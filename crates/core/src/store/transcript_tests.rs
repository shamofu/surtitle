use super::*;
fn segment(id: &str, start_ms: u64, end_ms: u64, text: &str) -> SubtitleSegment {
    SubtitleSegment {
        id: id.into(),
        media_id: "media".into(),
        start_ms,
        end_ms,
        text: text.into(),
        translation: None,
        status: "confirmed".into(),
    }
}
fn fixture() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let mut db = Store::open(dir.path().join("learning.sqlite")).unwrap();
    db.put_media(&Media {
        id: "media".into(),
        title: "Source".into(),
        path: dir.path().join("source.wav").to_string_lossy().into_owned(),
        source_url: None,
        kind: "audio".into(),
        duration_ms: 16000,
        learning_language: "en".into(),
        explanation_language: "ja".into(),
        created_at: now(),
        last_position_ms: 0,
        audio_stream_index: None,
        subtitle_stream_index: None,
        segment_count: 2,
        card_count: 0,
        status: "ready".into(),
        error: None,
    })
    .unwrap();
    db.set_segments(
        "media",
        &[
            segment("old", 0, 1000, "Original"),
            segment("outside", 10000, 11000, "Outside selection"),
        ],
    )
    .unwrap();
    (dir, db)
}
#[test]
fn explicit_adoption_is_atomic_and_idempotent_across_restart_without_changing_cards() {
    let (dir, mut db) = fixture();
    let card = db
        .save_card(
            &SaveCard {
                media_id: "media".into(),
                segment_id: "old".into(),
                source_cue_ids: vec![],
                term: "Original".into(),
                meaning: "Saved meaning".into(),
                example: "Original".into(),
                translation: Some("保存時の訳".into()),
                explanation: Some("保存時の解説".into()),
            },
            None,
        )
        .unwrap();
    let revision = subtitle_revision(&db.list_segments("media").unwrap()).unwrap();
    let job = "a".repeat(64);
    let draft = "b".repeat(64);
    let replacement = vec![segment("new", 1000, 2000, "Reviewed transcript")];
    assert!(
        db.adopt_transcript_once(
            "job",
            &job,
            &draft,
            "media",
            &revision,
            0,
            8000,
            &replacement
        )
        .unwrap()
    );
    assert!(db.segment("old").is_err());
    assert_eq!(db.segment("outside").unwrap().text, "Outside selection");
    assert_eq!(db.card(&card.id).unwrap().example, "Original");
    let mut edited = db.segment("new").unwrap();
    edited.text = "Later manual edit".into();
    edited.translation = Some("後の訳".into());
    db.edit_segment(&edited).unwrap();
    drop(db);
    let mut db = Store::open(dir.path().join("learning.sqlite")).unwrap();
    assert!(
        !db.adopt_transcript_once(
            "job",
            &job,
            &draft,
            "media",
            "stale-revision",
            0,
            8000,
            &replacement
        )
        .unwrap()
    );
    assert_eq!(db.segment("new").unwrap().text, "Later manual edit");
    assert_eq!(
        db.segment("new").unwrap().translation.as_deref(),
        Some("後の訳")
    );
    assert_eq!(db.transcript_adopted("job", &job).unwrap(), Some(draft));
    assert_eq!(
        db.card(&card.id).unwrap().translation.as_deref(),
        Some("保存時の訳")
    );
}
#[test]
fn truncated_old_cues_out_of_range_replacements_and_stale_sources_fail_without_deletion() {
    let (_dir, mut db) = fixture();
    let job = "a".repeat(64);
    let draft = "b".repeat(64);
    let revision = subtitle_revision(&db.list_segments("media").unwrap()).unwrap();
    assert!(
        db.adopt_transcript_once(
            "job",
            &job,
            &draft,
            "media",
            &revision,
            500,
            8000,
            &[segment("new", 1000, 2000, "New")]
        )
        .is_err()
    );
    assert!(
        db.adopt_transcript_once(
            "job",
            &job,
            &draft,
            "media",
            &revision,
            0,
            8000,
            &[segment("new", 7000, 9000, "New")]
        )
        .is_err()
    );
    assert!(
        db.adopt_transcript_once(
            "job",
            &job,
            &draft,
            "media",
            "stale",
            0,
            8000,
            &[segment("new", 1000, 2000, "New")]
        )
        .is_err()
    );
    assert_eq!(db.segment("old").unwrap().text, "Original");
    assert!(db.transcript_adopted("job", &job).unwrap().is_none());
}
#[test]
fn insert_failure_rolls_back_deleted_cues_new_rows_and_adoption_marker() {
    let (_dir, mut db) = fixture();
    let job = "a".repeat(64);
    let draft = "b".repeat(64);
    let revision = subtitle_revision(&db.list_segments("media").unwrap()).unwrap();
    let replacement = vec![
        segment("new", 1000, 2000, "New"),
        segment("outside", 3000, 4000, "Collision with retained subtitle"),
    ];
    assert!(
        db.adopt_transcript_once(
            "job",
            &job,
            &draft,
            "media",
            &revision,
            0,
            8000,
            &replacement
        )
        .is_err()
    );
    assert_eq!(db.segment("old").unwrap().text, "Original");
    assert!(db.segment("new").is_err());
    assert_eq!(db.segment("outside").unwrap().text, "Outside selection");
    assert!(db.transcript_adopted("job", &job).unwrap().is_none());
}
#[test]
fn local_draft_versions_survive_restart_but_are_excluded_from_exports_and_restore() {
    let (dir, db) = fixture();
    let data = serde_json::json!({"choice":"left","original":"retained"});
    db.save_transcript_draft("job", "job-digest", "base-one", &data)
        .unwrap();
    db.save_transcript_draft(
        "job",
        "job-digest",
        "base-two",
        &serde_json::json!({"choice":"manual"}),
    )
    .unwrap();
    drop(db);
    let mut db = Store::open(dir.path().join("learning.sqlite")).unwrap();
    assert_eq!(
        db.transcript_draft::<serde_json::Value>("job", "job-digest", "base-one")
            .unwrap(),
        Some(data)
    );
    let archive = db.archive().unwrap();
    assert!(
        !serde_json::to_string(&archive)
            .unwrap()
            .contains("job-digest")
    );
    db.restore(&archive, &dir.path().join("backup.sqlite"))
        .unwrap();
    assert!(
        db.transcript_draft::<serde_json::Value>("job", "job-digest", "base-one")
            .unwrap()
            .is_none()
    );
}
