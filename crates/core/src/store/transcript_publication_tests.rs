use super::*;

fn cue(id: &str, start_ms: u64, end_ms: u64, text: &str) -> SubtitleSegment {
    serde_json::from_value(serde_json::json!({
        "id":id, "mediaId":"media", "startMs":start_ms, "endMs":end_ms,
        "text":text, "translation":null, "status":"generated"
    }))
    .unwrap()
}

fn fixture(rows: &[SubtitleSegment]) -> (tempfile::TempDir, Store) {
    let directory = tempfile::tempdir().unwrap();
    let mut store = Store::open(directory.path().join("learning.sqlite")).unwrap();
    let media: Media = serde_json::from_value(serde_json::json!({
        "id":"media", "title":"Source", "path":directory.path().join("source.wav"), "sourceUrl":null,
        "kind":"audio", "durationMs":400000, "learningLanguage":"en", "explanationLanguage":"ja",
        "createdAt":now(), "lastPositionMs":0, "segmentCount":0, "cardCount":0,
        "status":"ready", "error":null, "audioStreamIndex":1, "subtitleStreamIndex":null
    })).unwrap();
    store.put_media(&media).unwrap();
    store.set_segments("media", rows).unwrap();
    (directory, store)
}

fn begin(store: &mut Store, job: &str, start_ms: u64, end_ms: u64) {
    let revision = subtitle_revision(&store.list_segments("media").unwrap()).unwrap();
    store
        .begin_transcript_publication(job, &"a".repeat(64), "media", &revision, start_ms, end_ms)
        .unwrap();
    store
        .activate_transcript_publication(job, &"a".repeat(64))
        .unwrap();
}

fn publish(
    store: &mut Store,
    job: &str,
    start_ms: u64,
    end_ms: u64,
    projection: &[SubtitleSegment],
) -> TranscriptPublicationReport {
    store
        .publish_transcript_progress(
            job,
            &"a".repeat(64),
            &[TranscriptPublicationRange { start_ms, end_ms }],
            projection,
            &[],
        )
        .unwrap()
}

#[test]
fn partial_publication_is_atomic_restartable_and_saves_one_original_version() {
    let old = cue("old", 100, 900, "Original");
    let outside = cue("outside", 10000, 11000, "Unreceived");
    let (directory, mut store) = fixture(&[old.clone(), outside.clone()]);
    begin(&mut store, "job", 0, 12000);
    let first = cue("provider:1", 200, 800, "Received text");
    assert!(publish(&mut store, "job", 0, 5000, std::slice::from_ref(&first)).changed);
    assert_eq!(store.segment("outside").unwrap().text, "Unreceived");
    assert!(store.segment("old").is_err());
    assert_eq!(store.subtitle_versions("media").unwrap().len(), 1);
    assert_eq!(
        store.subtitle_versions("media").unwrap()[0].segments.len(),
        2
    );
    drop(store);
    let mut store = Store::open(directory.path().join("learning.sqlite")).unwrap();
    assert!(!publish(&mut store, "job", 0, 5000, std::slice::from_ref(&first)).changed);
    let second = cue("provider:2", 10200, 10800, "Next text");
    assert!(
        publish(
            &mut store,
            "job",
            5000,
            12000,
            &[first.clone(), second.clone()]
        )
        .changed
    );
    assert_eq!(store.list_segments("media").unwrap().len(), 2);
    assert_eq!(store.subtitle_versions("media").unwrap().len(), 1);
    store
        .finish_transcript_publication("job", &"a".repeat(64))
        .unwrap();
    assert!(!publish(&mut store, "job", 0, 12000, &[]).changed);
    assert_eq!(store.segment(&first.id).unwrap().text, first.text);
    assert!(
        store
            .transcript_publication_active("job", &"a".repeat(64))
            .unwrap()
    );
}

#[test]
fn whole_old_cue_is_preserved_until_its_full_coverage_is_received() {
    let old = cue("spans-boundary", 500, 6500, "Old whole cue");
    let (_directory, mut store) = fixture(std::slice::from_ref(&old));
    begin(&mut store, "job", 0, 10000);
    let first = cue("first", 500, 2000, "First words");
    let report = publish(&mut store, "job", 0, 5000, std::slice::from_ref(&first));
    assert!(!report.changed);
    assert_eq!(report.deferred_segment_ids, vec!["first"]);
    assert_eq!(store.segment(&old.id).unwrap().end_ms, 6500);
    let next = cue("next", 5200, 6300, "Next words");
    assert!(publish(&mut store, "job", 5000, 10000, &[first, next]).changed);
    assert!(store.segment(&old.id).is_err());
    assert_eq!(store.list_segments("media").unwrap().len(), 2);
}

#[test]
fn successful_empty_received_range_replaces_old_text_without_inventing_cues() {
    let (_directory, mut store) = fixture(&[cue("old", 100, 2000, "Old")]);
    begin(&mut store, "job", 0, 5000);
    assert!(publish(&mut store, "job", 0, 5000, &[]).changed);
    assert!(store.list_segments("media").unwrap().is_empty());
    assert_eq!(store.subtitle_versions("media").unwrap().len(), 1);
}

#[test]
fn manual_translation_edits_protect_generated_rows_across_later_projection_changes() {
    let (directory, mut store) = fixture(&[]);
    begin(&mut store, "job", 0, 10000);
    let first = cue("first", 1000, 2000, "Provider text");
    publish(&mut store, "job", 0, 5000, std::slice::from_ref(&first));
    let mut edited = first.clone();
    edited.translation = Some("自分の翻訳".into());
    store.edit_segment(&edited).unwrap();
    drop(store);
    let mut store = Store::open(directory.path().join("learning.sqlite")).unwrap();
    let replacement = cue("new-first", 1100, 1900, "Later provider wording");
    let second = cue("second", 6000, 7000, "New received region");
    let report = publish(
        &mut store,
        "job",
        5000,
        10000,
        &[replacement.clone(), second],
    );
    assert!(report.changed);
    assert_eq!(
        store.segment("first").unwrap().translation.as_deref(),
        Some("自分の翻訳")
    );
    assert!(store.segment("new-first").is_err());
    assert_eq!(
        store
            .transcript_publication_candidates("job", &"a".repeat(64))
            .unwrap()[0]
            .text,
        replacement.text
    );
}

#[test]
fn moved_deleted_and_added_rows_protect_both_old_and_new_ranges() {
    let old = cue("old", 1000, 2000, "Move me");
    let deleted = cue("deleted", 3000, 4000, "Delete me");
    let (_directory, mut store) = fixture(&[old.clone(), deleted]);
    begin(&mut store, "job", 0, 10000);
    let mut moved = old;
    moved.start_ms = 5000;
    moved.end_ms = 6000;
    store.edit_segment(&moved).unwrap();
    store
        .conn
        .execute("DELETE FROM segments WHERE id='deleted'", [])
        .unwrap();
    let added = cue("manual-added", 7000, 8000, "Added text");
    store
        .conn
        .execute(
            "INSERT INTO segments(id,media_id,start_ms,data) VALUES(?,?,?,?)",
            params![
                added.id,
                added.media_id,
                added.start_ms as i64,
                serde_json::to_string(&added).unwrap()
            ],
        )
        .unwrap();
    let projection = [
        cue("p1", 1200, 1800, "Old place"),
        cue("p2", 3200, 3800, "Deleted place"),
        cue("p3", 5200, 5800, "Moved place"),
        cue("p4", 7200, 7800, "Added place"),
        cue("p5", 8500, 9000, "Untouched"),
    ];
    let report = publish(&mut store, "job", 0, 10000, &projection);
    assert_eq!(report.protected_ranges.len(), 4);
    assert_eq!(report.deferred_segment_ids, vec!["p1", "p2", "p3", "p4"]);
    assert!(store.segment("deleted").is_err());
    assert_eq!(store.segment("old").unwrap().start_ms, 5000);
    assert!(store.segment("manual-added").is_ok());
    assert!(store.segment("p5").is_ok());
}

#[test]
fn newer_requested_interval_protects_against_late_older_results() {
    let (_directory, mut store) = fixture(&[]);
    begin(&mut store, "older", 0, 10000);
    begin(&mut store, "newer", 3000, 6000);
    publish(
        &mut store,
        "newer",
        3000,
        6000,
        &[cue("new", 3500, 4500, "Newer")],
    );
    let report = publish(
        &mut store,
        "older",
        0,
        10000,
        &[
            cue("late", 3500, 4500, "Late older"),
            cue("other", 1000, 2000, "Older outside"),
        ],
    );
    assert_eq!(report.deferred_segment_ids, vec!["late"]);
    assert_eq!(store.segment("new").unwrap().text, "Newer");
    assert!(store.segment("other").is_ok());
}

#[test]
fn explicit_import_and_version_restore_detach_pending_publication() {
    let (_directory, mut store) = fixture(&[cue("old", 100, 200, "Old")]);
    begin(&mut store, "job", 0, 5000);
    publish(
        &mut store,
        "job",
        0,
        3000,
        &[cue("generated", 100, 200, "Generated")],
    );
    let version = store.subtitle_versions("media").unwrap()[0].id.clone();
    store.restore_subtitle_version("media", &version).unwrap();
    assert!(
        !store
            .transcript_publication_active("job", &"a".repeat(64))
            .unwrap()
    );
    assert!(
        publish(
            &mut store,
            "job",
            3000,
            5000,
            &[cue("generated", 100, 200, "Generated again")]
        )
        .detached
    );
    assert_eq!(store.segment("old").unwrap().text, "Old");
    begin(&mut store, "second", 0, 5000);
    store
        .replace_subtitles(
            "media",
            &[cue("import", 100, 200, "Imported")],
            None,
            true,
            "Import",
        )
        .unwrap();
    assert!(publish(&mut store, "second", 0, 5000, &[]).detached);
}

#[test]
fn invalid_projection_rolls_back_coverage_and_subtitle_version() {
    let (_directory, mut store) = fixture(&[cue("old", 100, 200, "Old")]);
    begin(&mut store, "job", 0, 5000);
    let bad = cue("bad", 4999, 5001, "Outside selected range");
    assert!(
        store
            .publish_transcript_progress(
                "job",
                &"a".repeat(64),
                &[TranscriptPublicationRange {
                    start_ms: 0,
                    end_ms: 5000
                }],
                &[bad],
                &[]
            )
            .is_err()
    );
    assert_eq!(store.segment("old").unwrap().text, "Old");
    assert!(store.subtitle_versions("media").unwrap().is_empty());
}

#[test]
fn block_text_and_selected_card_audio_preserve_original_timing_in_archive_v3() {
    let mut block = cue("block", 0, 300000, "Raw provider text");
    block.timing_precision = "source_block".into();
    let (directory, mut store) = fixture(std::slice::from_ref(&block));
    assert!(crate::subtitles::format(std::slice::from_ref(&block), false, false).is_empty());
    assert_eq!(
        crate::subtitles::format(std::slice::from_ref(&block), true, false),
        "WEBVTT\n\n"
    );
    let request = SaveCard {
        media_id: "media".into(),
        segment_id: "block".into(),
        source_cue_ids: vec![],
        source_range: Some(AudioClipRange {
            start_ms: 1000,
            end_ms: 61000,
        }),
        term: "term".into(),
        meaning: "meaning".into(),
        example: block.text.clone(),
        translation: None,
        explanation: None,
    };
    let card = store
        .save_card_with_audio_range(
            &request,
            Some("clip.wav".into()),
            Some(AudioClipRange {
                start_ms: 850,
                end_ms: 61150,
            }),
        )
        .unwrap();
    assert_eq!((card.start_ms, card.end_ms), (1000, 61000));
    assert_eq!(card.source_cues[0].end_ms, 300000);
    assert_eq!(card.source_cues[0].timing_precision, "source_block");
    assert!(
        store
            .save_card(
                &SaveCard {
                    source_range: None,
                    ..request.clone()
                },
                None
            )
            .is_err()
    );
    assert!(
        store
            .save_card(
                &SaveCard {
                    source_range: Some(AudioClipRange {
                        start_ms: 299000,
                        end_ms: 301000
                    }),
                    ..request.clone()
                },
                None
            )
            .is_err()
    );
    let archive = store.archive().unwrap();
    assert_eq!(archive.schema_version, 3);
    crate::transfer::validate(&archive).unwrap();
    let mut forged = archive.clone();
    forged.cards[0].start_ms = 0;
    forged.cards[0].end_ms = 300000;
    forged.cards[0].audio_clip_range = None;
    assert!(crate::transfer::validate(&forged).is_err());
    store
        .restore(&archive, &directory.path().join("before.sqlite"))
        .unwrap();
    assert_eq!(
        store.card(&card.id).unwrap().source_cues[0].timing_precision,
        "source_block"
    );
    for version in [1, 2, 3] {
        let mut archive = archive.clone();
        archive.schema_version = version;
        crate::transfer::validate(&archive).unwrap();
    }
}

#[test]
fn learning_restore_excludes_all_publication_authority() {
    let (directory, mut store) = fixture(&[]);
    begin(&mut store, "job", 0, 5000);
    publish(
        &mut store,
        "job",
        0,
        5000,
        &[cue("raw", 100, 200, "Kept study text")],
    );
    let archive = store.archive().unwrap();
    let json = serde_json::to_string(&archive).unwrap();
    assert!(!json.contains("expected") && !json.contains("projectionSha256"));
    store
        .restore(&archive, &directory.path().join("backup.sqlite"))
        .unwrap();
    assert!(
        !store
            .transcript_publication_exists("job", &"a".repeat(64))
            .unwrap()
    );
    assert_eq!(store.segment("raw").unwrap().text, "Kept study text");
}

#[test]
fn quote_does_not_claim_ownership_and_later_approval_replaces_intervening_automatic_rows() {
    let (_directory, mut store) = fixture(&[]);
    begin(&mut store, "older", 0, 10000);
    let revision = subtitle_revision(&store.list_segments("media").unwrap()).unwrap();
    store
        .begin_transcript_publication("quote", &"a".repeat(64), "media", &revision, 3000, 6000)
        .unwrap();
    assert!(
        store
            .publish_transcript_progress(
                "quote",
                &"a".repeat(64),
                &[TranscriptPublicationRange {
                    start_ms: 3000,
                    end_ms: 6000
                }],
                &[],
                &[]
            )
            .is_err()
    );
    assert!(
        publish(
            &mut store,
            "older",
            0,
            10000,
            &[cue("older-result", 3500, 4500, "Earlier result")]
        )
        .changed
    );
    store
        .activate_transcript_publication("quote", &"a".repeat(64))
        .unwrap();
    assert!(
        publish(
            &mut store,
            "quote",
            3000,
            6000,
            &[cue("approved-result", 3500, 4500, "New request")]
        )
        .changed
    );
    assert!(store.segment("older-result").is_err());
    assert_eq!(
        store.segment("approved-result").unwrap().text,
        "New request"
    );
}

#[test]
fn source_block_context_outside_request_is_exact_and_coexists_with_retained_cues() {
    let outside = cue("outside", 500, 900, "Precise outside subtitle");
    let inside = cue("inside", 1500, 2000, "Precise replaced subtitle");
    let (_directory, mut store) = fixture(&[outside.clone(), inside]);
    begin(&mut store, "job", 1000, 5000);
    let mut block = cue("block", 0, 6000, "Whole submitted audio text");
    block.timing_precision = "source_block".into();
    assert!(publish(&mut store, "job", 1000, 3000, std::slice::from_ref(&block)).changed);
    assert_eq!(
        (
            store.segment("block").unwrap().start_ms,
            store.segment("block").unwrap().end_ms
        ),
        (0, 6000)
    );
    assert_eq!(store.segment("outside").unwrap().text, outside.text);
    assert!(store.segment("inside").is_err());
    block.translation = Some("Whole raw block translation".into());
    assert!(publish(&mut store, "job", 3000, 5000, std::slice::from_ref(&block)).changed);
    assert_eq!(store.list_segments("media").unwrap().len(), 2);
    assert_eq!(store.segment("outside").unwrap().text, outside.text);
    assert_eq!(
        store.segment("block").unwrap().translation,
        block.translation
    );
    store
        .record_published_transcript_adoption("job", &"a".repeat(64), &"b".repeat(64))
        .unwrap();
    assert_eq!(
        store.transcript_adopted("job", &"a".repeat(64)).unwrap(),
        Some("b".repeat(64))
    );
    assert!(!publish(&mut store, "job", 1000, 5000, &[]).changed);
    assert_eq!(store.segment("block").unwrap().text, block.text);
}

#[test]
fn phrase_drafts_preserve_incomplete_source_block_audio_range_fields() {
    let mut block = cue("block", 0, 300000, "Raw text");
    block.timing_precision = "source_block".into();
    let (_directory, store) = fixture(std::slice::from_ref(&block));
    let saved = store
        .save_editor_draft(&SaveEditorDraft {
            id: "draft".into(),
            media_id: "media".into(),
            kind: "phrase".into(),
            source_key: "block".into(),
            expected_version: 0,
            source_cues: vec![block],
            fields: [
                ("term", ""),
                ("meaning", ""),
                ("example", "Raw text"),
                ("explanation", ""),
                ("audioStart", "00:"),
                ("audioEnd", ""),
            ]
            .into_iter()
            .map(|(key, value)| (key.into(), value.into()))
            .collect(),
        })
        .unwrap();
    assert_eq!(saved.draft.fields["audioStart"], "00:");
    assert!(!saved.stale);
    assert_eq!(saved.draft.source_cues[0].timing_precision, "source_block");
}

#[test]
fn source_block_card_from_editor_draft_rechecks_the_saved_audio_range() {
    let mut block = cue("block", 0, 300000, "Raw text");
    block.timing_precision = "source_block".into();
    let (_directory, store) = fixture(std::slice::from_ref(&block));
    let saved = store
        .save_editor_draft(&SaveEditorDraft {
            id: "draft".into(),
            media_id: "media".into(),
            kind: "phrase".into(),
            source_key: "block".into(),
            expected_version: 0,
            source_cues: vec![block],
            fields: [
                ("term", "term"),
                ("meaning", "meaning"),
                ("example", "Raw text"),
                ("explanation", ""),
                ("audioStart", "0:01.123"),
                ("audioEnd", "1:01.456"),
            ]
            .into_iter()
            .map(|(key, value)| (key.into(), value.into()))
            .collect(),
        })
        .unwrap();
    let reference = EditorDraftVersion {
        id: saved.draft.id,
        version: 1,
    };
    let request = SaveCard {
        media_id: "media".into(),
        segment_id: "block".into(),
        source_cue_ids: vec![],
        source_range: Some(AudioClipRange {
            start_ms: 1123,
            end_ms: 61456,
        }),
        term: "term".into(),
        meaning: "meaning".into(),
        example: "Raw text".into(),
        translation: None,
        explanation: None,
    };
    let stale = SaveCard {
        source_range: Some(AudioClipRange {
            start_ms: 1000,
            end_ms: 61456,
        }),
        ..request.clone()
    };
    assert!(
        store
            .save_card_from_editor_draft(&reference, &stale, None, None)
            .is_err()
    );
    assert!(store.editor_draft("draft").is_ok());
    let card = store
        .save_card_from_editor_draft(&reference, &request, None, None)
        .unwrap();
    assert_eq!((card.start_ms, card.end_ms), (1123, 61456));
    assert_eq!(card.source_cues[0].end_ms, 300000);
    assert!(store.editor_draft("draft").is_err());
}

#[test]
fn failed_generated_insert_rolls_back_cues_coverage_and_original_version() {
    let (_directory, mut store) = fixture(&[cue("old", 100, 200, "Original")]);
    begin(&mut store, "job", 0, 5000);
    store.conn.execute_batch("CREATE TEMP TRIGGER fail_publication BEFORE INSERT ON main.segments BEGIN SELECT RAISE(ABORT,'injected publication failure'); END;").unwrap();
    let projection = [cue("new", 100, 200, "Generated")];
    assert!(
        store
            .publish_transcript_progress(
                "job",
                &"a".repeat(64),
                &[TranscriptPublicationRange {
                    start_ms: 0,
                    end_ms: 5000
                }],
                &projection,
                &[]
            )
            .is_err()
    );
    assert_eq!(store.segment("old").unwrap().text, "Original");
    assert!(store.subtitle_versions("media").unwrap().is_empty());
    assert!(
        store
            .transcript_publication_candidates("job", &"a".repeat(64))
            .unwrap()
            .is_empty()
    );
    store
        .conn
        .execute_batch("DROP TRIGGER fail_publication;")
        .unwrap();
    assert!(publish(&mut store, "job", 0, 5000, &projection).changed);
    assert_eq!(store.subtitle_versions("media").unwrap().len(), 1);
}

#[test]
fn legacy_subtitle_serialization_preserves_frozen_hashes_and_blocks_never_arm_sentence_stops() {
    let precise = cue("precise", 100, 200, "Sentence.");
    let json = serde_json::to_value(&precise).unwrap();
    assert!(json.get("timingPrecision").is_none());
    let mut block = cue("block", 0, 1000, "Unsynchronized raw block.");
    block.timing_precision = "source_block".into();
    let ranges = crate::sentence_ranges(&[block.clone(), precise]).unwrap();
    assert_eq!(ranges.len(), 1);
    assert_eq!(ranges[0].segment_ids, vec!["precise"]);
    assert!(crate::sentence_ranges(&[block]).unwrap().is_empty());
}

#[test]
fn benign_duration_refinement_keeps_publication_active_and_allows_final_precise_cues() {
    let (_directory, mut store) = fixture(&[cue("old", 100, 900, "Original")]);
    begin(&mut store, "job", 0, 10000);
    let first = cue("first", 100, 900, "First received text");
    assert!(publish(&mut store, "job", 0, 5000, std::slice::from_ref(&first)).changed);
    let mut media = store.media("media").unwrap();
    media.duration_ms += 1;
    store.put_media(&media).unwrap();
    assert!(
        store
            .transcript_publication_active("job", &"a".repeat(64))
            .unwrap()
    );
    let final_cue = cue("final", 9000, 10000, "Final received text");
    assert!(publish(&mut store, "job", 5000, 10000, &[first, final_cue.clone()]).changed);
    assert_eq!(store.segment("final").unwrap().text, final_cue.text);
    store
        .finish_transcript_publication("job", &"a".repeat(64))
        .unwrap();
    assert_eq!(store.subtitle_versions("media").unwrap().len(), 1);
}

#[test]
fn shrinking_media_below_frozen_selection_rejects_publication_without_losing_ownership() {
    let (_directory, mut store) = fixture(&[cue("old", 100, 900, "Original")]);
    begin(&mut store, "job", 0, 10000);
    let mut media = store.media("media").unwrap();
    media.duration_ms = 9999;
    store.put_media(&media).unwrap();
    let received = [TranscriptPublicationRange {
        start_ms: 0,
        end_ms: 10000,
    }];
    let precise = vec![cue("new", 9000, 10000, "Unreceived final text")];
    for projection in [vec![], precise.clone()] {
        assert!(
            store
                .publish_transcript_progress("job", &"a".repeat(64), &received, &projection, &[])
                .is_err()
        );
    }
    assert!(
        store
            .transcript_publication_active("job", &"a".repeat(64))
            .unwrap()
    );
    assert_eq!(store.segment("old").unwrap().text, "Original");
    assert!(store.subtitle_versions("media").unwrap().is_empty());
    assert!(
        store
            .transcript_publication_candidates("job", &"a".repeat(64))
            .unwrap()
            .is_empty()
    );
    media.duration_ms = 10000;
    store.put_media(&media).unwrap();
    assert!(publish(&mut store, "job", 0, 10000, &precise).changed);
    assert_eq!(store.segment("new").unwrap().end_ms, 10000);
}

fn issue(id: &str, start_ms: u64, end_ms: u64) -> TranscriptIssueRecord {
    TranscriptIssueRecord {
        id: id.into(),
        media_id: "media".into(),
        source_id: "previous-job".into(),
        kind: "boundary_conflict".into(),
        start_ms,
        end_ms,
        active: true,
        alternatives: vec![],
    }
}

#[test]
fn clean_and_silent_retranscription_retire_old_boundary_issues_and_keep_their_history() {
    for silent in [false, true] {
        let (_directory, mut store) = fixture(&[cue("old", 100, 900, "Original")]);
        store
            .upsert_transcript_issues(&[issue("old-boundary", 100, 900)])
            .unwrap();
        begin(&mut store, "job", 0, 5000);
        let projection = if silent {
            vec![]
        } else {
            vec![cue("clean", 100, 900, "Clean text")]
        };
        assert!(publish(&mut store, "job", 0, 5000, &projection).changed);
        assert!(store.list_transcript_issues("media").unwrap().is_empty());
        assert!(!store.archive().unwrap().transcript_issues[0].active);
        assert!(!publish(&mut store, "job", 0, 5000, &projection).changed);
    }
}

#[test]
fn issue_only_publication_reports_a_change_and_preserves_current_job_issues() {
    let (_directory, mut store) = fixture(&[]);
    store
        .upsert_transcript_issues(&[issue("stale", 100, 900)])
        .unwrap();
    begin(&mut store, "job", 0, 5000);
    let mut current = issue("current", 1500, 2500);
    current.source_id = "current-job".into();
    store
        .upsert_transcript_issues(std::slice::from_ref(&current))
        .unwrap();
    let report = store
        .publish_transcript_progress(
            "job",
            &"a".repeat(64),
            &[TranscriptPublicationRange {
                start_ms: 0,
                end_ms: 5000,
            }],
            &[],
            std::slice::from_ref(&current),
        )
        .unwrap();
    assert!(report.changed);
    let remaining = store.list_transcript_issues("media").unwrap();
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].id, "current");
    assert!(store.subtitle_versions("media").unwrap().is_empty());
}

#[test]
fn publication_preserves_issues_on_protected_rows_pending_whole_cues_and_unreceived_ranges() {
    let protected = cue("protected", 1000, 2000, "User text");
    let pending = cue("pending-whole-cue", 3000, 6500, "Not completely received");
    let (_directory, mut store) = fixture(&[protected.clone(), pending]);
    store
        .upsert_transcript_issues(&[
            issue("protected-issue", 1100, 1900),
            issue("pending-issue", 3200, 3700),
            issue("outside-issue", 8000, 9000),
            issue("boundary-issue", 3500, 4500),
            issue("replaced-issue", 200, 700),
        ])
        .unwrap();
    begin(&mut store, "job", 0, 10000);
    let mut edited = protected;
    edited.translation = Some("User translation".into());
    store.edit_segment(&edited).unwrap();
    publish(
        &mut store,
        "job",
        0,
        4000,
        &[cue("clean", 200, 700, "Received")],
    );
    let active = store
        .list_transcript_issues("media")
        .unwrap()
        .into_iter()
        .map(|issue| issue.id)
        .collect::<HashSet<_>>();
    assert_eq!(
        active,
        [
            "protected-issue",
            "pending-issue",
            "outside-issue",
            "boundary-issue"
        ]
        .into_iter()
        .map(String::from)
        .collect()
    );
    publish(
        &mut store,
        "job",
        4000,
        10000,
        &[cue("clean", 200, 700, "Received")],
    );
    let active = store.list_transcript_issues("media").unwrap();
    assert_eq!(active.len(), 1);
    assert_eq!(active[0].id, "protected-issue");
}

#[test]
fn rejected_new_issue_rolls_back_old_issue_retirement_and_subtitle_publication() {
    let (_directory, mut store) = fixture(&[cue("old", 100, 900, "Original")]);
    store
        .upsert_transcript_issues(&[issue("stale", 100, 900)])
        .unwrap();
    begin(&mut store, "job", 0, 5000);
    let mut invalid = issue("bad", 100, 900);
    invalid.kind.clear();
    assert!(
        store
            .publish_transcript_progress(
                "job",
                &"a".repeat(64),
                &[TranscriptPublicationRange {
                    start_ms: 0,
                    end_ms: 5000
                }],
                &[cue("new", 100, 900, "New")],
                &[invalid]
            )
            .is_err()
    );
    assert_eq!(
        store.list_transcript_issues("media").unwrap()[0].id,
        "stale"
    );
    assert_eq!(store.segment("old").unwrap().text, "Original");
    assert!(store.subtitle_versions("media").unwrap().is_empty());
}
