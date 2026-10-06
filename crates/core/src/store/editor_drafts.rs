use super::*;
use rusqlite::{Transaction, TransactionBehavior};

pub(super) fn initialize(connection: &Connection) -> Result<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS editor_drafts (
            id TEXT PRIMARY KEY, media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
            kind TEXT NOT NULL, source_key TEXT NOT NULL,
            version INTEGER NOT NULL CHECK(version>0), data TEXT NOT NULL,
            UNIQUE(media_id,kind,source_key));",
    )?;
    Ok(())
}

pub(crate) fn validate(draft: &EditorDraft) -> Result<()> {
    ensure!(
        !draft.id.is_empty()
            && draft.id.len() <= 128
            && draft
                .id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
            && !draft.media_id.is_empty()
            && draft.media_id.len() <= 128
            && !draft.source_key.is_empty()
            && draft.source_key.len() <= 4096
            && (1..=i64::MAX as u64).contains(&draft.version),
        "Invalid editor draft identity"
    );
    let keys: &[&str] = match draft.kind.as_str() {
        "phrase" => &["term", "meaning", "example", "explanation"],
        "subtitle" => &["start", "end", "text", "translation"],
        _ => anyhow::bail!("Unknown editor draft kind"),
    };
    ensure!(
        draft.fields.len() == keys.len()
            && keys.iter().all(|key| draft.fields.contains_key(*key))
            && draft.fields.values().all(|value| value.len() <= 64 * 1024),
        "Invalid editor draft fields"
    );
    ensure!(
        !draft.source_cues.is_empty() && draft.source_cues.len() <= 64,
        "Invalid editor draft source"
    );
    let mut ids = std::collections::HashSet::new();
    for cue in &draft.source_cues {
        validate_segment(cue)?;
        ensure!(
            cue.media_id == draft.media_id && ids.insert(&cue.id),
            "Invalid editor draft cue"
        );
    }
    ensure!(
        draft.kind != "subtitle" || draft.source_cues.len() == 1,
        "A subtitle editor needs one source cue"
    );
    ensure!(
        draft.source_media_signature.len() <= 32 * 1024,
        "Invalid editor source signature"
    );
    let created = chrono::DateTime::parse_from_rfc3339(&draft.created_at)?;
    let updated = chrono::DateTime::parse_from_rfc3339(&draft.updated_at)?;
    ensure!(updated >= created, "Invalid editor draft timestamps");
    Ok(())
}

fn signature(media: &Media) -> Result<String> {
    Ok(serde_json::to_string(&(
        &media.path,
        &media.learning_language,
        media.audio_stream_index,
    ))?)
}

impl Store {
    pub fn editor_draft(&self, id: &str) -> Result<EditorDraft> {
        let draft: EditorDraft = self.one("SELECT data FROM editor_drafts WHERE id=?", id)?;
        validate(&draft)?;
        Ok(draft)
    }

    pub fn editor_draft_stale(&self, draft: &EditorDraft) -> Result<bool> {
        if !draft.binding_verified {
            return Ok(true);
        }
        let media = self.media(&draft.media_id)?;
        let original: (String, String, Option<u32>) =
            serde_json::from_str(&draft.source_media_signature)?;
        if original.0 != media.path
            || original.1 != media.learning_language
            || original
                .2
                .is_some_and(|track| Some(track) != media.audio_stream_index)
        {
            return Ok(true);
        }
        for original in &draft.source_cues {
            let Ok(current) = self.segment(&original.id) else {
                return Ok(true);
            };
            if serde_json::to_value(&current)? != serde_json::to_value(original)? {
                return Ok(true);
            }
        }
        Ok(false)
    }

    pub fn editor_draft_view(&self, draft: EditorDraft) -> Result<EditorDraftView> {
        let stale = self.editor_draft_stale(&draft)?;
        Ok(EditorDraftView { draft, stale })
    }

    pub fn list_editor_drafts(&self, media_id: &str) -> Result<Vec<EditorDraftView>> {
        let mut query = self
            .conn
            .prepare("SELECT data FROM editor_drafts WHERE media_id=? ORDER BY rowid")?;
        let rows = query
            .query_map([media_id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.iter()
            .map(|json| {
                let draft: EditorDraft = serde_json::from_str(json)?;
                validate(&draft)?;
                self.editor_draft_view(draft)
            })
            .collect()
    }

    pub fn save_editor_draft(&self, request: &SaveEditorDraft) -> Result<EditorDraftView> {
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)?;
        let mut draft = if request.expected_version == 0 {
            EditorDraft {
                id: request.id.clone(),
                media_id: request.media_id.clone(),
                kind: request.kind.clone(),
                source_key: request.source_key.clone(),
                version: 1,
                fields: request.fields.clone(),
                source_cues: request.source_cues.clone(),
                source_media_signature: signature(&self.media(&request.media_id)?)?,
                binding_verified: true,
                created_at: now(),
                updated_at: now(),
            }
        } else {
            let mut current = self.editor_draft(&request.id)?;
            ensure!(
                current.version == request.expected_version,
                "Editor draft changed; reload it without discarding your input"
            );
            ensure!(
                current.media_id == request.media_id
                    && current.kind == request.kind
                    && current.source_key == request.source_key,
                "Editor draft identity changed"
            );
            current.version = current
                .version
                .checked_add(1)
                .context("Editor draft version overflow")?;
            current.fields = request.fields.clone();
            current
        };
        draft.updated_at = now().max(draft.updated_at.clone());
        validate(&draft)?;
        if request.expected_version == 0 {
            tx.execute("INSERT INTO editor_drafts(id,media_id,kind,source_key,version,data) VALUES(?,?,?,?,?,?)",
                params![draft.id, draft.media_id, draft.kind, draft.source_key, draft.version as i64, serde_json::to_string(&draft)?])?;
        } else {
            tx.execute(
                "UPDATE editor_drafts SET version=?,data=? WHERE id=?",
                params![
                    draft.version as i64,
                    serde_json::to_string(&draft)?,
                    draft.id
                ],
            )?;
        }
        tx.commit()?;
        self.editor_draft_view(draft)
    }

    pub fn rebind_editor_draft(
        &self,
        reference: &EditorDraftVersion,
        source_cues: &[SubtitleSegment],
    ) -> Result<EditorDraftView> {
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)?;
        let mut draft = self.editor_draft(&reference.id)?;
        ensure!(
            draft.version == reference.version,
            "Editor draft changed; reload it"
        );
        draft.source_cues = source_cues.to_vec();
        draft.source_key =
            serde_json::to_string(&source_cues.iter().map(|cue| &cue.id).collect::<Vec<_>>())?;
        if draft.kind == "phrase" {
            let ids = source_cues
                .iter()
                .map(|cue| cue.id.clone())
                .collect::<Vec<_>>();
            crate::confirmed_cue_range(
                &self.list_segments(&draft.media_id)?,
                &draft.media_id,
                &ids,
            )?;
        }
        draft.source_media_signature = signature(&self.media(&draft.media_id)?)?;
        draft.binding_verified = true;
        draft.version = draft
            .version
            .checked_add(1)
            .context("Editor draft version overflow")?;
        draft.updated_at = now().max(draft.updated_at.clone());
        validate(&draft)?;
        ensure!(
            !self.editor_draft_stale(&draft)?,
            "The source changed again; reload the current subtitles"
        );
        tx.execute(
            "UPDATE editor_drafts SET source_key=?,version=?,data=? WHERE id=?",
            params![
                draft.source_key,
                draft.version as i64,
                serde_json::to_string(&draft)?,
                draft.id
            ],
        )?;
        tx.commit()?;
        self.editor_draft_view(draft)
    }

    pub fn delete_editor_draft(&self, reference: &EditorDraftVersion) -> Result<()> {
        let removed = self.conn.execute(
            "DELETE FROM editor_drafts WHERE id=? AND version=?",
            params![reference.id, reference.version as i64],
        )?;
        ensure!(
            removed == 1,
            "Editor draft changed; reload it before discarding"
        );
        Ok(())
    }

    fn checked_editor_draft(
        &self,
        reference: &EditorDraftVersion,
        kind: &str,
    ) -> Result<EditorDraft> {
        let draft = self.editor_draft(&reference.id)?;
        ensure!(
            draft.version == reference.version && draft.kind == kind,
            "Editor draft changed; reload it"
        );
        ensure!(
            !self.editor_draft_stale(&draft)?,
            "The source changed; reconnect this draft to the current subtitles"
        );
        Ok(draft)
    }

    pub fn commit_subtitle_editor_draft(
        &self,
        reference: &EditorDraftVersion,
        segment: &SubtitleSegment,
    ) -> Result<()> {
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)?;
        let draft = self.checked_editor_draft(reference, "subtitle")?;
        ensure!(
            draft.source_cues[0].id == segment.id && draft.media_id == segment.media_id,
            "Subtitle editor source changed"
        );
        self.edit_segment(segment)?;
        self.delete_editor_draft(reference)?;
        tx.commit()?;
        Ok(())
    }

    pub fn save_card_from_editor_draft(
        &self,
        reference: &EditorDraftVersion,
        request: &SaveCard,
        audio_path: Option<String>,
        range: Option<AudioClipRange>,
    ) -> Result<StudyCard> {
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)?;
        let draft = self.checked_editor_draft(reference, "phrase")?;
        let ids = if request.source_cue_ids.is_empty() {
            vec![request.segment_id.clone()]
        } else {
            request.source_cue_ids.clone()
        };
        ensure!(
            draft.media_id == request.media_id
                && draft.source_cues.iter().map(|cue| &cue.id).eq(ids.iter()),
            "Phrase editor source changed"
        );
        let card = self.save_card_with_audio_range(request, audio_path, range)?;
        self.delete_editor_draft(reference)?;
        tx.commit()?;
        Ok(card)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, Store, SubtitleSegment) {
        let directory = tempfile::tempdir().unwrap();
        let mut db = Store::open(directory.path().join("learning.sqlite")).unwrap();
        let media: Media = serde_json::from_value(serde_json::json!({
            "id":"media", "title":"Example", "path":directory.path().join("source.mp4"), "sourceUrl":null,
            "kind":"video", "durationMs":10000, "learningLanguage":"en", "explanationLanguage":"ja",
            "createdAt":now(), "lastPositionMs":0, "segmentCount":1, "cardCount":0,
            "status":"ready", "error":null, "audioStreamIndex":1, "subtitleStreamIndex":null
        })).unwrap();
        let cue: SubtitleSegment = serde_json::from_value(serde_json::json!({
            "id":"cue", "mediaId":"media", "startMs":100, "endMs":1000,
            "text":"Original text", "translation":null, "status":"confirmed"
        }))
        .unwrap();
        db.put_media(&media).unwrap();
        db.set_segments("media", std::slice::from_ref(&cue))
            .unwrap();
        (directory, db, cue)
    }

    fn request(cue: &SubtitleSegment) -> SaveEditorDraft {
        SaveEditorDraft {
            id: "editor-1".into(),
            media_id: "media".into(),
            kind: "subtitle".into(),
            source_key: "cue".into(),
            expected_version: 0,
            source_cues: vec![cue.clone()],
            fields: [
                ("start", "00:"),
                ("end", ""),
                ("text", "Unfinished"),
                ("translation", ""),
            ]
            .into_iter()
            .map(|(key, value)| (key.into(), value.into()))
            .collect(),
        }
    }

    #[test]
    fn incomplete_input_survives_restart_and_stale_updates_do_not_overwrite() {
        let (directory, db, cue) = fixture();
        let mut request = request(&cue);
        let saved = db.save_editor_draft(&request).unwrap();
        assert!(!saved.stale);
        drop(db);
        let db = Store::open(directory.path().join("learning.sqlite")).unwrap();
        assert_eq!(
            db.list_editor_drafts("media").unwrap()[0].draft.fields["start"],
            "00:"
        );
        request.expected_version = 1;
        request.fields.insert("text".into(), "Newer input".into());
        assert_eq!(db.save_editor_draft(&request).unwrap().draft.version, 2);
        request.fields.insert("text".into(), "Stale input".into());
        assert!(db.save_editor_draft(&request).is_err());
        assert!(
            db.delete_editor_draft(&EditorDraftVersion {
                id: request.id.clone(),
                version: 1
            })
            .is_err()
        );
        assert_eq!(
            db.editor_draft(&request.id).unwrap().fields["text"],
            "Newer input"
        );
    }

    #[test]
    fn source_changes_keep_input_and_require_explicit_rebind_before_atomic_commit() {
        let (_directory, db, mut cue) = fixture();
        let saved = db.save_editor_draft(&request(&cue)).unwrap();
        cue.text = "Changed source".into();
        db.edit_segment(&cue).unwrap();
        let reference = EditorDraftVersion {
            id: saved.draft.id,
            version: 1,
        };
        assert!(db.list_editor_drafts("media").unwrap()[0].stale);
        assert!(db.commit_subtitle_editor_draft(&reference, &cue).is_err());
        let rebound = db
            .rebind_editor_draft(&reference, std::slice::from_ref(&cue))
            .unwrap();
        assert_eq!(rebound.draft.fields["text"], "Unfinished");
        assert!(!rebound.stale);
        let reference = EditorDraftVersion {
            id: reference.id,
            version: 2,
        };
        let mut invalid = cue.clone();
        invalid.end_ms = invalid.start_ms;
        assert!(
            db.commit_subtitle_editor_draft(&reference, &invalid)
                .is_err()
        );
        assert!(db.editor_draft(&reference.id).is_ok());
        cue.text = "User finished text".into();
        db.commit_subtitle_editor_draft(&reference, &cue).unwrap();
        assert!(db.list_editor_drafts("media").unwrap().is_empty());
        assert_eq!(db.segment("cue").unwrap().text, "User finished text");
        assert!(db.commit_subtitle_editor_draft(&reference, &cue).is_err());
    }

    #[test]
    fn learning_archives_preserve_drafts_without_reactivating_source_bindings() {
        let (directory, mut db, cue) = fixture();
        db.save_editor_draft(&request(&cue)).unwrap();
        let archive = db.archive().unwrap();
        assert_eq!(archive.schema_version, 2);
        assert!(!archive.editor_drafts[0].binding_verified);
        for extension in ["json", "zip"] {
            let path = directory.path().join(format!("learning.{extension}"));
            if extension == "json" {
                crate::transfer::export_json(&archive, &path).unwrap();
            } else {
                crate::transfer::export_zip(&archive, directory.path(), &path).unwrap();
            }
            let restored = crate::transfer::read_archive(&path).unwrap();
            assert_eq!(restored.editor_drafts[0].fields["start"], "00:");
            assert!(!restored.editor_drafts[0].binding_verified);
            db.restore(
                &restored,
                &directory.path().join(format!("before-{extension}.sqlite")),
            )
            .unwrap();
            assert!(db.list_editor_drafts("media").unwrap()[0].stale);
        }
        let mut legacy = serde_json::to_value(&archive).unwrap();
        legacy["schemaVersion"] = 1.into();
        legacy.as_object_mut().unwrap().remove("editorDrafts");
        let legacy: LearningArchive = serde_json::from_value(legacy).unwrap();
        crate::transfer::validate(&legacy).unwrap();
        assert!(legacy.editor_drafts.is_empty());
    }

    #[test]
    fn phrase_rebind_moves_source_identity_and_final_save_consumes_draft_once() {
        let (_directory, mut db, cue) = fixture();
        let mut request = request(&cue);
        request.kind = "phrase".into();
        request.fields = [
            ("term", "hello"),
            ("meaning", "greeting"),
            ("example", "Hello"),
            ("explanation", "Notes"),
        ]
        .into_iter()
        .map(|(key, value)| (key.into(), value.into()))
        .collect();
        let saved = db.save_editor_draft(&request).unwrap();
        let mut replacement = cue.clone();
        replacement.id = "replacement".into();
        db.set_segments("media", std::slice::from_ref(&replacement))
            .unwrap();
        let reference = EditorDraftVersion {
            id: saved.draft.id,
            version: 1,
        };
        assert!(db.list_editor_drafts("media").unwrap()[0].stale);
        let rebound = db.rebind_editor_draft(&reference, &[replacement]).unwrap();
        assert_eq!(rebound.draft.source_key, "[\"replacement\"]");
        assert_eq!(rebound.draft.fields["meaning"], "greeting");
        let reference = EditorDraftVersion {
            id: reference.id,
            version: 2,
        };
        let card_request: SaveCard = serde_json::from_value(serde_json::json!({
            "mediaId":"media", "segmentId":"replacement", "term":"hello", "meaning":"greeting", "example":"Hello"
        })).unwrap();
        db.save_card_from_editor_draft(&reference, &card_request, None, None)
            .unwrap();
        assert!(db.list_editor_drafts("media").unwrap().is_empty());
        assert!(
            db.save_card_from_editor_draft(&reference, &card_request, None, None)
                .is_err()
        );
        assert_eq!(db.list_cards().unwrap().len(), 1);
    }
}
