//! Range-local study selection. A snapshot neither adopts a whole transcript nor
//! authorizes work, settles an attempt, or certifies provider word precision.
use super::*;

const STUDY_SCHEMA_VERSION: u32 = 1;
const MAX_STUDY_CUES: usize = 50;
const MAX_STUDY_TEXT_BYTES: usize = 128 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum StudySelectionRequest {
    Cues {
        #[serde(rename = "cueIds")]
        cue_ids: Vec<String>,
    },
    SourceChunk {
        ordinal: u32,
    },
}

/// Existing cue IDs include their global display index. Stable local anchors
/// keep an unrelated earlier insertion from invalidating a selection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum StudySelectionIdentity {
    Cues { anchors: Vec<ReviewText> },
    SourceChunk { ordinal: u32 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StudySelectionPrecision {
    CueRange,
    SourceBlock,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct StudySelectionFingerprint(String);

impl StudySelectionFingerprint {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudyChunkRevision {
    pub ordinal: u32,
    pub core_range: ReviewRange,
    pub request_range: ReviewRange,
    pub source: TranscriptRangeSource,
    pub original_source: TranscriptRangeSource,
    pub range_version: u64,
    pub manual_revision_id: Option<String>,
    pub manual_binding_revision: Option<String>,
    pub local_text_revision: String,
    pub local_timing_revision: String,
    pub original_local_revision: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudyPendingChunk {
    pub ordinal: u32,
    pub request_range: ReviewRange,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum StudyConfirmationBlocker {
    SourceBlockOnly,
    PendingChunk { ordinal: u32 },
    UnresolvedBoundary { id: String },
    UnresolvedWarning { id: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudySelectionSnapshot {
    pub schema_version: u32,
    pub draft_id: String,
    pub media_id: String,
    pub source_sha256: String,
    pub source_revision: String,
    pub selection: StudySelectionIdentity,
    pub range: ReviewRange,
    pub precision: StudySelectionPrecision,
    pub selected_text: String,
    pub text_revision: String,
    pub timing_revision: String,
    pub relevant_chunks: Vec<StudyChunkRevision>,
    pub intersecting_boundaries: Vec<ReviewConflict>,
    pub intersecting_warnings: Vec<ReviewWarning>,
    pub intersecting_pending_chunks: Vec<StudyPendingChunk>,
    pub intersecting_joins: Vec<ReviewEdgeGroupJoin>,
    pub confirmation_blockers: Vec<StudyConfirmationBlocker>,
    pub can_confirm: bool,
    pub fingerprint: StudySelectionFingerprint,
}

fn intersects(start: u64, end: u64, range: &ReviewRange) -> bool {
    start < range.end_ms && end > range.start_ms
}

fn digest<T: Serialize>(value: &T) -> Result<String> {
    Ok(sha256_bytes(&serde_json::to_vec(value)?))
}

fn text_revision(rows: &[ReviewText]) -> Result<String> {
    digest(&rows.iter().map(|row| &row.text).collect::<Vec<_>>())
}

fn timing_revision(rows: &[ReviewText]) -> Result<String> {
    digest(
        &rows
            .iter()
            .map(|row| (row.start_ms, row.end_ms))
            .collect::<Vec<_>>(),
    )
}

fn cue_anchor(cue: &ReviewCue) -> ReviewText {
    ReviewText {
        start_ms: cue.start_ms,
        end_ms: cue.end_ms,
        text: cue.text.clone(),
    }
}

fn selected_anchors(draft: &TranscriptDraft, cue_ids: &[String]) -> Result<Vec<ReviewText>> {
    if cue_ids.is_empty() || cue_ids.len() > MAX_STUDY_CUES {
        return Err(invalid("Select between one and fifty contiguous cues"));
    }
    let first = draft
        .segments
        .iter()
        .position(|cue| cue.id == cue_ids[0])
        .ok_or_else(|| invalid("Selected study cue is missing"))?;
    let selected = draft
        .segments
        .get(first..first + cue_ids.len())
        .filter(|rows| rows.iter().zip(cue_ids).all(|(row, id)| row.id == *id))
        .ok_or_else(|| invalid("Study cues must be contiguous and ordered"))?;
    Ok(selected.iter().map(cue_anchor).collect())
}

fn find_anchors(draft: &TranscriptDraft, anchors: &[ReviewText]) -> Result<()> {
    if anchors.is_empty()
        || anchors.len() > MAX_STUDY_CUES
        || anchors.iter().map(|cue| cue.text.len()).sum::<usize>() > MAX_STUDY_TEXT_BYTES
    {
        return Err(invalid("Stored study cue selection exceeds its bounds"));
    }
    let mut matches = draft.segments.windows(anchors.len()).filter(|window| {
        window.iter().zip(anchors).all(|(cue, anchor)| {
            cue.start_ms == anchor.start_ms
                && cue.end_ms == anchor.end_ms
                && cue.text == anchor.text
        })
    });
    if matches.next().is_none() || matches.next().is_some() {
        return Err(invalid("Study selection changed or is ambiguous"));
    }
    Ok(())
}

fn fingerprint(snapshot: &StudySelectionSnapshot) -> Result<StudySelectionFingerprint> {
    let mut unsigned = snapshot.clone();
    unsigned.fingerprint.0.clear();
    Ok(StudySelectionFingerprint(digest(&unsigned)?))
}

/// Build from trusted current draft data and existing selected IDs only. A
/// source-block selection intentionally exposes no inferred sentence/word times.
pub fn build_study_selection_snapshot(
    draft: &TranscriptDraft,
    request: &StudySelectionRequest,
) -> Result<StudySelectionSnapshot> {
    validate_transcript_draft(draft)?;
    let identity = match request {
        StudySelectionRequest::Cues { cue_ids } => StudySelectionIdentity::Cues {
            anchors: selected_anchors(draft, cue_ids)?,
        },
        StudySelectionRequest::SourceChunk { ordinal } => {
            StudySelectionIdentity::SourceChunk { ordinal: *ordinal }
        }
    };
    build_from_identity(draft, identity)
}

fn build_from_identity(
    draft: &TranscriptDraft,
    selection: StudySelectionIdentity,
) -> Result<StudySelectionSnapshot> {
    let (range, precision, rows) = match &selection {
        StudySelectionIdentity::Cues { anchors } => {
            find_anchors(draft, anchors)?;
            (
                ReviewRange {
                    start_ms: anchors[0].start_ms,
                    end_ms: anchors.iter().map(|cue| cue.end_ms).max().unwrap(),
                },
                StudySelectionPrecision::CueRange,
                anchors.clone(),
            )
        }
        StudySelectionIdentity::SourceChunk { ordinal } => {
            let chunk = draft
                .chunks
                .get(*ordinal as usize)
                .filter(|chunk| chunk.ordinal == *ordinal)
                .ok_or_else(|| invalid("Selected source block is missing"))?;
            (
                ReviewRange {
                    start_ms: chunk.request_start_ms,
                    end_ms: chunk.request_end_ms,
                },
                StudySelectionPrecision::SourceBlock,
                chunk.segments.clone(),
            )
        }
    };
    let selected_text = rows
        .iter()
        .map(|cue| cue.text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    if selected_text.len() > MAX_STUDY_TEXT_BYTES {
        return Err(invalid("Study selection text exceeds its bounded size"));
    }
    let mut relevant_chunks = Vec::new();
    let mut intersecting_pending_chunks = Vec::new();
    for chunk in &draft.chunks {
        if !intersects(chunk.request_start_ms, chunk.request_end_ms, &range) {
            continue;
        }
        let local = chunk
            .segments
            .iter()
            .filter(|cue| intersects(cue.start_ms, cue.end_ms, &range))
            .cloned()
            .collect::<Vec<_>>();
        let original = chunk
            .original_segments
            .iter()
            .filter(|cue| intersects(cue.start_ms, cue.end_ms, &range))
            .collect::<Vec<_>>();
        relevant_chunks.push(StudyChunkRevision {
            ordinal: chunk.ordinal,
            core_range: ReviewRange {
                start_ms: chunk.core_start_ms,
                end_ms: chunk.core_end_ms,
            },
            request_range: ReviewRange {
                start_ms: chunk.request_start_ms,
                end_ms: chunk.request_end_ms,
            },
            source: chunk.source,
            original_source: chunk.original_source,
            range_version: chunk.range_version,
            manual_revision_id: chunk
                .manual_revision
                .as_ref()
                .map(|revision| revision.id.clone()),
            manual_binding_revision: chunk
                .manual_revision
                .as_ref()
                .map(|revision| digest(&revision.binding))
                .transpose()?,
            local_text_revision: text_revision(&local)?,
            local_timing_revision: timing_revision(&local)?,
            original_local_revision: digest(&original)?,
        });
        if chunk.status == "pending" {
            intersecting_pending_chunks.push(StudyPendingChunk {
                ordinal: chunk.ordinal,
                request_range: ReviewRange {
                    start_ms: chunk.request_start_ms,
                    end_ms: chunk.request_end_ms,
                },
            });
        }
    }
    let intersecting_boundaries = draft
        .conflicts
        .iter()
        .filter(|conflict| intersects(conflict.start_ms, conflict.end_ms, &range))
        .cloned()
        .collect::<Vec<_>>();
    let intersecting_warnings = draft
        .warnings
        .iter()
        .filter(|warning| intersects(warning.start_ms, warning.end_ms, &range))
        .cloned()
        .collect::<Vec<_>>();
    let intersecting_joins = draft
        .edge_group_joins
        .iter()
        .filter(|join| intersects(join.joined.start_ms, join.joined.end_ms, &range))
        .cloned()
        .collect();
    let mut confirmation_blockers = Vec::new();
    if precision == StudySelectionPrecision::SourceBlock {
        confirmation_blockers.push(StudyConfirmationBlocker::SourceBlockOnly);
    }
    confirmation_blockers.extend(intersecting_pending_chunks.iter().map(|chunk| {
        StudyConfirmationBlocker::PendingChunk {
            ordinal: chunk.ordinal,
        }
    }));
    confirmation_blockers.extend(
        intersecting_boundaries
            .iter()
            .filter(|conflict| conflict.resolution.is_none())
            .map(|conflict| StudyConfirmationBlocker::UnresolvedBoundary {
                id: conflict.id.clone(),
            }),
    );
    // A warning acknowledgment alone does not correct text or timing. An
    // immutable local manual range is an explicit resolution with provenance.
    confirmation_blockers.extend(
        intersecting_warnings
            .iter()
            .filter(|warning| {
                let chunk = &draft.chunks[warning.ordinal as usize];
                chunk.source != TranscriptRangeSource::Manual || chunk.manual_revision.is_none()
            })
            .map(|warning| StudyConfirmationBlocker::UnresolvedWarning {
                id: warning.id.clone(),
            }),
    );
    let mut snapshot = StudySelectionSnapshot {
        schema_version: STUDY_SCHEMA_VERSION,
        draft_id: draft.id.clone(),
        media_id: draft.media_id.clone(),
        source_sha256: draft.source_sha256.clone(),
        source_revision: draft.source_revision.clone(),
        selection,
        range,
        precision,
        selected_text,
        text_revision: text_revision(&rows)?,
        timing_revision: if precision == StudySelectionPrecision::CueRange {
            timing_revision(&rows)?
        } else {
            digest(&(
                StudySelectionPrecision::SourceBlock,
                &relevant_chunks
                    .iter()
                    .map(|chunk| (&chunk.core_range, &chunk.request_range))
                    .collect::<Vec<_>>(),
            ))?
        },
        relevant_chunks,
        intersecting_boundaries,
        intersecting_warnings,
        intersecting_pending_chunks,
        intersecting_joins,
        can_confirm: confirmation_blockers.is_empty(),
        confirmation_blockers,
        fingerprint: StudySelectionFingerprint(String::new()),
    };
    snapshot.fingerprint = fingerprint(&snapshot)?;
    Ok(snapshot)
}

/// Revalidate only the selected source/contents and touching dependencies. The
/// full current draft is validated for integrity, but its digest is not bound.
pub fn validate_study_selection_snapshot(
    current: &TranscriptDraft,
    snapshot: &StudySelectionSnapshot,
) -> Result<()> {
    validate_transcript_draft(current)?;
    if snapshot.schema_version != STUDY_SCHEMA_VERSION
        || fingerprint(snapshot)? != snapshot.fingerprint
    {
        return Err(invalid("Study snapshot fingerprint differs"));
    }
    let rebuilt = build_from_identity(current, snapshot.selection.clone())?;
    if rebuilt != *snapshot {
        return Err(invalid(
            "Selected study range or its neighboring evidence changed",
        ));
    }
    Ok(())
}

/// This local confirmation gate is independent of whole-transcript adoption.
/// It grants neither paid-job approval nor precise word-level replay semantics.
pub fn confirm_study_selection_snapshot(
    current: &TranscriptDraft,
    snapshot: &StudySelectionSnapshot,
) -> Result<()> {
    validate_study_selection_snapshot(current, snapshot)?;
    if !snapshot.can_confirm || snapshot.precision != StudySelectionPrecision::CueRange {
        return Err(invalid(
            "Resolve the selected range locally before study confirmation",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(count: u32) -> TranscriptReviewInput {
        let chunks = (0..count)
            .map(|ordinal| AudioChunk {
                index: ordinal,
                sample_rate: 1000,
                core_start_sample: ordinal as u64 * 10_000,
                core_end_sample: (ordinal as u64 + 1) * 10_000,
                request_start_sample: (ordinal as u64 * 10_000).saturating_sub(1000),
                request_end_sample: ((ordinal as u64 + 1) * 10_000 + 1000)
                    .min(count as u64 * 10_000),
                boundary: BoundaryKind::Forced,
            })
            .collect::<Vec<_>>();
        let attachments = chunks
            .iter()
            .map(|chunk| crate::AudioAttachment {
                path: format!("unused-{}.wav", chunk.index).into(),
                sha256: sha256_bytes(format!("audio-{}", chunk.index).as_bytes()),
                byte_len: 10,
                mime_type: "audio/wav".into(),
                source_start_ms: chunk.request_start_ms(),
                duration_ms: chunk.request_duration_ms(),
            })
            .collect();
        TranscriptReviewInput {
            id: "preparation".into(),
            media_id: "media".into(),
            source_sha256: sha256_bytes(b"source"),
            source_revision: "source-one".into(),
            chunks,
            attachments,
            vad_no_speech_ordinals: vec![],
            vad_pause_evidence: None,
        }
    }
    fn response(ordinal: u32, rows: &[(u64, u64, &str)]) -> ChunkResponse {
        ChunkResponse {
            ordinal,
            output: ParsedOutput::Transcript {
                cues: rows
                    .iter()
                    .map(|&(start_ms, end_ms, text)| crate::GeneratedCue {
                        start_ms,
                        end_ms,
                        text: text.into(),
                    })
                    .collect(),
            },
        }
    }
    fn select(draft: &TranscriptDraft, text: &str) -> StudySelectionSnapshot {
        build_study_selection_snapshot(
            draft,
            &StudySelectionRequest::Cues {
                cue_ids: vec![draft
                    .segments
                    .iter()
                    .find(|cue| cue.text == text)
                    .unwrap()
                    .id
                    .clone()],
            },
        )
        .unwrap()
    }
    fn build(source: &TranscriptReviewInput, responses: &[ChunkResponse]) -> TranscriptDraft {
        build_transcript_draft_from_input(source, responses).unwrap()
    }

    #[test]
    fn incomplete_job_can_confirm_an_unaffected_range_and_late_earlier_cues_do_not_stale_it() {
        let source = input(3);
        let selected = response(
            1,
            &[
                (11_500, 12_000, "Selected."),
                (15_000, 15_500, "Elsewhere."),
            ],
        );
        let before = build(&source, std::slice::from_ref(&selected));
        assert!(!before.can_adopt);
        let snapshot = select(&before, "Selected.");
        confirm_study_selection_snapshot(&before, &snapshot).unwrap();
        let after = build(
            &source,
            &[response(0, &[(1000, 1500, "Arrived later.")]), selected],
        );
        assert_ne!(before.segments[0].id, after.segments[1].id);
        assert_ne!(before.digest, after.digest);
        confirm_study_selection_snapshot(&after, &snapshot).unwrap();
        let changed_elsewhere = build(
            &source,
            &[
                response(0, &[(1000, 1500, "Changed before.")]),
                response(
                    1,
                    &[
                        (11_500, 12_000, "Selected."),
                        (15_000, 15_500, "Changed elsewhere."),
                    ],
                ),
            ],
        );
        confirm_study_selection_snapshot(&changed_elsewhere, &snapshot).unwrap();
    }

    #[test]
    fn text_and_timing_revisions_change_independently_and_old_selection_is_rejected() {
        let source = input(1);
        let original = build(&source, &[response(0, &[(1000, 1500, "Original.")])]);
        let snapshot = select(&original, "Original.");
        let text = build(&source, &[response(0, &[(1000, 1500, "Corrected.")])]);
        let text_snapshot = select(&text, "Corrected.");
        assert_ne!(snapshot.text_revision, text_snapshot.text_revision);
        assert_eq!(snapshot.timing_revision, text_snapshot.timing_revision);
        assert!(validate_study_selection_snapshot(&text, &snapshot).is_err());
        let timing = build(&source, &[response(0, &[(1100, 1600, "Original.")])]);
        let timing_snapshot = select(&timing, "Original.");
        assert_eq!(snapshot.text_revision, timing_snapshot.text_revision);
        assert_ne!(snapshot.timing_revision, timing_snapshot.timing_revision);
        assert!(validate_study_selection_snapshot(&timing, &snapshot).is_err());
    }

    #[test]
    fn selection_requires_existing_ordered_contiguous_and_unambiguous_cues() {
        let source = input(1);
        let draft = build(
            &source,
            &[response(
                0,
                &[(1000, 1500, "A"), (2000, 2500, "B"), (3000, 3500, "C")],
            )],
        );
        for cue_ids in [
            vec![],
            vec!["missing".into()],
            vec![draft.segments[1].id.clone(), draft.segments[0].id.clone()],
            vec![draft.segments[0].id.clone(), draft.segments[2].id.clone()],
            vec![draft.segments[0].id.clone(); 51],
        ] {
            assert!(build_study_selection_snapshot(
                &draft,
                &StudySelectionRequest::Cues { cue_ids }
            )
            .is_err());
        }
        let two = build_study_selection_snapshot(
            &draft,
            &StudySelectionRequest::Cues {
                cue_ids: draft.segments[..2]
                    .iter()
                    .map(|cue| cue.id.clone())
                    .collect(),
            },
        )
        .unwrap();
        assert_eq!(two.selected_text, "A\nB");
        let ambiguous = build(
            &source,
            &[response(0, &[(1000, 1500, "Same"), (1000, 1500, "Same")])],
        );
        assert!(build_study_selection_snapshot(
            &ambiguous,
            &StudySelectionRequest::Cues {
                cue_ids: vec![ambiguous.segments[0].id.clone()]
            }
        )
        .is_err());
    }

    #[test]
    fn touching_pending_context_blocks_confirmation_but_source_block_remains_inspectable() {
        let source = input(2);
        let draft = build(
            &source,
            &[response(
                0,
                &[(9500, 9900, "Neighbor can still change this.")],
            )],
        );
        let snapshot = select(&draft, "Neighbor can still change this.");
        assert!(snapshot
            .confirmation_blockers
            .contains(&StudyConfirmationBlocker::PendingChunk { ordinal: 1 }));
        assert!(confirm_study_selection_snapshot(&draft, &snapshot).is_err());
        let block = build_study_selection_snapshot(
            &draft,
            &StudySelectionRequest::SourceChunk { ordinal: 1 },
        )
        .unwrap();
        assert_eq!(block.precision, StudySelectionPrecision::SourceBlock);
        assert_eq!(
            block.range,
            ReviewRange {
                start_ms: 9000,
                end_ms: 20_000
            }
        );
        assert!(block.selected_text.is_empty());
        validate_study_selection_snapshot(&draft, &block).unwrap();
        assert!(confirm_study_selection_snapshot(&draft, &block).is_err());
        assert!(build_study_selection_snapshot(
            &draft,
            &StudySelectionRequest::SourceChunk { ordinal: 99 }
        )
        .is_err());
        let received = build(
            &source,
            &[response(
                1,
                &[
                    (9200, 9600, "Context words."),
                    (11_000, 11_500, "Core words."),
                ],
            )],
        );
        let with_context = build_study_selection_snapshot(
            &received,
            &StudySelectionRequest::SourceChunk { ordinal: 1 },
        )
        .unwrap();
        assert_eq!(with_context.selected_text, "Context words.\nCore words.");
        assert_eq!(with_context.range.start_ms, 9000);
        assert!(matches!(
            with_context.selection,
            StudySelectionIdentity::SourceChunk { ordinal: 1 }
        ));
    }

    #[test]
    fn neighboring_conflicts_block_confirmation_and_resolutions_invalidate_old_snapshots() {
        let source = input(2);
        let draft = build(
            &source,
            &[
                response(0, &[(1000, 1200, "Unrelated."), (9900, 10_200, "Left.")]),
                response(1, &[(9900, 10_200, "Right.")]),
            ],
        );
        assert_eq!(draft.conflicts.len(), 1);
        let local = select(&draft, "Left.");
        assert_eq!(local.intersecting_boundaries.len(), 1);
        assert!(confirm_study_selection_snapshot(&draft, &local).is_err());
        let unrelated = select(&draft, "Unrelated.");
        assert!(unrelated.intersecting_boundaries.is_empty());
        confirm_study_selection_snapshot(&draft, &unrelated).unwrap();
        let resolved = resolve_transcript_boundary(
            &draft,
            &draft.digest,
            &draft.conflicts[0].id,
            BoundaryChoice::Left,
        )
        .unwrap();
        assert!(validate_study_selection_snapshot(&resolved, &local).is_err());
        confirm_study_selection_snapshot(&resolved, &select(&resolved, "Left.")).unwrap();
        confirm_study_selection_snapshot(&resolved, &unrelated).unwrap();
        let changed_neighbor = build(
            &source,
            &[
                response(0, &[(9900, 10_200, "Left.")]),
                response(1, &[(9900, 10_200, "Changed neighbor.")]),
            ],
        );
        assert!(validate_study_selection_snapshot(&changed_neighbor, &local).is_err());
    }

    #[test]
    fn acknowledgment_is_not_warning_resolution_but_valid_immutable_manual_content_is() {
        let mut source = input(1);
        source.vad_no_speech_ordinals = vec![0];
        let draft = build(&source, &[response(0, &[(1000, 1500, "Claimed speech.")])]);
        let acknowledged =
            acknowledge_transcript_warning(&draft, &draft.digest, &draft.warnings[0].id).unwrap();
        let snapshot = select(&acknowledged, "Claimed speech.");
        assert!(acknowledged.can_adopt);
        assert!(!snapshot.can_confirm);
        assert!(confirm_study_selection_snapshot(&acknowledged, &snapshot).is_err());
        let revision = ManualRangeRevision {
            id: uuid::Uuid::new_v4().to_string(),
            ordinal: 0,
            created_at: "2026-09-12T00:00:00Z".into(),
            binding: ManualRangeBinding {
                job_id: "job".into(),
                job_digest: sha256_bytes(b"job"),
                preparation_id: source.id.clone(),
                source_sha256: source.source_sha256.clone(),
                source_revision: source.source_revision.clone(),
                ordinal: 0,
                request_start_ms: 0,
                request_end_ms: 10_000,
                input_sha256: sha256_bytes(b"input"),
                request_sha256: sha256_bytes(b"request"),
            },
            content: ManualTranscriptContent::Subtitles {
                segments: vec![ReviewText {
                    start_ms: 1000,
                    end_ms: 1500,
                    text: "Locally checked speech.".into(),
                }],
            },
        };
        let manual = apply_manual_transcript_ranges(
            &draft,
            &[],
            &[revision],
            &[(0, 1)],
            Some(&acknowledged),
        )
        .unwrap();
        let local = select(&manual, "Locally checked speech.");
        assert_eq!(
            local.relevant_chunks[0].source,
            TranscriptRangeSource::Manual
        );
        assert!(!local.intersecting_warnings.is_empty());
        confirm_study_selection_snapshot(&manual, &local).unwrap();
    }

    #[test]
    fn forged_snapshot_missing_selection_and_other_source_are_rejected() {
        let source = input(1);
        let draft = build(&source, &[response(0, &[(1000, 1500, "Selected.")])]);
        let snapshot = select(&draft, "Selected.");
        for mutation in 0..5 {
            let mut forged = snapshot.clone();
            match mutation {
                0 => forged.selected_text = "Invented.".into(),
                1 => forged.range.end_ms += 1,
                2 => forged.relevant_chunks.clear(),
                3 => forged.text_revision = sha256_bytes(b"other"),
                _ => forged.source_sha256 = sha256_bytes(b"other"),
            }
            assert!(validate_study_selection_snapshot(&draft, &forged).is_err());
            // Recomputing a public hash cannot authorize invented current data.
            forged.fingerprint = fingerprint(&forged).unwrap();
            assert!(validate_study_selection_snapshot(&draft, &forged).is_err());
        }
        let missing = build(&source, &[]);
        assert!(validate_study_selection_snapshot(&missing, &snapshot).is_err());
        let mut other = input(1);
        other.media_id = "another media".into();
        assert!(validate_study_selection_snapshot(
            &build(&other, &[response(0, &[(1000, 1500, "Selected.")])]),
            &snapshot
        )
        .is_err());
    }
}
