use super::*;
use crate::AiProvider;

fn provider_plan(provider: AiProvider) -> PreparedJob {
    let mut plan = super::tests::plan();
    plan.execution.provider = provider;
    if provider == AiProvider::Openai {
        plan.project_id = "openai".into();
        plan.execution.response_mode = crate::ResponseMode::Responses;
    }
    plan.refreeze()
}

#[test]
fn provider_pacing_lanes_do_not_share_cooldowns_for_the_same_profile_and_model() {
    let (_directory, store) = super::tests::store();
    let mut vertex = provider_plan(AiProvider::Vertex);
    vertex.project_id = "openai".into();
    let openai = provider_plan(AiProvider::Openai);
    // lane() is the actual lookup used by both reservation and final dispatch.
    let conn = store.connect().unwrap();
    conn.execute(
        "INSERT INTO ai_transcription_pacing(project_id,model_id,location,interval_ms,cooldown_until_ms,provider) VALUES (?,?,?,20000,?,'vertex')",
        params![vertex.project_id, vertex.execution.model_id, vertex.execution.location, TEST_NOW_MS + 90_000],
    ).unwrap();
    // Verify lookup behavior via the production pacing guard with real audio tasks.
    let task = RequestTask::TranscribePreview {
        language: "en".into(),
        audio: AudioAttachment {
            path: "unused.flac".into(),
            sha256: crate::sha256_bytes(b"fixture"),
            byte_len: 7,
            mime_type: "audio/flac".into(),
            source_start_ms: 0,
            duration_ms: 1000,
        },
    };
    vertex.requests = vec![task.clone()];
    let vertex = vertex.refreeze();
    let mut openai = openai;
    openai.requests = vec![task];
    openai.execution.response_mode = crate::ResponseMode::AudioTranscriptions;
    let openai = openai.refreeze();
    assert!(matches!(
        store.check_pacing(&conn, &vertex, 0, TEST_NOW_MS),
        Err(AiError::PacingWaiting(_))
    ));
    store.check_pacing(&conn, &openai, 0, TEST_NOW_MS).unwrap();
}

#[test]
fn provider_budgets_and_unknown_holds_are_isolated_but_outbound_lane_is_global() {
    let (_directory, store) = super::tests::store();
    let vertex = store.prepare(provider_plan(AiProvider::Vertex)).unwrap();
    let openai = store.prepare(provider_plan(AiProvider::Openai)).unwrap();
    let cap = vertex.estimated_max_microusd.unwrap();
    let openai_cap = openai.estimated_max_microusd.unwrap();
    let limits = BudgetLimits {
        per_job_microusd: cap,
        daily_microusd: cap,
        monthly_microusd: cap,
    };
    store.set_budget_for(AiProvider::Vertex, limits).unwrap();
    store
        .set_budget_for(
            AiProvider::Openai,
            BudgetLimits {
                per_job_microusd: openai_cap,
                daily_microusd: openai_cap,
                monthly_microusd: openai_cap,
            },
        )
        .unwrap();
    store.approve(&vertex.id, &vertex.digest).unwrap();
    store.approve(&openai.id, &openai.digest).unwrap();
    let first = store.reserve_next(&vertex.id).unwrap().unwrap();
    assert!(matches!(
        store.reserve_next(&openai.id),
        Err(AiError::InFlight)
    ));
    store.mark_unknown(&first.attempt_id).unwrap();
    let mut after_unknown = provider_plan(AiProvider::Openai);
    after_unknown.title = "Approval after Vertex unknown".into();
    let after_unknown = store.prepare(after_unknown).unwrap();
    store
        .approve(&after_unknown.id, &after_unknown.digest)
        .unwrap();
    let second = store.reserve_next(&openai.id).unwrap().unwrap();
    assert_eq!(
        store
            .summary_for(AiProvider::Vertex)
            .unwrap()
            .daily_held_microusd,
        cap
    );
    assert_eq!(
        store
            .summary_for(AiProvider::Openai)
            .unwrap()
            .daily_held_microusd,
        openai_cap
    );
    assert_eq!(
        store.summary().unwrap().unknown_attempts[0].job_id,
        vertex.id
    );
    assert_eq!(
        store
            .summary_for(AiProvider::Openai)
            .unwrap()
            .unknown_attempts[0]
            .job_id,
        openai.id
    );
    store.release_unsent(&second.attempt_id, "fixture").unwrap();
    assert!(matches!(
        store.reapprove(&vertex.id, &vertex.digest),
        Err(AiError::UnknownOutcome)
    ));
    store.acknowledge_unknown(&first.attempt_id).unwrap();
    store.set_test_time(TEST_NOW_MS + 40 * 24 * 60 * 60 * 1000);
    assert_eq!(
        store
            .summary_for(AiProvider::Vertex)
            .unwrap()
            .monthly_held_microusd,
        cap
    );
    assert_eq!(
        store
            .summary_for(AiProvider::Openai)
            .unwrap()
            .monthly_held_microusd,
        0
    );
    assert!(store
        .summary_for(AiProvider::Vertex)
        .unwrap()
        .unknown_attempts
        .is_empty());
}

#[test]
fn settled_charges_follow_frozen_provider_and_expire_from_only_their_period_totals() {
    let (_directory, store) = super::tests::store();
    for (provider, charge) in [(AiProvider::Vertex, 37), (AiProvider::Openai, 51)] {
        let quote = store.prepare(provider_plan(provider)).unwrap();
        store.approve(&quote.id, &quote.digest).unwrap();
        let reservation = store.reserve_next(&quote.id).unwrap().unwrap();
        store
            .settle(
                &reservation.attempt_id,
                charge,
                &serde_json::json!({"promptTokenCount":10,"candidatesTokenCount":10}),
                Some(&ParsedOutput::Vocabulary { items: vec![] }),
                None,
            )
            .unwrap();
    }
    for (provider, charge) in [(AiProvider::Vertex, 37), (AiProvider::Openai, 51)] {
        let summary = store.summary_for(provider).unwrap();
        assert_eq!(summary.daily_actual_charged_microusd, charge);
        assert_eq!(summary.monthly_charged_or_held_microusd, charge);
        assert_eq!(summary.daily_held_microusd, 0);
    }
    store.set_test_time(TEST_NOW_MS + 24 * 60 * 60 * 1000);
    for (provider, charge) in [(AiProvider::Vertex, 37), (AiProvider::Openai, 51)] {
        let summary = store.summary_for(provider).unwrap();
        assert_eq!(summary.daily_actual_charged_microusd, 0);
        assert_eq!(summary.monthly_actual_charged_microusd, charge);
    }
}

#[test]
fn provider_budget_updates_and_unpriced_summary_do_not_cross_profiles() {
    let (_directory, store) = super::tests::store();
    let limits = BudgetLimits {
        per_job_microusd: 1,
        daily_microusd: 2,
        monthly_microusd: 3,
    };
    store.set_budget_for(AiProvider::Openai, limits).unwrap();
    assert_eq!(store.budget().unwrap(), BudgetLimits::default());
    assert_eq!(store.budget_for(AiProvider::Openai).unwrap(), limits);
    let mut plan = provider_plan(AiProvider::Openai);
    plan.execution.price = None;
    let quote = store.prepare(plan.refreeze()).unwrap();
    store
        .approve_scope(&quote.id, &quote.digest, true, true)
        .unwrap();
    store.reserve_next(&quote.id).unwrap().unwrap();
    assert_eq!(
        store
            .summary_for(AiProvider::Openai)
            .unwrap()
            .unpriced_attempts,
        1
    );
    assert!(
        !store
            .summary_for(AiProvider::Openai)
            .unwrap()
            .monetary_totals_complete
    );
    assert_eq!(store.summary().unwrap().unpriced_attempts, 0);
    assert!(store.summary().unwrap().monetary_totals_complete);
}

#[test]
fn failed_version_two_migration_rolls_back_all_schema_and_version_changes() {
    let (directory, store) = super::tests::store();
    let conn = store.connect().unwrap();
    // Simulate damaged pacing evidence: migration must fail without partially
    // upgrading settings, changing stored plans, or stamping schema version 3.
    conn.execute_batch("DROP TABLE ai_provider_settings; DROP TABLE ai_transcription_pacing;
        CREATE TABLE ai_transcription_pacing(project_id TEXT,model_id TEXT,location TEXT,policy_version INTEGER);
        PRAGMA user_version=2;").unwrap();
    drop(conn);
    assert!(AiStore::open(directory.path().join("ai.db")).is_err());
    let conn = store.connect().unwrap();
    assert_eq!(
        conn.query_row("PRAGMA user_version", [], |r| r.get::<_, u32>(0))
            .unwrap(),
        2
    );
    assert!(!conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='ai_provider_settings')",
            [],
            |r| r.get::<_, bool>(0)
        )
        .unwrap());
    assert!(!conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='ai_transcription_pacing_fixed_floor')", [], |r| r.get::<_, bool>(0)).unwrap());
}

#[test]
fn version_two_migration_preserves_plan_bytes_digest_holds_and_vertex_budget() {
    let (directory, store) = super::tests::store();
    super::tests::enable(&store);
    let quote = store.prepare(super::tests::plan()).unwrap();
    store.approve(&quote.id, &quote.digest).unwrap();
    let reservation = store.reserve_next(&quote.id).unwrap().unwrap();
    store.mark_unknown(&reservation.attempt_id).unwrap();
    let conn = store.connect().unwrap();
    let before: (String, String) = conn
        .query_row("SELECT plan_json,digest FROM ai_jobs", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    let summary = serde_json::to_value(store.summary().unwrap()).unwrap();
    assert!(
        serde_json::from_str::<serde_json::Value>(&before.0).unwrap()["execution"]
            .get("provider")
            .is_none()
    );
    // Reconstruct the previous schema, including the provider-free pacing key.
    conn.execute_batch("CREATE TABLE ai_settings(id INTEGER PRIMARY KEY CHECK(id=1),limits_json TEXT NOT NULL);
        INSERT INTO ai_settings SELECT 1,limits_json FROM ai_provider_settings WHERE provider='vertex';
        DROP TABLE ai_provider_settings;
        ALTER TABLE ai_transcription_pacing RENAME TO ai_pacing_v3;
        CREATE TABLE ai_transcription_pacing AS SELECT project_id,model_id,location,interval_ms,success_streak,last_dispatch_ms,cooldown_until_ms,policy_version FROM ai_pacing_v3;
        DROP TABLE ai_pacing_v3;
        PRAGMA user_version=2;").unwrap();
    drop(conn);
    let reopened = AiStore::open(directory.path().join("ai.db")).unwrap();
    assert_eq!(
        serde_json::to_value(reopened.summary().unwrap()).unwrap(),
        summary
    );
    assert_eq!(
        reopened.prepared_job(&quote.id).unwrap().digest().unwrap(),
        quote.digest
    );
    let conn = reopened.connect().unwrap();
    let after: (String, String) = conn
        .query_row("SELECT plan_json,digest FROM ai_jobs", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    assert_eq!(before, after);
    assert_eq!(
        conn.query_row("PRAGMA user_version", [], |r| r.get::<_, u32>(0))
            .unwrap(),
        3
    );
    assert_eq!(
        reopened.budget_for(AiProvider::Openai).unwrap(),
        BudgetLimits::default()
    );
}

#[test]
fn version_two_evaluation_database_is_rejected_without_migration() {
    let (directory, store) = super::tests::store();
    let conn = store.connect().unwrap();
    conn.execute_batch("CREATE TABLE ai_validation_settings(id INTEGER); PRAGMA user_version=2;")
        .unwrap();
    drop(conn);
    assert!(AiStore::open(directory.path().join("ai.db")).is_err());
    assert_eq!(
        store
            .connect()
            .unwrap()
            .query_row("PRAGMA user_version", [], |r| r.get::<_, u32>(0))
            .unwrap(),
        2
    );
}
