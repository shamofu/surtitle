//! Fixed model traces through the real worker and SQLite transactions. These
//! are boundary checks, not another implementation of the ledger state machine.
use super::*;

fn attempt(db_path: &std::path::Path, job: &str) -> String {
    Connection::open(db_path)
        .unwrap()
        .query_row(
            "SELECT id FROM ai_attempts WHERE job_id=? ORDER BY created_at_ms DESC,rowid DESC LIMIT 1",
            [job],
            |row| row.get(0),
        )
        .unwrap()
}

fn advance_pacing(store: &AiStore, job: &str) {
    if let Some(status) = store.pacing_status(job).unwrap() {
        store.set_test_time(
            chrono::DateTime::parse_from_rfc3339(status.next_send_at.as_deref().unwrap())
                .unwrap()
                .timestamp_millis(),
        );
    }
}

fn assert_accounts(store: &AiStore, actual: u64, held: u64, unpriced: u64) {
    let summary = store.summary().unwrap();
    assert_eq!(summary.daily_actual_charged_microusd, actual);
    assert_eq!(summary.monthly_actual_charged_microusd, actual);
    assert_eq!(summary.daily_held_microusd, held);
    assert_eq!(summary.monthly_held_microusd, held);
    assert_eq!(summary.unpriced_attempts, unpriced);
}

// Catches treating authorization as HTTP start, refunding a send cancelled in
// that gap, or allowing a second claim while that authorized send still owns it.
#[tokio::test]
async fn authorize_control_start_settle_keeps_stop_and_exclusive_claim() {
    for stop in ["paused", "cancelled"] {
        let h = Harness::with_tasks(
            vec![task(), task()],
            vec![Ok(FakeResponse::json(valid_response()))],
        );
        let mut other = h.store.prepared_job(&h.quote.id).unwrap();
        other.title = "Competing job at authorized boundary".into();
        let other = h.store.prepare(other.refreeze()).unwrap();
        h.store.approve(&other.id, &other.digest).unwrap();
        let store = h.store.clone();
        let job = h.quote.id.clone();
        let digest = h.quote.digest.clone();
        let events = h.events.clone();
        let db_path = h.transport.db_path.clone();
        let actions = Arc::new(Mutex::new(vec![]));
        let observed = actions.clone();
        let observer: ExecutionObserver = Arc::new(move |event| {
            if event.stage == ExecutionStage::Receiving {
                observed.lock().unwrap().push("Start");
            }
            if event.stage == ExecutionStage::Settled {
                observed.lock().unwrap().push("Settle");
            }
            if event.stage != ExecutionStage::Sending {
                return;
            }
            observed.lock().unwrap().push("Authorize");
            // This event is after validate_dispatch committed and before send.
            let dispatched: bool = Connection::open(&db_path)
                .unwrap()
                .query_row(
                    "SELECT dispatched_at_ms IS NOT NULL FROM ai_attempts WHERE id=?",
                    [&event.attempt_id],
                    |row| row.get(0),
                )
                .unwrap();
            assert!(dispatched);
            assert!(!events.lock().unwrap().contains(&"send"));
            let held = store.summary().unwrap().daily_held_microusd;
            assert!(held > 0);
            if stop == "paused" {
                store.pause(&job).unwrap();
                assert!(matches!(
                    store.reapprove(&job, &digest),
                    Err(AiError::WorkerBusy)
                ));
            } else {
                store.cancel(&job).unwrap();
            }
            observed.lock().unwrap().push("Control");
            assert!(matches!(
                store.reserve_next(&other.id),
                Err(AiError::InFlight)
            ));
            assert_eq!(store.summary().unwrap().daily_held_microusd, held);
        });
        let result = execute_observed_with_io(
            &h.store,
            &h.auth,
            &h.transport,
            &h.quote.id,
            None,
            || Ok(()),
            Some(&observer),
        )
        .await
        .unwrap()
        .unwrap();
        // Fixture price: ceil(1000 * .3 + (100 + 10) * 2.5) = 575 micro-USD.
        assert_eq!(result.charged_microusd, Some(575));
        assert_accounts(&h.store, 575, 0, 0);
        assert_eq!(h.store.quote(&h.quote.id).unwrap().state, stop);
        assert_eq!(h.store.quote(&h.quote.id).unwrap().completed_requests, 1);
        assert!(h.execute().await.is_err());
        assert!(h
            .store
            .settle(
                &result.attempt_id,
                575,
                &json!({}),
                Some(&result.output),
                None
            )
            .is_err());
        assert_accounts(&h.store, 575, 0, 0);
        assert_eq!(h.sends(), 1);
        assert_eq!(
            *actions.lock().unwrap(),
            ["Authorize", "Control", "Start", "Settle"]
        );
    }
}

// Catches losing durable evidence or releasing its hold after an atomic
// settlement failure; local parsing and retrying settlement must not send again.
#[tokio::test]
async fn save_evidence_settlement_failure_local_reuse_then_settle_once() {
    for unpriced in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let h = Harness::with_approval(
            vec![transcript_task(directory.path())],
            vec![Ok(FakeResponse::json(transcript_response()))],
            false,
        );
        let h = if unpriced { unprice(h) } else { h };
        h.store
            .approve_scope(&h.quote.id, &h.quote.digest, true, true)
            .unwrap();
        let conn = Connection::open(&h.transport.db_path).unwrap();
        conn.execute_batch("CREATE TRIGGER delayed_settlement BEFORE UPDATE OF state ON ai_attempts WHEN NEW.state='settled' BEGIN SELECT RAISE(ABORT,'delayed settlement'); END;").unwrap();
        assert!(h.execute().await.is_err());
        let id = attempt(&h.transport.db_path, &h.quote.id);
        let hold = h.quote.requests[0].estimated_max_microusd.unwrap_or(0);
        assert_accounts(&h.store, 0, hold, u64::from(unpriced));
        assert!(h.store.response(&h.quote.id, 0).unwrap().is_none());
        h.store.pause(&h.quote.id).unwrap();
        assert!(matches!(
            h.store
                .reapprove_scope(&h.quote.id, &h.quote.digest, true, true),
            Err(AiError::WorkerBusy)
        ));
        let detail = h.store.transcript_result_detail(&h.quote.id, 0).unwrap();
        let digest = detail.evidence_sha256.unwrap();
        let candidate = h
            .store
            .reparse_transcript_evidence(&h.quote.id, 0, &digest)
            .unwrap();
        assert!(candidate.output.is_some());
        assert_eq!(
            h.store
                .reparse_transcript_evidence(&h.quote.id, 0, &digest)
                .unwrap()
                .id,
            candidate.id
        );
        assert!(h
            .store
            .select_transcript_reparse(&h.quote.id, 0, &candidate.id)
            .is_err());
        assert_accounts(&h.store, 0, hold, u64::from(unpriced));
        assert_eq!(h.sends(), 1);
        conn.execute_batch("DROP TRIGGER delayed_settlement")
            .unwrap();
        let settle = || {
            if unpriced {
                h.store.settle_unpriced(
                    &id,
                    &json!({"promptTokenCount":10,"candidatesTokenCount":5}),
                    candidate.output.as_ref(),
                    None,
                )
            } else {
                // Fixture audio price: 10 * 1.5 + 5 * 9 = 60 micro-USD.
                h.store.settle(
                    &id,
                    60,
                    &json!({"promptTokenCount":10,"candidatesTokenCount":5}),
                    candidate.output.as_ref(),
                    None,
                )
            }
        };
        settle().unwrap();
        assert!(settle().is_err());
        assert_accounts(
            &h.store,
            if unpriced { 0 } else { 60 },
            0,
            u64::from(unpriced),
        );
        assert_eq!(h.store.quote(&h.quote.id).unwrap().state, "paused");
        assert!(h.store.response(&h.quote.id, 0).unwrap().is_some());
        assert!(h.execute().await.is_err());
        assert_eq!(h.sends(), 1);
    }
}

// Catches refunding a 429/unknown on acknowledgement or local reparse, stale
// approval reuse, or silently replacing old holds with the renewed approval.
#[tokio::test]
async fn reject429_unknown_local_reuse_acknowledge_reapprove_keeps_both_holds() {
    for unpriced in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let mut unknown_usage = transcript_response();
        unknown_usage["usageMetadata"] = json!({"promptTokenCount":10});
        let h = Harness::with_approval(
            vec![transcript_task(directory.path())],
            vec![
                Ok(FakeResponse::bytes(429, vec![])),
                Ok(FakeResponse::json(unknown_usage)),
                Ok(FakeResponse::json(transcript_response())),
            ],
            false,
        );
        let h = if unpriced { unprice(h) } else { h };
        let approval = h
            .store
            .approve_scope_with_retry(&h.quote.id, &h.quote.digest, true, true, Some(1))
            .unwrap();
        let retry_at = match execute_scoped_with_io(
            &h.store,
            &h.auth,
            &h.transport,
            &h.quote.id,
            Some(&approval),
            || Ok(()),
        )
        .await
        {
            Err(AiError::RetryWaiting(at)) => at,
            result => panic!("Reject429 expected RetryWaiting: {result:?}"),
        };
        let hold = h.quote.requests[0].estimated_max_microusd.unwrap_or(0);
        assert_accounts(&h.store, 0, hold, u64::from(unpriced));
        assert!(matches!(
            execute_scoped_with_io(
                &h.store,
                &h.auth,
                &h.transport,
                &h.quote.id,
                Some(&approval),
                || Ok(())
            )
            .await,
            Err(AiError::RetryWaiting(_))
        ));
        assert_eq!(h.sends(), 1);
        h.store.set_test_time(retry_at);
        assert!(matches!(
            execute_scoped_with_io(
                &h.store,
                &h.auth,
                &h.transport,
                &h.quote.id,
                Some(&approval),
                || Ok(())
            )
            .await,
            Err(AiError::UnknownOutcome)
        ));
        let id = attempt(&h.transport.db_path, &h.quote.id);
        assert_accounts(&h.store, 0, 2 * hold, if unpriced { 2 } else { 0 });
        assert!(matches!(
            h.store
                .reapprove_scope_with_retry(&h.quote.id, &h.quote.digest, true, true, Some(1)),
            Err(AiError::UnknownOutcome)
        ));
        let detail = h.store.transcript_result_detail(&h.quote.id, 0).unwrap();
        let candidate = h
            .store
            .reparse_transcript_evidence(&h.quote.id, 0, detail.evidence_sha256.as_deref().unwrap())
            .unwrap();
        assert!(h
            .store
            .select_transcript_reparse(&h.quote.id, 0, &candidate.id)
            .is_err());
        assert_accounts(&h.store, 0, 2 * hold, if unpriced { 2 } else { 0 });
        h.store.acknowledge_unknown(&id).unwrap();
        assert_accounts(&h.store, 0, 2 * hold, if unpriced { 2 } else { 0 });
        let renewed = h
            .store
            .reapprove_scope_with_retry(&h.quote.id, &h.quote.digest, true, true, Some(1))
            .unwrap();
        assert_ne!(approval, renewed);
        assert_accounts(&h.store, 0, 2 * hold, if unpriced { 2 } else { 0 });
        assert!(matches!(
            execute_scoped_with_io(
                &h.store,
                &h.auth,
                &h.transport,
                &h.quote.id,
                Some(&approval),
                || Ok(())
            )
            .await,
            Err(AiError::Superseded)
        ));
        assert_eq!(h.sends(), 2);
        advance_pacing(&h.store, &h.quote.id);
        let result = execute_scoped_with_io(
            &h.store,
            &h.auth,
            &h.transport,
            &h.quote.id,
            Some(&renewed),
            || Ok(()),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(result.ordinal, 0);
        assert_eq!(
            result.charged_microusd,
            if unpriced { None } else { Some(60) }
        );
        assert_accounts(
            &h.store,
            if unpriced { 0 } else { 60 },
            2 * hold,
            if unpriced { 3 } else { 0 },
        );
        assert_eq!(h.store.quote(&h.quote.id).unwrap().state, "completed");
        assert!(execute_scoped_with_io(
            &h.store,
            &h.auth,
            &h.transport,
            &h.quote.id,
            Some(&renewed),
            || Ok(())
        )
        .await
        .is_err());
        assert_eq!(h.sends(), 3);
    }
}

// Catches moving the worker's generation fence after evidence/settlement. A
// transport outcome can become unknown and be reviewed before late bytes arrive.
#[tokio::test]
async fn renewed_approval_fences_old_worker_completion_before_evidence_or_settlement() {
    let directory = tempfile::tempdir().unwrap();
    let h = Harness::with_tasks(
        vec![transcript_task(directory.path())],
        vec![Ok(FakeResponse::json(transcript_response()))],
    );
    let old = h.store.current_approval_id(&h.quote.id).unwrap().unwrap();
    let store = h.store.clone();
    let job = h.quote.id.clone();
    let digest = h.quote.digest.clone();
    let db_path = h.transport.db_path.clone();
    *h.transport.hook.lock().unwrap() = Some(Box::new(move || {
        let id = attempt(&db_path, &job);
        store.mark_unknown(&id).unwrap();
        store.acknowledge_unknown(&id).unwrap();
        store.reapprove(&job, &digest).unwrap();
    }));
    assert!(matches!(
        execute_scoped_with_io(
            &h.store,
            &h.auth,
            &h.transport,
            &h.quote.id,
            Some(&old),
            || Ok(())
        )
        .await,
        Err(AiError::Superseded)
    ));
    assert_accounts(&h.store, 0, h.quote.estimated_max_microusd.unwrap(), 0);
    assert_eq!(h.store.quote(&h.quote.id).unwrap().state, "approved");
    assert_eq!(h.store.quote(&h.quote.id).unwrap().completed_requests, 0);
    assert!(h.store.response(&h.quote.id, 0).unwrap().is_none());
    let evidence: i64 = Connection::open(&h.transport.db_path)
        .unwrap()
        .query_row("SELECT COUNT(*) FROM ai_transcript_evidence", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(evidence, 0);
    assert_eq!(h.sends(), 1);
}

// Raw settlement deliberately accepts unknown, unlike a scoped live worker.
// It is not an approval/evidence validator. Restart destroys the old workers;
// this direct call documents the lower-level recovery boundary, not a live
// worker surviving a process crash. Final accepted_unknown cannot be settled.
#[test]
fn reopen_unknown_raw_settlement_is_once_only_and_acknowledged_unknown_is_final() {
    for acknowledged in [false, true] {
        let h = Harness::new(vec![]);
        let reserved = h.store.reserve_next(&h.quote.id).unwrap().unwrap();
        h.store.validate_dispatch(&reserved).unwrap();
        let reopened = AiStore::open(&h.transport.db_path).unwrap();
        assert_eq!(reopened.recover_interrupted().unwrap(), 1);
        assert_accounts(&reopened, 0, reserved.reserved_microusd.unwrap(), 0);
        assert!(reopened.validate_dispatch(&reserved).is_err());
        if acknowledged {
            reopened.acknowledge_unknown(&reserved.attempt_id).unwrap();
        }
        let settle = || {
            reopened.settle(
                &reserved.attempt_id,
                17,
                &json!({"promptTokenCount":1,"candidatesTokenCount":1}),
                Some(&ParsedOutput::Vocabulary { items: vec![] }),
                None,
            )
        };
        if acknowledged {
            assert!(settle().is_err());
            assert_accounts(&reopened, 0, reserved.reserved_microusd.unwrap(), 0);
            assert!(reopened.response(&h.quote.id, 0).unwrap().is_none());
        } else {
            settle().unwrap();
            assert!(settle().is_err());
            assert_accounts(&reopened, 17, 0, 0);
            assert!(reopened.response(&h.quote.id, 0).unwrap().is_some());
        }
        assert_eq!(h.sends(), 0);
        assert_eq!(reopened.quote(&h.quote.id).unwrap().state, "needs_review");
    }
}
