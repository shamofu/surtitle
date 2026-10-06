use super::accounting::{period_breakdown, period_starts};
use super::*;
use crate::sha256_bytes;
const AT: i64 = 1_788_825_600_000; // before the catalog expiry
pub(super) fn plan() -> PreparedJob {
    PreparedJob::fixture(
        "Sample".into(),
        "sample-project".into(),
        "key1".into(),
        PreparationBinding {
            media_id: "media".into(),
            transcript_revision: "1".into(),
            source_sha256: sha256_bytes(b"source"),
            settings_sha256: sha256_bytes(b"settings"),
        },
        vec![RequestTask::Vocabulary {
            learning_language: "en".into(),
            explanation_language: "ja".into(),
            cues: vec![SourceCue {
                id: "cue".into(),
                start_ms: 0,
                end_ms: 1000,
                text: "I look forward to it.".into(),
            }],
            max_items: 5,
        }],
    )
}
pub(super) fn store() -> (tempfile::TempDir, AiStore) {
    let d = tempfile::tempdir().unwrap();
    let s = AiStore::open(d.path().join("ai.db")).unwrap();
    (d, s)
}
pub(super) fn enable(s: &AiStore) {
    s.set_budget(BudgetLimits {
        per_job_microusd: 10_000_000,
        daily_microusd: 10_000_000,
        monthly_microusd: 100_000_000,
    })
    .unwrap();
}
#[test]
fn default_store_cannot_approve_reserve_or_dispatch_a_validation_database() {
    for marker in [
        "ai_validation_settings",
        "ai_validation_campaigns",
        "ai_validation_campaign_jobs",
    ] {
        for stage in 0..3 {
            let (directory, store) = store();
            enable(&store);
            let quote = store.prepare(plan()).unwrap();
            if stage > 0 {
                store.approve(&quote.id, &quote.digest).unwrap();
            }
            let reserved = if stage == 2 {
                store.reserve_next(&quote.id).unwrap()
            } else {
                None
            };
            // A hand-authored marker is sufficient to prove that builds
            // without development-validation also reject this database.
            store
                .connect()
                .unwrap()
                .execute_batch(&format!("CREATE TABLE {marker} (id INTEGER)"))
                .unwrap();
            let reopened = AiStore::open(directory.path().join("ai.db")).unwrap();
            let before = serde_json::to_value(reopened.summary().unwrap()).unwrap();
            let result = match stage {
                0 => reopened.approve(&quote.id, &quote.digest),
                1 => reopened.reserve_next(&quote.id).map(|_| ()),
                _ => reopened.validate_dispatch(reserved.as_ref().unwrap()),
            };
            assert!(matches!(result, Err(AiError::ApprovalRequired)));
            assert_eq!(
                serde_json::to_value(reopened.summary().unwrap()).unwrap(),
                before
            );
            let dispatched: i64 = reopened
                .connect()
                .unwrap()
                .query_row(
                    "SELECT COUNT(*) FROM ai_attempts WHERE dispatched_at_ms IS NOT NULL",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(dispatched, 0);
        }
    }
}

#[cfg(feature = "development-validation")]
#[test]
fn untimed_diagnostic_cannot_use_an_ordinary_store_after_feature_unification() {
    let (_directory, store) = store();
    enable(&store);
    let source = plan();
    let request = RequestTask::TranscribeDiagnostic {
        language: "en".into(),
        audio: AudioAttachment {
            path: "unused.wav".into(),
            sha256: sha256_bytes(b"audio"),
            byte_len: 4,
            mime_type: "audio/wav".into(),
            source_start_ms: 0,
            duration_ms: 1000,
        },
    };
    let prepared = PreparedJob::fixture(
        source.title,
        source.project_id,
        source.credential_id,
        source.binding,
        vec![request],
    );
    let quote = store.prepare(prepared).unwrap();
    assert!(matches!(
        store.approve(&quote.id, &quote.digest),
        Err(AiError::ApprovalRequired)
    ));
    assert!(store.reserve_next(&quote.id).is_err());
    assert_eq!(store.summary().unwrap().monthly_charged_or_held_microusd, 0);
}
#[test]
fn zero_is_unlimited_and_preparation_is_deduplicated() {
    let (_d, s) = store();
    let q = s.prepare_at(plan(), AT).unwrap();
    assert_eq!(q.id, s.prepare_at(plan(), AT).unwrap().id);
    s.approve_at(&q.id, &q.digest, AT, false).unwrap();
    assert!(s.reserve_next_at(&q.id, AT).unwrap().is_some());
}

#[test]
fn positive_caps_are_enforced_when_other_caps_are_unlimited() {
    for (limits, expected) in [
        (
            BudgetLimits {
                per_job_microusd: 1,
                daily_microusd: 0,
                monthly_microusd: 0,
            },
            "job",
        ),
        (
            BudgetLimits {
                per_job_microusd: 0,
                daily_microusd: 1,
                monthly_microusd: 0,
            },
            "daily",
        ),
        (
            BudgetLimits {
                per_job_microusd: 0,
                daily_microusd: 0,
                monthly_microusd: 1,
            },
            "monthly",
        ),
    ] {
        let (_d, s) = store();
        s.set_budget(limits).unwrap();
        let q = s.prepare_at(plan(), AT).unwrap();
        assert!(
            matches!(s.approve_at(&q.id, &q.digest, AT, false), Err(AiError::BudgetExceeded(label)) if label == expected)
        );
    }
}
#[test]
fn digest_and_expiry_are_enforced() {
    let (_d, s) = store();
    enable(&s);
    let q = s.prepare_at(plan(), AT).unwrap();
    assert!(s.approve_at(&q.id, "changed", AT, false).is_err());
    assert!(s
        .approve_at(&q.id, &q.digest, AT + 1_800_001, false)
        .is_err());
    assert!(matches!(
        s.approve_at(&q.id, &q.digest, AT + 60 * 24 * 60 * 60 * 1000, false),
        Err(AiError::ApprovalRequired)
    ));
}
#[test]
fn concurrent_claim_has_exactly_one_winner() {
    let (_d, s) = store();
    enable(&s);
    let q = s.prepare_at(plan(), AT).unwrap();
    s.approve_at(&q.id, &q.digest, AT, false).unwrap();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let handles: Vec<_> = (0..2)
        .map(|_| {
            let s = s.clone();
            let id = q.id.clone();
            let b = barrier.clone();
            std::thread::spawn(move || {
                b.wait();
                s.reserve_next_at(&id, AT).is_ok()
            })
        })
        .collect();
    assert_eq!(
        handles
            .into_iter()
            .map(|h| h.join().unwrap())
            .filter(|won| *won)
            .count(),
        1
    );
}
#[test]
fn restart_unknown_requires_two_explicit_steps_and_preserves_charge() {
    let (d, s) = store();
    enable(&s);
    let q = s.prepare_at(plan(), AT).unwrap();
    s.approve_at(&q.id, &q.digest, AT, false).unwrap();
    let r = s.reserve_next_at(&q.id, AT).unwrap().unwrap();
    let reopened = AiStore::open(d.path().join("ai.db")).unwrap();
    assert_eq!(reopened.recover_interrupted().unwrap(), 1);
    assert!(reopened.approve_at(&q.id, &q.digest, AT, true).is_err());
    reopened.acknowledge_unknown(&r.attempt_id).unwrap();
    assert!(reopened.reserve_next_at(&q.id, AT).is_err());
    reopened.approve_at(&q.id, &q.digest, AT, true).unwrap();
    let r2 = reopened.reserve_next_at(&q.id, AT).unwrap().unwrap();
    assert_ne!(r.attempt_id, r2.attempt_id);
    assert_eq!(
        reopened
            .quote(&q.id)
            .unwrap()
            .already_charged_or_held_microusd,
        r.reserved_microusd.unwrap() * 2
    );
}
#[test]
fn successful_request_is_not_replayed_and_usage_settles_once() {
    let (_d, s) = store();
    enable(&s);
    let q = s.prepare_at(plan(), AT).unwrap();
    s.approve_at(&q.id, &q.digest, AT, false).unwrap();
    let r = s.reserve_next_at(&q.id, AT).unwrap().unwrap();
    let response = ParsedOutput::Vocabulary { items: vec![] };
    s.settle(
        &r.attempt_id,
        120,
        &serde_json::json!({}),
        Some(&response),
        None,
    )
    .unwrap();
    assert!(s
        .settle(
            &r.attempt_id,
            120,
            &serde_json::json!({}),
            Some(&response),
            None
        )
        .is_err());
    assert_eq!(s.quote(&q.id).unwrap().state, "completed");
    assert!(s.approve_at(&q.id, &q.digest, AT, true).is_err());
}
#[test]
fn changing_budget_after_approval_blocks_dispatch() {
    let (_d, s) = store();
    enable(&s);
    let q = s.prepare_at(plan(), AT).unwrap();
    s.approve_at(&q.id, &q.digest, AT, false).unwrap();
    s.set_budget(BudgetLimits {
        per_job_microusd: 1,
        daily_microusd: 1,
        monthly_microusd: 1,
    })
    .unwrap();
    assert!(matches!(
        s.reserve_next_at(&q.id, AT),
        Err(AiError::BudgetExceeded(_))
    ));
}
#[test]
fn midnight_budgets_use_utc_calendar() {
    let at = chrono::DateTime::parse_from_rfc3339("2026-09-01T00:00:00Z")
        .unwrap()
        .timestamp_millis();
    assert_eq!(period_starts(at).unwrap(), (at, at));
}

#[test]
fn preview_requires_explicit_unqualified_scope_acknowledgement() {
    let (_d, s) = store();
    enable(&s);
    let mut p = plan();
    p.requests = vec![RequestTask::TranscribePreview {
        language: "en-US".into(),
        audio: AudioAttachment {
            path: "fixture.flac".into(),
            sha256: sha256_bytes(b"fixture"),
            byte_len: 7,
            mime_type: "audio/flac".into(),
            source_start_ms: 0,
            duration_ms: 1000,
        },
    }];
    let q = s.prepare_at(p.refreeze(), AT).unwrap();
    assert!(matches!(
        s.approve_scope(&q.id, &q.digest, false, false),
        Err(AiError::ApprovalRequired)
    ));
    assert_eq!(s.quote(&q.id).unwrap().already_charged_or_held_microusd, 0);
}

#[test]
fn summary_separates_actual_and_unresolved_without_refunding_unknown() {
    let (_d, s) = store();
    enable(&s);
    let q = s.prepare_at(plan(), AT).unwrap();
    s.approve_at(&q.id, &q.digest, AT, false).unwrap();
    let r = s.reserve_next_at(&q.id, AT).unwrap().unwrap();
    let conn = s.connect().unwrap();
    assert_eq!(
        period_breakdown(&conn, AT).unwrap(),
        (0, r.reserved_microusd.unwrap())
    );
    s.mark_unknown(&r.attempt_id).unwrap();
    s.acknowledge_unknown(&r.attempt_id).unwrap();
    assert_eq!(
        period_breakdown(&conn, AT).unwrap(),
        (0, r.reserved_microusd.unwrap())
    );
    assert!(s
        .release_unsent(&r.attempt_id, "cannot_refund_accepted_unknown")
        .is_err());
}
