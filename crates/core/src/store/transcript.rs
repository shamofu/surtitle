use super::*;

impl Store {
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
                    && crate::is_usable_subtitle_status(&current.status)
                    && update.status == current.status,
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
        self.adopt_transcript_with_issues_once(
            job_id,
            job_digest,
            draft_digest,
            media_id,
            expected_revision,
            start_ms,
            end_ms,
            segments,
            &[],
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn adopt_transcript_with_issues_once(
        &mut self,
        job_id: &str,
        job_digest: &str,
        draft_digest: &str,
        media_id: &str,
        expected_revision: &str,
        start_ms: u64,
        end_ms: u64,
        segments: &[SubtitleSegment],
        issues: &[TranscriptIssueRecord],
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
        super::transcript_publication::protect_ranges_on(
            &tx,
            media_id,
            &[TranscriptPublicationRange { start_ms, end_ms }],
        )?;
        ensure!(
            issues.iter().all(|issue| issue.media_id == media_id
                && issue.start_ms >= start_ms
                && issue.end_ms <= end_ms),
            "Transcript issues belong outside the adopted range"
        );
        let previous = current
            .iter()
            .filter(|segment| segment.start_ms < end_ms && segment.end_ms > start_ms)
            .collect::<Vec<_>>();
        if !previous.is_empty() {
            let media_json: String =
                tx.query_row("SELECT data FROM media WHERE id=?", [media_id], |row| {
                    row.get(0)
                })?;
            let media: Media = serde_json::from_str(&media_json)?;
            let version = SubtitleVersion {
                id: id(),
                media_id: media_id.into(),
                created_at: now(),
                label: "Before applying generated subtitles".into(),
                stream_index: media.subtitle_stream_index,
                segments: current.clone(),
            };
            tx.execute(
                "INSERT INTO subtitle_versions(id,media_id,data) VALUES(?,?,?)",
                params![version.id, media_id, serde_json::to_string(&version)?],
            )?;
        }
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
        super::transcript_issues::deactivate_transcript_issues_on(
            &tx, media_id, start_ms, end_ms, false,
        )?;
        super::transcript_issues::upsert_transcript_issues_on(&tx, issues)?;
        tx.execute("INSERT INTO transcript_adoptions(job_id,job_digest,draft_digest,previous_segments_json,adopted_at) VALUES(?,?,?,?,?)", params![job_id,job_digest,draft_digest,serde_json::to_string(&previous)?,now()])?;
        tx.commit()?;
        Ok(true)
    }
}
