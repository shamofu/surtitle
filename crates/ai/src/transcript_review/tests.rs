use super::*;
use crate::{AudioAttachment, GeneratedCue, PreparationBinding, PreparedJob, RequestTask};

fn receipt(count: usize) -> AudioPreparationReceipt {
    let end = count as u64 * 120_000;
    let chunks: Vec<_> = (0..count)
        .map(|i| AudioChunk {
            index: i as u32,
            sample_rate: 1000,
            core_start_sample: i as u64 * 120_000,
            core_end_sample: (i + 1) as u64 * 120_000,
            request_start_sample: (i as u64 * 120_000).saturating_sub(3000),
            request_end_sample: ((i + 1) as u64 * 120_000 + 3000).min(end),
            boundary: BoundaryKind::Forced,
        })
        .collect();
    let requests = chunks
        .iter()
        .map(|c| RequestTask::TranscribePreview {
            language: "en".into(),
            audio: AudioAttachment {
                path: format!("chunk-{}.flac", c.index).into(),
                sha256: sha256_bytes(b"audio"),
                byte_len: 5,
                mime_type: "audio/flac".into(),
                source_start_ms: c.request_start_ms(),
                duration_ms: c.request_duration_ms(),
            },
        })
        .collect();
    AudioPreparationReceipt {
        id: "receipt-one".into(),
        directory: "unused".into(),
        source_path: "unused.wav".into(),
        audio_stream_index: Some(0),
        source_sha256: sha256_bytes(b"source"),
        model_sha256: sha256_bytes(b"vad"),
        ffmpeg: surtitle_tools::ToolSnapshot {
            tool: surtitle_tools::ResolvedTool {
                kind: surtitle_tools::ToolKind::FfmpegPair,
                source: surtitle_tools::ToolSource::External,
                selected_path: "ffmpeg".into(),
                executable: "ffmpeg".into(),
                ffprobe: Some("ffprobe".into()),
            },
            executable_sha256: sha256_bytes(b"ffmpeg"),
            ffprobe_sha256: Some(sha256_bytes(b"ffprobe")),
            probe: None,
        },
        chunks,
        vad_no_speech_ordinals: vec![],
        vad_pause_evidence: None,
        prepared_job: PreparedJob::fixture(
            "Review fixture".into(),
            "fixture-project".into(),
            "unused".into(),
            PreparationBinding {
                media_id: "media-one".into(),
                transcript_revision: "revision-one".into(),
                source_sha256: sha256_bytes(b"source"),
                settings_sha256: sha256_bytes(b"settings"),
            },
            requests,
        ),
        created_at_ms: 0,
    }
}
fn response(ordinal: u32, rows: &[(u64, u64, &str)]) -> ChunkResponse {
    ChunkResponse {
        ordinal,
        output: ParsedOutput::Transcript {
            cues: rows
                .iter()
                .map(|(start, end, text)| GeneratedCue {
                    start_ms: *start,
                    end_ms: *end,
                    text: (*text).into(),
                })
                .collect(),
        },
    }
}
fn contradictory() -> Vec<ChunkResponse> {
    vec![
        response(0, &[(119000, 119500, "Yes."), (120000, 120800, "wrong")]),
        response(1, &[(119000, 119500, "Yes."), (120000, 120800, "correct")]),
    ]
}

fn receipt_with_pause() -> AudioPreparationReceipt {
    let mut source = receipt(1);
    for chunk in &mut source.chunks {
        chunk.sample_rate = 16_000;
        chunk.core_start_sample *= 16;
        chunk.core_end_sample *= 16;
        chunk.request_start_sample *= 16;
        chunk.request_end_sample *= 16;
    }
    source.vad_pause_evidence = Some(VadPauseEvidence {
        policy: "silero-low-posterior-0.35-2s-250ms-v1".into(),
        model_sha256: source.model_sha256.clone(),
        runtime_sha256: sha256_bytes(b"runtime"),
        sample_rate: 16_000,
        source_start_sample: 0,
        source_end_sample: 120_000 * 16,
        minimum_pause_ms: 2000,
        boundary_guard_ms: 250,
        pauses: vec![crate::Pause {
            start_sample: 16_384,
            end_sample: 65_536,
        }],
    });
    source
}

#[test]
fn within_chunk_pause_flags_complete_cues_and_preserves_raw_text_and_timing() {
    let source = receipt_with_pause();
    let raw = response(
        0,
        &[
            (100, 900, "Normal speech."),
            (1500, 2500, "Quiet speech or invented?"),
            (2700, 3000, "Again, again."),
        ],
    );
    let draft = build_transcript_draft(&source, &[raw]).unwrap();
    assert!(!draft.can_adopt);
    assert_eq!(draft.warnings.len(), 1);
    let warning = &draft.warnings[0];
    assert_eq!(warning.kind, "speech_in_vad_pause_range");
    assert_eq!((warning.start_ms, warning.end_ms), (1274, 3846));
    assert_eq!(draft.segments[0].status, "confirmed");
    assert!(draft.segments[1..]
        .iter()
        .all(|cue| cue.status == "provisional"));
    assert_eq!(
        draft.chunks[0].vad_pause_evidence,
        source.vad_pause_evidence
    );
    assert_eq!(
        draft.chunks[0].segments[1],
        ReviewText {
            start_ms: 1500,
            end_ms: 2500,
            text: "Quiet speech or invented?".into()
        }
    );
    let checked = acknowledge_transcript_warning(&draft, &draft.digest, &warning.id).unwrap();
    assert!(checked.can_adopt);
    assert_eq!(checked.chunks, draft.chunks);
    assert_eq!(
        checked
            .segments
            .iter()
            .map(|cue| (&cue.text, cue.start_ms, cue.end_ms))
            .collect::<Vec<_>>(),
        draft
            .segments
            .iter()
            .map(|cue| (&cue.text, cue.start_ms, cue.end_ms))
            .collect::<Vec<_>>()
    );
    assert!(acknowledge_transcript_warning(&checked, &draft.digest, &warning.id).is_err());
    validate_transcript_adoption(&checked, &checked.digest).unwrap();
}

#[test]
fn pause_warnings_require_whole_cue_containment_after_both_edge_guards() {
    let source = receipt_with_pause();
    for (start, end, should_warn) in [
        (1000, 1500, false),
        (1273, 1400, false),
        (3600, 3847, false),
        (1274, 3846, true),
        (4096, 4500, false),
        (1000, 5000, false),
    ] {
        let draft = build_transcript_draft(
            &source,
            &[response(0, &[(start, end, "Preserved speech.")])],
        )
        .unwrap();
        assert_eq!(!draft.warnings.is_empty(), should_warn, "{start}..{end}");
        assert_eq!(draft.segments.len(), 1);
        assert_eq!(
            (draft.segments[0].start_ms, draft.segments[0].end_ms),
            (start, end)
        );
    }
}

#[test]
fn pause_evidence_never_converts_missing_results_to_silence_or_duplicates_whole_chunk_ack() {
    let mut source = receipt_with_pause();
    let pending = build_transcript_draft(&source, &[]).unwrap();
    assert!(!pending.can_adopt);
    assert_eq!(pending.pending_ranges.len(), 1);
    assert!(pending.warnings.is_empty());
    assert!(
        build_transcript_draft(&source, &[response(0, &[])])
            .unwrap()
            .can_adopt
    );
    source.vad_no_speech_ordinals = vec![0];
    let draft =
        build_transcript_draft(&source, &[response(0, &[(1500, 2500, "Speech?")])]).unwrap();
    assert_eq!(draft.warnings.len(), 1);
    assert_eq!(draft.warnings[0].kind, "speech_in_vad_no_speech_range");
    let changed =
        build_transcript_draft(&source, &[response(0, &[(1500, 2500, "Changed speech?")])])
            .unwrap();
    assert_ne!(
        draft.warnings[0].id, changed.warnings[0].id,
        "Acknowledgment belongs to the reviewed speech, not only its VAD range"
    );
}

fn manual_revision(
    draft: &TranscriptDraft,
    ordinal: u32,
    content: ManualTranscriptContent,
) -> ManualRangeRevision {
    let chunk = &draft.chunks[ordinal as usize];
    ManualRangeRevision {
        id: uuid::Uuid::new_v4().to_string(),
        ordinal,
        created_at: "2026-09-12T00:00:00Z".into(),
        content,
        binding: ManualRangeBinding {
            job_id: "job".into(),
            job_digest: sha256_bytes(b"job"),
            preparation_id: draft.id.clone(),
            source_sha256: draft.source_sha256.clone(),
            source_revision: draft.source_revision.clone(),
            ordinal,
            request_start_ms: chunk.request_start_ms,
            request_end_ms: chunk.request_end_ms,
            input_sha256: sha256_bytes(b"audio"),
            request_sha256: sha256_bytes(b"request"),
        },
    }
}

#[test]
fn local_range_recovery_is_explicit_bound_and_preserves_missing_originals() {
    let base = build_transcript_draft(&receipt(1), &[]).unwrap();
    let empty = manual_revision(
        &base,
        0,
        ManualTranscriptContent::Subtitles { segments: vec![] },
    );
    assert!(apply_manual_transcript_ranges(&base, &[], &[empty], &[], None).is_err());
    let silence = manual_revision(&base, 0, ManualTranscriptContent::ConfirmedNoSpeech);
    let updated =
        apply_manual_transcript_ranges(&base, &[], std::slice::from_ref(&silence), &[], None)
            .unwrap();
    assert!(updated.can_adopt && updated.segments.is_empty());
    assert_eq!(updated.chunks[0].source, TranscriptRangeSource::Manual);
    assert_eq!(
        updated.chunks[0].original_source,
        TranscriptRangeSource::Unresolved
    );
    assert!(updated.chunks[0].original_segments.is_empty());
    let restored = apply_manual_transcript_ranges(&updated, &[], &[], &[], Some(&updated)).unwrap();
    assert_eq!(restored, base);
    let mut wrong = silence;
    wrong.binding.source_sha256 = sha256_bytes(b"another source");
    assert!(apply_manual_transcript_ranges(&base, &[], &[wrong], &[], None).is_err());
    let invalid = manual_revision(
        &base,
        0,
        ManualTranscriptContent::Subtitles {
            segments: vec![ReviewText {
                start_ms: 0,
                end_ms: 120_015,
                text: "Do not clamp me.".into(),
            }],
        },
    );
    assert!(apply_manual_transcript_ranges(&base, &[], &[invalid], &[], None).is_err());
}

#[test]
fn manual_revision_rebuilds_neighbor_decisions_even_when_text_matches() {
    let base = build_transcript_draft(&receipt(2), &contradictory()).unwrap();
    let resolved = resolve_transcript_boundary(
        &base,
        &base.digest,
        &base.conflicts[0].id,
        BoundaryChoice::Left,
    )
    .unwrap();
    let revision = manual_revision(
        &base,
        1,
        ManualTranscriptContent::Subtitles {
            segments: base.chunks[1].segments.clone(),
        },
    );
    let updated =
        apply_manual_transcript_ranges(&base, &[], &[revision], &[], Some(&resolved)).unwrap();
    assert!(!updated.can_adopt);
    assert!(updated.conflicts[0].resolution.is_none());
    assert_ne!(updated.conflicts[0].id, resolved.conflicts[0].id);
    assert_eq!(updated.chunks[1].original_segments, base.chunks[1].segments);
}

#[test]
fn manual_choice_survives_later_provider_result_and_resets_warning_ack() {
    let mut source = receipt(1);
    source.vad_no_speech_ordinals = vec![0];
    let pending = build_transcript_draft(&source, &[]).unwrap();
    let revision = manual_revision(
        &pending,
        0,
        ManualTranscriptContent::Subtitles {
            segments: vec![ReviewText {
                start_ms: 100,
                end_ms: 500,
                text: "Authored".into(),
            }],
        },
    );
    let selected =
        apply_manual_transcript_ranges(&pending, &[], std::slice::from_ref(&revision), &[], None)
            .unwrap();
    let checked =
        acknowledge_transcript_warning(&selected, &selected.digest, &selected.warnings[0].id)
            .unwrap();
    assert!(checked.can_adopt);
    let received =
        build_transcript_draft(&source, &[response(0, &[(100, 500, "Provider")])]).unwrap();
    let updated =
        apply_manual_transcript_ranges(&received, &[], &[revision], &[], Some(&checked)).unwrap();
    assert_eq!(updated.segments[0].text, "Authored");
    assert_eq!(updated.chunks[0].original_segments[0].text, "Provider");
    assert!(!updated.warnings[0].acknowledged);
    assert_ne!(updated.digest, checked.digest);
}

#[test]
fn pause_scope_provenance_and_warning_cannot_change_behind_a_saved_digest() {
    let mut source = receipt_with_pause();
    let draft =
        build_transcript_draft(&source, &[response(0, &[(1500, 2500, "Speech?")])]).unwrap();
    source.vad_pause_evidence.as_mut().unwrap().model_sha256 = sha256_bytes(b"other model");
    assert!(build_transcript_draft(&source, &[]).is_err());
    source = receipt_with_pause();
    source
        .vad_pause_evidence
        .as_mut()
        .unwrap()
        .source_end_sample += 512;
    assert!(build_transcript_draft(&source, &[]).is_err());
    for mutation in 0..4 {
        let mut changed = draft.clone();
        match mutation {
            0 => changed.warnings.clear(),
            1 => {
                changed.chunks[0]
                    .vad_pause_evidence
                    .as_mut()
                    .unwrap()
                    .pauses[0]
                    .start_sample += 1
            }
            2 => {
                changed.chunks[0]
                    .vad_pause_evidence
                    .as_mut()
                    .unwrap()
                    .boundary_guard_ms = 0
            }
            _ => {
                changed.chunks[0]
                    .vad_pause_evidence
                    .as_mut()
                    .unwrap()
                    .source_end_sample -= 512
            }
        }
        changed.digest.clear();
        changed.digest = sha256_bytes(&serde_json::to_vec(&changed).unwrap());
        assert!(validate_transcript_draft(&changed).is_err());
    }
    let mut changed = draft.clone();
    changed.chunks[0]
        .vad_pause_evidence
        .as_mut()
        .unwrap()
        .runtime_sha256 = sha256_bytes(b"changed runtime");
    assert!(validate_transcript_draft(&changed).is_err());
}

#[test]
fn absent_pause_evidence_stays_absent_when_legacy_receipts_and_drafts_roundtrip() {
    let source = receipt(1);
    let receipt_bytes = serde_json::to_vec(&source).unwrap();
    let value: serde_json::Value = serde_json::from_slice(&receipt_bytes).unwrap();
    assert!(value.get("vad_pause_evidence").is_none());
    let restored: AudioPreparationReceipt = serde_json::from_slice(&receipt_bytes).unwrap();
    assert!(restored.vad_pause_evidence.is_none());
    assert_eq!(serde_json::to_vec(&restored).unwrap(), receipt_bytes);
    let draft = build_transcript_draft(
        &source,
        &[response(0, &[(1500, 2500, "Historical speech.")])],
    )
    .unwrap();
    let bytes = serde_json::to_vec(&draft).unwrap();
    let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert!(value["chunks"][0].get("vadPauseEvidence").is_none());
    let restored: TranscriptDraft = serde_json::from_slice(&bytes).unwrap();
    validate_transcript_draft(&restored).unwrap();
    assert_eq!(serde_json::to_vec(&restored).unwrap(), bytes);
    assert_eq!(restored.digest, draft.digest);
}

#[test]
fn group_join_provenance_is_derived_from_preserved_raw_chunks_and_digest_bound() {
    let raw = vec![
        response(
            0,
            &[(
                115000,
                122800,
                "Before we paused alpha beta gamma delta epsilon zeta eta theta",
            )],
        ),
        response(
            1,
            &[(
                117100,
                126000,
                "alpha beta gamma delta epsilon zeta eta theta after we continued.",
            )],
        ),
    ];
    let draft = build_transcript_draft(&receipt(2), &raw).unwrap();
    assert!(draft.can_adopt);
    assert_eq!(draft.edge_group_joins.len(), 1);
    assert_eq!(
        draft.edge_group_joins[0].anchor_kind,
        "observed_cue_intervals"
    );
    assert_eq!(draft.chunks[0].segments[0].end_ms, 122800);
    assert_eq!(draft.chunks[1].segments[0].start_ms, 117100);
    assert_eq!(draft.segments[0].start_ms, 115000);
    assert_eq!(draft.segments[0].end_ms, 126000);
    validate_transcript_draft(&draft).unwrap();
    let mut tampered = draft.clone();
    tampered.edge_group_joins[0].overlap_units += 1;
    tampered.digest.clear();
    tampered.digest = sha256_bytes(&serde_json::to_vec(&tampered).unwrap());
    assert!(validate_transcript_draft(&tampered).is_err());
    tampered = draft;
    tampered.edge_group_joins.clear();
    tampered.digest.clear();
    tampered.digest = sha256_bytes(&serde_json::to_vec(&tampered).unwrap());
    assert!(validate_transcript_draft(&tampered).is_err());
}

#[test]
fn vad_disagreement_keeps_raw_speech_and_requires_digest_bound_acknowledgment() {
    let mut source = receipt(1);
    source.vad_no_speech_ordinals = vec![0];
    let original = response(0, &[(100, 2000, "Invented or quiet speech?")]);
    let draft = build_transcript_draft(&source, &[original]).unwrap();
    assert!(!draft.can_adopt);
    assert_eq!(draft.warnings.len(), 1);
    assert_eq!(draft.warnings[0].kind, "speech_in_vad_no_speech_range");
    assert_eq!(draft.segments[0].text, "Invented or quiet speech?");
    assert_eq!(draft.segments[0].status, "provisional");
    assert_eq!(draft.chunks[0].segments[0].text, draft.segments[0].text);
    assert!(validate_transcript_adoption(&draft, &draft.digest).is_err());
    assert!(acknowledge_transcript_warning(&draft, "stale", &draft.warnings[0].id).is_err());
    let accepted =
        acknowledge_transcript_warning(&draft, &draft.digest, &draft.warnings[0].id).unwrap();
    assert!(accepted.can_adopt);
    assert_ne!(accepted.digest, draft.digest);
    assert_eq!(accepted.chunks, draft.chunks);
    assert_eq!(accepted.segments[0].text, draft.segments[0].text);
    validate_transcript_adoption(&accepted, &accepted.digest).unwrap();
    let mut deleted_warning = draft.clone();
    deleted_warning.warnings.clear();
    deleted_warning.digest.clear();
    deleted_warning.digest = sha256_bytes(&serde_json::to_vec(&deleted_warning).unwrap());
    assert!(validate_transcript_draft(&deleted_warning).is_err());
}

#[test]
fn vad_silence_is_not_a_substitute_for_a_missing_response() {
    let mut source = receipt(1);
    source.vad_no_speech_ordinals = vec![0];
    let pending = build_transcript_draft(&source, &[]).unwrap();
    assert!(!pending.can_adopt);
    assert_eq!(pending.pending_ranges.len(), 1);
    assert!(pending.warnings.is_empty());
    let complete = build_transcript_draft(&source, &[response(0, &[])]).unwrap();
    assert!(complete.can_adopt);
    assert!(complete.warnings.is_empty());
    source.vad_no_speech_ordinals = vec![1];
    assert!(build_transcript_draft(&source, &[]).is_err());
}

#[test]
fn partial_agreement_does_not_hide_other_conflicting_speech() {
    let draft = build_transcript_draft(&receipt(2), &contradictory()).unwrap();
    assert_eq!(draft.conflicts.len(), 1);
    assert!(!draft.can_adopt);
    assert!(draft.segments.iter().any(|s| s.status == "provisional"));
    assert_eq!(draft.conflicts[0].left_alternative.len(), 2);
    assert_eq!(draft.conflicts[0].right_alternative.len(), 2);
}
#[test]
fn noncontiguous_receipts_keep_pending_ranges_and_never_bridge_missing_audio() {
    let draft = build_transcript_draft(
        &receipt(3),
        &[
            response(2, &[(250000, 250500, "last")]),
            response(0, &[(500, 900, "first")]),
        ],
    )
    .unwrap();
    assert_eq!(
        draft.pending_ranges,
        vec![ReviewRange {
            start_ms: 120000,
            end_ms: 240000
        }]
    );
    assert_eq!(draft.segments.len(), 2);
    assert!(draft.conflicts.is_empty());
    assert!(!draft.can_adopt);
    assert!(validate_transcript_adoption(&draft, &draft.digest).is_err());
}
#[test]
fn overlapping_natural_repetition_inside_one_chunk_is_not_deduplicated() {
    let draft = build_transcript_draft(
        &receipt(1),
        &[response(0, &[(100, 500, "No"), (150, 550, "No")])],
    )
    .unwrap();
    assert_eq!(draft.segments.len(), 2);
    assert!(draft.can_adopt);
}
#[test]
fn resolutions_require_current_digest_and_keep_original_alternatives() {
    let initial = build_transcript_draft(&receipt(2), &contradictory()).unwrap();
    let conflict_id = initial.conflicts[0].id.clone();
    let chosen = resolve_transcript_boundary(
        &initial,
        &initial.digest,
        &conflict_id,
        BoundaryChoice::Left,
    )
    .unwrap();
    assert!(chosen.can_adopt);
    assert_ne!(chosen.digest, initial.digest);
    assert_eq!(chosen.chunks, initial.chunks);
    assert_eq!(
        chosen.conflicts[0].right_alternative,
        initial.conflicts[0].right_alternative
    );
    assert!(chosen.segments.iter().any(|s| s.text == "wrong"));
    assert!(!chosen.segments.iter().any(|s| s.text == "correct"));
    assert!(resolve_transcript_boundary(
        &chosen,
        &initial.digest,
        &conflict_id,
        BoundaryChoice::Right
    )
    .is_err());
    assert!(validate_transcript_adoption(&chosen, &initial.digest).is_err());
    let decoded: TranscriptDraft =
        serde_json::from_slice(&serde_json::to_vec(&chosen).unwrap()).unwrap();
    validate_transcript_draft(&decoded).unwrap();
    validate_transcript_adoption(&decoded, &chosen.digest).unwrap();
    let keep = resolve_transcript_boundary(
        &initial,
        &initial.digest,
        &conflict_id,
        BoundaryChoice::KeepBoth,
    )
    .unwrap();
    assert_eq!(keep.segments.len(), 4);
}
#[test]
fn manual_review_validates_time_and_text_without_discarding_raw_chunks() {
    let draft = build_transcript_draft(&receipt(2), &contradictory()).unwrap();
    let id = &draft.conflicts[0].id;
    for segment in [
        ReviewText {
            start_ms: 0,
            end_ms: 1,
            text: "outside".into(),
        },
        ReviewText {
            start_ms: 119000,
            end_ms: 119100,
            text: " ".into(),
        },
        ReviewText {
            start_ms: 120000,
            end_ms: 119000,
            text: "reversed".into(),
        },
    ] {
        assert!(resolve_transcript_boundary(
            &draft,
            &draft.digest,
            id,
            BoundaryChoice::Manual {
                segments: vec![segment]
            }
        )
        .is_err());
    }
    let resolved = resolve_transcript_boundary(
        &draft,
        &draft.digest,
        id,
        BoundaryChoice::Manual {
            segments: vec![ReviewText {
                start_ms: 119000,
                end_ms: 120800,
                text: "Yes. Correct.".into(),
            }],
        },
    )
    .unwrap();
    assert_eq!(resolved.chunks, draft.chunks);
    assert_eq!(resolved.segments.len(), 1);
    assert!(resolved.can_adopt);
}
#[test]
fn deterministic_digest_and_repair_duration_are_bound_to_current_draft() {
    let received = contradictory();
    let first = build_transcript_draft(&receipt(2), &received).unwrap();
    let reversed = vec![received[1].clone(), received[0].clone()];
    let same = build_transcript_draft(&receipt(2), &reversed).unwrap();
    assert_eq!(first.digest, same.digest);
    let repair = boundary_repair_range(&first, &first.digest, &first.conflicts[0].id).unwrap();
    assert_eq!(repair.end_ms - repair.start_ms, 30_000);
    assert!(boundary_repair_range(&first, "stale", &first.conflicts[0].id).is_err());
}
#[test]
fn six_hour_twenty_thousand_cue_draft_is_bounded_and_complete() {
    let receipt = receipt(180);
    let mut responses: Vec<_> = (0..180).map(|ordinal| response(ordinal, &[])).collect();
    for i in 0..20_000 {
        let start = i * 1080;
        let ordinal = (start / 120_000) as usize;
        let ParsedOutput::Transcript { cues } = &mut responses[ordinal].output else {
            unreachable!()
        };
        cues.push(GeneratedCue {
            start_ms: start,
            end_ms: start + 700,
            text: format!("word {i}"),
        });
    }
    let draft = build_transcript_draft(&receipt, &responses).unwrap();
    assert_eq!(draft.end_ms, 6 * 60 * 60 * 1000);
    assert_eq!(draft.segments.len(), 20_000);
    assert!(draft.pending_ranges.is_empty());
    validate_transcript_draft(&draft).unwrap();
}

#[test]
fn final_fractional_millisecond_uses_prepared_audio_outward_duration() {
    let mut receipt = receipt(1);
    receipt.chunks[0].sample_rate = 16_000;
    receipt.chunks[0].core_end_sample = 16_001;
    receipt.chunks[0].request_end_sample = 16_001;
    let RequestTask::TranscribePreview { audio, .. } = &mut receipt.prepared_job.requests[0] else {
        unreachable!()
    };
    audio.duration_ms = 1001;
    let draft = build_transcript_draft(&receipt, &[response(0, &[(1, 1001, "Hello")])]).unwrap();
    assert_eq!(draft.end_ms, 1001);
    assert!(draft.can_adopt);
    validate_transcript_adoption(&draft, &draft.digest).unwrap();
}

#[test]
fn overlapping_boundary_regions_are_reviewed_together_without_erasing_originals() {
    let received = vec![
        response(0, &[(119000, 120000, "A")]),
        response(1, &[(119000, 240001, "B")]),
        response(2, &[(239000, 241000, "C")]),
    ];
    let draft = build_transcript_draft(&receipt(3), &received).unwrap();
    assert_eq!(draft.conflicts.len(), 1);
    assert_eq!(draft.conflicts[0].start_ms, 119000);
    assert_eq!(draft.conflicts[0].end_ms, 241000);
    assert_eq!(draft.conflicts[0].left_ordinal, 0);
    assert_eq!(draft.conflicts[0].right_ordinal, 2);
    let resolved = resolve_transcript_boundary(
        &draft,
        &draft.digest,
        &draft.conflicts[0].id,
        BoundaryChoice::Manual {
            segments: vec![ReviewText {
                start_ms: 119000,
                end_ms: 241000,
                text: "Reviewed continuous sentence.".into(),
            }],
        },
    )
    .unwrap();
    assert_eq!(resolved.chunks, draft.chunks);
    validate_transcript_adoption(&resolved, &resolved.digest).unwrap();
}
