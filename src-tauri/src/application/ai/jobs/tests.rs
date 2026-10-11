use super::*;
use std::{path::Path, sync::Arc, time::Duration};
use surtitle_ai::test_support::{Checkpoint, OfflineVertexService, Scenario, Stage};
use surtitle_core::{Media, SubtitleSegment};

impl JobExecutor for Arc<OfflineVertexService> {
    async fn execute_next_with_guard(
        &self,
        job_id: &str,
        approval_id: &str,
        before_send: impl FnMut() -> surtitle_ai::Result<()> + Send,
    ) -> surtitle_ai::Result<Option<ExecutionResult>> {
        self.as_ref()
            .execute_next_scoped_with_guard(job_id, approval_id, before_send)
            .await
    }
}

struct Fixture {
    directory: tempfile::TempDir,
    state: AppState,
    quote: AiQuote,
}

impl Fixture {
    async fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let state = Services::open(directory.path().to_path_buf()).unwrap();
        let mut execution = crate::application::models::fixture_execution();
        execution.price.as_mut().unwrap().observed_at_ms = chrono::Utc::now().timestamp_millis();
        state
            .preferences
            .update(|preferences| {
                preferences.credential_id = Some("offline-app-credential".into());
                preferences.settings.credential_configured = true;
                preferences.settings.vertex_project = "offline-app-project".into();
                preferences.settings.vertex_location = "global".into();
                preferences.settings.ai_models.insert(
                    "translation".into(),
                    crate::application::models::preference_for(&execution, false),
                );
                Ok(())
            })
            .unwrap();
        state
            .ai
            .set_budget(BudgetLimits {
                per_job_microusd: 1_000_000,
                daily_microusd: 1_000_000,
                monthly_microusd: 1_000_000,
            })
            .unwrap();
        let cues = (0..31)
            .map(|index| SubtitleSegment {
                timing_precision: "cue".into(),
                id: format!("fixture-cue-{index:02}"),
                media_id: "offline-app-media".into(),
                start_ms: index * 1000,
                end_ms: (index + 1) * 1000,
                text: format!("Source sentence {index:02}."),
                translation: None,
                status: "confirmed".into(),
                review_issues: vec![],
            })
            .collect::<Vec<_>>();
        {
            let mut db = lock(&state.db).unwrap();
            db.put_media(&Media {
                id: "offline-app-media".into(),
                title: "Offline application integration".into(),
                path: directory
                    .path()
                    .join("unused-text-source.wav")
                    .to_string_lossy()
                    .into_owned(),
                source_url: None,
                kind: "audio".into(),
                duration_ms: 31_000,
                learning_language: "en".into(),
                explanation_language: "ja".into(),
                created_at: surtitle_core::now(),
                last_position_ms: 0,
                segment_count: 31,
                card_count: 0,
                status: "ready".into(),
                error: None,
                audio_stream_index: Some(0),
                subtitle_stream_index: None,
            })
            .unwrap();
            db.set_segments("offline-app-media", &cues).unwrap();
        }
        let quote = create_quote(
            state.clone(),
            QuoteRequest {
                media_id: "offline-app-media".into(),
                kind: "translate".into(),
                start_ms: 0,
                end_ms: 31_000,
                focus_term: None,
                model: None,
            },
        )
        .await
        .unwrap();
        assert!(quote.can_approve, "{:?}", quote.blocked_reason);
        assert_eq!(quote.request_count, 2);
        Self {
            directory,
            state,
            quote,
        }
    }

    fn approve(&self) -> ApprovedExecution {
        approve_for_execution(
            &self.state,
            &self.quote.id,
            &self.quote.digest,
            false,
            false,
            true,
        )
        .unwrap()
    }

    fn offline(&self, scenario: Scenario) -> Arc<OfflineVertexService> {
        Arc::new(
            OfflineVertexService::new(self.state.ai.clone(), &self.quote.id, scenario).unwrap(),
        )
    }

    fn start(
        &self,
        plan: ApprovedExecution,
        service: Arc<OfflineVertexService>,
    ) -> tokio::task::JoinHandle<Result<()>> {
        let state = self.state.clone();
        let id = self.quote.id.clone();
        tokio::spawn(run_approved_with(state, id, plan, move |_| Ok(service)))
    }

    fn connection(&self) -> rusqlite::Connection {
        rusqlite::Connection::open(self.directory.path().join("charges.sqlite")).unwrap()
    }

    fn assert_attempts(&self, expected: &[&str]) {
        let conn = self.connection();
        let mut statement = conn
            .prepare("SELECT state FROM ai_attempts ORDER BY ordinal,created_at_ms")
            .unwrap();
        let actual = statement
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(actual, expected);
    }

    fn translations(&self) -> Vec<Option<String>> {
        lock(&self.state.db)
            .unwrap()
            .list_segments("offline-app-media")
            .unwrap()
            .into_iter()
            .map(|cue| cue.translation)
            .collect()
    }

    fn edit_source(&self) {
        let db = lock(&self.state.db).unwrap();
        let mut cue = db.segment("fixture-cue-00").unwrap();
        cue.text = "Source changed while execution was waiting.".into();
        db.edit_segment(&cue).unwrap();
    }
}

#[tokio::test]
async fn queued_quote_reopens_with_same_identity_and_refreshes_only_after_expiry() {
    let fixture = Fixture::new().await;
    let original = fixture.state.ai.quote(&fixture.quote.id).unwrap();
    let first =
        super::super::quotes::review_ai_job(fixture.state.clone(), fixture.quote.id.clone())
            .unwrap();
    assert_eq!(first.id, original.id);
    assert_eq!(first.digest, original.digest);
    assert!(!first.is_retry);
    assert_eq!(
        fixture
            .state
            .ai
            .quote(&first.id)
            .unwrap()
            .quote_expires_at_ms,
        original.quote_expires_at_ms
    );
    fixture
        .connection()
        .execute(
            "UPDATE ai_jobs SET quote_expires_at_ms=0 WHERE id=?",
            [&first.id],
        )
        .unwrap();
    let refreshed =
        super::super::quotes::review_ai_job(fixture.state.clone(), first.id.clone()).unwrap();
    assert_eq!(refreshed.id, original.id);
    assert_eq!(refreshed.digest, original.digest);
    assert!(!refreshed.is_retry);
    assert!(refreshed.can_approve);
    fixture.assert_attempts(&[]);
    assert_eq!(fixture.state.ai.list_jobs().unwrap().len(), 1);
}

async fn reached(checkpoint: &mut Checkpoint) {
    tokio::time::timeout(Duration::from_secs(10), checkpoint.reached())
        .await
        .expect("worker checkpoint timed out");
}

async fn finished(worker: tokio::task::JoinHandle<Result<()>>) -> Result<()> {
    tokio::time::timeout(Duration::from_secs(10), worker)
        .await
        .expect("worker completion timed out")
        .expect("worker panicked")
}

fn assert_applied(state: &AppState, job: &str, ordinal: u32) {
    let output = state.ai.response(job, ordinal).unwrap().unwrap();
    let digest = sha256_bytes(&serde_json::to_vec(&output).unwrap());
    assert!(
        lock(&state.db)
            .unwrap()
            .ai_result_applied(job, ordinal, &digest)
            .unwrap()
    );
}

fn attempt_snapshot(root: &Path) -> Vec<(String, u32, String, Option<i64>)> {
    let connection = rusqlite::Connection::open(root.join("charges.sqlite")).unwrap();
    connection
        .prepare("SELECT id,ordinal,state,charged_microusd FROM ai_attempts ORDER BY ordinal,created_at_ms")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap()
}

#[tokio::test]
async fn approved_batches_use_the_real_worker_and_persist_each_application_once() {
    let fixture = Fixture::new().await;
    let service = fixture.offline(Scenario::Translation);
    finished(fixture.start(fixture.approve(), service.clone()))
        .await
        .unwrap();
    assert_eq!(service.sent_ordinals(), [0, 1]);
    fixture.assert_attempts(&["settled", "settled"]);
    assert_eq!(
        fixture.state.ai.quote(&fixture.quote.id).unwrap().state,
        "completed"
    );
    assert_eq!(
        fixture.translations(),
        (0..31)
            .map(|index| Some(format!("固定の翻訳 {index:02}。")))
            .collect::<Vec<_>>()
    );
    let spend = fixture.state.ai.summary().unwrap();
    assert_eq!(spend.daily_actual_charged_microusd, 880);
    assert_eq!(spend.daily_held_microusd, 0);
    for ordinal in 0..2 {
        assert_applied(&fixture.state, &fixture.quote.id, ordinal);
    }
    let attempts = attempt_snapshot(fixture.directory.path());
    let sent = service.sent_ordinals();
    drop(service);
    let Fixture {
        directory,
        state,
        quote,
    } = fixture;
    drop(state);
    let reopened = Services::open(directory.path().to_path_buf()).unwrap();
    for ordinal in 0..2 {
        assert_applied(&reopened, &quote.id, ordinal);
    }
    super::super::results::apply_saved_ai_result(reopened.clone(), quote.id.clone(), 0).unwrap();
    assert_eq!(
        reopened.ai.summary().unwrap().daily_actual_charged_microusd,
        880
    );
    assert_eq!(sent, [0, 1]);
    assert_eq!(attempt_snapshot(directory.path()), attempts);
}

#[tokio::test]
async fn another_job_can_start_during_a_request_and_gets_the_next_dispatch_turn() {
    let fixture = Fixture::new().await;
    let bulk = fixture.offline(Scenario::Translation);
    let mut first = bulk.checkpoint(Stage::AfterSend, 0);
    let bulk_worker = fixture.start(fixture.approve(), bulk.clone());
    reached(&mut first).await;
    let quote = create_quote(
        fixture.state.clone(),
        QuoteRequest {
            media_id: "offline-app-media".into(),
            kind: "translate".into(),
            start_ms: 0,
            end_ms: 1000,
            focus_term: None,
            model: None,
        },
    )
    .await
    .unwrap();
    let approved =
        approve_for_execution(&fixture.state, &quote.id, &quote.digest, false, false, true)
            .unwrap();
    let interactive = Arc::new(
        OfflineVertexService::new(
            fixture.state.ai.clone(),
            &quote.id,
            Scenario::SingleTranslation,
        )
        .unwrap(),
    );
    let mut second = interactive.checkpoint(Stage::AfterSend, 0);
    let state = fixture.state.clone();
    let job_id = quote.id.clone();
    let service = interactive.clone();
    let interactive_worker = tokio::spawn(run_approved_with(state, job_id, approved, move |_| {
        Ok(service)
    }));
    tokio::time::timeout(Duration::from_secs(10), async {
        while !fixture.state.ai_session.dispatch.is_waiting(&quote.id) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(interactive.sent_ordinals().is_empty());
    assert_eq!(fixture.state.ai.quote(&quote.id).unwrap().state, "approved");
    assert!(fixture.state.ai.job_issue(&quote.id).unwrap().is_none());
    first.resume();
    reached(&mut second).await;
    assert_eq!(bulk.sent_ordinals(), [0]);
    second.resume();
    finished(interactive_worker).await.unwrap();
    finished(bulk_worker).await.unwrap();
    assert_eq!(interactive.sent_ordinals(), [0]);
    assert_eq!(bulk.sent_ordinals(), [0, 1]);
    assert_eq!(
        fixture.state.ai.summary().unwrap().unknown_attempts.len(),
        0
    );
}

#[tokio::test]
async fn queued_pause_cancel_or_new_unknown_outcome_never_dispatches_waiting_work() {
    for stop in ["pause", "cancel", "unknown"] {
        let fixture = Fixture::new().await;
        let bulk = fixture.offline(if stop == "unknown" {
            Scenario::SendFailure
        } else {
            Scenario::Translation
        });
        let mut sent = bulk.checkpoint(Stage::AfterSend, 0);
        let bulk_worker = fixture.start(fixture.approve(), bulk.clone());
        reached(&mut sent).await;
        let quote = create_quote(
            fixture.state.clone(),
            QuoteRequest {
                media_id: "offline-app-media".into(),
                kind: "translate".into(),
                start_ms: 0,
                end_ms: 1000,
                focus_term: None,
                model: None,
            },
        )
        .await
        .unwrap();
        let approved =
            approve_for_execution(&fixture.state, &quote.id, &quote.digest, false, false, true)
                .unwrap();
        let service = Arc::new(
            OfflineVertexService::new(
                fixture.state.ai.clone(),
                &quote.id,
                Scenario::SingleTranslation,
            )
            .unwrap(),
        );
        let state = fixture.state.clone();
        let job_id = quote.id.clone();
        let executor = service.clone();
        let waiting = tokio::spawn(run_approved_with(state, job_id, approved, move |_| {
            Ok(executor)
        }));
        tokio::time::timeout(Duration::from_secs(10), async {
            while !fixture.state.ai_session.dispatch.is_waiting(&quote.id) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        match stop {
            "pause" => fixture.state.ai.pause(&quote.id).unwrap(),
            "cancel" => fixture.state.ai.cancel(&quote.id).unwrap(),
            _ => {}
        }
        sent.resume();
        let result = finished(waiting).await;
        let bulk_result = finished(bulk_worker).await;
        assert!(service.sent_ordinals().is_empty(), "{stop}");
        assert!(!fixture.state.ai_session.dispatch.is_waiting(&quote.id));
        assert_eq!(
            fixture
                .state
                .ai
                .quote(&quote.id)
                .unwrap()
                .request_counts
                .in_flight,
            0
        );
        if stop == "unknown" {
            assert!(result.is_err());
            assert!(bulk_result.is_err());
            let summary = fixture.state.ai.summary().unwrap();
            assert_eq!(summary.unknown_attempts.len(), 1);
            assert!(summary.daily_held_microusd > 0);
            assert_eq!(
                fixture.state.ai.job_issue(&quote.id).unwrap().unwrap().code,
                "unknown_outcome"
            );
        } else {
            result.unwrap();
            bulk_result.unwrap();
            assert!(fixture.state.ai.job_issue(&quote.id).unwrap().is_none());
        }
    }
}

#[tokio::test]
async fn simultaneous_approvals_start_only_one_worker() {
    let fixture = Fixture::new().await;
    let barrier = Arc::new(std::sync::Barrier::new(3));
    let workers = (0..2)
        .map(|_| {
            let barrier = barrier.clone();
            let state = fixture.state.clone();
            let id = fixture.quote.id.clone();
            let digest = fixture.quote.digest.clone();
            std::thread::spawn(move || {
                barrier.wait();
                approve_for_execution(&state, &id, &digest, false, false, true)
            })
        })
        .collect::<Vec<_>>();
    barrier.wait();
    let mut accepted = workers
        .into_iter()
        .filter_map(|worker| worker.join().unwrap().ok())
        .collect::<Vec<_>>();
    assert_eq!(accepted.len(), 1);
    fixture.assert_attempts(&[]);
    let service = fixture.offline(Scenario::Translation);
    finished(fixture.start(accepted.pop().unwrap(), service.clone()))
        .await
        .unwrap();
    assert_eq!(service.sent_ordinals(), [0, 1]);
    fixture.assert_attempts(&["settled", "settled"]);
}

#[tokio::test]
async fn recovered_and_superseded_worker_cannot_publish_response_or_failure() {
    for scenario in [Scenario::Translation, Scenario::SendFailure] {
        let fixture = Fixture::new().await;
        let service = fixture.offline(scenario);
        let mut checkpoint = service.checkpoint(Stage::AfterSend, 0);
        let old = fixture.start(fixture.approve(), service.clone());
        reached(&mut checkpoint).await;
        assert_eq!(fixture.state.ai.recover_interrupted().unwrap(), 1);
        let attempt = fixture.state.ai.summary().unwrap().unknown_attempts[0]
            .id
            .clone();
        fixture.state.ai.acknowledge_unknown(&attempt).unwrap();
        let approved = approve_for_execution(
            &fixture.state,
            &fixture.quote.id,
            &fixture.quote.digest,
            true,
            false,
            true,
        )
        .unwrap();
        let before = attempt_snapshot(fixture.directory.path());
        checkpoint.resume();
        finished(old).await.unwrap();
        assert_eq!(attempt_snapshot(fixture.directory.path()), before);
        assert!(
            fixture
                .state
                .ai
                .job_issue(&fixture.quote.id)
                .unwrap()
                .is_none()
        );
        assert!(
            fixture
                .state
                .ai
                .response(&fixture.quote.id, 0)
                .unwrap()
                .is_none()
        );
        assert_eq!(
            fixture.state.ai.quote(&fixture.quote.id).unwrap().state,
            "approved"
        );
        let resumed = fixture.offline(Scenario::Translation);
        finished(fixture.start(approved, resumed.clone()))
            .await
            .unwrap();
        assert_eq!(resumed.sent_ordinals(), [0, 1]);
        assert_eq!(service.sent_ordinals(), [0]);
    }
}

#[tokio::test]
async fn reapproval_clears_old_preview_before_worker_start_even_if_history_write_fails() {
    for history_write_fails in [false, true] {
        let fixture = Fixture::new().await;
        if history_write_fails {
            std::fs::write(
                fixture.directory.path().join("ai-progress"),
                b"not a directory",
            )
            .unwrap();
        }
        let published = Arc::new(std::sync::Mutex::new(Vec::new()));
        let publications = published.clone();
        super::super::runtime::install_publisher(&fixture.state, move |snapshot| {
            publications
                .lock()
                .unwrap()
                .push(serde_json::to_value(snapshot).unwrap());
        })
        .unwrap();
        let original = fixture.approve();
        let observer = super::super::runtime::observer(fixture.state.clone());
        let old_event = surtitle_ai::ExecutionEvent {
            job_id: fixture.quote.id.clone(),
            approval_id: Some(original.approval_id.clone()),
            attempt_id: "preceding-attempt".into(),
            ordinal: 0,
            stage: surtitle_ai::ExecutionStage::Receiving,
            text_delta: Some("{\"translations\":[{\"text\":\"old preview\"".into()),
            http_status: Some(200),
            rejection_reason: None,
        };
        observer(old_event.clone());
        let snapshot = || {
            serde_json::to_value(
                super::super::runtime::get_ai_runtime(
                    fixture.state.clone(),
                    fixture.quote.id.clone(),
                )
                .unwrap(),
            )
            .unwrap()
        };
        let before = snapshot();
        assert!(
            before["preview"]["text"]
                .as_str()
                .unwrap()
                .contains("old preview")
        );
        fixture.state.ai.pause(&fixture.quote.id).unwrap();
        let renewed = approve_for_execution(
            &fixture.state,
            &fixture.quote.id,
            &fixture.quote.digest,
            true,
            false,
            true,
        )
        .unwrap();
        assert_ne!(original.approval_id, renewed.approval_id);
        fixture.assert_attempts(&[]);
        let after = snapshot();
        assert_eq!(after["approvalId"], renewed.approval_id);
        assert!(after.get("preview").is_none());
        assert!(after["revision"].as_u64().unwrap() > before["revision"].as_u64().unwrap());
        let last = after["events"].as_array().unwrap().last().unwrap();
        assert_eq!(last["phase"], "preparing");
        assert!(last.get("attemptId").is_none());
        assert_eq!(published.lock().unwrap().last().unwrap(), &after);
        // A late callback from the preceding approval cannot restore its text.
        observer(old_event);
        assert_eq!(snapshot(), after);
        assert_eq!(
            fixture.state.ai.quote(&fixture.quote.id).unwrap().state,
            "approved"
        );
    }
}

#[tokio::test]
async fn duplicate_busy_worker_does_not_publish_a_false_runtime_stop() {
    let fixture = Fixture::new().await;
    let service = fixture.offline(Scenario::Translation);
    let mut checkpoint = service.checkpoint(Stage::AfterSend, 0);
    let approved = fixture.approve();
    let duplicate = approved.clone();
    let approval_id = approved.approval_id.clone();
    let worker = fixture.start(approved, service.clone());
    reached(&mut checkpoint).await;
    let attempt = fixture.state.ai.summary().unwrap().unknown_attempts[0]
        .id
        .clone();
    super::super::runtime::observer(fixture.state.clone())(surtitle_ai::ExecutionEvent {
        job_id: fixture.quote.id.clone(),
        approval_id: Some(approval_id),
        attempt_id: attempt,
        ordinal: 0,
        stage: surtitle_ai::ExecutionStage::Receiving,
        text_delta: Some("{\"translations\":[".into()),
        http_status: Some(200),
        rejection_reason: None,
    });
    let snapshot = || {
        serde_json::to_value(
            super::super::runtime::get_ai_runtime(fixture.state.clone(), fixture.quote.id.clone())
                .unwrap(),
        )
        .unwrap()
    };
    let before = snapshot();
    finished(fixture.start(duplicate, service.clone()))
        .await
        .unwrap();
    assert_eq!(
        snapshot(),
        before,
        "a busy duplicate cannot terminate another worker's preview"
    );
    assert_eq!(
        fixture.state.ai.quote(&fixture.quote.id).unwrap().state,
        "approved"
    );
    assert_eq!(service.sent_ordinals(), [0]);
    checkpoint.resume();
    finished(worker).await.unwrap();
    assert_eq!(service.sent_ordinals(), [0, 1]);
    let after = snapshot();
    let events = after["events"].as_array().unwrap();
    assert_eq!(events.last().unwrap()["phase"], "completed");
    assert!(!events.iter().any(|event| event["phase"] == "stopped"));
}

#[tokio::test]
async fn source_or_settings_change_during_auth_prevents_the_first_send() {
    for change_settings in [false, true] {
        let fixture = Fixture::new().await;
        let service = fixture.offline(Scenario::Translation);
        let mut checkpoint = service.checkpoint(Stage::BeforeDispatch, 0);
        let worker = fixture.start(fixture.approve(), service.clone());
        reached(&mut checkpoint).await;
        fixture.assert_attempts(&["reserved"]);
        if change_settings {
            fixture
                .state
                .preferences
                .update(|preferences| {
                    preferences.settings.vertex_project = "changed-project".into();
                    Ok(())
                })
                .unwrap();
        } else {
            fixture.edit_source();
        }
        checkpoint.resume();
        assert!(finished(worker).await.is_err());
        assert!(service.sent_ordinals().is_empty());
        fixture.assert_attempts(&["released"]);
        assert_eq!(
            fixture.state.ai.quote(&fixture.quote.id).unwrap().state,
            "needs_review"
        );
        assert!(fixture.translations().iter().all(Option::is_none));
        let spend = fixture.state.ai.summary().unwrap();
        assert_eq!(
            (
                spend.daily_actual_charged_microusd,
                spend.daily_held_microusd
            ),
            (0, 0)
        );
    }
}

#[tokio::test]
async fn source_change_after_send_retains_paid_response_and_stops_the_next_batch() {
    let fixture = Fixture::new().await;
    let service = fixture.offline(Scenario::Translation);
    let mut checkpoint = service.checkpoint(Stage::AfterSend, 0);
    let worker = fixture.start(fixture.approve(), service.clone());
    reached(&mut checkpoint).await;
    fixture.edit_source();
    checkpoint.resume();
    assert!(finished(worker).await.is_err());
    assert_eq!(service.sent_ordinals(), [0]);
    fixture.assert_attempts(&["settled"]);
    assert_eq!(
        fixture
            .state
            .ai
            .summary()
            .unwrap()
            .daily_actual_charged_microusd,
        440
    );
    assert_eq!(
        fixture.state.ai.quote(&fixture.quote.id).unwrap().state,
        "needs_review"
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
            .is_none()
    );
    assert!(fixture.translations().iter().all(Option::is_none));
    assert!(
        super::super::results::apply_saved_ai_result(
            fixture.state.clone(),
            fixture.quote.id.clone(),
            0
        )
        .is_err()
    );
}

#[tokio::test]
async fn failed_application_rolls_back_then_recovers_without_resending_paid_output() {
    let fixture = Fixture::new().await;
    let service = fixture.offline(Scenario::Translation);
    let mut checkpoint = service.checkpoint(Stage::AfterSend, 0);
    let worker = fixture.start(fixture.approve(), service.clone());
    reached(&mut checkpoint).await;
    let connection =
        rusqlite::Connection::open(fixture.directory.path().join("learning.sqlite")).unwrap();
    connection.execute_batch("CREATE TRIGGER reject_translation BEFORE UPDATE ON segments WHEN NEW.id='fixture-cue-01' BEGIN SELECT RAISE(ABORT, 'translation fixture failure'); END;").unwrap();
    checkpoint.resume();
    assert!(finished(worker).await.is_err());
    assert_eq!(service.sent_ordinals(), [0]);
    fixture.assert_attempts(&["settled"]);
    let issue = fixture
        .state
        .ai
        .job_issue(&fixture.quote.id)
        .unwrap()
        .unwrap();
    assert_eq!(issue.phase, "apply");
    assert_eq!(issue.ordinal, None);
    assert_eq!(
        fixture.state.ai.quote(&fixture.quote.id).unwrap().state,
        "needs_review"
    );
    assert!(fixture.translations().iter().all(Option::is_none));
    let response = fixture
        .state
        .ai
        .response(&fixture.quote.id, 0)
        .unwrap()
        .unwrap();
    let hash = sha256_bytes(&serde_json::to_vec(&response).unwrap());
    assert!(
        !lock(&fixture.state.db)
            .unwrap()
            .ai_result_applied(&fixture.quote.id, 0, &hash)
            .unwrap()
    );
    connection
        .execute_batch("DROP TRIGGER reject_translation;")
        .unwrap();
    drop(connection);
    let attempts = attempt_snapshot(fixture.directory.path());
    let sent = service.sent_ordinals();
    drop(service);
    let Fixture {
        directory,
        state,
        quote,
    } = fixture;
    drop(state);
    let reopened = Services::open(directory.path().to_path_buf()).unwrap();
    let issue = reopened.ai.job_issue(&quote.id).unwrap().unwrap();
    assert_eq!(issue.code, "local_apply");
    assert_eq!(issue.next_action, "retry_local");
    retry_ai_application(reopened.clone(), quote.id.clone()).unwrap();
    retry_ai_application(reopened.clone(), quote.id.clone()).unwrap();
    assert!(reopened.ai.job_issue(&quote.id).unwrap().is_none());
    assert_applied(&reopened, &quote.id, 0);
    assert_eq!(
        reopened.ai.summary().unwrap().daily_actual_charged_microusd,
        440
    );
    assert_eq!(sent, [0]);
    assert_eq!(attempt_snapshot(directory.path()), attempts);
    let retry =
        super::super::quotes::create_retry_quote(reopened.clone(), quote.id.clone()).unwrap();
    assert_eq!(retry.request_count, 1);
    let plan =
        approve_for_execution(&reopened, &retry.id, &retry.digest, true, false, true).unwrap();
    let retry_service = Arc::new(
        OfflineVertexService::new(reopened.ai.clone(), &retry.id, Scenario::Translation).unwrap(),
    );
    let executor = retry_service.clone();
    run_approved_with(reopened.clone(), retry.id.clone(), plan, move |_| {
        Ok(executor)
    })
    .await
    .unwrap();
    assert_eq!(retry_service.sent_ordinals(), [1]);
    assert_eq!(
        reopened.ai.summary().unwrap().daily_actual_charged_microusd,
        880
    );
    assert_eq!(reopened.ai.quote(&retry.id).unwrap().state, "completed");
    assert_applied(&reopened, &retry.id, 1);
    let retried_attempts = attempt_snapshot(directory.path());
    assert_eq!(retried_attempts.len(), 2);
    assert_eq!(retried_attempts[0], attempts[0]);
    assert_eq!(retried_attempts[1].1, 1);
}

#[tokio::test]
async fn pause_and_cancel_after_send_keep_settlement_without_sending_the_next_batch() {
    for cancelled in [false, true] {
        let fixture = Fixture::new().await;
        let service = fixture.offline(Scenario::Translation);
        let mut checkpoint = service.checkpoint(Stage::AfterSend, 0);
        let worker = fixture.start(fixture.approve(), service.clone());
        reached(&mut checkpoint).await;
        if cancelled {
            cancel_ai_job(fixture.state.clone(), fixture.quote.id.clone()).unwrap();
        } else {
            pause_ai_job(fixture.state.clone(), fixture.quote.id.clone()).unwrap();
        }
        checkpoint.resume();
        finished(worker).await.unwrap();
        assert_eq!(service.sent_ordinals(), [0]);
        fixture.assert_attempts(&["settled"]);
        assert_eq!(
            fixture.state.ai.quote(&fixture.quote.id).unwrap().state,
            if cancelled { "cancelled" } else { "paused" }
        );
        assert_eq!(
            fixture
                .state
                .ai
                .summary()
                .unwrap()
                .daily_actual_charged_microusd,
            440
        );
        assert_applied(&fixture.state, &fixture.quote.id, 0);
        assert!(fixture.translations()[30].is_none());
    }
}

#[tokio::test]
async fn unknown_send_outcome_holds_the_reservation_and_never_sends_another_batch() {
    let fixture = Fixture::new().await;
    let service = fixture.offline(Scenario::SendFailure);
    assert!(
        finished(fixture.start(fixture.approve(), service.clone()))
            .await
            .is_err()
    );
    assert_eq!(service.sent_ordinals(), [0]);
    fixture.assert_attempts(&["unknown"]);
    assert_eq!(
        fixture.state.ai.quote(&fixture.quote.id).unwrap().state,
        "needs_review"
    );
    let summary = fixture.state.ai.summary().unwrap();
    assert_eq!(summary.daily_actual_charged_microusd, 0);
    assert!(summary.daily_held_microusd > 0);
    assert_eq!(summary.unknown_attempts.len(), 1);
    let issue = fixture
        .state
        .ai
        .job_issue(&fixture.quote.id)
        .unwrap()
        .unwrap();
    assert_eq!(issue.code, "unknown_outcome");
    assert_eq!(issue.phase, "execute");
    assert_eq!(issue.ordinal, Some(0));
    assert!(fixture.translations().iter().all(Option::is_none));
    assert!(
        fixture
            .state
            .ai
            .response(&fixture.quote.id, 0)
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn executor_initialization_failure_does_not_leave_an_idle_approved_job() {
    let fixture = Fixture::new().await;
    let plan = fixture.approve();
    let result = run_approved_with::<Arc<OfflineVertexService>>(
        fixture.state.clone(),
        fixture.quote.id.clone(),
        plan,
        |_| anyhow::bail!("offline factory failure"),
    )
    .await;
    assert_eq!(result.unwrap_err().to_string(), "offline factory failure");
    assert_eq!(
        fixture
            .state
            .ai
            .job_issue(&fixture.quote.id)
            .unwrap()
            .unwrap()
            .ordinal,
        None
    );
    fixture.assert_attempts(&[]);
    assert_eq!(
        fixture.state.ai.quote(&fixture.quote.id).unwrap().state,
        "needs_review"
    );
}
