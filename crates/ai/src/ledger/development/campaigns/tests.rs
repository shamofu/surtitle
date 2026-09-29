use super::super::tests::{approval, setup};
use super::*;

fn campaign(store: &AiStore, quote: &JobQuote) -> ValidationCampaignQuote {
    store
        .quote_validation_campaign(
            "Offline fixture",
            std::slice::from_ref(&quote.id),
            store.now_ms() + 60_000,
        )
        .unwrap()
}
fn scoped(
    store: &AiStore,
    quote: &JobQuote,
    campaign: &ValidationCampaignQuote,
) -> Result<AiStore> {
    store.with_development_campaign(&quote.id, &campaign.id, &campaign.digest, approval(quote))
}
fn next_job(store: &AiStore, initial: &JobQuote, title: &str) -> JobQuote {
    let mut plan = store.prepared_job(&initial.id).unwrap();
    plan.title = title.into();
    store.prepare(plan.refreeze()).unwrap()
}

#[test]
fn quote_never_authorizes_and_exact_approval_binds_every_limit() {
    let (_directory, store, quote) = setup();
    let campaign = campaign(&store, &quote);
    assert!(scoped(&store, &quote, &campaign).is_err());
    assert!(store
        .with_development_validation(&quote.id, approval(&quote))
        .is_err());
    assert!(store
        .approve_scope(&quote.id, &quote.digest, false, true)
        .is_err());
    for index in 0..6 {
        let mut accepted = campaign.approval();
        match index {
            0 => accepted.digest = crate::sha256_bytes(b"other"),
            1 => accepted.max_requests += 1,
            2 => accepted.max_audio_duration_ms += 1,
            3 => accepted.max_reservation_microusd += 1,
            4 => accepted.total_limit_microusd += 1,
            _ => accepted.expires_at_ms += 1,
        }
        assert!(store
            .approve_validation_campaign(&campaign.id, accepted)
            .is_err());
    }
    store
        .approve_validation_campaign(&campaign.id, campaign.approval())
        .unwrap();
    assert!(store
        .approve_validation_campaign(&campaign.id, campaign.approval())
        .is_err());
    let scoped = scoped(&store, &quote, &campaign).unwrap();
    scoped.approve(&quote.id, &quote.digest).unwrap();
    let reservation = scoped.reserve_next(&quote.id).unwrap().unwrap();
    scoped.validate_dispatch(&reservation).unwrap();
    let totals = store.validation_totals().unwrap();
    assert_eq!(totals.attempted_requests, 1);
    assert_eq!(totals.campaign_attempted_requests, 1);
    assert_eq!(totals.legacy_attempted_requests, 0);
    assert_eq!(totals.remaining_requests, 120);
    assert_eq!(
        totals.charged_or_held_microusd,
        reservation.reserved_microusd.unwrap()
    );
    assert!(store.validate_dispatch(&reservation).is_err());
}

#[test]
fn exhausted_legacy_scope_is_unchanged_and_campaign_attempts_are_separate() {
    let (_directory, store, first) = setup();
    // Exercise the actual 120-attempt ceiling without lowering the durable cap.
    for index in 0..120 {
        let scoped = store
            .with_development_validation(&first.id, approval(&first))
            .unwrap();
        if index == 0 {
            scoped.approve(&first.id, &first.digest)
        } else {
            scoped.reapprove(&first.id, &first.digest)
        }
        .unwrap();
        let reservation = scoped.reserve_next(&first.id).unwrap().unwrap();
        scoped
            .release_unsent(&reservation.attempt_id, "offline_fixture")
            .unwrap();
    }
    let next = next_job(&store, &first, "Campaign after legacy exhaustion");
    let legacy = store
        .with_development_validation(&next.id, approval(&next))
        .unwrap();
    assert!(matches!(
        legacy.approve(&next.id, &next.digest),
        Err(AiError::BudgetExceeded("validation request count"))
    ));
    let campaign = campaign(&store, &next);
    store
        .approve_validation_campaign(&campaign.id, campaign.approval())
        .unwrap();
    let scoped = scoped(&store, &next, &campaign).unwrap();
    scoped.approve(&next.id, &next.digest).unwrap();
    let reservation = scoped.reserve_next(&next.id).unwrap().unwrap();
    scoped.validate_dispatch(&reservation).unwrap();
    let totals = store.validation_totals().unwrap();
    assert_eq!(
        (totals.max_requests, totals.max_audio_duration_ms),
        (120, 5_400_000)
    );
    assert_eq!(
        (
            totals.attempted_requests,
            totals.legacy_attempted_requests,
            totals.remaining_requests
        ),
        (121, 120, 0)
    );
    assert_eq!(totals.legacy_attempted_audio_duration_ms, 120_000);
    assert_eq!(totals.attempted_audio_duration_ms, 121_000);
    assert!(store.initialize_validation_total(10_000_000).is_err());
}

#[test]
fn no_retry_or_scope_reconstruction_after_restart_even_for_released_requests() {
    for unknown in [false, true] {
        let (directory, store, quote) = setup();
        let campaign = campaign(&store, &quote);
        store
            .approve_validation_campaign(&campaign.id, campaign.approval())
            .unwrap();
        let permit = scoped(&store, &quote, &campaign).unwrap();
        permit.approve(&quote.id, &quote.digest).unwrap();
        let reservation = permit.reserve_next(&quote.id).unwrap().unwrap();
        if unknown {
            permit.mark_unknown(&reservation.attempt_id).unwrap();
            permit.acknowledge_unknown(&reservation.attempt_id).unwrap();
        } else {
            permit
                .release_unsent(&reservation.attempt_id, "offline_fixture")
                .unwrap();
        }
        assert!(permit.reapprove(&quote.id, &quote.digest).is_err());
        let reopened = AiStore::open(directory.path().join("validation.sqlite")).unwrap();
        assert!(scoped(&reopened, &quote, &campaign).is_err());
        assert!(reopened
            .with_development_validation(&quote.id, approval(&quote))
            .is_err());
        assert!(reopened
            .quote_validation_campaign("Retry forbidden", &[quote.id], reopened.now_ms() + 60_000)
            .is_err());
        assert_eq!(
            reopened
                .validation_totals()
                .unwrap()
                .charged_or_held_microusd,
            if unknown {
                reservation.reserved_microusd.unwrap()
            } else {
                0
            }
        );
    }
}

#[test]
fn known_charges_and_unknown_holds_share_original_lifetime_pool_once() {
    let (_directory, store, first) = setup();
    let legacy = store
        .with_development_validation(&first.id, approval(&first))
        .unwrap();
    legacy.approve(&first.id, &first.digest).unwrap();
    let held = legacy.reserve_next(&first.id).unwrap().unwrap();
    legacy.mark_unknown(&held.attempt_id).unwrap();
    legacy.acknowledge_unknown(&held.attempt_id).unwrap();
    let next = next_job(&store, &first, "Campaign shared monetary pool");
    let campaign = campaign(&store, &next);
    store
        .approve_validation_campaign(&campaign.id, campaign.approval())
        .unwrap();
    let permit = scoped(&store, &next, &campaign).unwrap();
    permit.approve(&next.id, &next.digest).unwrap();
    let reservation = permit.reserve_next(&next.id).unwrap().unwrap();
    permit
        .settle(
            &reservation.attempt_id,
            10,
            &serde_json::json!({"promptTokenCount":1}),
            None,
            Some("offline_fixture"),
        )
        .unwrap();
    assert_eq!(
        store.validation_totals().unwrap().charged_or_held_microusd,
        held.reserved_microusd.unwrap() + 10
    );
    assert_eq!(
        store.validation_totals().unwrap().total_limit_microusd,
        2_000_000
    );
}

#[test]
fn quote_and_approval_tampering_and_expiry_fail_before_dispatch() {
    for mutation in 0..4 {
        let (_directory, store, quote) = setup();
        let campaign = campaign(&store, &quote);
        store
            .approve_validation_campaign(&campaign.id, campaign.approval())
            .unwrap();
        let permit = scoped(&store, &quote, &campaign).unwrap();
        permit.approve(&quote.id, &quote.digest).unwrap();
        let reservation = permit.reserve_next(&quote.id).unwrap().unwrap();
        let connection = store.connect().unwrap();
        match mutation {
            0 => {
                connection
                    .execute(
                        "UPDATE ai_validation_campaigns SET digest='tampered' WHERE id=?",
                        [&campaign.id],
                    )
                    .unwrap();
            }
            1 => {
                let mut value = campaign.clone();
                value.jobs[0].execution.model_id = "other-model".into();
                connection
                    .execute(
                        "UPDATE ai_validation_campaigns SET quote_json=? WHERE id=?",
                        params![serde_json::to_string(&value).unwrap(), campaign.id],
                    )
                    .unwrap();
            }
            2 => {
                connection
                    .execute(
                        "UPDATE ai_validation_campaigns SET approval_json=NULL WHERE id=?",
                        [&campaign.id],
                    )
                    .unwrap();
            }
            _ => permit.set_test_time(campaign.expires_at_ms),
        }
        assert!(permit.validate_dispatch(&reservation).is_err());
    }
}

#[test]
fn concurrent_claims_count_exactly_one_attempt() {
    let (_directory, store, quote) = setup();
    let campaign = campaign(&store, &quote);
    store
        .approve_validation_campaign(&campaign.id, campaign.approval())
        .unwrap();
    let permit = scoped(&store, &quote, &campaign).unwrap();
    permit.approve(&quote.id, &quote.digest).unwrap();
    let handles: Vec<_> = (0..4)
        .map(|_| {
            let permit = permit.clone();
            let id = quote.id.clone();
            std::thread::spawn(move || permit.reserve_next(&id).ok().flatten())
        })
        .collect();
    assert_eq!(
        handles
            .into_iter()
            .filter_map(|handle| handle.join().unwrap())
            .count(),
        1
    );
    assert_eq!(store.validation_totals().unwrap().attempted_requests, 1);
}

#[test]
fn a_campaign_approval_does_not_reserve_or_expand_lifetime_money() {
    let (_directory, store, first) = setup();
    let next = next_job(&store, &first, "Separate priced candidate");
    let quoted = store
        .quote_validation_campaign(
            "Two reviewed requests",
            &[first.id.clone(), next.id.clone()],
            store.now_ms() + 60_000,
        )
        .unwrap();
    store
        .approve_validation_campaign(&quoted.id, quoted.approval())
        .unwrap();
    assert_eq!(
        store.validation_totals().unwrap().charged_or_held_microusd,
        0
    );
    let first_permit = scoped(&store, &first, &quoted).unwrap();
    first_permit.approve(&first.id, &first.digest).unwrap();
    let first_reservation = first_permit.reserve_next(&first.id).unwrap().unwrap();
    first_permit
        .settle(
            &first_reservation.attempt_id,
            2_000_000,
            &serde_json::json!({"promptTokenCount":1}),
            None,
            Some("offline_fixture"),
        )
        .unwrap();
    let next_permit = scoped(&store, &next, &quoted).unwrap();
    assert!(next_permit.approve(&next.id, &next.digest).is_err());
    assert_eq!(store.validation_totals().unwrap().attempted_requests, 1);
    assert_eq!(
        store.validation_totals().unwrap().charged_or_held_microusd,
        2_000_000
    );
}

#[test]
fn unpriced_jobs_and_previously_attempted_jobs_cannot_join() {
    let (_directory, store, quote) = setup();
    let mut plan = store.prepared_job(&quote.id).unwrap();
    plan.execution.price = None;
    let unpriced = store.prepare(plan.refreeze()).unwrap();
    assert!(store
        .quote_validation_campaign("Unpriced", &[unpriced.id], store.now_ms() + 60_000)
        .is_err());
    let scoped = store
        .with_development_validation(&quote.id, approval(&quote))
        .unwrap();
    scoped.approve(&quote.id, &quote.digest).unwrap();
    scoped.reserve_next(&quote.id).unwrap();
    assert!(store
        .quote_validation_campaign("Old request", &[quote.id], store.now_ms() + 60_000)
        .is_err());
}
