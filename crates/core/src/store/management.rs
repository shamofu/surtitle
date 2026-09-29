use super::*;

impl Store {
    pub fn edit_card(&self, request: &EditCard) -> Result<StudyCard> {
        ensure!(
            !request.term.trim().is_empty() && request.term.len() < 4096,
            "enter a term"
        );
        ensure!(
            [
                Some(&request.meaning),
                Some(&request.example),
                request.translation.as_ref(),
                request.explanation.as_ref()
            ]
            .into_iter()
            .flatten()
            .all(|s| s.len() < 64 * 1024),
            "card is too large"
        );
        let mut card = self.card(&request.id)?;
        card.term = request.term.trim().to_owned();
        card.meaning = request.meaning.clone();
        card.example = request.example.clone();
        card.translation = request.translation.clone();
        card.explanation = request.explanation.clone();
        self.put_card(&card)?;
        Ok(card)
    }
    pub fn suspend_card(&self, id: &str, suspended: bool) -> Result<()> {
        let mut card = self.card(id)?;
        card.suspended = suspended;
        self.put_card(&card)
    }
    pub fn delete_card(&self, id: &str) -> Result<StudyCard> {
        let card = self.card(id)?;
        self.conn.execute("DELETE FROM cards WHERE id=?", [id])?;
        Ok(card)
    }
    /// Cards and their original context remain usable after removing a library item.
    /// This never deletes any original or downloaded media file.
    pub fn remove_media(&self, id: &str) -> Result<()> {
        self.media(id)?;
        self.conn.execute("DELETE FROM media WHERE id=?", [id])?;
        Ok(())
    }
    pub fn subtitle_versions(&self, media_id: &str) -> Result<Vec<SubtitleVersion>> {
        let mut stmt = self
            .conn
            .prepare("SELECT data FROM subtitle_versions WHERE media_id=? ORDER BY rowid DESC")?;
        let json = stmt
            .query_map([media_id], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        json.iter().map(|s| Ok(serde_json::from_str(s)?)).collect()
    }
    /// Replacing subtitles is explicit and saves the complete previous edition.
    pub fn replace_subtitles(
        &mut self,
        media_id: &str,
        segments: &[SubtitleSegment],
        stream_index: Option<u32>,
        replace_existing: bool,
        label: &str,
    ) -> Result<()> {
        let mut media = self.media(media_id)?;
        let previous = self.list_segments(media_id)?;
        ensure!(
            previous.is_empty() || replace_existing,
            "Existing subtitles must be explicitly replaced; the previous version will be preserved."
        );
        for s in segments {
            validate_segment(s)?;
            ensure!(s.media_id == media_id, "wrong media");
        }
        ensure!(!segments.is_empty(), "subtitle source contains no cues");
        let tx = self.conn.transaction()?;
        if !previous.is_empty() {
            let version = SubtitleVersion {
                id: id(),
                media_id: media_id.into(),
                created_at: now(),
                label: label.into(),
                stream_index: media.subtitle_stream_index,
                segments: previous,
            };
            tx.execute(
                "INSERT INTO subtitle_versions(id,media_id,data) VALUES(?,?,?)",
                params![version.id, media_id, serde_json::to_string(&version)?],
            )?;
        }
        tx.execute("DELETE FROM segments WHERE media_id=?", [media_id])?;
        for s in segments {
            tx.execute(
                "INSERT INTO segments(id,media_id,start_ms,data) VALUES(?,?,?,?)",
                params![s.id, media_id, s.start_ms as i64, serde_json::to_string(s)?],
            )?;
        }
        media.subtitle_stream_index = stream_index;
        tx.execute(
            "UPDATE media SET data=? WHERE id=?",
            params![serde_json::to_string(&media)?, media_id],
        )?;
        tx.commit()?;
        Ok(())
    }
    pub fn restore_subtitle_version(&mut self, media_id: &str, version_id: &str) -> Result<()> {
        let version: SubtitleVersion =
            self.one("SELECT data FROM subtitle_versions WHERE id=?", version_id)?;
        ensure!(
            version.media_id == media_id,
            "subtitle version belongs to another media"
        );
        self.replace_subtitles(
            media_id,
            &version.segments,
            version.stream_index,
            true,
            "Before restoring a saved version",
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, Store, Media, SubtitleSegment) {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source.wav");
        std::fs::write(&source, b"original").unwrap();
        let mut db = Store::open(temp.path().join("learning.sqlite")).unwrap();
        let media = Media {
            id: "media".into(),
            title: "Original title".into(),
            path: source.to_string_lossy().into_owned(),
            source_url: None,
            kind: "audio".into(),
            duration_ms: 5000,
            learning_language: "en".into(),
            explanation_language: "ja".into(),
            created_at: now(),
            last_position_ms: 1200,
            segment_count: 0,
            card_count: 0,
            status: "ready".into(),
            error: None,
            audio_stream_index: Some(4),
            subtitle_stream_index: Some(5),
        };
        let segment = SubtitleSegment {
            id: "cue".into(),
            media_id: media.id.clone(),
            start_ms: 1000,
            end_ms: 2000,
            text: "Original example".into(),
            translation: None,
            status: "confirmed".into(),
        };
        db.put_media(&media).unwrap();
        db.set_segments(&media.id, std::slice::from_ref(&segment))
            .unwrap();
        (temp, db, media, segment)
    }
    #[test]
    fn card_management_keeps_schedule_audio_and_source_after_media_removal() {
        let (_temp, mut db, media, segment) = fixture();
        let card = db
            .save_card(
                &SaveCard {
                    media_id: media.id.clone(),
                    segment_id: segment.id,
                    source_cue_ids: vec![],
                    term: "original".into(),
                    meaning: "meaning".into(),
                    example: "original example".into(),
                    translation: None,
                    explanation: None,
                },
                Some("saved-clip.wav".into()),
            )
            .unwrap();
        let rated = db
            .rate_card(&card.id, "good", 0.9, chrono::Utc::now())
            .unwrap();
        let edited = db
            .edit_card(&EditCard {
                id: card.id.clone(),
                term: "corrected".into(),
                meaning: "corrected meaning".into(),
                example: "corrected example".into(),
                translation: Some("翻訳".into()),
                explanation: Some("Note".into()),
            })
            .unwrap();
        assert_eq!(edited.audio_path, card.audio_path);
        assert_eq!(edited.audio_stream_index, Some(4));
        assert_eq!(edited.source_title, media.title);
        assert_eq!(edited.due_at, rated.due_at);
        assert_eq!(edited.review_count, 1);
        db.suspend_card(&card.id, true).unwrap();
        assert!(
            db.rate_card(&card.id, "good", 0.9, chrono::Utc::now())
                .is_err()
        );
        db.suspend_card(&card.id, false).unwrap();
        db.remove_media(&media.id).unwrap();
        assert!(Path::new(&media.path).is_file());
        assert!(db.list_media().unwrap().is_empty());
        assert_eq!(db.card(&card.id).unwrap().term, "corrected");
        crate::transfer::validate(&db.archive().unwrap()).unwrap();
        db.delete_card(&card.id).unwrap();
        assert!(db.list_reviews().unwrap().is_empty());
        assert!(db.card(&card.id).is_err());
    }
    #[test]
    fn multi_cue_cards_validate_the_whole_source_and_keep_immutable_snapshots() {
        let (_temp, mut db, media, first) = fixture();
        let mut second = first.clone();
        second.id = "cue-2".into();
        second.start_ms = 2000;
        second.end_ms = 3000;
        second.text = "Second half".into();
        second.translation = Some("後半".into());
        let mut third = second.clone();
        third.id = "cue-3".into();
        third.start_ms = 3000;
        third.end_ms = 4000;
        db.set_segments(&media.id, &[first.clone(), second.clone(), third.clone()])
            .unwrap();
        let request = SaveCard {
            media_id: media.id.clone(),
            segment_id: first.id.clone(),
            source_cue_ids: vec![first.id.clone(), second.id.clone()],
            term: "example second".into(),
            meaning: "meaning".into(),
            example: "Original example\nSecond half".into(),
            translation: None,
            explanation: None,
        };
        let range = crate::replay_range(1000, 3000, media.duration_ms, 150).unwrap();
        let saved = db
            .save_card_with_audio_range(&request, Some("whole-source.wav".into()), Some(range))
            .unwrap();
        assert_eq!((saved.start_ms, saved.end_ms), (1000, 3000));
        assert_eq!(saved.source_cues.len(), 2);
        assert_eq!(saved.audio_stream_index, Some(4));
        assert_eq!(saved.audio_clip_range, Some(range));
        assert!(
            db.save_card_with_audio_range(&request, None, Some(range))
                .is_err()
        );
        assert!(
            db.save_card_with_audio_range(
                &request,
                Some("invalid.wav".into()),
                Some(crate::AudioClipRange {
                    start_ms: 1001,
                    end_ms: 3000
                })
            )
            .is_err()
        );
        assert!(
            saved.translation.is_none(),
            "Never substitute one cue's translation for the whole scene"
        );
        for ids in [
            vec![first.id.clone(), third.id.clone()],
            vec![second.id.clone(), first.id.clone()],
            vec![first.id.clone(), first.id.clone()],
            vec![first.id.clone(), "missing".into()],
        ] {
            assert!(
                db.save_card(
                    &SaveCard {
                        source_cue_ids: ids,
                        ..request.clone()
                    },
                    None
                )
                .is_err()
            );
        }
        second.status = "provisional".into();
        db.edit_segment(&second).unwrap();
        // edit_segment is an explicit confirmation path, so put a provisional
        // imported sequence to exercise the actual saved-card trust boundary.
        db.set_segments(&media.id, &[first.clone(), second.clone(), third])
            .unwrap();
        assert!(db.save_card(&request, None).is_err());
        second.status = "confirmed".into();
        second.end_ms = 181_001;
        db.set_segments(&media.id, &[first.clone(), second.clone()])
            .unwrap();
        assert!(db.save_card(&request, None).is_err());
        second.end_ms = 3000;
        second.text = "Changed later".into();
        db.set_segments(&media.id, &[first, second]).unwrap();
        let retained = db.card(&saved.id).unwrap();
        assert_eq!(retained.source_cues[1].text, "Second half");
        assert_eq!(retained.audio_path.as_deref(), Some("whole-source.wav"));
        assert_eq!(retained.audio_clip_range, Some(range));
        crate::transfer::validate(&db.archive().unwrap()).unwrap();
        db.remove_media(&media.id).unwrap();
        crate::transfer::validate(&db.archive().unwrap()).unwrap();
        assert_eq!(
            db.card(&saved.id).unwrap().source_cues[1].text,
            "Second half"
        );
    }
    #[test]
    fn subtitle_replacement_is_explicit_versioned_atomic_and_portable() {
        let (temp, mut db, media, segment) = fixture();
        let mut replacement = segment.clone();
        replacement.id = "new-cue".into();
        replacement.text = "別の字幕".into();
        assert!(
            db.replace_subtitles(
                &media.id,
                std::slice::from_ref(&replacement),
                Some(6),
                false,
                "Before switch"
            )
            .is_err()
        );
        assert_eq!(db.list_segments(&media.id).unwrap()[0].text, segment.text);
        db.replace_subtitles(
            &media.id,
            std::slice::from_ref(&replacement),
            Some(6),
            true,
            "Before switch",
        )
        .unwrap();
        let old = db.subtitle_versions(&media.id).unwrap().remove(0);
        assert_eq!(old.stream_index, Some(5));
        assert_eq!(old.segments[0].text, segment.text);
        assert!(
            db.replace_subtitles(
                &media.id,
                &[replacement.clone(), replacement.clone()],
                Some(6),
                true,
                "invalid"
            )
            .is_err()
        );
        assert_eq!(db.subtitle_versions(&media.id).unwrap().len(), 1);
        db.restore_subtitle_version(&media.id, &old.id).unwrap();
        assert_eq!(db.list_segments(&media.id).unwrap()[0].text, segment.text);
        assert_eq!(db.media(&media.id).unwrap().subtitle_stream_index, Some(5));
        let backup = db.archive().unwrap();
        crate::transfer::validate(&backup).unwrap();
        let mut restored = Store::open(temp.path().join("restored.sqlite")).unwrap();
        restored
            .restore(&backup, &temp.path().join("prior.sqlite"))
            .unwrap();
        assert_eq!(restored.subtitle_versions(&media.id).unwrap().len(), 2);
        assert_eq!(
            restored.media(&media.id).unwrap().audio_stream_index,
            Some(4)
        );
        let mut old_json = serde_json::to_value(&backup).unwrap();
        old_json.as_object_mut().unwrap().remove("subtitleVersions");
        old_json["media"][0]
            .as_object_mut()
            .unwrap()
            .remove("audioStreamIndex");
        old_json["media"][0]
            .as_object_mut()
            .unwrap()
            .remove("subtitleStreamIndex");
        let legacy: LearningArchive = serde_json::from_value(old_json).unwrap();
        assert!(legacy.subtitle_versions.is_empty());
        assert_eq!(legacy.media[0].audio_stream_index, None);
    }
}
