//! Shared transaction queries and approval/budget invariants.
use super::BudgetLimits;
use crate::{AiError, PreparedJob, RequestEstimate, Result};
use rusqlite::Connection;

pub(super) fn sum_estimates<'a>(
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
pub(super) fn unpriced_count(conn: &Connection, job: Option<&str>) -> Result<u64> {
    Ok(conn.query_row("SELECT COUNT(*) FROM ai_attempts WHERE reserve_microusd IS NULL AND state!='released' AND (?1 IS NULL OR job_id=?1)",[job],|r|r.get::<_,i64>(0))? as u64)
}
pub(super) fn validate_scope(
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
pub(super) fn limits(conn: &Connection) -> Result<BudgetLimits> {
    let s: String = conn.query_row("SELECT limits_json FROM ai_settings WHERE id=1", [], |r| {
        r.get(0)
    })?;
    Ok(serde_json::from_str(&s)?)
}
pub(super) fn read_job(conn: &Connection, id: &str) -> Result<(PreparedJob, String, String, i64)> {
    let (s, d, state, expiry): (String, String, String, i64) = conn.query_row(
        "SELECT plan_json,digest,state,quote_expires_at_ms FROM ai_jobs WHERE id=?",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )?;
    Ok((serde_json::from_str(&s)?, d, state, expiry))
}
pub(super) fn has_blocking_attempt(conn: &Connection) -> Result<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM ai_attempts WHERE state IN ('reserved','unknown'))",
        [],
        |r| r.get(0),
    )?)
}
pub(super) fn job_spend(conn: &Connection, id: &str) -> Result<u64> {
    Ok(conn.query_row("SELECT COALESCE(SUM(COALESCE(charged_microusd,reserve_microusd)),0) FROM ai_attempts WHERE job_id=?",[id],|r|r.get::<_,i64>(0))? as u64)
}
pub(super) fn period_spend(conn: &Connection, start: i64) -> Result<u64> {
    Ok(conn.query_row("SELECT COALESCE(SUM(COALESCE(charged_microusd,reserve_microusd)),0) FROM ai_attempts WHERE COALESCE(dispatched_at_ms,created_at_ms)>=? OR charged_microusd IS NULL",[start],|r|r.get::<_,i64>(0))? as u64)
}
pub(super) fn period_breakdown(conn: &Connection, start: i64) -> Result<(u64, u64)> {
    // An unresolved hold remains conservative capacity in later periods, including
    // after explicit acknowledgement. Calendar rollover never proves it was free.
    Ok(conn.query_row("SELECT COALESCE(SUM(COALESCE(charged_microusd,0)),0),COALESCE(SUM(CASE WHEN charged_microusd IS NULL THEN reserve_microusd ELSE 0 END),0) FROM ai_attempts WHERE COALESCE(dispatched_at_ms,created_at_ms)>=? OR charged_microusd IS NULL",[start],|r|Ok((r.get::<_,i64>(0)? as u64,r.get::<_,i64>(1)? as u64)))?)
}
pub(super) fn period_starts(at: i64) -> Result<(i64, i64)> {
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
pub(super) fn check_budget(conn: &Connection, job: &str, additional: u64, at: i64) -> Result<()> {
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
