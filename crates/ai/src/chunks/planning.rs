//! Transport chunk boundaries and streaming pause detection.
use crate::{AiError, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct Pause {
    pub start_sample: u64,
    pub end_sample: u64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct ChunkOptions {
    pub sample_rate: u32,
    pub minimum_ms: u64,
    pub target_ms: u64,
    pub search_end_ms: u64,
    pub hard_maximum_ms: u64,
    pub strong_pause_ms: u64,
    pub weak_pause_ms: u64,
    pub context_ms: u64,
    /// Byte-bounded profiles encode the full selection before choosing any cut.
    /// Legacy duration profiles omit this field to preserve their fingerprints.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub maximum_file_bytes: Option<u64>,
}

/// Preparation policies. Existing preparations retain their frozen plan.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum AudioChunkProfile {
    #[serde(rename = "legacy")]
    Legacy,
    #[serde(rename = "quality_30_seconds")]
    Quality30Seconds,
    #[serde(rename = "quality_15_seconds")]
    Quality15Seconds,
    #[serde(rename = "openai_file")]
    OpenAiFile,
    #[serde(rename = "openai_file_silence")]
    OpenAiFileSilence,
    #[serde(rename = "vertex_transcribe_file_silence")]
    VertexTranscribeFileSilence,
    #[serde(rename = "vertex_audio_file_silence")]
    VertexAudioFileSilence,
    #[serde(rename = "quality_240_seconds")]
    Quality240Seconds,
}

impl AudioChunkProfile {
    pub fn vertex_audio_policy(self) -> Option<crate::VertexAudioPolicy> {
        match self {
            Self::VertexTranscribeFileSilence => Some(crate::VertexAudioPolicy::TranscribeFileV1),
            Self::VertexAudioFileSilence => {
                Some(crate::VertexAudioPolicy::AudioUnderstandingFileV1)
            }
            _ => None,
        }
    }
}

impl ChunkOptions {
    pub fn for_profile(profile: AudioChunkProfile) -> Self {
        match profile {
            AudioChunkProfile::Legacy => Self::default(),
            AudioChunkProfile::Quality30Seconds => Self {
                minimum_ms: 15_000,
                target_ms: 25_000,
                search_end_ms: 30_000,
                hard_maximum_ms: 30_000,
                context_ms: 0,
                ..Self::default()
            },
            AudioChunkProfile::Quality15Seconds => Self {
                minimum_ms: 7500,
                target_ms: 12_000,
                search_end_ms: 15_000,
                hard_maximum_ms: 15_000,
                context_ms: 0,
                ..Self::default()
            },
            AudioChunkProfile::OpenAiFile => Self {
                maximum_file_bytes: Some(crate::AudioAttachment::MAX_OPENAI_FILE_BYTES),
                context_ms: 0,
                ..Self::default()
            },
            AudioChunkProfile::OpenAiFileSilence => Self {
                strong_pause_ms: crate::prepare::MINIMUM_PAUSE_MS,
                weak_pause_ms: crate::prepare::MINIMUM_PAUSE_MS,
                ..Self::for_profile(AudioChunkProfile::OpenAiFile)
            },
            AudioChunkProfile::VertexTranscribeFileSilence
            | AudioChunkProfile::VertexAudioFileSilence => {
                let limits = profile.vertex_audio_policy().unwrap().limits();
                Self {
                    maximum_file_bytes: Some(limits.maximum_bytes),
                    hard_maximum_ms: limits.maximum_duration_ms,
                    ..Self::for_profile(AudioChunkProfile::OpenAiFileSilence)
                }
            }
            AudioChunkProfile::Quality240Seconds => Self {
                minimum_ms: 120_000,
                target_ms: 210_000,
                search_end_ms: 240_000,
                hard_maximum_ms: 240_000,
                context_ms: 0,
                ..Self::default()
            },
        }
    }

    pub fn profile(&self) -> Option<AudioChunkProfile> {
        [
            AudioChunkProfile::Legacy,
            AudioChunkProfile::Quality30Seconds,
            AudioChunkProfile::Quality15Seconds,
            AudioChunkProfile::OpenAiFile,
            AudioChunkProfile::OpenAiFileSilence,
            AudioChunkProfile::VertexTranscribeFileSilence,
            AudioChunkProfile::VertexAudioFileSilence,
            AudioChunkProfile::Quality240Seconds,
        ]
        .into_iter()
        .find(|profile| self == &Self::for_profile(*profile))
    }
}

impl Default for ChunkOptions {
    fn default() -> Self {
        Self {
            sample_rate: 16_000,
            minimum_ms: 90_000,
            target_ms: 120_000,
            search_end_ms: 150_000,
            hard_maximum_ms: 180_000,
            strong_pause_ms: 500,
            weak_pause_ms: 200,
            context_ms: 3000,
            maximum_file_bytes: None,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BoundaryKind {
    StrongPause,
    WeakPause,
    Forced,
    EndOfSelection,
}

/// Frozen source samples and pause evidence, independent of rounded UI times.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ChunkBoundaryProvenance {
    pub sample_rate: u32,
    pub core_start_sample: u64,
    pub boundary_sample: u64,
    pub request_start_sample: u64,
    pub request_end_sample: u64,
    pub kind: BoundaryKind,
    pub supporting_pause: Option<Pause>,
}

impl ChunkBoundaryProvenance {
    pub(crate) fn as_chunk(&self, index: u32) -> AudioChunk {
        AudioChunk {
            index,
            sample_rate: self.sample_rate,
            core_start_sample: self.core_start_sample,
            core_end_sample: self.boundary_sample,
            request_start_sample: self.request_start_sample,
            request_end_sample: self.request_end_sample,
            boundary: self.kind,
            boundary_provenance: Some(self.clone()),
        }
    }

    pub(crate) fn validate(&self) -> Result<()> {
        if self.sample_rate != 16_000
            || self.core_start_sample >= self.boundary_sample
            || self.request_start_sample > self.core_start_sample
            || self.request_end_sample < self.boundary_sample
        {
            return Err(AiError::Invalid(
                "Invalid frozen chunk boundary timeline".into(),
            ));
        }
        match (self.kind, self.supporting_pause) {
            (BoundaryKind::StrongPause | BoundaryKind::WeakPause, Some(pause)) => {
                let minimum = if self.kind == BoundaryKind::StrongPause {
                    8000
                } else {
                    3200
                };
                if pause.end_sample.saturating_sub(pause.start_sample) < minimum
                    || self.boundary_sample.saturating_sub(pause.start_sample) < 1600
                    || pause.end_sample.saturating_sub(self.boundary_sample) < 1600
                {
                    return Err(AiError::Invalid(
                        "Frozen pause does not support the guarded cut".into(),
                    ));
                }
            }
            (BoundaryKind::Forced | BoundaryKind::EndOfSelection, None) => {}
            _ => {
                return Err(AiError::Invalid(
                    "Frozen boundary kind differs from pause evidence".into(),
                ));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AudioChunk {
    pub index: u32,
    pub sample_rate: u32,
    pub core_start_sample: u64,
    pub core_end_sample: u64,
    pub request_start_sample: u64,
    pub request_end_sample: u64,
    pub boundary: BoundaryKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub boundary_provenance: Option<ChunkBoundaryProvenance>,
}

impl AudioChunk {
    pub fn request_start_ms(&self) -> u64 {
        self.request_start_sample.saturating_mul(1000) / self.sample_rate as u64
    }
    pub fn request_duration_ms(&self) -> u64 {
        (self.request_end_sample - self.request_start_sample)
            .saturating_mul(1000)
            .div_ceil(self.sample_rate as u64)
    }
    pub fn core_start_ms(&self) -> u64 {
        self.core_start_sample.saturating_mul(1000) / self.sample_rate as u64
    }
    pub fn core_end_ms(&self) -> u64 {
        self.core_end_sample.saturating_mul(1000) / self.sample_rate as u64
    }
}

pub fn plan_chunks(
    start_sample: u64,
    end_sample: u64,
    pauses: &[Pause],
    options: ChunkOptions,
) -> Result<Vec<AudioChunk>> {
    let o = options;
    let profile = o.profile();
    if matches!(
        profile,
        Some(
            AudioChunkProfile::OpenAiFile
                | AudioChunkProfile::OpenAiFileSilence
                | AudioChunkProfile::VertexTranscribeFileSilence
                | AudioChunkProfile::VertexAudioFileSilence
        )
    ) {
        if start_sample >= end_sample {
            return Err(AiError::Invalid("Invalid whole-file selection".into()));
        }
        return Ok(vec![file_chunk(
            start_sample,
            end_sample,
            BoundaryKind::EndOfSelection,
            None,
        )]);
    }
    if o.sample_rate == 0
        || o.maximum_file_bytes.is_some()
        || start_sample >= end_sample
        || o.minimum_ms == 0
        || o.minimum_ms > o.target_ms
        || o.target_ms > o.search_end_ms
        || o.search_end_ms > o.hard_maximum_ms
        || (o.hard_maximum_ms > 180_000 && profile != Some(AudioChunkProfile::Quality240Seconds))
        || o.context_ms > 3000
        || o.weak_pause_ms == 0
        || o.weak_pause_ms > o.strong_pause_ms
    {
        return Err(AiError::Invalid(
            "Invalid bounded chunk options or selection".into(),
        ));
    }
    let samples = |ms: u64| -> Result<u64> {
        ms.checked_mul(o.sample_rate as u64)
            .map(|v| v / 1000)
            .ok_or_else(|| AiError::Invalid("Sample count overflow".into()))
    };
    let minimum = samples(o.minimum_ms)?;
    let target = samples(o.target_ms)?;
    let search = samples(o.search_end_ms)?;
    let maximum = samples(o.hard_maximum_ms)?;
    let strong = samples(o.strong_pause_ms)?;
    let weak = samples(o.weak_pause_ms)?;
    let context = samples(o.context_ms)?;
    let quality_profile = matches!(
        profile,
        Some(
            AudioChunkProfile::Quality30Seconds
                | AudioChunkProfile::Quality15Seconds
                | AudioChunkProfile::Quality240Seconds
        )
    );
    let guard = samples(100)?;
    if minimum == 0 || maximum == 0 {
        return Err(AiError::Invalid("Sample rate is too small".into()));
    }
    let mut pauses = pauses.to_vec();
    pauses.sort_by_key(|p| p.start_sample);
    if pauses.iter().any(|p| p.start_sample >= p.end_sample) {
        return Err(AiError::Invalid("Invalid pause coordinates".into()));
    }
    let mut merged: Vec<Pause> = Vec::new();
    for p in pauses {
        if let Some(last) = merged.last_mut().filter(|v| p.start_sample <= v.end_sample) {
            last.end_sample = last.end_sample.max(p.end_sample);
        } else {
            merged.push(p);
        }
    }
    let mut chunks = Vec::new();
    let mut start = start_sample;
    while start < end_sample {
        let remaining = end_sample - start;
        let (end, boundary, supporting_pause) = if remaining <= maximum {
            (end_sample, BoundaryKind::EndOfSelection, None)
        } else {
            let low = start + minimum;
            let preferred = start + target;
            let high = start + search;
            let hard = start + maximum;
            let candidates: Vec<_> = merged
                .iter()
                .filter_map(|p| {
                    let duration = p.end_sample - p.start_sample;
                    let overlap_low = if quality_profile {
                        p.start_sample.saturating_add(guard)
                    } else {
                        p.start_sample
                    }
                    .max(low);
                    let overlap_high = p
                        .end_sample
                        .saturating_sub(if quality_profile { guard } else { 1 })
                        .min(hard);
                    if overlap_low > overlap_high {
                        return None;
                    }
                    // A long pause offers many safe cut points. Its single midpoint
                    // may be hours away; select near the transport target instead.
                    // Center short pauses and retain up to a strong-pause margin on
                    // both sides when the legal transport window allows it.
                    let margin = (duration / 2).min(strong);
                    let padded_low = (p.start_sample + margin).max(overlap_low);
                    let padded_high = p.end_sample.saturating_sub(margin).min(overlap_high);
                    let point = if padded_low <= padded_high {
                        preferred.clamp(padded_low, padded_high)
                    } else {
                        preferred.clamp(overlap_low, overlap_high)
                    };
                    Some((point, duration, *p))
                })
                .collect();
            let normal = candidates
                .iter()
                .filter(|(mid, duration, _)| *mid <= high && *duration >= strong)
                .min_by_key(|(mid, duration, _)| {
                    (mid.abs_diff(preferred), std::cmp::Reverse(*duration), *mid)
                });
            if let Some((mid, _, pause)) = normal {
                (*mid, BoundaryKind::StrongPause, Some(*pause))
            } else if let Some((mid, _, pause)) = candidates
                .iter()
                .filter(|(mid, duration, _)| *mid > high && *duration >= strong)
                .min_by_key(|(mid, _, _)| *mid)
            {
                (*mid, BoundaryKind::StrongPause, Some(*pause))
            } else if let Some((mid, _, pause)) = candidates
                .iter()
                .filter(|(_, duration, _)| *duration >= weak)
                .min_by_key(|(mid, duration, _)| {
                    (std::cmp::Reverse(*duration), mid.abs_diff(preferred), *mid)
                })
            {
                (*mid, BoundaryKind::WeakPause, Some(*pause))
            } else {
                (hard, BoundaryKind::Forced, None)
            }
        };
        chunks.push(AudioChunk {
            index: u32::try_from(chunks.len())
                .map_err(|_| AiError::Invalid("Too many chunks".into()))?,
            sample_rate: o.sample_rate,
            core_start_sample: start,
            core_end_sample: end,
            request_start_sample: start.saturating_sub(context).max(start_sample),
            request_end_sample: end.saturating_add(context).min(end_sample),
            boundary,
            boundary_provenance: quality_profile.then_some(ChunkBoundaryProvenance {
                sample_rate: o.sample_rate,
                core_start_sample: start,
                boundary_sample: end,
                request_start_sample: start,
                request_end_sample: end,
                kind: boundary,
                supporting_pause,
            }),
        });
        start = end;
    }
    Ok(chunks)
}

fn file_chunk(start: u64, end: u64, kind: BoundaryKind, pause: Option<Pause>) -> AudioChunk {
    ChunkBoundaryProvenance {
        sample_rate: 16_000,
        core_start_sample: start,
        boundary_sample: end,
        request_start_sample: start,
        request_end_sample: end,
        kind,
        supporting_pause: pause,
    }
    .as_chunk(0)
}

/// Split only an encoded file already known to exceed its byte cap. Keep each
/// child at most three quarters of the samples so repeated encodes make progress.
pub(crate) fn split_file_chunk(
    chunk: &AudioChunk,
    pauses: &[Pause],
) -> Result<(AudioChunk, AudioChunk)> {
    let start = chunk.core_start_sample;
    let end = chunk.core_end_sample;
    let length = end
        .checked_sub(start)
        .filter(|length| *length >= 2)
        .ok_or_else(|| AiError::Invalid("Encoded audio cannot fit the upload limit".into()))?;
    let low = start + (length / 4).max(1);
    let high = end - (length / 4).max(1);
    let middle = start + length / 2;
    let candidate = pauses
        .iter()
        .filter_map(|pause| {
            let duration = pause.end_sample.checked_sub(pause.start_sample)?;
            if duration < 3200 {
                return None;
            }
            let guarded_low = pause.start_sample.checked_add(1600)?.max(low);
            let guarded_high = pause.end_sample.checked_sub(1600)?.min(high);
            if guarded_low > guarded_high {
                return None;
            }
            let cut = middle.clamp(guarded_low, guarded_high);
            Some((cut, duration, *pause))
        })
        .min_by_key(|(cut, duration, _)| {
            (
                *duration < 8000,
                cut.abs_diff(middle),
                std::cmp::Reverse(*duration),
                *cut,
            )
        });
    let (cut, kind, pause) = match candidate {
        Some((cut, duration, pause)) => (
            cut,
            if duration >= 8000 {
                BoundaryKind::StrongPause
            } else {
                BoundaryKind::WeakPause
            },
            Some(pause),
        ),
        None => (middle, BoundaryKind::Forced, None),
    };
    let left = file_chunk(start, cut, kind, pause);
    let right = file_chunk(
        cut,
        end,
        chunk.boundary,
        chunk
            .boundary_provenance
            .as_ref()
            .and_then(|p| p.supporting_pause),
    );
    left.boundary_provenance.as_ref().unwrap().validate()?;
    right.boundary_provenance.as_ref().unwrap().validate()?;
    Ok((left, right))
}

/// Exact total samples sent, including overlapping context. This is the duration
/// approved in the paid job, not just the non-overlapping source duration.
pub fn total_request_samples(chunks: &[AudioChunk]) -> Result<u64> {
    chunks.iter().try_fold(0_u64, |sum, c| {
        sum.checked_add(
            c.request_end_sample
                .checked_sub(c.request_start_sample)
                .ok_or_else(|| AiError::Invalid("Invalid chunk".into()))?,
        )
        .ok_or_else(|| AiError::Invalid("Duration overflow".into()))
    })
}

/// Streaming Silero posterior -> pause detector. Keep the ONNX hidden state in
/// the inference layer; feed each original frame exactly once. Padding on the final
/// inference frame must not be included in valid_samples.
#[derive(Debug, Clone)]
pub struct PauseDetector {
    sample_rate: u32,
    position: u64,
    start: Option<u64>,
    pauses: Vec<Pause>,
}

impl PauseDetector {
    pub fn new(sample_rate: u32) -> Result<Self> {
        if ![8000, 16000].contains(&sample_rate) {
            return Err(AiError::Invalid("VAD requires 8 or 16 kHz audio".into()));
        }
        Ok(Self {
            sample_rate,
            position: 0,
            start: None,
            pauses: Vec::new(),
        })
    }
    pub fn push(&mut self, speech_probability: f32, valid_samples: usize) -> Result<()> {
        if !speech_probability.is_finite()
            || !(0.0..=1.0).contains(&speech_probability)
            || valid_samples == 0
            || valid_samples > self.sample_rate as usize / 31
        {
            return Err(AiError::Invalid("Invalid VAD frame".into()));
        }
        if speech_probability < 0.35 {
            self.start.get_or_insert(self.position);
        } else if speech_probability >= 0.5 {
            self.end_pause();
        }
        self.position = self
            .position
            .checked_add(valid_samples as u64)
            .ok_or_else(|| AiError::Invalid("Audio duration overflow".into()))?;
        Ok(())
    }
    fn end_pause(&mut self) {
        if let Some(start) = self.start.take() {
            if self.position - start >= self.sample_rate as u64 / 5 {
                self.pauses.push(Pause {
                    start_sample: start,
                    end_sample: self.position,
                });
            }
        }
    }
    pub fn finish(mut self) -> Vec<Pause> {
        self.end_pause();
        self.pauses
    }
}
