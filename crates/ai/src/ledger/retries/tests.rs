use super::*;
use crate::{AudioAttachment, BudgetLimits, ParsedOutput};
use std::sync::atomic::Ordering;

struct Fixture {
    directory: tempfile::TempDir,
    store: AiStore,
    quote: super::super::JobQuote,
}

impl Fixture {
    fn new(count: usize, unpriced: bool) -> Self {
        let (directory, store) = super::super::tests::store();
        super::super::tests::enable(&store);
        let source = super::super::tests::plan();
        let path = directory.path().join("audio.wav");
        std::fs::write(&path, b"offline-audio").unwrap();
        let requests = (0..count)
            .map(|ordinal| RequestTask::TranscribePreview {
                language: "en".into(),
                audio: AudioAttachment::from_file(path.clone(), ordinal as u64 * 1000, 1000)
                    .unwrap(),
            })
            .collect();
        let mut plan = PreparedJob::fixture(
            source.title,
            source.project_id,
            source.credential_id,
            source.binding,
            requests,
        );
        if unpriced {
            let mut execution = plan.execution.clone();
            execution.price = None;
            plan = plan.with_execution(execution).unwrap();
        }
        let quote = store.prepare(plan).unwrap();
        Self {
            directory,
            store,
            quote,
        }
    }

    fn approve(&self, policy: Option<u32>) -> String {
        self.store
            .approve_scope_with_retry(&self.quote.id, &self.quote.digest, true, true, policy)
            .unwrap()
    }

    fn reserve(&self, approval: &str) -> ReservedRequest {
        if let Some(status) = self.store.pacing_status(&self.quote.id).unwrap() {
            self.advance_to(status.next_send_at.as_deref().unwrap());
        }
        let reservation = self
            .store
            .reserve_next_scoped(&self.quote.id, approval)
            .unwrap()
            .unwrap();
        self.store.validate_dispatch(&reservation).unwrap();
        reservation
    }

    fn advance_to(&self, when: &str) {
        let ms = chrono::DateTime::parse_from_rfc3339(when)
            .unwrap()
            .timestamp_millis();
        self.store.clock.store(ms, Ordering::SeqCst);
    }

    fn reject(&self, reservation: &ReservedRequest, header: Option<&str>) -> RetryStatus {
        self.store
            .handle_429_at(reservation, header, self.store.now_ms(), 0)
            .unwrap()
    }
}

#[test]
fn retry_scope_preserves_digest_counts_and_financial_holds_through_exhaustion() {
    for unpriced in [false, true] {
        let f = Fixture::new(2, unpriced);
        let approval = f.approve(Some(1));
        assert_eq!(
            f.store.prepared_job(&f.quote.id).unwrap().digest().unwrap(),
            f.quote.digest
        );
        assert!(matches!(
            f.store.reserve_next(&f.quote.id),
            Err(AiError::ApprovalRequired)
        ));
        for attempt in 1..=3 {
            let reserved = f.reserve(&approval);
            assert_eq!(reserved.ordinal, 0);
            let retry = f.reject(&reserved, None);
            assert_eq!(retry.retry_number, attempt.min(2));
            assert_eq!(retry.max_retries, 2);
            if attempt <= 2 {
                assert_eq!(retry.state, "waiting");
                let expected = f.store.now_ms() + if attempt == 1 { 20_000 } else { 40_000 };
                assert!(
                    matches!(f.store.reserve_next_scoped(&f.quote.id, &approval), Err(AiError::RetryWaiting(at)) if at == expected)
                );
                f.advance_to(retry.next_retry_at.as_deref().unwrap());
            } else {
                assert_eq!(retry.state, "exhausted");
                assert_eq!(f.store.quote(&f.quote.id).unwrap().state, "needs_review");
                assert!(f.store.reserve_next_scoped(&f.quote.id, &approval).is_err());
            }
            assert!(f.store.handle_429(&reserved, None).is_err());
        }
        let summary = f.store.summary().unwrap();
        assert!(summary.unknown_attempts.is_empty());
        assert_eq!(summary.unpriced_attempts, if unpriced { 3 } else { 0 });
        assert_eq!(summary.daily_actual_charged_microusd, 0);
        assert_eq!(
            summary.daily_held_microusd,
            f.quote.requests[0].estimated_max_microusd.unwrap_or(0) * 3
        );
        assert_eq!(
            f.store.retry_status(&f.quote.id).unwrap().unwrap().state,
            "exhausted"
        );
        let pending: String = f
            .store
            .connect()
            .unwrap()
            .query_row(
                "SELECT state FROM ai_requests WHERE job_id=? AND ordinal=1",
                [&f.quote.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(pending, "pending");
    }
}

#[test]
fn retry_success_advances_to_next_chunk_without_replaying_received_output() {
    let f = Fixture::new(2, true);
    let approval = f.approve(Some(1));
    let first = f.reserve(&approval);
    let retry = f.reject(&first, None);
    f.advance_to(retry.next_retry_at.as_deref().unwrap());
    let second = f.reserve(&approval);
    let status = f.store.retry_status(&f.quote.id).unwrap().unwrap();
    assert_eq!(
        (status.state.as_str(), status.retry_number),
        ("retrying", 1)
    );
    f.store
        .settle_unpriced(
            &second.attempt_id,
            &serde_json::json!({}),
            Some(&ParsedOutput::Transcript { cues: vec![] }),
            None,
        )
        .unwrap();
    assert!(f.store.retry_status(&f.quote.id).unwrap().is_none());
    assert_eq!(f.reserve(&approval).ordinal, 1);
}

#[test]
fn legacy_scope_and_historical_unknown_never_gain_automatic_retries() {
    let f = Fixture::new(1, true);
    let approval = f.approve(None);
    let reservation = f.reserve(&approval);
    let status = f.reject(&reservation, None);
    assert_eq!(status.max_retries, 0);
    assert_eq!(f.store.summary().unwrap().unknown_attempts.len(), 1);
    assert!(f
        .store
        .reapprove_scope_with_retry(&f.quote.id, &f.quote.digest, true, true, Some(1))
        .is_err());
    f.store
        .acknowledge_unknown(&reservation.attempt_id)
        .unwrap();
    let renewed = f
        .store
        .reapprove_scope_with_retry(&f.quote.id, &f.quote.digest, true, true, Some(1))
        .unwrap();
    assert_ne!(renewed, approval);
    assert_eq!(f.reserve(&renewed).ordinal, 0);
    assert_eq!(f.store.summary().unwrap().unpriced_attempts, 2);
}

#[test]
fn approval_checks_worst_case_budget_and_limits_policy_to_transcription() {
    let f = Fixture::new(1, false);
    let cost = f.quote.estimated_max_microusd.unwrap();
    f.store
        .set_budget(BudgetLimits {
            per_job_microusd: cost * 2,
            daily_microusd: 0,
            monthly_microusd: 0,
        })
        .unwrap();
    assert!(matches!(
        f.store
            .approve_scope_with_retry(&f.quote.id, &f.quote.digest, false, true, Some(1)),
        Err(AiError::BudgetExceeded("job"))
    ));
    assert!(f
        .store
        .approve_scope_with_retry(&f.quote.id, &f.quote.digest, false, true, Some(2))
        .is_err());
    assert_eq!(f.store.quote(&f.quote.id).unwrap().state, "prepared");
    let text = f.store.prepare(super::super::tests::plan()).unwrap();
    assert!(f
        .store
        .transcription_retry_policy(&text.id)
        .unwrap()
        .is_none());
    assert!(f
        .store
        .approve_scope_with_retry(&text.id, &text.digest, false, true, Some(1))
        .is_err());
}

#[test]
fn pause_cancel_restart_and_new_approval_invalidate_waiters_without_refunding() {
    for action in ["pause", "cancel", "restart"] {
        let f = Fixture::new(1, true);
        let approval = f.approve(Some(1));
        let reservation = f.reserve(&approval);
        let retry = f.reject(&reservation, None);
        f.advance_to(retry.next_retry_at.as_deref().unwrap());
        match action {
            "pause" => f.store.pause(&f.quote.id).unwrap(),
            "cancel" => f.store.cancel(&f.quote.id).unwrap(),
            _ => {
                let reopened = AiStore::open(f.directory.path().join("ai.db")).unwrap();
                reopened.recover_interrupted().unwrap();
            }
        }
        assert!(f.store.reserve_next_scoped(&f.quote.id, &approval).is_err());
        assert_eq!(f.store.summary().unwrap().unpriced_attempts, 1);
        assert!(f.store.summary().unwrap().unknown_attempts.is_empty());
        if action == "cancel" {
            continue;
        }
        let next = f
            .store
            .reapprove_scope_with_retry(&f.quote.id, &f.quote.digest, true, true, Some(1))
            .unwrap();
        assert!(matches!(
            f.store.reserve_next_scoped(&f.quote.id, &approval),
            Err(AiError::Superseded)
        ));
        assert!(matches!(
            f.store.validate_dispatch(&reservation),
            Err(AiError::Superseded)
        ));
        assert!(!f
            .store
            .require_review_scoped(&f.quote.id, &approval, "stale")
            .unwrap());
        assert!(!f
            .store
            .record_job_issue_scoped(
                &f.quote.id,
                &approval,
                "execution",
                "execute",
                None,
                "resume"
            )
            .unwrap());
        f.store
            .record_job_issue_scoped(&f.quote.id, &next, "execution", "execute", None, "resume")
            .unwrap();
        assert!(!f
            .store
            .clear_job_issue_scoped(&f.quote.id, &approval)
            .unwrap());
        assert!(f.store.job_issue(&f.quote.id).unwrap().is_some());
        assert_eq!(f.reserve(&next).ordinal, 0);
    }
}

#[test]
fn simultaneous_workers_claim_one_attempt_and_leave_winner_approved() {
    let f = Fixture::new(1, true);
    let approval = f.approve(Some(1));
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let threads = (0..2)
        .map(|_| {
            let store = f.store.clone();
            let job = f.quote.id.clone();
            let approval = approval.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                store.reserve_next_scoped(&job, &approval)
            })
        })
        .collect::<Vec<_>>();
    let mut claimed = 0;
    let mut busy = 0;
    for thread in threads {
        match thread.join().unwrap() {
            Ok(Some(_)) => claimed += 1,
            Err(AiError::WorkerBusy) => busy += 1,
            other => panic!("{other:?}"),
        }
    }
    assert_eq!((claimed, busy), (1, 1));
    assert_eq!(f.store.quote(&f.quote.id).unwrap().state, "approved");
}

#[test]
fn retry_after_is_bounded_and_invalid_headers_cannot_reduce_local_backoff() {
    let f = Fixture::new(1, true);
    let at = f.store.now_ms();
    assert_eq!(retry_after_delay(Some("30"), at), Some(30_000));
    let date = chrono::DateTime::from_timestamp_millis(at + 45_000)
        .unwrap()
        .to_rfc2822();
    assert_eq!(retry_after_delay(Some(&date), at), Some(45_000));
    assert_eq!(retry_after_delay(Some("not a delay"), at), None);
    assert_eq!(
        retry_after_delay(Some("9999999999999999999999999999999"), at),
        Some(u64::MAX)
    );
    let approval = f.approve(Some(1));
    let reservation = f.reserve(&approval);
    let status = f.reject(&reservation, Some("301"));
    assert_eq!(status.state, "deferred");
    let floor = at + 301_000;
    assert_eq!(
        chrono::DateTime::parse_from_rfc3339(status.next_retry_at.as_deref().unwrap())
            .unwrap()
            .timestamp_millis(),
        floor
    );
    assert_eq!(f.store.quote(&f.quote.id).unwrap().state, "needs_review");
    assert!(f.store.summary().unwrap().unknown_attempts.is_empty());
    assert_eq!(f.store.retry_not_before(&f.quote.id).unwrap(), Some(floor));
    assert!(
        matches!(f.store.reapprove_scope_with_retry(&f.quote.id,&f.quote.digest,true,true,Some(1)),Err(AiError::RetryWaiting(at)) if at==floor)
    );
    assert!(
        matches!(f.store.reapprove_scope_with_retry(&f.quote.id,&f.quote.digest,true,true,None),Err(AiError::RetryWaiting(at)) if at==floor)
    );
    f.advance_to(status.next_retry_at.as_deref().unwrap());
    let next = f
        .store
        .reapprove_scope_with_retry(&f.quote.id, &f.quote.digest, true, true, Some(1))
        .unwrap();
    assert_eq!(f.reserve(&next).ordinal, 0);
}

#[test]
fn lowering_budget_during_wait_prevents_another_reservation() {
    let f = Fixture::new(1, false);
    let approval = f.approve(Some(1));
    let reservation = f.reserve(&approval);
    let status = f.reject(&reservation, None);
    f.advance_to(status.next_retry_at.as_deref().unwrap());
    f.store
        .set_budget(BudgetLimits {
            per_job_microusd: reservation.reserved_microusd.unwrap(),
            daily_microusd: 0,
            monthly_microusd: 0,
        })
        .unwrap();
    assert!(matches!(
        f.store.reserve_next_scoped(&f.quote.id, &approval),
        Err(AiError::BudgetExceeded("job"))
    ));
}

#[test]
fn persisted_legacy_approval_without_generation_remains_one_send_only() {
    let mut f = Fixture::new(1, true);
    f.approve(None);
    let conn = f.store.connect().unwrap();
    conn.execute("UPDATE ai_jobs SET approval_json=json_remove(approval_json,'$.approval_id','$.retry_policy_version') WHERE id=?", [&f.quote.id]).unwrap();
    conn.execute("DROP TABLE ai_approval_requests", []).unwrap();
    let before: (String, String, String) = conn
        .query_row(
            "SELECT digest,plan_json,approval_json FROM ai_jobs WHERE id=?",
            [&f.quote.id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    drop(conn);
    f.store = AiStore::open(f.directory.path().join("ai.db")).unwrap();
    let after: (String, String, String) = f
        .store
        .connect()
        .unwrap()
        .query_row(
            "SELECT digest,plan_json,approval_json FROM ai_jobs WHERE id=?",
            [&f.quote.id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(before, after);
    assert_eq!(
        f.store.prepared_job(&f.quote.id).unwrap().digest().unwrap(),
        f.quote.digest
    );
    assert!(f.store.current_approval_id(&f.quote.id).unwrap().is_none());
    let reserved = f.store.reserve_next(&f.quote.id).unwrap().unwrap();
    assert!(reserved.approval_id.is_none());
    f.store.validate_dispatch(&reserved).unwrap();
    assert_eq!(f.reject(&reserved, None).max_retries, 0);
    assert!(f.store.reserve_next(&f.quote.id).is_err());
    assert_eq!(f.store.summary().unwrap().unknown_attempts.len(), 1);
}

#[test]
fn jitter_bounds_apply_to_both_retry_delays_without_exceeding_twenty_percent() {
    for (first_jitter, second_jitter, first_delay, second_delay) in
        [(0, 0, 10_000, 20_000), (2000, 4000, 12_000, 24_000)]
    {
        let f = Fixture::new(1, true);
        let approval = f.approve(Some(1));
        for (index, (jitter, delay)) in [(first_jitter, first_delay), (second_jitter, second_delay)]
            .into_iter()
            .enumerate()
        {
            assert_eq!(retry_delay(index as u32 + 1, jitter), delay);
            let reservation = f.reserve(&approval);
            let at = f.store.now_ms();
            let retry = f
                .store
                .handle_429_at(&reservation, Some("invalid"), at, jitter)
                .unwrap();
            assert_eq!(retry.state, "waiting");
            let next =
                chrono::DateTime::parse_from_rfc3339(retry.next_retry_at.as_deref().unwrap())
                    .unwrap()
                    .timestamp_millis();
            // The shared lane's 20/40s cooldown is stronger than this
            // individual retry's still-bounded 10/20s plus jitter floor.
            assert_eq!(
                next,
                at + if index == 0 { 20_000 } else { 40_000 } + i64::from(jitter)
            );
            assert!(
                matches!(f.store.reserve_next_scoped(&f.quote.id, &approval), Err(AiError::RetryWaiting(until)) if until == next)
            );
            f.advance_to(retry.next_retry_at.as_deref().unwrap());
        }
    }
}

#[test]
fn http_date_sets_the_persisted_retry_floor_and_reservation_time() {
    let f = Fixture::new(1, true);
    let approval = f.approve(Some(1));
    let reservation = f.reserve(&approval);
    let until = f.store.now_ms() + 45_000;
    let date = chrono::DateTime::from_timestamp_millis(until)
        .unwrap()
        .to_rfc2822();
    let retry = f.reject(&reservation, Some(&date));
    assert_eq!(retry.state, "waiting");
    assert_eq!(f.store.retry_not_before(&f.quote.id).unwrap(), Some(until));
    assert!(
        matches!(f.store.reserve_next_scoped(&f.quote.id, &approval), Err(AiError::RetryWaiting(at)) if at == until)
    );
    assert_eq!(
        chrono::DateTime::parse_from_rfc3339(retry.next_retry_at.as_deref().unwrap())
            .unwrap()
            .timestamp_millis(),
        until
    );
    f.store.clock.store(until - 1, Ordering::SeqCst);
    assert!(
        matches!(f.store.reserve_next_scoped(&f.quote.id, &approval), Err(AiError::RetryWaiting(at)) if at == until)
    );
    f.advance_to(retry.next_retry_at.as_deref().unwrap());
    assert_eq!(f.reserve(&approval).ordinal, reservation.ordinal);
}

#[test]
fn paused_response_retains_server_floor_and_priced_holds_across_calendar_days() {
    let f = Fixture::new(1, false);
    let approval = f.approve(Some(1));
    let reservation = f.reserve(&approval);
    f.store.pause(&f.quote.id).unwrap();
    let retry = f.reject(&reservation, Some("30"));
    assert_eq!(retry.state, "deferred");
    assert_eq!(f.store.quote(&f.quote.id).unwrap().state, "paused");
    assert!(matches!(
        f.store
            .reapprove_scope_with_retry(&f.quote.id, &f.quote.digest, false, true, Some(1)),
        Err(AiError::RetryWaiting(_))
    ));
    f.store.clock.fetch_add(86_400_000, Ordering::SeqCst);
    assert_eq!(
        f.store.summary().unwrap().daily_held_microusd,
        reservation.reserved_microusd.unwrap()
    );
    assert!(f.store.retry_not_before(&f.quote.id).unwrap().is_none());
    let quote = f.store.refresh_quote(&f.quote.id).unwrap();
    let renewed = f
        .store
        .reapprove_scope_with_retry(&quote.id, &quote.digest, false, true, Some(1))
        .unwrap();
    assert_eq!(f.reserve(&renewed).ordinal, 0);
}
