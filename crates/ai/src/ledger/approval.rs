//! Preparation, explicit approval, and job lifecycle changes.
use super::accounting::{check_budget, has_blocking_attempt, read_job};
use super::{audit, AiStore, BudgetLimits, JobQuote};
use crate::{AiError, PreparedJob, Result};
use rusqlite::{params, OptionalExtension, TransactionBehavior};

impl AiStore {
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

    pub(super) fn prepare_at(&self, plan: PreparedJob, at: i64) -> Result<JobQuote> {
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

    pub(super) fn approve_at(
        &self,
        job_id: &str,
        digest: &str,
        at: i64,
        retry: bool,
    ) -> Result<()> {
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
}
