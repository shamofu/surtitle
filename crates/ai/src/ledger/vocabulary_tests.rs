use super::*;
use crate::{OutputFailureReason, TextFailurePolicy};
use serde_json::json;

fn plan(count: usize) -> PreparedJob {
    let original = super::tests::plan();
    PreparedJob::new(
        original.title,
        original.project_id,
        original.credential_id,
        original.binding,
        vec![original.requests[0].clone(); count],
        original.execution,
    )
    .unwrap()
    .with_text_failure_policy(TextFailurePolicy::SkipRejected)
    .unwrap()
}

fn approve(store: &AiStore, plan: PreparedJob) -> (JobQuote, String) {
    super::tests::enable(store);
    let quote = store.prepare(plan).unwrap();
    let approval = store
        .approve_scope_with_retry(&quote.id, &quote.digest, false, true, None)
        .unwrap();
    (quote, approval)
}

fn reserve(store: &AiStore, quote: &JobQuote, approval: &str) -> ReservedRequest {
    let request = store
        .reserve_next_scoped(&quote.id, approval)
        .unwrap()
        .unwrap();
    store.validate_dispatch(&request).unwrap();
    request
}

fn settle(store: &AiStore, request: &ReservedRequest, rejected: bool) {
    let usage = json!({"promptTokenCount": 10, "candidatesTokenCount": 10});
    if rejected {
        store
            .settle_rejected(
                request,
                Some(42),
                &usage,
                OutputFailureReason::InvalidFields,
            )
            .unwrap();
    } else {
        store
            .settle(
                &request.attempt_id,
                42,
                &usage,
                Some(&ParsedOutput::Vocabulary { items: vec![] }),
                None,
            )
            .unwrap();
    }
}

#[test]
fn rejected_batches_are_skipped_once_and_drained_work_never_remains_running() {
    for rejected in [
        [false, true, false],
        [true, false, false],
        [false, false, true],
        [true, true, true],
        [false, false, false],
    ] {
        let (_directory, store) = super::tests::store();
        let (quote, approval) = approve(&store, plan(3));
        for (ordinal, failed) in rejected.into_iter().enumerate() {
            let request = reserve(&store, &quote, &approval);
            assert_eq!(request.ordinal, ordinal as u32);
            settle(&store, &request, failed);
            if ordinal < 2 {
                assert_eq!(store.quote(&quote.id).unwrap().state, "approved");
            }
        }
        let final_quote = store.quote(&quote.id).unwrap();
        let rejected_count = rejected.into_iter().filter(|failed| *failed).count() as u32;
        assert_eq!(
            final_quote.state,
            if rejected_count > 0 {
                "needs_review"
            } else {
                "completed"
            }
        );
        assert_eq!(
            final_quote.request_counts,
            RequestCounts {
                total: 3,
                succeeded: 3 - rejected_count,
                rejected: rejected_count,
                pending: 0,
                in_flight: 0
            }
        );
        assert_eq!(
            store.summary().unwrap().monthly_actual_charged_microusd,
            126
        );
        let attempts: u32 = store
            .connect()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM ai_attempts", [], |row| row.get(0))
            .unwrap();
        assert_eq!(attempts, 3);
        assert!(store.reserve_next_scoped(&quote.id, &approval).is_err());
    }
}

#[test]
fn separate_approval_retries_only_rejected_batches_and_retains_previous_charges() {
    let (_directory, store) = super::tests::store();
    let (quote, approval) = approve(&store, plan(3));
    for failed in [false, true, false] {
        settle(&store, &reserve(&store, &quote, &approval), failed);
    }
    assert_eq!(store.quote(&quote.id).unwrap().remaining_ordinals, [1]);
    let next = store
        .reapprove_scope_with_retry(&quote.id, &quote.digest, false, true, None)
        .unwrap();
    let request = reserve(&store, &quote, &next);
    assert_eq!(request.ordinal, 1);
    settle(&store, &request, false);
    assert_eq!(store.quote(&quote.id).unwrap().state, "completed");
    assert_eq!(
        store.summary().unwrap().monthly_actual_charged_microusd,
        168
    );
}

#[test]
fn legacy_plans_still_stop_on_rejected_output_and_keep_their_serialized_identity() {
    let new = plan(2);
    let legacy = new
        .with_text_failure_policy(TextFailurePolicy::FailFast)
        .unwrap();
    let serialized = serde_json::to_value(&legacy).unwrap();
    assert!(serialized.get("text_failure_policy").is_none());
    let restored: PreparedJob = serde_json::from_value(serialized).unwrap();
    assert_eq!(legacy.digest().unwrap(), restored.digest().unwrap());
    assert_eq!(restored.text_failure_policy, TextFailurePolicy::FailFast);
    let (_directory, store) = super::tests::store();
    let (quote, approval) = approve(&store, restored);
    settle(&store, &reserve(&store, &quote, &approval), true);
    assert_eq!(store.quote(&quote.id).unwrap().state, "needs_review");
    assert!(store.reserve_next_scoped(&quote.id, &approval).is_err());
}

#[test]
fn skip_policy_survives_execution_changes_and_cannot_be_used_for_translation() {
    let original = plan(2);
    let changed = original
        .clone()
        .with_execution(original.execution.clone())
        .unwrap();
    assert_eq!(original.digest().unwrap(), changed.digest().unwrap());
    let mut tasks = original.requests.clone();
    let RequestTask::Vocabulary { cues, .. } = tasks.remove(0) else {
        unreachable!()
    };
    let translation = PreparedJob::new(
        original.title,
        original.project_id,
        original.credential_id,
        original.binding,
        vec![RequestTask::Translation {
            target_language: "ja".into(),
            cues,
        }],
        original.execution,
    )
    .unwrap();
    assert!(translation
        .with_text_failure_policy(TextFailurePolicy::SkipRejected)
        .is_err());
}

#[test]
fn unsettled_or_over_budget_rejections_never_allow_the_next_request() {
    for block in ["unknown", "tokens", "cost", "usage", "paused", "cancelled"] {
        let (_directory, store) = super::tests::store();
        let (quote, approval) = approve(&store, plan(2));
        let request = reserve(&store, &quote, &approval);
        let mut usage = json!({"promptTokenCount": 10, "candidatesTokenCount": 10});
        let mut cost = 42;
        match block {
            "unknown" => {
                store.mark_unknown(&request.attempt_id).unwrap();
            }
            _ => {
                match block {
                    "tokens" => {
                        usage["candidatesTokenCount"] =
                            json!(request.execution.max_output_tokens + 1)
                    }
                    "cost" => cost = request.reserved_microusd.unwrap() + 1,
                    "usage" => usage = json!({}),
                    "paused" => store.pause(&quote.id).unwrap(),
                    "cancelled" => store.cancel(&quote.id).unwrap(),
                    _ => unreachable!(),
                }
                store
                    .settle_rejected(
                        &request,
                        Some(cost),
                        &usage,
                        OutputFailureReason::InvalidFields,
                    )
                    .unwrap();
            }
        }
        assert_ne!(store.quote(&quote.id).unwrap().state, "approved", "{block}");
        assert!(
            store.reserve_next_scoped(&quote.id, &approval).is_err(),
            "{block}"
        );
    }
}

#[test]
fn unpriced_but_known_usage_can_continue_within_the_approved_scope() {
    let (_directory, store) = super::tests::store();
    let original = plan(2);
    let mut execution = original.execution.clone();
    execution.price = None;
    let quote = store
        .prepare(original.with_execution(execution).unwrap())
        .unwrap();
    let approval = store
        .approve_scope_with_retry(&quote.id, &quote.digest, true, true, None)
        .unwrap();
    let request = reserve(&store, &quote, &approval);
    store
        .settle_rejected(
            &request,
            None,
            &json!({"promptTokenCount":10,"candidatesTokenCount":10}),
            OutputFailureReason::InvalidFields,
        )
        .unwrap();
    assert_eq!(store.quote(&quote.id).unwrap().state, "approved");
    assert_eq!(reserve(&store, &quote, &approval).ordinal, 1);
    assert_eq!(store.summary().unwrap().unpriced_attempts, 2);
}
