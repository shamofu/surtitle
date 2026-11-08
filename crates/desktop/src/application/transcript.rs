//! App-owned audio preparations and local, explicit transcript review.
use crate::application::*;
pub(crate) mod study;
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};
use surtitle_ai::*;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RepairParent {
    job_id: String,
    draft_digest: String,
    boundary_id: String,
    start_ms: u64,
    end_ms: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TranscriptJob {
    job_id: String,
    job_digest: String,
    preparation_id: String,
    receipt_sha256: String,
    repair_parent: Option<RepairParent>,
    #[serde(default)]
    progressive: bool,
    #[serde(default)]
    publication_detached: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionPreparation {
    pub(crate) provider: surtitle_core::AiProvider,
    pub(crate) ai_configuration_generation: u64,
    pub(crate) compatible: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) chunk_profile: Option<AudioChunkProfile>,
    pub(crate) id: String,
    pub(crate) media_id: String,
    pub(crate) start_ms: u64,
    pub(crate) end_ms: u64,
    pub(crate) core_duration_ms: u64,
    pub(crate) send_duration_ms: u64,
    pub(crate) chunk_count: usize,
    pub(crate) job_id: Option<String>,
    pub(crate) repair_parent_job_id: Option<String>,
    pub(crate) repair_boundary_id: Option<String>,
    pub(crate) whole_media: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) audio_stream_index: Option<u32>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptReview {
    pub(crate) job_id: String,
    pub(crate) media_id: String,
    pub(crate) draft: TranscriptDraft,
    pub(crate) applied: bool,
    pub(crate) can_apply: bool,
    pub(crate) blocked_reason: Option<String>,
    pub(crate) repair_alternatives: Vec<RepairAlternative>,
    pub(crate) results: Vec<TranscriptResultReview>,
    pub(crate) range_edits: Vec<surtitle_core::store::TranscriptRangeEdit<ManualRangeRevision>>,
    pub(crate) manual_editing_blocked_reason: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairAlternative {
    pub(crate) job_id: String,
    pub(crate) boundary_id: String,
    pub(crate) draft: TranscriptDraft,
}

pub(crate) mod storage;
use storage::*;
pub(crate) mod policy;
pub(crate) mod preparation;
use preparation::*;
pub(crate) mod ranges;
use ranges::*;
pub(crate) mod review;
use review::*;
pub(crate) mod automatic;
pub(crate) mod repair;
use repair::*;
#[cfg(feature = "e2e-test")]
pub(crate) mod fixtures;
#[cfg(all(test, feature = "e2e-test"))]
use fixtures::*;

#[cfg(all(test, feature = "e2e-test"))]
mod progressive_tests;
#[cfg(all(test, feature = "e2e-test"))]
mod tests;
