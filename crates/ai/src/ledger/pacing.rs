//! Shared, durable pacing for ordinary transcription. This is a client policy,
//! not a claim about a provider RPM quota or an authorization to send.
use super::{accounting::read_job, AiStore};
use crate::{AiError, PreparedJob, RequestTask, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

const MIN_INTERVAL_MS: i64 = 10_000;
const MAX_INTERVAL_MS: i64 = 60_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PacingStatus {
    pub ordinal: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_send_at: Option<String>,
    pub interval_ms: u64,
    pub slowed: bool,
}

pub(super) fn initialize(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS ai_transcription_pacing (
            project_id TEXT NOT NULL, model_id TEXT NOT NULL, location TEXT NOT NULL,
            interval_ms INTEGER NOT NULL CHECK(interval_ms BETWEEN 10000 AND 60000),
            success_streak INTEGER NOT NULL DEFAULT 0 CHECK(success_streak BETWEEN 0 AND 2),
            last_dispatch_ms INTEGER, cooldown_until_ms INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY(project_id,model_id,location));",
    )?;
    Ok(())
}

struct Lane {
    interval: i64,
    last_dispatch: Option<i64>,
    cooldown: i64,
}

pub(super) struct RejectionTiming {
    pub at: i64,
    pub server_floor: Option<i64>,
    pub jitter: u32,
}

impl Lane {
    fn next(&self) -> i64 {
        self.last_dispatch
            .map(|at| at.saturating_add(self.interval))
            .unwrap_or(0)
            .max(self.cooldown)
    }
}

fn lane(conn: &Connection, plan: &PreparedJob) -> Result<Lane> {
    Ok(conn
        .query_row(
            "SELECT interval_ms,last_dispatch_ms,cooldown_until_ms FROM ai_transcription_pacing
         WHERE project_id=? AND model_id=? AND location=?",
            params![
                plan.project_id,
                plan.execution.model_id,
                plan.execution.location
            ],
            |row| {
                Ok(Lane {
                    interval: row.get(0)?,
                    last_dispatch: row.get(1)?,
                    cooldown: row.get(2)?,
                })
            },
        )
        .optional()?
        .unwrap_or(Lane {
            interval: MIN_INTERVAL_MS,
            last_dispatch: None,
            cooldown: 0,
        }))
}

impl AiStore {
    fn pacing_applies(&self, plan: &PreparedJob, ordinal: u32) -> bool {
        #[cfg(feature = "development-validation")]
        if self.development.is_some() {
            return false;
        }
        matches!(
            plan.requests.get(ordinal as usize),
            Some(RequestTask::AudioTranscription { .. } | RequestTask::TranscribePreview { .. })
        )
    }

    /// Informational only: pause, cancel, and restart never become approval.
    pub fn pacing_status(&self, job_id: &str) -> Result<Option<PacingStatus>> {
        let conn = self.connect()?;
        let (plan, _, state, _) = read_job(&conn, job_id)?;
        if state != "approved" {
            return Ok(None);
        }
        let ordinal: Option<u32> = conn.query_row(
            "SELECT r.ordinal FROM ai_requests r WHERE r.job_id=? AND r.state IN ('pending','reserved')
             AND NOT EXISTS(SELECT 1 FROM ai_attempts a WHERE a.job_id=r.job_id AND a.state='reserved' AND a.dispatched_at_ms IS NOT NULL)
             ORDER BY r.ordinal LIMIT 1",
            [job_id], |row| row.get(0),
        ).optional()?;
        let Some(ordinal) = ordinal.filter(|ordinal| self.pacing_applies(&plan, *ordinal)) else {
            return Ok(None);
        };
        let lane = lane(&conn, &plan)?;
        let approval = super::retries::current_approval(&conn, job_id)?;
        let retry: Option<i64> = conn.query_row(
            "SELECT MAX(MAX(CASE WHEN approval_id=? THEN COALESCE(retry_at_ms,0) ELSE 0 END,COALESCE(retry_floor_ms,0))) FROM ai_approval_requests WHERE job_id=? AND ordinal=?",
            params![approval,job_id,ordinal], |row| row.get(0),
        )?;
        let next = lane.next().max(retry.unwrap_or(0));
        if next <= self.now_ms() {
            return Ok(None);
        }
        Ok(Some(PacingStatus {
            ordinal,
            // Excessive Retry-After is not shortened merely to fit a timestamp.
            // The native numeric gate stays intact; the UI can show an indefinite wait.
            next_send_at: chrono::DateTime::from_timestamp_millis(next).map(|at| at.to_rfc3339()),
            interval_ms: lane.interval as u64,
            slowed: lane.interval > MIN_INTERVAL_MS,
        }))
    }

    pub(super) fn pacing_floor(
        &self,
        conn: &Connection,
        plan: &PreparedJob,
        ordinal: u32,
    ) -> Result<Option<i64>> {
        if self.pacing_applies(plan, ordinal) {
            Ok(Some(lane(conn, plan)?.next()))
        } else {
            Ok(None)
        }
    }

    pub(super) fn check_pacing(
        &self,
        conn: &Connection,
        plan: &PreparedJob,
        ordinal: u32,
        at: i64,
    ) -> Result<()> {
        if self.pacing_applies(plan, ordinal) {
            let next = lane(conn, plan)?.next();
            if next > at {
                return Err(AiError::PacingWaiting(next));
            }
        }
        Ok(())
    }

    /// Called in the same immediate transaction as the dispatch timestamp.
    pub(super) fn pace_dispatch(
        &self,
        conn: &Connection,
        plan: &PreparedJob,
        ordinal: u32,
        at: i64,
    ) -> Result<()> {
        self.check_pacing(conn, plan, ordinal, at)?;
        if self.pacing_applies(plan, ordinal) {
            conn.execute(
                "INSERT INTO ai_transcription_pacing(project_id,model_id,location,interval_ms,last_dispatch_ms)
                 VALUES (?,?,?,10000,?) ON CONFLICT(project_id,model_id,location)
                 DO UPDATE SET last_dispatch_ms=excluded.last_dispatch_ms",
                params![plan.project_id,plan.execution.model_id,plan.execution.location,at],
            )?;
        }
        Ok(())
    }

    /// Only a received HTTP 429 may increase the lane interval. All jobs and
    /// approval generations using this lane inherit its cooldown and server floor.
    pub(super) fn pace_rejection(
        &self,
        conn: &Connection,
        plan: &PreparedJob,
        ordinal: u32,
        timing: RejectionTiming,
    ) -> Result<Option<i64>> {
        if !self.pacing_applies(plan, ordinal) {
            return Ok(None);
        }
        let lane = lane(conn, plan)?;
        let interval = (lane.interval * 2).min(MAX_INTERVAL_MS);
        let jitter = i64::from(timing.jitter) % (interval / 5 + 1);
        let next = lane
            .cooldown
            .max(timing.at.saturating_add(interval + jitter))
            .max(timing.server_floor.unwrap_or(0));
        conn.execute(
            "INSERT INTO ai_transcription_pacing(project_id,model_id,location,interval_ms,last_dispatch_ms,cooldown_until_ms)
             VALUES (?,?,?,?,?,?) ON CONFLICT(project_id,model_id,location)
             DO UPDATE SET interval_ms=excluded.interval_ms,success_streak=0,cooldown_until_ms=excluded.cooldown_until_ms",
            params![plan.project_id,plan.execution.model_id,plan.execution.location,interval,lane.last_dispatch,next],
        )?;
        Ok(Some(next))
    }

    pub(super) fn pace_outcome(
        &self,
        conn: &Connection,
        plan: &PreparedJob,
        ordinal: u32,
        success: bool,
    ) -> Result<()> {
        if self.pacing_applies(plan, ordinal) {
            conn.execute(
                "UPDATE ai_transcription_pacing SET
                 interval_ms=CASE WHEN ? AND success_streak=2 THEN MAX(10000,interval_ms-5000) ELSE interval_ms END,
                 success_streak=CASE WHEN ? THEN (success_streak+1)%3 ELSE 0 END
                 WHERE project_id=? AND model_id=? AND location=?",
                params![success,success,plan.project_id,plan.execution.model_id,plan.execution.location],
            )?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
