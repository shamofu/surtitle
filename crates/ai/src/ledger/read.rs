//! Read-only job quotes, prepared plans, responses, and spend summaries.
use super::accounting::{
    job_spend, limits, period_breakdown, period_spend, period_starts, read_job, sum_estimates,
    unpriced_count,
};
use super::{AiStore, AttemptSummary, BudgetLimits, JobQuote, SpendSummary};
use crate::{AiError, ParsedOutput, PreparedJob, Result};
use rusqlite::params;

impl AiStore {
    pub fn budget(&self) -> Result<BudgetLimits> {
        limits(&self.connect()?)
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
