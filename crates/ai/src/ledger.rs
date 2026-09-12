use crate::{models::*, AiError, ExecutionConfig, Result};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

mod transcript_evidence;
pub use transcript_evidence::*;

#[cfg(feature = "development-validation")]
mod development;
#[cfg(feature = "development-validation")]
pub use development::{ValidationApproval, ValidationAttempt, ValidationTotals};
#[cfg(feature = "development-validation")]
pub use development::{ValidationCampaignApproval, ValidationCampaignJob, ValidationCampaignQuote};
#[cfg(feature = "e2e-fixtures")]
mod e2e_fixtures;

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct BudgetLimits {
    pub per_job_microusd: u64,
    pub daily_microusd: u64,
    pub monthly_microusd: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobQuote {
    pub id: String,
    pub title: String,
    pub digest: String,
    pub project_id: String,
    pub credential_id: String,
    pub binding: PreparationBinding,
    pub state: String,
    pub requests: Vec<RequestEstimate>,
    pub estimated_max_microusd: Option<u64>,
    pub additional_reservation_microusd: Option<u64>,
    pub remaining_ordinals: Vec<u32>,
    pub completed_requests: u32,
    pub already_charged_or_held_microusd: u64,
    pub audio_duration_ms: u64,
    pub execution: ExecutionConfig,
    pub total_output_tokens: u64,
    pub unpriced_attempts: u64,
    pub quote_expires_at_ms: i64,
    pub created_at_ms: i64,
    pub disclaimer: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpendSummary {
    pub limits: BudgetLimits,
    pub daily_charged_or_held_microusd: u64,
    pub monthly_charged_or_held_microusd: u64,
    pub daily_actual_charged_microusd: u64,
    pub monthly_actual_charged_microusd: u64,
    pub daily_held_microusd: u64,
    pub monthly_held_microusd: u64,
    pub unknown_attempts: Vec<AttemptSummary>,
    pub unpriced_attempts: u64,
    pub monetary_totals_complete: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttemptSummary {
    pub id: String,
    pub job_id: String,
    pub ordinal: u32,
    pub state: String,
    pub held_or_charged_microusd: Option<u64>,
    pub created_at_ms: i64,
}

/// A native-only reservation token. Do not expose this token as a renderer command.
#[derive(Debug, Clone)]
pub struct ReservedRequest {
    pub attempt_id: String,
    pub job_id: String,
    pub ordinal: u32,
    pub task: RequestTask,
    pub project_id: String,
    pub credential_id: String,
    pub reserved_microusd: Option<u64>,
    pub execution: ExecutionConfig,
    pub body_snapshot: serde_json::Value,
}

#[derive(Debug, Clone)]
pub struct AiStore {
    path: PathBuf,
    #[cfg(feature = "development-validation")]
    development: Option<std::sync::Arc<development::DevelopmentScope>>,
    #[cfg(test)]
    clock: std::sync::Arc<std::sync::atomic::AtomicI64>,
}

#[cfg(test)]
pub(crate) const TEST_NOW_MS: i64 = 1_788_825_600_000; // 2026-09-08 00:00:00 UTC

impl AiStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        // Inspect the SQLite header before opening writable SQLite/WAL handles.
        // Older evaluation databases are evidence and are never migrated in place.
        if path.exists() && path.metadata()?.len() != 0 {
            use std::io::Read;
            let mut header = [0u8; 100];
            std::fs::File::open(&path)?.read_exact(&mut header)?;
            if &header[..16] != b"SQLite format 3\0"
                || u32::from_be_bytes(header[60..64].try_into().unwrap()) != 2
            {
                return Err(AiError::Invalid("Existing AI database has a different schema; preserve it and use a new data root".into()));
            }
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let store = Self {
            path,
            #[cfg(feature = "development-validation")]
            development: None,
            #[cfg(test)]
            clock: std::sync::Arc::new(std::sync::atomic::AtomicI64::new(TEST_NOW_MS)),
        };
        let conn = store.connect()?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS ai_settings (id INTEGER PRIMARY KEY CHECK(id=1), limits_json TEXT NOT NULL);
            INSERT OR IGNORE INTO ai_settings VALUES (1, '{\"per_job_microusd\":0,\"daily_microusd\":0,\"monthly_microusd\":0}');
            CREATE TABLE IF NOT EXISTS ai_jobs (
                id TEXT PRIMARY KEY, digest TEXT NOT NULL UNIQUE, plan_json TEXT NOT NULL,
                state TEXT NOT NULL DEFAULT 'prepared', created_at_ms INTEGER NOT NULL,
                quote_expires_at_ms INTEGER NOT NULL, approved_at_ms INTEGER, approval_json TEXT);
            CREATE TABLE IF NOT EXISTS ai_requests (
                job_id TEXT NOT NULL REFERENCES ai_jobs(id), ordinal INTEGER NOT NULL,
                state TEXT NOT NULL DEFAULT 'pending', response_json TEXT, error_code TEXT,
                PRIMARY KEY(job_id,ordinal));
            CREATE TABLE IF NOT EXISTS ai_attempts (
                id TEXT PRIMARY KEY, job_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
                state TEXT NOT NULL, reserve_microusd INTEGER CHECK(reserve_microusd>=0),
                charged_microusd INTEGER CHECK(charged_microusd>=0), created_at_ms INTEGER NOT NULL,
                dispatched_at_ms INTEGER, settled_at_ms INTEGER, usage_json TEXT, model_version TEXT,
                FOREIGN KEY(job_id,ordinal) REFERENCES ai_requests(job_id,ordinal));
            CREATE UNIQUE INDEX IF NOT EXISTS ai_one_outbound_request ON ai_attempts((1)) WHERE state='reserved';
            CREATE INDEX IF NOT EXISTS ai_spend_period ON ai_attempts(created_at_ms);
            CREATE TABLE IF NOT EXISTS ai_audit (id INTEGER PRIMARY KEY, at_ms INTEGER NOT NULL, event TEXT NOT NULL, job_id TEXT, detail TEXT);
            PRAGMA user_version=2;
        ")?;
        transcript_evidence::initialize(&conn)?;
        Ok(store)
    }

    fn connect(&self) -> Result<Connection> {
        let conn = Connection::open(&self.path)?;
        conn.busy_timeout(Duration::from_secs(5))?;
        conn.execute_batch("PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;")?;
        Ok(conn)
    }

    fn now_ms(&self) -> i64 {
        #[cfg(test)]
        {
            self.clock.load(std::sync::atomic::Ordering::SeqCst)
        }
        #[cfg(not(test))]
        {
            crate::now_ms()
        }
    }

    /// Per-store deterministic clock shared by clones, absent from production builds.
    #[cfg(test)]
    pub(crate) fn set_test_time(&self, at: i64) {
        self.clock.store(at, std::sync::atomic::Ordering::SeqCst);
    }

    pub fn budget(&self) -> Result<BudgetLimits> {
        limits(&self.connect()?)
    }

    pub fn set_budget(&self, value: BudgetLimits) -> Result<()> {
        for n in [
            value.per_job_microusd,
            value.daily_microusd,
            value.monthly_microusd,
        ] {
            if n > 1_000_000_000_000 {
                return Err(AiError::Invalid("Budget exceeds supported range".into()));
            }
        }
        let conn = self.connect()?;
        conn.execute(
            "UPDATE ai_settings SET limits_json=? WHERE id=1",
            [serde_json::to_string(&value)?],
        )?;
        audit(
            &conn,
            self.now_ms(),
            "budget_changed",
            None,
            &serde_json::to_string(&value)?,
        )?;
        Ok(())
    }

    pub fn prepare(&self, plan: PreparedJob) -> Result<JobQuote> {
        self.prepare_at(plan, self.now_ms())
    }

    fn prepare_at(&self, plan: PreparedJob, at: i64) -> Result<JobQuote> {
        plan.validate()?;
        let digest = plan.digest()?;
        let mut conn = self.connect()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing: Option<String> = tx
            .query_row("SELECT id FROM ai_jobs WHERE digest=?", [&digest], |r| {
                r.get(0)
            })
            .optional()?;
        let id = if let Some(id) = existing {
            id
        } else {
            let id = uuid::Uuid::new_v4().to_string();
            tx.execute("INSERT INTO ai_jobs(id,digest,plan_json,created_at_ms,quote_expires_at_ms) VALUES (?,?,?,?,?)",
                params![id, digest, serde_json::to_string(&plan)?, at, at + 30 * 60 * 1000])?;
            for ordinal in 0..plan.requests.len() {
                tx.execute(
                    "INSERT INTO ai_requests(job_id,ordinal) VALUES (?,?)",
                    params![id, ordinal as i64],
                )?;
            }
            audit(&tx, at, "prepared", Some(&id), &digest)?;
            id
        };
        tx.commit()?;
        self.quote(&id)
    }

    pub fn quote(&self, job_id: &str) -> Result<JobQuote> {
        let conn = self.connect()?;
        let (plan, digest, state, expiry) = read_job(&conn, job_id)?;
        let requests = plan.estimates()?;
        let total = sum_estimates(requests.iter())?;
        let audio_duration_ms = requests.iter().map(|r| r.audio_duration_ms).sum();
        let mut states =
            conn.prepare("SELECT ordinal,state FROM ai_requests WHERE job_id=? ORDER BY ordinal")?;
        let remaining_ordinals: Vec<u32> = states
            .query_map([job_id], |r| {
                Ok((r.get::<_, u32>(0)?, r.get::<_, String>(1)?))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?
            .into_iter()
            .filter_map(|(ordinal, state)| (state != "completed").then_some(ordinal))
            .collect();
        let completed_requests = requests.len() as u32 - remaining_ordinals.len() as u32;
        let additional_reservation_microusd = sum_estimates(
            requests
                .iter()
                .filter(|r| remaining_ordinals.contains(&r.ordinal)),
        )?;
        let total_output_tokens = plan.total_output_tokens();
        let unpriced_attempts = unpriced_count(&conn, Some(job_id))?;
        let created_at_ms = conn.query_row(
            "SELECT created_at_ms FROM ai_jobs WHERE id=?",
            [job_id],
            |r| r.get(0),
        )?;
        Ok(JobQuote { id: job_id.into(), title: plan.title, digest, project_id: plan.project_id,
            credential_id: plan.credential_id, binding: plan.binding, state, requests,
            estimated_max_microusd: total, already_charged_or_held_microusd: job_spend(&conn, job_id)?,
            additional_reservation_microusd,remaining_ordinals,completed_requests,created_at_ms,
            audio_duration_ms, execution:plan.execution, total_output_tokens, unpriced_attempts, quote_expires_at_ms: expiry,
            disclaimer: "Approximate USD estimate when a price is supplied, never a provider-backed billing cap. Unpriced means unknown, not free. Approval binds model, input, request count, audio duration and generation settings. No automatic paid retries.".into() })
    }

    pub fn list_jobs(&self) -> Result<Vec<JobQuote>> {
        let conn = self.connect()?;
        let mut stmt =
            conn.prepare("SELECT id FROM ai_jobs ORDER BY created_at_ms DESC LIMIT 500")?;
        let ids: Vec<String> = stmt
            .query_map([], |r| r.get(0))?
            .collect::<std::result::Result<_, _>>()?;
        ids.iter().map(|id| self.quote(id)).collect()
    }

    /// Native integration may compare the originally approved input against current
    /// source data before dispatch or applying results. This does not grant approval.
    pub fn prepared_job(&self, job_id: &str) -> Result<PreparedJob> {
        let conn = self.connect()?;
        let (plan, digest, _, _) = read_job(&conn, job_id)?;
        if plan.digest()? != digest {
            return Err(AiError::PreparationChanged);
        }
        Ok(plan)
    }

    /// Produce a fresh review window without approving or replaying anything.
    pub fn refresh_quote(&self, job_id: &str) -> Result<JobQuote> {
        let mut conn = self.connect()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (_, _, state, _) = read_job(&tx, job_id)?;
        if !["prepared", "paused", "needs_review"].contains(&state.as_str()) {
            return Err(AiError::ApprovalRequired);
        }
        tx.execute(
            "UPDATE ai_jobs SET quote_expires_at_ms=? WHERE id=?",
            params![self.now_ms() + 30 * 60 * 1000, job_id],
        )?;
        audit(
            &tx,
            self.now_ms(),
            "quote_refreshed",
            Some(job_id),
            "No additional work approved",
        )?;
        tx.commit()?;
        self.quote(job_id)
    }

    pub fn require_review(&self, job_id: &str, reason: &str) -> Result<()> {
        let conn = self.connect()?;
        conn.execute(
            "UPDATE ai_jobs SET state='needs_review' WHERE id=? AND state!='cancelled'",
            [job_id],
        )?;
        audit(
            &conn,
            self.now_ms(),
            "source_review_required",
            Some(job_id),
            reason,
        )?;
        Ok(())
    }

    pub fn approve(&self, job_id: &str, expected_digest: &str) -> Result<()> {
        self.approve_at(job_id, expected_digest, self.now_ms(), false)
    }

    /// Explicitly approve another attempt after reviewing its new reservation. Completed
    /// requests are never replayed. Unknown costs must be acknowledged separately first.
    pub fn reapprove(&self, job_id: &str, expected_digest: &str) -> Result<()> {
        self.approve_at(job_id, expected_digest, self.now_ms(), true)
    }

    pub fn approve_scope(
        &self,
        job_id: &str,
        digest: &str,
        acknowledge_unpriced: bool,
        acknowledge_unqualified: bool,
    ) -> Result<()> {
        self.approve_scoped_at(
            job_id,
            digest,
            self.now_ms(),
            false,
            acknowledge_unpriced,
            acknowledge_unqualified,
        )
    }
    pub fn reapprove_scope(
        &self,
        job_id: &str,
        digest: &str,
        acknowledge_unpriced: bool,
        acknowledge_unqualified: bool,
    ) -> Result<()> {
        self.approve_scoped_at(
            job_id,
            digest,
            self.now_ms(),
            true,
            acknowledge_unpriced,
            acknowledge_unqualified,
        )
    }
    fn approve_at(&self, job_id: &str, digest: &str, at: i64, retry: bool) -> Result<()> {
        self.approve_scoped_at(job_id, digest, at, retry, false, true)
    }
    fn approve_scoped_at(
        &self,
        job_id: &str,
        expected_digest: &str,
        at: i64,
        retry: bool,
        acknowledge_unpriced: bool,
        acknowledge_unqualified: bool,
    ) -> Result<()> {
        let mut conn = self.connect()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        self.require_validation_scope(&tx)?;
        let (plan, digest, state, expiry) = read_job(&tx, job_id)?;
        plan.validate()?;
        if digest != expected_digest
            || digest != plan.digest()?
            || ["completed", "cancelled"].contains(&state.as_str())
            || at > expiry
            || !acknowledge_unqualified
            || (plan.execution.price.is_none() && !acknowledge_unpriced)
        {
            return Err(AiError::ApprovalRequired);
        }
        self.check_model_permission(&plan, job_id, at)?;
        if has_blocking_attempt(&tx)? {
            return Err(AiError::InFlight);
        }
        if !retry && state == "needs_review" {
            return Err(AiError::ApprovalRequired);
        }
        let pending: u64 = tx.query_row(
            "SELECT COUNT(*) FROM ai_requests WHERE job_id=? AND state!='completed'",
            [job_id],
            |r| r.get::<_, i64>(0),
        )? as u64;
        if pending == 0 {
            return Err(AiError::Invalid(
                "All provider requests already completed; no paid retry is needed".into(),
            ));
        }
        let mut pending_cost = 0u64;
        for estimate in plan.estimates()? {
            let completed: bool = tx.query_row(
                "SELECT state='completed' FROM ai_requests WHERE job_id=? AND ordinal=?",
                params![job_id, estimate.ordinal],
                |r| r.get(0),
            )?;
            if !completed {
                pending_cost = pending_cost
                    .checked_add(estimate.estimated_max_microusd.unwrap_or(0))
                    .ok_or_else(|| AiError::Invalid("Cost overflow".into()))?;
            }
        }
        if plan.execution.price.is_some() {
            check_budget(&tx, job_id, pending_cost, at)?;
        }
        #[cfg(feature = "development-validation")]
        self.check_development_budget(&tx, pending_cost, true)?;
        let previous: u64 = tx.query_row(
            "SELECT COUNT(*) FROM ai_attempts WHERE job_id=?",
            [job_id],
            |r| r.get::<_, i64>(0),
        )? as u64;
        let approval = serde_json::json!({"digest":digest,"max_attempts":previous + pending,
            "acknowledge_unpriced":acknowledge_unpriced,"acknowledge_unqualified":acknowledge_unqualified});
        if retry {
            tx.execute("UPDATE ai_requests SET state='pending',error_code=NULL WHERE job_id=? AND state IN ('failed','needs_review')",[job_id])?;
        }
        tx.execute(
            "UPDATE ai_jobs SET state='approved',approved_at_ms=?,approval_json=? WHERE id=?",
            params![at, serde_json::to_string(&approval)?, job_id],
        )?;
        audit(
            &tx,
            at,
            if retry { "reapproved" } else { "approved" },
            Some(job_id),
            &serde_json::to_string(&approval)?,
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn pause(&self, job_id: &str) -> Result<()> {
        self.stop(job_id, "paused")
    }
    pub fn cancel(&self, job_id: &str) -> Result<()> {
        self.stop(job_id, "cancelled")
    }
    fn stop(&self, job_id: &str, state: &str) -> Result<()> {
        let conn = self.connect()?;
        conn.execute(
            "UPDATE ai_jobs SET state=? WHERE id=? AND state NOT IN ('completed','cancelled')",
            params![state, job_id],
        )?;
        audit(
            &conn,
            self.now_ms(),
            state,
            Some(job_id),
            "In-flight requests can still accrue charges",
        )?;
        Ok(())
    }

    /// Native worker entrypoint; claims exactly one immutable request transactionally.
    pub fn reserve_next(&self, job_id: &str) -> Result<Option<ReservedRequest>> {
        self.reserve_next_at(job_id, self.now_ms())
    }

    fn reserve_next_at(&self, job_id: &str, at: i64) -> Result<Option<ReservedRequest>> {
        let mut conn = self.connect()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        self.require_validation_scope(&tx)?;
        let (plan, digest, state, _) = read_job(&tx, job_id)?;
        if state != "approved" || plan.digest()? != digest {
            return Err(AiError::ApprovalRequired);
        }
        if has_blocking_attempt(&tx)? {
            return Err(AiError::InFlight);
        }
        let ordinal: Option<u32> = tx.query_row("SELECT ordinal FROM ai_requests WHERE job_id=? AND state='pending' ORDER BY ordinal LIMIT 1",[job_id],|r|r.get(0)).optional()?;
        let Some(ordinal) = ordinal else {
            tx.commit()?;
            return Ok(None);
        };
        let task = plan
            .requests
            .get(ordinal as usize)
            .ok_or(AiError::PreparationChanged)?
            .clone();
        self.check_model_permission(&plan, job_id, at)?;
        validate_scope(&tx, &plan, job_id, &digest, false)?;
        let reserve = plan.estimates()?[ordinal as usize].estimated_max_microusd;
        if let Some(amount) = reserve {
            check_budget(&tx, job_id, amount, at)?;
        }
        #[cfg(feature = "development-validation")]
        self.check_development_budget(&tx, reserve.unwrap_or(0), true)?;
        let attempt_id = uuid::Uuid::new_v4().to_string();
        tx.execute("INSERT INTO ai_attempts(id,job_id,ordinal,state,reserve_microusd,created_at_ms) VALUES (?,?,?,'reserved',?,?)",params![attempt_id,job_id,ordinal,reserve.map(i64::try_from).transpose().map_err(|_|AiError::Invalid("Reservation overflow".into()))?,at])?;
        tx.execute(
            "UPDATE ai_requests SET state='reserved' WHERE job_id=? AND ordinal=?",
            params![job_id, ordinal],
        )?;
        audit(&tx, at, "reserved", Some(job_id), &attempt_id)?;
        tx.commit()?;
        Ok(Some(ReservedRequest {
            attempt_id,
            job_id: job_id.into(),
            ordinal,
            task,
            body_snapshot: plan.request_body_snapshot(ordinal)?.clone(),
            execution: plan.execution,
            project_id: plan.project_id,
            credential_id: plan.credential_id,
            reserved_microusd: reserve,
        }))
    }

    /// Recheck authorization immediately before dispatch, after asynchronous local
    /// preflight. The durable reservation is already included in all budget totals;
    /// it must not be added a second time. This does not create or renew approval.
    pub fn validate_dispatch(&self, reservation: &ReservedRequest) -> Result<()> {
        let at = self.now_ms();
        let mut conn = self.connect()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        self.require_validation_scope(&tx)?;
        let (plan, digest, state, _) = read_job(&tx, &reservation.job_id)?;
        if state != "approved" {
            return Err(AiError::ApprovalRequired);
        }
        self.check_model_permission(&plan, &reservation.job_id, at)?;
        if plan.digest()? != digest
            || plan.execution != reservation.execution
            || plan.request_body_snapshot(reservation.ordinal)? != &reservation.body_snapshot
            || plan.project_id != reservation.project_id
            || plan.credential_id != reservation.credential_id
            || plan.requests.get(reservation.ordinal as usize) != Some(&reservation.task)
        {
            return Err(AiError::PreparationChanged);
        }
        let actual: Option<(String, u32, String, Option<u64>, String)> = tx.query_row(
            "SELECT a.job_id,a.ordinal,a.state,a.reserve_microusd,r.state FROM ai_attempts a JOIN ai_requests r ON r.job_id=a.job_id AND r.ordinal=a.ordinal WHERE a.id=?",
            [&reservation.attempt_id],
            |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get::<_,Option<i64>>(3)?.map(|n|n as u64),r.get(4)?)),
        ).optional()?;
        if actual
            .as_ref()
            .is_none_or(|(job, ordinal, attempt_state, reserve, request_state)| {
                job != &reservation.job_id
                    || *ordinal != reservation.ordinal
                    || attempt_state != "reserved"
                    || request_state != "reserved"
                    || *reserve != reservation.reserved_microusd
            })
        {
            return Err(AiError::ApprovalRequired);
        }
        validate_scope(&tx, &plan, &reservation.job_id, &digest, true)?;
        if plan.execution.price.is_some() {
            check_budget(&tx, &reservation.job_id, 0, at)?;
        }
        #[cfg(feature = "development-validation")]
        self.check_development_budget(&tx, 0, false)?;
        // Reservation can precede UTC midnight while credential preflight finishes
        // after it. Charge accounting belongs to the initial authorized dispatch,
        // while created_at_ms continues to identify the reservation audit time.
        tx.execute(
            "UPDATE ai_attempts SET dispatched_at_ms=COALESCE(dispatched_at_ms,?) WHERE id=?",
            params![at, reservation.attempt_id],
        )?;
        tx.commit()?;
        Ok(())
    }

    fn check_model_permission(&self, plan: &PreparedJob, _job_id: &str, _at: i64) -> Result<()> {
        #[cfg(feature = "development-validation")]
        {
            if let Some(scope) = &self.development {
                return scope.verify(plan, _job_id, _at);
            }
            if plan
                .requests
                .iter()
                .any(|task| matches!(task, RequestTask::TranscribeDiagnostic { .. }))
            {
                return Err(AiError::ApprovalRequired);
            }
        }
        let _ = plan;
        Ok(())
    }

    /// This guard is compiled into ordinary desktop builds too. Opening an
    /// evaluation database without its development feature must never turn its
    /// append-only campaign/lifetime accounting into ordinary daily budgets.
    fn require_validation_scope(&self, connection: &Connection) -> Result<()> {
        let isolated: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name IN ('ai_validation_settings','ai_validation_campaigns','ai_validation_campaign_jobs'))",
            [], |row| row.get(0),
        )?;
        #[cfg(feature = "development-validation")]
        let scoped = self.development.is_some();
        #[cfg(not(feature = "development-validation"))]
        let scoped = false;
        if isolated && !scoped {
            return Err(AiError::ApprovalRequired);
        }
        Ok(())
    }

    /// Only call when the native worker knows no paid request was sent (e.g. key import
    /// or fingerprint failed). HTTP errors with unknown usage must use mark_unknown.
    pub fn release_unsent(&self, attempt_id: &str, code: &str) -> Result<()> {
        self.finish_attempt(attempt_id, Some(0), None, None, Some(code), "released")
    }

    pub fn settle(
        &self,
        attempt_id: &str,
        actual_microusd: u64,
        usage: &serde_json::Value,
        response: Option<&ParsedOutput>,
        validation_error: Option<&str>,
    ) -> Result<()> {
        self.finish_attempt(
            attempt_id,
            Some(actual_microusd),
            Some(usage),
            response,
            validation_error,
            "settled",
        )
    }

    /// A received result with unknown price is settled without inventing a zero cost.
    pub fn settle_unpriced(
        &self,
        attempt_id: &str,
        usage: &serde_json::Value,
        response: Option<&ParsedOutput>,
        error: Option<&str>,
    ) -> Result<()> {
        self.finish_attempt(attempt_id, None, Some(usage), response, error, "settled")
    }

    pub(crate) fn record_model_version(&self, attempt_id: &str, value: Option<&str>) -> Result<()> {
        if let Some(version) = value.filter(|v| {
            !v.is_empty()
                && v.len() <= 200
                && v.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-._@".contains(&b))
        }) {
            self.connect()?.execute(
                "UPDATE ai_attempts SET model_version=? WHERE id=? AND state='reserved'",
                params![version, attempt_id],
            )?;
        }
        Ok(())
    }

    pub(crate) fn mark_unknown_usage(
        &self,
        attempt_id: &str,
        observed: &serde_json::Value,
    ) -> Result<()> {
        self.finish_attempt(
            attempt_id,
            None,
            Some(observed),
            None,
            Some("usage_unknown"),
            "unknown",
        )
    }

    pub fn mark_unknown(&self, attempt_id: &str) -> Result<()> {
        self.finish_attempt(
            attempt_id,
            None,
            None,
            None,
            Some("unknown_outcome"),
            "unknown",
        )
    }

    fn finish_attempt(
        &self,
        id: &str,
        charged: Option<u64>,
        usage: Option<&serde_json::Value>,
        response: Option<&ParsedOutput>,
        error: Option<&str>,
        state: &str,
    ) -> Result<()> {
        if charged.is_some_and(|n| n > i64::MAX as u64) {
            return Err(AiError::Invalid("Usage cost overflow".into()));
        }
        let mut conn = self.connect()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (job_id, ordinal, previous, reserve): (String, u32, String, Option<u64>) = tx
            .query_row(
                "SELECT job_id,ordinal,state,reserve_microusd FROM ai_attempts WHERE id=?",
                [id],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get::<_, Option<i64>>(3)?.map(|n| n as u64),
                    ))
                },
            )?;
        if !["reserved", "unknown"].contains(&previous.as_str()) {
            return Err(AiError::Invalid(
                "Attempt is already final; settlement is never applied twice".into(),
            ));
        }
        if state == "released" && previous != "reserved" {
            return Err(AiError::UnknownOutcome);
        }
        tx.execute("UPDATE ai_attempts SET state=?,charged_microusd=?,settled_at_ms=?,usage_json=? WHERE id=?",params![state,charged.map(|n|n as i64),self.now_ms(),usage.map(serde_json::to_string).transpose()?,id])?;
        let success = response.is_some() && error.is_none() && state == "settled";
        tx.execute("UPDATE ai_requests SET state=?,response_json=?,error_code=? WHERE job_id=? AND ordinal=?",params![if success {"completed"} else if state == "unknown" {"unknown"} else {"failed"},response.map(serde_json::to_string).transpose()?,error,job_id,ordinal])?;
        if !success || charged.zip(reserve).is_some_and(|(n, r)| n > r) {
            tx.execute(
                "UPDATE ai_jobs SET state='needs_review' WHERE id=? AND state NOT IN ('cancelled','paused')",
                [&job_id],
            )?;
        } else {
            tx.execute("UPDATE ai_jobs SET state='completed' WHERE id=? AND state='approved' AND NOT EXISTS(SELECT 1 FROM ai_requests WHERE job_id=? AND state!='completed')",params![job_id,job_id])?;
        }
        audit(&tx, self.now_ms(), state, Some(&job_id), id)?;
        tx.commit()?;
        Ok(())
    }

    /// Call once at application startup, before starting workers. Charges are retained.
    pub fn recover_interrupted(&self) -> Result<u64> {
        let mut conn = self.connect()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let changed = tx.execute(
            "UPDATE ai_attempts SET state='unknown' WHERE state='reserved'",
            [],
        )?;
        tx.execute("UPDATE ai_requests SET state='unknown',error_code='interrupted' WHERE state='reserved'",[])?;
        tx.execute(
            "UPDATE ai_jobs SET state='needs_review' WHERE state='approved'",
            [],
        )?;
        audit(
            &tx,
            self.now_ms(),
            "recovered_interrupted",
            None,
            &changed.to_string(),
        )?;
        tx.commit()?;
        Ok(changed as u64)
    }

    /// Explicitly accept the conservative reservation as potentially spent. This does
    /// not refund it, create a retry, or approve any new paid work.
    pub fn acknowledge_unknown(&self, attempt_id: &str) -> Result<()> {
        let mut conn = self.connect()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (job, ordinal): (String, u32) = tx.query_row(
            "SELECT job_id,ordinal FROM ai_attempts WHERE id=? AND state='unknown'",
            [attempt_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        tx.execute(
            "UPDATE ai_attempts SET state='accepted_unknown' WHERE id=?",
            [attempt_id],
        )?;
        tx.execute("UPDATE ai_requests SET state='needs_review' WHERE job_id=? AND ordinal=? AND state='unknown'",params![job,ordinal])?;
        audit(
            &tx,
            self.now_ms(),
            "unknown_cost_accepted",
            Some(&job),
            attempt_id,
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn response(&self, job_id: &str, ordinal: u32) -> Result<Option<ParsedOutput>> {
        let conn = self.connect()?;
        let json: Option<String> = conn.query_row(
            "SELECT response_json FROM ai_requests WHERE job_id=? AND ordinal=?",
            params![job_id, ordinal],
            |r| r.get(0),
        )?;
        json.map(|s| serde_json::from_str(&s).map_err(Into::into))
            .transpose()
    }

    pub fn summary(&self) -> Result<SpendSummary> {
        let conn = self.connect()?;
        let (day, month) = period_starts(self.now_ms())?;
        let mut stmt = conn.prepare("SELECT id,job_id,ordinal,state,COALESCE(charged_microusd,reserve_microusd),created_at_ms FROM ai_attempts WHERE state IN ('unknown','reserved') ORDER BY created_at_ms")?;
        let unknown_attempts = stmt
            .query_map([], |r| {
                Ok(AttemptSummary {
                    id: r.get(0)?,
                    job_id: r.get(1)?,
                    ordinal: r.get(2)?,
                    state: r.get(3)?,
                    held_or_charged_microusd: r.get::<_, Option<i64>>(4)?.map(|n| n as u64),
                    created_at_ms: r.get(5)?,
                })
            })?
            .collect::<std::result::Result<_, _>>()?;
        let (daily_actual_charged_microusd, daily_held_microusd) = period_breakdown(&conn, day)?;
        let (monthly_actual_charged_microusd, monthly_held_microusd) =
            period_breakdown(&conn, month)?;
        Ok(SpendSummary {
            limits: limits(&conn)?,
            daily_charged_or_held_microusd: period_spend(&conn, day)?,
            monthly_charged_or_held_microusd: period_spend(&conn, month)?,
            daily_actual_charged_microusd,
            monthly_actual_charged_microusd,
            daily_held_microusd,
            monthly_held_microusd,
            unknown_attempts,
            unpriced_attempts: unpriced_count(&conn, None)?,
            monetary_totals_complete: unpriced_count(&conn, None)? == 0,
        })
    }
}

fn sum_estimates<'a>(
    mut estimates: impl Iterator<Item = &'a RequestEstimate>,
) -> Result<Option<u64>> {
    estimates.try_fold(Some(0u64), |sum, estimate| {
        match (sum, estimate.estimated_max_microusd) {
            (Some(sum), Some(n)) => sum
                .checked_add(n)
                .map(Some)
                .ok_or_else(|| AiError::Invalid("Cost overflow".into())),
            _ => Ok(None),
        }
    })
}
fn unpriced_count(conn: &Connection, job: Option<&str>) -> Result<u64> {
    Ok(conn.query_row("SELECT COUNT(*) FROM ai_attempts WHERE reserve_microusd IS NULL AND state!='released' AND (?1 IS NULL OR job_id=?1)",[job],|r|r.get::<_,i64>(0))? as u64)
}
fn validate_scope(
    conn: &Connection,
    plan: &PreparedJob,
    job: &str,
    digest: &str,
    already_reserved: bool,
) -> Result<()> {
    let raw: Option<String> =
        conn.query_row("SELECT approval_json FROM ai_jobs WHERE id=?", [job], |r| {
            r.get(0)
        })?;
    let approval: serde_json::Value =
        serde_json::from_str(raw.as_deref().ok_or(AiError::ApprovalRequired)?)?;
    let attempts: u64 = conn.query_row(
        "SELECT COUNT(*) FROM ai_attempts WHERE job_id=?",
        [job],
        |r| r.get::<_, i64>(0),
    )? as u64;
    if approval["digest"].as_str() != Some(digest)
        || approval["acknowledge_unqualified"].as_bool() != Some(true)
        || (plan.execution.price.is_none()
            && approval["acknowledge_unpriced"].as_bool() != Some(true))
        || approval["max_attempts"].as_u64().is_none_or(|limit| {
            if already_reserved {
                attempts > limit
            } else {
                attempts >= limit
            }
        })
    {
        return Err(AiError::ApprovalRequired);
    }
    Ok(())
}
fn limits(conn: &Connection) -> Result<BudgetLimits> {
    let s: String = conn.query_row("SELECT limits_json FROM ai_settings WHERE id=1", [], |r| {
        r.get(0)
    })?;
    Ok(serde_json::from_str(&s)?)
}
fn read_job(conn: &Connection, id: &str) -> Result<(PreparedJob, String, String, i64)> {
    let (s, d, state, expiry): (String, String, String, i64) = conn.query_row(
        "SELECT plan_json,digest,state,quote_expires_at_ms FROM ai_jobs WHERE id=?",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )?;
    Ok((serde_json::from_str(&s)?, d, state, expiry))
}
fn has_blocking_attempt(conn: &Connection) -> Result<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM ai_attempts WHERE state IN ('reserved','unknown'))",
        [],
        |r| r.get(0),
    )?)
}
fn job_spend(conn: &Connection, id: &str) -> Result<u64> {
    Ok(conn.query_row("SELECT COALESCE(SUM(COALESCE(charged_microusd,reserve_microusd)),0) FROM ai_attempts WHERE job_id=?",[id],|r|r.get::<_,i64>(0))? as u64)
}
fn period_spend(conn: &Connection, start: i64) -> Result<u64> {
    Ok(conn.query_row("SELECT COALESCE(SUM(COALESCE(charged_microusd,reserve_microusd)),0) FROM ai_attempts WHERE COALESCE(dispatched_at_ms,created_at_ms)>=? OR charged_microusd IS NULL",[start],|r|r.get::<_,i64>(0))? as u64)
}
fn period_breakdown(conn: &Connection, start: i64) -> Result<(u64, u64)> {
    // An unresolved hold remains conservative capacity in later periods, including
    // after explicit acknowledgement. Calendar rollover never proves it was free.
    Ok(conn.query_row("SELECT COALESCE(SUM(COALESCE(charged_microusd,0)),0),COALESCE(SUM(CASE WHEN charged_microusd IS NULL THEN reserve_microusd ELSE 0 END),0) FROM ai_attempts WHERE COALESCE(dispatched_at_ms,created_at_ms)>=? OR charged_microusd IS NULL",[start],|r|Ok((r.get::<_,i64>(0)? as u64,r.get::<_,i64>(1)? as u64)))?)
}
fn period_starts(at: i64) -> Result<(i64, i64)> {
    use chrono::Datelike;
    let d = chrono::DateTime::from_timestamp_millis(at)
        .ok_or_else(|| AiError::Invalid("Invalid time".into()))?
        .date_naive();
    let day = d.and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp_millis();
    let month = d
        .with_day(1)
        .unwrap()
        .and_hms_opt(0, 0, 0)
        .unwrap()
        .and_utc()
        .timestamp_millis();
    Ok((day, month))
}
fn check_budget(conn: &Connection, job: &str, additional: u64, at: i64) -> Result<()> {
    let b = limits(conn)?;
    if b.per_job_microusd == 0 || b.daily_microusd == 0 || b.monthly_microusd == 0 {
        return Err(AiError::BudgetDisabled);
    }
    let (day, month) = period_starts(at)?;
    for (used, cap, label) in [
        (job_spend(conn, job)?, b.per_job_microusd, "job"),
        (period_spend(conn, day)?, b.daily_microusd, "daily"),
        (period_spend(conn, month)?, b.monthly_microusd, "monthly"),
    ] {
        if used.checked_add(additional).is_none_or(|n| n > cap) {
            return Err(AiError::BudgetExceeded(label));
        }
    }
    Ok(())
}
fn audit(conn: &Connection, at: i64, event: &str, job: Option<&str>, detail: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO ai_audit(at_ms,event,job_id,detail) VALUES (?,?,?,?)",
        params![at, event, job, detail],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
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
    fn zero_is_closed_and_preparation_is_deduplicated() {
        let (_d, s) = store();
        let q = s.prepare_at(plan(), AT).unwrap();
        assert_eq!(q.id, s.prepare_at(plan(), AT).unwrap().id);
        assert!(matches!(
            s.approve_at(&q.id, &q.digest, AT, false),
            Err(AiError::BudgetDisabled)
        ));
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
}

#[cfg(test)]
mod fault_tests;
