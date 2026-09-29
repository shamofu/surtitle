//! Local authored ranges never become provider responses or word timestamps.
use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TranscriptRangeSource {
    Provider,
    LocalReparse,
    Manual,
    Unresolved,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ManualTranscriptContent {
    Subtitles { segments: Vec<ReviewText> },
    ConfirmedNoSpeech,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManualRangeBinding {
    pub job_id: String,
    pub job_digest: String,
    pub preparation_id: String,
    pub source_sha256: String,
    pub source_revision: String,
    pub ordinal: u32,
    pub request_start_ms: u64,
    pub request_end_ms: u64,
    pub input_sha256: String,
    pub request_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManualRangeRevision {
    pub id: String,
    pub ordinal: u32,
    pub created_at: String,
    pub binding: ManualRangeBinding,
    pub content: ManualTranscriptContent,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum TranscriptRangeSelection {
    Original,
    Manual {
        #[serde(rename = "revisionId")]
        revision_id: String,
    },
}

impl ManualRangeRevision {
    pub fn validate(&self, binding: &ManualRangeBinding) -> Result<()> {
        if &self.binding != binding
            || self.ordinal != binding.ordinal
            || uuid::Uuid::parse_str(&self.id).is_err()
            || chrono::DateTime::parse_from_rfc3339(&self.created_at).is_err()
            || binding.request_start_ms >= binding.request_end_ms
            || [
                &binding.job_digest,
                &binding.source_sha256,
                &binding.input_sha256,
                &binding.request_sha256,
            ]
            .iter()
            .any(|s| s.len() != 64 || !s.bytes().all(|b| b.is_ascii_hexdigit()))
        {
            return Err(invalid("Manual range binding changed"));
        }
        match &self.content {
            ManualTranscriptContent::Subtitles { segments } => {
                if segments.is_empty()
                    || segments.len() > 5000
                    || segments.iter().map(|s| s.text.len()).sum::<usize>() > 1024 * 1024
                {
                    return Err(invalid("Manual subtitles require bounded nonempty content; confirm no speech explicitly"));
                }
                validate_texts(segments, binding.request_start_ms, binding.request_end_ms)
            }
            ManualTranscriptContent::ConfirmedNoSpeech => Ok(()),
        }
    }
    fn segments(&self) -> Vec<ReviewText> {
        match &self.content {
            ManualTranscriptContent::Subtitles { segments } => segments.clone(),
            ManualTranscriptContent::ConfirmedNoSpeech => vec![],
        }
    }
}

pub(super) fn validate_chunk_source(draft: &TranscriptDraft, chunk: &ReviewChunk) -> Result<()> {
    if chunk.original_source == TranscriptRangeSource::Manual
        || chunk.original_source == TranscriptRangeSource::Unresolved
            && !chunk.original_segments.is_empty()
    {
        return Err(invalid("Invalid original range provenance"));
    }
    validate_texts(
        &chunk.original_segments,
        chunk.request_start_ms,
        chunk.request_end_ms,
    )?;
    if let Some(revision) = &chunk.manual_revision {
        revision.validate(&revision.binding)?;
        let binding = &revision.binding;
        if binding.preparation_id != draft.id
            || binding.source_sha256 != draft.source_sha256
            || binding.source_revision != draft.source_revision
            || binding.ordinal != chunk.ordinal
            || binding.request_start_ms != chunk.request_start_ms
            || binding.request_end_ms != chunk.request_end_ms
            || chunk.source != TranscriptRangeSource::Manual
            || chunk.status != "received"
            || chunk.segments != revision.segments()
        {
            return Err(invalid("Manual range differs from its immutable revision"));
        }
    } else if chunk.source != chunk.original_source
        || chunk.segments != chunk.original_segments
        || (chunk.status == "pending") != (chunk.source == TranscriptRangeSource::Unresolved)
    {
        return Err(invalid("Effective range differs from its selected source"));
    }
    Ok(())
}

pub(super) fn selection_identity(chunk: &ReviewChunk) -> String {
    // Include original updates as well as local revision identity. Review choices
    // cannot survive a changed neighbor merely because its displayed text matches.
    sha256_bytes(
        &serde_json::to_vec(&(
            chunk.source,
            chunk.original_source,
            chunk.range_version,
            &chunk.original_segments,
            chunk
                .manual_revision
                .as_ref()
                .map(|r| (&r.id, &r.binding, &r.content)),
            &chunk.segments,
        ))
        .expect("Range provenance contains serializable values"),
    )
}

/// Rebuild from trusted received responses and immutable local selections.
/// Preserve only decisions whose complete alternative/provenance identity survives.
pub fn apply_manual_transcript_ranges(
    base: &TranscriptDraft,
    reparsed_ordinals: &[u32],
    revisions: &[ManualRangeRevision],
    range_versions: &[(u32, u64)],
    previous: Option<&TranscriptDraft>,
) -> Result<TranscriptDraft> {
    validate_transcript_draft(base)?;
    let mut draft = base.clone();
    for chunk in &mut draft.chunks {
        chunk.source = chunk.original_source;
        chunk.status = if chunk.original_source == TranscriptRangeSource::Unresolved {
            "pending"
        } else {
            "received"
        }
        .into();
        chunk.segments = chunk.original_segments.clone();
        chunk.manual_revision = None;
    }
    let mut seen_versions = std::collections::HashSet::new();
    for &(ordinal, version) in range_versions {
        if !seen_versions.insert(ordinal) {
            return Err(invalid("Duplicate range selection version"));
        }
        draft
            .chunks
            .get_mut(ordinal as usize)
            .ok_or_else(|| invalid("Unknown range selection version"))?
            .range_version = version;
    }
    for &ordinal in reparsed_ordinals {
        let chunk = draft
            .chunks
            .get_mut(ordinal as usize)
            .ok_or_else(|| invalid("Unknown reparsed range"))?;
        if chunk.source != TranscriptRangeSource::Provider {
            return Err(invalid("Reparse has no selected output"));
        }
        chunk.source = TranscriptRangeSource::LocalReparse;
        chunk.original_source = TranscriptRangeSource::LocalReparse;
    }
    let mut seen = std::collections::HashSet::new();
    for revision in revisions {
        if !seen.insert(revision.ordinal) {
            return Err(invalid("Duplicate selected manual range"));
        }
        let chunk = draft
            .chunks
            .get_mut(revision.ordinal as usize)
            .ok_or_else(|| invalid("Unknown manual range"))?;
        chunk.source = TranscriptRangeSource::Manual;
        chunk.status = "received".into();
        chunk.segments = revision.segments();
        chunk.manual_revision = Some(revision.clone());
    }
    let (_, mut conflicts, joins) = assemble(&draft.chunks)?;
    let mut warnings = warnings_for_chunks(&draft.chunks);
    if let Some(previous) = previous {
        validate_transcript_draft(previous)?;
        if previous.id != draft.id
            || previous.source_sha256 != draft.source_sha256
            || previous.source_revision != draft.source_revision
        {
            return Err(invalid("Previous review belongs to another source"));
        }
        for conflict in &mut conflicts {
            if let Some(saved) = previous.conflicts.iter().find(|c| c.id == conflict.id) {
                conflict.resolution = saved.resolution.clone();
            }
        }
        for warning in &mut warnings {
            warning.acknowledged = previous
                .warnings
                .iter()
                .any(|w| w.id == warning.id && w.acknowledged);
        }
    }
    draft.conflicts = conflicts;
    draft.edge_group_joins = joins;
    draft.warnings = warnings;
    refresh(&mut draft)?;
    Ok(draft)
}
