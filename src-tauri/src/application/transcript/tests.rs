use super::*;
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
        .find(|b| b.preparation_id == preparation)
        .unwrap()
        .job_id
}
const COMPLETE: &str = "11111111-1111-4111-8111-111111111111";
const PENDING: &str = "22222222-2222-4222-8222-222222222222";
const REPAIR: &str = "33333333-3333-4333-8333-333333333333";
fn authored_range() -> ManualTranscriptContent {
    ManualTranscriptContent::Subtitles {
        segments: vec![
            ReviewText {
                start_ms: 3500,
                end_ms: 4500,
                text: "No, no.".into(),
            },
            ReviewText {
                start_ms: 7500,
                end_ms: 7900,
                text: "Locally corrected.".into(),
            },
        ],
    }
}
fn charge_snapshot(conn: &rusqlite::Connection) -> Vec<String> {
    [
            "SELECT json_group_array(json_array(id,job_id,ordinal,state,reserve_microusd,charged_microusd,created_at_ms,dispatched_at_ms,settled_at_ms,usage_json,model_version)) FROM (SELECT * FROM ai_attempts ORDER BY id)",
            "SELECT json_group_array(json_array(job_id,ordinal,state,response_json,error_code)) FROM (SELECT * FROM ai_requests ORDER BY job_id,ordinal)",
            "SELECT json_group_array(json_array(id,digest,state,approved_at_ms,approval_json)) FROM (SELECT * FROM ai_jobs ORDER BY id)",
            "SELECT json_group_array(json_array(attempt_id,evidence_json,evidence_sha256)) FROM (SELECT * FROM ai_transcript_evidence ORDER BY attempt_id)",
        ].iter().map(|sql| conn.query_row(sql, [], |r| r.get(0)).unwrap()).collect()
}
#[test]
fn manual_missing_range_is_versioned_reversible_persistent_and_locally_adoptable() {
    let (directory, state) = fixture();
    let pending = job(&state, PENDING);
    let initial = view(&state, &pending).unwrap();
    assert_eq!(initial.range_edits.len(), 2);
    assert_eq!(initial.range_edits[1].version, 0);
    let charges = rusqlite::Connection::open(directory.path().join("charges.sqlite")).unwrap();
    let snapshot = charge_snapshot(&charges);
    let saved = save_manual_range(
        &state,
        &pending,
        &initial.draft.digest,
        1,
        0,
        authored_range(),
    )
    .unwrap();
    assert!(
        saved.can_apply,
        "{:?}; conflicts={:?}",
        saved.blocked_reason, saved.draft.conflicts
    );
    assert_eq!(saved.results[1].state, TranscriptResultState::Pending);
    assert_eq!(saved.draft.chunks[1].source, TranscriptRangeSource::Manual);
    assert!(saved.draft.chunks[1].original_segments.is_empty());
    assert_eq!(saved.range_edits[1].version, 1);
    assert!(
        save_manual_range(
            &state,
            &pending,
            &initial.draft.digest,
            1,
            1,
            authored_range()
        )
        .is_err()
    );
    assert!(
        save_manual_range(
            &state,
            &pending,
            &saved.draft.digest,
            1,
            0,
            authored_range()
        )
        .is_err()
    );
    let id = saved.range_edits[1].selected_revision_id.clone().unwrap();
    let original = select_range_source(
        &state,
        &pending,
        &saved.draft.digest,
        1,
        1,
        TranscriptRangeSelection::Original,
    )
    .unwrap();
    assert!(!original.can_apply);
    assert_eq!(
        original.draft.chunks[1].source,
        TranscriptRangeSource::Unresolved
    );
    let selected = select_range_source(
        &state,
        &pending,
        &original.draft.digest,
        1,
        2,
        TranscriptRangeSelection::Manual { revision_id: id },
    )
    .unwrap();
    assert_eq!(selected.range_edits[1].version, 3);
    assert!(selected.can_apply);
    assert_ne!(
        selected.draft.digest, saved.draft.digest,
        "Returning to an old revision must not revive an old adoption digest"
    );
    assert!(apply_review(&state, &pending, &saved.draft.digest).is_err());
    assert_eq!(charge_snapshot(&charges), snapshot);
    drop(state);
    let state = Services::open(directory.path().to_path_buf()).unwrap();
    let reloaded = view(&state, &pending).unwrap();
    assert_eq!(reloaded.draft, selected.draft);
    assert!(
        apply_review(&state, &pending, &reloaded.draft.digest)
            .unwrap()
            .applied
    );
    assert_eq!(state.ai.quote(&pending).unwrap().completed_requests, 1);
    assert_eq!(state.ai.quote(&pending).unwrap().state, "needs_review");
    assert_eq!(charge_snapshot(&charges), snapshot);
    assert!(
        save_manual_range(
            &state,
            &pending,
            &reloaded.draft.digest,
            1,
            3,
            authored_range()
        )
        .is_err()
    );
}
#[test]
fn invalid_unknown_range_can_be_edited_and_adopted_without_settling_or_refunding() {
    let (directory, state) = fixture();
    let pending = job(&state, PENDING);
    let charges = rusqlite::Connection::open(directory.path().join("charges.sqlite")).unwrap();
    let attempt = uuid::Uuid::new_v4().to_string();
    charges.execute("INSERT INTO ai_attempts(id,job_id,ordinal,state,reserve_microusd,created_at_ms,dispatched_at_ms) VALUES(?,?,1,'unknown',12345,1,2)", rusqlite::params![attempt,pending]).unwrap();
    charges.execute("UPDATE ai_requests SET state='unknown',error_code='invalid_response' WHERE job_id=? AND ordinal=1", [&pending]).unwrap();
    let binding = load_binding(&state, &pending).unwrap();
    let receipt = receipt_for_job(&state, &binding).unwrap();
    let range = range_binding(&binding, &receipt, 1).unwrap();
    let evidence = TranscriptEvidence {
        attempt_id: attempt.clone(),
        job_id: pending.clone(),
        ordinal: 1,
        input_sha256: range.input_sha256,
        request_sha256: range.request_sha256,
        task_sha256: sha256_bytes(&serde_json::to_vec(&receipt.prepared_job.requests[1]).unwrap()),
        model_id: receipt.prepared_job.execution.model_id.clone(),
        parser_revision: "transcript-response-v1".into(),
        response: serde_json::json!({"candidates":[{"finishReason":"STOP","content":{"parts":[{"audioTranscription":{"text":"Authored invalid fixture.","words":[{"word":"Authored","startOffset":"2s","endOffset":"1s"}]}}]}}]}),
        complete: true,
        state: TranscriptResultState::Invalid,
        reason: Some(TranscriptResultReason::ReversedTime),
    };
    let evidence_json = serde_json::to_string(&evidence).unwrap();
    charges
        .execute(
            "INSERT INTO ai_transcript_evidence VALUES(?,?,?)",
            rusqlite::params![
                attempt,
                evidence_json,
                sha256_bytes(evidence_json.as_bytes())
            ],
        )
        .unwrap();
    let before = charge_snapshot(&charges);
    let original = view(&state, &pending).unwrap();
    assert_eq!(original.results[1].state, TranscriptResultState::Invalid);
    assert_eq!(
        original.results[1].reason,
        Some(TranscriptResultReason::SettlementPending)
    );
    assert!(original.manual_editing_blocked_reason.is_none());
    let provider = serde_json::to_value(&original.results).unwrap();
    let saved = save_manual_range(
        &state,
        &pending,
        &original.draft.digest,
        1,
        0,
        authored_range(),
    )
    .unwrap();
    assert_eq!(serde_json::to_value(&saved.results).unwrap(), provider);
    assert!(
        saved.can_apply,
        "{:?}; conflicts={:?}",
        saved.blocked_reason, saved.draft.conflicts
    );
    assert!(
        apply_review(&state, &pending, &saved.draft.digest)
            .unwrap()
            .applied
    );
    assert_eq!(charge_snapshot(&charges), before);
    assert_eq!(
        state
            .ai
            .summary()
            .unwrap()
            .unknown_attempts
            .iter()
            .find(|a| a.id == attempt)
            .unwrap()
            .held_or_charged_microusd,
        Some(12345)
    );
}
#[test]
fn manual_edits_require_pause_and_inflight_completion_but_survive_later_results() {
    let (directory, state) = fixture();
    let pending = job(&state, PENDING);
    let charges = rusqlite::Connection::open(directory.path().join("charges.sqlite")).unwrap();
    charges
        .execute("UPDATE ai_jobs SET state='approved' WHERE id=?", [&pending])
        .unwrap();
    let original = view(&state, &pending).unwrap();
    assert!(original.manual_editing_blocked_reason.is_some());
    assert!(
        save_manual_range(
            &state,
            &pending,
            &original.draft.digest,
            1,
            0,
            authored_range()
        )
        .is_err()
    );
    state.ai.pause(&pending).unwrap();
    let attempt = uuid::Uuid::new_v4().to_string();
    charges.execute("INSERT INTO ai_attempts(id,job_id,ordinal,state,reserve_microusd,created_at_ms,dispatched_at_ms) VALUES(?,?,1,'reserved',999,1,2)", rusqlite::params![attempt,pending]).unwrap();
    assert!(
        save_manual_range(
            &state,
            &pending,
            &original.draft.digest,
            1,
            0,
            authored_range()
        )
        .is_err()
    );
    state.ai.mark_unknown(&attempt).unwrap();
    let saved = save_manual_range(
        &state,
        &pending,
        &original.draft.digest,
        1,
        0,
        authored_range(),
    )
    .unwrap();
    assert!(
        saved.can_apply,
        "{:?}; conflicts={:?}",
        saved.blocked_reason, saved.draft.conflicts
    );
    // Simulate a separately recorded late result without changing the local
    // selection. No production recovery path automatically performs this.
    let output = serde_json::to_string(&ParsedOutput::Transcript {
        cues: vec![GeneratedCue {
            start_ms: 6000,
            end_ms: 6500,
            text: "Later provider result.".into(),
        }],
    })
    .unwrap();
    charges
        .execute(
            "UPDATE ai_requests SET state='completed',response_json=? WHERE job_id=? AND ordinal=1",
            rusqlite::params![output, pending],
        )
        .unwrap();
    let after_provider = charge_snapshot(&charges);
    let updated = view(&state, &pending).unwrap();
    assert_eq!(
        updated.range_edits[1].selected_revision_id,
        saved.range_edits[1].selected_revision_id
    );
    assert!(
        updated
            .draft
            .segments
            .iter()
            .any(|s| s.text == "Locally corrected.")
    );
    assert_eq!(
        updated.draft.chunks[1].original_segments[0].text,
        "Later provider result."
    );
    assert_ne!(updated.draft.digest, saved.draft.digest);
    assert_eq!(charge_snapshot(&charges), after_provider);
}
#[test]
fn valid_empty_provider_results_require_explicit_no_speech_for_every_range() {
    let (directory, state) = fixture();
    let pending = job(&state, PENDING);
    let charges = rusqlite::Connection::open(directory.path().join("charges.sqlite")).unwrap();
    let output = serde_json::to_string(&ParsedOutput::Transcript { cues: vec![] }).unwrap();
    charges
        .execute(
            "UPDATE ai_requests SET state='completed',response_json=? WHERE job_id=?",
            rusqlite::params![output, pending],
        )
        .unwrap();
    let before = charge_snapshot(&charges);
    let original = view(&state, &pending).unwrap();
    // Provider parsing remains valid. Only the new application adoption
    // contract requires an explicit local decision about each empty range.
    assert!(original.draft.can_adopt);
    assert!(!original.can_apply);
    assert!(
        original
            .blocked_reason
            .unwrap()
            .contains("no-speech confirmation")
    );
    assert!(apply_review(&state, &pending, &original.draft.digest).is_err());
    let first = save_manual_range(
        &state,
        &pending,
        &original.draft.digest,
        0,
        0,
        ManualTranscriptContent::ConfirmedNoSpeech,
    )
    .unwrap();
    assert!(!first.can_apply);
    let complete = save_manual_range(
        &state,
        &pending,
        &first.draft.digest,
        1,
        0,
        ManualTranscriptContent::ConfirmedNoSpeech,
    )
    .unwrap();
    assert!(complete.can_apply, "{:?}", complete.blocked_reason);
    assert!(
        apply_review(&state, &pending, &complete.draft.digest)
            .unwrap()
            .applied
    );
    assert_eq!(charge_snapshot(&charges), before);
}
#[test]
fn manual_empty_requires_explicit_silence_and_rejects_stale_source() {
    let (_directory, state) = fixture();
    let pending = job(&state, PENDING);
    let original = view(&state, &pending).unwrap();
    assert!(
        save_manual_range(
            &state,
            &pending,
            &original.draft.digest,
            1,
            0,
            ManualTranscriptContent::Subtitles { segments: vec![] }
        )
        .is_err()
    );
    assert_eq!(view(&state, &pending).unwrap().range_edits[1].version, 0);
    let silent = save_manual_range(
        &state,
        &pending,
        &original.draft.digest,
        1,
        0,
        ManualTranscriptContent::ConfirmedNoSpeech,
    )
    .unwrap();
    assert_eq!(
        silent.range_edits[1]
            .selected_revision
            .as_ref()
            .unwrap()
            .content,
        ManualTranscriptContent::ConfirmedNoSpeech
    );
    let mut segment = lock(&state.db)
        .unwrap()
        .list_segments(&silent.media_id)
        .unwrap()
        .remove(0);
    segment.text = "Independently edited original".into();
    lock(&state.db).unwrap().edit_segment(&segment).unwrap();
    assert!(
        save_manual_range(
            &state,
            &pending,
            &silent.draft.digest,
            1,
            1,
            authored_range()
        )
        .is_err()
    );
    assert!(apply_review(&state, &pending, &silent.draft.digest).is_err());
}
#[test]
fn vad_warning_acknowledgement_survives_restart_and_requires_current_digest_for_adoption() {
    let (directory, state) = fixture();
    let complete = job(&state, COMPLETE);
    // Add authored VAD evidence to this private fixture and rebind its receipt
    // before any decisions exist. No model call or ledger mutation is made.
    let mut receipt = load_receipt(&state, COMPLETE).unwrap();
    receipt.vad_no_speech_ordinals = vec![0];
    surtitle_core::store::write_json_atomic(&receipt.directory.join("receipt.json"), &receipt)
        .unwrap();
    register_fixture_job(&state, &receipt, &state.ai.quote(&complete).unwrap(), None).unwrap();
    let original = view(&state, &complete).unwrap();
    assert_eq!(original.draft.warnings.len(), 1);
    assert!(!original.can_apply);
    let warning_id = original.draft.warnings[0].id.clone();
    assert!(!original.draft.warnings[0].acknowledged);
    assert!(acknowledge_review_warning(&state, &complete, "stale", &warning_id).is_err());
    assert_eq!(view(&state, &complete).unwrap().draft, original.draft);

    let boundary = resolve_review(
        &state,
        &complete,
        &original.draft.digest,
        &original.draft.conflicts[0].id,
        BoundaryChoice::Left,
    )
    .unwrap();
    assert!(
        !boundary.can_apply,
        "A resolved boundary must not silently acknowledge a VAD warning"
    );
    assert!(apply_review(&state, &complete, &boundary.draft.digest).is_err());
    assert!(
        acknowledge_review_warning(&state, &complete, &original.draft.digest, &warning_id).is_err()
    );
    let checked =
        acknowledge_review_warning(&state, &complete, &boundary.draft.digest, &warning_id).unwrap();
    assert!(checked.can_apply && checked.draft.warnings[0].acknowledged);
    assert_eq!(checked.draft.chunks, original.draft.chunks);
    let acknowledged_digest = checked.draft.digest.clone();
    assert_ne!(acknowledged_digest, boundary.draft.digest);

    drop(state);
    let state = Services::open(directory.path().to_path_buf()).unwrap();
    let reloaded = view(&state, &complete).unwrap();
    assert_eq!(reloaded.draft, checked.draft);
    assert!(reloaded.can_apply);
    assert!(
        acknowledge_review_warning(&state, &complete, &boundary.draft.digest, &warning_id).is_err()
    );
    assert!(apply_review(&state, &complete, &boundary.draft.digest).is_err());
    assert!(
        apply_review(&state, &complete, &acknowledged_digest)
            .unwrap()
            .applied
    );
    assert!(
        acknowledge_review_warning(&state, &complete, &acknowledged_digest, &warning_id).is_err()
    );

    drop(state);
    let state = Services::open(directory.path().to_path_buf()).unwrap();
    let adopted = view(&state, &complete).unwrap();
    assert!(adopted.applied && !adopted.can_apply);
    assert_eq!(adopted.draft, checked.draft);
    assert_eq!(
        state.ai.summary().unwrap().monthly_actual_charged_microusd,
        0
    );
    assert_eq!(state.ai.quote(&complete).unwrap().completed_requests, 2);
}
#[test]
fn local_review_requires_all_chunks_and_explicit_resolution_then_preserves_edits_after_restart() {
    let (directory, state) = fixture();
    let complete = job(&state, COMPLETE);
    let pending = job(&state, PENDING);
    let original = view(&state, &complete).unwrap();
    assert!(!original.can_apply);
    assert_eq!(original.draft.conflicts.len(), 1);
    assert!(apply_review(&state, &complete, &original.draft.digest).is_err());
    let partial = view(&state, &pending).unwrap();
    assert!(!partial.can_apply);
    assert_eq!(partial.draft.pending_ranges.len(), 1);
    assert!(apply_review(&state, &pending, &partial.draft.digest).is_err());
    let reviewed = resolve_review(
        &state,
        &complete,
        &original.draft.digest,
        &original.draft.conflicts[0].id,
        BoundaryChoice::Left,
    )
    .unwrap();
    assert!(reviewed.can_apply);
    assert_eq!(reviewed.draft.chunks, original.draft.chunks);
    let digest = reviewed.draft.digest.clone();
    drop(state);
    let state = Services::open(directory.path().to_path_buf()).unwrap();
    assert_eq!(view(&state, &complete).unwrap().draft.digest, digest);
    assert!(apply_review(&state, &complete, &digest).unwrap().applied);
    let mut segment = lock(&state.db)
        .unwrap()
        .list_segments("e2e-transcript-review")
        .unwrap()
        .remove(0);
    segment.text = "A later manual correction.".into();
    segment.translation = Some("後の訳".into());
    lock(&state.db).unwrap().edit_segment(&segment).unwrap();
    drop(state);
    let state = Services::open(directory.path().to_path_buf()).unwrap();
    assert!(apply_review(&state, &complete, &digest).unwrap().applied);
    assert_eq!(
        lock(&state.db).unwrap().segment(&segment.id).unwrap().text,
        "A later manual correction."
    );
    assert_eq!(
        state.ai.summary().unwrap().monthly_actual_charged_microusd,
        0
    );
}
#[test]
fn concurrent_decisions_using_one_digest_have_exactly_one_winner() {
    let (_directory, state) = fixture();
    let complete = job(&state, COMPLETE);
    let original = view(&state, &complete).unwrap();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let handles = [BoundaryChoice::Left, BoundaryChoice::Right]
        .into_iter()
        .map(|choice| {
            let state = state.clone();
            let id = complete.clone();
            let digest = original.draft.digest.clone();
            let boundary = original.draft.conflicts[0].id.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                resolve_review(&state, &id, &digest, &boundary, choice).is_ok()
            })
        })
        .collect::<Vec<_>>();
    assert_eq!(
        handles
            .into_iter()
            .filter(|handle| handle.thread().id() != std::thread::current().id())
            .map(|handle| u32::from(handle.join().unwrap()))
            .sum::<u32>(),
        1
    );
}
#[test]
fn repair_quote_is_separate_blocked_and_cannot_replace_parent_or_survive_changed_decisions() {
    let (_directory, state) = fixture();
    let complete = job(&state, COMPLETE);
    let repair = job(&state, REPAIR);
    let quoted = serde_json::to_value(create_audio_quote(&state, REPAIR).unwrap()).unwrap();
    assert_eq!(quoted["canApprove"], false);
    assert!(quoted["maximumUsd"].as_f64().unwrap() > 0.0);
    assert_eq!(state.ai.quote(&repair).unwrap().state, "prepared");
    assert!(
        apply_review(
            &state,
            &repair,
            &view(&state, &repair).unwrap().draft.digest
        )
        .is_err()
    );
    let original = view(&state, &complete).unwrap();
    resolve_review(
        &state,
        &complete,
        &original.draft.digest,
        &original.draft.conflicts[0].id,
        BoundaryChoice::Left,
    )
    .unwrap();
    assert!(create_audio_quote(&state, REPAIR).is_err());
    assert!(verify_audio_plan(&state, &state.ai.prepared_job(&repair).unwrap()).is_err());
    assert_eq!(
        state.ai.summary().unwrap().monthly_actual_charged_microusd,
        0
    );
}
#[test]
fn unavailable_unrelated_preparation_and_deleted_audio_do_not_hide_received_results() {
    let (_directory, state) = fixture();
    let complete = job(&state, COMPLETE);
    let directory = state.root.join("prepared").join("broken-unrelated");
    fs::create_dir(&directory).unwrap();
    fs::write(directory.join("receipt.json"), b"broken json").unwrap();
    let receipt = load_receipt(&state, COMPLETE).unwrap();
    fs::remove_file(
        &audio_attachment(&receipt.prepared_job.requests[0])
            .unwrap()
            .path,
    )
    .unwrap();
    assert_eq!(
        view(&state, &complete).unwrap().draft.chunks[0].status,
        "received"
    );
    assert!(create_audio_quote(&state, COMPLETE).is_err());
}
#[test]
fn credential_rotation_requotes_the_same_immutable_audio_without_regeneration() {
    let (_directory, state) = fixture();
    let previous = job(&state, PENDING);
    {
        let mut preferences = state.preferences.test_value().unwrap();
        preferences.settings.vertex_project = "another-project".into();
        preferences.credential_id = Some("c".repeat(64));
    }
    let quote = serde_json::to_value(create_audio_quote(&state, PENDING).unwrap()).unwrap();
    let new_id = quote["id"].as_str().unwrap();
    assert_ne!(new_id, previous);
    assert_eq!(
        state.ai.prepared_job(new_id).unwrap().requests,
        state.ai.prepared_job(&previous).unwrap().requests
    );
    assert_eq!(quote["canApprove"], false);
    assert_eq!(state.ai.quote(new_id).unwrap().completed_requests, 0);
}
