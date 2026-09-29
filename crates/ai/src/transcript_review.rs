//! Pure, local subtitle review. Provider capability gates and paid execution are
//! deliberately absent. Raw chunk variants survive every explicit resolution.
use crate::{
    sha256_bytes, stitch_chunks, AiError, AudioChunk, AudioPreparationReceipt, BoundaryKind,
    ChunkTranscript, ParsedOutput, Result, TimedText, VadPauseEvidence,
};
use serde::{Deserialize, Serialize};
mod manual;
pub use manual::*;
mod study;
pub use study::*;

const MAX_CUES: usize = 50_000;
const MAX_TEXT_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChunkResponse {
    pub ordinal: u32,
    pub output: ParsedOutput,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewText {
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}
impl From<TimedText> for ReviewText {
    fn from(value: TimedText) -> Self {
        Self {
            start_ms: value.start_ms,
            end_ms: value.end_ms,
            text: value.text,
        }
    }
}
impl From<ReviewText> for TimedText {
    fn from(value: ReviewText) -> Self {
        Self {
            start_ms: value.start_ms,
            end_ms: value.end_ms,
            text: value.text,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewCue {
    pub id: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRange {
    pub start_ms: u64,
    pub end_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewChunk {
    pub ordinal: u32,
    pub core_start_ms: u64,
    pub core_end_ms: u64,
    pub request_start_ms: u64,
    pub request_end_ms: u64,
    pub status: String,
    pub segments: Vec<ReviewText>,
    pub source: TranscriptRangeSource,
    pub original_source: TranscriptRangeSource,
    pub original_segments: Vec<ReviewText>,
    pub manual_revision: Option<ManualRangeRevision>,
    pub range_version: u64,
    #[serde(default)]
    pub no_speech_detected: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vad_pause_evidence: Option<VadPauseEvidence>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewWarning {
    pub id: String,
    pub kind: String,
    pub ordinal: u32,
    pub start_ms: u64,
    pub end_ms: u64,
    pub acknowledged: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewEdgeGroupJoin {
    pub id: String,
    pub method: String,
    pub anchor_kind: String,
    pub left_ordinal: u32,
    pub right_ordinal: u32,
    pub left_segment_indices: Vec<usize>,
    pub right_segment_indices: Vec<usize>,
    pub overlap_units: usize,
    pub joined: ReviewText,
}

/// Exact source timeline for local review, without credentials, tool execution,
/// prices or permission to send. Used by native receipts and offline evaluation.
pub struct TranscriptReviewInput {
    pub id: String,
    pub media_id: String,
    pub source_sha256: String,
    pub source_revision: String,
    pub chunks: Vec<AudioChunk>,
    pub attachments: Vec<crate::AudioAttachment>,
    pub vad_no_speech_ordinals: Vec<u32>,
    pub vad_pause_evidence: Option<VadPauseEvidence>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BoundaryChoice {
    Left,
    Right,
    KeepBoth,
    Manual { segments: Vec<ReviewText> },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewConflict {
    pub id: String,
    pub at_ms: u64,
    pub start_ms: u64,
    pub end_ms: u64,
    pub left_ordinal: u32,
    pub right_ordinal: u32,
    pub left_alternative: Vec<ReviewText>,
    pub right_alternative: Vec<ReviewText>,
    pub resolution: Option<BoundaryChoice>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptDraft {
    pub id: String,
    pub media_id: String,
    pub source_sha256: String,
    pub source_revision: String,
    pub digest: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub segments: Vec<ReviewCue>,
    pub chunks: Vec<ReviewChunk>,
    pub conflicts: Vec<ReviewConflict>,
    pub pending_ranges: Vec<ReviewRange>,
    pub can_adopt: bool,
    #[serde(default)]
    pub warnings: Vec<ReviewWarning>,
    #[serde(default)]
    pub edge_group_joins: Vec<ReviewEdgeGroupJoin>,
}

pub fn build_transcript_draft(
    receipt: &AudioPreparationReceipt,
    responses: &[ChunkResponse],
) -> Result<TranscriptDraft> {
    if receipt.source_sha256 != receipt.prepared_job.binding.source_sha256 {
        return Err(invalid("Receipt source binding differs"));
    }
    if receipt
        .vad_pause_evidence
        .as_ref()
        .is_some_and(|evidence| evidence.model_sha256 != receipt.model_sha256)
    {
        return Err(invalid("Receipt VAD model binding differs"));
    }
    let attachments = receipt
        .prepared_job
        .requests
        .iter()
        .map(|request| match request {
            crate::RequestTask::TranscribePreview { audio, .. }
            | crate::RequestTask::AudioTranscription { audio, .. } => Ok(audio.clone()),
            _ => Err(invalid("Transcript draft requires audio requests")),
        })
        .collect::<Result<Vec<_>>>()?;
    build_transcript_draft_from_input(
        &TranscriptReviewInput {
            id: receipt.id.clone(),
            media_id: receipt.prepared_job.binding.media_id.clone(),
            source_sha256: receipt.source_sha256.clone(),
            source_revision: receipt.prepared_job.binding.transcript_revision.clone(),
            chunks: receipt.chunks.clone(),
            attachments,
            vad_no_speech_ordinals: receipt.vad_no_speech_ordinals.clone(),
            vad_pause_evidence: receipt.vad_pause_evidence.clone(),
        },
        responses,
    )
}

pub fn build_transcript_draft_from_input(
    input: &TranscriptReviewInput,
    responses: &[ChunkResponse],
) -> Result<TranscriptDraft> {
    if input.chunks.is_empty()
        || input.chunks.len() > 5000
        || input.chunks.len() != input.attachments.len()
        || input.id.is_empty()
        || input.media_id.is_empty()
        || input.source_revision.is_empty()
        || input.source_sha256.len() != 64
        || !input.source_sha256.bytes().all(|b| b.is_ascii_hexdigit())
        || input
            .vad_no_speech_ordinals
            .iter()
            .any(|ordinal| *ordinal as usize >= input.chunks.len())
        || input
            .vad_no_speech_ordinals
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len()
            != input.vad_no_speech_ordinals.len()
    {
        return Err(invalid("Receipt chunk and request counts differ"));
    }
    if let Some(evidence) = &input.vad_pause_evidence {
        evidence.validate()?;
        if input
            .chunks
            .iter()
            .any(|chunk| chunk.sample_rate != evidence.sample_rate)
            || input.chunks[0].core_start_sample != evidence.source_start_sample
            || input.chunks.last().unwrap().core_end_sample != evidence.source_end_sample
        {
            return Err(invalid(
                "VAD pause evidence differs from the prepared source range",
            ));
        }
    }
    let mut by_ordinal = std::collections::BTreeMap::new();
    for response in responses {
        if response.ordinal as usize >= input.chunks.len()
            || by_ordinal
                .insert(response.ordinal, &response.output)
                .is_some()
        {
            return Err(invalid("Duplicate or unknown response ordinal"));
        }
    }
    let mut chunks = Vec::with_capacity(input.chunks.len());
    let mut count = 0usize;
    let mut bytes = 0usize;
    for (ordinal, chunk) in input.chunks.iter().enumerate() {
        if chunk.index as usize != ordinal
            || chunk.sample_rate == 0
            || chunk.core_start_sample >= chunk.core_end_sample
            || chunk.request_start_sample > chunk.core_start_sample
            || chunk.request_end_sample < chunk.core_end_sample
            || ordinal > 0
                && (input.chunks[ordinal - 1].core_end_sample != chunk.core_start_sample
                    || input.chunks[ordinal - 1].sample_rate != chunk.sample_rate)
        {
            return Err(invalid("Invalid or discontinuous receipt timeline"));
        }
        let audio = &input.attachments[ordinal];
        if audio.source_start_ms != chunk.request_start_ms()
            || audio.duration_ms != chunk.request_duration_ms()
        {
            return Err(invalid("Prepared attachment differs from chunk timeline"));
        }
        let mut segments = Vec::new();
        let status = if let Some(output) = by_ordinal.get(&(ordinal as u32)) {
            let ParsedOutput::Transcript { cues } = output else {
                return Err(invalid("Saved response is not a transcript"));
            };
            for cue in cues {
                segments.push(ReviewText {
                    start_ms: cue.start_ms,
                    end_ms: cue.end_ms,
                    text: cue.text.clone(),
                });
            }
            "received"
        } else {
            "pending"
        };
        count = count.saturating_add(segments.len());
        bytes = bytes.saturating_add(segments.iter().map(|s| s.text.len()).sum::<usize>());
        if count > MAX_CUES || bytes > MAX_TEXT_BYTES {
            return Err(invalid("Transcript review exceeds bounded size"));
        }
        validate_texts(
            &segments,
            chunk.request_start_ms(),
            chunk
                .request_start_ms()
                .saturating_add(chunk.request_duration_ms()),
        )?;
        chunks.push(ReviewChunk {
            ordinal: ordinal as u32,
            core_start_ms: chunk.core_start_ms(),
            // Preserve the final partial PCM millisecond consistently with the
            // prepared attachment's outward-rounded request duration.
            core_end_ms: if ordinal + 1 == input.chunks.len() {
                chunk.request_start_ms() + chunk.request_duration_ms()
            } else {
                chunk.core_end_ms()
            },
            request_start_ms: chunk.request_start_ms(),
            request_end_ms: chunk.request_start_ms() + chunk.request_duration_ms(),
            status: status.into(),
            source: if status == "received" {
                TranscriptRangeSource::Provider
            } else {
                TranscriptRangeSource::Unresolved
            },
            original_source: if status == "received" {
                TranscriptRangeSource::Provider
            } else {
                TranscriptRangeSource::Unresolved
            },
            original_segments: segments.clone(),
            manual_revision: None,
            range_version: 0,
            segments,
            no_speech_detected: input.vad_no_speech_ordinals.contains(&(ordinal as u32)),
            vad_pause_evidence: input
                .vad_pause_evidence
                .as_ref()
                .and_then(|evidence| evidence.for_chunk(chunk)),
        });
    }
    let start_ms = chunks[0].core_start_ms;
    let end_ms = chunks.last().unwrap().core_end_ms;
    let (_, conflicts, edge_group_joins) = assemble(&chunks)?;
    let warnings = warnings_for_chunks(&chunks);
    let mut draft = TranscriptDraft {
        id: input.id.clone(),
        media_id: input.media_id.clone(),
        source_sha256: input.source_sha256.clone(),
        source_revision: input.source_revision.clone(),
        digest: String::new(),
        start_ms,
        end_ms,
        segments: vec![],
        chunks,
        conflicts,
        pending_ranges: vec![],
        can_adopt: false,
        warnings,
        edge_group_joins,
    };
    refresh(&mut draft)?;
    Ok(draft)
}

/// Native code should load its saved draft and pass only the renderer's digest,
/// boundary ID and explicit choice. The renderer never supplies original chunks.
pub fn resolve_transcript_boundary(
    draft: &TranscriptDraft,
    expected_digest: &str,
    boundary_id: &str,
    choice: BoundaryChoice,
) -> Result<TranscriptDraft> {
    verify_digest(draft, expected_digest)?;
    let mut updated = draft.clone();
    let conflict = updated
        .conflicts
        .iter_mut()
        .find(|c| c.id == boundary_id)
        .ok_or_else(|| invalid("Unknown boundary"))?;
    if let BoundaryChoice::Manual { segments } = &choice {
        validate_texts(segments, conflict.start_ms, conflict.end_ms)?;
    }
    conflict.resolution = Some(choice);
    refresh(&mut updated)?;
    Ok(updated)
}

/// A VAD disagreement is a review warning, never a reason to delete provider
/// speech or call another model. Explicit acceptance keeps every original cue.
pub fn acknowledge_transcript_warning(
    draft: &TranscriptDraft,
    expected_digest: &str,
    warning_id: &str,
) -> Result<TranscriptDraft> {
    verify_digest(draft, expected_digest)?;
    validate_transcript_draft(draft)?;
    let mut updated = draft.clone();
    let warning = updated
        .warnings
        .iter_mut()
        .find(|warning| warning.id == warning_id)
        .ok_or_else(|| invalid("Unknown transcript warning"))?;
    warning.acknowledged = true;
    refresh(&mut updated)?;
    Ok(updated)
}

pub fn boundary_repair_range(
    draft: &TranscriptDraft,
    expected_digest: &str,
    boundary_id: &str,
) -> Result<ReviewRange> {
    verify_digest(draft, expected_digest)?;
    let conflict = draft
        .conflicts
        .iter()
        .find(|c| c.id == boundary_id)
        .ok_or_else(|| invalid("Unknown boundary"))?;
    let start_ms = conflict.at_ms.saturating_sub(15_000).max(draft.start_ms);
    let end_ms = conflict.at_ms.saturating_add(15_000).min(draft.end_ms);
    if start_ms >= end_ms || end_ms - start_ms > 30_000 {
        return Err(invalid("Invalid repair interval"));
    }
    Ok(ReviewRange { start_ms, end_ms })
}

pub fn validate_transcript_adoption(draft: &TranscriptDraft, expected_digest: &str) -> Result<()> {
    verify_digest(draft, expected_digest)?;
    validate_transcript_draft(draft)?;
    if !draft.can_adopt {
        return Err(invalid(
            "Finish pending chunks and boundary review before adoption",
        ));
    }
    Ok(())
}

pub fn validate_transcript_draft(draft: &TranscriptDraft) -> Result<()> {
    verify_digest(draft, &draft.digest)?;
    let mut rebuilt = draft.clone();
    refresh(&mut rebuilt)?;
    if rebuilt != *draft {
        return Err(invalid(
            "Saved review differs from its original chunks and choices",
        ));
    }
    Ok(())
}

type AssembledDraft = (
    Vec<ReviewText>,
    Vec<ReviewConflict>,
    Vec<ReviewEdgeGroupJoin>,
);

fn assemble(chunks: &[ReviewChunk]) -> Result<AssembledDraft> {
    let mut segments = Vec::new();
    let mut conflicts: Vec<ReviewConflict> = Vec::new();
    let mut joins = Vec::new();
    let mut position = 0;
    while position < chunks.len() {
        if chunks[position].status == "pending" {
            position += 1;
            continue;
        }
        let start = position;
        while position < chunks.len() && chunks[position].status == "received" {
            position += 1;
        }
        if start == position {
            return Err(invalid("Invalid chunk review status"));
        }
        let run = chunks[start..position]
            .iter()
            .map(|c| ChunkTranscript {
                chunk: AudioChunk {
                    index: c.ordinal,
                    sample_rate: 1000,
                    core_start_sample: c.core_start_ms,
                    core_end_sample: c.core_end_ms,
                    request_start_sample: c.request_start_ms,
                    request_end_sample: c.request_end_ms,
                    boundary: BoundaryKind::Forced,
                },
                segments: c.segments.clone().into_iter().map(Into::into).collect(),
            })
            .collect();
        let stitched = stitch_chunks(run)?;
        segments.extend(stitched.segments.into_iter().map(ReviewText::from));
        for join in stitched.group_joins {
            let mut evidence = ReviewEdgeGroupJoin {
                id: String::new(),
                method: "exact_transport_edge_group_v1".into(),
                anchor_kind: "observed_cue_intervals".into(),
                left_ordinal: join.left_chunk,
                right_ordinal: join.right_chunk,
                left_segment_indices: join.left_segment_indices,
                right_segment_indices: join.right_segment_indices,
                overlap_units: join.overlap_units,
                joined: join.joined.into(),
            };
            evidence.id = sha256_bytes(&serde_json::to_vec(&evidence)?);
            joins.push(evidence);
        }
        for conflict in stitched.boundary_conflicts {
            let left: Vec<ReviewText> = conflict
                .left_alternative
                .into_iter()
                .map(Into::into)
                .collect();
            let right: Vec<ReviewText> = conflict
                .right_alternative
                .into_iter()
                .map(Into::into)
                .collect();
            let start_ms = left
                .iter()
                .chain(&right)
                .map(|s| s.start_ms)
                .min()
                .unwrap_or(conflict.at_ms);
            let end_ms = left
                .iter()
                .chain(&right)
                .map(|s| s.end_ms)
                .max()
                .unwrap_or(conflict.at_ms + 1);
            let mut next = ReviewConflict {
                id: String::new(),
                at_ms: conflict.at_ms,
                start_ms,
                end_ms,
                left_ordinal: conflict.left_chunk,
                right_ordinal: conflict.right_chunk,
                left_alternative: left,
                right_alternative: right,
                resolution: None,
            };
            // A long cue may touch multiple boundaries. Review that connected
            // region together so one choice cannot silently overwrite another.
            if let Some(previous) = conflicts
                .last_mut()
                .filter(|previous| previous.end_ms > next.start_ms)
            {
                previous.start_ms = previous.start_ms.min(next.start_ms);
                previous.end_ms = previous.end_ms.max(next.end_ms);
                previous.right_ordinal = next.right_ordinal;
                for value in next.left_alternative {
                    if !previous.left_alternative.contains(&value) {
                        previous.left_alternative.push(value);
                    }
                }
                for value in next.right_alternative {
                    if !previous.right_alternative.contains(&value) {
                        previous.right_alternative.push(value);
                    }
                }
                previous
                    .left_alternative
                    .sort_by_key(|value| value.start_ms);
                previous
                    .right_alternative
                    .sort_by_key(|value| value.start_ms);
                previous.id = conflict_digest(previous, chunks)?;
            } else {
                next.id = conflict_digest(&next, chunks)?;
                conflicts.push(next);
            }
        }
    }
    segments.sort_by_key(|s| s.start_ms);
    Ok((segments, conflicts, joins))
}

fn refresh(draft: &mut TranscriptDraft) -> Result<()> {
    if draft.chunks.is_empty()
        || draft.chunks.len() > 5000
        || draft.chunks[0].core_start_ms != draft.start_ms
        || draft.chunks.last().unwrap().core_end_ms != draft.end_ms
    {
        return Err(invalid("Invalid draft source interval"));
    }
    let mut count = 0usize;
    let mut bytes = 0usize;
    let mut vad_provenance: Option<&VadPauseEvidence> = None;
    for (index, chunk) in draft.chunks.iter().enumerate() {
        manual::validate_chunk_source(draft, chunk)?;
        if chunk.ordinal as usize != index
            || chunk.core_start_ms >= chunk.core_end_ms
            || chunk.request_start_ms > chunk.core_start_ms
            || chunk.request_end_ms < chunk.core_end_ms
            || chunk.request_start_ms < draft.start_ms
            || chunk.request_end_ms > draft.end_ms
            || index > 0 && draft.chunks[index - 1].core_end_ms != chunk.core_start_ms
            || !["pending", "received"].contains(&chunk.status.as_str())
            || chunk.status == "pending" && !chunk.segments.is_empty()
        {
            return Err(invalid("Invalid stored chunk timeline or state"));
        }
        validate_texts(
            &chunk.segments,
            chunk.request_start_ms,
            chunk.request_end_ms,
        )?;
        if let Some(evidence) = &chunk.vad_pause_evidence {
            evidence.validate()?;
            if evidence.source_start_sample / 16 != draft.start_ms
                || evidence.source_end_sample.div_ceil(16) != draft.end_ms
                || evidence.pauses.is_empty()
                || evidence.pauses.iter().any(|pause| {
                    pause.end_sample <= chunk.request_start_ms.saturating_mul(16)
                        || pause.start_sample >= chunk.request_end_ms.saturating_mul(16)
                })
                || vad_provenance.is_some_and(|first| {
                    first.model_sha256 != evidence.model_sha256
                        || first.runtime_sha256 != evidence.runtime_sha256
                        || first.source_start_sample != evidence.source_start_sample
                        || first.source_end_sample != evidence.source_end_sample
                })
            {
                return Err(invalid("Stored VAD provenance or pause scope changed"));
            }
            vad_provenance = Some(evidence);
        }
        count = count.saturating_add(chunk.segments.len());
        bytes = bytes.saturating_add(chunk.segments.iter().map(|s| s.text.len()).sum::<usize>());
    }
    if count > MAX_CUES || bytes > MAX_TEXT_BYTES {
        return Err(invalid("Stored review exceeds bounded size"));
    }
    let expected_warnings = warnings_for_chunks(&draft.chunks);
    if expected_warnings.len() != draft.warnings.len()
        || expected_warnings
            .iter()
            .zip(&draft.warnings)
            .any(|(expected, actual)| {
                let mut original = actual.clone();
                original.acknowledged = false;
                expected != &original
            })
    {
        return Err(invalid("Original VAD warning evidence changed"));
    }
    let (mut segments, expected, joins) = assemble(&draft.chunks)?;
    if joins != draft.edge_group_joins {
        return Err(invalid("Original edge-group join evidence changed"));
    }
    if expected.len() != draft.conflicts.len()
        || expected.iter().zip(&draft.conflicts).any(|(a, b)| {
            let mut original = b.clone();
            original.resolution = None;
            a != &original
        })
    {
        return Err(invalid("Original boundary alternatives changed"));
    }
    for conflict in &draft.conflicts {
        if let Some(choice) = &conflict.resolution {
            let chosen = match choice {
                BoundaryChoice::Left => conflict.left_alternative.clone(),
                BoundaryChoice::Right => conflict.right_alternative.clone(),
                BoundaryChoice::KeepBoth => conflict
                    .left_alternative
                    .iter()
                    .chain(&conflict.right_alternative)
                    .cloned()
                    .collect(),
                BoundaryChoice::Manual { segments } => {
                    validate_texts(segments, conflict.start_ms, conflict.end_ms)?;
                    segments.clone()
                }
            };
            segments.retain(|value| {
                !conflict.left_alternative.contains(value)
                    && !conflict.right_alternative.contains(value)
            });
            segments.extend(chosen);
        }
    }
    segments.sort_by_key(|s| s.start_ms);
    if segments.len() > MAX_CUES
        || segments.iter().map(|s| s.text.len()).sum::<usize>() > MAX_TEXT_BYTES
    {
        return Err(invalid("Resolved transcript exceeds bounded size"));
    }
    draft.pending_ranges = draft
        .chunks
        .iter()
        .filter(|c| c.status == "pending")
        .map(|c| ReviewRange {
            start_ms: c.core_start_ms,
            end_ms: c.core_end_ms,
        })
        .collect();
    draft.segments = segments
        .into_iter()
        .enumerate()
        .map(|(index, s)| {
            let conflict = draft
                .conflicts
                .iter()
                .any(|c| c.resolution.is_none() && s.start_ms < c.end_ms && s.end_ms > c.start_ms);
            let pending = draft
                .chunks
                .iter()
                .filter(|c| c.status == "pending")
                .any(|c| s.start_ms < c.request_end_ms && s.end_ms > c.request_start_ms);
            let warning = draft.warnings.iter().any(|warning| {
                !warning.acknowledged && s.start_ms < warning.end_ms && s.end_ms > warning.start_ms
            });
            let id = sha256_bytes(
                format!(
                    "{}:{index}:{}:{}:{}",
                    draft.id, s.start_ms, s.end_ms, s.text
                )
                .as_bytes(),
            );
            ReviewCue {
                id,
                start_ms: s.start_ms,
                end_ms: s.end_ms,
                text: s.text,
                status: if conflict || pending || warning {
                    "provisional"
                } else {
                    "confirmed"
                }
                .into(),
            }
        })
        .collect();
    draft.can_adopt = draft.pending_ranges.is_empty()
        && draft.conflicts.iter().all(|c| c.resolution.is_some())
        && draft.warnings.iter().all(|warning| warning.acknowledged);
    draft.digest = String::new();
    draft.digest = sha256_bytes(&serde_json::to_vec(draft)?);
    Ok(())
}

fn warnings_for_chunks(chunks: &[ReviewChunk]) -> Vec<ReviewWarning> {
    let mut warnings = Vec::new();
    for chunk in chunks {
        if chunk.segments.is_empty() {
            continue;
        }
        // A second warning for the same silent chunk would be ambiguous.
        if chunk.no_speech_detected {
            warnings.push(ReviewWarning {
                id: sha256_bytes(
                    format!(
                        "vad-no-speech:{}:{}:{}:{}",
                        chunk.ordinal,
                        chunk.request_start_ms,
                        chunk.request_end_ms,
                        manual::selection_identity(chunk)
                    )
                    .as_bytes(),
                ),
                kind: "speech_in_vad_no_speech_range".into(),
                ordinal: chunk.ordinal,
                start_ms: chunk.request_start_ms,
                end_ms: chunk.request_end_ms,
                acknowledged: false,
            });
            continue;
        }
        let Some(evidence) = &chunk.vad_pause_evidence else {
            continue;
        };
        let mut flagged = std::collections::BTreeSet::new();
        // Each cue can be wholly inside at most one ordered, disjoint pause.
        // Binary lookup avoids scanning every pause for every subtitle.
        for cue in &chunk.segments {
            let after = evidence
                .pauses
                .partition_point(|pause| evidence.guarded_range(pause).0 <= cue.start_ms);
            if let Some(index) = after.checked_sub(1) {
                let (_, end_ms) = evidence.guarded_range(&evidence.pauses[index]);
                if cue.end_ms <= end_ms {
                    flagged.insert(index);
                }
            }
        }
        for index in flagged {
            let pause = &evidence.pauses[index];
            let (start_ms, end_ms) = evidence.guarded_range(pause);
            let id = sha256_bytes(
                format!(
                    "vad-pause:{}:{}:{}:{}:{}:{}:{}:{}:{}:{}",
                    chunk.ordinal,
                    evidence.policy,
                    evidence.model_sha256,
                    evidence.runtime_sha256,
                    evidence.source_start_sample,
                    evidence.source_end_sample,
                    pause.start_sample,
                    pause.end_sample,
                    evidence.boundary_guard_ms,
                    manual::selection_identity(chunk)
                )
                .as_bytes(),
            );
            warnings.push(ReviewWarning {
                id,
                kind: "speech_in_vad_pause_range".into(),
                ordinal: chunk.ordinal,
                start_ms: start_ms.max(chunk.request_start_ms),
                end_ms: end_ms.min(chunk.request_end_ms),
                acknowledged: false,
            });
        }
    }
    warnings
}

fn conflict_digest(conflict: &ReviewConflict, chunks: &[ReviewChunk]) -> Result<String> {
    Ok(sha256_bytes(&serde_json::to_vec(&(
        conflict.at_ms,
        conflict.start_ms,
        conflict.end_ms,
        conflict.left_ordinal,
        conflict.right_ordinal,
        &conflict.left_alternative,
        &conflict.right_alternative,
        chunks[conflict.left_ordinal as usize..=conflict.right_ordinal as usize]
            .iter()
            .map(manual::selection_identity)
            .collect::<Vec<_>>(),
    ))?))
}
fn verify_digest(draft: &TranscriptDraft, expected: &str) -> Result<()> {
    let mut unhashed = draft.clone();
    unhashed.digest.clear();
    if expected != draft.digest || sha256_bytes(&serde_json::to_vec(&unhashed)?) != draft.digest {
        return Err(AiError::PreparationChanged);
    }
    Ok(())
}
fn validate_texts(segments: &[ReviewText], start: u64, end: u64) -> Result<()> {
    if segments.len() > MAX_CUES {
        return Err(invalid("Too many reviewed subtitles"));
    }
    let mut previous = start;
    for segment in segments {
        if segment.start_ms < start
            || segment.start_ms < previous
            || segment.start_ms >= segment.end_ms
            || segment.end_ms > end
            || segment.text.trim().is_empty()
            || segment.text.len() > 64 * 1024
        {
            return Err(invalid("Invalid subtitle text or timestamp in review"));
        }
        previous = segment.start_ms;
    }
    Ok(())
}
fn invalid(message: &str) -> AiError {
    AiError::Invalid(message.into())
}

#[cfg(test)]
mod tests;
