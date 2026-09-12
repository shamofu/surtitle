use super::*;

const COMPLETE: &str = "11111111-1111-4111-8111-111111111111";
const PENDING: &str = "22222222-2222-4222-8222-222222222222";

fn fixture() -> (tempfile::TempDir, AppState) {
    let directory = tempfile::tempdir().unwrap();
    let state = Services::open(directory.path().to_path_buf()).unwrap();
    seed_fixture_data(&state).unwrap();
    (directory, state)
}

fn job(state: &AppState, preparation: &str) -> String {
    job_bindings(state)
        .unwrap()
        .into_iter()
        .find(|binding| binding.preparation_id == preparation)
        .unwrap()
        .job_id
}

fn stored(state: &AppState, view: &SelectionView) -> DraftStudySelection {
    lock(&state.db)
        .unwrap()
        .draft_study_selection(view.selection["id"].as_str().unwrap())
        .unwrap()
}

fn prepare_cue(state: &AppState, job: &str, text: &str) -> SelectionView {
    let binding = load_binding(state, job).unwrap();
    let (_, draft, _) = load_draft(state, &binding).unwrap();
    let cue = draft.segments.iter().find(|cue| cue.text == text).unwrap();
    prepare_selection(
        state,
        PrepareSelection {
            job_id: job.into(),
            cue_ids: Some(vec![cue.id.clone()]),
            ordinal: None,
        },
    )
    .unwrap()
}

fn update(
    selected: &DraftStudySelection,
    text: &str,
    start_ms: u64,
    end_ms: u64,
    confirm: bool,
) -> UpdateSelection {
    UpdateSelection {
        id: selected.id.clone(),
        version: selected.version,
        text: text.into(),
        start_ms,
        end_ms,
        confirm,
    }
}

fn charge_snapshot(conn: &rusqlite::Connection) -> Vec<String> {
    [
        "SELECT json_group_array(json_array(id,job_id,ordinal,state,reserve_microusd,charged_microusd,created_at_ms,dispatched_at_ms,settled_at_ms,usage_json,model_version)) FROM (SELECT * FROM ai_attempts ORDER BY id)",
        "SELECT json_group_array(json_array(job_id,ordinal,state,response_json,error_code)) FROM (SELECT * FROM ai_requests ORDER BY job_id,ordinal)",
        "SELECT json_group_array(json_array(id,digest,state,approved_at_ms,approval_json)) FROM (SELECT * FROM ai_jobs ORDER BY id)",
        "SELECT json_group_array(json_array(attempt_id,evidence_json,evidence_sha256)) FROM (SELECT * FROM ai_transcript_evidence ORDER BY attempt_id)",
    ].iter().map(|sql| conn.query_row(sql, [], |row| row.get(0)).unwrap()).collect()
}

fn insert_invalid_unknown(state: &AppState, conn: &rusqlite::Connection, job: &str) -> String {
    let attempt = uuid::Uuid::new_v4().to_string();
    conn.execute("INSERT INTO ai_attempts(id,job_id,ordinal,state,reserve_microusd,created_at_ms,dispatched_at_ms) VALUES(?,?,1,'unknown',12345,1,2)", rusqlite::params![attempt, job]).unwrap();
    conn.execute("UPDATE ai_requests SET state='unknown',error_code='invalid_response' WHERE job_id=? AND ordinal=1", [job]).unwrap();
    let binding = load_binding(state, job).unwrap();
    let receipt = receipt_for_job(state, &binding).unwrap();
    let range = range_binding(&binding, &receipt, 1).unwrap();
    let evidence = TranscriptEvidence {
        attempt_id: attempt.clone(),
        job_id: job.into(),
        ordinal: 1,
        input_sha256: range.input_sha256,
        request_sha256: range.request_sha256,
        task_sha256: sha256_bytes(&serde_json::to_vec(&receipt.prepared_job.requests[1]).unwrap()),
        model_id: receipt.prepared_job.execution.model_id,
        parser_revision: "transcript-response-v1".into(),
        response: json!({"candidates":[{"finishReason":"STOP","content":{"parts":[
            {"thought":true,"audioTranscription":{"text":"Do not display thought content."}},
            {"audioTranscription":{"text":"Authored invalid fixture.","words":[{"word":"Authored","startOffset":"2s","endOffset":"1s"}]}},
            {"text":"Authored invalid fixture."}
        ]}}]}),
        complete: true,
        state: TranscriptResultState::Invalid,
        reason: Some(TranscriptResultReason::ReversedTime),
    };
    let encoded = serde_json::to_string(&evidence).unwrap();
    conn.execute(
        "INSERT INTO ai_transcript_evidence VALUES(?,?,?)",
        rusqlite::params![attempt, encoded, sha256_bytes(encoded.as_bytes())],
    )
    .unwrap();
    attempt
}

fn quote_plan(state: &AppState, selected: &DraftStudySelection) -> PreparedJob {
    let cue = lock(&state.db)
        .unwrap()
        .draft_study_source_cue(&selected.id, selected.version)
        .unwrap();
    let sources = vec![SourceCue {
        id: cue.id,
        start_ms: cue.start_ms,
        end_ms: cue.end_ms,
        text: cue.text,
    }];
    PreparedJob::new(
        "Offline study quote fixture".into(),
        "e2e-project".into(),
        "unused-e2e-fixture".into(),
        PreparationBinding {
            media_id: selected.media_id.clone(),
            transcript_revision: format!("{QUOTE_PREFIX}{}:{}", selected.id, selected.version),
            source_sha256: sha256_bytes(&serde_json::to_vec(&sources).unwrap()),
            settings_sha256: sha256_bytes(b"fixture settings"),
        },
        vec![RequestTask::Vocabulary {
            learning_language: "en".into(),
            explanation_language: "ja".into(),
            cues: sources,
            max_items: 5,
        }],
        crate::model_commands::fixture_execution(),
    )
    .unwrap()
}

#[test]
fn unadoptable_whole_transcript_can_supply_explicit_local_study_without_canonical_changes() {
    let (directory, state) = fixture();
    let job = job(&state, COMPLETE);
    let original = view(&state, &job).unwrap();
    assert!(!original.draft.can_adopt);
    assert!(!original.applied);
    let canonical = lock(&state.db)
        .unwrap()
        .list_segments(&original.media_id)
        .unwrap();
    let charges = rusqlite::Connection::open(directory.path().join("charges.sqlite")).unwrap();
    let before = charge_snapshot(&charges);
    let prepared = prepare_cue(&state, &job, "Hello.");
    assert!(!prepared.stale);
    let initial = stored(&state, &prepared);
    assert!(!initial.confirmed);
    assert!(confirmed_selection(&state, &initial.id, initial.version, true).is_err());
    let confirmed = update_selection(&state, update(&initial, "Hello.", 500, 1000, true)).unwrap();
    let selected = stored(&state, &confirmed);
    assert!(selected.confirmed);
    assert_eq!(selected.origin, "manual");
    assert_eq!(selected.timing, "manual");
    let (_, cue) = confirmed_selection(&state, &selected.id, selected.version, true).unwrap();
    assert_eq!(cue.text, "Hello.");
    assert_eq!(
        serde_json::to_value(
            lock(&state.db)
                .unwrap()
                .list_segments(&original.media_id)
                .unwrap()
        )
        .unwrap(),
        serde_json::to_value(canonical).unwrap()
    );
    assert!(!view(&state, &job).unwrap().applied);
    assert_eq!(charge_snapshot(&charges), before);
}

#[test]
fn invalid_held_source_block_keeps_raw_text_and_allows_a_separately_authored_manual_excerpt() {
    let (directory, state) = fixture();
    let job = job(&state, PENDING);
    let charges = rusqlite::Connection::open(directory.path().join("charges.sqlite")).unwrap();
    let attempt = insert_invalid_unknown(&state, &charges, &job);
    let before = charge_snapshot(&charges);
    let prepared = prepare_selection(
        &state,
        PrepareSelection {
            job_id: job.clone(),
            cue_ids: None,
            ordinal: Some(1),
        },
    )
    .unwrap();
    let initial = stored(&state, &prepared);
    assert_eq!(initial.text, "Authored invalid fixture.");
    assert_eq!(initial.timing, "source_block");
    assert_eq!(
        (initial.source_start_ms, initial.source_end_ms),
        (1000, 8000)
    );
    assert!(!initial.confirmed);
    let saved = update_selection(
        &state,
        update(&initial, "Locally checked excerpt.", 7500, 7900, true),
    )
    .unwrap();
    let selected = stored(&state, &saved);
    assert_eq!(
        (selected.origin.as_str(), selected.timing.as_str()),
        ("manual", "manual")
    );
    assert!(selected.confirmed);
    confirmed_selection(&state, &selected.id, selected.version, true).unwrap();
    let provider = view(&state, &job).unwrap();
    assert_eq!(provider.results[1].state, TranscriptResultState::Invalid);
    assert_eq!(
        provider.draft.chunks[1].source,
        TranscriptRangeSource::Unresolved
    );
    assert!(!provider.applied);
    assert_eq!(charge_snapshot(&charges), before);
    assert_eq!(
        state
            .ai
            .summary()
            .unwrap()
            .unknown_attempts
            .iter()
            .find(|row| row.id == attempt)
            .unwrap()
            .held_or_charged_microusd,
        Some(12345)
    );
}

#[test]
fn manually_recovered_source_block_bookmark_keeps_selected_text_and_separate_raw_evidence() {
    let (directory, state) = fixture();
    let job = job(&state, PENDING);
    let charges = rusqlite::Connection::open(directory.path().join("charges.sqlite")).unwrap();
    insert_invalid_unknown(&state, &charges, &job);
    let before = charge_snapshot(&charges);
    let original = view(&state, &job).unwrap();
    let raw_text = source_block_text(&state, &job, 1).unwrap();
    assert_eq!(raw_text, "Authored invalid fixture.");
    let corrected_text = "Locally corrected wording, preserved verbatim.";
    let corrected = save_manual_range(
        &state,
        &job,
        &original.draft.digest,
        1,
        0,
        ManualTranscriptContent::Subtitles {
            segments: vec![ReviewText {
                start_ms: 7500,
                end_ms: 7900,
                text: corrected_text.into(),
            }],
        },
    )
    .unwrap();
    assert_eq!(
        corrected.draft.chunks[1].source,
        TranscriptRangeSource::Manual
    );
    assert_eq!(corrected.results[1].state, TranscriptResultState::Invalid);
    let prepare_block = || {
        prepare_selection(
            &state,
            PrepareSelection {
                job_id: job.clone(),
                cue_ids: None,
                ordinal: Some(1),
            },
        )
        .unwrap()
    };
    let manual = stored(&state, &prepare_block());
    assert_eq!(manual.text, corrected_text);
    assert_ne!(manual.text, raw_text);
    assert_eq!(manual.origin, "manual");
    // The bookmark still represents the full source block. Selecting a manual
    // range does not invent cue-level precision or a new listening confirmation.
    assert_eq!(manual.timing, "source_block");
    assert!(!manual.confirmed);
    assert!(manual.cue_ids.is_empty());
    assert_eq!((manual.start_ms, manual.end_ms), (1000, 8000));
    assert_eq!(
        manual.source_snapshot["selection"]["selectedText"],
        corrected_text
    );
    assert_eq!(source_block_text(&state, &job, 1).unwrap(), raw_text);
    assert_eq!(charge_snapshot(&charges), before);

    select_range_source(
        &state,
        &job,
        &corrected.draft.digest,
        1,
        1,
        TranscriptRangeSelection::Original,
    )
    .unwrap();
    assert!(validate_source(&state, &manual, true).is_err());
    let provider = stored(&state, &prepare_block());
    assert_eq!(provider.text, raw_text);
    assert_eq!(provider.origin, "ai");
    assert_eq!(provider.timing, "source_block");
    assert!(!provider.confirmed);
    assert_eq!(charge_snapshot(&charges), before);
    assert!(!view(&state, &job).unwrap().applied);
}

#[test]
fn local_selection_compare_and_swap_and_source_bounds_reject_stale_or_invalid_updates() {
    let (_directory, state) = fixture();
    let job = job(&state, PENDING);
    let initial = stored(
        &state,
        &prepare_selection(
            &state,
            PrepareSelection {
                job_id: job,
                cue_ids: None,
                ordinal: Some(1),
            },
        )
        .unwrap(),
    );
    let updated = stored(
        &state,
        &update_selection(&state, update(&initial, "Draft text.", 7000, 7900, false)).unwrap(),
    );
    assert_eq!(updated.version, initial.version + 1);
    assert!(
        update_selection(
            &state,
            update(&initial, "Stale overwrite.", 7000, 7900, true)
        )
        .is_err()
    );
    for (text, start, end) in [
        ("Outside.", 999, 1500),
        ("Outside.", 7000, 8001),
        ("Zero.", 7500, 7500),
        ("  ", 7000, 7900),
    ] {
        assert!(update_selection(&state, update(&updated, text, start, end, true)).is_err());
    }
    assert_eq!(
        lock(&state.db)
            .unwrap()
            .draft_study_selection(&updated.id)
            .unwrap(),
        updated
    );
}

#[test]
fn source_file_track_path_or_language_drift_rejects_confirmation_without_saved_changes() {
    let (_directory, state) = fixture();
    let job = job(&state, COMPLETE);
    let selected = stored(&state, &prepare_cue(&state, &job, "Hello."));
    let original_media = lock(&state.db).unwrap().media(&selected.media_id).unwrap();
    for change in 0..3 {
        let mut media = original_media.clone();
        match change {
            0 => media.audio_stream_index = Some(1),
            1 => media.path.push_str(".different"),
            _ => media.learning_language = "ja".into(),
        }
        lock(&state.db).unwrap().put_media(&media).unwrap();
        assert!(update_selection(&state, update(&selected, "Hello.", 500, 1000, true)).is_err());
        lock(&state.db).unwrap().put_media(&original_media).unwrap();
    }
    let original = fs::read(&original_media.path).unwrap();
    let mut changed = original.clone();
    changed[44] = 1;
    fs::write(&original_media.path, &changed).unwrap();
    assert!(update_selection(&state, update(&selected, "Hello.", 500, 1000, true)).is_err());
    assert_eq!(
        lock(&state.db)
            .unwrap()
            .draft_study_selection(&selected.id)
            .unwrap(),
        selected
    );
    fs::write(&original_media.path, original).unwrap();
}

#[test]
fn selected_bookmark_survives_restart_without_restoring_any_paid_authority() {
    let (directory, state) = fixture();
    let job = job(&state, PENDING);
    let prepared = stored(&state, &prepare_cue(&state, &job, "Hello."));
    let selected = stored(
        &state,
        &update_selection(&state, update(&prepared, "Hello.", 500, 1000, true)).unwrap(),
    );
    let charges = rusqlite::Connection::open(directory.path().join("charges.sqlite")).unwrap();
    let before = charge_snapshot(&charges);
    drop(state);
    let reopened = Services::open(directory.path().to_path_buf()).unwrap();
    assert_eq!(
        lock(&reopened.db)
            .unwrap()
            .draft_study_selection(&selected.id)
            .unwrap(),
        selected
    );
    confirmed_selection(&reopened, &selected.id, selected.version, true).unwrap();
    assert_eq!(charge_snapshot(&charges), before);
}

#[test]
fn unrelated_later_result_does_not_stale_a_local_range_but_new_relevant_raw_evidence_does() {
    let (directory, state) = fixture();
    let job = job(&state, PENDING);
    let selected = stored(&state, &prepare_cue(&state, &job, "Hello."));
    let charges = rusqlite::Connection::open(directory.path().join("charges.sqlite")).unwrap();
    let output = serde_json::to_string(&ParsedOutput::Transcript {
        cues: vec![GeneratedCue {
            start_ms: 7500,
            end_ms: 7900,
            text: "Later provider result.".into(),
        }],
    })
    .unwrap();
    charges
        .execute(
            "UPDATE ai_requests SET state='completed',response_json=? WHERE job_id=? AND ordinal=1",
            rusqlite::params![output, job],
        )
        .unwrap();
    validate_source(&state, &selected, true).unwrap();
    update_selection(&state, update(&selected, "Hello.", 500, 1000, true)).unwrap();

    let (other_directory, other) = fixture();
    let other_job = job_bindings(&other)
        .unwrap()
        .into_iter()
        .find(|binding| binding.preparation_id == PENDING)
        .unwrap()
        .job_id;
    let block = stored(
        &other,
        &prepare_selection(
            &other,
            PrepareSelection {
                job_id: other_job.clone(),
                cue_ids: None,
                ordinal: Some(1),
            },
        )
        .unwrap(),
    );
    let other_charges =
        rusqlite::Connection::open(other_directory.path().join("charges.sqlite")).unwrap();
    insert_invalid_unknown(&other, &other_charges, &other_job);
    let after_response = charge_snapshot(&other_charges);
    assert!(validate_source(&other, &block, true).is_err());
    assert!(
        update_selection(
            &other,
            update(&block, "A later local excerpt.", 7500, 7900, true)
        )
        .is_err()
    );
    assert_eq!(charge_snapshot(&other_charges), after_response);
}

#[test]
fn study_quote_binds_confirmed_version_exact_text_timing_media_and_current_source() {
    let (_directory, state) = fixture();
    let job = job(&state, COMPLETE);
    let initial = stored(&state, &prepare_cue(&state, &job, "Hello."));
    let selected = stored(
        &state,
        &update_selection(&state, update(&initial, "Hello.", 500, 1000, true)).unwrap(),
    );
    let plan = quote_plan(&state, &selected);
    verify_quote(&state, &plan, true).unwrap();
    assert!(verify_quote_cues(&lock(&state.db).unwrap(), &plan).unwrap());
    for change in 0..4 {
        let mut altered = plan.clone();
        match change {
            0 => altered.binding.media_id = "other".into(),
            1 => altered.binding.source_sha256 = sha256_bytes(b"other"),
            _ => {
                let RequestTask::Vocabulary { cues, .. } = &mut altered.requests[0] else {
                    panic!("fixture vocabulary")
                };
                if change == 2 {
                    cues[0].text = "Changed frozen text.".into();
                } else {
                    cues[0].end_ms += 1;
                }
            }
        }
        assert!(verify_quote_cues(&lock(&state.db).unwrap(), &altered).is_err());
    }
    let media = lock(&state.db).unwrap().media(&selected.media_id).unwrap();
    let original = fs::read(&media.path).unwrap();
    let mut changed = original.clone();
    changed[44] = 1;
    fs::write(&media.path, changed).unwrap();
    assert!(verify_quote(&state, &plan, true).is_err());
    fs::write(&media.path, original).unwrap();

    // Source metadata is intentionally rebound by a new selection; an existing
    // quoted version can never silently follow a local text edit.
    let fresh = stored(&state, &prepare_cue(&state, &job, "Hello."));
    let confirmed = stored(
        &state,
        &update_selection(&state, update(&fresh, "Hello.", 500, 1000, true)).unwrap(),
    );
    let old_quote = quote_plan(&state, &confirmed);
    update_selection(
        &state,
        update(&confirmed, "Locally changed text.", 500, 1000, true),
    )
    .unwrap();
    assert!(verify_quote(&state, &old_quote, true).is_err());
    assert!(verify_quote_cues(&lock(&state.db).unwrap(), &old_quote).is_err());
}
