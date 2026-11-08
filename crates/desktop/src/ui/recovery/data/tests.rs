use super::*;
use surtitle_core::workspace::{ArchiveUiDraft, SaveUiDraft};

fn backend() -> (tempfile::TempDir, Backend) {
    let dir = tempfile::tempdir().unwrap();
    let runtime = tokio::runtime::Handle::current();
    let state =
        crate::application::Services::open_with_runtime(dir.path().to_path_buf(), runtime.clone())
            .unwrap();
    let host = crate::runtime::DesktopHost::new(
        runtime,
        |work| {
            work();
            Ok(())
        },
        |_| Ok(()),
        |_| {},
    );
    (dir, Backend::new(state, host))
}

#[tokio::test]
async fn discard_requires_gate_and_exact_revision_and_never_deletes_archived_input() {
    let (_dir, backend) = backend();
    let first = commands::ui_drafts::save_ui_draft(
        &backend.state,
        SaveUiDraft {
            kind: "settings".into(),
            entity_id: "default".into(),
            expected_revision: 0,
            fields: [("retentionInput".into(), "89.".into())].into(),
        },
    )
    .unwrap();
    let current = commands::ui_drafts::save_ui_draft(
        &backend.state,
        SaveUiDraft {
            kind: "settings".into(),
            entity_id: "default".into(),
            expected_revision: first.revision,
            fields: [("retentionInput".into(), "new raw".into())].into(),
        },
    )
    .unwrap();
    let archived = commands::ui_drafts::archive_ui_draft(
        &backend.state,
        ArchiveUiDraft {
            kind: "settings".into(),
            entity_id: "default".into(),
            fields: first.fields.clone(),
        },
    )
    .unwrap();
    assert!(
        discard(backend.clone(), RecoveryItem::Ui(current.clone()))
            .await
            .is_err()
    );
    backend.exclusive.store(true, Ordering::Release);
    assert!(
        discard(backend.clone(), RecoveryItem::Ui(first))
            .await
            .is_err()
    );
    assert!(
        discard(backend.clone(), RecoveryItem::Ui(archived.clone()))
            .await
            .is_err()
    );
    assert_eq!(
        commands::ui_drafts::get_ui_draft(&backend.state, "settings".into(), "default".into())
            .unwrap(),
        Some(current.clone())
    );
    discard(backend.clone(), RecoveryItem::Ui(current))
        .await
        .unwrap();
    assert_eq!(
        commands::ui_drafts::list_ui_drafts(&backend.state).unwrap(),
        vec![archived]
    );
}

#[tokio::test]
async fn recovered_list_keeps_raw_orphan_input_readable_without_mutating_learning_data() {
    let (_dir, backend) = backend();
    let saved = commands::ui_drafts::save_ui_draft(
        &backend.state,
        SaveUiDraft {
            kind: "card".into(),
            entity_id: "deleted-card".into(),
            expected_revision: 0,
            fields: [
                ("term".into(), "  unfinished 日本語  ".into()),
                ("baseRevision".into(), "old".into()),
            ]
            .into(),
        },
    )
    .unwrap();
    let archived = commands::ui_drafts::archive_ui_draft(
        &backend.state,
        ArchiveUiDraft {
            kind: "card".into(),
            entity_id: "deleted-card".into(),
            fields: saved.fields.clone(),
        },
    )
    .unwrap();
    let rows = load(&backend.state).unwrap();
    assert_eq!(rows.len(), 2);
    let orphan = rows
        .iter()
        .find(|row| matches!(row,RecoveryItem::Ui(draft) if draft.archive_id.is_none()))
        .unwrap();
    assert!(orphan.can_recover());
    let copied: std::collections::BTreeMap<String, String> =
        serde_json::from_str(&orphan.text()).unwrap();
    assert_eq!(copied["term"], "  unfinished 日本語  ");
    assert!(!copied.contains_key("baseRevision"));
    let archived = rows
        .iter()
        .find(|row| matches!(row,RecoveryItem::Ui(draft) if draft.archive_id==archived.archive_id))
        .unwrap();
    assert!(!archived.can_open());
    assert!(!archived.can_recover());
    assert!(!archived.can_discard());
    assert!(
        commands::ai::get_app_snapshot(&backend.state)
            .unwrap()
            .cards
            .is_empty()
    );
}

#[tokio::test]
async fn source_discard_rejects_a_changed_draft_without_touching_subtitles() {
    let (dir, backend) = backend();
    let mut store = surtitle_core::Store::open(dir.path().join("learning.sqlite")).unwrap();
    let media=serde_json::from_value(serde_json::json!({"id":"media","title":"Test","path":dir.path().join("source.mp4"),"kind":"video","durationMs":10000,"learningLanguage":"en","explanationLanguage":"ja","createdAt":surtitle_core::now(),"lastPositionMs":0,"segmentCount":1,"cardCount":0,"status":"ready"})).unwrap();
    let cue:surtitle_core::SubtitleSegment=serde_json::from_value(serde_json::json!({"id":"cue","mediaId":"media","startMs":100,"endMs":1000,"text":"Original","translation":null,"status":"confirmed"})).unwrap();
    store.put_media(&media).unwrap();
    store
        .set_segments("media", std::slice::from_ref(&cue))
        .unwrap();
    let mut request = surtitle_core::SaveEditorDraft {
        id: "source-draft".into(),
        media_id: "media".into(),
        kind: "subtitle".into(),
        source_key: "cue".into(),
        expected_version: 0,
        fields: [
            ("text".into(), "Unfinished".into()),
            ("start".into(), "0.100".into()),
            ("end".into(), "1.000".into()),
            ("translation".into(), String::new()),
        ]
        .into(),
        source_cues: vec![cue],
    };
    let first =
        commands::editor_drafts::save_editor_draft(&backend.state, request.clone()).unwrap();
    request.expected_version = first.draft.version;
    request
        .fields
        .insert("text".into(), "Newer raw input".into());
    let current = commands::editor_drafts::save_editor_draft(&backend.state, request).unwrap();
    backend.exclusive.store(true, Ordering::Release);
    assert!(
        discard(backend.clone(), RecoveryItem::Source(first))
            .await
            .is_err()
    );
    let rows = load(&backend.state).unwrap();
    assert!(rows.iter().any(|item|matches!(item,RecoveryItem::Source(draft) if draft.draft.version==current.draft.version)));
    discard(backend.clone(), RecoveryItem::Source(current))
        .await
        .unwrap();
    assert!(
        commands::editor_drafts::list_editor_drafts(&backend.state, "media".into())
            .unwrap()
            .is_empty()
    );
    assert_eq!(store.list_segments("media").unwrap()[0].text, "Original");
}
