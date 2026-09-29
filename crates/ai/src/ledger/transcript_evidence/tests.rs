use super::*;

fn task() -> RequestTask {
    RequestTask::TranscribePreview {
        audio: crate::AudioAttachment {
            path: std::path::PathBuf::from("unused.flac"),
            sha256: sha256_bytes(b"audio"),
            byte_len: 5,
            duration_ms: 10_000,
            source_start_ms: 1000,
            mime_type: "audio/flac".into(),
        },
        language: "en".into(),
    }
}
fn response() -> Value {
    json!({"modelVersion":"test-model", "usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5},
        "candidates":[{"finishReason":"STOP","content":{"parts":[{"audioTranscription":{"text":"Hello.","finished":true,"words":[{"word":"Hello","startOffset":"1s","endOffset":"2s"}]}}]}}]})
}
fn setup() -> (tempfile::TempDir, AiStore, ReservedRequest) {
    let (directory, store) = super::super::tests::store();
    super::super::tests::enable(&store);
    let source = super::super::tests::plan();
    let plan = PreparedJob::fixture(
        source.title,
        source.project_id,
        source.credential_id,
        source.binding,
        vec![task()],
    );
    let quote = store.prepare(plan).unwrap();
    store.approve(&quote.id, &quote.digest).unwrap();
    let request = store.reserve_next(&quote.id).unwrap().unwrap();
    store.validate_dispatch(&request).unwrap();
    (directory, store, request)
}

#[test]
fn allowlist_drops_thoughts_secrets_and_oversized_fields_without_prefixes() {
    let mut raw = response();
    raw["authorization"] = json!("secret");
    raw["candidates"][0]["finishMessage"] = json!("secret");
    raw["candidates"][0]["content"]["parts"]
        .as_array_mut()
        .unwrap()
        .push(json!({"thought":true,"text":"secret"}));
    raw["candidates"][0]["content"]["parts"][0]["audioTranscription"]["words"][0]["diagnostic"] =
        json!("secret");
    let (saved, complete) = sanitize(&raw);
    assert!(complete);
    assert!(!saved.to_string().contains("secret"));
    assert_eq!(
        saved["candidates"][0]["content"]["parts"][0]["audioTranscription"]["text"],
        "Hello."
    );
    raw["candidates"][0]["content"]["parts"][0]["text"] = json!("x".repeat(MAX_TEXT_BYTES + 1));
    let (saved, complete) = sanitize(&raw);
    assert!(!complete);
    assert!(saved.to_string().len() < 2000);
}

#[test]
fn invalid_response_is_durable_and_reparse_never_releases_cost_or_overwrites_original() {
    let (_directory, store, request) = setup();
    let mut raw = response();
    raw["candidates"][0]["content"]["parts"][0]["audioTranscription"]["words"][0]["endOffset"] =
        json!("0.5s");
    store.record_transcript_evidence(&request, &raw).unwrap();
    store
        .settle(
            &request.attempt_id,
            20,
            &json!({}),
            None,
            Some("output_requires_review"),
        )
        .unwrap();
    let before = serde_json::to_value(store.summary().unwrap()).unwrap();
    let review = store.transcript_result_detail(&request.job_id, 0).unwrap();
    assert_eq!(review.state, TranscriptResultState::Invalid);
    assert_eq!(
        review.evidence.as_ref().unwrap().response["candidates"][0]["content"]["parts"][0]
            ["audioTranscription"]["words"][0]["endOffset"],
        "0.5s"
    );
    let derived = store
        .reparse_transcript_evidence(&request.job_id, 0, review.evidence_sha256.as_ref().unwrap())
        .unwrap();
    assert_eq!(derived.state, TranscriptResultState::Invalid);
    assert!(derived.output.is_none());
    assert!(store
        .select_transcript_reparse(&request.job_id, 0, &derived.id)
        .is_err());
    assert!(store.response(&request.job_id, 0).unwrap().is_none());
    assert_eq!(
        serde_json::to_value(store.summary().unwrap()).unwrap(),
        before
    );
    assert!(store.reserve_next(&request.job_id).is_err());
}

#[test]
fn local_candidate_requires_selection_and_completed_settlement_and_detects_tampering() {
    let (_directory, store, request) = setup();
    store
        .record_transcript_evidence(&request, &response())
        .unwrap();
    let review = store
        .transcript_result_reviews(&request.job_id)
        .unwrap()
        .remove(0);
    let derived = store
        .reparse_transcript_evidence(&request.job_id, 0, review.evidence_sha256.as_ref().unwrap())
        .unwrap();
    assert!(!derived.selected);
    assert!(store
        .selected_transcript_reparse(&request.job_id, 0)
        .unwrap()
        .is_none());
    assert!(store
        .select_transcript_reparse(&request.job_id, 0, &derived.id)
        .is_err());
    store
        .settle(
            &request.attempt_id,
            20,
            &json!({}),
            None,
            Some("output_requires_review"),
        )
        .unwrap();
    store
        .select_transcript_reparse(&request.job_id, 0, &derived.id)
        .unwrap();
    assert!(store
        .selected_transcript_reparse(&request.job_id, 0)
        .unwrap()
        .is_some());
    assert!(store.response(&request.job_id, 0).unwrap().is_none());
    store
        .connect()
        .unwrap()
        .execute(
            "UPDATE ai_transcript_evidence SET evidence_json='{}' WHERE attempt_id=?",
            [&request.attempt_id],
        )
        .unwrap();
    assert!(store
        .selected_transcript_reparse(&request.job_id, 0)
        .is_err());
}

#[test]
fn missing_invalid_and_valid_empty_results_remain_distinct() {
    let (_directory, store, request) = setup();
    assert_eq!(
        store.transcript_result_reviews(&request.job_id).unwrap()[0].state,
        TranscriptResultState::Pending
    );
    let missing = json!({"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":3}});
    assert_eq!(
        classified(&task(), &missing).1,
        Some(TranscriptResultReason::CandidateMissing)
    );
    let empty = json!({"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"totalTokenCount":10}});
    assert_eq!(classified(&task(), &empty).0, TranscriptResultState::Empty);
    assert_eq!(
        classified(&task(), &response()).0,
        TranscriptResultState::Received
    );
}

#[test]
fn immutable_attempt_evidence_cannot_be_overwritten_or_rebound() {
    let (_directory, store, request) = setup();
    store
        .record_transcript_evidence(&request, &response())
        .unwrap();
    assert!(store
        .record_transcript_evidence(&request, &response())
        .is_err());
    let review = store
        .transcript_result_reviews(&request.job_id)
        .unwrap()
        .remove(0);
    assert!(store
        .reparse_transcript_evidence(&request.job_id, 0, &"0".repeat(64))
        .is_err());
    assert_eq!(
        review.evidence.unwrap().input_sha256,
        sha256_bytes(b"audio")
    );
}

#[test]
fn concurrent_reparses_keep_one_candidate_per_parser_revision() {
    let (_directory, store, request) = setup();
    store
        .record_transcript_evidence(&request, &response())
        .unwrap();
    let digest = store
        .transcript_result_detail(&request.job_id, 0)
        .unwrap()
        .evidence_sha256
        .unwrap();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let handles = (0..2)
        .map(|_| {
            let (store, job, digest, barrier) = (
                store.clone(),
                request.job_id.clone(),
                digest.clone(),
                barrier.clone(),
            );
            std::thread::spawn(move || {
                barrier.wait();
                store
                    .reparse_transcript_evidence(&job, 0, &digest)
                    .unwrap()
                    .id
            })
        })
        .collect::<Vec<_>>();
    let ids = handles
        .into_iter()
        .map(|handle| handle.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(ids[0], ids[1]);
    assert_eq!(
        store
            .transcript_result_detail(&request.job_id, 0)
            .unwrap()
            .reparses
            .len(),
        1
    );
}

#[test]
fn provider_metadata_cannot_smuggle_arbitrary_diagnostics() {
    let mut raw = response();
    raw["modelVersion"] = json!("token: secret");
    raw["candidates"][0]["finishReason"] = json!("token: secret");
    let (saved, complete) = sanitize(&raw);
    assert!(complete);
    assert!(!saved.to_string().contains("secret"));
    assert!(saved.get("modelVersion").is_none());
    assert_eq!(saved["candidates"][0]["finishReason"], "UNRECOGNIZED");
}
