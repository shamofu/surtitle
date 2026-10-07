use super::*;

const COMPLETE: &str = "11111111-1111-4111-8111-111111111111";
const PENDING: &str = "22222222-2222-4222-8222-222222222222";

struct Fixture {
    directory: tempfile::TempDir,
    state: AppState,
    quote: JobQuote,
    receipt: AudioPreparationReceipt,
}

impl Fixture {
    fn new(pending: bool, pending_context: bool) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let state = Services::open(directory.path().to_path_buf()).unwrap();
        seed_fixture_data(&state).unwrap();
        let mut receipt = load_receipt(&state, if pending { PENDING } else { COMPLETE }).unwrap();
        if pending_context {
            let db = lock(&state.db).unwrap();
            let mut old = db
                .list_segments(&receipt.prepared_job.binding.media_id)
                .unwrap()
                .remove(0);
            old.start_ms = 3500;
            old.end_ms = 4500;
            db.edit_segment(&old).unwrap();
            receipt.prepared_job.binding.transcript_revision =
                surtitle_core::store::subtitle_revision(&db.list_segments(&old.media_id).unwrap())
                    .unwrap();
        }
        receipt.prepared_job = receipt
            .prepared_job
            .with_apply_policy(TranscriptApplyPolicy::Auto)
            .unwrap();
        surtitle_core::store::write_json_atomic(&receipt.directory.join("receipt.json"), &receipt)
            .unwrap();
        let quote = state
            .ai
            .seed_transcript_review_fixture(receipt.prepared_job.clone(), pending)
            .unwrap();
        register_fixture_job(&state, &receipt, &quote, None).unwrap();
        let mut binding = load_binding(&state, &quote.id).unwrap();
        binding.progressive = true;
        save_binding(&state, &binding).unwrap();
        let draft = build_transcript_draft(&receipt, &[]).unwrap();
        {
            let mut db = lock(&state.db).unwrap();
            db.begin_transcript_publication(
                &quote.id,
                &quote.digest,
                &draft.media_id,
                &draft.source_revision,
                draft.start_ms,
                draft.end_ms,
            )
            .unwrap();
            // The fixture never dispatches a request. Activate only the local
            // publication seam that native approval activates in production.
            db.activate_transcript_publication(&quote.id, &quote.digest)
                .unwrap();
        }
        Self {
            directory,
            state,
            quote,
            receipt,
        }
    }

    fn media_id(&self) -> &str {
        &self.quote.binding.media_id
    }

    fn charges(&self) -> rusqlite::Connection {
        rusqlite::Connection::open(self.directory.path().join("charges.sqlite")).unwrap()
    }

    fn rows(&self) -> Vec<surtitle_core::SubtitleSegment> {
        crate::application::subtitles::list_segments(self.state.clone(), self.media_id().into())
            .unwrap()
    }

    fn receive_last(&self) {
        // A saved provider arrival is injected before taking the ledger snapshot.
        // Every assertion below exercises native publication without transport.
        let output = ParsedOutput::Transcript {
            cues: vec![
                GeneratedCue {
                    start_ms: 3500,
                    end_ms: 4500,
                    text: "No.".into(),
                    ..Default::default()
                },
                GeneratedCue {
                    start_ms: 7500,
                    end_ms: 7900,
                    text: "Goodbye.".into(),
                    ..Default::default()
                },
            ],
        };
        self.charges().execute(
            "UPDATE ai_requests SET state='completed',response_json=?,error_code=NULL WHERE job_id=? AND ordinal=1",
            rusqlite::params![serde_json::to_string(&output).unwrap(), self.quote.id],
        ).unwrap();
        self.charges()
            .execute(
                "UPDATE ai_jobs SET state='completed' WHERE id=?",
                [&self.quote.id],
            )
            .unwrap();
    }
}

/// Workflow completion receipts may change locally; original requests, attempt
/// costs, evidence, and paid approval must remain byte-for-byte unchanged.
fn ledger_snapshot(connection: &rusqlite::Connection) -> Vec<String> {
    [
        "SELECT json_group_array(json_array(id,job_id,ordinal,state,reserve_microusd,charged_microusd,created_at_ms,dispatched_at_ms,settled_at_ms,usage_json,model_version)) FROM (SELECT * FROM ai_attempts ORDER BY id)",
        "SELECT json_group_array(json_array(job_id,ordinal,state,response_json,error_code)) FROM (SELECT * FROM ai_requests ORDER BY job_id,ordinal)",
        "SELECT json_group_array(json_array(id,digest,approved_at_ms,approval_json)) FROM (SELECT * FROM ai_jobs ORDER BY id)",
        "SELECT json_group_array(json_array(attempt_id,evidence_json,evidence_sha256)) FROM (SELECT * FROM ai_transcript_evidence ORDER BY attempt_id)",
    ].iter().map(|sql| connection.query_row(sql, [], |row| row.get(0)).unwrap()).collect()
}

#[test]
fn partial_provider_result_is_published_in_the_ordinary_subtitle_list() {
    let fixture = Fixture::new(true, false);
    fixture
        .charges()
        .execute(
            "UPDATE ai_jobs SET state='approved' WHERE id=?",
            [&fixture.quote.id],
        )
        .unwrap();
    let before = ledger_snapshot(&fixture.charges());
    assert!(automatic::apply_progress(&fixture.state, &fixture.quote.id).unwrap());
    let rows = fixture.rows();
    assert!(
        rows.iter()
            .any(|row| row.text == "Hello." && row.status == "generated")
    );
    assert!(!rows.iter().any(|row| row.text == "Goodbye."));
    assert!(
        rows.iter()
            .all(|row| surtitle_core::is_usable_subtitle_status(&row.status))
    );
    let ranges = serde_json::to_value(
        automatic::progress_ranges(&fixture.state, &fixture.quote.id).unwrap(),
    )
    .unwrap();
    assert_eq!(ranges[0]["state"], "received");
    assert_eq!(ranges[1]["state"], "pending");
    assert_eq!(
        fixture.state.ai.quote(&fixture.quote.id).unwrap().state,
        "approved"
    );
    assert!(
        !fixture
            .state
            .ai
            .transcript_application_recorded(&fixture.quote.id, &fixture.quote.digest)
            .unwrap()
    );
    assert_eq!(before, ledger_snapshot(&fixture.charges()));
}

#[test]
fn ordinary_row_edits_during_a_job_survive_later_results_and_completion() {
    let fixture = Fixture::new(true, false);
    fixture
        .charges()
        .execute(
            "UPDATE ai_jobs SET state='approved' WHERE id=?",
            [&fixture.quote.id],
        )
        .unwrap();
    automatic::apply_progress(&fixture.state, &fixture.quote.id).unwrap();
    let mut corrected = fixture
        .rows()
        .into_iter()
        .find(|row| row.text == "Hello.")
        .unwrap();
    corrected.text = "My correction while the next response is pending.".into();
    corrected.status = "confirmed".into();
    let before_edit = ledger_snapshot(&fixture.charges());
    crate::application::subtitles::edit_segment(fixture.state.clone(), corrected.clone()).unwrap();
    assert_eq!(
        fixture.state.ai.quote(&fixture.quote.id).unwrap().state,
        "approved"
    );
    assert_eq!(before_edit, ledger_snapshot(&fixture.charges()));
    fixture.receive_last();
    let before_publish = ledger_snapshot(&fixture.charges());
    assert!(automatic::apply_progress(&fixture.state, &fixture.quote.id).unwrap());
    automatic::apply_completed(&fixture.state, &fixture.quote.id).unwrap();
    let rows = fixture.rows();
    assert_eq!(
        serde_json::to_value(rows.iter().find(|row| row.id == corrected.id).unwrap()).unwrap(),
        serde_json::to_value(&corrected).unwrap()
    );
    assert!(rows.iter().any(|row| row.text == "Goodbye."));
    assert!(
        fixture
            .state
            .ai
            .transcript_application_recorded(&fixture.quote.id, &fixture.quote.digest)
            .unwrap()
    );
    assert_eq!(before_publish, ledger_snapshot(&fixture.charges()));
}

#[test]
fn restarting_a_partial_job_preserves_rows_ids_and_one_previous_version() {
    let fixture = Fixture::new(true, false);
    automatic::apply_progress(&fixture.state, &fixture.quote.id).unwrap();
    let rows = fixture.rows();
    let versions = lock(&fixture.state.db)
        .unwrap()
        .subtitle_versions(fixture.media_id())
        .unwrap();
    assert_eq!(versions.len(), 1);
    let before = ledger_snapshot(&fixture.charges());
    let Fixture {
        directory,
        state,
        quote,
        ..
    } = fixture;
    drop(state);
    let state = Services::open(directory.path().to_path_buf()).unwrap();
    assert_eq!(
        serde_json::to_value(
            crate::application::subtitles::list_segments(
                state.clone(),
                quote.binding.media_id.clone()
            )
            .unwrap()
        )
        .unwrap(),
        serde_json::to_value(rows).unwrap()
    );
    assert!(!automatic::apply_progress(&state, &quote.id).unwrap());
    assert_eq!(
        lock(&state.db)
            .unwrap()
            .subtitle_versions(&quote.binding.media_id)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        before,
        ledger_snapshot(
            &rusqlite::Connection::open(directory.path().join("charges.sqlite")).unwrap()
        )
    );
}

#[test]
fn restoring_subtitles_detaches_a_running_publication_and_restart_does_not_republish() {
    let fixture = Fixture::new(true, false);
    automatic::apply_progress(&fixture.state, &fixture.quote.id).unwrap();
    let version = lock(&fixture.state.db)
        .unwrap()
        .subtitle_versions(fixture.media_id())
        .unwrap()
        .remove(0);
    crate::application::subtitles::restore_subtitle_version(
        fixture.state.clone(),
        fixture.media_id().into(),
        version.id,
    )
    .unwrap();
    assert!(
        load_binding(&fixture.state, &fixture.quote.id)
            .unwrap()
            .publication_detached
    );
    let restored = fixture.rows();
    assert_eq!(restored.len(), 1);
    assert_eq!(restored[0].text, "Original subtitle");
    fixture.receive_last();
    let before = ledger_snapshot(&fixture.charges());
    assert!(!automatic::apply_progress(&fixture.state, &fixture.quote.id).unwrap());
    assert!(!automatic::apply_completed(&fixture.state, &fixture.quote.id).unwrap());
    let Fixture {
        directory,
        state,
        quote,
        ..
    } = fixture;
    drop(state);
    let state = Services::open(directory.path().to_path_buf()).unwrap();
    assert_eq!(
        serde_json::to_value(
            crate::application::subtitles::list_segments(state.clone(), quote.binding.media_id)
                .unwrap()
        )
        .unwrap(),
        serde_json::to_value(restored).unwrap()
    );
    assert_eq!(
        before,
        ledger_snapshot(
            &rusqlite::Connection::open(directory.path().join("charges.sqlite")).unwrap()
        )
    );
}

#[test]
fn coarse_text_preserves_the_actual_submitted_range_including_context() {
    let fixture = Fixture::new(true, true);
    let output = ParsedOutput::Transcript {
        cues: vec![GeneratedCue {
            start_ms: 0,
            end_ms: 7000,
            text: "All received words survive uncertain timing.".into(),
            timing_precision: "source_block".into(),
            word_anchors: vec![],
        }],
    };
    fixture
        .charges()
        .execute(
            "UPDATE ai_requests SET response_json=? WHERE job_id=? AND ordinal=0",
            rusqlite::params![serde_json::to_string(&output).unwrap(), fixture.quote.id],
        )
        .unwrap();
    let before = ledger_snapshot(&fixture.charges());
    assert!(automatic::apply_progress(&fixture.state, &fixture.quote.id).unwrap());
    let rows = fixture.rows();
    let block = rows
        .iter()
        .find(|row| row.timing_precision == "source_block")
        .unwrap();
    assert_eq!((block.start_ms, block.end_ms), (0, 7000));
    assert_eq!(block.text, "All received words survive uncertain timing.");
    assert_eq!(block.status, "generated");
    assert!(
        rows.iter().any(|row| row.text == "Original subtitle"),
        "Context must not replace unrelated canonical rows outside the selection"
    );
    let ranges = serde_json::to_value(
        automatic::progress_ranges(&fixture.state, &fixture.quote.id).unwrap(),
    )
    .unwrap();
    assert_eq!(ranges[0]["state"], "source_block");
    assert_eq!(before, ledger_snapshot(&fixture.charges()));
}

#[test]
fn final_publication_hashes_source_bytes_and_rejects_same_size_content_changes() {
    let fixture = Fixture::new(false, false);
    let original_rows = fixture.rows();
    let mut bytes = fs::read(&fixture.receipt.source_path).unwrap();
    *bytes.last_mut().unwrap() ^= 1;
    fs::write(&fixture.receipt.source_path, &bytes).unwrap();
    let before = ledger_snapshot(&fixture.charges());
    assert!(automatic::apply_completed(&fixture.state, &fixture.quote.id).is_err());
    assert_eq!(
        serde_json::to_value(fixture.rows()).unwrap(),
        serde_json::to_value(original_rows).unwrap()
    );
    assert!(
        !fixture
            .state
            .ai
            .transcript_application_recorded(&fixture.quote.id, &fixture.quote.digest)
            .unwrap()
    );
    assert!(
        fixture
            .state
            .ai
            .response(&fixture.quote.id, 0)
            .unwrap()
            .is_some()
    );
    assert!(
        fixture
            .state
            .ai
            .response(&fixture.quote.id, 1)
            .unwrap()
            .is_some()
    );
    assert_eq!(before, ledger_snapshot(&fixture.charges()));
}

fn legacy_fixture(pending: bool) -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let state = Services::open(directory.path().to_path_buf()).unwrap();
    seed_fixture_data(&state).unwrap();
    let mut receipt = load_receipt(&state, if pending { PENDING } else { COMPLETE }).unwrap();
    receipt.prepared_job = receipt
        .prepared_job
        .with_apply_policy(TranscriptApplyPolicy::Auto)
        .unwrap();
    surtitle_core::store::write_json_atomic(&receipt.directory.join("receipt.json"), &receipt)
        .unwrap();
    let quote = state
        .ai
        .seed_transcript_review_fixture(receipt.prepared_job.clone(), pending)
        .unwrap();
    // Registration defaults to the pre-progressive contract. No publication
    // session exists until the user explicitly adopts the saved result.
    register_fixture_job(&state, &receipt, &quote, None).unwrap();
    assert!(!load_binding(&state, &quote.id).unwrap().progressive);
    assert!(
        !lock(&state.db)
            .unwrap()
            .transcript_publication_exists(&quote.id, &quote.digest)
            .unwrap()
    );
    Fixture {
        directory,
        state,
        quote,
        receipt,
    }
}

fn reopen(fixture: Fixture) -> Fixture {
    let Fixture {
        directory,
        state,
        quote,
        receipt,
    } = fixture;
    drop(state);
    let state = Services::open(directory.path().to_path_buf()).unwrap();
    Fixture {
        directory,
        state,
        quote,
        receipt,
    }
}

/// A fixed old-parser failure for the unchanged second fixture request. The
/// provider's complete text and invalid original timing remain immutable.
fn seed_old_timing_failure(fixture: &Fixture, attempt_state: &str, job_state: &str) -> String {
    assert!(matches!(attempt_state, "settled" | "unknown"));
    let attempt = uuid::Uuid::new_v4().to_string();
    let binding = load_binding(&fixture.state, &fixture.quote.id).unwrap();
    let range = range_binding(&binding, &fixture.receipt, 1).unwrap();
    assert_eq!((range.request_start_ms, range.request_end_ms), (1000, 8000));
    let settled = attempt_state == "settled";
    fixture.charges().execute(
        "INSERT INTO ai_attempts(id,job_id,ordinal,state,reserve_microusd,charged_microusd,created_at_ms,dispatched_at_ms,settled_at_ms,usage_json,model_version) VALUES(?,?,1,?,12345,?,1,2,?,?,?)",
        rusqlite::params![attempt, fixture.quote.id, attempt_state, settled.then_some(440), settled.then_some(3),
            settled.then_some(r#"{"promptTokenCount":100,"candidatesTokenCount":20}"#), "historical-fixture-v1"],
    ).unwrap();
    fixture.charges().execute(
        "UPDATE ai_requests SET state=?,response_json=NULL,error_code='output_requires_review' WHERE job_id=? AND ordinal=1",
        rusqlite::params![if settled { "needs_review" } else { "unknown" }, fixture.quote.id],
    ).unwrap();
    fixture
        .charges()
        .execute(
            "UPDATE ai_jobs SET state=? WHERE id=?",
            rusqlite::params![job_state, fixture.quote.id],
        )
        .unwrap();
    let evidence = TranscriptEvidence {
        attempt_id: attempt.clone(),
        job_id: fixture.quote.id.clone(),
        ordinal: 1,
        input_sha256: range.input_sha256,
        request_sha256: range.request_sha256,
        task_sha256: sha256_bytes(
            &serde_json::to_vec(&fixture.receipt.prepared_job.requests[1]).unwrap(),
        ),
        model_id: fixture.receipt.prepared_job.execution.model_id.clone(),
        parser_revision: "transcript-response-v1".into(),
        response: serde_json::json!({
            "candidates":[{"finishReason":"STOP","content":{"parts":[{"audioTranscription":{
                "text":"No. Goodbye.", "finished":true,
                "words":[{"word":"No","startOffset":"2.5s","endOffset":"1.5s"},
                    {"word":"Goodbye","startOffset":"6.5s","endOffset":"6.9s"}]
            }}]}}],
            "usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":20}
        }),
        complete: true,
        state: TranscriptResultState::Invalid,
        reason: Some(TranscriptResultReason::ReversedTime),
    };
    let json = serde_json::to_string(&evidence).unwrap();
    fixture
        .charges()
        .execute(
            "INSERT INTO ai_transcript_evidence VALUES(?,?,?)",
            rusqlite::params![attempt, json, sha256_bytes(json.as_bytes())],
        )
        .unwrap();
    attempt
}

fn immutable_history_snapshot(fixture: &Fixture) -> Vec<String> {
    let mut snapshot = ledger_snapshot(&fixture.charges());
    // Local recovery may mark the operational request complete, but must not
    // change its absent original output, plan digest, evidence, or attempt cost.
    snapshot.remove(1);
    snapshot.push(
        fixture
            .charges()
            .query_row(
                "SELECT json_array(plan_json,digest) FROM ai_jobs WHERE id=?",
                [&fixture.quote.id],
                |row| row.get(0),
            )
            .unwrap(),
    );
    snapshot.push(fixture.charges().query_row(
        "SELECT json_group_array(json_array(ordinal,response_json)) FROM (SELECT ordinal,response_json FROM ai_requests WHERE job_id=? ORDER BY ordinal)",
        [&fixture.quote.id], |row| row.get(0),
    ).unwrap());
    snapshot
}

#[tokio::test]
async fn legacy_auto_jobs_require_explicit_adoption_after_startup_without_rewriting_the_plan() {
    let fixture = legacy_fixture(false);
    let before = ledger_snapshot(&fixture.charges());
    let original = serde_json::to_value(fixture.rows()).unwrap();
    let fixture = reopen(fixture);
    assert_eq!(serde_json::to_value(fixture.rows()).unwrap(), original);
    assert!(
        !fixture
            .state
            .ai
            .transcript_application_recorded(&fixture.quote.id, &fixture.quote.digest)
            .unwrap()
    );
    let review = get_transcript_review(fixture.state.clone(), fixture.quote.id.clone())
        .await
        .unwrap();
    assert!(review.can_apply, "{:?}", review.blocked_reason);
    assert_eq!(serde_json::to_value(fixture.rows()).unwrap(), original);
    let applied = apply_review(&fixture.state, &fixture.quote.id, &review.draft.digest).unwrap();
    assert!(applied.applied);
    assert!(fixture.rows().iter().any(|row| row.text == "Hello."));
    assert_eq!(
        fixture.state.ai.quote(&fixture.quote.id).unwrap().digest,
        fixture.quote.digest
    );
    assert_eq!(before, ledger_snapshot(&fixture.charges()));
}

#[tokio::test]
async fn opening_settled_old_timing_failure_recovers_text_locally_and_excludes_paid_retry() {
    let fixture = legacy_fixture(true);
    seed_old_timing_failure(&fixture, "settled", "needs_review");
    let before = immutable_history_snapshot(&fixture);
    let original = serde_json::to_value(fixture.rows()).unwrap();
    let fixture = reopen(fixture);
    assert!(
        fixture
            .state
            .ai
            .selected_transcript_reparse(&fixture.quote.id, 1)
            .unwrap()
            .is_none(),
        "Startup must not silently reinterpret historical evidence"
    );
    let review = get_transcript_review(fixture.state.clone(), fixture.quote.id.clone())
        .await
        .unwrap();
    assert!(review.can_apply, "{:?}", review.blocked_reason);
    let block = review
        .draft
        .segments
        .iter()
        .find(|row| row.timing_precision == "source_block")
        .unwrap();
    assert_eq!(
        (block.start_ms, block.end_ms, block.text.as_str()),
        (1000, 8000, "No. Goodbye.")
    );
    assert!(block.word_anchors.is_empty());
    assert_eq!(
        serde_json::to_value(fixture.rows()).unwrap(),
        original,
        "Opening legacy history must not replace the canonical subtitles"
    );
    assert!(
        fixture
            .state
            .ai
            .response(&fixture.quote.id, 1)
            .unwrap()
            .is_none()
    );
    assert!(
        fixture
            .state
            .ai
            .selected_transcript_reparse(&fixture.quote.id, 1)
            .unwrap()
            .is_some()
    );
    let quote = fixture.state.ai.quote(&fixture.quote.id).unwrap();
    assert_eq!(quote.completed_requests, 2);
    assert!(quote.remaining_ordinals.is_empty());
    assert!(fixture.state.ai.reserve_next(&fixture.quote.id).is_err());
    let detail = fixture
        .state
        .ai
        .transcript_result_detail(&fixture.quote.id, 1)
        .unwrap();
    assert_eq!(
        detail.evidence.as_ref().unwrap().parser_revision,
        "transcript-response-v1"
    );
    assert_eq!(
        detail.evidence.as_ref().unwrap().response["candidates"][0]["content"]["parts"][0]["audioTranscription"]
            ["words"][0]["endOffset"],
        "1.5s"
    );
    assert_eq!(
        detail
            .reparses
            .iter()
            .filter(|candidate| candidate.selected)
            .count(),
        1
    );
    assert_eq!(before, immutable_history_snapshot(&fixture));
    get_transcript_review(fixture.state.clone(), fixture.quote.id.clone())
        .await
        .unwrap();
    assert_eq!(
        fixture
            .state
            .ai
            .transcript_result_detail(&fixture.quote.id, 1)
            .unwrap()
            .reparses
            .len(),
        1
    );
    assert_eq!(before, immutable_history_snapshot(&fixture));
}

#[tokio::test]
async fn opening_unknown_or_running_history_keeps_evidence_readable_without_selecting_it() {
    for (attempt_state, job_state) in [("unknown", "needs_review"), ("settled", "approved")] {
        let fixture = legacy_fixture(true);
        let attempt = seed_old_timing_failure(&fixture, attempt_state, job_state);
        let before = ledger_snapshot(&fixture.charges());
        let review = get_transcript_review(fixture.state.clone(), fixture.quote.id.clone())
            .await
            .unwrap();
        assert_eq!(review.results[1].state, TranscriptResultState::Invalid);
        assert!(!review.can_apply);
        assert!(!review.draft.pending_ranges.is_empty());
        assert!(
            fixture
                .state
                .ai
                .selected_transcript_reparse(&fixture.quote.id, 1)
                .unwrap()
                .is_none()
        );
        let detail = fixture
            .state
            .ai
            .transcript_result_detail(&fixture.quote.id, 1)
            .unwrap();
        assert!(detail.reparses.is_empty());
        assert_eq!(
            detail.evidence.as_ref().unwrap().response["candidates"][0]["content"]["parts"][0]["audioTranscription"]
                ["text"],
            "No. Goodbye."
        );
        assert_eq!(
            fixture.state.ai.quote(&fixture.quote.id).unwrap().state,
            job_state
        );
        if attempt_state == "unknown" {
            let summary = fixture.state.ai.summary().unwrap();
            let held = summary
                .unknown_attempts
                .iter()
                .find(|row| row.id == attempt)
                .unwrap();
            assert_eq!(held.state, "unknown");
            assert_eq!(held.held_or_charged_microusd, Some(12345));
        }
        assert_eq!(before, ledger_snapshot(&fixture.charges()));
    }
}
