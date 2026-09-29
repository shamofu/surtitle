use super::*;
fn segment() -> surtitle_core::SubtitleSegment {
    surtitle_core::SubtitleSegment {
        id: "cue".into(),
        media_id: "media".into(),
        start_ms: 0,
        end_ms: 1000,
        text: "Hello.".into(),
        translation: None,
        status: "confirmed".into(),
    }
}
fn cue() -> SourceCue {
    SourceCue {
        id: "cue".into(),
        start_ms: 0,
        end_ms: 1000,
        text: "Hello.".into(),
    }
}
#[test]
fn own_translation_updates_do_not_invalidate_approved_source() {
    let original = segment();
    let mut translated = original.clone();
    translated.translation = Some("こんにちは。".into());
    assert_eq!(
        transcript_fingerprint(&[original]).unwrap(),
        transcript_fingerprint(&[translated.clone()]).unwrap()
    );
    assert!(source_matches(&cue(), &translated, "media"));
}
#[test]
fn edited_text_timing_status_or_media_invalidates_source() {
    let mut changed = segment();
    changed.text = "Goodbye.".into();
    assert!(!source_matches(&cue(), &changed, "media"));
    changed = segment();
    changed.end_ms = 1200;
    assert!(!source_matches(&cue(), &changed, "media"));
    changed = segment();
    changed.status = "draft".into();
    assert!(!source_matches(&cue(), &changed, "media"));
    assert!(!source_matches(&cue(), &segment(), "another-media"));
}
fn translation_fixture() -> (tempfile::TempDir, AppState, PreparedJob) {
    let temp = tempfile::tempdir().unwrap();
    let state = Services::open(temp.path().to_path_buf()).unwrap();
    let media = surtitle_core::Media {
        id: "media".into(),
        title: "Fixture".into(),
        path: temp
            .path()
            .join("fixture.mp4")
            .to_string_lossy()
            .into_owned(),
        source_url: None,
        kind: "video".into(),
        duration_ms: 2000,
        learning_language: "en".into(),
        explanation_language: "ja".into(),
        created_at: surtitle_core::now(),
        last_position_ms: 0,
        segment_count: 1,
        card_count: 0,
        status: "ready".into(),
        error: None,
        audio_stream_index: Some(0),
        subtitle_stream_index: None,
    };
    {
        let mut db = lock(&state.db).unwrap();
        db.put_media(&media).unwrap();
        db.set_segments("media", &[segment()]).unwrap();
    }
    let plan = PreparedJob::new(
        "Translation".into(),
        "test-project".into(),
        "unused".into(),
        PreparationBinding {
            media_id: "media".into(),
            transcript_revision: "revision".into(),
            source_sha256: sha256_bytes(b"source"),
            settings_sha256: sha256_bytes(b"settings"),
        },
        vec![RequestTask::Translation {
            target_language: "ja".into(),
            cues: vec![cue()],
        }],
        crate::application::models::fixture_execution(),
    )
    .unwrap();
    (temp, state, plan)
}
fn translation() -> ParsedOutput {
    ParsedOutput::Translation {
        translations: vec![CueTranslation {
            id: "cue".into(),
            translation: "こんにちは。".into(),
        }],
    }
}
#[test]
fn stale_translation_is_never_applied_to_edited_source() {
    let (_temp, state, plan) = translation_fixture();
    let mut changed = segment();
    changed.text = "Goodbye.".into();
    lock(&state.db).unwrap().edit_segment(&changed).unwrap();
    let output = ParsedOutput::Translation {
        translations: vec![CueTranslation {
            id: "cue".into(),
            translation: "こんにちは。".into(),
        }],
    };
    assert!(apply_received_output(&state, "job", 0, &plan, output).is_err());
    assert!(
        lock(&state.db)
            .unwrap()
            .segment("cue")
            .unwrap()
            .translation
            .is_none()
    );
}
#[test]
fn local_application_persists_once_without_keys_or_budget_and_preserves_manual_edits() {
    let (temp, state, plan) = translation_fixture();
    assert!(
        state
            .preferences
            .test_value()
            .unwrap()
            .credential_id
            .is_none()
    );
    assert_eq!(
        state.ai.summary().unwrap().monthly_actual_charged_microusd,
        0
    );
    let hash = sha256_bytes(&serde_json::to_vec(&translation()).unwrap());
    apply_received_output(&state, "job", 0, &plan, translation()).unwrap();
    assert!(
        lock(&state.db)
            .unwrap()
            .ai_result_applied("job", 0, &hash)
            .unwrap()
    );
    drop(state);
    let state = Services::open(temp.path().to_path_buf()).unwrap();
    let mut edited = lock(&state.db).unwrap().segment("cue").unwrap();
    assert_eq!(edited.translation.as_deref(), Some("こんにちは。"));
    edited.text = "The source was manually corrected.".into();
    edited.translation = Some("手動で変更した訳".into());
    lock(&state.db).unwrap().edit_segment(&edited).unwrap();
    drop(state);
    let state = Services::open(temp.path().to_path_buf()).unwrap();
    apply_received_output(&state, "job", 0, &plan, translation()).unwrap();
    assert_eq!(
        lock(&state.db).unwrap().segment("cue").unwrap().text,
        "The source was manually corrected."
    );
    assert!(
        lock(&state.db)
            .unwrap()
            .ai_result_applied("job", 0, &hash)
            .unwrap()
    );
    assert_eq!(
        lock(&state.db)
            .unwrap()
            .segment("cue")
            .unwrap()
            .translation
            .as_deref(),
        Some("手動で変更した訳")
    );
    assert!(state.ai.list_jobs().unwrap().is_empty());
    assert_eq!(
        state.ai.summary().unwrap().monthly_actual_charged_microusd,
        0
    );
}
#[test]
fn translation_batch_rolls_back_every_row_and_marker_on_failure() {
    let (_temp, state, _plan) = translation_fixture();
    let mut first = segment();
    first.translation = Some("変更前にロールバック".into());
    let mut missing = first.clone();
    missing.id = "missing".into();
    let hash = sha256_bytes(b"response");
    let mut db = lock(&state.db).unwrap();
    assert!(
        db.apply_translations_once("job", 0, &hash, &[first, missing])
            .is_err()
    );
    assert!(db.segment("cue").unwrap().translation.is_none());
    assert!(!db.ai_result_applied("job", 0, &hash).unwrap());
}
#[test]
fn translation_language_change_blocks_local_application() {
    let (_temp, state, plan) = translation_fixture();
    let db = lock(&state.db).unwrap();
    let mut media = db.media("media").unwrap();
    media.explanation_language = "de".into();
    db.put_media(&media).unwrap();
    drop(db);
    assert!(apply_received_output(&state, "job", 0, &plan, translation()).is_err());
    assert!(
        lock(&state.db)
            .unwrap()
            .segment("cue")
            .unwrap()
            .translation
            .is_none()
    );
}
