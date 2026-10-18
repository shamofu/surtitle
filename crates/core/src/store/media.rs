use super::*;

impl Store {
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
        let previous: Option<String> = self
            .conn
            .query_row("SELECT data FROM media WHERE id=?", [&media.id], |row| {
                row.get(0)
            })
            .optional()?;
        let previous = previous
            .map(|json| serde_json::from_str::<Media>(&json))
            .transpose()?;
        let source_identity_changed = previous.as_ref().is_some_and(|old| {
            old.path != media.path
                || old.learning_language != media.learning_language
                || old
                    .audio_stream_index
                    .is_some_and(|track| Some(track) != media.audio_stream_index)
        });
        let source_changed = source_identity_changed
            || previous.is_some_and(|old| old.duration_ms != media.duration_ms);
        let transaction = if self.conn.is_autocommit() {
            Some(self.conn.unchecked_transaction()?)
        } else {
            None
        };
        if source_identity_changed {
            super::transcript_publication::detach_on(&self.conn, &media.id)?;
        }
        if source_changed {
            super::transcript_issues::deactivate_transcript_issues_on(
                &self.conn,
                &media.id,
                0,
                u64::MAX,
                false,
            )?;
        }
        self.conn.execute("INSERT INTO media(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",params![media.id,serde_json::to_string(media)?])?;
        if let Some(transaction) = transaction {
            transaction.commit()?;
        }
        Ok(())
    }
    pub fn set_segments(&mut self, media_id: &str, segments: &[SubtitleSegment]) -> Result<()> {
        for segment in segments {
            validate_segment(segment)?;
            ensure!(segment.media_id == media_id, "wrong media");
        }
        let tx = self.conn.transaction()?;
        super::transcript_publication::detach_on(&tx, media_id)?;
        super::transcript_issues::deactivate_transcript_issues_on(
            &tx,
            media_id,
            0,
            u64::MAX,
            false,
        )?;
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
        let mut edited = segment.clone();
        if edited.status == "confirmed" {
            edited.review_issues.clear();
        }
        let old = self.segment(&segment.id)?;
        ensure!(
            old.media_id == segment.media_id,
            "cannot move subtitle to another media"
        );
        // Draft commits already supply a transaction; direct edits create one.
        let transaction = if self.conn.is_autocommit() {
            Some(self.conn.unchecked_transaction()?)
        } else {
            None
        };
        self.conn.execute(
            "UPDATE segments SET start_ms=?,data=? WHERE id=?",
            params![
                segment.start_ms as i64,
                serde_json::to_string(&edited)?,
                segment.id
            ],
        )?;
        if serde_json::to_value(&old)? != serde_json::to_value(&edited)? {
            super::transcript_publication::protect_changes_on(
                &self.conn,
                &old.media_id,
                &[&old, &edited],
            )?;
        }
        if edited.status == "confirmed" {
            super::transcript_issues::deactivate_transcript_issues_on(
                &self.conn,
                &old.media_id,
                old.start_ms,
                old.end_ms,
                true,
            )?;
        }
        if let Some(transaction) = transaction {
            transaction.commit()?;
        }
        Ok(())
    }
}
