use crate::application::*;
use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use surtitle_ai::*;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSnapshot {
    pub(crate) media: Vec<surtitle_core::Media>,
    pub(crate) cards: Vec<surtitle_core::StudyCard>,
    pub(crate) tools: Vec<crate::application::tool_runtime::ToolStatus>,
    pub(crate) settings: surtitle_core::AppSettings,
    pub(crate) jobs: Vec<JobSummary>,
    pub(crate) budgets: std::collections::BTreeMap<surtitle_core::AiProvider, BudgetSummary>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobSummary {
    pub(crate) provider: surtitle_core::AiProvider,
    pub(crate) id: String,
    pub(crate) media_id: Option<String>,
    pub(crate) kind: String,
    pub(crate) status: String,
    pub(crate) progress: f64,
    pub(crate) request_counts: RequestCounts,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) execution_outcome: Option<String>,
    pub(crate) message: Option<String>,
    pub(crate) created_at: String,
    pub(crate) pending_results: usize,
    pub(crate) transcript_review: bool,
    pub(crate) has_transcript_result: bool,
    pub(crate) needs_attention: bool,
    pub(crate) result_state: String,
    pub(crate) issue: Option<surtitle_ai::JobIssue>,
    pub(crate) automatic_transcript: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub(crate) transcription_ranges: Vec<TranscriptionRangeSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) retry: Option<RetryStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) pacing: Option<PacingStatus>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TranscriptionRangeSummary {
    pub(crate) start_ms: u64,
    pub(crate) end_ms: u64,
    pub(crate) state: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetSummary {
    pub(crate) spent_usd: f64,
    pub(crate) reserved_usd: f64,
    pub(crate) limit_usd: f64,
    pub(crate) unknown_attempts: Vec<UnknownAttemptSummary>,
    pub(crate) unpriced_attempts: u64,
    pub(crate) monetary_totals_complete: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnknownAttemptSummary {
    pub(crate) id: String,
    pub(crate) job_id: String,
    pub(crate) ordinal: u32,
    pub(crate) held_usd: Option<f64>,
    pub(crate) created_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuoteRequest {
    #[serde(default)]
    pub(crate) provider: Option<surtitle_core::AiProvider>,
    #[serde(default)]
    pub(crate) ai_configuration_generation: Option<u64>,
    pub(crate) media_id: String,
    pub(crate) kind: String,
    pub(crate) start_ms: u64,
    pub(crate) end_ms: u64,
    #[serde(default)]
    pub(crate) focus_term: Option<String>,
    #[serde(default)]
    pub(crate) model: Option<surtitle_core::AiModelPreference>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiQuote {
    pub(crate) ai_configuration_generation: u64,
    pub(crate) provider: surtitle_core::AiProvider,
    pub(crate) id: String,
    pub(crate) media_id: String,
    pub(crate) kind: String,
    pub(crate) start_ms: u64,
    pub(crate) end_ms: u64,
    pub(crate) model: String,
    pub(crate) estimated_usd: Option<f64>,
    pub(crate) maximum_usd: Option<f64>,
    pub(crate) input_tokens: u64,
    pub(crate) max_output_tokens: u32,
    pub(crate) expires_at: String,
    pub(crate) warnings: Vec<String>,
    pub(crate) can_approve: bool,
    pub(crate) blocked_reason: Option<String>,
    pub(crate) is_retry: bool,
    pub(crate) focus_term: Option<String>,
    pub(crate) digest: String,
    pub(crate) request_count: usize,
    pub(crate) send_duration_ms: u64,
    pub(crate) total_output_tokens: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) retry_policy: Option<RetryPolicy>,
    pub(crate) maximum_request_count: usize,
    pub(crate) maximum_send_duration_ms: u64,
    pub(crate) maximum_total_output_tokens: u64,
    pub(crate) pricing_source: Option<String>,
    pub(crate) unpriced: bool,
    pub(crate) location: String,
    pub(crate) apply_policy: TranscriptApplyPolicy,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedAiResult {
    pub(crate) job_id: String,
    pub(crate) ordinal: u32,
    pub(crate) applied: bool,
    pub(crate) can_apply: bool,
    pub(crate) blocked_reason: Option<String>,
    pub(crate) translations: Vec<SavedTranslation>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedTranslation {
    pub(crate) source: String,
    pub(crate) translation: String,
    pub(crate) start_ms: u64,
    pub(crate) end_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VocabularyCandidate {
    pub(crate) id: String,
    pub(crate) media_id: String,
    pub(crate) segment_id: String,
    pub(crate) term: String,
    pub(crate) meaning: String,
    pub(crate) example: String,
    pub(crate) explanation: String,
    pub(crate) translation: Option<String>,
    pub(crate) source_cue_ids: Vec<String>,
    pub(crate) start_ms: u64,
    pub(crate) end_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparationSummary {
    pub(crate) provider: surtitle_core::AiProvider,
    pub(crate) ai_configuration_generation: u64,
    pub(crate) compatible: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) chunk_profile: Option<surtitle_ai::AudioChunkProfile>,
    pub(crate) id: String,
    pub(crate) media_id: String,
    pub(crate) start_ms: u64,
    pub(crate) end_ms: u64,
    pub(crate) core_duration_ms: u64,
    pub(crate) send_duration_ms: u64,
    pub(crate) chunk_count: usize,
    pub(crate) whole_media: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) audio_stream_index: Option<u32>,
}

pub(crate) mod bindings;
pub(crate) mod runtime;
pub(crate) mod scheduler;
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
