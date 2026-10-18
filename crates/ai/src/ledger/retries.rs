//! Approval-bound, bounded retries of explicit HTTP 429 responses only.
//! A rejection is operationally known, but its monetary hold is never refunded.
use super::{audit, AiStore, ReservedRequest};
use crate::{AiError, PreparedJob, RequestTask, Result};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RetryPolicy {
    pub version: u32,
    pub max_retries: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RetryStatus {
    pub state: String,
    pub ordinal: u32,
    pub retry_number: u32,
    pub max_retries: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_retry_at: Option<String>,
}

pub(super) fn initialize(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS ai_approval_requests (
        approval_id TEXT NOT NULL, job_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
        max_retries INTEGER NOT NULL CHECK(max_retries IN (0,2)),
        attempts_started INTEGER NOT NULL DEFAULT 0 CHECK(attempts_started>=0),
        retry_at_ms INTEGER, retry_floor_ms INTEGER, retry_state TEXT, last_attempt_id TEXT,
        PRIMARY KEY(approval_id,ordinal),
        FOREIGN KEY(job_id,ordinal) REFERENCES ai_requests(job_id,ordinal),
        FOREIGN KEY(last_attempt_id) REFERENCES ai_attempts(id));",
    )?;
    Ok(())
}

pub(super) fn current_approval(conn: &Connection, job: &str) -> Result<Option<String>> {
    let json: Option<String> = conn.query_row(
        "SELECT approval_json FROM ai_jobs WHERE id=?",
        [job],
        |row| row.get(0),
    )?;
    let value: serde_json::Value = json
        .as_deref()
        .map(serde_json::from_str)
        .transpose()?
        .unwrap_or_default();
    Ok(value["approval_id"].as_str().map(str::to_owned))
}

pub(super) fn check_generation(conn: &Connection, job: &str, expected: Option<&str>) -> Result<()> {
    if current_approval(conn, job)?.as_deref() != expected {
        return Err(AiError::Superseded);
    }
    Ok(())
}

pub(super) fn retry_floor(conn: &Connection, job: &str, at: i64) -> Result<Option<i64>> {
    Ok(conn.query_row(
        "SELECT MAX(s.retry_floor_ms) FROM ai_approval_requests s
        JOIN ai_requests r ON r.job_id=s.job_id AND r.ordinal=s.ordinal
        WHERE s.job_id=? AND r.state!='completed' AND s.retry_floor_ms>?",
        params![job, at],
        |row| row.get(0),
    )?)
}

impl AiStore {
    pub fn current_approval_id(&self, job_id: &str) -> Result<Option<String>> {
        current_approval(&self.connect()?, job_id)
    }

    pub fn approval_is_current(&self, job_id: &str, approval_id: &str) -> Result<bool> {
        Ok(self.current_approval_id(job_id)?.as_deref() == Some(approval_id))
    }

    pub fn retry_not_before(&self, job_id: &str) -> Result<Option<i64>> {
        retry_floor(&self.connect()?, job_id, self.now_ms())
    }

    pub(super) fn retry_policy_for_plan(&self, plan: &PreparedJob) -> Option<RetryPolicy> {
        #[cfg(feature = "development-validation")]
        if self.development.is_some() {
            return None;
        }
        (!plan.requests.is_empty()
            && plan.requests.iter().all(|task| {
                matches!(
                    task,
                    RequestTask::AudioTranscription { .. } | RequestTask::TranscribePreview { .. }
                )
            }))
        .then_some(RetryPolicy {
            version: 1,
            max_retries: 2,
        })
    }

    pub fn transcription_retry_policy(&self, job_id: &str) -> Result<Option<RetryPolicy>> {
        Ok(self.retry_policy_for_plan(&self.prepared_job(job_id)?))
    }

    /// Finalize only an observed 429. Neither a transport error nor a missing
    /// response can call this path. Legacy approvals retain unknown handling.
    pub fn handle_429(
        &self,
        reservation: &ReservedRequest,
        retry_after: Option<&str>,
    ) -> Result<RetryStatus> {
        let at = self.now_ms();
        let jitter = u32::from_le_bytes(uuid::Uuid::new_v4().as_bytes()[..4].try_into().unwrap());
        self.handle_429_at(reservation, retry_after, at, jitter)
    }

    pub(super) fn handle_429_at(
        &self,
        reservation: &ReservedRequest,
        retry_after: Option<&str>,
        at: i64,
        jitter: u32,
    ) -> Result<RetryStatus> {
        let mut conn = self.connect()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        check_generation(&tx, &reservation.job_id, reservation.approval_id.as_deref())?;
        let valid: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM ai_attempts WHERE id=? AND job_id=? AND ordinal=? AND state='reserved' AND dispatched_at_ms IS NOT NULL)",
            params![reservation.attempt_id,reservation.job_id,reservation.ordinal], |row| row.get(0),
        )?;
        if !valid {
            return Err(AiError::ApprovalRequired);
        }
        let requested_delay = retry_after_delay(retry_after, at);
        let floor = requested_delay
            .map(|delay| at.saturating_add(i64::try_from(delay).unwrap_or(i64::MAX)));
        let (plan, _, _, _) = super::accounting::read_job(&tx, &reservation.job_id)?;
        let scope: Option<(u32, u32, String)> = tx.query_row(
            "SELECT max_retries,attempts_started,COALESCE(last_attempt_id,'') FROM ai_approval_requests WHERE approval_id=? AND job_id=? AND ordinal=?",
            params![reservation.approval_id, reservation.job_id, reservation.ordinal],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
        ).optional()?;
        let Some((max_retries, started, last)) = scope.filter(|(max, _, _)| *max > 0) else {
            self.pace_rejection(
                &tx,
                &plan,
                reservation.ordinal,
                super::pacing::RejectionTiming {
                    at,
                    server_floor: floor,
                    jitter,
                },
            )?;
            tx.commit()?;
            self.mark_unknown(&reservation.attempt_id)?;
            return Ok(RetryStatus {
                state: "exhausted".into(),
                ordinal: reservation.ordinal,
                retry_number: 0,
                max_retries: 0,
                next_retry_at: None,
            });
        };
        if last != reservation.attempt_id || started == 0 || started > max_retries + 1 {
            return Err(AiError::ApprovalRequired);
        }
        let pacing_floor = self.pace_rejection(
            &tx,
            &plan,
            reservation.ordinal,
            super::pacing::RejectionTiming {
                at,
                server_floor: floor,
                jitter,
            },
        )?;
        let job_state: String = tx.query_row(
            "SELECT state FROM ai_jobs WHERE id=?",
            [&reservation.job_id],
            |row| row.get(0),
        )?;
        let retry_state = if started > max_retries {
            "exhausted"
        } else if requested_delay.is_some_and(|delay| delay > 300_000) || job_state != "approved" {
            "deferred"
        } else {
            "waiting"
        };
        let next = if retry_state == "waiting" {
            let delay = retry_delay(started, jitter).max(requested_delay.unwrap_or(0));
            Some(
                at.checked_add(delay as i64)
                    .ok_or_else(|| AiError::Invalid("Retry time overflow".into()))?,
            )
        } else {
            floor
        };
        let next = next.into_iter().chain(pacing_floor).max();
        tx.execute("UPDATE ai_attempts SET state='rejected_429',settled_at_ms=? WHERE id=? AND state='reserved'", params![at,reservation.attempt_id])?;
        tx.execute(
            "UPDATE ai_requests SET state=?,error_code='rate_limited' WHERE job_id=? AND ordinal=?",
            params![
                if retry_state == "waiting" {
                    "pending"
                } else {
                    "failed"
                },
                reservation.job_id,
                reservation.ordinal
            ],
        )?;
        tx.execute("UPDATE ai_approval_requests SET retry_at_ms=?,retry_floor_ms=?,retry_state=? WHERE approval_id=? AND ordinal=?",
            params![next,floor,retry_state,reservation.approval_id,reservation.ordinal])?;
        if retry_state != "waiting" {
            tx.execute(
                "UPDATE ai_jobs SET state='needs_review' WHERE id=? AND state='approved'",
                [&reservation.job_id],
            )?;
        }
        audit(
            &tx,
            at,
            "rejected_429",
            Some(&reservation.job_id),
            &reservation.attempt_id,
        )?;
        tx.commit()?;
        Ok(status(
            retry_state,
            reservation.ordinal,
            started,
            max_retries,
            next,
        ))
    }

    pub fn retry_status(&self, job_id: &str) -> Result<Option<RetryStatus>> {
        let conn = self.connect()?;
        let Some(approval) = current_approval(&conn, job_id)? else {
            return Ok(None);
        };
        let row: Option<(String,u32,u32,u32,Option<i64>)> = conn.query_row(
            "SELECT s.retry_state,s.ordinal,s.attempts_started,s.max_retries,s.retry_at_ms
             FROM ai_approval_requests s JOIN ai_requests r ON r.job_id=s.job_id AND r.ordinal=s.ordinal
             WHERE s.job_id=? AND s.approval_id=? AND s.max_retries>0 AND s.retry_state IS NOT NULL AND r.state!='completed'
             AND (s.retry_state IN ('exhausted','deferred') OR EXISTS(SELECT 1 FROM ai_jobs j WHERE j.id=s.job_id AND j.state='approved'))
             ORDER BY s.ordinal LIMIT 1", params![job_id,approval],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?)),
        ).optional()?;
        row.map(|(state, ordinal, started, max, next)| {
            let next = if state == "waiting" {
                let (plan, _, _, _) = super::accounting::read_job(&conn, job_id)?;
                next.into_iter()
                    .chain(self.pacing_floor(&conn, &plan, ordinal)?)
                    .max()
            } else {
                next
            };
            Ok(status(&state, ordinal, started, max, next))
        })
        .transpose()
    }

    pub fn require_review_scoped(
        &self,
        job_id: &str,
        approval_id: &str,
        reason: &str,
    ) -> Result<bool> {
        let mut conn = self.connect()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if current_approval(&tx, job_id)?.as_deref() != Some(approval_id) {
            return Ok(false);
        }
        let changed = tx.execute("UPDATE ai_jobs SET state='needs_review' WHERE id=? AND state NOT IN ('paused','cancelled')", [job_id])?;
        if changed > 0 {
            audit(
                &tx,
                self.now_ms(),
                "source_review_required",
                Some(job_id),
                reason,
            )?;
        }
        tx.commit()?;
        Ok(changed > 0)
    }
}

fn status(state: &str, ordinal: u32, started: u32, max: u32, next: Option<i64>) -> RetryStatus {
    RetryStatus {
        state: state.into(),
        ordinal,
        retry_number: if state == "retrying" {
            started.saturating_sub(1)
        } else {
            started.min(max)
        },
        max_retries: max,
        next_retry_at: next
            .and_then(chrono::DateTime::from_timestamp_millis)
            .map(|time| time.to_rfc3339()),
    }
}

/// Retry-After supports delta seconds and HTTP dates. Invalid/absent values use
/// local backoff; valid excessive values stop instead of shortening the wait.
fn retry_after_delay(header: Option<&str>, at: i64) -> Option<u64> {
    let raw = header?.trim();
    if raw.is_empty() || raw.len() > 128 {
        return None;
    }
    if raw.bytes().all(|byte| byte.is_ascii_digit()) {
        return Some(raw.parse::<u64>().unwrap_or(u64::MAX).saturating_mul(1000));
    }
    let date = chrono::DateTime::parse_from_rfc2822(raw).ok()?;
    Some(date.timestamp_millis().saturating_sub(at).max(0) as u64)
}

fn retry_delay(started: u32, jitter: u32) -> u64 {
    let base = if started == 1 { 10_000_u32 } else { 20_000 };
    u64::from(base + jitter % (base / 5 + 1))
}

#[cfg(test)]
mod tests;
