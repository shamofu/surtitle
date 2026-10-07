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

    fn approve(&self) -> PreparedJob {
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

    fn service(&self, scenario: Scenario) -> Arc<OfflineVertexService> {
        Arc::new(
            OfflineVertexService::new(self.state.ai.clone(), &self.quote.id, scenario).unwrap(),
        )
    }

    fn start(
        &self,
        plan: PreparedJob,
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
    tokio::time::timeout(Duration::from_secs(10), checkpoint.reached())
        .await
        .expect("transcription checkpoint timed out");
}

async fn finished(worker: tokio::task::JoinHandle<Result<()>>) -> Result<()> {
    tokio::time::timeout(Duration::from_secs(10), worker)
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
