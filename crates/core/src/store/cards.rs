use super::*;

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
        let all = self.list_segments(&request.media_id)?;
        Ok(confirmed_cue_range(&all, &request.media_id, &ids)?
            .cues
            .to_vec())
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
}
