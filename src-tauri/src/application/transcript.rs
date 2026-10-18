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
    id: String,
    media_id: String,
    start_ms: u64,
    end_ms: u64,
    core_duration_ms: u64,
    send_duration_ms: u64,
    chunk_count: usize,
    job_id: Option<String>,
    repair_parent_job_id: Option<String>,
    repair_boundary_id: Option<String>,
    whole_media: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    audio_stream_index: Option<u32>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptReview {
    job_id: String,
    media_id: String,
    draft: TranscriptDraft,
    applied: bool,
    can_apply: bool,
    blocked_reason: Option<String>,
    repair_alternatives: Vec<RepairAlternative>,
    results: Vec<TranscriptResultReview>,
    range_edits: Vec<surtitle_core::store::TranscriptRangeEdit<ManualRangeRevision>>,
    manual_editing_blocked_reason: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairAlternative {
    job_id: String,
    boundary_id: String,
    draft: TranscriptDraft,
}

pub(crate) mod storage;
use storage::*;
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
