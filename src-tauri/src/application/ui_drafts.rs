//! Unfinished input remains separate from committed content and credentials.
use super::*;
use surtitle_core::workspace::{ArchiveUiDraft, SaveUiDraft, UiDraft};

pub fn archive_ui_draft(state: AppState, request: ArchiveUiDraft) -> Result<UiDraft, String> {
    lock(&state.workspace)
        .and_then(|mut store| store.archive(&request))
        .map_err(err)
}

pub fn list_ui_drafts(state: AppState) -> Result<Vec<UiDraft>, String> {
    (|| {
        let db = lock(&state.db)?;
        let mut drafts = lock(&state.workspace)?.list(&db.learning_generation()?)?;
        for draft in &mut drafts {
            mark_changed_card(&db, draft);
        }
        Ok(drafts)
    })()
    .map_err(err)
}

pub fn get_ui_draft(
    state: AppState,
    kind: String,
    entity_id: String,
) -> Result<Option<UiDraft>, String> {
    (|| {
        let db = lock(&state.db)?;
        let generation = db.learning_generation()?;
        let mut draft = lock(&state.workspace)?.get(&kind, &entity_id, &generation)?;
        if let Some(draft) = &mut draft {
            mark_changed_card(&db, draft);
        }
        Ok(draft)
    })()
    .map_err(err)
}

pub fn save_ui_draft(state: AppState, request: SaveUiDraft) -> Result<UiDraft, String> {
    (|| {
        // Keep this lock through the draft write, so restore cannot change the
        // source generation between its read and binding the unfinished input.
        let db = lock(&state.db)?;
        let generation = db.learning_generation()?;
        let mut draft = lock(&state.workspace)?.save(&request, &generation)?;
        mark_changed_card(&db, &mut draft);
        Ok(draft)
    })()
    .map_err(err)
}

fn mark_changed_card(db: &Store, draft: &mut UiDraft) {
    if draft.kind == "draft_card" {
        let current = db.draft_study_selection(&draft.entity_id).ok();
        draft.stale |= current.as_ref().is_none_or(|current| {
            draft.fields.get("baseRevision") != Some(&current.version.to_string())
        });
    }
    if draft.kind == "card" {
        let current = db.card_edit_state(&draft.entity_id).ok();
        draft.stale |= current
            .as_ref()
            .is_none_or(|current| draft.fields.get("baseRevision") != Some(&current.revision));
    }
}

pub fn delete_ui_draft(
    state: AppState,
    kind: String,
    entity_id: String,
    expected_revision: u64,
) -> Result<(), String> {
    lock(&state.workspace)
        .and_then(|store| store.delete(&kind, &entity_id, expected_revision))
        .map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn draft_card_input_survives_restart_and_detaches_when_selection_changes_or_disappears() {
        let dir = tempfile::tempdir().unwrap();
        let state = Services::open(dir.path().to_path_buf()).unwrap();
        let source = dir.path().join("fixture.wav");
        std::fs::write(&source, b"isolated fixture").unwrap();
        let media: surtitle_core::Media = serde_json::from_value(serde_json::json!({
            "id":"media", "title":"Fixture", "path":source, "kind":"audio",
            "durationMs":3000,"learningLanguage":"en","explanationLanguage":"ja",
            "createdAt":"2026-10-11T00:00:00Z","lastPositionMs":0,"segmentCount":0,"cardCount":0,"status":"ready"
        })).unwrap();
        lock(&state.db).unwrap().put_media(&media).unwrap();
        let selection: surtitle_core::DraftStudySelection = serde_json::from_value(serde_json::json!({
            "id":"selection","mediaId":"media","jobId":null,"version":1,"text":"Source.",
            "startMs":1000,"endMs":2000,"sourceStartMs":0,"sourceEndMs":3000,"cueIds":[],"ordinal":null,
            "origin":"manual","timing":"manual","confirmed":false,"createdAt":"","updatedAt":"",
            "sourceSnapshot":{"fixture":true}
        })).unwrap();
        lock(&state.db)
            .unwrap()
            .insert_draft_study_selection(&selection)
            .unwrap();
        let saved = save_ui_draft(
            state.clone(),
            SaveUiDraft {
                kind: "draft_card".into(),
                entity_id: "selection".into(),
                expected_revision: 0,
                fields: [
                    ("term".into(), " unfinished ".into()),
                    ("meaning".into(), "".into()),
                    ("baseRevision".into(), "1".into()),
                ]
                .into(),
            },
        )
        .unwrap();
        assert!(!saved.stale);
        drop(state);
        let state = Services::open(dir.path().to_path_buf()).unwrap();
        assert_eq!(
            get_ui_draft(state.clone(), "draft_card".into(), "selection".into()).unwrap(),
            Some(saved.clone())
        );
        lock(&state.db)
            .unwrap()
            .update_draft_study_selection(
                "selection",
                1,
                &surtitle_core::DraftStudySelectionEdit {
                    text: "Changed source.".into(),
                    start_ms: 1000,
                    end_ms: 2000,
                    confirmed: false,
                },
            )
            .unwrap();
        let changed = get_ui_draft(state.clone(), "draft_card".into(), "selection".into())
            .unwrap()
            .unwrap();
        assert!(changed.stale);
        assert_eq!(changed.fields, saved.fields);
        lock(&state.db)
            .unwrap()
            .remove_draft_study_selection("selection", 2)
            .unwrap();
        assert!(
            get_ui_draft(state, "draft_card".into(), "selection".into())
                .unwrap()
                .unwrap()
                .stale
        );
    }
    #[test]
    fn native_drafts_preserve_invalid_fields_across_restart() {
        let dir = tempfile::tempdir().unwrap();
        let state = Services::open(dir.path().to_path_buf()).unwrap();
        let saved = save_ui_draft(
            state.clone(),
            SaveUiDraft {
                kind: "settings".into(),
                entity_id: "default".into(),
                expected_revision: 0,
                fields: [("retention".into(), "-".into())].into(),
            },
        )
        .unwrap();
        drop(state);
        let reopened = Services::open(dir.path().to_path_buf()).unwrap();
        assert_eq!(
            get_ui_draft(reopened.clone(), "settings".into(), "default".into()).unwrap(),
            Some(saved.clone())
        );
    }
    #[test]
    fn input_for_a_missing_card_is_retained_without_automatic_application_authority() {
        let dir = tempfile::tempdir().unwrap();
        let state = Services::open(dir.path().to_path_buf()).unwrap();
        let saved = save_ui_draft(
            state.clone(),
            SaveUiDraft {
                kind: "card".into(),
                entity_id: "removed".into(),
                expected_revision: 0,
                fields: [
                    ("term".into(), "keep this text".into()),
                    ("baseRevision".into(), "old".into()),
                ]
                .into(),
            },
        )
        .unwrap();
        assert!(saved.stale);
        assert_eq!(
            get_ui_draft(state.clone(), "card".into(), "removed".into()).unwrap(),
            Some(saved.clone())
        );
        assert!(lock(&state.db).unwrap().card("removed").is_err());
        assert_eq!(list_ui_drafts(state).unwrap(), vec![saved]);
    }
}
