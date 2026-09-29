use super::*;

impl Store {
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
