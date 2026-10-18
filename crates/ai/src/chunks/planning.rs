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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AudioChunk {
    pub index: u32,
    pub sample_rate: u32,
    pub core_start_sample: u64,
    pub core_end_sample: u64,
    pub request_start_sample: u64,
    pub request_end_sample: u64,
    pub boundary: BoundaryKind,
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
    if o.sample_rate == 0
        || start_sample >= end_sample
        || o.minimum_ms == 0
        || o.minimum_ms > o.target_ms
        || o.target_ms > o.search_end_ms
        || o.search_end_ms > o.hard_maximum_ms
        || o.hard_maximum_ms > 180_000
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
        let (end, boundary) = if remaining <= maximum {
            (end_sample, BoundaryKind::EndOfSelection)
        } else {
            let low = start + minimum;
            let preferred = start + target;
            let high = start + search;
            let hard = start + maximum;
            let candidates: Vec<_> = merged
                .iter()
                .filter_map(|p| {
                    let duration = p.end_sample - p.start_sample;
                    let overlap_low = p.start_sample.max(low);
                    let overlap_high = p.end_sample.saturating_sub(1).min(hard);
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
                    Some((point, duration))
                })
                .collect();
            let normal = candidates
                .iter()
                .filter(|(mid, duration)| *mid <= high && *duration >= strong)
                .min_by_key(|(mid, duration)| {
                    (mid.abs_diff(preferred), std::cmp::Reverse(*duration), *mid)
                });
            if let Some((mid, _)) = normal {
                (*mid, BoundaryKind::StrongPause)
            } else if let Some((mid, _)) = candidates
                .iter()
                .filter(|(mid, duration)| *mid > high && *duration >= strong)
                .min_by_key(|(mid, _)| *mid)
            {
                (*mid, BoundaryKind::StrongPause)
            } else if let Some((mid, _)) = candidates
                .iter()
                .filter(|(_, duration)| *duration >= weak)
                .min_by_key(|(mid, duration)| {
                    (std::cmp::Reverse(*duration), mid.abs_diff(preferred), *mid)
                })
            {
                (*mid, BoundaryKind::WeakPause)
            } else {
                (hard, BoundaryKind::Forced)
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
        });
        start = end;
    }
    Ok(chunks)
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
