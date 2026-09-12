use crate::*;
use anyhow::{Context, Result, ensure};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Serialize, de::DeserializeOwned};
use std::path::{Path, PathBuf};
pub(crate) mod draft_study;
mod management;
mod transcript_ranges;
pub use transcript_ranges::TranscriptRangeEdit;

/// Learning data only. Credentials, executable selections and charge ledgers live elsewhere.
pub struct Store {
    pub(crate) conn: Connection,
    pub path: PathBuf,
}
impl Store {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(&path)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS segments (id TEXT PRIMARY KEY, media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE, start_ms INTEGER NOT NULL, data TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS segments_media_time ON segments(media_id,start_ms);
            CREATE TABLE IF NOT EXISTS cards (id TEXT PRIMARY KEY, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS reviews (id TEXT PRIMARY KEY, card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS ai_result_applications (job_id TEXT NOT NULL, ordinal INTEGER NOT NULL, response_sha256 TEXT NOT NULL, applied_at TEXT NOT NULL, PRIMARY KEY(job_id,ordinal));
            CREATE TABLE IF NOT EXISTS transcript_drafts (job_id TEXT NOT NULL, job_digest TEXT NOT NULL, base_digest TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(job_id,job_digest,base_digest));
            CREATE TABLE IF NOT EXISTS transcript_draft_heads (job_id TEXT PRIMARY KEY, job_digest TEXT NOT NULL, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS transcript_adoptions (job_id TEXT PRIMARY KEY, job_digest TEXT NOT NULL, draft_digest TEXT NOT NULL, previous_segments_json TEXT NOT NULL, adopted_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS subtitle_versions (id TEXT PRIMARY KEY, media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE, data TEXT NOT NULL);
            PRAGMA user_version=1;")?;
        transcript_ranges::initialize(&conn)?;
        draft_study::initialize(&conn)?;
        Ok(Self { conn, path })
    }
    fn all<T: DeserializeOwned>(&self, sql: &str) -> Result<Vec<T>> {
        let mut stmt = self.conn.prepare(sql)?;
        let json = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        json.iter().map(|s| Ok(serde_json::from_str(s)?)).collect()
    }
    fn one<T: DeserializeOwned>(&self, sql: &str, id: &str) -> Result<T> {
        let json: String = self
            .conn
            .query_row(sql, [id], |r| r.get(0))
            .optional()?
            .context("item not found")?;
        Ok(serde_json::from_str(&json)?)
    }
    pub fn media(&self, id: &str) -> Result<Media> {
        self.one("SELECT data FROM media WHERE id=?", id)
    }
    pub fn card(&self, id: &str) -> Result<StudyCard> {
        self.one("SELECT data FROM cards WHERE id=?", id)
    }
    pub fn segment(&self, id: &str) -> Result<SubtitleSegment> {
        self.one("SELECT data FROM segments WHERE id=?", id)
    }
    pub fn list_media(&self) -> Result<Vec<Media>> {
        let mut media: Vec<Media> = self.all("SELECT data FROM media ORDER BY rowid DESC")?;
        let cards = self.list_cards()?;
        for item in &mut media {
            item.segment_count = self.conn.query_row(
                "SELECT count(*) FROM segments WHERE media_id=?",
                [&item.id],
                |r| r.get::<_, i64>(0),
            )? as usize;
            item.card_count = cards.iter().filter(|c| c.media_id == item.id).count();
            if !Path::new(&item.path).is_file() {
                item.status = "missing".into();
            }
        }
        Ok(media)
    }
    pub fn list_cards(&self) -> Result<Vec<StudyCard>> {
        self.all("SELECT data FROM cards ORDER BY rowid DESC")
    }
    pub fn list_reviews(&self) -> Result<Vec<Review>> {
        self.all("SELECT data FROM reviews ORDER BY rowid")
    }
    pub fn list_segments(&self, media_id: &str) -> Result<Vec<SubtitleSegment>> {
        let mut stmt = self
            .conn
            .prepare("SELECT data FROM segments WHERE media_id=? ORDER BY start_ms,id")?;
        let rows = stmt
            .query_map([media_id], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.iter().map(|s| Ok(serde_json::from_str(s)?)).collect()
    }
    pub fn put_media(&self, media: &Media) -> Result<()> {
        ensure!(
            Path::new(&media.path).is_absolute(),
            "media path must be absolute"
        );
        self.conn.execute("INSERT INTO media(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",params![media.id,serde_json::to_string(media)?])?;
        Ok(())
    }
    pub fn set_segments(&mut self, media_id: &str, segments: &[SubtitleSegment]) -> Result<()> {
        for segment in segments {
            validate_segment(segment)?;
            ensure!(segment.media_id == media_id, "wrong media");
        }
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM segments WHERE media_id=?", [media_id])?;
        for s in segments {
            tx.execute(
                "INSERT INTO segments(id,media_id,start_ms,data) VALUES(?,?,?,?)",
                params![
                    s.id,
                    s.media_id,
                    s.start_ms as i64,
                    serde_json::to_string(s)?
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }
    pub fn edit_segment(&self, segment: &SubtitleSegment) -> Result<()> {
        validate_segment(segment)?;
        let old = self.segment(&segment.id)?;
        ensure!(
            old.media_id == segment.media_id,
            "cannot move subtitle to another media"
        );
        self.conn.execute(
            "UPDATE segments SET start_ms=?,data=? WHERE id=?",
            params![
                segment.start_ms as i64,
                serde_json::to_string(segment)?,
                segment.id
            ],
        )?;
        Ok(())
    }
    /// Operational markers stay on this device and are excluded from learning exports.
    pub fn ai_result_applied(
        &self,
        job_id: &str,
        ordinal: u32,
        response_sha256: &str,
    ) -> Result<bool> {
        let saved: Option<String> = self
            .conn
            .query_row(
                "SELECT response_sha256 FROM ai_result_applications WHERE job_id=? AND ordinal=?",
                params![job_id, ordinal],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(saved) = saved {
            ensure!(
                saved == response_sha256,
                "saved AI response changed after application"
            );
            return Ok(true);
        }
        Ok(false)
    }
    /// Validate, update every translation, and record application in one durable commit.
    /// A repeated application never overwrites later manual edits.
    pub fn apply_translations_once(
        &mut self,
        job_id: &str,
        ordinal: u32,
        response_sha256: &str,
        updates: &[SubtitleSegment],
    ) -> Result<bool> {
        ensure!(
            !job_id.is_empty() && job_id.len() <= 128,
            "invalid AI result ID"
        );
        ensure!(
            response_sha256.len() == 64 && response_sha256.bytes().all(|b| b.is_ascii_hexdigit()),
            "invalid AI response hash"
        );
        ensure!(
            !updates.is_empty() && updates.len() <= 1000,
            "invalid translation batch"
        );
        let tx = self.conn.transaction()?;
        let saved: Option<String> = tx
            .query_row(
                "SELECT response_sha256 FROM ai_result_applications WHERE job_id=? AND ordinal=?",
                params![job_id, ordinal],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(saved) = saved {
            ensure!(
                saved == response_sha256,
                "saved AI response changed after application"
            );
            return Ok(false);
        }
        let mut seen = std::collections::HashSet::new();
        for update in updates {
            validate_segment(update)?;
            ensure!(seen.insert(&update.id), "duplicate translation source");
            ensure!(
                update
                    .translation
                    .as_ref()
                    .is_some_and(|v| !v.trim().is_empty() && v.len() < 64 * 1024),
                "invalid translation"
            );
            let json: String = tx.query_row(
                "SELECT data FROM segments WHERE id=?",
                [&update.id],
                |row| row.get(0),
            )?;
            let current: SubtitleSegment = serde_json::from_str(&json)?;
            ensure!(
                current.media_id == update.media_id
                    && current.start_ms == update.start_ms
                    && current.end_ms == update.end_ms
                    && current.text == update.text
                    && current.status == "confirmed"
                    && update.status == "confirmed",
                "AI translation source changed"
            );
            tx.execute(
                "UPDATE segments SET data=? WHERE id=?",
                params![serde_json::to_string(update)?, update.id],
            )?;
        }
        tx.execute("INSERT INTO ai_result_applications(job_id,ordinal,response_sha256,applied_at) VALUES(?,?,?,?)", params![job_id, ordinal, response_sha256, now()])?;
        tx.commit()?;
        Ok(true)
    }
    pub fn transcript_draft<T: DeserializeOwned>(
        &self,
        job_id: &str,
        job_digest: &str,
        base_digest: &str,
    ) -> Result<Option<T>> {
        let saved: Option<String> = self.conn.query_row("SELECT data FROM transcript_drafts WHERE job_id=? AND job_digest=? AND base_digest=?", params![job_id,job_digest,base_digest], |row| row.get(0)).optional()?;
        saved
            .map(|json| Ok(serde_json::from_str(&json)?))
            .transpose()
    }
    pub fn save_transcript_draft(
        &self,
        job_id: &str,
        job_digest: &str,
        base_digest: &str,
        draft: &impl Serialize,
    ) -> Result<()> {
        let json = serde_json::to_string(draft)?;
        ensure!(
            json.len() <= 32 * 1024 * 1024,
            "transcript review is too large"
        );
        let tx = self.conn.unchecked_transaction()?;
        tx.execute("INSERT INTO transcript_drafts(job_id,job_digest,base_digest,data,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(job_id,job_digest,base_digest) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at", params![job_id,job_digest,base_digest,json,now()])?;
        tx.execute("INSERT INTO transcript_draft_heads(job_id,job_digest,data) VALUES(?,?,?) ON CONFLICT(job_id) DO UPDATE SET job_digest=excluded.job_digest,data=excluded.data", params![job_id,job_digest,json])?;
        tx.commit()?;
        Ok(())
    }
    pub fn latest_transcript_draft<T: DeserializeOwned>(
        &self,
        job_id: &str,
        job_digest: &str,
    ) -> Result<Option<T>> {
        let saved: Option<String> = self
            .conn
            .query_row(
                "SELECT data FROM transcript_draft_heads WHERE job_id=? AND job_digest=?",
                params![job_id, job_digest],
                |row| row.get(0),
            )
            .optional()?;
        saved
            .map(|json| Ok(serde_json::from_str(&json)?))
            .transpose()
    }
    pub fn transcript_adopted(&self, job_id: &str, job_digest: &str) -> Result<Option<String>> {
        let saved: Option<(String, String)> = self
            .conn
            .query_row(
                "SELECT job_digest,draft_digest FROM transcript_adoptions WHERE job_id=?",
                [job_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        saved
            .map(|(job, draft)| {
                ensure!(job == job_digest, "adopted transcript job changed");
                Ok(draft)
            })
            .transpose()
    }
    /// Replacing a selected interval is one durable operation. Card snapshots and
    /// received provider results are separate; neither is mutated here.
    #[allow(clippy::too_many_arguments)]
    pub fn adopt_transcript_once(
        &mut self,
        job_id: &str,
        job_digest: &str,
        draft_digest: &str,
        media_id: &str,
        expected_revision: &str,
        start_ms: u64,
        end_ms: u64,
        segments: &[SubtitleSegment],
    ) -> Result<bool> {
        ensure!(
            !job_id.is_empty() && job_id.len() <= 128,
            "invalid transcript job"
        );
        ensure!(
            job_digest.len() == 64 && draft_digest.len() == 64,
            "invalid transcript digest"
        );
        ensure!(
            start_ms < end_ms && segments.len() <= 100_000,
            "invalid transcript selection"
        );
        let tx = self.conn.transaction()?;
        let marker: Option<(String, String)> = tx
            .query_row(
                "SELECT job_digest,draft_digest FROM transcript_adoptions WHERE job_id=?",
                [job_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if let Some((job, draft)) = marker {
            ensure!(
                job == job_digest && draft == draft_digest,
                "transcript was already adopted with another digest"
            );
            return Ok(false);
        }
        ensure!(
            tx.query_row("SELECT COUNT(*) FROM media WHERE id=?", [media_id], |row| {
                row.get::<_, i64>(0)
            })? == 1,
            "transcript media is missing"
        );
        let current = {
            let mut statement =
                tx.prepare("SELECT data FROM segments WHERE media_id=? ORDER BY start_ms,id")?;
            let json = statement
                .query_map([media_id], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            json.iter()
                .map(|value| Ok(serde_json::from_str::<SubtitleSegment>(value)?))
                .collect::<Result<Vec<_>>>()?
        };
        ensure!(
            subtitle_revision(&current)? == expected_revision,
            "source subtitles changed; review a new preparation"
        );
        validate_transcript_range(&current, start_ms, end_ms, segments, media_id)?;
        let previous = current
            .iter()
            .filter(|segment| segment.start_ms < end_ms && segment.end_ms > start_ms)
            .collect::<Vec<_>>();
        for old in &previous {
            tx.execute("DELETE FROM segments WHERE id=?", [&old.id])?;
        }
        for segment in segments {
            tx.execute(
                "INSERT INTO segments(id,media_id,start_ms,data) VALUES(?,?,?,?)",
                params![
                    segment.id,
                    segment.media_id,
                    segment.start_ms as i64,
                    serde_json::to_string(segment)?
                ],
            )?;
        }
        tx.execute("INSERT INTO transcript_adoptions(job_id,job_digest,draft_digest,previous_segments_json,adopted_at) VALUES(?,?,?,?,?)", params![job_id,job_digest,draft_digest,serde_json::to_string(&previous)?,now()])?;
        tx.commit()?;
        Ok(true)
    }
    /// Resolve the complete source from the DB. IPC timestamps and cue ordering
    /// never decide the clip boundaries; all requested cues must be adjacent.
    pub fn card_source_cues(&self, request: &SaveCard) -> Result<Vec<SubtitleSegment>> {
        let ids = if request.source_cue_ids.is_empty() {
            vec![request.segment_id.clone()]
        } else {
            request.source_cue_ids.clone()
        };
        ensure!(
            ids.len() <= 64 && ids.first() == Some(&request.segment_id),
            "invalid card source cues"
        );
        let all = self.list_segments(&request.media_id)?;
        let first = all
            .iter()
            .position(|s| s.id == request.segment_id)
            .context("card source subtitle is missing")?;
        let cues = all
            .get(first..first + ids.len())
            .context("card source subtitles are not adjacent")?;
        ensure!(
            cues.iter().zip(&ids).all(|(s, id)| s.id == *id
                && s.media_id == request.media_id
                && s.status == "confirmed"),
            "card source subtitles must be confirmed, ordered and adjacent"
        );
        let start = cues[0].start_ms;
        let end = cues
            .iter()
            .map(|s| s.end_ms)
            .max()
            .context("missing card source")?;
        ensure!(
            end > start && end - start <= 180_000,
            "card audio must be at most 180 seconds"
        );
        Ok(cues.to_vec())
    }
    pub fn save_card(&self, request: &SaveCard, audio_path: Option<String>) -> Result<StudyCard> {
        self.save_card_with_audio_range(request, audio_path, None)
    }
    pub fn save_card_with_audio_range(
        &self,
        request: &SaveCard,
        audio_path: Option<String>,
        audio_clip_range: Option<AudioClipRange>,
    ) -> Result<StudyCard> {
        ensure!(
            !request.term.trim().is_empty() && request.term.len() < 4096,
            "enter a term"
        );
        ensure!(
            request.meaning.len() < 64 * 1024
                && request.example.len() < 64 * 1024
                && request
                    .translation
                    .as_ref()
                    .is_none_or(|s| s.len() < 64 * 1024)
                && request
                    .explanation
                    .as_ref()
                    .is_none_or(|s| s.len() < 64 * 1024),
            "card is too large"
        );
        let media = self.media(&request.media_id)?;
        let source_cues = self.card_source_cues(request)?;
        let segment = &source_cues[0];
        let end_ms = source_cues
            .iter()
            .map(|s| s.end_ms)
            .max()
            .context("missing card source")?;
        if let Some(range) = audio_clip_range {
            ensure!(audio_path.is_some(), "Clip range requires saved audio");
            range.validate_source(segment.start_ms, end_ms)?;
            ensure!(
                range.end_ms <= media.duration_ms,
                "Clip exceeds media duration"
            );
        }
        // A missing multi-cue translation must remain missing. Reusing only the
        // first subtitle's translation would describe different audio/context.
        let source_translation = source_cues
            .iter()
            .map(|s| {
                s.translation
                    .as_ref()
                    .filter(|t| !t.trim().is_empty())
                    .cloned()
            })
            .collect::<Option<Vec<_>>>()
            .map(|parts| parts.join("\n"));
        let card = StudyCard {
            id: id(),
            media_id: media.id,
            segment_id: segment.id.clone(),
            term: request.term.trim().into(),
            meaning: request.meaning.clone(),
            example: request.example.clone(),
            language: media.learning_language,
            due_at: now(),
            created_at: now(),
            review_count: 0,
            audio_path,
            audio_clip_range,
            audio_stream_index: media.audio_stream_index,
            suspended: false,
            translation: request.translation.clone().or(source_translation),
            explanation: request.explanation.clone(),
            source_title: media.title,
            source_url: media.source_url,
            start_ms: segment.start_ms,
            end_ms,
            source_cues,
            memory: None,
            last_review: None,
        };
        self.put_card(&card)?;
        Ok(card)
    }
    pub fn put_card(&self, card: &StudyCard) -> Result<()> {
        self.conn.execute("INSERT INTO cards(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",params![card.id,serde_json::to_string(card)?])?;
        Ok(())
    }
    pub fn rate_card(
        &mut self,
        card_id: &str,
        rating: &str,
        retention: f32,
        at: chrono::DateTime<chrono::Utc>,
    ) -> Result<StudyCard> {
        ensure!((0.7..=0.97).contains(&retention), "retention out of range");
        let mut card = self.card(card_id)?;
        ensure!(!card.suspended, "card is suspended");
        let elapsed = card
            .last_review
            .as_deref()
            .map(chrono::DateTime::parse_from_rfc3339)
            .transpose()?
            .map(|last| (at - last.with_timezone(&chrono::Utc)).num_days().max(0) as u32)
            .unwrap_or(0);
        let states =
            fsrs::FSRS::default().next_states(card.memory.map(Into::into), retention, elapsed)?;
        let state = match rating {
            "again" => states.again,
            "hard" => states.hard,
            "good" => states.good,
            "easy" => states.easy,
            _ => anyhow::bail!("invalid review rating"),
        };
        let days = state.interval.round().clamp(1., 36500.) as u32;
        card.memory = Some(state.memory.into());
        card.review_count = card
            .review_count
            .checked_add(1)
            .context("review count overflow")?;
        card.last_review = Some(at.to_rfc3339());
        card.due_at = (at
            + if rating == "again" {
                chrono::Duration::minutes(1)
            } else {
                chrono::Duration::days(days.into())
            })
        .to_rfc3339();
        let review = Review {
            id: id(),
            card_id: card.id.clone(),
            rating: rating.into(),
            reviewed_at: at.to_rfc3339(),
            scheduled_days: if rating == "again" { 0 } else { days },
        };
        let tx = self.conn.transaction()?;
        tx.execute(
            "UPDATE cards SET data=? WHERE id=?",
            params![serde_json::to_string(&card)?, card.id],
        )?;
        tx.execute(
            "INSERT INTO reviews(id,card_id,data) VALUES(?,?,?)",
            params![review.id, review.card_id, serde_json::to_string(&review)?],
        )?;
        tx.commit()?;
        Ok(card)
    }
    pub fn archive(&self) -> Result<LearningArchive> {
        Ok(LearningArchive {
            format: "surtitle.learning".into(),
            schema_version: 1,
            exported_at: now(),
            media: self.list_media()?,
            segments: self.all("SELECT data FROM segments ORDER BY media_id,start_ms")?,
            cards: self.list_cards()?,
            reviews: self.list_reviews()?,
            subtitle_versions: self.all("SELECT data FROM subtitle_versions ORDER BY rowid")?,
            draft_study_selections: self
                .all::<DraftStudySelection>(
                    "SELECT data FROM draft_study_selections ORDER BY rowid",
                )?
                .iter()
                .map(DraftStudySelection::detached)
                .collect(),
        })
    }
    pub fn backup(&self, path: &Path) -> Result<()> {
        self.conn.backup("main", path, None)?;
        Ok(())
    }
    pub fn restore(&mut self, archive: &LearningArchive, backup_path: &Path) -> Result<()> {
        crate::transfer::validate(archive)?;
        self.backup(backup_path)?;
        let tx = self.conn.transaction()?;
        tx.execute_batch(
            "DELETE FROM draft_study_selections; DELETE FROM transcript_range_selections; DELETE FROM transcript_range_revisions; DELETE FROM transcript_draft_heads; DELETE FROM transcript_adoptions; DELETE FROM transcript_drafts; DELETE FROM ai_result_applications; DELETE FROM reviews; DELETE FROM cards; DELETE FROM segments; DELETE FROM media;",
        )?;
        for m in &archive.media {
            tx.execute(
                "INSERT INTO media VALUES(?,?)",
                params![m.id, serde_json::to_string(m)?],
            )?;
        }
        for s in &archive.segments {
            tx.execute(
                "INSERT INTO segments VALUES(?,?,?,?)",
                params![
                    s.id,
                    s.media_id,
                    s.start_ms as i64,
                    serde_json::to_string(s)?
                ],
            )?;
        }
        for c in &archive.cards {
            tx.execute(
                "INSERT INTO cards VALUES(?,?)",
                params![c.id, serde_json::to_string(c)?],
            )?;
        }
        for selection in &archive.draft_study_selections {
            let selection = selection.detached();
            tx.execute(
                "INSERT INTO draft_study_selections(id,media_id,version,data) VALUES(?,?,?,?)",
                params![
                    selection.id,
                    selection.media_id,
                    selection.version as i64,
                    serde_json::to_string(&selection)?
                ],
            )?;
        }
        for version in &archive.subtitle_versions {
            tx.execute(
                "INSERT INTO subtitle_versions(id,media_id,data) VALUES(?,?,?)",
                params![
                    version.id,
                    version.media_id,
                    serde_json::to_string(version)?
                ],
            )?;
        }
        for r in &archive.reviews {
            tx.execute(
                "INSERT INTO reviews VALUES(?,?,?)",
                params![r.id, r.card_id, serde_json::to_string(r)?],
            )?;
        }
        tx.commit()?;
        Ok(())
    }
}

pub fn subtitle_revision(segments: &[SubtitleSegment]) -> Result<String> {
    use sha2::{Digest, Sha256};
    let bytes = serde_json::to_vec(
        &segments
            .iter()
            .map(|s| (&s.id, &s.media_id, s.start_ms, s.end_ms, &s.text, &s.status))
            .collect::<Vec<_>>(),
    )?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}
pub fn validate_transcript_range(
    current: &[SubtitleSegment],
    start_ms: u64,
    end_ms: u64,
    replacement: &[SubtitleSegment],
    media_id: &str,
) -> Result<()> {
    ensure!(start_ms < end_ms, "invalid transcript selection");
    for old in current
        .iter()
        .filter(|s| s.start_ms < end_ms && s.end_ms > start_ms)
    {
        ensure!(
            old.start_ms >= start_ms && old.end_ms <= end_ms,
            "selection cuts an existing subtitle; choose a range containing the whole cue"
        );
    }
    let mut ids = std::collections::HashSet::new();
    for segment in replacement {
        validate_segment(segment)?;
        ensure!(
            segment.media_id == media_id
                && segment.status == "confirmed"
                && segment.start_ms >= start_ms
                && segment.end_ms <= end_ms,
            "replacement subtitle lies outside the reviewed selection"
        );
        ensure!(ids.insert(&segment.id), "duplicate replacement subtitle ID");
    }
    Ok(())
}

pub fn validate_segment(s: &SubtitleSegment) -> Result<()> {
    ensure!(
        s.start_ms < s.end_ms && s.end_ms < 360_000_000_000,
        "invalid subtitle range"
    );
    ensure!(
        !s.text.trim().is_empty() && s.text.len() < 1024 * 1024,
        "invalid subtitle text"
    );
    Ok(())
}

pub fn write_json_atomic(path: &Path, value: &impl Serialize) -> Result<()> {
    let tmp = path.with_extension(format!("{}.tmp", id()));
    {
        use std::io::Write;
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(&serde_json::to_vec_pretty(value)?)?;
        file.sync_all()?;
    }
    // Rust uses replace-existing rename semantics on Windows too. Never delete
    // the old preferences first: a crash must not silently reset tool selections.
    std::fs::rename(tmp, path)?;
    Ok(())
}

#[cfg(test)]
#[path = "store/transcript_tests.rs"]
mod transcript_tests;
