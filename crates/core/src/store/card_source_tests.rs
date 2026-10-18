use super::*;

fn fixture() -> (tempfile::TempDir, Store, SaveCard) {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("source.wav");
    std::fs::write(&source, b"local source").unwrap();
    let mut db = Store::open(directory.path().join("learning.sqlite")).unwrap();
    let media: Media = serde_json::from_value(serde_json::json!({
        "id":"media", "title":"Original title", "path":source, "kind":"audio",
        "durationMs":300000, "learningLanguage":"en", "explanationLanguage":"ja",
        "createdAt":now(), "lastPositionMs":0, "segmentCount":2, "cardCount":0,
        "status":"ready", "audioStreamIndex":1
    }))
    .unwrap();
    db.put_media(&media).unwrap();
    let first = cue("a", 1000, 2500);
    let mut second = cue("c", 2000, 3000);
    second.translation = Some("second translation".into());
    db.set_segments("media", &[first, second]).unwrap();
    let request: SaveCard = serde_json::from_value(serde_json::json!({
        "mediaId":"media", "segmentId":"a", "sourceCueIds":["a","c"],
        "term":"example", "meaning":"meaning", "example":"a c"
    }))
    .unwrap();
    (directory, db, request)
}

fn cue(id: &str, start_ms: u64, end_ms: u64) -> SubtitleSegment {
    serde_json::from_value(serde_json::json!({
        "id":id, "mediaId":"media", "startMs":start_ms, "endMs":end_ms,
        "text":id, "translation":null, "status":"confirmed"
    }))
    .unwrap()
}

fn save(
    db: &Store,
    request: &SaveCard,
    source: &CardSourceSnapshot,
    draft: Option<&EditorDraftVersion>,
) -> Result<StudyCard> {
    db.save_card_with_source_snapshot(
        request,
        source,
        Some("clip.wav".into()),
        Some(source.range()),
        draft,
    )
}

fn phrase_draft(db: &Store, source: &CardSourceSnapshot) -> EditorDraftVersion {
    let saved = db
        .save_editor_draft(&SaveEditorDraft {
            id: "phrase".into(),
            media_id: "media".into(),
            kind: "phrase".into(),
            source_key: "selected-cues".into(),
            expected_version: 0,
            source_cues: source.cues().to_vec(),
            fields: [
                ("term", "example"),
                ("meaning", "meaning"),
                ("example", "a c"),
                ("explanation", ""),
            ]
            .into_iter()
            .map(|(key, value)| (key.into(), value.into()))
            .collect(),
        })
        .unwrap();
    EditorDraftVersion {
        id: saved.draft.id,
        version: saved.draft.version,
    }
}

#[test]
fn contiguous_lookup_keeps_time_and_id_order_and_detects_inserted_neighbors() {
    let (_directory, mut db, request) = fixture();
    let first = cue("a", 1000, 2500);
    let second = cue("c", 1000, 2000);
    db.set_segments(
        "media",
        &[
            cue("0", 1000, 1500),
            second.clone(),
            first.clone(),
            cue("z", 4000, 5000),
        ],
    )
    .unwrap();
    let source = db.card_source_snapshot(&request).unwrap();
    assert_eq!(
        source
            .cues()
            .iter()
            .map(|cue| cue.id.as_str())
            .collect::<Vec<_>>(),
        ["a", "c"]
    );
    assert_eq!(
        source.range(),
        AudioClipRange {
            start_ms: 1000,
            end_ms: 2500
        }
    );
    let card = save(&db, &request, &source, None).unwrap();
    assert_eq!(
        serde_json::to_value(card.source_cues).unwrap(),
        serde_json::to_value(source.cues()).unwrap()
    );
    db.set_segments("media", &[first, cue("b", 1000, 1800), second])
        .unwrap();
    assert!(save(&db, &request, &source, None).is_err());
    assert!(db.save_card(&request, None).is_err());
    assert_eq!(db.list_cards().unwrap().len(), 1);
}

#[test]
fn extraction_snapshot_rejects_changed_cues_and_does_not_restrict_unrelated_cues() {
    for change in [
        "text",
        "translation",
        "timing",
        "status",
        "removed",
        "inserted",
    ] {
        let (_directory, mut db, request) = fixture();
        let source = db.card_source_snapshot(&request).unwrap();
        let mut cues = source.cues().to_vec();
        match change {
            "text" => cues[0].text = "edited".into(),
            "translation" => cues[0].translation = Some("translated".into()),
            "timing" => cues[0].start_ms = 1100,
            "status" => cues[0].status = "draft".into(),
            "removed" => {
                cues.remove(0);
            }
            "inserted" => cues.push(cue("b", 1500, 1800)),
            _ => unreachable!(),
        }
        db.set_segments("media", &cues).unwrap();
        assert!(save(&db, &request, &source, None).is_err(), "{change}");
        assert!(db.list_cards().unwrap().is_empty());
    }
    let (_directory, mut db, request) = fixture();
    let source = db.card_source_snapshot(&request).unwrap();
    let mut cues = source.cues().to_vec();
    cues.extend([cue("before", 0, 500), cue("after", 4000, 5000)]);
    db.set_segments("media", &cues).unwrap();
    let card = save(&db, &request, &source, None).unwrap();
    assert!(
        card.translation.is_none(),
        "a partial translation must remain missing"
    );
    assert_eq!((card.start_ms, card.end_ms), (1000, 3000));
}

#[test]
fn source_block_snapshot_keeps_original_bounds_and_checks_selected_range() {
    let (_directory, mut db, mut request) = fixture();
    let mut block = cue("a", 0, 300000);
    block.timing_precision = "source_block".into();
    db.set_segments("media", &[block]).unwrap();
    request.source_cue_ids.clear();
    assert!(db.card_source_cues(&request).is_ok());
    assert_eq!(
        db.card_source_range(&request).unwrap_err().to_string(),
        "Source range must be at most 180 seconds"
    );
    request.source_range = Some(AudioClipRange {
        start_ms: 1000,
        end_ms: 2000,
    });
    let source = db.card_source_snapshot(&request).unwrap();
    let card = save(&db, &request, &source, None).unwrap();
    assert_eq!(card.source_cues[0].end_ms, 300000);
    assert_eq!((card.start_ms, card.end_ms), (1000, 2000));
    request.source_range = Some(AudioClipRange {
        start_ms: 1000,
        end_ms: 2500,
    });
    assert!(save(&db, &request, &source, None).is_err());

    let (_directory, db, mut request) = fixture();
    request.source_range = Some(AudioClipRange {
        start_ms: 1000,
        end_ms: 2000,
    });
    assert!(db.card_source_cues(&request).is_ok());
    assert_eq!(
        db.card_source_range(&request).unwrap_err().to_string(),
        "Only an audio source block can use a selected card range"
    );
    request.term.clear();
    request.media_id = "missing".into();
    assert_eq!(
        db.save_card(&request, None).unwrap_err().to_string(),
        "enter a term"
    );
}

#[test]
fn checked_save_retains_media_identity_policy_and_current_metadata() {
    for track_change in [false, true] {
        let (directory, db, request) = fixture();
        let source = db.card_source_snapshot(&request).unwrap();
        let mut media = source.media().clone();
        if track_change {
            media.audio_stream_index = Some(2);
        } else {
            media.path = directory
                .path()
                .join("replacement.wav")
                .to_string_lossy()
                .into_owned();
        }
        db.put_media(&media).unwrap();
        assert!(save(&db, &request, &source, None).is_err());
        assert!(db.list_cards().unwrap().is_empty());
    }
    let (_directory, db, request) = fixture();
    let source = db.card_source_snapshot(&request).unwrap();
    let mut media = source.media().clone();
    media.title = "Current title".into();
    media.learning_language = "fr".into();
    media.explanation_language = "en".into();
    media.duration_ms = 5000;
    db.put_media(&media).unwrap();
    let card = save(&db, &request, &source, None).unwrap();
    assert_eq!(card.source_title, media.title);
    assert_eq!(card.language, media.learning_language);
    media.duration_ms = 2000;
    db.put_media(&media).unwrap();
    assert_eq!(
        save(&db, &request, &source, None).unwrap_err().to_string(),
        "Clip exceeds media duration"
    );
}

#[test]
fn checked_phrase_save_rolls_back_card_when_draft_consumption_fails() {
    let (directory, db, request) = fixture();
    let source = db.card_source_snapshot(&request).unwrap();
    let reference = phrase_draft(&db, &source);
    db.conn.execute_batch("CREATE TRIGGER reject_draft_delete BEFORE DELETE ON editor_drafts BEGIN SELECT RAISE(ABORT,'fixture rejects draft consumption'); END;").unwrap();
    assert!(save(&db, &request, &source, Some(&reference)).is_err());
    assert!(db.list_cards().unwrap().is_empty());
    assert_eq!(
        db.editor_draft(&reference.id).unwrap().version,
        reference.version
    );
    db.conn
        .execute_batch("DROP TRIGGER reject_draft_delete;")
        .unwrap();
    let card = save(&db, &request, &source, Some(&reference)).unwrap();
    drop(db);
    let reopened = Store::open(directory.path().join("learning.sqlite")).unwrap();
    assert_eq!(
        reopened.card(&card.id).unwrap().audio_path.as_deref(),
        Some("clip.wav")
    );
    assert!(reopened.list_editor_drafts("media").unwrap().is_empty());
    assert!(save(&reopened, &request, &source, Some(&reference)).is_err());
    assert_eq!(reopened.list_cards().unwrap().len(), 1);
}

#[test]
fn identical_restore_keeps_plain_save_compatible_but_detaches_phrase_drafts() {
    let (directory, mut db, request) = fixture();
    let source = db.card_source_snapshot(&request).unwrap();
    let reference = phrase_draft(&db, &source);
    let original_generation = db.learning_generation().unwrap();
    let archive = db.archive().unwrap();
    db.restore(&archive, &directory.path().join("before.sqlite"))
        .unwrap();
    assert_ne!(db.learning_generation().unwrap(), original_generation);
    assert!(save(&db, &request, &source, Some(&reference)).is_err());
    assert!(db.list_cards().unwrap().is_empty());
    assert!(!db.editor_draft(&reference.id).unwrap().binding_verified);
    save(&db, &request, &source, None).unwrap();
    assert_eq!(db.list_cards().unwrap().len(), 1);
}
