//! Offline contract tests for the production execution state machine. Neither a
//! network listener nor real Google credentials are used or configurable here.
use super::*;
use crate::{
    sha256_bytes, AudioAttachment, BudgetLimits, JobQuote, PreparationBinding, PreparedJob,
    SourceCue,
};
use rusqlite::Connection;
use serde_json::json;
use std::{
    collections::VecDeque,
    path::PathBuf,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
};

const FAKE_TOKEN: &str = "test-only-bearer-secret-never-persist";
const FAKE_PROVIDER_SECRET: &str = "test-only-provider-detail-never-expose";

fn transcript_response() -> Value {
    json!({"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5},"candidates":[{"finishReason":"STOP","content":{"parts":[{"text":"{\"cues\":[{\"startMs\":100,\"endMs\":500,\"text\":\"Hello.\"}]}"}]}}]})
}

fn transcript_task(directory: &std::path::Path) -> RequestTask {
    let path = directory.join("fixture.flac");
    std::fs::write(&path, b"test-only audio, no network").unwrap();
    RequestTask::AudioTranscription {
        language: "en".into(),
        audio: AudioAttachment::from_file(path, 0, 1000).unwrap(),
    }
}

#[tokio::test]
async fn transcript_evidence_retains_rejected_response_and_exact_cost_without_resending() {
    let directory = tempfile::tempdir().unwrap();
    let mut response = transcript_response();
    response["candidates"][0]["content"]["parts"][0]["text"] =
        json!("{\"cues\":[{\"startMs\":900,\"endMs\":500,\"text\":\"Hello.\"}]}");
    response["candidates"][0]["finishMessage"] = json!(FAKE_PROVIDER_SECRET);
    let h = Harness::with_tasks(
        vec![transcript_task(directory.path())],
        vec![Ok(FakeResponse::json(response))],
    );
    assert!(matches!(h.execute().await, Err(AiError::Invalid(_))));
    let review = h.store.transcript_result_detail(&h.quote.id, 0).unwrap();
    assert_eq!(review.state, crate::TranscriptResultState::Invalid);
    assert_eq!(
        review.reason,
        Some(crate::TranscriptResultReason::ReversedTime)
    );
    assert!(!serde_json::to_string(&review)
        .unwrap()
        .contains(FAKE_PROVIDER_SECRET));
    let before = serde_json::to_value(h.store.summary().unwrap()).unwrap();
    let derived = h
        .store
        .reparse_transcript_evidence(&h.quote.id, 0, review.evidence_sha256.as_ref().unwrap())
        .unwrap();
    assert!(derived.output.is_none());
    assert!(h.store.response(&h.quote.id, 0).unwrap().is_none());
    assert_eq!(
        serde_json::to_value(h.store.summary().unwrap()).unwrap(),
        before
    );
    assert!(h.execute().await.is_err());
    assert_eq!(h.sends(), 1);
}

#[tokio::test]
async fn transcript_evidence_persistence_and_settlement_failures_keep_hold_and_block_candidates() {
    for evidence_failure in [true, false] {
        let directory = tempfile::tempdir().unwrap();
        let h = Harness::with_tasks(
            vec![transcript_task(directory.path())],
            vec![Ok(FakeResponse::json(transcript_response()))],
        );
        let conn = Connection::open(&h.transport.db_path).unwrap();
        conn.execute_batch(if evidence_failure {
            "CREATE TRIGGER injected_evidence_failure BEFORE INSERT ON ai_transcript_evidence BEGIN SELECT RAISE(ABORT,'injected evidence failure'); END;"
        } else {
            "CREATE TRIGGER injected_settlement_failure BEFORE UPDATE OF state ON ai_attempts WHEN NEW.state='settled' BEGIN SELECT RAISE(ABORT,'injected settlement failure'); END;"
        }).unwrap();
        assert!(h.execute().await.is_err());
        let reopened = AiStore::open(&h.transport.db_path).unwrap();
        reopened.recover_interrupted().unwrap();
        assert_eq!(reopened.summary().unwrap().unknown_attempts.len(), 1);
        assert!(reopened.response(&h.quote.id, 0).unwrap().is_none());
        let review = reopened.transcript_result_detail(&h.quote.id, 0).unwrap();
        assert_eq!(review.evidence.is_none(), evidence_failure);
        if let Some(digest) = review.evidence_sha256 {
            let candidate = reopened
                .reparse_transcript_evidence(&h.quote.id, 0, &digest)
                .unwrap();
            assert!(candidate.output.is_some());
            assert!(reopened
                .select_transcript_reparse(&h.quote.id, 0, &candidate.id)
                .is_err());
        }
        assert!(h.execute().await.is_err());
        assert_eq!(h.sends(), 1);
    }
}

#[tokio::test]
async fn transcript_evidence_marks_unparseable_json_without_retaining_unsafe_bytes() {
    let directory = tempfile::tempdir().unwrap();
    let h = Harness::with_tasks(
        vec![transcript_task(directory.path())],
        vec![Ok(FakeResponse::bytes(
            200,
            format!("{{ {FAKE_PROVIDER_SECRET}").into_bytes(),
        ))],
    );
    assert!(matches!(h.execute().await, Err(AiError::UnknownOutcome)));
    let review = h.store.transcript_result_detail(&h.quote.id, 0).unwrap();
    assert_eq!(review.state, crate::TranscriptResultState::Invalid);
    assert!(!review.evidence.as_ref().unwrap().complete);
    assert!(!serde_json::to_string(&review)
        .unwrap()
        .contains(FAKE_PROVIDER_SECRET));
    assert!(h
        .store
        .reparse_transcript_evidence(&h.quote.id, 0, review.evidence_sha256.as_ref().unwrap())
        .is_err());
    assert_eq!(h.store.summary().unwrap().unknown_attempts.len(), 1);
}
type Events = Arc<Mutex<Vec<&'static str>>>;
type Hook = Mutex<Option<Box<dyn FnOnce() + Send>>>;

fn unprice(mut harness: Harness) -> Harness {
    let plan = harness.store.prepared_job(&harness.quote.id).unwrap();
    let mut execution = plan.execution.clone();
    execution.model_id = "gemini-unlisted-future".into();
    execution.location = "asia-northeast1".into();
    execution.max_output_tokens = 2048;
    execution.price = None;
    harness.quote = harness
        .store
        .prepare(plan.with_execution(execution).unwrap())
        .unwrap();
    harness.store.set_budget(BudgetLimits::default()).unwrap();
    harness
}

#[tokio::test]
async fn unpriced_scope_runs_exact_approved_requests_and_keeps_cost_unknown_after_success() {
    let h = unprice(Harness::with_approval(
        vec![task(), task()],
        vec![
            Ok(FakeResponse::json(valid_response())),
            Ok(FakeResponse::json(valid_response())),
        ],
        false,
    ));
    assert!(h.execute().await.is_err());
    assert!(h
        .store
        .approve_scope(&h.quote.id, &h.quote.digest, false, true)
        .is_err());
    assert!(h
        .store
        .approve_scope(&h.quote.id, &h.quote.digest, true, false)
        .is_err());
    h.store
        .approve_scope(&h.quote.id, &h.quote.digest, true, true)
        .unwrap();
    assert_eq!(h.quote.estimated_max_microusd, None);
    assert_eq!(h.quote.total_output_tokens, 4096);
    for ordinal in 0..2 {
        let result = h.execute().await.unwrap().unwrap();
        assert_eq!(result.ordinal, ordinal);
        assert_eq!(result.charged_microusd, None);
    }
    let summary = h.store.summary().unwrap();
    assert_eq!(summary.unpriced_attempts, 2);
    assert!(!summary.monetary_totals_complete);
    assert!(summary.unknown_attempts.is_empty());
    assert_eq!(h.store.quote(&h.quote.id).unwrap().state, "completed");
    assert!(h.execute().await.is_err());
    assert!(h
        .store
        .reapprove_scope(&h.quote.id, &h.quote.digest, true, true)
        .is_err());
    assert_eq!(h.sends(), 2);
    let requests = h.transport.requests.lock().unwrap();
    assert!(requests[0]
        .url
        .starts_with("https://asia-northeast1-aiplatform.googleapis.com/"));
    assert!(requests[0]
        .url
        .ends_with("/models/gemini-unlisted-future:generateContent"));
    assert_eq!(
        requests[0].body["generationConfig"]["maxOutputTokens"],
        2048
    );
    assert_eq!(requests[0].body["generationConfig"]["candidateCount"], 1);
    assert!(requests[0].body["generationConfig"]
        .get("thinkingConfig")
        .is_none());
}

#[tokio::test]
async fn unpriced_communication_unknown_is_a_separate_blocking_outcome() {
    let h = unprice(Harness::with_approval(
        vec![task()],
        vec![Err(SendFailure::Timeout)],
        false,
    ));
    h.store
        .approve_scope(&h.quote.id, &h.quote.digest, true, true)
        .unwrap();
    assert!(matches!(h.execute().await, Err(AiError::UnknownOutcome)));
    assert!(h.execute().await.is_err());
    let summary = h.store.summary().unwrap();
    assert_eq!(summary.unpriced_attempts, 1);
    assert_eq!(summary.unknown_attempts.len(), 1);
    assert_eq!(summary.unknown_attempts[0].held_or_charged_microusd, None);
    assert!(h
        .store
        .reapprove_scope(&h.quote.id, &h.quote.digest, true, true)
        .is_err());
    let reopened = AiStore::open(&h.transport.db_path).unwrap();
    reopened.recover_interrupted().unwrap();
    assert_eq!(reopened.summary().unwrap().unpriced_attempts, 1);
    assert_eq!(reopened.summary().unwrap().unknown_attempts.len(), 1);
    assert_eq!(h.sends(), 1);
}

#[tokio::test]
async fn replacing_model_price_or_template_after_reservation_cannot_reuse_approval() {
    let h = unprice(Harness::with_approval(vec![task()], vec![], false));
    h.store
        .approve_scope(&h.quote.id, &h.quote.digest, true, true)
        .unwrap();
    let original = h.store.reserve_next(&h.quote.id).unwrap().unwrap();
    for mutation in 0..4 {
        let mut changed = original.clone();
        match mutation {
            0 => changed.execution.model_id = "gemini-another-model".into(),
            1 => changed.execution.location = "global".into(),
            2 => changed.execution.max_output_tokens += 1,
            _ => {
                changed.body_snapshot["systemInstruction"]["parts"][0]["text"] =
                    json!("Changed prompt")
            }
        }
        assert!(h.store.validate_dispatch(&changed).is_err());
    }
    h.store.validate_dispatch(&original).unwrap();
    assert_eq!(h.sends(), 0);
}

struct FakeAuthorization {
    fail: bool,
    calls: AtomicUsize,
    events: Events,
    hook: Hook,
}

impl Authorization for FakeAuthorization {
    async fn access_token(&self, _: &ReservedRequest) -> Result<Zeroizing<String>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.events.lock().unwrap().push("auth");
        let hook = self.hook.lock().unwrap().take();
        if let Some(hook) = hook {
            hook();
        }
        if self.fail {
            return Err(AiError::Credentials);
        }
        Ok(Zeroizing::new(FAKE_TOKEN.into()))
    }
}

#[derive(Debug)]
struct RecordedRequest {
    url: String,
    token: String,
    body: Value,
}

#[derive(Debug, Clone, Copy)]
enum SendFailure {
    Connect,
    Timeout,
    ConnectionReset,
}

struct FakeTransport {
    db_path: PathBuf,
    requests: Mutex<Vec<RecordedRequest>>,
    replies: Mutex<VecDeque<std::result::Result<FakeResponse, SendFailure>>>,
    events: Events,
    hook: Hook,
}

impl Transport for FakeTransport {
    type Response = FakeResponse;

    async fn send(
        &self,
        url: &str,
        token: &str,
        body: &Value,
    ) -> std::result::Result<FakeResponse, ()> {
        // A different SQLite connection must already see the durable reservation.
        // This catches implementations that record it only after the HTTP send.
        let connection = Connection::open(&self.db_path).unwrap();
        let reserved: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM ai_attempts WHERE state='reserved'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(reserved, 1);
        self.events.lock().unwrap().push("send");
        self.requests.lock().unwrap().push(RecordedRequest {
            url: url.into(),
            token: token.into(),
            body: body.clone(),
        });
        let hook = self.hook.lock().unwrap().take();
        if let Some(hook) = hook {
            hook();
        }
        self.replies
            .lock()
            .unwrap()
            .pop_front()
            .expect("An unexpected paid send or retry was attempted")
            .map_err(|_| ())
    }
}

struct FakeResponse {
    status: u16,
    chunks: VecDeque<std::result::Result<Vec<u8>, ()>>,
    reads: Arc<AtomicUsize>,
    pause_on_read: Option<(usize, PathBuf)>,
}

impl FakeResponse {
    fn bytes(status: u16, bytes: Vec<u8>) -> Self {
        Self {
            status,
            chunks: VecDeque::from([Ok(bytes)]),
            reads: Arc::new(AtomicUsize::new(0)),
            pause_on_read: None,
        }
    }

    fn json(value: Value) -> Self {
        Self::bytes(200, serde_json::to_vec(&value).unwrap())
    }
}

impl ResponseBody for FakeResponse {
    fn status(&self) -> u16 {
        self.status
    }

    async fn chunk(&mut self) -> std::result::Result<Option<Vec<u8>>, ()> {
        let read = self.reads.fetch_add(1, Ordering::SeqCst) + 1;
        if let Some((at, marker)) = &self.pause_on_read {
            if read == *at {
                checkpoint_and_park(marker);
            }
        }
        self.chunks.pop_front().transpose()
    }
}

struct Harness {
    _directory: tempfile::TempDir,
    store: AiStore,
    quote: JobQuote,
    auth: FakeAuthorization,
    transport: FakeTransport,
    events: Events,
}

impl Harness {
    fn new(replies: Vec<std::result::Result<FakeResponse, SendFailure>>) -> Self {
        Self::with_tasks(vec![task()], replies)
    }

    fn with_tasks(
        tasks: Vec<RequestTask>,
        replies: Vec<std::result::Result<FakeResponse, SendFailure>>,
    ) -> Self {
        Self::with_approval(tasks, replies, true)
    }

    fn with_approval(
        tasks: Vec<RequestTask>,
        replies: Vec<std::result::Result<FakeResponse, SendFailure>>,
        approve: bool,
    ) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let db_path = directory.path().join("charges.sqlite");
        let store = AiStore::open(&db_path).unwrap();
        store
            .set_budget(BudgetLimits {
                per_job_microusd: 1_000_000,
                daily_microusd: 1_000_000,
                monthly_microusd: 1_000_000,
            })
            .unwrap();
        let quote = store
            .prepare(PreparedJob::fixture(
                "Deterministic offline Vertex test".into(),
                "fixture-project".into(),
                "fixture-credential".into(),
                PreparationBinding {
                    media_id: "fixture-media".into(),
                    transcript_revision: "revision-one".into(),
                    source_sha256: sha256_bytes(b"source"),
                    settings_sha256: sha256_bytes(b"settings"),
                },
                tasks,
            ))
            .unwrap();
        if approve {
            store.approve(&quote.id, &quote.digest).unwrap();
        }
        let events = Events::default();
        Self {
            _directory: directory,
            store,
            quote,
            auth: FakeAuthorization {
                fail: false,
                calls: AtomicUsize::new(0),
                events: events.clone(),
                hook: Mutex::new(None),
            },
            transport: FakeTransport {
                db_path,
                requests: Mutex::new(vec![]),
                replies: Mutex::new(replies.into()),
                events: events.clone(),
                hook: Mutex::new(None),
            },
            events,
        }
    }

    async fn execute(&self) -> Result<Option<ExecutionResult>> {
        execute_with_io(
            &self.store,
            &self.auth,
            &self.transport,
            &self.quote.id,
            || {
                self.events.lock().unwrap().push("guard");
                Ok(())
            },
        )
        .await
    }

    fn sends(&self) -> usize {
        self.transport.requests.lock().unwrap().len()
    }

    fn assert_unknown(&self) {
        let summary = self.store.summary().unwrap();
        assert_eq!(summary.unknown_attempts.len(), 1);
        assert_eq!(summary.unknown_attempts[0].state, "unknown");
        assert_eq!(summary.daily_actual_charged_microusd, 0);
        assert_eq!(
            summary.daily_held_microusd,
            self.quote.requests[0].estimated_max_microusd.unwrap()
        );
        assert_eq!(
            self.store.quote(&self.quote.id).unwrap().state,
            "needs_review"
        );
        assert!(self.store.response(&self.quote.id, 0).unwrap().is_none());
        assert_eq!(self.sends(), 1);
    }

    fn assert_unsent(&self) {
        let summary = self.store.summary().unwrap();
        assert_eq!(summary.daily_charged_or_held_microusd, 0);
        assert!(summary.unknown_attempts.is_empty());
        assert_eq!(self.sends(), 0);
        let conn = Connection::open(&self.transport.db_path).unwrap();
        let state: String = conn
            .query_row("SELECT state FROM ai_attempts", [], |row| row.get(0))
            .unwrap();
        assert_eq!(state, "released");
    }
}

fn task() -> RequestTask {
    RequestTask::Vocabulary {
        learning_language: "en".into(),
        explanation_language: "ja".into(),
        max_items: 2,
        cues: vec![SourceCue {
            id: "cue-one".into(),
            start_ms: 100,
            end_ms: 2000,
            text: "Take your time.".into(),
        }],
    }
}

fn valid_response() -> Value {
    json!({
        "candidates": [{"finishReason": "STOP", "content": {"parts": [{
            "text": serde_json::to_string(&json!({"items": [{
                "term": "take your time", "meaning": "ゆっくりで大丈夫",
                "explanation": "急ぐ必要がないことを伝える表現。",
                "example": "Take your time.", "sourceCueIds": ["cue-one"]
            }]})).unwrap()
        }]}}],
        "usageMetadata": {
            "promptTokenCount": 1000, "candidatesTokenCount": 100,
            "thoughtsTokenCount": 10
        }
    })
}

fn assert_sanitized(error: &AiError) {
    for exposed in [error.to_string(), format!("{error:?}")] {
        assert!(!exposed.contains(FAKE_TOKEN));
        assert!(!exposed.contains(FAKE_PROVIDER_SECRET));
        assert!(!exposed.contains("evil.invalid"));
    }
}

#[tokio::test]
async fn successful_request_uses_real_body_and_durable_reservation_then_settles_once() {
    let h = Harness::new(vec![Ok(FakeResponse::json(valid_response()))]);
    let result = h.execute().await.unwrap().unwrap();
    assert_eq!(result.ordinal, 0);
    assert_eq!(result.charged_microusd.unwrap(), 575);
    assert!(matches!(result.output, ParsedOutput::Vocabulary { .. }));
    assert_eq!(*h.events.lock().unwrap(), ["auth", "guard", "send"]);
    {
        let requests = h.transport.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].url, "https://aiplatform.googleapis.com/v1/projects/fixture-project/locations/global/publishers/google/models/gemini-3.8-flash:generateContent");
        assert_eq!(
            &requests[0].body,
            h.store
                .prepared_job(&h.quote.id)
                .unwrap()
                .request_body_snapshot(0)
                .unwrap()
        );
        assert_eq!(requests[0].token, FAKE_TOKEN);
    }
    let summary = h.store.summary().unwrap();
    assert_eq!(summary.daily_actual_charged_microusd, 575);
    assert_eq!(summary.daily_held_microusd, 0);
    assert_eq!(h.store.quote(&h.quote.id).unwrap().state, "completed");
    assert!(h.store.response(&h.quote.id, 0).unwrap().is_some());
    assert!(h.execute().await.is_err());
    assert_eq!(h.sends(), 1);
    assert_eq!(h.auth.calls.load(Ordering::SeqCst), 1);
    let conn = Connection::open(&h.transport.db_path).unwrap();
    let persisted: String = conn
        .query_row(
            "SELECT COALESCE(usage_json,'') || COALESCE(response_json,'') || COALESCE(error_code,'') FROM ai_attempts JOIN ai_requests USING(job_id,ordinal)",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(!persisted.contains(FAKE_TOKEN));
}

#[tokio::test]
async fn explanation_refinement_is_frozen_and_old_approval_never_authorizes_new_prompt() {
    const REFINEMENT: &str = "Describe contrasts as context-dependent unless a categorical restriction is well established; do not infer intention, agency, necessity, causes, or subsequent events that the cited source does not entail. ";
    let h = Harness::with_approval(
        vec![RequestTask::Explanation {
            term: "take your time".into(),
            learning_language: "en".into(),
            explanation_language: "ja".into(),
            proficiency: "B1".into(),
            cues: vec![SourceCue {
                id: "cue-one".into(),
                start_ms: 100,
                end_ms: 2000,
                text: "Take your time.".into(),
            }],
        }],
        vec![
            Ok(FakeResponse::json(valid_response())),
            Ok(FakeResponse::json(valid_response())),
        ],
        false,
    );
    let fresh = h.store.prepared_job(&h.quote.id).unwrap();
    let fresh_body = fresh.request_body_snapshot(0).unwrap().clone();
    let mut historical_json = serde_json::to_value(&fresh).unwrap();
    let instruction = historical_json
        .pointer_mut("/frozen_requests/0/systemInstruction/parts/0/text")
        .unwrap();
    let historical_instruction = instruction.as_str().unwrap().replace(REFINEMENT, "");
    assert_ne!(historical_instruction, instruction.as_str().unwrap());
    *instruction = json!(historical_instruction);
    let historical: PreparedJob = serde_json::from_value(historical_json).unwrap();
    historical.validate().unwrap();
    let historical_body = historical.request_body_snapshot(0).unwrap().clone();
    let historical_quote = h.store.prepare(historical).unwrap();
    assert_ne!(historical_quote.digest, h.quote.digest);
    assert!(h
        .store
        .approve(&historical_quote.id, &h.quote.digest)
        .is_err());
    h.store
        .approve(&historical_quote.id, &historical_quote.digest)
        .unwrap();
    let reopened = AiStore::open(&h.transport.db_path).unwrap();
    execute_with_io(
        &reopened,
        &h.auth,
        &h.transport,
        &historical_quote.id,
        || Ok(()),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(
        h.transport.requests.lock().unwrap()[0].body,
        historical_body
    );
    assert_eq!(
        reopened
            .prepared_job(&historical_quote.id)
            .unwrap()
            .request_body_snapshot(0)
            .unwrap(),
        &historical_body
    );
    assert!(reopened
        .approve(&h.quote.id, &historical_quote.digest)
        .is_err());
    reopened.approve(&h.quote.id, &h.quote.digest).unwrap();
    execute_with_io(&reopened, &h.auth, &h.transport, &h.quote.id, || Ok(()))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(h.transport.requests.lock().unwrap()[1].body, fresh_body);
    assert!(execute_with_io(
        &reopened,
        &h.auth,
        &h.transport,
        &historical_quote.id,
        || Ok(())
    )
    .await
    .is_err());
    assert_eq!(h.sends(), 2);
    assert_eq!(reopened.summary().unwrap().daily_held_microusd, 0);
}

#[cfg(feature = "development-validation")]
#[tokio::test]
async fn scoped_audio_validation_uses_the_shared_worker_and_retains_word_evidence() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("offline-fixture.flac");
    std::fs::write(&path, b"fake audio bytes never sent to a network").unwrap();
    let audio = AudioAttachment::from_file(path, 0, 1000).unwrap();
    let h = Harness::with_approval(
        vec![RequestTask::TranscribePreview {
            language: "en-US".into(),
            audio,
        }],
        vec![Ok(FakeResponse::json(json!({
            "usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":10,"thoughtsTokenCount":0},
            "candidates":[{"finishReason":"STOP","content":{"parts":[{"audioTranscription":{
                "text":"Hello.","finished":true,"words":[{"word":"Hello","startOffset":"0.100s","endOffset":"0.500s"}]
            }}]}}]
        })))],
        false,
    );
    assert!(matches!(
        h.store
            .approve_scope(&h.quote.id, &h.quote.digest, false, false),
        Err(AiError::ApprovalRequired)
    ));
    h.store.initialize_validation_total(2_000_000).unwrap();
    let scoped = h
        .store
        .with_development_validation(
            &h.quote.id,
            crate::ValidationApproval {
                plan_digest: h.quote.digest.clone(),
                model: crate::TRANSCRIBE_MODEL.into(),
                max_requests: 1,
                expires_at_ms: crate::ledger::TEST_NOW_MS + 60_000,
                max_reservation_microusd: h.quote.estimated_max_microusd,
                total_limit_microusd: 2_000_000,
            },
        )
        .unwrap();
    scoped.approve(&h.quote.id, &h.quote.digest).unwrap();
    let result = execute_with_io(&scoped, &h.auth, &h.transport, &h.quote.id, || Ok(()))
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(result.output, ParsedOutput::Transcript { .. }));
    assert_eq!(result.charged_microusd.unwrap(), 320);
    assert_eq!(h.sends(), 1);
    let attempts = scoped.validation_attempts().unwrap();
    assert_eq!(attempts.len(), 1);
    assert_eq!(attempts[0].charged_microusd, Some(320));
    assert_eq!(
        attempts[0].evidence.as_ref().unwrap()["audioTranscriptions"][0]["words"][0]["startOffset"],
        "0.100s"
    );
    assert!(
        execute_with_io(&scoped, &h.auth, &h.transport, &h.quote.id, || Ok(()))
            .await
            .is_err()
    );
    assert_eq!(h.sends(), 1);
}

#[cfg(feature = "development-validation")]
#[tokio::test]
async fn scoped_silence_settles_verified_zero_output_and_holds_ambiguous_usage_without_replay() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("offline-silence.wav");
    // Deterministic local bytes exercise immutable request preparation only;
    // the private fake transport never decodes or sends them to any network.
    std::fs::write(&path, b"offline silent response fixture").unwrap();
    let audio = AudioAttachment::from_file(path, 0, 2000).unwrap();
    for (usage, accepts) in [
        (json!({"promptTokenCount":52,"totalTokenCount":52}), true),
        (json!({"promptTokenCount":52,"totalTokenCount":53}), false),
        (
            json!({"promptTokenCount":52,"totalTokenCount":52,"candidatesTokenCount":null}),
            false,
        ),
        (
            json!({"promptTokenCount":52,"totalTokenCount":52,"thoughtsTokenCount":0.5}),
            false,
        ),
    ] {
        let h = Harness::with_approval(
            vec![RequestTask::TranscribePreview {
                language: "en-US".into(),
                audio: audio.clone(),
            }],
            vec![Ok(FakeResponse::json(json!({
                "usageMetadata":usage,
                "candidates":[{"finishReason":"STOP","content":{"role":"model"}}]
            })))],
            false,
        );
        h.store.initialize_validation_total(2_000_000).unwrap();
        let scoped = h
            .store
            .with_development_validation(
                &h.quote.id,
                crate::ValidationApproval {
                    plan_digest: h.quote.digest.clone(),
                    model: crate::TRANSCRIBE_MODEL.into(),
                    max_requests: 1,
                    expires_at_ms: crate::ledger::TEST_NOW_MS + 60_000,
                    max_reservation_microusd: h.quote.estimated_max_microusd,
                    total_limit_microusd: 2_000_000,
                },
            )
            .unwrap();
        scoped.approve(&h.quote.id, &h.quote.digest).unwrap();
        let result = execute_with_io(&scoped, &h.auth, &h.transport, &h.quote.id, || Ok(())).await;
        if accepts {
            let result = result.unwrap().unwrap();
            assert!(matches!(result.output, ParsedOutput::Transcript { cues } if cues.is_empty()));
            assert_eq!(result.charged_microusd.unwrap(), 104);
            let attempts = scoped.validation_attempts().unwrap();
            assert_eq!(attempts.len(), 1);
            assert_eq!(attempts[0].state, "settled");
            assert_eq!(attempts[0].charged_microusd, Some(104));
            assert_eq!(attempts[0].usage, usage);
            let evidence = attempts[0].evidence.as_ref().unwrap();
            assert_eq!(evidence["candidateDiagnostics"][0]["finishReason"], "STOP");
            assert_eq!(evidence["candidateDiagnostics"][0]["textParts"], json!([]));
            assert_eq!(evidence["evidenceTruncated"], false);
            assert_eq!(scoped.quote(&h.quote.id).unwrap().state, "completed");
            assert!(
                matches!(scoped.response(&h.quote.id, 0).unwrap(), Some(ParsedOutput::Transcript { cues }) if cues.is_empty())
            );
            let summary = scoped.summary().unwrap();
            assert_eq!(summary.daily_actual_charged_microusd, 104);
            assert_eq!(summary.daily_held_microusd, 0);
            assert!(summary.unknown_attempts.is_empty());
        } else {
            assert!(matches!(result, Err(AiError::UnknownOutcome)));
            h.assert_unknown();
        }
        let before = scoped.validation_totals().unwrap().charged_or_held_microusd;
        assert!(
            execute_with_io(&scoped, &h.auth, &h.transport, &h.quote.id, || Ok(()))
                .await
                .is_err()
        );
        assert_eq!(h.sends(), 1);
        assert_eq!(h.auth.calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            scoped.validation_totals().unwrap().charged_or_held_microusd,
            before
        );
    }
}

#[cfg(feature = "development-validation")]
#[tokio::test]
async fn scoped_parse_failure_keeps_generated_diagnostics_after_known_usage_settlement() {
    let request = RequestTask::Explanation {
        term: "look forward to".into(),
        learning_language: "en".into(),
        explanation_language: "ja".into(),
        proficiency: "A2".into(),
        cues: vec![
            crate::SourceCue {
                id: "cue-19".into(),
                start_ms: 0,
                end_ms: 1000,
                text: "We can still look".into(),
            },
            crate::SourceCue {
                id: "cue-20".into(),
                start_ms: 1000,
                end_ms: 2000,
                text: "forward to the trip, even though it has been delayed.".into(),
            },
        ],
    };
    let generated = json!({"items":[{"term":"look forward to","meaning":"楽しみにする","explanation":"期待を表す。","example":"I look forward to the trip.","sourceCueIds":["cue-19"]}]}).to_string();
    let response = json!({
        "usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":10},
        "candidates":[{"finishReason":"STOP","content":{"parts":[
            {"thought":true,"text":"thought-secret-sentinel"},
            {"text":generated,"access_token":"credential-secret-sentinel"}
        ]}}]
    });
    let h = Harness::with_approval(vec![request], vec![Ok(FakeResponse::json(response))], false);
    h.store.initialize_validation_total(2_000_000).unwrap();
    let scoped = h
        .store
        .with_development_validation(
            &h.quote.id,
            crate::ValidationApproval {
                plan_digest: h.quote.digest.clone(),
                model: crate::VOCABULARY_MODEL.into(),
                max_requests: 1,
                expires_at_ms: crate::ledger::TEST_NOW_MS + 60_000,
                max_reservation_microusd: h.quote.estimated_max_microusd,
                total_limit_microusd: 2_000_000,
            },
        )
        .unwrap();
    scoped.approve(&h.quote.id, &h.quote.digest).unwrap();
    let error = execute_with_io(&scoped, &h.auth, &h.transport, &h.quote.id, || Ok(()))
        .await
        .unwrap_err();
    assert!(matches!(error, AiError::Invalid(_)));
    assert!(!error.to_string().contains("cue-19"));
    assert_eq!(h.sends(), 1);
    let attempts = scoped.validation_attempts().unwrap();
    assert_eq!(attempts.len(), 1);
    assert_eq!(attempts[0].state, "settled");
    assert_eq!(attempts[0].charged_microusd, Some(55));
    let evidence = attempts[0].evidence.as_ref().unwrap();
    assert_eq!(evidence["candidateDiagnostics"][0]["finishReason"], "STOP");
    assert_eq!(
        evidence["candidateDiagnostics"][0]["textParts"],
        json!([generated])
    );
    assert!(!evidence.to_string().contains("secret-sentinel"));
    assert_eq!(scoped.quote(&h.quote.id).unwrap().state, "needs_review");
    assert!(scoped.response(&h.quote.id, 0).unwrap().is_none());
    assert_eq!(scoped.summary().unwrap().daily_held_microusd, 0);
}

#[tokio::test]
async fn credentials_failure_releases_unsent_and_never_retries() {
    let mut h = Harness::new(vec![]);
    h.auth.fail = true;
    let error = h.execute().await.unwrap_err();
    assert!(matches!(error, AiError::Credentials));
    assert_sanitized(&error);
    h.assert_unsent();
    assert_eq!(*h.events.lock().unwrap(), ["auth"]);
    assert!(h.execute().await.is_err());
    assert_eq!(h.auth.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn public_service_rejects_missing_real_vault_credentials_without_network() {
    let h = Harness::new(vec![]);
    let vault = CredentialVault::new(h._directory.path().join("empty-credentials")).unwrap();
    let service = VertexService::new(h.store.clone(), vault).unwrap();
    assert!(matches!(
        service.execute_next(&h.quote.id).await,
        Err(AiError::Credentials)
    ));
    h.assert_unsent();
}

#[tokio::test]
async fn modified_audio_is_rejected_before_oauth_or_paid_transport() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("日本語 & immutable.flac");
    std::fs::write(&path, b"original audio").unwrap();
    let audio = AudioAttachment::from_file(path.clone(), 0, 1000).unwrap();
    let h = Harness::new(vec![]);
    let reservation = ReservedRequest {
        attempt_id: "private-preflight-only".into(),
        job_id: h.quote.id.clone(),
        ordinal: 0,
        task: RequestTask::AudioTranscription {
            language: "en-US".into(),
            audio,
        },
        project_id: "fixture-project".into(),
        credential_id: "fixture-credential".into(),
        reserved_microusd: Some(0),
        execution: h.quote.execution.clone(),
        body_snapshot: serde_json::json!({}),
    };
    std::fs::write(path, b"tampered audio").unwrap();
    // This calls only shared preflight, without bypassing audio qualification or
    // constructing an executable ledger reservation.
    assert!(matches!(
        prepare_authenticated(&h.auth, &reservation).await,
        Err(AiError::PreparationChanged)
    ));
    assert_eq!(h.store.summary().unwrap().daily_charged_or_held_microusd, 0);
    assert_eq!(h.sends(), 0);
    assert_eq!(h.auth.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn source_guard_failure_releases_unsent() {
    let h = Harness::new(vec![]);
    let result = execute_with_io(&h.store, &h.auth, &h.transport, &h.quote.id, || {
        Err(AiError::PreparationChanged)
    })
    .await;
    assert!(matches!(result, Err(AiError::PreparationChanged)));
    h.assert_unsent();
}

#[tokio::test]
async fn cancellation_during_authentication_prevents_paid_dispatch() {
    let h = Harness::new(vec![]);
    let store = h.store.clone();
    let id = h.quote.id.clone();
    *h.auth.hook.lock().unwrap() = Some(Box::new(move || store.cancel(&id).unwrap()));
    assert!(matches!(h.execute().await, Err(AiError::ApprovalRequired)));
    h.assert_unsent();
    assert_eq!(h.store.quote(&h.quote.id).unwrap().state, "cancelled");
}

#[tokio::test]
async fn budget_reduction_during_authentication_prevents_paid_dispatch() {
    let h = Harness::new(vec![]);
    let store = h.store.clone();
    *h.auth.hook.lock().unwrap() = Some(Box::new(move || {
        store.set_budget(BudgetLimits::default()).unwrap();
    }));
    assert!(matches!(h.execute().await, Err(AiError::BudgetDisabled)));
    h.assert_unsent();
}

#[tokio::test]
async fn cancellation_inside_source_guard_is_rechecked_before_send() {
    let h = Harness::new(vec![]);
    let result = execute_with_io(&h.store, &h.auth, &h.transport, &h.quote.id, || {
        h.store.cancel(&h.quote.id)
    })
    .await;
    assert!(matches!(result, Err(AiError::ApprovalRequired)));
    h.assert_unsent();
}

#[tokio::test]
async fn cancellation_after_send_preserves_charge_without_resurrecting_the_job() {
    let h = Harness::new(vec![Ok(FakeResponse::json(valid_response()))]);
    let store = h.store.clone();
    let id = h.quote.id.clone();
    *h.transport.hook.lock().unwrap() = Some(Box::new(move || store.cancel(&id).unwrap()));
    let result = h.execute().await.unwrap().unwrap();
    assert_eq!(result.charged_microusd.unwrap(), 575);
    assert_eq!(h.store.quote(&h.quote.id).unwrap().state, "cancelled");
    assert_eq!(
        h.store.summary().unwrap().daily_actual_charged_microusd,
        575
    );
    assert!(h.store.response(&h.quote.id, 0).unwrap().is_some());
    assert!(h.execute().await.is_err());
    assert_eq!(h.sends(), 1);
}

#[tokio::test]
async fn http_rejections_and_redirects_retain_unknown_without_reading_or_retrying() {
    for status in [301, 302, 307, 308, 401, 403, 429, 500, 502, 503] {
        let response = FakeResponse::json(json!({
            "error": FAKE_PROVIDER_SECRET,
            "location": "https://evil.invalid/credential-collector"
        }));
        let reads = response.reads.clone();
        let h = Harness::new(vec![Ok(FakeResponse { status, ..response })]);
        let error = h.execute().await.unwrap_err();
        assert!(matches!(error, AiError::Provider(n) if n == status));
        assert_sanitized(&error);
        h.assert_unknown();
        assert_eq!(reads.load(Ordering::SeqCst), 0);
        assert!(h.execute().await.is_err());
        assert_eq!(h.sends(), 1);
    }
}

#[tokio::test]
async fn connection_and_send_timeout_failures_retain_unknown_without_retry() {
    for failure in [
        SendFailure::Connect,
        SendFailure::Timeout,
        SendFailure::ConnectionReset,
    ] {
        let h = Harness::new(vec![Err(failure)]);
        let error = h.execute().await.unwrap_err();
        assert!(matches!(error, AiError::UnknownOutcome));
        assert_sanitized(&error);
        h.assert_unknown();
        assert!(h.execute().await.is_err());
        assert_eq!(h.sends(), 1);
    }
}

#[tokio::test]
async fn partial_body_read_failure_keeps_full_reservation() {
    let response = FakeResponse {
        status: 200,
        chunks: VecDeque::from([Ok(b"{\"usageMetadata\":".to_vec()), Err(())]),
        reads: Arc::new(AtomicUsize::new(0)),
        pause_on_read: None,
    };
    let h = Harness::new(vec![Ok(response)]);
    assert!(matches!(h.execute().await, Err(AiError::UnknownOutcome)));
    h.assert_unknown();
}

#[tokio::test]
async fn malformed_json_and_missing_usage_keep_full_reservation() {
    let mut no_usage = valid_response();
    no_usage.as_object_mut().unwrap().remove("usageMetadata");
    for body in [
        format!("{{ invalid JSON {FAKE_PROVIDER_SECRET}").into_bytes(),
        serde_json::to_vec(&no_usage).unwrap(),
        br#"{"usageMetadata":null}"#.to_vec(),
    ] {
        let h = Harness::new(vec![Ok(FakeResponse::bytes(200, body))]);
        let error = h.execute().await.unwrap_err();
        assert!(matches!(error, AiError::UnknownOutcome));
        assert_sanitized(&error);
        h.assert_unknown();
    }
}

#[tokio::test]
async fn malformed_usage_values_are_not_silently_priced_as_zero() {
    for field in [
        "promptTokenCount",
        "candidatesTokenCount",
        "thoughtsTokenCount",
    ] {
        for invalid in [
            json!(-1),
            json!(0.5),
            Value::Null,
            json!("10"),
            json!(false),
        ] {
            let mut response = valid_response();
            response["usageMetadata"][field] = invalid;
            let h = Harness::new(vec![Ok(FakeResponse::json(response))]);
            assert!(matches!(h.execute().await, Err(AiError::UnknownOutcome)));
            h.assert_unknown();
        }
    }
    let mut overflowing = valid_response();
    overflowing["usageMetadata"]["candidatesTokenCount"] = json!(u64::MAX);
    let h = Harness::new(vec![Ok(FakeResponse::json(overflowing))]);
    assert!(matches!(h.execute().await, Err(AiError::UnknownOutcome)));
    h.assert_unknown();
}

#[tokio::test]
async fn response_limit_applies_to_the_accumulated_body() {
    let mut exact = serde_json::to_vec(&valid_response()).unwrap();
    exact.resize(MAX_RESPONSE_BYTES, b' ');
    let h = Harness::new(vec![Ok(FakeResponse::bytes(200, exact))]);
    assert!(h.execute().await.unwrap().is_some());

    for chunks in [
        VecDeque::from([Ok(vec![b' '; MAX_RESPONSE_BYTES + 1])]),
        VecDeque::from([Ok(vec![b' '; MAX_RESPONSE_BYTES]), Ok(vec![b' '])]),
    ] {
        let h = Harness::new(vec![Ok(FakeResponse {
            status: 200,
            chunks,
            reads: Arc::new(AtomicUsize::new(0)),
            pause_on_read: None,
        })]);
        assert!(matches!(h.execute().await, Err(AiError::UnknownOutcome)));
        h.assert_unknown();
    }
}

#[tokio::test]
async fn invalid_output_with_valid_usage_settles_cost_and_requires_review() {
    let mut response = valid_response();
    response["candidates"][0]["finishReason"] = json!("MAX_TOKENS");
    let h = Harness::new(vec![Ok(FakeResponse::json(response))]);
    assert!(matches!(h.execute().await, Err(AiError::Invalid(_))));
    let summary = h.store.summary().unwrap();
    assert_eq!(summary.daily_actual_charged_microusd, 575);
    assert_eq!(summary.daily_held_microusd, 0);
    assert!(summary.unknown_attempts.is_empty());
    assert_eq!(h.store.quote(&h.quote.id).unwrap().state, "needs_review");
    assert!(h.store.response(&h.quote.id, 0).unwrap().is_none());
    assert!(h.execute().await.is_err());
    assert_eq!(h.sends(), 1);
}

#[tokio::test]
async fn structured_output_errors_do_not_expose_provider_controlled_content() {
    let mut response = valid_response();
    response["candidates"][0]["content"]["parts"][0]["text"] =
        json!(serde_json::to_string(&json!({"items": FAKE_PROVIDER_SECRET})).unwrap());
    let h = Harness::new(vec![Ok(FakeResponse::json(response))]);
    let error = h.execute().await.unwrap_err();
    assert!(matches!(error, AiError::Invalid(_)));
    assert_sanitized(&error);
    assert_eq!(
        h.store.summary().unwrap().daily_actual_charged_microusd,
        575
    );
    assert_eq!(h.store.quote(&h.quote.id).unwrap().state, "needs_review");
    assert!(h.store.response(&h.quote.id, 0).unwrap().is_none());
}

#[tokio::test]
async fn usage_above_reservation_records_actual_cost_and_stops_remaining_requests() {
    let mut response = valid_response();
    response["usageMetadata"]["candidatesTokenCount"] = json!(100_000);
    let actual = usage_cost(crate::VOCABULARY_MODEL, &response["usageMetadata"]).unwrap();
    let h = Harness::with_tasks(vec![task(), task()], vec![Ok(FakeResponse::json(response))]);
    assert!(h.execute().await.is_err());
    assert!(actual > h.quote.requests[0].estimated_max_microusd.unwrap());
    let quote = h.store.quote(&h.quote.id).unwrap();
    assert_eq!(quote.state, "needs_review");
    assert_eq!(quote.completed_requests, 1);
    assert_eq!(quote.remaining_ordinals, [1]);
    assert_eq!(
        h.store.summary().unwrap().daily_actual_charged_microusd,
        actual
    );
    assert!(h.execute().await.is_err());
    assert_eq!(h.sends(), 1);
}

fn checkpoint_and_park(marker: &std::path::Path) -> ! {
    use std::io::Write;
    let pending = marker.with_extension("part");
    let mut file = std::fs::File::create(&pending).unwrap();
    file.write_all(b"offline transport checkpoint\n").unwrap();
    file.sync_all().unwrap();
    drop(file);
    std::fs::rename(pending, marker).unwrap();
    loop {
        std::thread::park();
    }
}

/// Self-spawn helper. It is unreachable in production and does not open sockets.
/// Only the parent test supplies the temporary data location and checkpoint.
#[test]
#[ignore = "invoked by killed_worker_after_dispatch_retains_unknown_at_each_response_stage"]
fn crash_child_after_paid_dispatch() {
    let Some(directory) = std::env::var_os("SURTITLE_VERTEX_FAULT_CHILD_DIR") else {
        return;
    };
    let directory = PathBuf::from(directory);
    let stage = std::env::var("SURTITLE_VERTEX_FAULT_CHILD_STAGE").unwrap();
    assert!(["sent", "partial", "received"].contains(&stage.as_str()));
    let store = AiStore::open(directory.join("charges.sqlite")).unwrap();
    let job_id = std::fs::read_to_string(directory.join("job-id")).unwrap();
    let marker = directory.join("checkpoint");
    let bytes = serde_json::to_vec(&valid_response()).unwrap();
    let chunks = if stage == "partial" {
        let middle = bytes.len() / 2;
        VecDeque::from([Ok(bytes[..middle].to_vec()), Ok(bytes[middle..].to_vec())])
    } else {
        VecDeque::from([Ok(bytes)])
    };
    let response = FakeResponse {
        status: 200,
        chunks,
        reads: Arc::new(AtomicUsize::new(0)),
        // Partial: block before delivering chunk two. Received: block at EOF,
        // after the worker holds every byte but before it can parse or settle.
        pause_on_read: (stage != "sent").then_some((2, marker.clone())),
    };
    let events = Events::default();
    let auth = FakeAuthorization {
        fail: false,
        calls: AtomicUsize::new(0),
        events: events.clone(),
        hook: Mutex::new(None),
    };
    let transport = FakeTransport {
        db_path: directory.join("charges.sqlite"),
        requests: Mutex::new(vec![]),
        replies: Mutex::new(VecDeque::from([Ok(response)])),
        events,
        hook: Mutex::new(Some(Box::new(move || {
            use std::io::Write;
            let mut log = std::fs::OpenOptions::new()
                .append(true)
                .create(true)
                .open(directory.join("send-log"))
                .unwrap();
            log.write_all(b"send\n").unwrap();
            log.sync_all().unwrap();
            if stage == "sent" {
                checkpoint_and_park(&marker);
            }
        }))),
    };
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(execute_with_io(&store, &auth, &transport, &job_id, || {
            Ok(())
        }))
        .unwrap();
    panic!("The parent should kill the worker at its checkpoint");
}

#[tokio::test]
async fn killed_worker_after_dispatch_retains_unknown_at_each_response_stage() {
    use std::{process::Stdio, time::Instant};
    for stage in ["sent", "partial", "received"] {
        let h = Harness::new(vec![]);
        let directory = h._directory.path();
        std::fs::write(directory.join("job-id"), &h.quote.id).unwrap();
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "vertex::fault_tests::crash_child_after_paid_dispatch",
                "--ignored",
                "--nocapture",
            ])
            .env("SURTITLE_VERTEX_FAULT_CHILD_DIR", directory)
            .env("SURTITLE_VERTEX_FAULT_CHILD_STAGE", stage)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let mut child = command.spawn().unwrap();
        let deadline = Instant::now() + Duration::from_secs(20);
        let marker = directory.join("checkpoint");
        while !marker.exists() && Instant::now() < deadline {
            if child.try_wait().unwrap().is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let ready = marker.exists();
        let _ = child.kill();
        child.wait().unwrap();
        assert!(ready, "child did not reach the {stage} checkpoint");
        assert_eq!(
            std::fs::read_to_string(directory.join("send-log")).unwrap(),
            "send\n"
        );
        let reopened = AiStore::open(&h.transport.db_path).unwrap();
        assert_eq!(reopened.recover_interrupted().unwrap(), 1);
        let summary = reopened.summary().unwrap();
        assert_eq!(summary.daily_actual_charged_microusd, 0);
        assert_eq!(
            summary.daily_held_microusd,
            h.quote.estimated_max_microusd.unwrap()
        );
        assert_eq!(summary.unknown_attempts.len(), 1);
        assert_eq!(summary.unknown_attempts[0].state, "unknown");
        assert_eq!(reopened.quote(&h.quote.id).unwrap().state, "needs_review");
        assert!(reopened.response(&h.quote.id, 0).unwrap().is_none());
        assert!(
            execute_with_io(&reopened, &h.auth, &h.transport, &h.quote.id, || Ok(()))
                .await
                .is_err()
        );
        assert_eq!(h.auth.calls.load(Ordering::SeqCst), 0);
        assert_eq!(h.sends(), 0);
        assert_eq!(
            std::fs::read_to_string(directory.join("send-log")).unwrap(),
            "send\n"
        );
    }
}
