use super::*;
use std::{path::Path, sync::Arc, time::Duration};
use surtitle_ai::test_support::{Checkpoint, OfflineVertexService, Scenario, Stage};

struct Fixture {
    directory: tempfile::TempDir,
    state: AppState,
    quote: AiQuote,
    source_path: std::path::PathBuf,
    preparation_id: String,
}

impl Fixture {
    async fn new() -> Self {
        Self::prepare_and_quote(false).await
    }

    async fn prepare_and_quote(edit_before_quote: bool) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let state = Services::open(directory.path().to_path_buf()).unwrap();
        crate::application::transcript::fixtures::seed_fixture_data(&state).unwrap();
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
                    "transcription".into(),
                    crate::application::models::preference_for(&execution, true),
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
        // A fresh preparation identity ensures the production quote path creates
        // its own registered publication session rather than reusing a preset.
        let mut receipt = crate::application::transcript::fixtures::fixture_receipt(
            &state,
            "e2e-transcript-pending",
            &uuid::Uuid::new_v4().to_string(),
            false,
        )
        .unwrap();
        receipt.prepared_job = receipt
            .prepared_job
            .with_apply_policy(TranscriptApplyPolicy::Auto)
            .unwrap();
        surtitle_core::store::write_json_atomic(&receipt.directory.join("receipt.json"), &receipt)
            .unwrap();
        let immutable_receipt = std::fs::read(receipt.directory.join("receipt.json")).unwrap();
        if edit_before_quote {
            let mut edited = lock(&state.db)
                .unwrap()
                .segment("e2e-transcript-pending-old")
                .unwrap();
            edited.text = "Edited after audio preparation, before creating the quote.".into();
            crate::application::subtitles::edit_segment(state.clone(), edited).unwrap();
            assert_ne!(
                surtitle_core::store::subtitle_revision(
                    &lock(&state.db)
                        .unwrap()
                        .list_segments("e2e-transcript-pending")
                        .unwrap()
                )
                .unwrap(),
                receipt.prepared_job.binding.transcript_revision,
            );
        }
        let quote = crate::application::transcript::preparation::create_transcription_quote(
            state.clone(),
            receipt.id.clone(),
            None,
        )
        .await
        .unwrap();
        assert!(quote.can_approve, "{:?}", quote.blocked_reason);
        assert_eq!(quote.apply_policy, TranscriptApplyPolicy::Auto);
        assert_eq!(quote.request_count, 2);
        assert_eq!(
            std::fs::read(receipt.directory.join("receipt.json")).unwrap(),
            immutable_receipt
        );
        assert_eq!(
            state
                .ai
                .prepared_job(&quote.id)
                .unwrap()
                .binding
                .transcript_revision,
            receipt.prepared_job.binding.transcript_revision
        );
        assert!(
            lock(&state.db)
                .unwrap()
                .transcript_publication_exists(&quote.id, &quote.digest)
                .unwrap()
        );
        Self {
            directory,
            state,
            quote,
            source_path: receipt.source_path,
            preparation_id: receipt.id,
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

    fn approve_retries(&self, retry: bool) -> ApprovedExecution {
        approve_for_execution_with_retry(
            &self.state,
            &self.quote.id,
            &self.quote.digest,
            retry,
            false,
            true,
            Some(1),
        )
        .unwrap()
    }

    fn service(&self, scenario: Scenario) -> Arc<OfflineVertexService> {
        Arc::new(
            OfflineVertexService::new(self.state.ai.clone(), &self.quote.id, scenario).unwrap(),
        )
    }

    fn start(
        &self,
        plan: ApprovedExecution,
        service: Arc<OfflineVertexService>,
    ) -> tokio::task::JoinHandle<Result<()>> {
        tokio::spawn(run_approved_with(
            self.state.clone(),
            self.quote.id.clone(),
            plan,
            move |_| Ok(service),
        ))
    }

    fn rows(&self) -> Vec<surtitle_core::SubtitleSegment> {
        crate::application::subtitles::list_segments(
            self.state.clone(),
            self.quote.media_id.clone(),
        )
        .unwrap()
    }
}

#[tokio::test]
async fn queued_audio_replacement_stops_before_reservation_and_releases_the_lane() {
    let fixture = Fixture::new().await;
    let occupied = fixture
        .state
        .ai_session
        .dispatch
        .enqueue("other-request", true);
    let active = occupied.try_acquire().unwrap();
    let service = fixture.service(Scenario::Transcription);
    let approved = fixture.approve();
    let approval_id = approved.approval_id.clone();
    let baseline = serde_json::to_value(fixture.rows()).unwrap();
    let worker = fixture.start(approved, service.clone());
    tokio::time::timeout(Duration::from_secs(10), async {
        while !fixture
            .state
            .ai_session
            .dispatch
            .is_waiting(&fixture.quote.id)
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("audio worker must finish its initial hash and join the dispatch queue");
    assert!(service.sent_ordinals().is_empty());
    assert!(attempts(fixture.directory.path(), &fixture.quote.id).is_empty());

    // Preserve the path and file size: only source content changes during the
    // queue wait, so metadata/source-scope checks alone cannot catch this.
    let mut replacement = std::fs::read(&fixture.source_path).unwrap();
    let tail = replacement.last_mut().unwrap();
    *tail ^= 1;
    std::fs::write(&fixture.source_path, replacement).unwrap();
    drop(active);

    assert!(finished(worker).await.is_err());
    assert!(service.sent_ordinals().is_empty());
    assert!(attempts(fixture.directory.path(), &fixture.quote.id).is_empty());
    assert_eq!(
        fixture.state.ai.quote(&fixture.quote.id).unwrap().state,
        "needs_review"
    );
    assert_eq!(
        fixture
            .state
            .ai
            .job_issue(&fixture.quote.id)
            .unwrap()
            .unwrap()
            .phase,
        "source"
    );
    assert_eq!(serde_json::to_value(fixture.rows()).unwrap(), baseline);
    assert!(
        !fixture
            .state
            .ai_session
            .dispatch
            .is_waiting(&fixture.quote.id)
    );
    assert!(
        fixture
            .state
            .ai_session
            .dispatch
            .worker(&approval_id)
            .is_some()
    );
    let next = fixture
        .state
        .ai_session
        .dispatch
        .enqueue("next-request", true);
    assert!(next.try_acquire().is_some());
}

#[tokio::test]
async fn immutable_audio_preparation_uses_current_subtitles_at_quote_time_and_preserves_later_edits()
 {
    for edit_after_quote in [false, true] {
        let fixture = Fixture::prepare_and_quote(true).await;
        let mut baseline = fixture
            .rows()
            .into_iter()
            .find(|row| row.id == "e2e-transcript-pending-old")
            .unwrap();
        assert_eq!(
            baseline.text,
            "Edited after audio preparation, before creating the quote."
        );
        if edit_after_quote {
            baseline.text = "Human correction after the quote was created.".into();
            crate::application::subtitles::edit_segment(fixture.state.clone(), baseline.clone())
                .unwrap();
        }
        // Reopening the still-prepared quote must reuse its identity without
        // rebasing away an edit made after its publication session was created.
        let reused = crate::application::transcript::preparation::create_transcription_quote(
            fixture.state.clone(),
            fixture.preparation_id.clone(),
            None,
        )
        .await
        .unwrap();
        assert_eq!(
            (&reused.id, &reused.digest),
            (&fixture.quote.id, &fixture.quote.digest)
        );
        let service = fixture.service(Scenario::Transcription);
        finished(fixture.start(fixture.approve(), service.clone()))
            .await
            .unwrap();
        assert_eq!(service.sent_ordinals(), [0, 1]);
        let rows = fixture.rows();
        assert!(rows.iter().any(|row| row.text == "Goodbye."));
        if edit_after_quote {
            assert_eq!(
                serde_json::to_value(rows.iter().find(|row| row.id == baseline.id).unwrap())
                    .unwrap(),
                serde_json::to_value(&baseline).unwrap()
            );
            assert!(
                !rows.iter().any(|row| row.text == "Hello."),
                "The generated overlapping cue must not overwrite the later human correction"
            );
        } else {
            assert!(!rows.iter().any(|row| row.id == baseline.id));
            assert!(
                rows.iter().any(|row| row.text == "Hello."),
                "The current quote-time baseline may be replaced by the approved transcription"
            );
        }
        let paid = attempts(fixture.directory.path(), &fixture.quote.id);
        assert_eq!(paid.len(), 2);
        assert!(
            paid.iter()
                .all(|(_, _, state, cost)| state == "settled" && *cost == Some(440))
        );
    }
}

async fn reached(checkpoint: &mut Checkpoint) {
    tokio::time::timeout(Duration::from_secs(30), checkpoint.reached())
        .await
        .expect("transcription checkpoint timed out");
}

async fn finished(worker: tokio::task::JoinHandle<Result<()>>) -> Result<()> {
    tokio::time::timeout(Duration::from_secs(60), worker)
        .await
        .expect("transcription worker timed out")
        .expect("transcription worker panicked")
}

fn attempts(root: &Path, job: &str) -> Vec<(String, u32, String, Option<i64>)> {
    let connection = rusqlite::Connection::open(root.join("charges.sqlite")).unwrap();
    connection.prepare("SELECT id,ordinal,state,charged_microusd FROM ai_attempts WHERE job_id=? ORDER BY ordinal,created_at_ms").unwrap()
        .query_map([job], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))).unwrap()
        .collect::<rusqlite::Result<Vec<_>>>().unwrap()
}

async fn waiting(fixture: &Fixture, retry_number: u32) -> RetryStatus {
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            if let Some(retry) = fixture.state.ai.retry_status(&fixture.quote.id).unwrap()
                && retry.state == "waiting"
                && retry.retry_number == retry_number
            {
                return retry;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("worker should enter HTTP429 wait")
}

fn advance_to_retry(fixture: &Fixture, retry: &RetryStatus) {
    let next = chrono::DateTime::parse_from_rfc3339(retry.next_retry_at.as_ref().unwrap())
        .unwrap()
        .timestamp_millis();
    assert!(next > fixture.state.ai.now_ms());
    fixture.state.ai.set_test_time(next);
}

async fn advance_to_pacing(state: &AppState, job_id: &str, ordinal: u32) {
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            if let Some(pacing) = state.ai.pacing_status(job_id).unwrap()
                && pacing.ordinal == ordinal
            {
                let next =
                    chrono::DateTime::parse_from_rfc3339(pacing.next_send_at.as_ref().unwrap())
                        .unwrap()
                        .timestamp_millis();
                assert!(next > state.ai.now_ms());
                state.ai.set_test_time(next);
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("resumed request should retain its dispatch deadline");
}

async fn observed_cooldown(fixture: &Fixture, mut checkpoint: Checkpoint) {
    reached(&mut checkpoint).await;
    // Retain the final two seconds of an observed server cooldown. The first
    // response is in flight; freeze the ledger clock so slow settlement cannot
    // consume the wait before the test observes it. Advance it after assertions.
    let now = fixture.state.ai.now_ms();
    fixture.state.ai.set_test_time(now);
    let conn = rusqlite::Connection::open(fixture.directory.path().join("charges.sqlite")).unwrap();
    conn.execute(
        "UPDATE ai_transcription_pacing SET cooldown_until_ms=?",
        [now + 2_000],
    )
    .unwrap();
    checkpoint.resume();
}

#[tokio::test]
async fn normal_transcription_reaches_the_next_dispatch_without_a_fixed_wait() {
    let fixture = Fixture::new().await;
    let service = fixture.service(Scenario::Transcription);
    let mut checkpoint = service.checkpoint(Stage::BeforeDispatch, 1);
    let worker = fixture.start(fixture.approve_retries(false), service.clone());
    tokio::time::timeout(Duration::from_secs(5), checkpoint.reached())
        .await
        .unwrap();
    assert_eq!(service.sent_ordinals(), [0]);
    assert!(fixture.rows().iter().any(|row| row.text == "Hello."));
    assert!(
        fixture
            .state
            .ai
            .pacing_status(&fixture.quote.id)
            .unwrap()
            .is_none()
    );
    checkpoint.resume();
    finished(worker).await.unwrap();
    assert_eq!(service.sent_ordinals(), [0, 1]);
}

async fn pacing(fixture: &Fixture) -> PacingStatus {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(pacing) = fixture.state.ai.pacing_status(&fixture.quote.id).unwrap() {
                return pacing;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("worker should wait before reserving the next section")
}

#[tokio::test]
async fn observed_cooldown_waits_without_reserving_and_preserves_live_edits() {
    let fixture = Fixture::new().await;
    let service = fixture.service(Scenario::Transcription);
    let checkpoint = service.checkpoint(Stage::AfterSend, 0);
    let worker = fixture.start(fixture.approve_retries(false), service.clone());
    observed_cooldown(&fixture, checkpoint).await;
    let delay = pacing(&fixture).await;
    assert_eq!(delay.ordinal, 1);
    assert_eq!(delay.interval_ms, 0);
    assert!(delay.slowed);
    assert_eq!(service.sent_ordinals(), [0]);
    assert_eq!(
        attempts(fixture.directory.path(), &fixture.quote.id).len(),
        1
    );
    assert_eq!(fixture.state.ai.summary().unwrap().daily_held_microusd, 0);
    for locale in ["ja", "en"] {
        fixture
            .state
            .preferences
            .update(|p| {
                p.settings.locale = locale.into();
                Ok(())
            })
            .unwrap();
        let snapshot = super::super::snapshot::get_app_snapshot(fixture.state.clone()).unwrap();
        let job = snapshot
            .jobs
            .iter()
            .find(|job| job.id == fixture.quote.id)
            .unwrap();
        assert_eq!(job.status, "running");
        assert!(job.retry.is_none());
        assert_eq!(
            job.pacing.as_ref().unwrap().next_send_at,
            delay.next_send_at
        );
        assert!(!job.message.as_ref().unwrap().contains("429"));
    }
    let mut correction = fixture
        .rows()
        .into_iter()
        .find(|row| row.text == "Hello.")
        .unwrap();
    correction.text = "Human correction during observed server cooldown.".into();
    correction.status = "confirmed".into();
    crate::application::subtitles::edit_segment(fixture.state.clone(), correction.clone()).unwrap();
    advance_to_pacing(&fixture.state, &fixture.quote.id, 1).await;
    finished(worker).await.unwrap();
    assert_eq!(service.sent_ordinals(), [0, 1]);
    let conn = rusqlite::Connection::open(fixture.directory.path().join("charges.sqlite")).unwrap();
    let elapsed: i64 = conn
        .query_row(
            "SELECT MAX(dispatched_at_ms)-MIN(dispatched_at_ms) FROM ai_attempts WHERE job_id=?",
            [&fixture.quote.id],
            |row| row.get(0),
        )
        .unwrap();
    assert!(elapsed >= 2_000, "dispatches were only {elapsed}ms apart");
    assert_eq!(
        serde_json::to_value(
            fixture
                .rows()
                .iter()
                .find(|row| row.id == correction.id)
                .unwrap()
        )
        .unwrap(),
        serde_json::to_value(&correction).unwrap()
    );
    assert!(
        fixture
            .state
            .ai
            .pacing_status(&fixture.quote.id)
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn pause_cancel_or_reapproval_during_pacing_stops_the_old_worker() {
    for action in ["pause", "cancel", "reapprove"] {
        let fixture = Fixture::new().await;
        let service = fixture.service(Scenario::Transcription);
        let checkpoint = service.checkpoint(Stage::AfterSend, 0);
        let worker = fixture.start(fixture.approve_retries(false), service.clone());
        observed_cooldown(&fixture, checkpoint).await;
        let delay = pacing(&fixture).await;
        let before = attempts(fixture.directory.path(), &fixture.quote.id);
        if action == "cancel" {
            cancel_ai_job(fixture.state.clone(), fixture.quote.id.clone()).unwrap();
        } else {
            pause_ai_job(fixture.state.clone(), fixture.quote.id.clone()).unwrap();
            if action == "reapprove" {
                fixture.approve_retries(true);
                assert_eq!(
                    fixture
                        .state
                        .ai
                        .pacing_status(&fixture.quote.id)
                        .unwrap()
                        .unwrap()
                        .next_send_at,
                    delay.next_send_at
                );
            }
        }
        tokio::time::timeout(Duration::from_secs(2), worker)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(service.sent_ordinals(), [0]);
        assert_eq!(
            attempts(fixture.directory.path(), &fixture.quote.id),
            before
        );
        assert!(
            fixture
                .state
                .ai
                .job_issue(&fixture.quote.id)
                .unwrap()
                .is_none()
        );
    }
}

#[tokio::test]
async fn pacing_rechecks_budget_and_source_before_the_next_reservation() {
    for change_source in [false, true] {
        let fixture = Fixture::new().await;
        let service = fixture.service(Scenario::Transcription);
        let checkpoint = service.checkpoint(Stage::AfterSend, 0);
        let worker = fixture.start(fixture.approve_retries(false), service.clone());
        observed_cooldown(&fixture, checkpoint).await;
        pacing(&fixture).await;
        let before = attempts(fixture.directory.path(), &fixture.quote.id);
        if change_source {
            let db = lock(&fixture.state.db).unwrap();
            let mut media = db.media(&fixture.quote.media_id).unwrap();
            media.duration_ms = 7500;
            db.put_media(&media).unwrap();
        } else {
            fixture
                .state
                .ai
                .set_budget(BudgetLimits {
                    per_job_microusd: 440,
                    daily_microusd: 440,
                    monthly_microusd: 440,
                })
                .unwrap();
        }
        advance_to_pacing(&fixture.state, &fixture.quote.id, 1).await;
        let error = finished(worker).await.unwrap_err();
        if !change_source {
            assert!(matches!(
                error.downcast_ref::<AiError>(),
                Some(AiError::BudgetExceeded(_))
            ));
        }
        assert_eq!(service.sent_ordinals(), [0]);
        assert_eq!(
            attempts(fixture.directory.path(), &fixture.quote.id),
            before
        );
        assert!(fixture.rows().iter().any(|row| row.text == "Hello."));
        assert_eq!(
            fixture.state.ai.quote(&fixture.quote.id).unwrap().state,
            "needs_review"
        );
    }
}

#[tokio::test]
async fn http429_retries_only_failed_section_and_preserves_progressive_manual_edits() {
    let fixture = Fixture::new().await;
    fixture.state.ai.set_test_time(fixture.state.ai.now_ms());
    assert_eq!(fixture.quote.retry_policy.as_ref().unwrap().version, 1);
    assert_eq!(
        fixture.quote.maximum_request_count,
        fixture.quote.request_count * 3
    );
    assert_eq!(
        fixture.quote.maximum_send_duration_ms,
        fixture.quote.send_duration_ms * 3
    );
    assert_eq!(
        fixture.quote.maximum_total_output_tokens,
        fixture.quote.total_output_tokens * 3
    );
    assert!(
        (fixture.quote.maximum_usd.unwrap() - fixture.quote.estimated_usd.unwrap() * 3.).abs()
            < 1e-10
    );
    let service = fixture.service(Scenario::TranscriptionSecond429ThenSuccess);
    let worker = fixture.start(fixture.approve_retries(false), service.clone());
    let retry = waiting(&fixture, 1).await;
    assert_eq!(
        (retry.ordinal, retry.retry_number, retry.max_retries),
        (1, 1, 2)
    );
    assert_eq!(service.sent_ordinals(), [0, 1]);
    for locale in ["ja", "en"] {
        fixture
            .state
            .preferences
            .update(|p| {
                p.settings.locale = locale.into();
                Ok(())
            })
            .unwrap();
        let snapshot = super::super::snapshot::get_app_snapshot(fixture.state.clone()).unwrap();
        let job = snapshot
            .jobs
            .iter()
            .find(|job| job.id == fixture.quote.id)
            .unwrap();
        assert_eq!(job.status, "running");
        assert_eq!(job.retry.as_ref().unwrap().state, "waiting");
        assert!(job.message.as_ref().unwrap().contains("429"));
    }
    let mut corrected = fixture
        .rows()
        .into_iter()
        .find(|row| row.text == "Hello.")
        .unwrap();
    corrected.text = "Kept while waiting for HTTP 429.".into();
    corrected.status = "confirmed".into();
    crate::application::subtitles::edit_segment(fixture.state.clone(), corrected.clone()).unwrap();
    assert!(fixture.state.ai.summary().unwrap().daily_held_microusd > 0);
    let retained_spend = fixture
        .state
        .ai
        .quote(&fixture.quote.id)
        .unwrap()
        .already_charged_or_held_microusd;
    advance_to_retry(&fixture, &retry);
    tokio::time::timeout(Duration::from_secs(40), worker)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(service.sent_ordinals(), [0, 1, 1]);
    assert_eq!(
        fixture.state.ai.quote(&fixture.quote.id).unwrap().state,
        "completed"
    );
    assert_eq!(
        serde_json::to_value(
            fixture
                .rows()
                .iter()
                .find(|row| row.id == corrected.id)
                .unwrap()
        )
        .unwrap(),
        serde_json::to_value(&corrected).unwrap()
    );
    // The retained hold plus the new successful charge belongs to this job,
    // even if its retry deadline crosses a UTC day boundary.
    assert!(
        fixture
            .state
            .ai
            .quote(&fixture.quote.id)
            .unwrap()
            .already_charged_or_held_microusd
            > retained_spend
    );
    assert!(
        fixture
            .state
            .ai
            .summary()
            .unwrap()
            .unknown_attempts
            .is_empty()
    );
}

#[tokio::test]
async fn http429_exhaustion_stops_after_three_sends_and_retains_accounting() {
    let fixture = Fixture::new().await;
    fixture.state.ai.set_test_time(fixture.state.ai.now_ms());
    let service = fixture.service(Scenario::Transcription429Exhausted);
    let worker = fixture.start(fixture.approve_retries(false), service.clone());
    // Exercise both persisted retry deadlines without waiting for the real
    // 20/40-second backoffs. The same dispatch gate and worker still run.
    for retry_number in 1..=2 {
        let retry = waiting(&fixture, retry_number).await;
        assert_eq!(service.sent_ordinals(), vec![0; retry_number as usize]);
        advance_to_retry(&fixture, &retry);
    }
    let error = tokio::time::timeout(Duration::from_secs(90), worker)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert!(matches!(
        error.downcast_ref::<AiError>(),
        Some(AiError::Provider(429))
    ));
    assert_eq!(service.sent_ordinals(), [0, 0, 0]);
    let snapshot = super::super::snapshot::get_app_snapshot(fixture.state.clone()).unwrap();
    let job = snapshot
        .jobs
        .iter()
        .find(|job| job.id == fixture.quote.id)
        .unwrap();
    assert_eq!(job.status, "failed");
    assert_eq!(job.retry.as_ref().unwrap().state, "exhausted");
    assert_eq!(job.issue.as_ref().unwrap().http_status, Some(429));
    assert_eq!(job.issue.as_ref().unwrap().next_action, "resume");
    assert_eq!(
        attempts(fixture.directory.path(), &fixture.quote.id).len(),
        3
    );
    assert!(fixture.state.ai.summary().unwrap().daily_held_microusd > 0);
}

#[tokio::test]
async fn http429_retry_after_over_five_minutes_stops_and_reports_resume_time() {
    let fixture = Fixture::new().await;
    let service = fixture.service(Scenario::Transcription429Deferred);
    let before = chrono::Utc::now().timestamp_millis();
    let error = finished(fixture.start(fixture.approve_retries(false), service.clone()))
        .await
        .unwrap_err();
    assert!(matches!(
        error.downcast_ref::<AiError>(),
        Some(AiError::Provider(429))
    ));
    assert_eq!(service.sent_ordinals(), [0]);
    let retry = fixture
        .state
        .ai
        .retry_status(&fixture.quote.id)
        .unwrap()
        .unwrap();
    assert_eq!(retry.state, "deferred");
    assert!(
        chrono::DateTime::parse_from_rfc3339(retry.next_retry_at.as_ref().unwrap())
            .unwrap()
            .timestamp_millis()
            >= before + 301_000
    );
}

#[tokio::test]
async fn http429_pause_cancel_and_reapproval_stop_the_waiting_worker_without_resend() {
    for cancel in [false, true] {
        let fixture = Fixture::new().await;
        fixture.state.ai.set_test_time(fixture.state.ai.now_ms());
        // Reapproval includes a fresh worst-case scope plus the retained 429
        // hold. Give this lifecycle test room for both independent approvals.
        fixture
            .state
            .ai
            .set_budget(BudgetLimits {
                per_job_microusd: 10_000_000,
                daily_microusd: 10_000_000,
                monthly_microusd: 10_000_000,
            })
            .unwrap();
        let service = fixture.service(Scenario::Transcription429ThenSuccess);
        let worker = fixture.start(fixture.approve_retries(false), service.clone());
        waiting(&fixture, 1).await;
        let reapproved = if cancel {
            cancel_ai_job(fixture.state.clone(), fixture.quote.id.clone()).unwrap();
            None
        } else {
            pause_ai_job(fixture.state.clone(), fixture.quote.id.clone()).unwrap();
            Some(fixture.approve_retries(true))
        };
        let resumed = reapproved.map(|approved| {
            let service = fixture.service(Scenario::Transcription);
            let worker = fixture.start(approved, service.clone());
            (service, worker)
        });
        // The old approval must stop while its deadline is still in the future.
        finished(worker).await.unwrap();
        assert_eq!(service.sent_ordinals(), [0]);
        if let Some((resumed, worker)) = resumed {
            assert!(resumed.sent_ordinals().is_empty());
            for ordinal in 0..=1 {
                advance_to_pacing(&fixture.state, &fixture.quote.id, ordinal).await;
            }
            finished(worker).await.unwrap();
            assert_eq!(resumed.sent_ordinals(), [0, 1]);
        }
        assert!(
            fixture
                .state
                .ai
                .job_issue(&fixture.quote.id)
                .unwrap()
                .is_none()
        );
        assert_eq!(
            fixture.state.ai.quote(&fixture.quote.id).unwrap().state,
            if cancel { "cancelled" } else { "completed" }
        );
    }
}

#[tokio::test]
async fn simultaneous_workers_for_one_approval_do_not_overwrite_or_double_send() {
    let fixture = Fixture::new().await;
    let approved = fixture.approve_retries(false);
    let service = fixture.service(Scenario::Transcription);
    let mut checkpoint = service.checkpoint(Stage::BeforeDispatch, 0);
    let first = fixture.start(approved.clone(), service.clone());
    reached(&mut checkpoint).await;
    let second = fixture.start(approved, service.clone());
    finished(second).await.unwrap();
    assert!(service.sent_ordinals().is_empty());
    assert!(
        fixture
            .state
            .ai
            .job_issue(&fixture.quote.id)
            .unwrap()
            .is_none()
    );
    checkpoint.resume();
    finished(first).await.unwrap();
    assert_eq!(service.sent_ordinals(), [0, 1]);
}

#[tokio::test]
async fn in_flight_http429_does_not_hide_pause_or_cancellation_in_snapshot() {
    for cancel in [false, true] {
        let fixture = Fixture::new().await;
        let service = fixture.service(Scenario::Transcription429ThenSuccess);
        let mut checkpoint = service.checkpoint(Stage::AfterSend, 0);
        let worker = fixture.start(fixture.approve_retries(false), service.clone());
        reached(&mut checkpoint).await;
        if cancel {
            cancel_ai_job(fixture.state.clone(), fixture.quote.id.clone()).unwrap();
        } else {
            pause_ai_job(fixture.state.clone(), fixture.quote.id.clone()).unwrap();
        }
        checkpoint.resume();
        finished(worker).await.unwrap_err();
        assert_eq!(service.sent_ordinals(), [0]);
        for (locale, paused, cancelled) in [
            ("ja", "一時停止", "キャンセル"),
            ("en", "Paused", "Cancelled"),
        ] {
            fixture
                .state
                .preferences
                .update(|p| {
                    p.settings.locale = locale.into();
                    Ok(())
                })
                .unwrap();
            let snapshot = super::super::snapshot::get_app_snapshot(fixture.state.clone()).unwrap();
            let job = snapshot
                .jobs
                .iter()
                .find(|job| job.id == fixture.quote.id)
                .unwrap();
            assert_eq!(job.status, if cancel { "cancelled" } else { "paused" });
            assert!(job.message.as_ref().unwrap().starts_with(if cancel {
                cancelled
            } else {
                paused
            }));
        }
    }
}

#[tokio::test]
async fn legacy_approval_keeps_http429_unknown_without_automatic_retry() {
    let fixture = Fixture::new().await;
    let service = fixture.service(Scenario::Transcription429ThenSuccess);
    finished(fixture.start(fixture.approve(), service.clone()))
        .await
        .unwrap_err();
    assert_eq!(service.sent_ordinals(), [0]);
    assert_eq!(
        fixture.state.ai.summary().unwrap().unknown_attempts.len(),
        1
    );
    assert!(
        fixture
            .state
            .ai
            .retry_status(&fixture.quote.id)
            .unwrap()
            .is_none()
    );
    for (locale, acknowledgement) in [
        ("ja", "結果不明の要求を確認"),
        ("en", "Acknowledge the unknown request"),
    ] {
        fixture
            .state
            .preferences
            .update(|p| {
                p.settings.locale = locale.into();
                Ok(())
            })
            .unwrap();
        let snapshot = super::super::snapshot::get_app_snapshot(fixture.state.clone()).unwrap();
        let job = snapshot
            .jobs
            .iter()
            .find(|job| job.id == fixture.quote.id)
            .unwrap();
        assert_eq!(job.status, "unknown");
        assert!(job.message.as_ref().unwrap().contains(acknowledgement));
    }
}

#[tokio::test]
async fn restart_during_http429_wait_requires_reapproval_and_resumes_only_remaining_section() {
    let fixture = Fixture::new().await;
    let at = fixture.state.ai.now_ms();
    fixture.state.ai.set_test_time(at);
    let service = fixture.service(Scenario::TranscriptionSecond429ThenSuccess);
    let worker = fixture.start(fixture.approve_retries(false), service.clone());
    waiting(&fixture, 1).await;
    let before = attempts(fixture.directory.path(), &fixture.quote.id);
    assert_eq!(service.sent_ordinals(), [0, 1]);
    // Simulate process shutdown, including releasing the data-directory lock.
    worker.abort();
    assert!(worker.await.unwrap_err().is_cancelled());
    drop(service);
    let Fixture {
        directory,
        state,
        quote,
        ..
    } = fixture;
    drop(state);
    let reopened = Services::open(directory.path().to_path_buf()).unwrap();
    reopened.ai.set_test_time(at);
    assert_eq!(reopened.ai.quote(&quote.id).unwrap().state, "needs_review");
    assert_eq!(attempts(directory.path(), &quote.id), before);
    let quote = super::super::quotes::review_ai_job(reopened.clone(), quote.id).unwrap();
    assert!(quote.can_approve, "{:?}", quote.blocked_reason);
    assert_eq!(quote.request_count, 1);
    let approved = approve_for_execution_with_retry(
        &reopened,
        &quote.id,
        &quote.digest,
        true,
        false,
        true,
        Some(1),
    )
    .unwrap();
    let service = Arc::new(
        OfflineVertexService::new(reopened.ai.clone(), &quote.id, Scenario::Transcription).unwrap(),
    );
    let executor = service.clone();
    let state = reopened.clone();
    let job_id = quote.id.clone();
    let worker = tokio::spawn(async move {
        run_approved_with(state, job_id, approved, move |_| Ok(executor)).await
    });
    advance_to_pacing(&reopened, &quote.id, 1).await;
    finished(worker).await.unwrap();
    assert_eq!(service.sent_ordinals(), [1]);
    assert_eq!(reopened.ai.quote(&quote.id).unwrap().state, "completed");
}

#[tokio::test]
async fn transcription_worker_publishes_before_the_second_send_and_preserves_live_edits() {
    let fixture = Fixture::new().await;
    let service = fixture.service(Scenario::Transcription);
    let mut checkpoint = service.checkpoint(Stage::BeforeDispatch, 1);
    let worker = fixture.start(fixture.approve(), service.clone());
    reached(&mut checkpoint).await;
    assert_eq!(service.sent_ordinals(), [0]);
    let mut correction = fixture
        .rows()
        .into_iter()
        .find(|row| row.text == "Hello.")
        .unwrap();
    assert_eq!(correction.status, "generated");
    correction.text = "Edited during the running transcription.".into();
    correction.status = "confirmed".into();
    crate::application::subtitles::edit_segment(fixture.state.clone(), correction.clone()).unwrap();
    assert_eq!(
        fixture.state.ai.quote(&fixture.quote.id).unwrap().state,
        "approved"
    );
    checkpoint.resume();
    finished(worker).await.unwrap();
    assert_eq!(service.sent_ordinals(), [0, 1]);
    let rows = fixture.rows();
    assert_eq!(
        serde_json::to_value(rows.iter().find(|row| row.id == correction.id).unwrap()).unwrap(),
        serde_json::to_value(&correction).unwrap()
    );
    assert!(rows.iter().any(|row| row.text == "Goodbye."));
    assert!(
        fixture
            .state
            .ai
            .transcript_application_recorded(&fixture.quote.id, &fixture.quote.digest)
            .unwrap()
    );
    let paid = attempts(fixture.directory.path(), &fixture.quote.id);
    assert_eq!(paid.len(), 2);
    assert!(
        paid.iter()
            .all(|(_, _, state, cost)| state == "settled" && *cost == Some(440))
    );
    assert_eq!(fixture.state.ai.summary().unwrap().daily_held_microusd, 0);
    drop(service);
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
            crate::application::subtitles::list_segments(state.clone(), quote.media_id).unwrap()
        )
        .unwrap(),
        serde_json::to_value(rows).unwrap()
    );
    retry_ai_application(state.clone(), quote.id.clone()).unwrap();
    assert_eq!(attempts(directory.path(), &quote.id), paid);
    assert_eq!(state.ai.quote(&quote.id).unwrap().state, "completed");
}

#[tokio::test]
async fn timing_failure_publishes_full_text_and_does_not_stop_or_retry_the_next_request() {
    let fixture = Fixture::new().await;
    let service = fixture.service(Scenario::TranscriptionCoarseFirst);
    let mut checkpoint = service.checkpoint(Stage::BeforeDispatch, 1);
    let worker = fixture.start(fixture.approve(), service.clone());
    reached(&mut checkpoint).await;
    assert_eq!(service.sent_ordinals(), [0]);
    let rows = fixture.rows();
    let coarse = rows
        .iter()
        .find(|row| row.timing_precision == "source_block")
        .unwrap();
    assert_eq!((coarse.start_ms, coarse.end_ms), (0, 7000));
    assert_eq!(coarse.text, "Hello. No, no.");
    assert_eq!(coarse.status, "generated");
    let ParsedOutput::Transcript { cues } = fixture
        .state
        .ai
        .response(&fixture.quote.id, 0)
        .unwrap()
        .unwrap()
    else {
        panic!("transcript expected")
    };
    assert_eq!(cues[0].timing_precision, "source_block");
    assert!(cues[0].word_anchors.is_empty());
    assert_eq!(
        fixture.state.ai.quote(&fixture.quote.id).unwrap().state,
        "approved"
    );
    checkpoint.resume();
    finished(worker).await.unwrap();
    assert_eq!(service.sent_ordinals(), [0, 1]);
    assert!(fixture.rows().iter().any(|row| row.text == "Goodbye."));
    assert!(
        fixture
            .rows()
            .iter()
            .any(|row| row.text == "Hello. No, no." && row.end_ms == 7000)
    );
    let paid = attempts(fixture.directory.path(), &fixture.quote.id);
    assert_eq!(paid.len(), 2);
    assert!(
        paid.iter()
            .all(|(_, _, state, cost)| state == "settled" && *cost == Some(440))
    );
    assert_eq!(
        fixture
            .state
            .ai
            .quote(&fixture.quote.id)
            .unwrap()
            .completed_requests,
        2
    );
    assert!(
        fixture
            .state
            .ai
            .job_issue(&fixture.quote.id)
            .unwrap()
            .is_none()
    );
    drop(service);
    let Fixture {
        directory,
        state,
        quote,
        ..
    } = fixture;
    drop(state);
    let state = Services::open(directory.path().to_path_buf()).unwrap();
    retry_ai_application(state, quote.id.clone()).unwrap();
    assert_eq!(attempts(directory.path(), &quote.id), paid);
}

#[tokio::test]
async fn relinking_after_send_retains_settled_text_and_stops_the_second_request() {
    let fixture = Fixture::new().await;
    let service = fixture.service(Scenario::Transcription);
    let mut checkpoint = service.checkpoint(Stage::AfterSend, 0);
    let worker = fixture.start(fixture.approve(), service.clone());
    reached(&mut checkpoint).await;
    let replacement = fixture.directory.path().join("replacement.wav");
    std::fs::copy(&fixture.source_path, &replacement).unwrap();
    {
        let db = lock(&fixture.state.db).unwrap();
        let mut media = db.media(&fixture.quote.media_id).unwrap();
        media.path = replacement.to_string_lossy().into_owned();
        db.put_media(&media).unwrap();
    }
    checkpoint.resume();
    assert!(finished(worker).await.is_err());
    assert_eq!(service.sent_ordinals(), [0]);
    let paid = attempts(fixture.directory.path(), &fixture.quote.id);
    assert_eq!(paid.len(), 1);
    assert_eq!((&paid[0].2, paid[0].3), (&"settled".to_owned(), Some(440)));
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
    assert_eq!(fixture.rows()[0].text, "Original subtitle");
    assert_eq!(
        fixture.state.ai.quote(&fixture.quote.id).unwrap().state,
        "needs_review"
    );
    assert!(retry_ai_application(fixture.state.clone(), fixture.quote.id.clone()).is_err());
    assert_eq!(attempts(fixture.directory.path(), &fixture.quote.id), paid);
}

#[tokio::test]
async fn restoring_subtitles_with_the_same_audio_stops_the_remaining_paid_dispatch() {
    let fixture = Fixture::new().await;
    let source_bytes = std::fs::read(&fixture.source_path).unwrap();
    let original_media = lock(&fixture.state.db)
        .unwrap()
        .media(&fixture.quote.media_id)
        .unwrap();
    let service = fixture.service(Scenario::Transcription);
    let mut checkpoint = service.checkpoint(Stage::BeforeDispatch, 1);
    let worker = fixture.start(fixture.approve(), service.clone());
    reached(&mut checkpoint).await;
    assert_eq!(service.sent_ordinals(), [0]);
    assert!(fixture.rows().iter().any(|row| row.text == "Hello."));
    let received = serde_json::to_value(
        fixture
            .state
            .ai
            .response(&fixture.quote.id, 0)
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    let first_attempt = attempts(fixture.directory.path(), &fixture.quote.id)[0].clone();
    assert_eq!(
        (first_attempt.1, first_attempt.2.as_str(), first_attempt.3),
        (0, "settled", Some(440))
    );
    let version = lock(&fixture.state.db)
        .unwrap()
        .subtitle_versions(&fixture.quote.media_id)
        .unwrap()
        .remove(0);
    crate::application::subtitles::restore_subtitle_version(
        fixture.state.clone(),
        fixture.quote.media_id.clone(),
        version.id,
    )
    .unwrap();
    let restored = serde_json::to_value(fixture.rows()).unwrap();
    assert_eq!(fixture.rows()[0].text, "Original subtitle");
    let current_media = lock(&fixture.state.db)
        .unwrap()
        .media(&fixture.quote.media_id)
        .unwrap();
    assert_eq!(
        (
            &current_media.path,
            &current_media.learning_language,
            current_media.audio_stream_index
        ),
        (
            &original_media.path,
            &original_media.learning_language,
            original_media.audio_stream_index
        )
    );
    assert_eq!(std::fs::read(&fixture.source_path).unwrap(), source_bytes);
    checkpoint.resume();
    assert!(finished(worker).await.is_err());
    assert_eq!(
        service.sent_ordinals(),
        [0],
        "Detaching publication must revoke further paid sends even when the audio binding still matches"
    );
    assert_eq!(serde_json::to_value(fixture.rows()).unwrap(), restored);
    assert_eq!(
        serde_json::to_value(
            fixture
                .state
                .ai
                .response(&fixture.quote.id, 0)
                .unwrap()
                .unwrap()
        )
        .unwrap(),
        received
    );
    assert!(
        fixture
            .state
            .ai
            .response(&fixture.quote.id, 1)
            .unwrap()
            .is_none()
    );
    let paid = attempts(fixture.directory.path(), &fixture.quote.id);
    assert_eq!(paid.len(), 2);
    assert_eq!(paid[0], first_attempt);
    assert_eq!(
        (paid[1].1, paid[1].2.as_str(), paid[1].3),
        (1, "released", Some(0))
    );
    let connection =
        rusqlite::Connection::open(fixture.directory.path().join("charges.sqlite")).unwrap();
    let dispatched: Option<i64> = connection
        .query_row(
            "SELECT dispatched_at_ms FROM ai_attempts WHERE id=?",
            [&paid[1].0],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(dispatched, None);
    let summary = fixture.state.ai.summary().unwrap();
    assert_eq!(summary.daily_actual_charged_microusd, 440);
    assert_eq!(summary.daily_held_microusd, 0);
    assert!(
        approve_for_execution(
            &fixture.state,
            &fixture.quote.id,
            &fixture.quote.digest,
            true,
            false,
            true
        )
        .is_err()
    );
    assert_eq!(attempts(fixture.directory.path(), &fixture.quote.id), paid);
    assert_eq!(serde_json::to_value(fixture.rows()).unwrap(), restored);
}

#[tokio::test]
async fn shorter_media_duration_stops_dispatch_beyond_the_current_source_scope() {
    let fixture = Fixture::new().await;
    let service = fixture.service(Scenario::Transcription);
    let mut checkpoint = service.checkpoint(Stage::BeforeDispatch, 1);
    let worker = fixture.start(fixture.approve(), service.clone());
    reached(&mut checkpoint).await;
    assert_eq!(service.sent_ordinals(), [0]);
    let published = serde_json::to_value(fixture.rows()).unwrap();
    assert!(fixture.rows().iter().any(|row| row.text == "Hello."));
    let first_response = serde_json::to_value(
        fixture
            .state
            .ai
            .response(&fixture.quote.id, 0)
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    let first_attempt = attempts(fixture.directory.path(), &fixture.quote.id)[0].clone();
    let source_bytes = std::fs::read(&fixture.source_path).unwrap();
    {
        let db = lock(&fixture.state.db).unwrap();
        let mut media = db.media(&fixture.quote.media_id).unwrap();
        assert_eq!(media.duration_ms, 8000);
        // Request 0 ends at 7000; request 1 is frozen through 8000. Metadata
        // correction alone makes only the remaining request exceed the source.
        media.duration_ms = 7500;
        db.put_media(&media).unwrap();
        assert!(
            db.transcript_publication_active(&fixture.quote.id, &fixture.quote.digest)
                .unwrap(),
            "This exercises the source-range guard rather than publication detachment"
        );
    }
    assert_eq!(std::fs::read(&fixture.source_path).unwrap(), source_bytes);
    checkpoint.resume();
    let error = finished(worker).await.unwrap_err();
    assert!(
        error.to_string().contains("current media duration"),
        "{error:#}"
    );
    assert_eq!(service.sent_ordinals(), [0]);
    assert_eq!(serde_json::to_value(fixture.rows()).unwrap(), published);
    assert_eq!(
        serde_json::to_value(
            fixture
                .state
                .ai
                .response(&fixture.quote.id, 0)
                .unwrap()
                .unwrap()
        )
        .unwrap(),
        first_response
    );
    assert!(
        fixture
            .state
            .ai
            .response(&fixture.quote.id, 1)
            .unwrap()
            .is_none()
    );
    let paid = attempts(fixture.directory.path(), &fixture.quote.id);
    assert_eq!(paid.len(), 2);
    assert_eq!(paid[0], first_attempt);
    assert_eq!(
        (paid[0].1, paid[0].2.as_str(), paid[0].3),
        (0, "settled", Some(440))
    );
    assert_eq!(
        (paid[1].1, paid[1].2.as_str(), paid[1].3),
        (1, "released", Some(0))
    );
    let connection =
        rusqlite::Connection::open(fixture.directory.path().join("charges.sqlite")).unwrap();
    let dispatched: Option<i64> = connection
        .query_row(
            "SELECT dispatched_at_ms FROM ai_attempts WHERE id=?",
            [&paid[1].0],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(dispatched, None);
    let summary = fixture.state.ai.summary().unwrap();
    assert_eq!(summary.daily_actual_charged_microusd, 440);
    assert_eq!(summary.daily_held_microusd, 0);
    assert_eq!(
        fixture.state.ai.quote(&fixture.quote.id).unwrap().state,
        "needs_review"
    );
}
