use super::*;
use rusqlite::{Transaction, TransactionBehavior};

/// Immutable input for local audio extraction, not authority to save a card.
/// Saving rechecks the current source in the same transaction as the card write.
pub struct CardSourceSnapshot {
    media: Media,
    cues: Vec<SubtitleSegment>,
    range: AudioClipRange,
}

impl CardSourceSnapshot {
    pub fn media(&self) -> &Media {
        &self.media
    }

    pub fn cues(&self) -> &[SubtitleSegment] {
        &self.cues
    }

    pub fn range(&self) -> AudioClipRange {
        self.range
    }
}

fn selected_source_range(request: &SaveCard, cues: &[SubtitleSegment]) -> Result<AudioClipRange> {
    let start_ms = cues[0].start_ms;
    let end_ms = cues
        .iter()
        .map(|cue| cue.end_ms)
        .max()
        .context("missing card source")?;
    let range = request
        .source_range
        .unwrap_or(AudioClipRange { start_ms, end_ms });
    ensure!(
        range.start_ms < range.end_ms && range.end_ms - range.start_ms <= 180_000,
        "Source range must be at most 180 seconds"
    );
    if request.source_range.is_some() {
        ensure!(
            cues.len() == 1
                && cues[0].timing_precision == "source_block"
                && range.start_ms >= start_ms
                && range.end_ms <= end_ms,
            "Only an audio source block can use a selected card range"
        );
    }
    Ok(range)
}

pub(super) fn validate_card_fields(request: &SaveCard) -> Result<()> {
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
    Ok(())
}

impl Store {
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
        // Read consecutive rows, not just the requested IDs: a newly inserted
        // subtitle between two selected cues must invalidate their adjacency.
        let mut query = self.conn.prepare(
            "SELECT data FROM segments WHERE media_id=?1 AND (start_ms,id) >= \
             (SELECT start_ms,id FROM segments WHERE media_id=?1 AND id=?2) \
             ORDER BY start_ms,id LIMIT ?3",
        )?;
        let rows = query
            .query_map(
                params![request.media_id, request.segment_id, ids.len() as i64],
                |row| row.get::<_, String>(0),
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let cues = rows
            .iter()
            .map(|json| Ok(serde_json::from_str(json)?))
            .collect::<Result<Vec<SubtitleSegment>>>()?;
        Ok(confirmed_cue_range(&cues, &request.media_id, &ids)?
            .cues
            .to_vec())
    }
    /// Exact card source selected by the user inside a provider audio block.
    /// The immutable cue snapshot keeps the provider's original block bounds.
    pub fn card_source_range(&self, request: &SaveCard) -> Result<AudioClipRange> {
        let cues = self.card_source_cues(request)?;
        selected_source_range(request, &cues)
    }
    /// Capture a consistent source, then release the database before extracting audio.
    pub fn card_source_snapshot(&self, request: &SaveCard) -> Result<CardSourceSnapshot> {
        let tx = self.conn.unchecked_transaction()?;
        let source = self.resolve_card_source(request)?;
        tx.commit()?;
        Ok(source)
    }

    fn resolve_card_source(&self, request: &SaveCard) -> Result<CardSourceSnapshot> {
        let media = self.media(&request.media_id)?;
        let cues = self.card_source_cues(request)?;
        let range = selected_source_range(request, &cues)?;
        Ok(CardSourceSnapshot { media, cues, range })
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
        validate_card_fields(request)?;
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)?;
        let card = self.insert_card_with_audio_range(request, audio_path, audio_clip_range)?;
        tx.commit()?;
        Ok(card)
    }

    // Callers validate fields and own the transaction, including draft consumption.
    pub(super) fn insert_card_with_audio_range(
        &self,
        request: &SaveCard,
        audio_path: Option<String>,
        audio_clip_range: Option<AudioClipRange>,
    ) -> Result<StudyCard> {
        let source = self.resolve_card_source(request)?;
        self.insert_card_from_source(request, source, audio_path, audio_clip_range)
    }

    /// Revalidate extracted audio against the current source and save atomically.
    /// A snapshot can never bypass the current subtitle or editor-draft checks.
    pub fn save_card_with_source_snapshot(
        &self,
        request: &SaveCard,
        expected: &CardSourceSnapshot,
        audio_path: Option<String>,
        audio_clip_range: Option<AudioClipRange>,
        draft: Option<&EditorDraftVersion>,
    ) -> Result<StudyCard> {
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)?;
        let current = self.card_source_cues(request);
        // Keep media lookup errors ahead of the general changed-source error.
        let media = self.media(&expected.media.id)?;
        ensure!(
            request.media_id == expected.media.id
                && current.as_ref().is_ok_and(|cues| {
                    serde_json::to_value(cues).ok() == serde_json::to_value(&expected.cues).ok()
                })
                && media.path == expected.media.path
                && media.audio_stream_index == expected.media.audio_stream_index,
            "The subtitle or media changed while preparing card audio. Save it again."
        );
        let cues = current?;
        if let Some(reference) = draft {
            self.check_phrase_editor_draft(reference, request)?;
        }
        validate_card_fields(request)?;
        let range = selected_source_range(request, &cues)?;
        ensure!(
            range == expected.range,
            "The subtitle or media changed while preparing card audio. Save it again."
        );
        let card = self.insert_card_from_source(
            request,
            CardSourceSnapshot { media, cues, range },
            audio_path,
            audio_clip_range,
        )?;
        if let Some(reference) = draft {
            self.delete_editor_draft(reference)?;
        }
        tx.commit()?;
        Ok(card)
    }

    fn insert_card_from_source(
        &self,
        request: &SaveCard,
        source: CardSourceSnapshot,
        audio_path: Option<String>,
        audio_clip_range: Option<AudioClipRange>,
    ) -> Result<StudyCard> {
        let CardSourceSnapshot {
            media,
            cues: source_cues,
            range: source_range,
        } = source;
        let segment = &source_cues[0];
        let end_ms = source_range.end_ms;
        if let Some(range) = audio_clip_range {
            ensure!(audio_path.is_some(), "Clip range requires saved audio");
            range.validate_source(source_range.start_ms, end_ms)?;
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
            start_ms: source_range.start_ms,
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
}

#[cfg(test)]
#[path = "card_source_tests.rs"]
mod source_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration, TimeZone, Utc};

    #[test]
    fn review_sequences_preserve_audio_history_and_schedule_after_reopen() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("learning.sqlite");
        let mut store = Store::open(&path).unwrap();
        let mut total_reviews = 0;
        for (case, intervals, ratings) in [
            ("steady", vec![0, 1, 3, 7, 14, 30, 60, 120], vec!["good"; 8]),
            (
                "lapse",
                vec![0, 1, 2, 0, 1, 4, 30, 90],
                vec![
                    "good", "hard", "again", "good", "good", "easy", "again", "good",
                ],
            ),
            (
                "overdue",
                vec![0, 14, 90, 365, 700],
                vec!["easy", "good", "hard", "again", "good"],
            ),
        ] {
            for retention in [0.7_f32, 0.9, 0.97] {
                let card: StudyCard = serde_json::from_value(serde_json::json!({
                    "id": format!("{case}-{retention}"), "mediaId": "fixture",
                    "segmentId": "fixture-cue", "term": "phrase", "meaning": "meaning",
                    "example": "Example.", "language": "en",
                    "dueAt": "2026-01-01T00:00:00Z", "createdAt": "2026-01-01T00:00:00Z",
                    "reviewCount": 0, "audioPath": "fixture-audio.wav", "suspended": false,
                }))
                .unwrap();
                store.put_card(&card).unwrap();
                let mut at = Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap();
                for (ordinal, (&days, &rating)) in intervals.iter().zip(&ratings).enumerate() {
                    at += if days == 0 && ordinal > 0 {
                        Duration::minutes(1)
                    } else {
                        Duration::days(days)
                    };
                    let rated = store.rate_card(&card.id, rating, retention, at).unwrap();
                    total_reviews += 1;
                    assert_eq!(rated.review_count, ordinal as u32 + 1);
                    assert_eq!(rated.last_review, Some(at.to_rfc3339()));
                    assert_eq!(rated.audio_path, card.audio_path);
                    let memory = rated.memory.unwrap();
                    assert!(memory.stability.is_finite() && memory.stability > 0.0);
                    assert!((1.0..=10.0).contains(&memory.difficulty));
                    let due = chrono::DateTime::parse_from_rfc3339(&rated.due_at)
                        .unwrap()
                        .with_timezone(&Utc);
                    if rating == "again" {
                        assert_eq!(due, at + Duration::minutes(1));
                    } else {
                        assert!(due >= at + Duration::days(1));
                    }
                    let reviews = store.list_reviews().unwrap();
                    assert_eq!(reviews.len(), total_reviews);
                    let card_reviews = reviews
                        .iter()
                        .filter(|review| review.card_id == card.id)
                        .collect::<Vec<_>>();
                    assert_eq!(card_reviews.len(), ordinal + 1);
                    let review = card_reviews
                        .iter()
                        .find(|review| review.reviewed_at == at.to_rfc3339())
                        .unwrap();
                    assert_eq!(review.rating, rating);
                    assert_eq!(review.scheduled_days, (due - at).num_days() as u32);
                }
                let before = store.archive().unwrap();
                drop(store);
                store = Store::open(&path).unwrap();
                let after = store.archive().unwrap();
                assert_eq!(
                    serde_json::to_value(&before.cards).unwrap(),
                    serde_json::to_value(&after.cards).unwrap()
                );
                assert_eq!(
                    serde_json::to_value(&before.reviews).unwrap(),
                    serde_json::to_value(&after.reviews).unwrap()
                );
            }
        }
        assert_eq!(total_reviews, 63);
    }
}
