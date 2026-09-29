//! Durable settlement, unknown outcomes, and interrupted-work recovery.
use super::{audit, AiStore};
use crate::{AiError, ParsedOutput, Result};
use rusqlite::{params, TransactionBehavior};

impl AiStore {
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
}
