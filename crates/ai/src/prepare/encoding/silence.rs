//! Measured upload limits with sustained non-speech boundaries. No audio is removed.
use super::*;
use crate::{AudioRequestLimits, BoundaryKind, ChunkBoundaryProvenance};

const MINIMUM_PAUSE_SAMPLES: u64 = crate::prepare::MINIMUM_PAUSE_MS * 16;
const GUARD_SAMPLES: u64 = crate::prepare::BOUNDARY_GUARD_MS * 16;

fn prefix(whole: &AudioChunk, cut: u64, pause: Option<Pause>) -> AudioChunk {
    ChunkBoundaryProvenance {
        sample_rate: whole.sample_rate,
        core_start_sample: whole.core_start_sample,
        boundary_sample: cut,
        request_start_sample: whole.core_start_sample,
        request_end_sample: cut,
        kind: if pause.is_some() {
            BoundaryKind::StrongPause
        } else {
            BoundaryKind::Forced
        },
        supporting_pause: pause,
    }
    .as_chunk(0)
}

fn estimated_end(whole: &AudioChunk, bytes: u64, limits: AudioRequestLimits) -> Result<u64> {
    let length = whole
        .core_end_sample
        .checked_sub(whole.core_start_sample)
        .filter(|length| *length >= 2)
        .ok_or_else(|| local_error("encoded audio cannot fit the upload limit"))?;
    if bytes <= limits.maximum_bytes && whole.request_duration_ms() <= limits.maximum_duration_ms {
        return Err(local_error(
            "splitting requires a measured oversized or overlong file",
        ));
    }
    let byte_span = if bytes > limits.maximum_bytes {
        (u128::from(length) * u128::from(limits.maximum_bytes) / u128::from(bytes)) as u64
    } else {
        length
    };
    let span = byte_span.min(limits.maximum_duration_ms * 16);
    Ok(whole.core_start_sample + span.clamp(1, length - 1))
}

fn pause_prefixes(
    whole: &AudioChunk,
    pauses: &[Pause],
    target: u64,
    maximum_end: u64,
) -> Vec<AudioChunk> {
    let mut candidates = pauses
        .iter()
        .filter_map(|pause| {
            let start = pause.start_sample.max(whole.core_start_sample);
            let end = pause.end_sample.min(whole.core_end_sample);
            if end.checked_sub(start)? < MINIMUM_PAUSE_SAMPLES {
                return None;
            }
            let low = start.checked_add(GUARD_SAMPLES)?;
            let high = end.checked_sub(GUARD_SAMPLES)?.min(maximum_end);
            if low > high {
                return None;
            }
            let middle = low + (high - low) / 2;
            let cut = if (low..=high).contains(&target) {
                target
            } else {
                middle
            };
            Some(prefix(whole, cut, Some(*pause)))
        })
        .collect::<Vec<_>>();
    candidates.sort_by_key(|candidate| candidate.core_end_sample);
    candidates.dedup_by_key(|candidate| candidate.core_end_sample);
    candidates
}

/// Estimates only choose probes. Every returned prefix has itself been encoded
/// and measured. Candidate backtracking halves its search range, never scanning
/// every VAD pause or assuming a constant FLAC bitrate.
#[cfg(test)]
fn fitting_prefix(
    whole: &AudioChunk,
    pauses: &[Pause],
    bytes: u64,
    measure: impl FnMut(&AudioChunk) -> Result<u64>,
) -> Result<AudioChunk> {
    fitting_prefix_with_limits(whole, pauses, bytes, openai_limits(), measure)
}

fn openai_limits() -> AudioRequestLimits {
    AudioRequestLimits {
        maximum_bytes: AudioAttachment::MAX_OPENAI_FILE_BYTES,
        maximum_duration_ms: AudioAttachment::MAX_OPENAI_DURATION_MS,
    }
}

fn fitting_prefix_with_limits(
    whole: &AudioChunk,
    pauses: &[Pause],
    bytes: u64,
    limits: AudioRequestLimits,
    mut measure: impl FnMut(&AudioChunk) -> Result<u64>,
) -> Result<AudioChunk> {
    let target = estimated_end(whole, bytes, limits)?;
    let maximum_end = whole.core_end_sample.min(
        whole
            .core_start_sample
            .saturating_add(limits.maximum_duration_ms * 16),
    );
    let candidates = pause_prefixes(whole, pauses, target, maximum_end);
    if !candidates.is_empty() {
        let mut index = candidates
            .partition_point(|candidate| candidate.core_end_sample <= target)
            .saturating_sub(1);
        loop {
            let candidate = &candidates[index];
            if measure(candidate)? <= limits.maximum_bytes {
                return Ok(candidate.clone());
            }
            // A long pause can straddle the capacity boundary. Rejecting only
            // its estimated/middle cut would miss an earlier fitting interior.
            let pause = candidate
                .boundary_provenance
                .as_ref()
                .unwrap()
                .supporting_pause
                .unwrap();
            let first = pause.start_sample.max(whole.core_start_sample) + GUARD_SAMPLES;
            if first < candidate.core_end_sample {
                let earlier = prefix(whole, first, Some(pause));
                if measure(&earlier)? <= limits.maximum_bytes {
                    return Ok(earlier);
                }
            }
            if index == 0 {
                break;
            }
            index /= 2;
        }
    }
    // No measured fitting sustained pause was found. Preserve the explicit
    // forced-boundary warning. Leave headroom for nonuniform compression and
    // halve after an oversized probe, so even pathological audio makes progress.
    let mut cut = if bytes > limits.maximum_bytes {
        whole.core_start_sample + (target - whole.core_start_sample) * 95 / 100
    } else {
        target
    };
    cut = cut.max(whole.core_start_sample + 1);
    loop {
        let candidate = prefix(whole, cut, None);
        if measure(&candidate)? <= limits.maximum_bytes {
            return Ok(candidate);
        }
        if cut == whole.core_start_sample + 1 {
            return Err(local_error("encoded audio cannot fit the upload limit"));
        }
        cut = whole.core_start_sample + ((cut - whole.core_start_sample) / 2).max(1);
    }
}

pub(in crate::prepare) fn encode_openai_file_silence(
    spool: &Path,
    directory: &Path,
    remaining: AudioChunk,
    pauses: &[Pause],
    tool: &ToolSnapshot,
    cancel: Arc<AtomicBool>,
    progress: impl FnMut(u32, u64),
) -> Result<(Vec<AudioChunk>, Vec<AudioAttachment>)> {
    encode_file_silence(
        spool,
        directory,
        remaining,
        pauses,
        openai_limits(),
        tool,
        cancel,
        progress,
    )
}

#[allow(clippy::too_many_arguments)]
pub(in crate::prepare) fn encode_file_silence(
    spool: &Path,
    directory: &Path,
    mut remaining: AudioChunk,
    pauses: &[Pause],
    limits: AudioRequestLimits,
    tool: &ToolSnapshot,
    cancel: Arc<AtomicBool>,
    mut progress: impl FnMut(u32, u64),
) -> Result<(Vec<AudioChunk>, Vec<AudioAttachment>)> {
    let selection_start = remaining.request_start_sample;
    let candidate_path = directory.join("candidate.flac");
    let mut measure = |chunk: &AudioChunk| -> Result<u64> {
        check_cancel(&cancel)?;
        if candidate_path.exists() {
            std::fs::remove_file(&candidate_path)?;
        }
        let pcm = copy_pcm_span(spool, directory, selection_start, chunk, &cancel)?;
        encode_flac(pcm, &candidate_path, tool, cancel.clone())?;
        Ok(candidate_path.metadata()?.len())
    };
    let mut chunks = Vec::new();
    let mut audio = Vec::new();
    loop {
        let bytes = measure(&remaining)?;
        let mut chunk = if bytes > limits.maximum_bytes
            || remaining.request_duration_ms() > limits.maximum_duration_ms
        {
            if chunks.len() + 2 > 5000 {
                return Err(local_error("selection exceeds 5000 byte-bounded requests"));
            }
            fitting_prefix_with_limits(&remaining, pauses, bytes, limits, &mut measure)?
        } else {
            remaining.clone()
        };
        chunk
            .boundary_provenance
            .as_ref()
            .ok_or_else(|| local_error("missing file boundary evidence"))?
            .validate()?;
        chunk.index = chunks.len() as u32;
        let output = directory.join(format!("chunk-{:05}.flac", chunk.index));
        if output.exists() {
            return Err(local_error("prepared audio destination already exists"));
        }
        check_cancel(&cancel)?;
        std::fs::rename(&candidate_path, &output)?;
        audio.push(AudioAttachment::from_file_with_limits(
            output,
            chunk.request_start_ms(),
            chunk.request_duration_ms(),
            limits,
        )?);
        let cut = chunk.core_end_sample;
        chunks.push(chunk);
        progress(chunks.len() as u32, chunks.last().unwrap().core_end_ms());
        if cut == remaining.core_end_sample {
            break;
        }
        remaining.core_start_sample = cut;
        remaining.request_start_sample = cut;
        if let Some(boundary) = &mut remaining.boundary_provenance {
            boundary.core_start_sample = cut;
            boundary.request_start_sample = cut;
        }
    }
    Ok((chunks, audio))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn vertex_duration_limit_prefers_a_guarded_pause_crossing_the_limit() {
        let whole = whole();
        let limits = crate::VertexAudioPolicy::TranscribeFileV1.limits();
        let crossing = pause(898, 4);
        let selected =
            fitting_prefix_with_limits(&whole, &[crossing], 100_000, limits, |_| Ok(90_000))
                .unwrap();
        assert_eq!(
            selected.core_end_sample,
            whole.core_start_sample + 900 * 16_000
        );
        assert_eq!(selected.boundary, BoundaryKind::StrongPause);
        assert_eq!(
            selected.boundary_provenance.unwrap().supporting_pause,
            Some(crossing)
        );
    }
    #[test]
    fn vertex_duration_limit_rejects_short_and_too_late_pauses_and_marks_forcing() {
        let whole = whole();
        let limits = crate::VertexAudioPolicy::TranscribeFileV1.limits();
        let selected = fitting_prefix_with_limits(
            &whole,
            &[pause(899, 1), pause(901, 3)],
            100_000,
            limits,
            |_| Ok(90_000),
        )
        .unwrap();
        assert_eq!(
            selected.core_end_sample,
            whole.core_start_sample + 900 * 16_000
        );
        assert_eq!(selected.boundary, BoundaryKind::Forced);
    }
    #[test]
    fn vertex_byte_limit_is_measured_even_when_duration_fits() {
        let whole = whole();
        let limits = crate::VertexAudioPolicy::AudioUnderstandingFileV1.limits();
        let selected = fitting_prefix_with_limits(
            &whole,
            &[pause(400, 4), pause(800, 4)],
            limits.maximum_bytes * 2,
            limits,
            |candidate| {
                Ok(
                    if candidate.core_end_sample <= whole.core_start_sample + 600 * 16_000 {
                        limits.maximum_bytes
                    } else {
                        limits.maximum_bytes + 1
                    },
                )
            },
        )
        .unwrap();
        assert_eq!(
            selected.core_end_sample,
            whole.core_start_sample + 402 * 16_000
        );
        assert_eq!(selected.boundary, BoundaryKind::StrongPause);
    }
    fn whole() -> AudioChunk {
        plan_chunks(
            123,
            123 + 1000 * 16_000 + 7,
            &[],
            ChunkOptions::for_profile(crate::AudioChunkProfile::OpenAiFileSilence),
        )
        .unwrap()
        .remove(0)
    }
    fn pause(start_seconds: u64, seconds: u64) -> Pause {
        Pause {
            start_sample: 123 + start_seconds * 16_000,
            end_sample: 123 + (start_seconds + seconds) * 16_000,
        }
    }
    #[test]
    fn silence_file_uses_late_long_pause_outside_the_old_middle_search() {
        let whole = whole();
        let pauses = [pause(100, 3), pause(450, 1), pause(800, 4), pause(950, 3)];
        let mut probes = Vec::new();
        let selected = fitting_prefix(&whole, &pauses, 30_000_000, |chunk| {
            probes.push(chunk.core_end_sample);
            Ok((chunk.core_end_sample - 123) * 30_000_000 / (whole.core_end_sample - 123))
        })
        .unwrap();
        assert_eq!(selected.core_end_sample, 123 + 802 * 16_000);
        assert_eq!(selected.boundary, BoundaryKind::StrongPause);
        assert_eq!(probes, vec![selected.core_end_sample]);
        assert_eq!(
            selected.boundary_provenance.unwrap().supporting_pause,
            Some(pauses[2])
        );
    }
    #[test]
    fn silence_file_measures_and_backtracks_for_uneven_compression() {
        let whole = whole();
        let pauses = [pause(100, 4), pause(400, 4), pause(800, 4)];
        let mut probes = Vec::new();
        let selected = fitting_prefix(&whole, &pauses, 30_000_000, |chunk| {
            probes.push(chunk.core_end_sample);
            Ok(if chunk.core_end_sample > 123 + 700 * 16_000 {
                26_000_000
            } else {
                25_000_000
            })
        })
        .unwrap();
        assert_eq!(
            probes,
            vec![
                123 + 802 * 16_000,
                123 + 800 * 16_000 + GUARD_SAMPLES,
                123 + 402 * 16_000
            ]
        );
        assert_eq!(selected.boundary, BoundaryKind::StrongPause);
        assert_eq!(selected.core_end_sample, probes[2]);
    }
    #[test]
    fn silence_file_keeps_an_early_adequate_pause_instead_of_forcing_the_middle() {
        let whole = whole();
        let early = pause(20, 2);
        let selected = fitting_prefix(&whole, &[early], 50_000_000, |_| Ok(900_000)).unwrap();
        assert_eq!(selected.core_start_sample, 123);
        assert_eq!(selected.core_end_sample, 123 + 21 * 16_000);
        assert_eq!(selected.request_start_sample, selected.core_start_sample);
        assert_eq!(selected.request_end_sample, selected.core_end_sample);
        assert_eq!(selected.boundary, BoundaryKind::StrongPause);
        selected.boundary_provenance.unwrap().validate().unwrap();
    }
    #[test]
    fn silence_file_ignores_short_pauses_and_marks_measured_fallback_for_review() {
        let whole = whole();
        let mut probes = Vec::new();
        let selected = fitting_prefix(
            &whole,
            &[pause(100, 1), pause(900, 3)],
            30_000_000,
            |chunk| {
                probes.push((chunk.core_end_sample, chunk.boundary));
                Ok(if chunk.boundary == BoundaryKind::StrongPause {
                    29_000_000
                } else {
                    24_000_000
                })
            },
        )
        .unwrap();
        assert_eq!(probes.len(), 3);
        assert_eq!(probes[0].1, BoundaryKind::StrongPause);
        assert_eq!(selected.boundary, BoundaryKind::Forced);
        assert!(selected
            .boundary_provenance
            .unwrap()
            .supporting_pause
            .is_none());
    }
    #[test]
    fn silence_file_long_pause_uses_a_guarded_cut_near_the_byte_estimate() {
        let whole = whole();
        let pauses = [pause(100, 850)];
        let selected = fitting_prefix(&whole, &pauses, 30_000_000, |_| Ok(24_900_000)).unwrap();
        let cut = selected.core_end_sample;
        assert_eq!(
            cut,
            estimated_end(&whole, 30_000_000, openai_limits()).unwrap()
        );
        assert!(cut >= pauses[0].start_sample + GUARD_SAMPLES);
        assert!(cut <= pauses[0].end_sample - GUARD_SAMPLES);
    }
    #[test]
    fn silence_file_long_pause_can_fit_before_its_oversized_estimated_cut() {
        let whole = whole();
        let pauses = [pause(100, 850)];
        let selected = fitting_prefix(&whole, &pauses, 30_000_000, |chunk| {
            Ok(if chunk.core_end_sample > 123 + 600 * 16_000 {
                28_000_000
            } else {
                20_000_000
            })
        })
        .unwrap();
        assert_eq!(selected.boundary, BoundaryKind::StrongPause);
        assert_eq!(
            selected.core_end_sample,
            pauses[0].start_sample + GUARD_SAMPLES
        );
    }
    #[test]
    fn silence_file_probe_count_is_bounded_and_cancellation_errors_propagate() {
        let whole = whole();
        let pauses = (0..50_000)
            .map(|i| Pause {
                start_sample: 123 + i * 64,
                end_sample: 123 + i * 64 + MINIMUM_PAUSE_SAMPLES,
            })
            .collect::<Vec<_>>();
        let mut probes = 0;
        let selected = fitting_prefix(&whole, &pauses, 30_000_000, |chunk| {
            probes += 1;
            Ok(if chunk.boundary == BoundaryKind::Forced {
                1
            } else {
                25_000_001
            })
        })
        .unwrap();
        assert_eq!(selected.boundary, BoundaryKind::Forced);
        assert!(probes <= 35);
        assert!(
            fitting_prefix(&whole, &[], 30_000_000, |_| Err(local_error("cancelled"))).is_err()
        );
    }
}
