use super::{tests::*, *};

fn at(value: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(value)
        .unwrap()
        .timestamp_millis()
}

fn counts(s: &AiStore) -> (u32, u32) {
    s.connect()
        .unwrap()
        .query_row(
            "SELECT (SELECT COUNT(*) FROM ai_jobs),(SELECT COUNT(*) FROM ai_attempts)",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap()
}

fn approve_one(s: &AiStore) -> JobQuote {
    let quote = s.prepare(plan()).unwrap();
    s.approve(&quote.id, &quote.digest).unwrap();
    quote
}

fn settle_success(s: &AiStore, r: &ReservedRequest, cost: u64) {
    s.settle(
        &r.attempt_id,
        cost,
        &serde_json::json!({"test":true}),
        Some(&ParsedOutput::Vocabulary { items: vec![] }),
        None,
    )
    .unwrap();
}

#[test]
fn each_budget_accepts_exact_boundary_and_rejects_one_microdollar_below() {
    for bucket in ["job", "daily", "monthly"] {
        for delta in [-1i64, 0, 1] {
            let (_dir, s) = store();
            let q = s.prepare(plan()).unwrap();
            let expected = q.estimated_max_microusd.unwrap();
            let mut budget = BudgetLimits {
                per_job_microusd: expected + 100,
                daily_microusd: expected + 100,
                monthly_microusd: expected + 100,
            };
            let cap = (expected as i64 + delta) as u64;
            match bucket {
                "job" => budget.per_job_microusd = cap,
                "daily" => budget.daily_microusd = cap,
                _ => budget.monthly_microusd = cap,
            }
            s.set_budget(budget).unwrap();
            let result = s.approve(&q.id, &q.digest);
            if delta < 0 {
                assert!(matches!(result, Err(AiError::BudgetExceeded(label)) if label == bucket));
                assert_eq!(counts(&s).1, 0);
            } else {
                result.unwrap();
                let r = s.reserve_next(&q.id).unwrap().unwrap();
                assert_eq!(r.reserved_microusd.unwrap(), expected);
                // A second pre-send check must not count this reservation twice.
                s.validate_dispatch(&r).unwrap();
            }
        }
    }
}

#[test]
fn per_job_cap_includes_previous_charges_and_accepted_unknown_retries() {
    let (_dir, s) = store();
    enable(&s);
    let q = approve_one(&s);
    let r = s.reserve_next(&q.id).unwrap().unwrap();
    s.mark_unknown(&r.attempt_id).unwrap();
    s.acknowledge_unknown(&r.attempt_id).unwrap();
    s.set_budget(BudgetLimits {
        per_job_microusd: r.reserved_microusd.unwrap() * 2 - 1,
        daily_microusd: r.reserved_microusd.unwrap() * 3,
        monthly_microusd: r.reserved_microusd.unwrap() * 3,
    })
    .unwrap();
    assert!(matches!(
        s.reapprove(&q.id, &q.digest),
        Err(AiError::BudgetExceeded("job"))
    ));
    assert_eq!(counts(&s).1, 1);
    s.set_budget(BudgetLimits {
        per_job_microusd: r.reserved_microusd.unwrap() * 2,
        daily_microusd: r.reserved_microusd.unwrap() * 2,
        monthly_microusd: r.reserved_microusd.unwrap() * 2,
    })
    .unwrap();
    s.reapprove(&q.id, &q.digest).unwrap();
    let retry = s.reserve_next(&q.id).unwrap().unwrap();
    s.validate_dispatch(&retry).unwrap();
    assert_eq!(
        s.summary().unwrap().monthly_held_microusd,
        r.reserved_microusd.unwrap() * 2
    );
}

#[test]
fn next_request_is_limited_by_previous_actual_charges() {
    for bucket in ["job", "daily", "monthly"] {
        let (_dir, s) = store();
        enable(&s);
        let mut p = plan();
        p.requests.push(p.requests[0].clone());
        let q = s.prepare(p.refreeze()).unwrap();
        s.approve(&q.id, &q.digest).unwrap();
        let first = s.reserve_next(&q.id).unwrap().unwrap();
        settle_success(&s, &first, 123);
        let boundary = first.reserved_microusd.unwrap() + 123;
        let mut budget = BudgetLimits {
            per_job_microusd: boundary,
            daily_microusd: boundary,
            monthly_microusd: boundary,
        };
        match bucket {
            "job" => budget.per_job_microusd -= 1,
            "daily" => budget.daily_microusd -= 1,
            _ => budget.monthly_microusd -= 1,
        }
        s.set_budget(budget).unwrap();
        assert!(
            matches!(s.reserve_next(&q.id), Err(AiError::BudgetExceeded(label)) if label == bucket)
        );
        assert_eq!(counts(&s).1, 1);
        s.set_budget(BudgetLimits {
            per_job_microusd: boundary,
            daily_microusd: boundary,
            monthly_microusd: boundary,
        })
        .unwrap();
        let second = s.reserve_next(&q.id).unwrap().unwrap();
        assert_eq!(second.ordinal, 1);
        s.validate_dispatch(&second).unwrap();
    }
}

#[test]
fn calendar_rollover_keeps_unknown_holds_but_drops_previous_period_actuals() {
    let (_dir, s) = store();
    enable(&s);
    s.set_test_time(at("2026-08-31T23:59:59Z"));
    let settled = approve_one(&s);
    let r = s.reserve_next(&settled.id).unwrap().unwrap();
    settle_success(&s, &r, 77);
    let mut p = plan();
    p.title = "Unresolved next job".into();
    let q = s.prepare(p.refreeze()).unwrap();
    s.approve(&q.id, &q.digest).unwrap();
    let unresolved = s.reserve_next(&q.id).unwrap().unwrap();
    s.mark_unknown(&unresolved.attempt_id).unwrap();
    s.acknowledge_unknown(&unresolved.attempt_id).unwrap();
    let before = s.summary().unwrap();
    assert_eq!(before.monthly_actual_charged_microusd, 77);
    assert_eq!(
        before.daily_held_microusd,
        unresolved.reserved_microusd.unwrap()
    );
    for date in [
        "2026-09-01T00:00:00Z",
        "2026-09-02T00:00:00Z",
        "2026-10-01T00:00:00Z",
    ] {
        s.set_test_time(at(date));
        let after = s.summary().unwrap();
        assert_eq!(after.daily_actual_charged_microusd, 0);
        assert_eq!(after.monthly_actual_charged_microusd, 0);
        assert_eq!(
            after.daily_held_microusd,
            unresolved.reserved_microusd.unwrap()
        );
        assert_eq!(
            after.monthly_charged_or_held_microusd,
            unresolved.reserved_microusd.unwrap()
        );
    }
}

#[test]
fn utc_midnight_resets_daily_actuals_while_monthly_actuals_remain() {
    let (_dir, s) = store();
    enable(&s);
    s.set_test_time(at("2026-09-08T23:59:59Z"));
    let q = approve_one(&s);
    let r = s.reserve_next(&q.id).unwrap().unwrap();
    settle_success(&s, &r, 91);
    s.set_test_time(at("2026-09-09T00:00:00Z"));
    let summary = s.summary().unwrap();
    assert_eq!(summary.daily_actual_charged_microusd, 0);
    assert_eq!(summary.monthly_actual_charged_microusd, 91);
}

#[test]
fn reservation_crossing_midnight_is_counted_once_and_settles_on_dispatch_day() {
    for (before, after) in [
        ("2026-09-08T23:59:59Z", "2026-09-09T00:00:00Z"),
        ("2026-09-30T23:59:59Z", "2026-10-01T00:00:00Z"),
    ] {
        let (_dir, s) = store();
        s.set_test_time(at(before));
        let q = s.prepare(plan()).unwrap();
        let cost = q.estimated_max_microusd.unwrap();
        s.set_budget(BudgetLimits {
            per_job_microusd: cost,
            daily_microusd: cost,
            monthly_microusd: cost,
        })
        .unwrap();
        s.approve(&q.id, &q.digest).unwrap();
        let r = s.reserve_next(&q.id).unwrap().unwrap();
        s.set_test_time(at(after));
        s.validate_dispatch(&r).unwrap();
        let held = s.summary().unwrap();
        assert_eq!(held.daily_held_microusd, cost);
        assert_eq!(held.monthly_held_microusd, cost);
        settle_success(&s, &r, cost);
        let charged = s.summary().unwrap();
        assert_eq!(charged.daily_actual_charged_microusd, cost);
        assert_eq!(charged.monthly_actual_charged_microusd, cost);
        assert_eq!(charged.daily_held_microusd, 0);
        let dates: (i64, i64) = s
            .connect()
            .unwrap()
            .query_row(
                "SELECT created_at_ms,dispatched_at_ms FROM ai_attempts WHERE id=?",
                [&r.attempt_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(dates, (at(before), at(after)));
        let mut next = plan();
        next.title = "Next day job".into();
        let next = s.prepare(next).unwrap();
        assert!(matches!(
            s.approve(&next.id, &next.digest),
            Err(AiError::BudgetExceeded("daily"))
        ));
        assert_eq!(counts(&s).1, 1);
    }
}

#[test]
fn rejected_dispatch_does_not_stamp_time_or_release_cross_period_hold() {
    let (_dir, s) = store();
    enable(&s);
    s.set_test_time(at("2026-09-30T23:59:59Z"));
    let q = approve_one(&s);
    let r = s.reserve_next(&q.id).unwrap().unwrap();
    s.set_test_time(at("2026-10-01T00:00:00Z"));
    s.set_budget(BudgetLimits {
        per_job_microusd: r.reserved_microusd.unwrap(),
        daily_microusd: r.reserved_microusd.unwrap() - 1,
        monthly_microusd: r.reserved_microusd.unwrap(),
    })
    .unwrap();
    assert!(matches!(
        s.validate_dispatch(&r),
        Err(AiError::BudgetExceeded("daily"))
    ));
    let dispatch: Option<i64> = s
        .connect()
        .unwrap()
        .query_row(
            "SELECT dispatched_at_ms FROM ai_attempts WHERE id=?",
            [&r.attempt_id],
            |r| r.get(0),
        )
        .unwrap();
    assert!(dispatch.is_none());
    assert_eq!(
        s.summary().unwrap().monthly_held_microusd,
        r.reserved_microusd.unwrap()
    );
    s.release_unsent(&r.attempt_id, "budget changed before sending")
        .unwrap();
    assert_eq!(s.summary().unwrap().monthly_charged_or_held_microusd, 0);
}

#[test]
fn two_distinct_jobs_cannot_claim_simultaneously() {
    let (_dir, s) = store();
    enable(&s);
    let a = approve_one(&s);
    let mut p = plan();
    p.title = "Independent second job".into();
    let b = s.prepare(p).unwrap();
    s.approve(&b.id, &b.digest).unwrap();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let threads: Vec<_> = [a.id, b.id]
        .into_iter()
        .map(|id| {
            let s = s.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                s.reserve_next(&id)
            })
        })
        .collect();
    let results: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
    assert_eq!(
        results.iter().filter(|r| matches!(r, Ok(Some(_)))).count(),
        1
    );
    assert_eq!(
        results
            .iter()
            .filter(|r| matches!(r, Err(AiError::InFlight)))
            .count(),
        1
    );
    assert_eq!(counts(&s), (2, 1));
}

#[test]
fn invalid_preparation_digest_and_expired_quote_never_create_reservations() {
    let (_dir, s) = store();
    enable(&s);
    let mut invalid = plan();
    invalid.requests.clear();
    assert!(s.prepare(invalid).is_err());
    assert_eq!(counts(&s), (0, 0));
    let q = s.prepare(plan()).unwrap();
    assert!(matches!(
        s.approve(&q.id, "different"),
        Err(AiError::ApprovalRequired)
    ));
    s.set_test_time(q.quote_expires_at_ms + 1);
    assert!(matches!(
        s.approve(&q.id, &q.digest),
        Err(AiError::ApprovalRequired)
    ));
    assert_eq!(counts(&s).1, 0);
    s.set_test_time(TEST_NOW_MS);
    let mut changed = plan();
    changed.title = "Changed without a new quote".into();
    s.connect()
        .unwrap()
        .execute(
            "UPDATE ai_jobs SET plan_json=? WHERE id=?",
            params![serde_json::to_string(&changed).unwrap(), q.id],
        )
        .unwrap();
    assert!(s.approve(&q.id, &q.digest).is_err());
    assert_eq!(counts(&s).1, 0);
}

#[test]
fn dispatch_rechecks_current_budget_price_state_and_reservation_identity() {
    for scenario in [
        "budget", "price", "pause", "cancel", "released", "task", "identity",
    ] {
        let (_dir, s) = store();
        enable(&s);
        let q = approve_one(&s);
        let mut r = s.reserve_next(&q.id).unwrap().unwrap();
        s.validate_dispatch(&r).unwrap();
        match scenario {
            "budget" => s.set_budget(BudgetLimits::default()).unwrap(),
            "price" => {
                r.execution
                    .price
                    .as_mut()
                    .unwrap()
                    .output_microusd_per_million += 1
            }
            "pause" => s.pause(&q.id).unwrap(),
            "cancel" => s.cancel(&q.id).unwrap(),
            "released" => s.release_unsent(&r.attempt_id, "preflight").unwrap(),
            "task" => {
                if let RequestTask::Vocabulary { max_items, .. } = &mut r.task {
                    *max_items += 1;
                }
            }
            _ => r.attempt_id = "not-the-reserved-attempt".into(),
        }
        assert!(s.validate_dispatch(&r).is_err(), "scenario {scenario}");
        assert_eq!(counts(&s).1, 1);
    }
}

#[test]
fn approved_long_job_survives_quote_review_window_without_new_approval() {
    let (_dir, s) = store();
    enable(&s);
    let q = approve_one(&s);
    s.set_test_time(TEST_NOW_MS + 6 * 60 * 60 * 1000);
    let r = s.reserve_next(&q.id).unwrap().unwrap();
    s.validate_dispatch(&r).unwrap();
    s.set_test_time(TEST_NOW_MS + 60 * 24 * 60 * 60 * 1000);
    s.validate_dispatch(&r).unwrap(); // the approved price snapshot is immutable
}

#[test]
fn both_audio_adapters_require_explicit_scope_and_cannot_forge_approval_state() {
    for preview in [true, false] {
        let (_dir, s) = store();
        enable(&s);
        let mut p = plan();
        let audio = AudioAttachment {
            path: "never-read.flac".into(),
            sha256: crate::sha256_bytes(b"fixture"),
            byte_len: 7,
            mime_type: "audio/flac".into(),
            source_start_ms: 0,
            duration_ms: 1000,
        };
        p.requests = vec![if preview {
            RequestTask::TranscribePreview {
                language: "en-US".into(),
                audio,
            }
        } else {
            RequestTask::AudioTranscription {
                language: "en-US".into(),
                audio,
            }
        }];
        let q = s.prepare(p.refreeze()).unwrap();
        assert!(matches!(
            s.approve_scope(&q.id, &q.digest, false, false),
            Err(AiError::ApprovalRequired)
        ));
        assert_eq!(counts(&s).1, 0);
        // Persisted state from an earlier application cannot bypass qualification.
        s.connect()
            .unwrap()
            .execute("UPDATE ai_jobs SET state='approved' WHERE id=?", [&q.id])
            .unwrap();
        assert!(matches!(
            s.reserve_next(&q.id),
            Err(AiError::ApprovalRequired)
        ));
        assert_eq!(counts(&s).1, 0);
    }
}

#[test]
fn restart_requires_approval_even_without_an_interrupted_request() {
    let (dir, s) = store();
    enable(&s);
    let q = approve_one(&s);
    let reopened = AiStore::open(dir.path().join("ai.db")).unwrap();
    assert_eq!(reopened.recover_interrupted().unwrap(), 0);
    assert_eq!(reopened.quote(&q.id).unwrap().state, "needs_review");
    assert!(matches!(
        reopened.reserve_next(&q.id),
        Err(AiError::ApprovalRequired)
    ));
    assert!(matches!(
        reopened.approve(&q.id, &q.digest),
        Err(AiError::ApprovalRequired)
    ));
    reopened.refresh_quote(&q.id).unwrap();
    reopened.reapprove(&q.id, &q.digest).unwrap();
    assert!(reopened.reserve_next(&q.id).unwrap().is_some());
}

#[test]
fn cancelled_jobs_stay_cancelled_and_reviewed_success_cannot_be_resent() {
    let (_dir, s) = store();
    enable(&s);
    let q = approve_one(&s);
    s.cancel(&q.id).unwrap();
    s.pause(&q.id).unwrap();
    s.require_review(&q.id, "late source event").unwrap();
    assert_eq!(s.quote(&q.id).unwrap().state, "cancelled");
    assert!(s.reapprove(&q.id, &q.digest).is_err());
    let mut p = plan();
    p.title = "Completed".into();
    let completed = s.prepare(p).unwrap();
    s.approve(&completed.id, &completed.digest).unwrap();
    let r = s.reserve_next(&completed.id).unwrap().unwrap();
    settle_success(&s, &r, 10);
    s.require_review(&completed.id, "late source event")
        .unwrap();
    assert_eq!(s.quote(&completed.id).unwrap().state, "needs_review");
    assert!(s.reapprove(&completed.id, &completed.digest).is_err());
    assert_eq!(s.quote(&completed.id).unwrap().completed_requests, 1);
    assert!(s.response(&completed.id, 0).unwrap().is_some());
}

#[test]
fn unknown_cannot_be_released_as_unsent() {
    let (_dir, s) = store();
    enable(&s);
    let q = approve_one(&s);
    let r = s.reserve_next(&q.id).unwrap().unwrap();
    s.mark_unknown(&r.attempt_id).unwrap();
    assert!(matches!(
        s.release_unsent(&r.attempt_id, "late preflight"),
        Err(AiError::UnknownOutcome)
    ));
    assert_eq!(
        s.summary().unwrap().monthly_held_microusd,
        r.reserved_microusd.unwrap()
    );
}

#[test]
fn successful_inflight_result_keeps_pause_cancel_and_review_decisions() {
    for state in ["paused", "cancelled", "needs_review"] {
        let (_dir, s) = store();
        enable(&s);
        let q = approve_one(&s);
        let r = s.reserve_next(&q.id).unwrap().unwrap();
        match state {
            "paused" => s.pause(&q.id).unwrap(),
            "cancelled" => s.cancel(&q.id).unwrap(),
            _ => s.require_review(&q.id, "native source changed").unwrap(),
        }
        settle_success(&s, &r, 88);
        let quote = s.quote(&q.id).unwrap();
        assert_eq!(quote.state, state);
        assert_eq!(quote.completed_requests, 1);
        assert_eq!(quote.already_charged_or_held_microusd, 88);
        assert!(s.response(&q.id, 0).unwrap().is_some());
        assert!(s.reapprove(&q.id, &q.digest).is_err());
    }
}

/// Executed only as a subprocess by the checkpoint test below. The parent kills
/// this process after a durable operation, without running SQLite/Rust destructors.
#[test]
#[ignore = "subprocess helper, invoked with an isolated temporary database"]
fn process_checkpoint_child() {
    let Some(root) = std::env::var_os("SURTITLE_LEDGER_CHECKPOINT_ROOT") else {
        return;
    };
    let root = PathBuf::from(root);
    let phase = std::env::var("SURTITLE_LEDGER_CHECKPOINT_PHASE").unwrap();
    let s = AiStore::open(root.join("ai.db")).unwrap();
    enable(&s);
    let q = approve_one(&s);
    let r = s.reserve_next(&q.id).unwrap().unwrap();
    match phase.as_str() {
        "reserved" => (),
        "released" => s.release_unsent(&r.attempt_id, "known unsent").unwrap(),
        "settled" => settle_success(&s, &r, 42),
        _ => panic!("Unexpected checkpoint"),
    }
    let marker = serde_json::json!({ "job": q.id, "digest": q.digest,
        "attempt": r.attempt_id, "reserved": r.reserved_microusd.unwrap() });
    std::fs::write(
        root.join("ready.json.part"),
        serde_json::to_vec(&marker).unwrap(),
    )
    .unwrap();
    std::fs::rename(root.join("ready.json.part"), root.join("ready.json")).unwrap();
    loop {
        std::thread::sleep(Duration::from_secs(1));
    }
}

#[test]
fn killed_process_reopens_durable_reserved_released_and_settled_checkpoints() {
    use std::process::{Command, Stdio};
    for phase in ["reserved", "released", "settled"] {
        let dir = tempfile::tempdir().unwrap();
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "ledger::fault_tests::process_checkpoint_child",
                "--ignored",
                "--nocapture",
            ])
            .env("SURTITLE_LEDGER_CHECKPOINT_ROOT", dir.path())
            .env("SURTITLE_LEDGER_CHECKPOINT_PHASE", phase)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        let mut child = command.spawn().unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        let marker = dir.path().join("ready.json");
        while !marker.exists() && std::time::Instant::now() < deadline {
            if let Some(status) = child.try_wait().unwrap() {
                panic!("Checkpoint child exited: {status}");
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(marker.exists(), "Child never reached checkpoint {phase}");
        let checkpoint: serde_json::Value =
            serde_json::from_slice(&std::fs::read(marker).unwrap()).unwrap();
        let s = AiStore::open(dir.path().join("ai.db")).unwrap();
        let job = checkpoint["job"].as_str().unwrap();
        let digest = checkpoint["digest"].as_str().unwrap();
        let recovered = s.recover_interrupted().unwrap();
        let quote = s.quote(job).unwrap();
        assert_eq!(counts(&s).1, 1);
        assert_eq!(recovered, u64::from(phase == "reserved"));
        match phase {
            "reserved" => {
                assert_eq!(
                    quote.already_charged_or_held_microusd,
                    checkpoint["reserved"].as_u64().unwrap()
                );
                assert_eq!(s.summary().unwrap().unknown_attempts.len(), 1);
                assert!(s.reapprove(job, digest).is_err());
                s.acknowledge_unknown(checkpoint["attempt"].as_str().unwrap())
                    .unwrap();
                assert!(s.reserve_next(job).is_err());
                s.reapprove(job, digest).unwrap();
                assert!(s.reserve_next(job).unwrap().is_some());
            }
            "released" => {
                assert_eq!(quote.already_charged_or_held_microusd, 0);
                assert!(s.reserve_next(job).is_err());
                s.reapprove(job, digest).unwrap();
                assert!(s.reserve_next(job).unwrap().is_some());
            }
            "settled" => {
                assert_eq!(quote.state, "completed");
                assert_eq!(quote.already_charged_or_held_microusd, 42);
                assert!(s.response(job, 0).unwrap().is_some());
                assert!(s.reapprove(job, digest).is_err());
                assert!(s.reserve_next(job).is_err());
            }
            _ => unreachable!(),
        }
    }
}
