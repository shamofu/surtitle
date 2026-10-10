use crate::{models::*, AiError, ExecutionConfig, Result};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

mod accounting;
mod approval;
mod dispatch;
mod initialize;
mod issues;
mod local_applications;
mod pacing;
mod read;
mod retries;
mod settlement;
pub use issues::JobIssue;
pub use pacing::PacingStatus;
pub use retries::{RetryPolicy, RetryStatus};

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
    /// Generation of the approval that reserved this exact attempt.
    pub approval_id: Option<String>,
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
}

fn audit(conn: &Connection, at: i64, event: &str, job: Option<&str>, detail: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO ai_audit(at_ms,event,job_id,detail) VALUES (?,?,?,?)",
        params![at, event, job, detail],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod fault_tests;
