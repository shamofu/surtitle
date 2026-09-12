use super::*;
use rusqlite::{Transaction, TransactionBehavior};

pub(super) fn initialize(connection: &Connection) -> Result<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS draft_study_selections (
            id TEXT PRIMARY KEY, media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
            version INTEGER NOT NULL CHECK(version>0), data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS draft_study_media ON draft_study_selections(media_id);",
    )?;
    Ok(())
}

pub(crate) fn validate(selection: &DraftStudySelection, media: &Media) -> Result<()> {
    ensure!(
        !selection.id.is_empty()
            && selection.id.len() <= 128
            && selection
                .id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
            && selection.media_id == media.id
            && (1..=i64::MAX as u64).contains(&selection.version),
        "Invalid draft study selection identity"
    );
    ensure!(
        selection.source_start_ms < selection.source_end_ms
            && selection.source_end_ms <= media.duration_ms
            && selection.source_start_ms <= selection.start_ms
            && selection.start_ms < selection.end_ms
            && selection.end_ms <= selection.source_end_ms,
        "Draft study range is outside its original source or media"
    );
    ensure!(
        selection.text.len() < 64 * 1024,
        "Draft study text is too large"
    );
    ensure!(
        !selection.confirmed || !selection.text.trim().is_empty(),
        "A confirmed draft study selection requires text"
    );
    ensure!(
        ["ai", "manual", "mixed"].contains(&selection.origin.as_str())
            && ["cue", "source_block", "manual"].contains(&selection.timing.as_str()),
        "Invalid draft study origin or timing"
    );
    ensure!(
        selection.cue_ids.len() <= 1000,
        "Too many draft study source cues"
    );
    let mut ids = std::collections::HashSet::new();
    for cue in &selection.cue_ids {
        ensure!(
            !cue.is_empty() && cue.len() < 256 && ids.insert(cue),
            "Invalid draft study source cues"
        );
    }
    ensure!(
        selection
            .job_id
            .as_ref()
            .is_none_or(|id| !id.is_empty() && id.len() <= 128),
        "Invalid draft study job"
    );
    if selection.source_snapshot.is_null() {
        ensure!(
            selection.job_id.is_none() && !selection.confirmed,
            "A detached bookmark must have its source verified before confirmation"
        );
    } else {
        ensure!(
            selection
                .source_snapshot
                .as_object()
                .is_some_and(|object| !object.is_empty())
                && serde_json::to_vec(&selection.source_snapshot)?.len() <= 64 * 1024,
            "Invalid draft study source snapshot"
        );
    }
    let created = chrono::DateTime::parse_from_rfc3339(&selection.created_at)?;
    let updated = chrono::DateTime::parse_from_rfc3339(&selection.updated_at)?;
    ensure!(updated >= created, "Invalid draft study timestamps");
    Ok(())
}

fn read(connection: &Connection, id: &str) -> Result<DraftStudySelection> {
    let (version, data): (i64, String) = connection
        .query_row(
            "SELECT version,data FROM draft_study_selections WHERE id=?",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .context("Draft study selection not found")?;
    let selection: DraftStudySelection = serde_json::from_str(&data)?;
    ensure!(
        version > 0 && selection.version == version as u64 && selection.id == id,
        "Draft study selection storage differs"
    );
    Ok(selection)
}

fn media(connection: &Connection, id: &str) -> Result<Media> {
    let data: String =
        connection.query_row("SELECT data FROM media WHERE id=?", [id], |row| row.get(0))?;
    Ok(serde_json::from_str(&data)?)
}

fn confirmed_source(
    selection: &DraftStudySelection,
    version: u64,
    media: &Media,
) -> Result<SubtitleSegment> {
    ensure!(
        selection.version == version,
        "Draft study selection changed; reload it"
    );
    validate(selection, media)?;
    ensure!(
        selection.confirmed && !selection.source_snapshot.is_null(),
        "Confirm the verified draft study selection before saving a card"
    );
    ensure!(
        selection.end_ms - selection.start_ms <= 180_000,
        "Card audio must be at most 180 seconds"
    );
    let cue = SubtitleSegment {
        id: format!("draft:{}:{}", selection.id, selection.version),
        media_id: selection.media_id.clone(),
        start_ms: selection.start_ms,
        end_ms: selection.end_ms,
        text: selection.text.clone(),
        translation: None,
        status: "confirmed".into(),
    };
    validate_segment(&cue)?;
    Ok(cue)
}

impl Store {
    pub fn insert_draft_study_selection(
        &self,
        selection: &DraftStudySelection,
    ) -> Result<DraftStudySelection> {
        ensure!(
            selection.version == 1,
            "A new draft study selection starts at version one"
        );
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)?;
        let mut selection = selection.clone();
        selection.created_at = now();
        selection.updated_at = selection.created_at.clone();
        validate(&selection, &media(&tx, &selection.media_id)?)?;
        tx.execute(
            "INSERT INTO draft_study_selections(id,media_id,version,data) VALUES(?,?,?,?)",
            params![
                selection.id,
                selection.media_id,
                selection.version as i64,
                serde_json::to_string(&selection)?
            ],
        )?;
        tx.commit()?;
        Ok(selection)
    }

    pub fn list_draft_study_selections(&self, media_id: &str) -> Result<Vec<DraftStudySelection>> {
        let mut query = self
            .conn
            .prepare("SELECT data FROM draft_study_selections WHERE media_id=? ORDER BY rowid")?;
        let rows = query
            .query_map([media_id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter()
            .map(|row| Ok(serde_json::from_str(&row)?))
            .collect()
    }

    pub fn draft_study_selection(&self, id: &str) -> Result<DraftStudySelection> {
        read(&self.conn, id)
    }

    pub fn update_draft_study_selection(
        &self,
        id: &str,
        expected_version: u64,
        edit: &DraftStudySelectionEdit,
    ) -> Result<DraftStudySelection> {
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)?;
        let mut selection = read(&tx, id)?;
        ensure!(
            selection.version == expected_version,
            "Draft study selection changed; reload it"
        );
        selection.version = selection
            .version
            .checked_add(1)
            .context("Draft study version overflow")?;
        selection.text = edit.text.clone();
        selection.start_ms = edit.start_ms;
        selection.end_ms = edit.end_ms;
        selection.confirmed = edit.confirmed;
        selection.origin = "manual".into();
        selection.timing = "manual".into();
        // A clock adjustment cannot make an existing record's history run backward.
        let timestamp = now();
        if chrono::DateTime::parse_from_rfc3339(&timestamp)?
            > chrono::DateTime::parse_from_rfc3339(&selection.updated_at)?
        {
            selection.updated_at = timestamp;
        }
        validate(&selection, &media(&tx, &selection.media_id)?)?;
        ensure!(
            tx.execute(
                "UPDATE draft_study_selections SET version=?,data=? WHERE id=? AND version=?",
                params![
                    selection.version as i64,
                    serde_json::to_string(&selection)?,
                    id,
                    expected_version as i64
                ]
            )? == 1,
            "Draft study selection changed; reload it"
        );
        tx.commit()?;
        Ok(selection)
    }

    pub fn remove_draft_study_selection(&self, id: &str, expected_version: u64) -> Result<()> {
        ensure!(
            (1..=i64::MAX as u64).contains(&expected_version),
            "Invalid draft study version"
        );
        ensure!(
            self.conn.execute(
                "DELETE FROM draft_study_selections WHERE id=? AND version=?",
                params![id, expected_version as i64]
            )? == 1,
            "Draft study selection changed or was removed; reload it"
        );
        Ok(())
    }

    pub fn draft_study_source_cue(
        &self,
        id: &str,
        expected_version: u64,
    ) -> Result<SubtitleSegment> {
        let selection = read(&self.conn, id)?;
        confirmed_source(
            &selection,
            expected_version,
            &self.media(&selection.media_id)?,
        )
    }

    /// Save a frozen excerpt without adopting or changing canonical subtitles.
    /// Native code verifies the opaque source binding before extracting audio.
    pub fn save_draft_selection_card(
        &self,
        id: &str,
        expected_version: u64,
        fields: &DraftStudyCardFields,
        audio_path: Option<String>,
        audio_clip_range: Option<AudioClipRange>,
    ) -> Result<StudyCard> {
        ensure!(
            !fields.term.trim().is_empty() && fields.term.len() < 4096,
            "Enter a term"
        );
        ensure!(
            [
                Some(&fields.meaning),
                fields.translation.as_ref(),
                fields.explanation.as_ref()
            ]
            .into_iter()
            .flatten()
            .all(|text| text.len() < 64 * 1024),
            "Card is too large"
        );
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)?;
        let selection = read(&tx, id)?;
        let media = media(&tx, &selection.media_id)?;
        let cue = confirmed_source(&selection, expected_version, &media)?;
        if let Some(range) = audio_clip_range {
            ensure!(audio_path.is_some(), "Clip range requires saved audio");
            range.validate_source(cue.start_ms, cue.end_ms)?;
            ensure!(
                range.end_ms <= media.duration_ms,
                "Clip exceeds media duration"
            );
        }
        let at = now();
        let card = StudyCard {
            id: crate::id(),
            media_id: media.id,
            segment_id: cue.id.clone(),
            source_cues: vec![cue.clone()],
            term: fields.term.trim().into(),
            meaning: fields.meaning.clone(),
            example: cue.text.clone(),
            language: media.learning_language,
            due_at: at.clone(),
            created_at: at,
            review_count: 0,
            audio_path,
            audio_clip_range,
            audio_stream_index: media.audio_stream_index,
            suspended: false,
            translation: fields.translation.clone(),
            explanation: fields.explanation.clone(),
            source_title: media.title,
            source_url: media.source_url,
            start_ms: cue.start_ms,
            end_ms: cue.end_ms,
            memory: None,
            last_review: None,
        };
        tx.execute(
            "INSERT INTO cards(id,data) VALUES(?,?)",
            params![card.id, serde_json::to_string(&card)?],
        )?;
        tx.commit()?;
        Ok(card)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, Store, DraftStudySelection) {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source.wav");
        std::fs::write(&source, b"owned source fixture").unwrap();
        let db = Store::open(temp.path().join("learning.sqlite")).unwrap();
        let media = Media {
            id: "media".into(),
            title: "Original title".into(),
            path: source.to_string_lossy().into_owned(),
            source_url: Some("https://example.invalid/lesson".into()),
            kind: "audio".into(),
            duration_ms: 8000,
            learning_language: "en".into(),
            explanation_language: "ja".into(),
            created_at: now(),
            last_position_ms: 0,
            segment_count: 0,
            card_count: 0,
            status: "ready".into(),
            error: None,
            audio_stream_index: Some(2),
            subtitle_stream_index: None,
        };
        db.put_media(&media).unwrap();
        let selection = DraftStudySelection {
            id: "selection".into(),
            media_id: media.id,
            job_id: Some("job-local-only".into()),
            version: 1,
            text: "An unchanged example.".into(),
            start_ms: 1200,
            end_ms: 2100,
            source_start_ms: 1000,
            source_end_ms: 7000,
            cue_ids: vec!["provider-cue".into()],
            ordinal: Some(1),
            origin: "ai".into(),
            timing: "cue".into(),
            confirmed: false,
            created_at: String::new(),
            updated_at: String::new(),
            source_snapshot: serde_json::json!({"digest":"immutable-source-hash","path":media.path,"audioStreamIndex":2}),
        };
        (temp, db, selection)
    }
    fn edit(selection: &DraftStudySelection, confirmed: bool) -> DraftStudySelectionEdit {
        DraftStudySelectionEdit {
            text: selection.text.clone(),
            start_ms: selection.start_ms,
            end_ms: selection.end_ms,
            confirmed,
        }
    }
    fn fields() -> DraftStudyCardFields {
        DraftStudyCardFields {
            term: " unchanged ".into(),
            meaning: "unaltered".into(),
            example: "Untrusted caller example must not replace the source.".into(),
            translation: Some("saved translation".into()),
            explanation: Some("saved explanation".into()),
        }
    }

    #[test]
    fn persistence_cas_and_immutable_source_binding() {
        let (temp, db, selection) = fixture();
        let original = db.insert_draft_study_selection(&selection).unwrap();
        assert!(db.insert_draft_study_selection(&selection).is_err());
        let other = Store::open(temp.path().join("learning.sqlite")).unwrap();
        assert_eq!(other.draft_study_selection(&original.id).unwrap(), original);
        let mut change = edit(&original, true);
        change.text = "Locally corrected example.".into();
        change.start_ms = 1100;
        let updated = other
            .update_draft_study_selection(&original.id, 1, &change)
            .unwrap();
        assert_eq!(updated.version, 2);
        assert_eq!(updated.source_snapshot, original.source_snapshot);
        assert_eq!(updated.job_id, original.job_id);
        assert_eq!(updated.cue_ids, original.cue_ids);
        assert_eq!(updated.ordinal, original.ordinal);
        assert_eq!(
            (updated.source_start_ms, updated.source_end_ms),
            (1000, 7000)
        );
        assert_eq!(updated.created_at, original.created_at);
        assert_eq!((&*updated.origin, &*updated.timing), ("manual", "manual"));
        assert!(
            db.update_draft_study_selection(&original.id, 1, &change)
                .is_err()
        );
        assert!(db.remove_draft_study_selection(&original.id, 1).is_err());
        assert_eq!(
            db.list_draft_study_selections("media").unwrap(),
            vec![updated.clone()]
        );
        drop(other);
        drop(db);
        let reopened = Store::open(temp.path().join("learning.sqlite")).unwrap();
        assert_eq!(
            reopened.draft_study_selection(&original.id).unwrap(),
            updated
        );
        reopened
            .remove_draft_study_selection(&original.id, 2)
            .unwrap();
        assert!(reopened.draft_study_selection(&original.id).is_err());
    }

    #[test]
    fn invalid_edits_do_not_change_version_or_source() {
        let (_temp, db, selection) = fixture();
        let original = db.insert_draft_study_selection(&selection).unwrap();
        for change in [
            DraftStudySelectionEdit {
                start_ms: 999,
                ..edit(&original, true)
            },
            DraftStudySelectionEdit {
                end_ms: 7001,
                ..edit(&original, true)
            },
            DraftStudySelectionEdit {
                end_ms: original.start_ms,
                ..edit(&original, true)
            },
            DraftStudySelectionEdit {
                text: " ".into(),
                ..edit(&original, true)
            },
            DraftStudySelectionEdit {
                text: "x".repeat(64 * 1024),
                ..edit(&original, false)
            },
        ] {
            assert!(
                db.update_draft_study_selection(&original.id, 1, &change)
                    .is_err()
            );
            assert_eq!(db.draft_study_selection(&original.id).unwrap(), original);
        }
        let mut shortened = db.media("media").unwrap();
        shortened.duration_ms = 6000;
        db.put_media(&shortened).unwrap();
        assert!(
            db.update_draft_study_selection(&original.id, 1, &edit(&original, true))
                .is_err()
        );
        assert_eq!(db.draft_study_selection(&original.id).unwrap(), original);
    }

    #[test]
    fn insertion_checks_bounds_and_detached_authority() {
        let (_temp, db, selection) = fixture();
        let mut invalid = selection.clone();
        invalid.source_end_ms = 8001;
        assert!(db.insert_draft_study_selection(&invalid).is_err());
        invalid = selection.clone();
        invalid.cue_ids.push(invalid.cue_ids[0].clone());
        assert!(db.insert_draft_study_selection(&invalid).is_err());
        invalid = selection.clone();
        invalid.source_snapshot = serde_json::json!({});
        assert!(db.insert_draft_study_selection(&invalid).is_err());
        invalid = selection.detached();
        invalid.confirmed = true;
        assert!(db.insert_draft_study_selection(&invalid).is_err());
        invalid = selection.detached();
        invalid.text.clear();
        let stored = db.insert_draft_study_selection(&invalid).unwrap();
        assert!(!stored.confirmed);
        assert!(db.draft_study_source_cue(&stored.id, 1).is_err());
        let mut change = edit(&stored, true);
        change.text = "Restored text still lacks a verified source.".into();
        assert!(
            db.update_draft_study_selection(&stored.id, 1, &change)
                .is_err()
        );
        change.confirmed = false;
        assert!(
            db.update_draft_study_selection(&stored.id, 1, &change)
                .is_ok()
        );
    }

    #[test]
    fn confirmed_card_is_frozen_without_canonical_adoption() {
        let (temp, mut db, selection) = fixture();
        let original = db.insert_draft_study_selection(&selection).unwrap();
        assert!(
            db.save_draft_selection_card(&original.id, 1, &fields(), None, None)
                .is_err()
        );
        let confirmed = db
            .update_draft_study_selection(&original.id, 1, &edit(&original, true))
            .unwrap();
        let cue = db.draft_study_source_cue(&original.id, 2).unwrap();
        assert_eq!(cue.id, "draft:selection:2");
        assert!(db.list_segments("media").unwrap().is_empty());
        let audio = temp.path().join("card.wav");
        std::fs::write(&audio, b"immutable saved audio").unwrap();
        let range = AudioClipRange {
            start_ms: 1050,
            end_ms: 2250,
        };
        assert!(
            db.save_draft_selection_card(&original.id, 1, &fields(), None, None)
                .is_err()
        );
        assert!(
            db.save_draft_selection_card(&original.id, 2, &fields(), None, Some(range))
                .is_err()
        );
        assert!(db.list_cards().unwrap().is_empty());
        let card = db
            .save_draft_selection_card(
                &original.id,
                2,
                &fields(),
                Some(audio.to_string_lossy().into_owned()),
                Some(range),
            )
            .unwrap();
        assert_eq!(card.example, original.text);
        assert_eq!(card.term, "unchanged");
        assert_eq!(card.source_cues[0].text, original.text);
        assert_eq!(card.audio_stream_index, Some(2));
        assert_eq!(card.audio_clip_range, Some(range));
        let fixed_card = serde_json::to_value(&card).unwrap();
        let mut change = edit(&confirmed, false);
        change.text = "Later source revision".into();
        let updated = db
            .update_draft_study_selection(&original.id, 2, &change)
            .unwrap();
        db.remove_draft_study_selection(&original.id, updated.version)
            .unwrap();
        assert_eq!(
            serde_json::to_value(db.card(&card.id).unwrap()).unwrap(),
            fixed_card
        );
        assert!(db.list_segments("media").unwrap().is_empty());
        let rated = db
            .rate_card(&card.id, "good", 0.9, chrono::Utc::now())
            .unwrap();
        assert_eq!(rated.example, card.example);
        assert_eq!(std::fs::read(&audio).unwrap(), b"immutable saved audio");
        db.remove_media("media").unwrap();
        crate::transfer::validate(&db.archive().unwrap()).unwrap();
        drop(db);
        let reopened = Store::open(temp.path().join("learning.sqlite")).unwrap();
        assert_eq!(
            reopened.card(&card.id).unwrap().source_cues[0].text,
            card.example
        );
        assert_eq!(reopened.list_reviews().unwrap().len(), 1);
    }

    #[test]
    fn card_rechecks_cas_after_another_connection_edits_the_selection() {
        let (temp, db, selection) = fixture();
        let mut selection = db.insert_draft_study_selection(&selection).unwrap();
        selection = db
            .update_draft_study_selection(&selection.id, 1, &edit(&selection, true))
            .unwrap();
        let prepared = db.draft_study_source_cue(&selection.id, 2).unwrap();
        let other = Store::open(temp.path().join("learning.sqlite")).unwrap();
        let mut changed = edit(&selection, true);
        changed.end_ms = 3000;
        other
            .update_draft_study_selection(&selection.id, 2, &changed)
            .unwrap();
        assert_eq!(prepared.end_ms, 2100);
        assert!(
            db.save_draft_selection_card(&selection.id, 2, &fields(), None, None)
                .is_err()
        );
        assert!(db.list_cards().unwrap().is_empty());
    }

    #[test]
    fn json_zip_and_restore_keep_bookmarks_but_detach_operational_bindings() {
        let (temp, db, selection) = fixture();
        let selection = db.insert_draft_study_selection(&selection).unwrap();
        let confirmed = db
            .update_draft_study_selection(&selection.id, 1, &edit(&selection, true))
            .unwrap();
        let archive = db.archive().unwrap();
        assert_eq!(archive.draft_study_selections, vec![confirmed.detached()]);
        let text = serde_json::to_string(&archive).unwrap();
        assert!(!text.contains("job-local-only") && !text.contains("immutable-source-hash"));
        let mut raw = archive.clone();
        raw.draft_study_selections = vec![confirmed.clone()];
        for suffix in ["json", "zip"] {
            let path = temp.path().join(format!("export.{suffix}"));
            if suffix == "json" {
                crate::transfer::export_json(&raw, &path).unwrap();
            } else {
                crate::transfer::export_zip(&raw, temp.path(), &path).unwrap();
            }
            let parsed = crate::transfer::read_archive(&path).unwrap();
            assert_eq!(parsed.draft_study_selections, vec![confirmed.detached()]);
        }
        // A direct archive caller cannot bypass restoration's detachment step.
        let mut restored = Store::open(temp.path().join("restored.sqlite")).unwrap();
        restored
            .restore(&raw, &temp.path().join("prior.sqlite"))
            .unwrap();
        assert_eq!(
            restored.draft_study_selection(&selection.id).unwrap(),
            confirmed.detached()
        );
        assert!(restored.draft_study_source_cue(&selection.id, 2).is_err());
        assert!(
            restored
                .update_draft_study_selection(&selection.id, 2, &edit(&confirmed, true))
                .is_err()
        );
        assert!(
            restored
                .save_draft_selection_card(&selection.id, 2, &fields(), None, None)
                .is_err()
        );
        assert!(temp.path().join("prior.sqlite").is_file());
        let mut invalid = raw.clone();
        invalid.draft_study_selections[0].end_ms = 9000;
        let rejected_backup = temp.path().join("must-not-backup-invalid.sqlite");
        assert!(restored.restore(&invalid, &rejected_backup).is_err());
        assert!(!rejected_backup.exists());
        assert_eq!(
            restored.draft_study_selection(&selection.id).unwrap(),
            confirmed.detached()
        );
        let mut old = serde_json::to_value(archive).unwrap();
        old.as_object_mut().unwrap().remove("draftStudySelections");
        assert!(
            serde_json::from_value::<LearningArchive>(old)
                .unwrap()
                .draft_study_selections
                .is_empty()
        );
        db.remove_media("media").unwrap();
        assert!(db.list_draft_study_selections("media").unwrap().is_empty());
    }

    #[test]
    fn source_cue_length_and_clip_boundaries_match_ordinary_cards() {
        let (_temp, db, selection) = fixture();
        let selection = db.insert_draft_study_selection(&selection).unwrap();
        let confirmed = db
            .update_draft_study_selection(&selection.id, 1, &edit(&selection, true))
            .unwrap();
        for range in [
            AudioClipRange {
                start_ms: 1201,
                end_ms: 2100,
            },
            AudioClipRange {
                start_ms: 0,
                end_ms: 2100,
            },
            AudioClipRange {
                start_ms: 1200,
                end_ms: 3101,
            },
        ] {
            assert!(
                db.save_draft_selection_card(
                    &confirmed.id,
                    2,
                    &fields(),
                    Some("generated.wav".into()),
                    Some(range)
                )
                .is_err()
            );
        }
        assert!(db.list_cards().unwrap().is_empty());
        let mut longer_media = db.media("media").unwrap();
        longer_media.duration_ms = 400_000;
        db.put_media(&longer_media).unwrap();
        let long = DraftStudySelection {
            id: "long-selection".into(),
            version: 1,
            start_ms: 0,
            end_ms: 180_001,
            source_start_ms: 0,
            source_end_ms: 400_000,
            ..confirmed
        };
        let long = db.insert_draft_study_selection(&long).unwrap();
        assert!(db.draft_study_source_cue(&long.id, 1).is_err());
        assert!(
            db.save_draft_selection_card(&long.id, 1, &fields(), None, None)
                .is_err()
        );
        let exact = db
            .update_draft_study_selection(
                &long.id,
                1,
                &DraftStudySelectionEdit {
                    end_ms: 180_000,
                    ..edit(&long, true)
                },
            )
            .unwrap();
        assert!(
            db.save_draft_selection_card(&exact.id, 2, &fields(), None, None)
                .is_ok()
        );
    }
}
