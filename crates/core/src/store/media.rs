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
}
