use super::*;
use crate::{
    application::Services,
    runtime::{DesktopHost, test_runtime},
    ui::session::Backend,
};
use std::task::{Context, Poll, Waker};
fn fixture() -> (tempfile::TempDir, Persistence) {
    let dir =
        tempfile::tempdir_in(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../work"))
            .unwrap();
    let state = Services::open(dir.path().to_path_buf()).unwrap();
    let host = DesktopHost::new(
        test_runtime(),
        |task| {
            task();
            Ok(())
        },
        |_| Ok(()),
        |_| {},
    );
    let backend = Backend::new(state, host);
    (dir, Persistence::new(backend))
}
fn raw(value: &str) -> RawInput {
    let digest = "a".repeat(64);
    RawInput {
        id: surtitle_core::workspace::transcript_review_draft_id("job", &digest, "range:0", 1),
        expected_revision: 0,
        fields: [
            ("jobId".into(), "job".into()),
            ("draftDigest".into(), digest),
            ("target".into(), "range:0".into()),
            ("rangeVersion".into(), "1".into()),
            (
                "rows".into(),
                format!(r#"[{{"start":"00:","end":"","text":"{value}"}}]"#),
            ),
            ("confirmedNoSpeech".into(), "false".into()),
        ]
        .into(),
        force: false,
        lease: 0,
    }
}
#[test]
fn queued_raw_updates_are_serialized_and_flush_persists_the_latest_incomplete_input() {
    let (_dir, store) = fixture();
    let first = raw("first");
    let latest = raw("newer");
    store.raw(first).unwrap();
    store.raw(latest.clone()).unwrap();
    test_runtime()
        .block_on(store.flush(FlushPurpose::Save))
        .unwrap();
    let saved = commands::ui_drafts::get_ui_draft(
        &store.backend.state,
        "transcript_review".into(),
        latest.id,
    )
    .unwrap()
    .unwrap();
    assert_eq!(saved.fields["rows"], latest.fields["rows"]);
    assert!(!saved.stale);
    assert!(!store.pending());
    assert!(
        commands::ai::get_app_snapshot(&store.backend.state)
            .unwrap()
            .jobs
            .is_empty()
    );
}
#[test]
fn exclusive_flush_freezes_new_mutations_and_waits_for_a_real_operation_guard() {
    let (_dir, store) = fixture();
    let guard = store.operation().unwrap();
    let mut flush = store.flush(FlushPurpose::Restore);
    assert!(store.frozen());
    assert!(store.operation().is_err());
    assert!(store.raw(raw("blocked")).is_err());
    let mut cx = Context::from_waker(Waker::noop());
    assert!(matches!(flush.as_mut().poll(&mut cx), Poll::Pending));
    assert!(store.resume().is_err());
    drop(guard);
    test_runtime().block_on(flush).unwrap();
    assert!(store.frozen());
    store.backend.generation.fetch_add(1, Ordering::AcqRel);
    store.restored().unwrap();
    assert!(store.retired(0));
    test_runtime()
        .block_on(store.flush(FlushPurpose::Save))
        .unwrap();
    assert!(!store.frozen());
}
#[test]
fn a_competing_raw_draft_is_preserved_until_explicit_recovery() {
    let (_dir, store) = fixture();
    let foreign = raw("foreign");
    let saved = commands::ui_drafts::save_ui_draft(
        &store.backend.state,
        SaveUiDraft {
            kind: "transcript_review".into(),
            entity_id: foreign.id.clone(),
            expected_revision: 0,
            fields: foreign.fields.clone(),
        },
    )
    .unwrap();
    let mut local = raw("local");
    store.raw(local.clone()).unwrap();
    test_runtime()
        .block_on(store.flush(FlushPurpose::Save))
        .unwrap();
    let active = commands::ui_drafts::get_ui_draft(
        &store.backend.state,
        "transcript_review".into(),
        local.id.clone(),
    )
    .unwrap()
    .unwrap();
    assert_eq!(active.fields, saved.fields);
    let archives = commands::ui_drafts::list_ui_drafts(&store.backend.state).unwrap();
    assert!(
        archives
            .iter()
            .any(|d| d.archive_id.is_some() && d.fields["rows"] == local.fields["rows"])
    );
    local.force = true;
    store.raw(local.clone()).unwrap();
    test_runtime()
        .block_on(store.flush(FlushPurpose::Save))
        .unwrap();
    let active = commands::ui_drafts::get_ui_draft(
        &store.backend.state,
        "transcript_review".into(),
        local.id,
    )
    .unwrap()
    .unwrap();
    assert_eq!(active.fields["rows"], local.fields["rows"]);
    let archives = commands::ui_drafts::list_ui_drafts(&store.backend.state).unwrap();
    assert!(
        archives
            .iter()
            .any(|d| d.archive_id.is_some() && d.fields["rows"] == foreign.fields["rows"])
    );
}
#[test]
fn failed_input_write_blocks_close_and_a_healthy_retry_preserves_the_text() {
    let (_dir, store) = fixture();
    let mut bad = raw("kept locally");
    bad.fields.insert("credentialId".into(), "forbidden".into());
    store.raw(bad).unwrap();
    assert!(
        test_runtime()
            .block_on(store.flush(FlushPurpose::Close))
            .is_err()
    );
    assert!(!store.frozen());
    assert!(store.pending());
    let good = raw("kept locally");
    store.raw(good.clone()).unwrap();
    test_runtime()
        .block_on(store.flush(FlushPurpose::Save))
        .unwrap();
    assert!(!store.pending());
    let saved = commands::ui_drafts::get_ui_draft(
        &store.backend.state,
        "transcript_review".into(),
        good.id,
    )
    .unwrap()
    .unwrap();
    assert_eq!(saved.fields["rows"], good.fields["rows"]);
}
#[test]
fn a_restore_gate_cannot_be_released_or_invalidated_before_success() {
    let (_dir, store) = fixture();
    assert!(store.restored().is_err());
    let guard = store.operation().unwrap();
    let flush = store.flush(FlushPurpose::Restore);
    assert!(store.resume().is_err());
    assert!(store.restored().is_err());
    drop(guard);
    test_runtime().block_on(flush).unwrap();
    assert!(store.restored().is_err());
    store.resume().unwrap();
    assert!(!store.frozen());
}

#[test]
fn discarded_raw_owner_cannot_recreate_input_after_the_gate_resumes() {
    let (_dir, store) = fixture();
    let old = raw("incomplete old text");
    store.raw(old.clone()).unwrap();
    test_runtime()
        .block_on(store.flush(FlushPurpose::Export))
        .unwrap();
    let saved = commands::ui_drafts::get_ui_draft(
        &store.backend.state,
        "transcript_review".into(),
        old.id.clone(),
    )
    .unwrap()
    .unwrap();
    commands::ui_drafts::delete_ui_draft(
        &store.backend.state,
        "transcript_review".into(),
        old.id.clone(),
        saved.revision,
    )
    .unwrap();
    store.retire_raw(&old.id).unwrap();
    store.resume().unwrap();
    assert!(store.raw(old.clone()).is_err());
    test_runtime()
        .block_on(store.flush(FlushPurpose::Save))
        .unwrap();
    assert!(
        commands::ui_drafts::get_ui_draft(
            &store.backend.state,
            "transcript_review".into(),
            old.id.clone()
        )
        .unwrap()
        .is_none()
    );
    let mut reopened = old.clone();
    reopened.lease = store.raw_epoch(&old.id);
    reopened.fields.insert("rows".into(), "[]".into());
    store.raw(reopened).unwrap();
    test_runtime()
        .block_on(store.flush(FlushPurpose::Save))
        .unwrap();
    assert_eq!(
        commands::ui_drafts::get_ui_draft(&store.backend.state, "transcript_review".into(), old.id)
            .unwrap()
            .unwrap()
            .fields["rows"],
        "[]"
    );
}
#[test]
fn accepted_continuation_input_invalidates_an_already_read_list_before_delivery() {
    let (dir, store) = fixture();
    let media: surtitle_core::Media = serde_json::from_value(serde_json::json!({
        "id":"media", "title":"fixture", "path":dir.path().join("fixture.mp4").to_string_lossy(),
        "kind":"video", "durationMs":1000, "learningLanguage":"en", "explanationLanguage":"ja",
        "createdAt":"", "lastPositionMs":0, "audioStreamIndex":null, "subtitleStreamIndex":null,
        "segmentCount":0, "cardCount":0, "status":"ready", "error":null
    }))
    .unwrap();
    surtitle_core::Store::open(dir.path().join("learning.sqlite"))
        .unwrap()
        .put_media(&media)
        .unwrap();
    let mut value: AiContinuation = serde_json::from_value(serde_json::json!({
        "id":"request", "mediaId":"media", "kind":"vocabulary", "start":"00:", "end":"1.",
        "wholeMedia":false, "focusTerm":"previous input"
    }))
    .unwrap();
    store.continuation(value.clone(), 0).unwrap();
    test_runtime().block_on(store.drain_inputs()).unwrap();
    let read_epoch = store.continuation_read_epoch();
    let old_list = commands::continuations::list_ai_continuations(&store.backend.state).unwrap();
    value.focus_term = "  newer unfinished input  ".into();
    store.continuation(value.clone(), 0).unwrap();
    assert!(
        !store.continuation_read_current(read_epoch),
        "accepted input must invalidate the old list even before its async save completes"
    );
    let delivered = store
        .continuation_read_current(read_epoch)
        .then_some(old_list);
    assert!(delivered.is_none());
    test_runtime()
        .block_on(store.flush(FlushPurpose::Export))
        .unwrap();
    assert_eq!(
        commands::continuations::list_ai_continuations(&store.backend.state).unwrap()[0].focus_term,
        value.focus_term
    );
    let frozen_epoch = store.continuation_read_epoch();
    assert!(store.continuation(value, 0).is_err());
    assert!(
        store.continuation_read_current(frozen_epoch),
        "rejected frozen edits must not invalidate a valid read"
    );
    store.resume().unwrap();
}

#[test]
fn continuation_discard_drains_latest_raw_and_retires_only_its_original_writer() {
    let (_dir, store) = fixture();
    let media:surtitle_core::Media=serde_json::from_value(serde_json::json!({
        "id":"media","title":"fixture","path":_dir.path().join("fixture.mp4").to_string_lossy(),"kind":"video","durationMs":1000,
        "learningLanguage":"en","explanationLanguage":"ja","createdAt":"","lastPositionMs":0,
        "audioStreamIndex":null,"subtitleStreamIndex":null,"segmentCount":0,"cardCount":0,"status":"ready","error":null
    })).unwrap();
    surtitle_core::Store::open(_dir.path().join("learning.sqlite"))
        .unwrap()
        .put_media(&media)
        .unwrap();
    let value:AiContinuation=serde_json::from_value(serde_json::json!({
        "id":"request","mediaId":"media","kind":"vocabulary","start":"00:","end":"1.","wholeMedia":false,
        "focusTerm":"unfinished focus","preparationId":null,"quoteId":null,
        "modelInputs":{"vertex:vocabulary":{"enabled":"true","inputPrice":"1.","thinkingBudget":"-"}}
    })).unwrap();
    let lease = store.continuation_epoch(&value.id);
    store.continuation(value.clone(), lease).unwrap();
    assert!(store.retire_continuation(&value.id).is_err());
    test_runtime()
        .block_on(store.flush(FlushPurpose::Export))
        .unwrap();
    let saved = commands::continuations::list_ai_continuations(&store.backend.state).unwrap();
    // A list/open reader has captured this exact value, but its UI delivery is delayed.
    let delayed_read_epoch = store.continuation_read_epoch();
    let delayed_read = saved.clone();
    assert_eq!(
        saved[0].model_inputs["vertex:vocabulary"]["inputPrice"],
        "1."
    );
    commands::continuations::discard_ai_continuation(&store.backend.state, value.id.clone())
        .unwrap();
    store.retire_continuation(&value.id).unwrap();
    store.resume().unwrap();
    assert!(!store.continuation_read_current(delayed_read_epoch));
    let reopened_from_delayed_read = store
        .continuation_read_current(delayed_read_epoch)
        .then_some(delayed_read);
    assert!(
        reopened_from_delayed_read.is_none(),
        "a delayed list/open result must not acquire a fresh writer lease"
    );
    assert!(store.continuation(value.clone(), lease).is_err());
    test_runtime()
        .block_on(store.flush(FlushPurpose::Save))
        .unwrap();
    assert!(
        commands::continuations::list_ai_continuations(&store.backend.state)
            .unwrap()
            .is_empty()
    );
    let mut fresh = value.clone();
    fresh.focus_term = "fresh input".into();
    store
        .continuation(fresh, store.continuation_epoch(&value.id))
        .unwrap();
    test_runtime()
        .block_on(store.flush(FlushPurpose::Save))
        .unwrap();
    assert_eq!(
        commands::continuations::list_ai_continuations(&store.backend.state).unwrap()[0].focus_term,
        "fresh input"
    );
    assert!(
        commands::ai::get_app_snapshot(&store.backend.state)
            .unwrap()
            .jobs
            .is_empty()
    );
}
