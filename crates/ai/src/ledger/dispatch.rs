//! Atomic reservations and final authorization before paid dispatch.
use super::accounting::{check_budget, has_blocking_attempt, read_job, validate_scope};
use super::{audit, AiStore, ReservedRequest};
#[cfg(feature = "development-validation")]
use crate::RequestTask;
use crate::{AiError, PreparedJob, Result};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};

impl AiStore {
    /// Native worker entrypoint; claims exactly one immutable request transactionally.
    pub fn reserve_next(&self, job_id: &str) -> Result<Option<ReservedRequest>> {
        self.reserve_next_at(job_id, self.now_ms())
    }

    pub(super) fn reserve_next_at(&self, job_id: &str, at: i64) -> Result<Option<ReservedRequest>> {
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

    pub(super) fn check_model_permission(
        &self,
        plan: &PreparedJob,
        _job_id: &str,
        _at: i64,
    ) -> Result<()> {
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
    pub(super) fn require_validation_scope(&self, connection: &Connection) -> Result<()> {
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
}
