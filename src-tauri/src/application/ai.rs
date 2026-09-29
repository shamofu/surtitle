use crate::application::*;
use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use surtitle_ai::*;
use tauri::Emitter;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSnapshot {
    media: Vec<surtitle_core::Media>,
    cards: Vec<surtitle_core::StudyCard>,
    tools: Vec<crate::application::tool_runtime::ToolStatus>,
    settings: surtitle_core::AppSettings,
    jobs: Vec<JobSummary>,
    budget: BudgetSummary,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobSummary {
    id: String,
    media_id: Option<String>,
    kind: String,
    status: String,
    progress: f64,
    message: Option<String>,
    created_at: String,
    pending_results: usize,
    transcript_review: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetSummary {
    spent_usd: f64,
    reserved_usd: f64,
    limit_usd: f64,
    unknown_attempts: Vec<UnknownAttemptSummary>,
    unpriced_attempts: u64,
    monetary_totals_complete: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnknownAttemptSummary {
    id: String,
    job_id: String,
    ordinal: u32,
    held_usd: Option<f64>,
    created_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuoteRequest {
    media_id: String,
    kind: String,
    start_ms: u64,
    end_ms: u64,
    #[serde(default)]
    focus_term: Option<String>,
    #[serde(default)]
    model: Option<surtitle_core::AiModelPreference>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiQuote {
    id: String,
    media_id: String,
    kind: String,
    start_ms: u64,
    end_ms: u64,
    model: String,
    estimated_usd: Option<f64>,
    maximum_usd: Option<f64>,
    input_tokens: u64,
    max_output_tokens: u32,
    expires_at: String,
    warnings: Vec<String>,
    can_approve: bool,
    blocked_reason: Option<String>,
    is_retry: bool,
    focus_term: Option<String>,
    digest: String,
    request_count: usize,
    send_duration_ms: u64,
    total_output_tokens: u64,
    pricing_source: Option<String>,
    unpriced: bool,
    location: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedAiResult {
    job_id: String,
    ordinal: u32,
    applied: bool,
    can_apply: bool,
    blocked_reason: Option<String>,
    translations: Vec<SavedTranslation>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedTranslation {
    source: String,
    translation: String,
    start_ms: u64,
    end_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VocabularyCandidate {
    id: String,
    media_id: String,
    segment_id: String,
    term: String,
    meaning: String,
    example: String,
    explanation: String,
    translation: Option<String>,
    source_cue_ids: Vec<String>,
    start_ms: u64,
    end_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparationSummary {
    id: String,
    media_id: String,
    start_ms: u64,
    end_ms: u64,
    core_duration_ms: u64,
    send_duration_ms: u64,
    chunk_count: usize,
}

pub(crate) mod bindings;
pub(crate) mod snapshot;
use bindings::*;
pub(crate) mod quotes;
use quotes::*;
pub(crate) mod jobs;
pub(crate) mod results;
use results::*;
#[cfg(feature = "e2e-test")]
pub(crate) mod fixtures;
pub(crate) mod preparation;

#[cfg(test)]
mod tests;
