use super::*;
use serde_json::{Value, json};

struct Fixture {
    directory: tempfile::TempDir,
    state: AppState,
    quote: JobQuote,
}

impl Fixture {
    fn new(empty: bool) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let state = Services::open(directory.path().to_path_buf()).unwrap();
        seed_fixture_data(&state).unwrap();
        let mut receipt = load_receipt(&state, "11111111-1111-4111-8111-111111111111").unwrap();
        for chunk in &mut receipt.chunks {
            chunk.boundary_provenance = Some(ChunkBoundaryProvenance {
                sample_rate: chunk.sample_rate,
                core_start_sample: chunk.core_start_sample,
                boundary_sample: chunk.core_end_sample,
                request_start_sample: chunk.request_start_sample,
                request_end_sample: chunk.request_end_sample,
                kind: chunk.boundary,
                supporting_pause: None,
            });
        }
        // Keep a separate VAD warning in the source draft to prove it is not
        // misclassified or newly published as a forced transport boundary.
        receipt.vad_no_speech_ordinals = vec![0];
        receipt.prepared_job = receipt
            .prepared_job
            .with_apply_policy(TranscriptApplyPolicy::Auto)
            .unwrap();
        surtitle_core::store::write_json_atomic(&receipt.directory.join("receipt.json"), &receipt)
            .unwrap();
        let quote = state
            .ai
            .seed_transcript_review_fixture(receipt.prepared_job.clone(), false)
            .unwrap();
        register_fixture_job(&state, &receipt, &quote, None).unwrap();
        let mut binding = load_binding(&state, &quote.id).unwrap();
        binding.progressive = true;
        save_binding(&state, &binding).unwrap();

        // Authored saved provider results only: no transport or credentials.
        // Equal, untimed text in overlapping source blocks must remain intact.
        let charges = rusqlite::Connection::open(directory.path().join("charges.sqlite")).unwrap();
        for ordinal in 0..2 {
            let output = ParsedOutput::Transcript {
                cues: if empty {
                    vec![]
                } else {
                    vec![GeneratedCue {
                        start_ms: ordinal * 1000,
                        end_ms: ordinal * 1000 + 7000,
                        text: "No, no.".into(),
                        timing_precision: "source_block".into(),
                        ..Default::default()
                    }]
                },
            };
            charges
                .execute(
                    "UPDATE ai_requests SET response_json=? WHERE job_id=? AND ordinal=?",
                    rusqlite::params![
                        serde_json::to_string(&output).unwrap(),
                        quote.id,
                        ordinal as i64
                    ],
                )
                .unwrap();
        }
        let draft = keep_conflict_alternatives(&state, &quote.id);
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
        db.activate_transcript_publication(&quote.id, &quote.digest)
            .unwrap();
        drop(db);
        Self {
            directory,
            state,
            quote,
        }
    }

    fn charges(&self) -> rusqlite::Connection {
        rusqlite::Connection::open(self.directory.path().join("charges.sqlite")).unwrap()
    }

    fn ledger_snapshot(&self) -> Vec<String> {
        let charges = self.charges();
        [
            "SELECT json_group_array(json_array(id,job_id,ordinal,state,reserve_microusd,charged_microusd,usage_json)) FROM (SELECT * FROM ai_attempts ORDER BY id)",
            "SELECT json_group_array(json_array(job_id,ordinal,state,response_json,error_code)) FROM (SELECT * FROM ai_requests ORDER BY job_id,ordinal)",
            "SELECT json_group_array(json_array(id,digest,approved_at_ms,approval_json)) FROM (SELECT * FROM ai_jobs ORDER BY id)",
            "SELECT json_group_array(json_array(attempt_id,evidence_json,evidence_sha256)) FROM (SELECT * FROM ai_transcript_evidence ORDER BY attempt_id)",
        ].iter().map(|sql| charges.query_row(sql, [], |row| row.get(0)).unwrap()).collect()
    }

    fn draft(&self) -> TranscriptDraft {
        load_draft(
            &self.state,
            &load_binding(&self.state, &self.quote.id).unwrap(),
        )
        .unwrap()
        .1
    }

    fn rows(&self) -> Vec<surtitle_core::SubtitleSegment> {
        lock(&self.state.db)
            .unwrap()
            .list_segments(&self.quote.binding.media_id)
            .unwrap()
    }

    fn issues(&self) -> Vec<surtitle_core::TranscriptIssueRecord> {
        lock(&self.state.db)
            .unwrap()
            .list_transcript_issues(&self.quote.binding.media_id)
            .unwrap()
    }

    fn reopen(self) -> Self {
        let Self {
            directory,
            state,
            quote,
        } = self;
        drop(state);
        let state = Services::open(directory.path().to_path_buf()).unwrap();
        Self {
            directory,
            state,
            quote,
        }
    }

    fn summary(&self) -> Value {
        let snapshot = serde_json::to_value(
            crate::application::ai::snapshot::get_app_snapshot(self.state.clone()).unwrap(),
        )
        .unwrap();
        snapshot["jobs"]
            .as_array()
            .unwrap()
            .iter()
            .find(|job| job["id"] == self.quote.id)
            .unwrap()
            .clone()
    }
}

fn keep_conflict_alternatives(state: &AppState, job_id: &str) -> TranscriptDraft {
    let binding = load_binding(state, job_id).unwrap();
    let mut draft = load_draft(state, &binding).unwrap().1;
    let conflicts = draft
        .conflicts
        .iter()
        .map(|conflict| conflict.id.clone())
        .collect::<Vec<_>>();
    for id in conflicts {
        draft = resolve_review(state, job_id, &draft.digest, &id, BoundaryChoice::KeepBoth)
            .unwrap()
            .draft;
    }
    draft
}

#[test]
fn forced_boundary_publication_preserves_blocks_and_empty_range_warnings_after_restart() {
    for empty in [false, true] {
        let fixture = Fixture::new(empty);
        let draft = fixture.draft();
        let warning = draft
            .warnings
            .iter()
            .find(|warning| warning.kind == "forced_chunk_boundary")
            .unwrap();
        assert_eq!((warning.start_ms, warning.end_ms), (3000, 5000));
        let ledger = fixture.ledger_snapshot();
        assert!(apply_progress(&fixture.state, &fixture.quote.id).unwrap());
        let rows = fixture.rows();
        assert_eq!(rows.len(), if empty { 0 } else { 2 });
        for row in &rows {
            assert_eq!(row.text, "No, no.");
            assert_eq!(row.timing_precision, "source_block");
            assert_eq!(row.status, "generated_review");
            assert_eq!(row.review_issues.len(), 1);
            assert_eq!(row.review_issues[0].kind, "forced_chunk_boundary");
            assert_eq!(row.review_issues[0].id, warning.id);
            assert!(row.review_issues[0].alternatives.is_empty());
        }
        let issues = fixture.issues();
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].kind, "forced_chunk_boundary");
        assert_eq!(issues[0].id, format!("{}-{}", fixture.quote.id, warning.id));
        assert_eq!((issues[0].start_ms, issues[0].end_ms), (3000, 5000));
        apply_completed(&fixture.state, &fixture.quote.id).unwrap();
        assert_eq!(fixture.summary()["resultState"], "applied_with_warnings");
        assert_eq!(fixture.summary()["needsAttention"], false);
        assert_eq!(fixture.ledger_snapshot(), ledger);
        let fixture = fixture.reopen();
        assert_eq!(
            serde_json::to_value(fixture.rows()).unwrap(),
            serde_json::to_value(rows).unwrap()
        );
        assert_eq!(
            serde_json::to_value(fixture.issues()).unwrap(),
            serde_json::to_value(issues).unwrap()
        );
        assert_eq!(fixture.summary()["resultState"], "applied_with_warnings");
        assert_eq!(fixture.ledger_snapshot(), ledger);
    }
}

#[test]
fn forced_boundary_acknowledgement_clears_publication_issues_on_local_apply_and_restart() {
    let fixture = Fixture::new(false);
    let ledger = fixture.ledger_snapshot();
    apply_progress(&fixture.state, &fixture.quote.id).unwrap();
    assert_eq!(fixture.issues().len(), 1);
    let draft = fixture.draft();
    let warning = draft
        .warnings
        .iter()
        .find(|warning| warning.kind == "forced_chunk_boundary")
        .unwrap();
    let accepted = acknowledge_review_warning(
        &fixture.state,
        &fixture.quote.id,
        &draft.digest,
        &warning.id,
    )
    .unwrap();
    assert!(
        accepted
            .draft
            .warnings
            .iter()
            .any(|warning| warning.kind == "forced_chunk_boundary" && warning.acknowledged)
    );
    assert!(accepted.draft.warnings.iter().any(|warning| warning.kind == "speech_in_vad_no_speech_range" && !warning.acknowledged));
    assert!(
        apply_review(&fixture.state, &fixture.quote.id, &accepted.draft.digest)
            .unwrap()
            .applied
    );
    assert!(fixture.issues().is_empty());
    let rows = fixture.rows();
    assert_eq!(rows.len(), 2);
    assert!(rows.iter().all(|row| row.text == "No, no."
        && row.status == "generated"
        && row.review_issues.is_empty()));
    assert_eq!(fixture.summary()["resultState"], "applied");
    let fixture = fixture.reopen();
    assert!(
        fixture
            .draft()
            .warnings
            .iter()
            .any(|warning| warning.kind == "forced_chunk_boundary" && warning.acknowledged)
    );
    assert!(fixture.issues().is_empty());
    assert_eq!(
        serde_json::to_value(fixture.rows()).unwrap(),
        serde_json::to_value(rows).unwrap()
    );
    assert_eq!(fixture.ledger_snapshot(), ledger);
}

#[test]
fn forced_boundary_warning_survives_selected_local_reparse_and_publication() {
    let fixture = Fixture::new(false);
    let original = fixture.draft();
    let warning = original
        .warnings
        .iter()
        .find(|warning| warning.kind == "forced_chunk_boundary")
        .unwrap();
    let binding = load_binding(&fixture.state, &fixture.quote.id).unwrap();
    let receipt = receipt_for_job(&fixture.state, &binding).unwrap();
    let range = range_binding(&binding, &receipt, 0).unwrap();
    let charges = fixture.charges();
    let attempt: String = charges
        .query_row(
            "SELECT id FROM ai_attempts WHERE job_id=? AND ordinal=0",
            [&fixture.quote.id],
            |row| row.get(0),
        )
        .unwrap();
    let evidence = TranscriptEvidence {
        attempt_id: attempt.clone(),
        job_id: fixture.quote.id.clone(),
        ordinal: 0,
        input_sha256: range.input_sha256,
        request_sha256: range.request_sha256,
        task_sha256: sha256_bytes(&serde_json::to_vec(&receipt.prepared_job.requests[0]).unwrap()),
        model_id: receipt.prepared_job.execution.model_id,
        parser_revision: "transcript-response-v1".into(),
        response: json!({"candidates":[{"finishReason":"STOP","content":{"parts":[{"audioTranscription":{"text":"Recovered.","finished":true,"words":[{"word":"Recovered","startOffset":"3s","endOffset":"3.5s"}]}}]}}]}),
        complete: true,
        state: TranscriptResultState::Invalid,
        reason: Some(TranscriptResultReason::InvalidStructure),
    };
    let encoded = serde_json::to_string(&evidence).unwrap();
    let hash = sha256_bytes(encoded.as_bytes());
    charges
        .execute(
            "INSERT INTO ai_transcript_evidence VALUES(?,?,?)",
            rusqlite::params![attempt, encoded, hash],
        )
        .unwrap();
    charges.execute("UPDATE ai_requests SET response_json=NULL,error_code='output_requires_review' WHERE job_id=? AND ordinal=0", [&fixture.quote.id]).unwrap();
    let candidate = fixture
        .state
        .ai
        .reparse_transcript_evidence(&fixture.quote.id, 0, &hash)
        .unwrap();
    assert_eq!(candidate.state, TranscriptResultState::Received);
    fixture
        .state
        .ai
        .select_transcript_reparse(&fixture.quote.id, 0, &candidate.id)
        .unwrap();
    let reparsed = keep_conflict_alternatives(&fixture.state, &fixture.quote.id);
    assert_eq!(
        reparsed.chunks[0].source,
        TranscriptRangeSource::LocalReparse
    );
    assert!(
        reparsed
            .warnings
            .iter()
            .any(|value| value.id == warning.id && !value.acknowledged)
    );
    let ledger = fixture.ledger_snapshot();
    apply_progress(&fixture.state, &fixture.quote.id).unwrap();
    assert_eq!(fixture.issues().len(), 1);
    assert_eq!(fixture.issues()[0].kind, "forced_chunk_boundary");
    assert!(fixture.rows().iter().any(|row| row.text == "Recovered."
        && row.review_issues.iter().any(|issue| issue.id == warning.id)));
    assert!(
        fixture
            .rows()
            .iter()
            .any(|row| row.text == "No, no." && row.timing_precision == "source_block")
    );
    apply_completed(&fixture.state, &fixture.quote.id).unwrap();
    let fixture = fixture.reopen();
    assert!(
        fixture
            .draft()
            .warnings
            .iter()
            .any(|value| value.id == warning.id && !value.acknowledged)
    );
    assert_eq!(fixture.issues().len(), 1);
    assert_eq!(fixture.ledger_snapshot(), ledger);
}
