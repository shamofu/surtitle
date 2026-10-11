//! The actual native loop with deterministic, independently settled text requests.
use super::*;
use std::sync::{Arc, Mutex};
use surtitle_core::{Media, SubtitleSegment};

struct Fixture {
    _directory: tempfile::TempDir,
    state: AppState,
    quote: AiQuote,
}

impl Fixture {
    async fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let state = Services::open(directory.path().to_path_buf()).unwrap();
        let execution = crate::application::models::fixture_execution();
        state
            .preferences
            .update(|preferences| {
                preferences.credential_id = Some("offline-key".into());
                preferences.settings.credential_configured = true;
                preferences.settings.vertex_project = "offline-vocabulary".into();
                preferences.settings.vertex_location = "global".into();
                preferences.settings.ai_models.insert(
                    "vocabulary".into(),
                    crate::application::models::preference_for(&execution, false),
                );
                Ok(())
            })
            .unwrap();
        let cues = (0..121)
            .map(|index| SubtitleSegment {
                id: format!("cue-{index}"),
                media_id: "vocabulary".into(),
                start_ms: index * 1000,
                end_ms: (index + 1) * 1000,
                text: format!("Sentence {index}."),
                translation: None,
                status: "confirmed".into(),
                timing_precision: "cue".into(),
                review_issues: vec![],
            })
            .collect::<Vec<_>>();
        {
            let mut db = lock(&state.db).unwrap();
            db.put_media(&Media {
                id: "vocabulary".into(),
                title: "Vocabulary batches".into(),
                path: directory
                    .path()
                    .join("unused.mp4")
                    .to_string_lossy()
                    .into_owned(),
                source_url: None,
                kind: "video".into(),
                duration_ms: 121_000,
                learning_language: "en".into(),
                explanation_language: "ja".into(),
                created_at: surtitle_core::now(),
                last_position_ms: 0,
                segment_count: 121,
                card_count: 0,
                status: "ready".into(),
                error: None,
                audio_stream_index: Some(0),
                subtitle_stream_index: None,
            })
            .unwrap();
            db.set_segments("vocabulary", &cues).unwrap();
        }
        let quote = create_quote(
            state.clone(),
            QuoteRequest {
                media_id: "vocabulary".into(),
                kind: "vocabulary".into(),
                start_ms: 0,
                end_ms: 121_000,
                focus_term: None,
                model: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(quote.request_count, 3);
        Self {
            _directory: directory,
            state,
            quote,
        }
    }

    async fn run(&self, rejected: Vec<u32>, stop: Option<&'static str>) -> (Result<()>, Vec<u32>) {
        let approved = approve_for_execution(
            &self.state,
            &self.quote.id,
            &self.quote.digest,
            false,
            false,
            true,
        )
        .unwrap();
        let sent = Arc::new(Mutex::new(Vec::new()));
        let executor = Executor {
            state: self.state.clone(),
            rejected,
            sent: sent.clone(),
            stop,
        };
        let result = run_approved_with(self.state.clone(), self.quote.id.clone(), approved, |_| {
            Ok(executor)
        })
        .await;
        let requests = sent.lock().unwrap().clone();
        (result, requests)
    }
}

struct Executor {
    state: AppState,
    rejected: Vec<u32>,
    sent: Arc<Mutex<Vec<u32>>>,
    stop: Option<&'static str>,
}

impl JobExecutor for Executor {
    async fn execute_next_with_guard(
        &self,
        job_id: &str,
        approval_id: &str,
        mut before_send: impl FnMut() -> surtitle_ai::Result<()> + Send,
    ) -> surtitle_ai::Result<Option<ExecutionResult>> {
        let Some(request) = self.state.ai.reserve_next_scoped(job_id, approval_id)? else {
            return Ok(None);
        };
        before_send()?;
        self.state.ai.validate_dispatch(&request)?;
        self.sent.lock().unwrap().push(request.ordinal);
        if self.stop == Some("unknown") {
            self.state.ai.mark_unknown(&request.attempt_id)?;
            return Err(AiError::UnknownOutcome);
        }
        let usage = serde_json::json!({"promptTokenCount":10,"candidatesTokenCount":
            if self.stop == Some("output_cap") { request.execution.max_output_tokens + 1 } else { 10 }});
        if self.rejected.contains(&request.ordinal) {
            self.state.ai.settle_rejected(
                &request,
                Some(if self.stop == Some("reserve_overrun") {
                    request.reserved_microusd.unwrap() + 1
                } else {
                    42
                }),
                &usage,
                OutputFailureReason::InvalidSource,
            )?;
            if self.stop == Some("source") {
                let db = self.state.db.lock().unwrap();
                let mut cue = db.segment("cue-0").unwrap();
                cue.text = "Edited after the first response.".into();
                db.edit_segment(&cue).unwrap();
            }
            if self.stop == Some("budget") {
                self.state.ai.set_budget(BudgetLimits {
                    per_job_microusd: 1,
                    daily_microusd: 1,
                    monthly_microusd: 1,
                })?;
            }
            return Err(AiError::OutputRejected(OutputFailureReason::InvalidSource));
        }
        let output = ParsedOutput::Vocabulary { items: vec![] };
        self.state
            .ai
            .settle(&request.attempt_id, 42, &usage, Some(&output), None)?;
        Ok(Some(ExecutionResult {
            job_id: job_id.into(),
            ordinal: request.ordinal,
            attempt_id: request.attempt_id,
            charged_microusd: Some(42),
            output,
        }))
    }
}

#[tokio::test]
async fn vocabulary_worker_finishes_every_independent_batch_once() {
    for rejected in [vec![1], vec![0], vec![2], vec![0, 1, 2], vec![]] {
        let fixture = Fixture::new().await;
        let (result, sent) = fixture.run(rejected.clone(), None).await;
        result.unwrap();
        assert_eq!(sent, [0, 1, 2]);
        let quote = fixture.state.ai.quote(&fixture.quote.id).unwrap();
        assert_eq!(quote.request_counts.rejected, rejected.len() as u32);
        assert_eq!(quote.request_counts.succeeded, 3 - rejected.len() as u32);
        assert_eq!(quote.request_counts.pending, 0);
        assert_eq!(
            fixture
                .state
                .ai
                .summary()
                .unwrap()
                .monthly_actual_charged_microusd,
            126
        );
        let snapshot = super::super::snapshot::get_app_snapshot(fixture.state.clone()).unwrap();
        let job = snapshot.jobs.iter().find(|job| job.id == quote.id).unwrap();
        assert_eq!(job.progress, 1.0);
        assert_eq!(
            job.execution_outcome.as_deref(),
            Some(if rejected.is_empty() {
                "complete"
            } else if rejected.len() == 3 {
                "failed"
            } else {
                "partial"
            })
        );
        assert_eq!(
            job.status,
            if rejected.is_empty() {
                "completed"
            } else {
                "failed"
            }
        );
    }
}

#[tokio::test]
async fn vocabulary_worker_stops_for_source_budget_and_unknown_outcome() {
    for stop in [
        "source",
        "budget",
        "unknown",
        "output_cap",
        "reserve_overrun",
    ] {
        let fixture = Fixture::new().await;
        let (result, sent) = fixture.run(vec![0], Some(stop)).await;
        assert!(result.is_err(), "{stop}");
        assert_eq!(sent, [0], "{stop}");
        let snapshot = super::super::snapshot::get_app_snapshot(fixture.state.clone()).unwrap();
        let job = snapshot
            .jobs
            .iter()
            .find(|job| job.id == fixture.quote.id)
            .unwrap();
        assert_eq!(job.execution_outcome.as_deref(), Some("stopped"), "{stop}");
        assert!(job.request_counts.pending > 0);
    }
}
