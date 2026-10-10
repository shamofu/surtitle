use super::*;
use crate::{AudioAttachment, BudgetLimits, JobQuote, ParsedOutput, ReservedRequest};

struct Fixture {
    directory: tempfile::TempDir,
    store: AiStore,
    quote: JobQuote,
    approval: String,
}

impl Fixture {
    fn new(count: usize) -> Self {
        let (directory, store) = super::super::tests::store();
        store
            .set_budget(BudgetLimits {
                per_job_microusd: 100_000_000,
                daily_microusd: 100_000_000,
                monthly_microusd: 100_000_000,
            })
            .unwrap();
        let source = super::super::tests::plan();
        let path = directory.path().join("audio.wav");
        std::fs::write(&path, b"offline fixture").unwrap();
        let requests = (0..count)
            .map(|ordinal| RequestTask::TranscribePreview {
                language: "en".into(),
                audio: AudioAttachment::from_file(path.clone(), ordinal as u64 * 1000, 1000)
                    .unwrap(),
            })
            .collect();
        let plan = PreparedJob::fixture(
            source.title,
            source.project_id,
            source.credential_id,
            source.binding,
            requests,
        );
        let quote = store.prepare(plan).unwrap();
        let approval = store
            .approve_scope_with_retry(&quote.id, &quote.digest, false, true, Some(1))
            .unwrap();
        Self {
            directory,
            store,
            quote,
            approval,
        }
    }

    fn send(&self) -> ReservedRequest {
        loop {
            match self
                .store
                .reserve_next_scoped(&self.quote.id, &self.approval)
            {
                Err(AiError::PacingWaiting(at) | AiError::RetryWaiting(at)) => {
                    self.store.set_test_time(at)
                }
                Ok(Some(reservation)) => {
                    self.store.validate_dispatch(&reservation).unwrap();
                    return reservation;
                }
                other => panic!("unexpected reservation: {other:?}"),
            }
        }
    }

    fn settle(&self, reservation: &ReservedRequest) {
        self.store
            .settle(
                &reservation.attempt_id,
                1,
                &serde_json::json!({}),
                Some(&ParsedOutput::Transcript { cues: vec![] }),
                None,
            )
            .unwrap();
    }

    fn lane(&self) -> (i64, i64, i64) {
        self.store
            .connect()
            .unwrap()
            .query_row(
                "SELECT interval_ms,success_streak,cooldown_until_ms FROM ai_transcription_pacing",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap()
    }

    fn counts(&self) -> (i64, i64) {
        let conn = self.store.connect().unwrap();
        (
            conn.query_row("SELECT COUNT(*) FROM ai_attempts", [], |row| row.get(0))
                .unwrap(),
            conn.query_row(
                "SELECT SUM(attempts_started) FROM ai_approval_requests",
                [],
                |row| row.get(0),
            )
            .unwrap(),
        )
    }

    fn other_job(
        &self,
        project: Option<&str>,
        model: Option<&str>,
        location: Option<&str>,
    ) -> (JobQuote, String) {
        let mut plan = self.store.prepared_job(&self.quote.id).unwrap();
        plan.title.push_str(" other");
        plan.credential_id = "different-key-same-lane".into();
        if let Some(project) = project {
            plan.project_id = project.into();
        }
        let mut execution = plan.execution.clone();
        if let Some(model) = model {
            execution.model_id = model.into();
        }
        if let Some(location) = location {
            execution.location = location.into();
        }
        let quote = self
            .store
            .prepare(plan.with_execution(execution).unwrap())
            .unwrap();
        let approval = self
            .store
            .approve_scope_with_retry(&quote.id, &quote.digest, false, true, Some(1))
            .unwrap();
        (quote, approval)
    }
}

#[test]
fn normal_spacing_is_between_dispatch_starts_and_waiting_has_no_financial_effect() {
    let f = Fixture::new(2);
    let at = f.store.now_ms();
    let first = f.send();
    assert!(
        f.store.pacing_status(&f.quote.id).unwrap().is_none(),
        "already sent is not waiting"
    );
    f.store.set_test_time(at + 2_000);
    f.settle(&first);
    let before = serde_json::to_value(f.store.summary().unwrap()).unwrap();
    let counts = f.counts();
    let status = f.store.pacing_status(&f.quote.id).unwrap().unwrap();
    assert_eq!(status.ordinal, 1);
    assert_eq!(status.interval_ms, 10_000);
    assert!(!status.slowed);
    for now in [at + 2_000, at + 9_999] {
        f.store.set_test_time(now);
        assert!(
            matches!(f.store.reserve_next_scoped(&f.quote.id,&f.approval),Err(AiError::PacingWaiting(next)) if next==at+10_000)
        );
        assert_eq!(f.counts(), counts);
        assert_eq!(
            serde_json::to_value(f.store.summary().unwrap()).unwrap(),
            before
        );
    }
    f.store.set_test_time(at + 10_000);
    let next = f.send();
    assert_eq!(next.ordinal, 1);
    f.settle(&next);
    assert_eq!(f.store.quote(&f.quote.id).unwrap().completed_requests, 2);
    assert_eq!(f.store.summary().unwrap().daily_actual_charged_microusd, 2);
    assert_eq!(f.store.summary().unwrap().daily_held_microusd, 0);
}

#[test]
fn rejection_slows_subsequent_chunks_and_three_successes_recover_gradually() {
    let f = Fixture::new(40);
    for interval in [20_000, 40_000, 60_000, 60_000] {
        let first = f.send();
        let rejected_at = f.store.now_ms();
        let retry = f
            .store
            .handle_429_at(&first, None, f.store.now_ms(), 0)
            .unwrap();
        assert_eq!(retry.state, "waiting");
        assert_eq!(f.lane(), (interval, 0, rejected_at + interval));
        let status = f.store.pacing_status(&f.quote.id).unwrap().unwrap();
        assert_eq!(status.interval_ms, interval as u64);
        assert!(status.slowed);
        let retry = f.send();
        assert_eq!(retry.ordinal, first.ordinal);
        f.settle(&retry);
        assert_eq!(
            f.lane().0,
            interval,
            "one success must not reset the interval"
        );
        assert_eq!(f.lane().1, 1);
    }
    for expected in (10_000..=55_000).rev().step_by(5_000) {
        let needed = 3 - f.lane().1;
        for _ in 0..needed {
            let sent = f.send();
            f.settle(&sent);
        }
        assert_eq!((f.lane().0, f.lane().1), (expected, 0));
    }
    for _ in 0..3 {
        let sent = f.send();
        f.settle(&sent);
    }
    assert_eq!(f.lane().0, 10_000);
    assert_eq!(f.store.summary().unwrap().unknown_attempts.len(), 0);
    assert_eq!(
        f.store.summary().unwrap().daily_held_microusd,
        4 * f.quote.requests[0].estimated_max_microusd.unwrap()
    );
}

#[test]
fn shared_lane_survives_new_jobs_and_keys_but_other_projects_models_regions_are_isolated() {
    for (project, model, location) in [
        (None, None, None),
        (Some("another-project"), None, None),
        (None, Some("another-model"), None),
        (None, None, Some("us-central1")),
    ] {
        let f = Fixture::new(1);
        let first = f.send();
        f.settle(&first);
        let (quote, approval) = f.other_job(project, model, location);
        let reservation = f.store.reserve_next_scoped(&quote.id, &approval);
        if project.is_none() && model.is_none() && location.is_none() {
            assert!(matches!(reservation, Err(AiError::PacingWaiting(_))));
        } else {
            let reservation = reservation.unwrap().unwrap();
            f.store.validate_dispatch(&reservation).unwrap();
        }
    }
}

#[test]
fn retry_after_overrides_pacing_and_applies_to_other_jobs_in_same_lane() {
    for header in ["90", "301"] {
        let f = Fixture::new(1);
        let sent = f.send();
        let expected = f.store.now_ms() + header.parse::<i64>().unwrap() * 1000;
        let status = f
            .store
            .handle_429_at(&sent, Some(header), f.store.now_ms(), 0)
            .unwrap();
        assert_eq!(
            status.state,
            if header == "301" {
                "deferred"
            } else {
                "waiting"
            }
        );
        assert_eq!(f.lane().2, expected);
        let (quote, approval) = f.other_job(None, None, None);
        assert!(
            matches!(f.store.reserve_next_scoped(&quote.id,&approval),Err(AiError::PacingWaiting(at)) if at==expected)
        );
        let before = f.counts();
        f.store.set_test_time(expected - 1);
        assert!(f.store.reserve_next_scoped(&quote.id, &approval).is_err());
        assert_eq!(f.counts(), before);
        f.store.set_test_time(expected);
        assert!(f
            .store
            .reserve_next_scoped(&quote.id, &approval)
            .unwrap()
            .is_some());
    }
}

#[test]
fn pause_cancel_restart_and_new_approval_cannot_erase_cooldown_or_send_automatically() {
    for action in ["pause", "cancel", "restart"] {
        let f = Fixture::new(1);
        let sent = f.send();
        f.store
            .handle_429_at(&sent, None, f.store.now_ms(), 0)
            .unwrap();
        let lane_before = f.lane();
        let counts_before = f.counts();
        match action {
            "pause" => f.store.pause(&f.quote.id).unwrap(),
            "cancel" => f.store.cancel(&f.quote.id).unwrap(),
            _ => {
                AiStore::open(f.directory.path().join("ai.db"))
                    .unwrap()
                    .recover_interrupted()
                    .unwrap();
            }
        }
        assert!(f.store.pacing_status(&f.quote.id).unwrap().is_none());
        assert!(f
            .store
            .reserve_next_scoped(&f.quote.id, &f.approval)
            .is_err());
        assert_eq!(f.counts(), counts_before);
        assert_eq!(f.lane(), lane_before);
        if action == "cancel" {
            continue;
        }
        let renewed = f
            .store
            .reapprove_scope_with_retry(&f.quote.id, &f.quote.digest, false, true, Some(1))
            .unwrap();
        assert!(matches!(
            f.store.reserve_next_scoped(&f.quote.id, &f.approval),
            Err(AiError::Superseded)
        ));
        assert!(
            matches!(f.store.reserve_next_scoped(&f.quote.id,&renewed),Err(AiError::PacingWaiting(at)) if at==lane_before.2)
        );
        assert_eq!(f.counts(), counts_before);
    }
}

#[test]
fn final_dispatch_gate_keeps_the_same_unsent_reservation_without_double_counting() {
    let f = Fixture::new(2);
    let sent = f.send();
    f.settle(&sent);
    let at = f.store.now_ms() + 10_000;
    f.store.set_test_time(at);
    let reservation = f
        .store
        .reserve_next_scoped(&f.quote.id, &f.approval)
        .unwrap()
        .unwrap();
    // Simulate a shared durable floor becoming stronger after local preflight.
    f.store
        .connect()
        .unwrap()
        .execute(
            "UPDATE ai_transcription_pacing SET cooldown_until_ms=?",
            [at + 5_000],
        )
        .unwrap();
    let before = f.counts();
    assert!(
        matches!(f.store.validate_dispatch(&reservation),Err(AiError::PacingWaiting(next)) if next==at+5_000)
    );
    let state: (String, Option<i64>) = f
        .store
        .connect()
        .unwrap()
        .query_row(
            "SELECT state,dispatched_at_ms FROM ai_attempts WHERE id=?",
            [&reservation.attempt_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(state, ("reserved".into(), None));
    assert_eq!(f.store.quote(&f.quote.id).unwrap().state, "approved");
    f.store.set_test_time(at + 5_000);
    f.store.validate_dispatch(&reservation).unwrap();
    f.store.validate_dispatch(&reservation).unwrap();
    assert_eq!(f.counts(), before);
    assert_eq!(f.lane().0, 10_000);
}

#[test]
fn non_transcription_jobs_have_no_pacing_and_unknown_outcomes_break_recovery_streak() {
    let f = Fixture::new(3);
    let sent = f.send();
    f.settle(&sent);
    let sent = f.send();
    f.store.mark_unknown(&sent.attempt_id).unwrap();
    assert_eq!(f.lane().1, 0);
    f.store.acknowledge_unknown(&sent.attempt_id).unwrap();
    let quote = f.store.prepare(super::super::tests::plan()).unwrap();
    f.store.approve(&quote.id, &quote.digest).unwrap();
    let reservation = f.store.reserve_next(&quote.id).unwrap().unwrap();
    f.store.validate_dispatch(&reservation).unwrap();
    assert!(f.store.pacing_status(&quote.id).unwrap().is_none());
}

#[test]
fn adaptive_cooldown_jitter_stays_within_twenty_percent_of_each_interval() {
    for use_max in [false, true] {
        let f = Fixture::new(1);
        for interval in [20_000, 40_000, 60_000] {
            let sent = f.send();
            let at = f.store.now_ms();
            let jitter = if use_max { interval / 5 } else { 0 };
            f.store
                .handle_429_at(&sent, None, at, jitter as u32)
                .unwrap();
            assert_eq!(f.lane(), (interval, 0, at + interval + jitter));
        }
    }
}

#[test]
fn excessive_retry_after_is_not_shortened_and_status_remains_serializable() {
    let f = Fixture::new(1);
    let sent = f.send();
    let retry = f
        .store
        .handle_429_at(&sent, Some("999999999999999999999999"), f.store.now_ms(), 0)
        .unwrap();
    assert_eq!(retry.state, "deferred");
    assert_eq!(f.lane().2, i64::MAX);
    let (quote, approval) = f.other_job(None, None, None);
    let status = f.store.pacing_status(&quote.id).unwrap().unwrap();
    assert!(status.next_send_at.is_none());
    assert!(serde_json::to_value(status)
        .unwrap()
        .get("nextSendAt")
        .is_none());
    assert!(matches!(
        f.store.reserve_next_scoped(&quote.id, &approval),
        Err(AiError::PacingWaiting(i64::MAX))
    ));
    assert_eq!(f.counts().0, 1);
}

#[test]
fn retry_countdown_tracks_later_shared_lane_floor_without_changing_retry_allowance() {
    let f = Fixture::new(1);
    let sent = f.send();
    let at = f.store.now_ms();
    f.store.handle_429_at(&sent, None, at, 0).unwrap();
    let before = f.counts();
    f.store
        .connect()
        .unwrap()
        .execute(
            "UPDATE ai_transcription_pacing SET cooldown_until_ms=?",
            [at + 50_000],
        )
        .unwrap();
    let expected = chrono::DateTime::from_timestamp_millis(at + 50_000)
        .unwrap()
        .to_rfc3339();
    assert_eq!(
        f.store
            .retry_status(&f.quote.id)
            .unwrap()
            .unwrap()
            .next_retry_at,
        Some(expected.clone())
    );
    assert_eq!(
        f.store
            .pacing_status(&f.quote.id)
            .unwrap()
            .unwrap()
            .next_send_at,
        Some(expected)
    );
    assert_eq!(f.counts(), before);
}

#[cfg(feature = "development-validation")]
#[test]
fn development_validation_keeps_its_original_send_scope_and_does_not_populate_pacing() {
    let f = Fixture::new(1);
    f.store.pause(&f.quote.id).unwrap();
    f.store.initialize_validation_total(2_000_000).unwrap();
    let scoped = f
        .store
        .with_development_validation(
            &f.quote.id,
            crate::ValidationApproval {
                plan_digest: f.quote.digest.clone(),
                model: crate::TRANSCRIBE_MODEL.into(),
                max_requests: 1,
                expires_at_ms: f.store.now_ms() + 60_000,
                max_reservation_microusd: f.quote.estimated_max_microusd,
                total_limit_microusd: 2_000_000,
            },
        )
        .unwrap();
    scoped.approve(&f.quote.id, &f.quote.digest).unwrap();
    let reservation = scoped.reserve_next(&f.quote.id).unwrap().unwrap();
    scoped.validate_dispatch(&reservation).unwrap();
    assert_eq!(
        scoped
            .connect()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM ai_transcription_pacing", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
        0
    );
    assert!(scoped.pacing_status(&f.quote.id).unwrap().is_none());
}
