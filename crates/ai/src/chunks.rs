//! Chunk boundaries are transport boundaries, never claims about sentence endings.
//! VAD supplies pause candidates only; no detected "silence" is deleted from audio.
use crate::{AiError, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use unicode_normalization::UnicodeNormalization;

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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TimedText {
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChunkTranscript {
    pub chunk: AudioChunk,
    pub segments: Vec<TimedText>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BoundaryConflict {
    pub at_ms: u64,
    pub left_chunk: u32,
    pub right_chunk: u32,
    pub reason: String,
    pub left_alternative: Vec<TimedText>,
    pub right_alternative: Vec<TimedText>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StitchedTranscript {
    pub segments: Vec<TimedText>,
    pub boundary_conflicts: Vec<BoundaryConflict>,
    pub group_joins: Vec<BoundaryGroupJoin>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BoundaryGroupJoin {
    pub left_chunk: u32,
    pub right_chunk: u32,
    pub left_segment_indices: Vec<usize>,
    pub right_segment_indices: Vec<usize>,
    pub overlap_units: usize,
    pub joined: TimedText,
}

/// Preserve source time and natural repetition. Dedupe is allowed only for matching
/// text with substantially overlapping times in adjacent request contexts. Where
/// providers disagree, core-midpoint ownership is provisional and BOTH alternatives
/// are retained for review; no paid repair is requested by this function.
pub fn stitch_chunks(mut transcripts: Vec<ChunkTranscript>) -> Result<StitchedTranscript> {
    transcripts.sort_by_key(|c| c.chunk.core_start_sample);
    for (i, t) in transcripts.iter().enumerate() {
        let c = &t.chunk;
        if c.sample_rate == 0
            || c.core_start_sample >= c.core_end_sample
            || c.request_start_sample > c.core_start_sample
            || c.request_end_sample < c.core_end_sample
        {
            return Err(AiError::Invalid("Invalid transcript chunk timeline".into()));
        }
        if i > 0
            && (transcripts[i - 1].chunk.core_end_sample != c.core_start_sample
                || transcripts[i - 1].chunk.sample_rate != c.sample_rate)
        {
            return Err(AiError::Invalid(
                "Transcript core spans must be continuous".into(),
            ));
        }
        let mut previous = 0;
        for s in &t.segments {
            if s.start_ms >= s.end_ms
                || s.text.trim().is_empty()
                || s.start_ms < previous
                || s.start_ms < c.request_start_ms()
                || s.end_ms > c.request_start_ms() + c.request_duration_ms() + 1
            {
                return Err(AiError::Invalid(
                    "Transcript timestamps lie outside the prepared request".into(),
                ));
            }
            previous = s.start_ms;
        }
    }
    let mut conflicts = Vec::new();
    let mut context_fragments = HashSet::new();
    let mut group_joins = Vec::new();
    for (pair_index, pair) in transcripts.windows(2).enumerate() {
        let left = &pair[0];
        let right = &pair[1];
        let at = right.chunk.core_start_ms();
        let lo = right.chunk.request_start_ms();
        let hi = left.chunk.request_start_ms() + left.chunk.request_duration_ms();
        let left_indices: Vec<_> = left
            .segments
            .iter()
            .enumerate()
            .filter_map(|(index, s)| (s.end_ms > lo && s.start_ms < hi).then_some(index))
            .collect();
        let right_indices: Vec<_> = right
            .segments
            .iter()
            .enumerate()
            .filter_map(|(index, s)| (s.end_ms > lo && s.start_ms < hi).then_some(index))
            .collect();
        let l: Vec<_> = left_indices
            .iter()
            .map(|&index| left.segments[index].clone())
            .collect();
        let r: Vec<_> = right_indices
            .iter()
            .map(|&index| right.segments[index].clone())
            .collect();
        // One matching phrase cannot certify all speech in the overlap. Match
        // occurrences one-to-one so a repeated word or partial contradiction is
        // retained for review instead of hidden by an unrelated matching cue.
        let matches = match_boundary_cues(&l, &r, lo, hi);
        let mut all_match = matches.is_some();
        if let Some(matches) = matches {
            for (li, ri, kind) in matches {
                match kind {
                    ContextMatch::LeftFragment => {
                        context_fragments.insert((pair_index, left_indices[li]));
                    }
                    ContextMatch::RightFragment => {
                        context_fragments.insert((pair_index + 1, right_indices[ri]));
                    }
                    ContextMatch::Exact => {}
                }
            }
        }
        if !all_match {
            if let Some((joined, overlap_units)) = reconcile_edge_group(&l, &r, lo, hi) {
                // Do not let a derived group consume raw cues involved in a
                // different boundary. Those connected regions need review.
                let isolated = (pair_index == 0
                    || joined.start_ms
                        >= transcripts[pair_index - 1].chunk.request_start_ms()
                            + transcripts[pair_index - 1].chunk.request_duration_ms())
                    && (pair_index + 2 >= transcripts.len()
                        || joined.end_ms <= transcripts[pair_index + 2].chunk.request_start_ms());
                if isolated {
                    context_fragments.extend(left_indices.iter().map(|&index| (pair_index, index)));
                    context_fragments
                        .extend(right_indices.iter().map(|&index| (pair_index + 1, index)));
                    group_joins.push(BoundaryGroupJoin {
                        left_chunk: left.chunk.index,
                        right_chunk: right.chunk.index,
                        left_segment_indices: left_indices.clone(),
                        right_segment_indices: right_indices.clone(),
                        overlap_units,
                        joined,
                    });
                    all_match = true;
                }
            }
        }
        if (!l.is_empty() || !r.is_empty()) && !all_match {
            conflicts.push(BoundaryConflict{at_ms:at,left_chunk:left.chunk.index,right_chunk:right.chunk.index,reason:"Boundary transcriptions disagree. Review the retained alternatives; no automatic paid retry was made.".into(),left_alternative:l,right_alternative:r});
        }
    }
    let mut output: Vec<TimedText> = Vec::new();
    let mut last_chunk = None;
    for (i, t) in transcripts.iter().enumerate() {
        for (segment_index, segment) in t.segments.iter().enumerate() {
            if context_fragments.contains(&(i, segment_index)) {
                continue;
            }
            let midpoint = segment.start_ms + (segment.end_ms - segment.start_ms) / 2;
            if (midpoint < t.chunk.core_start_ms()
                || (midpoint >= t.chunk.core_end_ms() && i + 1 < transcripts.len()))
                && transcripts
                    .iter()
                    .find(|candidate| {
                        candidate.chunk.index != t.chunk.index
                            && midpoint >= candidate.chunk.core_start_ms()
                            && midpoint < candidate.chunk.core_end_ms()
                    })
                    .is_some_and(|owner| {
                        owner
                            .segments
                            .iter()
                            .any(|other| same_spoken_interval(segment, other))
                    })
            {
                // Context ownership can remove only an actually matched copy.
                // If its owner omitted or contradicted the speech, keep this
                // variant provisionally and let boundary review decide.
                continue;
            }
            if last_chunk != Some(t.chunk.index)
                && output
                    .last()
                    .is_some_and(|last| same_spoken_interval(last, segment))
            {
                continue;
            }
            output.push(segment.clone());
            last_chunk = Some(t.chunk.index);
        }
    }
    output.extend(group_joins.iter().map(|join| join.joined.clone()));
    output.sort_by_key(|s| s.start_ms);
    Ok(StitchedTranscript {
        segments: output,
        boundary_conflicts: conflicts,
        group_joins,
    })
}

struct GroupUnit {
    text: String,
    start_byte: usize,
    cue_index: usize,
}

fn edge_group_units(cues: &[TimedText]) -> Option<(String, Vec<GroupUnit>)> {
    let text = cues
        .iter()
        .map(|cue| cue.text.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    if text.len() > 16_384 {
        return None;
    }
    let mut units = Vec::new();
    let mut offset = 0;
    for (cue_index, cue) in cues.iter().enumerate() {
        if cue
            .text
            .chars()
            .any(|c| c.is_alphanumeric() && !c.is_ascii_alphanumeric())
        {
            return None;
        }
        for range in lexical_unit_ranges(&cue.text) {
            units.push(GroupUnit {
                text: cue.text[range.clone()].to_ascii_lowercase(),
                start_byte: offset + range.start,
                cue_index,
            });
        }
        offset += cue.text.len() + 1;
    }
    (units.len() <= 512).then_some((text, units))
}

// Reconcile only complementary, request-clipped groups. These are observed cue
// intervals, not word timestamps: each matched lexical unit must belong to
// intersecting source intervals. The sole derived timing is their observed outer
// span. Unspaced scripts and semantic spelling equivalences are not inferred.
fn reconcile_edge_group(
    left: &[TimedText],
    right: &[TimedText],
    lo: u64,
    hi: u64,
) -> Option<(TimedText, usize)> {
    if left.is_empty() || right.is_empty() || left.len() > 4 || right.len() > 4 || hi <= lo {
        return None;
    }
    let a0 = left.first()?;
    let az = left.last()?;
    let b0 = right.first()?;
    let bz = right.last()?;
    if a0.start_ms >= lo
        || bz.end_ms <= hi
        || az.end_ms.abs_diff(hi) > 400
        || b0.start_ms.abs_diff(lo) > 400
        || a0.start_ms >= b0.start_ms
        || az.end_ms >= bz.end_ms
        || bz.end_ms.checked_sub(a0.start_ms)? > 30_000
        || !(1000..=6000).contains(&(hi - lo))
        || left.windows(2).chain(right.windows(2)).any(|pair| {
            pair[1].start_ms < pair[0].end_ms || pair[1].start_ms - pair[0].end_ms > 2000
        })
    {
        return None;
    }
    let (a_text, a) = edge_group_units(left)?;
    let (b_text, b) = edge_group_units(right)?;
    let candidates: Vec<_> = (1..a.len().min(b.len()))
        .filter(|&n| {
            a[a.len() - n..]
                .iter()
                .zip(&b[..n])
                .all(|(x, y)| x.text == y.text)
        })
        .collect();
    if candidates.len() != 1 {
        return None;
    }
    let overlap = candidates[0];
    let overlap_words: Vec<_> = b[..overlap]
        .iter()
        .filter(|u| u.text.bytes().all(|c| c.is_ascii_alphanumeric()))
        .map(|u| &u.text)
        .collect();
    // Preserved symbols must not make a short word overlap pass the threshold.
    if overlap_words.len() < 8 || overlap_words.iter().collect::<HashSet<_>>().len() < 4 {
        return None;
    }
    if a[a.len() - overlap].cue_index != 0 || b[overlap - 1].cue_index + 1 != right.len() {
        return None;
    }
    let occurs = |units: &[GroupUnit]| {
        units
            .windows(overlap)
            .filter(|slice| {
                slice
                    .iter()
                    .zip(&b[..overlap])
                    .all(|(x, y)| x.text == y.text)
            })
            .count()
    };
    if occurs(&a) != 1 || occurs(&b) != 1 {
        return None;
    }
    for (x, y) in a[a.len() - overlap..].iter().zip(&b[..overlap]) {
        let l = &left[x.cue_index];
        let r = &right[y.cue_index];
        if l.end_ms.min(r.end_ms) <= l.start_ms.max(r.start_ms) {
            return None;
        }
    }
    let prefix = a_text[..a[a.len() - overlap].start_byte].trim_end();
    Some((
        TimedText {
            start_ms: a0.start_ms,
            end_ms: bz.end_ms,
            text: format!("{prefix} {b_text}"),
        },
        // The published count remains word units; matched punctuation and
        // symbols add evidence, not words toward the minimum overlap length.
        overlap_words.len(),
    ))
}

fn presentation_punctuation(c: char, previous: Option<char>, next: Option<char>) -> bool {
    match c {
        // Decimal, thousands and time separators carry information. Keeping
        // them also distinguishes a decimal from two space-separated numbers.
        '.' | ',' | ':' | '，' | '．' => {
            !(previous.is_some_and(char::is_numeric) && next.is_some_and(char::is_numeric))
        }
        '!' | '?' | ';' | '"' | '(' | ')' | '[' | ']' | '{' | '}' | '、' | '。' | '！' | '？' => {
            true
        }
        _ => false,
    }
}

fn unspaced_character(c: char) -> bool {
    // Han and kana are compared character by character so a transport fragment
    // can end within a phrase. Other scripts retain contiguous word boundaries.
    matches!(c as u32,
        0x3005 | 0x3007 | 0x303b
        | 0x3040..=0x30ff | 0x31f0..=0x31ff
        | 0x3400..=0x4dbf | 0x4e00..=0x9fff | 0xf900..=0xfaff
        | 0xff66..=0xff9f | 0x1b000..=0x1b16f
        | 0x20000..=0x2ffff | 0x30000..=0x323af
    )
}

// All matching paths share the same lexical boundaries. Whitespace may separate
// words but cannot fuse them; currency, percentages, signs and apostrophes remain
// units. Byte ranges let group joins preserve the exact original continuation.
fn lexical_unit_ranges(text: &str) -> Vec<std::ops::Range<usize>> {
    let mut ranges = Vec::new();
    let mut word_start = None;
    let mut previous = None;
    let mut chars = text.char_indices().peekable();
    while let Some((at, c)) = chars.next() {
        if (c.is_alphanumeric() || unicode_normalization::char::is_combining_mark(c))
            && !unspaced_character(c)
        {
            word_start.get_or_insert(at);
        } else {
            if let Some(start) = word_start.take() {
                ranges.push(start..at);
            }
            if !c.is_whitespace()
                && !presentation_punctuation(c, previous, chars.peek().map(|(_, c)| *c))
            {
                ranges.push(at..at + c.len_utf8());
            }
        }
        previous = Some(c);
    }
    if let Some(start) = word_start {
        ranges.push(start..text.len());
    }
    ranges
}

// Japanese characters remain separate units so an exact fragment can end within
// an unspaced phrase. No pronunciation or alternative spelling is inferred.
fn spoken_units(text: &str) -> Vec<String> {
    let normalized: String = text.nfc().flat_map(char::to_lowercase).collect();
    lexical_unit_ranges(&normalized)
        .into_iter()
        .map(|range| normalized[range].to_owned())
        .collect()
}

#[derive(Clone, Copy)]
enum ContextMatch {
    Exact,
    LeftFragment,
    RightFragment,
}

fn context_match(left: &TimedText, right: &TimedText, lo: u64, hi: u64) -> Option<ContextMatch> {
    if same_spoken_interval(left, right) {
        return Some(ContextMatch::Exact);
    }
    let a = spoken_units(&left.text);
    let b = spoken_units(&right.text);
    // Request edges can clip speech. Certify only a strict lexical subset with
    // the intact endpoint aligned and a full counterpart beyond the clip edge.
    // Neither a general substring nor core-midpoint ownership is sufficient.
    if !a.is_empty()
        && a.len() < b.len()
        && left.end_ms.abs_diff(hi) <= 400
        && right.end_ms > hi
        && left.start_ms.abs_diff(right.start_ms) <= 250
        && left.end_ms > right.start_ms
        && b.starts_with(&a)
    {
        return Some(ContextMatch::LeftFragment);
    }
    if !b.is_empty()
        && b.len() < a.len()
        && right.start_ms.abs_diff(lo) <= 400
        && left.start_ms < lo
        && left.end_ms.abs_diff(right.end_ms) <= 250
        && right.start_ms < left.end_ms
        && a.ends_with(&b)
    {
        return Some(ContextMatch::RightFragment);
    }
    None
}

fn match_boundary_cues(
    left: &[TimedText],
    right: &[TimedText],
    lo: u64,
    hi: u64,
) -> Option<Vec<(usize, usize, ContextMatch)>> {
    if left.len() != right.len() {
        return None;
    }
    let mut used = vec![false; right.len()];
    let mut matches = Vec::new();
    for (li, a) in left.iter().enumerate() {
        let candidates: Vec<_> = right
            .iter()
            .enumerate()
            .filter_map(|(ri, b)| {
                (!used[ri])
                    .then(|| context_match(a, b, lo, hi).map(|kind| (ri, kind)))
                    .flatten()
            })
            .collect();
        // An ambiguous repeated occurrence requires review even if a greedy
        // pairing could make the aggregate text look correct.
        if candidates.len() != 1 {
            return None;
        }
        let (ri, kind) = candidates[0];
        used[ri] = true;
        matches.push((li, ri, kind));
    }
    Some(matches)
}
fn same_spoken_interval(a: &TimedText, b: &TimedText) -> bool {
    let overlap = a
        .end_ms
        .min(b.end_ms)
        .saturating_sub(a.start_ms.max(b.start_ms));
    let union = a.end_ms.max(b.end_ms) - a.start_ms.min(b.start_ms);
    let normalized = spoken_units(&a.text);
    !normalized.is_empty()
        && normalized == spoken_units(&b.text)
        && (overlap as u128) * 10 >= (union as u128) * 6
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sm(ms: u64) -> u64 {
        ms * 16
    }
    fn pause(start_ms: u64, end_ms: u64) -> Pause {
        Pause {
            start_sample: sm(start_ms),
            end_sample: sm(end_ms),
        }
    }
    #[test]
    fn silence_near_target_wins_over_fixed_cut() {
        let p = plan_chunks(
            0,
            sm(400_000),
            &[pause(123_000, 124_000)],
            ChunkOptions::default(),
        )
        .unwrap();
        assert_eq!(p[0].core_end_sample, sm(123_500));
        assert_eq!(p[0].boundary, BoundaryKind::StrongPause);
    }
    #[test]
    fn long_silence_offers_target_boundaries_instead_of_distant_midpoint() {
        let duration = 6 * 3600 * 1000;
        let chunks = plan_chunks(
            0,
            sm(duration),
            &[pause(0, duration)],
            ChunkOptions::default(),
        )
        .unwrap();
        assert_eq!(chunks[0].core_end_sample, sm(120_000));
        assert_eq!(chunks[0].boundary, BoundaryKind::StrongPause);
        assert!(chunks[..chunks.len() - 1]
            .iter()
            .all(|c| c.boundary == BoundaryKind::StrongPause));
        assert_eq!(chunks.last().unwrap().core_end_sample, sm(duration));
    }
    #[test]
    fn extends_then_uses_weak_then_forces() {
        let a = plan_chunks(
            0,
            sm(400_000),
            &[pause(166_000, 167_000)],
            ChunkOptions::default(),
        )
        .unwrap();
        assert_eq!(a[0].core_end_sample, sm(166_500));
        let b = plan_chunks(
            0,
            sm(400_000),
            &[pause(125_000, 125_250)],
            ChunkOptions::default(),
        )
        .unwrap();
        assert_eq!(b[0].boundary, BoundaryKind::WeakPause);
        let c = plan_chunks(0, sm(400_000), &[], ChunkOptions::default()).unwrap();
        assert_eq!(c[0].core_end_sample, sm(180_000));
        assert_eq!(c[0].boundary, BoundaryKind::Forced);
    }
    #[test]
    fn six_hours_preserves_every_sample_and_accounts_for_overlap() {
        let start = sm(37_345);
        let end = start + sm(6 * 3600 * 1000);
        let chunks = plan_chunks(start, end, &[], ChunkOptions::default()).unwrap();
        assert_eq!(chunks.first().unwrap().core_start_sample, start);
        assert_eq!(chunks.last().unwrap().core_end_sample, end);
        for p in chunks.windows(2) {
            assert_eq!(p[0].core_end_sample, p[1].core_start_sample);
        }
        assert!(chunks.iter().all(|c| c.request_duration_ms() <= 186_000));
        assert_eq!(
            total_request_samples(&chunks).unwrap(),
            end - start + sm(6000) * (chunks.len() as u64 - 1)
        );
    }
    #[test]
    fn no_frame_padding_or_resets_shift_time() {
        let mut d = PauseDetector::new(16000).unwrap();
        for _ in 0..10 {
            d.push(0.9, 512).unwrap();
        }
        for _ in 0..10 {
            d.push(0.1, 512).unwrap();
        }
        d.push(0.9, 111).unwrap();
        assert_eq!(
            d.finish(),
            vec![Pause {
                start_sample: 5120,
                end_sample: 10240
            }]
        );
    }
    #[test]
    fn invalid_nan_posterior_does_not_create_fake_silence() {
        let mut d = PauseDetector::new(16000).unwrap();
        assert!(d.push(f32::NAN, 512).is_err());
    }
    #[test]
    fn short_selection_is_one_bounded_request() {
        let c = plan_chunks(sm(5000), sm(6000), &[], ChunkOptions::default()).unwrap();
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].request_start_sample, sm(5000));
        assert_eq!(c[0].request_end_sample, sm(6000));
    }
    fn transcript_pair() -> Vec<ChunkTranscript> {
        let chunks = plan_chunks(
            0,
            sm(300_000),
            &[pause(119_500, 120_500)],
            ChunkOptions::default(),
        )
        .unwrap();
        chunks
            .into_iter()
            .map(|chunk| ChunkTranscript {
                chunk,
                segments: vec![],
            })
            .collect()
    }
    #[test]
    fn natural_repeated_words_are_not_deleted() {
        let mut ts = transcript_pair();
        ts[0].segments = vec![
            TimedText {
                start_ms: 119_000,
                end_ms: 119_200,
                text: "no".into(),
            },
            TimedText {
                start_ms: 119_300,
                end_ms: 119_500,
                text: "no".into(),
            },
        ];
        ts[1].segments = vec![TimedText {
            start_ms: 120_100,
            end_ms: 120_300,
            text: "no".into(),
        }];
        let out = stitch_chunks(ts).unwrap();
        assert_eq!(out.segments.len(), 3);
    }
    #[test]
    fn duplicate_context_not_duplicate_sentence() {
        let mut ts = transcript_pair();
        let s = TimedText {
            start_ms: 119_000,
            end_ms: 121_000,
            text: "続けて説明します。".into(),
        };
        ts[0].segments = vec![s.clone()];
        ts[1].segments = vec![s];
        let out = stitch_chunks(ts).unwrap();
        assert_eq!(out.segments.len(), 1);
        assert!(out.boundary_conflicts.is_empty());
    }
    #[test]
    fn exact_overlap_preserves_word_boundaries_numbers_and_meaningful_symbols() {
        for (left, right) in [
            ("We are now here.", "We are nowhere."),
            ("Un café noir.", "Un cafénoir."),
            ("ré sumé", "résumé"),
            ("α β", "αβ"),
            ("시 험", "시험"),
            ("The value is 3.5.", "The value is 35."),
            ("The value is 3.5.", "The value is 3 5."),
            ("٣.٥", "٣ ٥"),
            ("３．５", "３ ５"),
            ("Pay $5.", "Pay 5."),
            ("It increased 20%.", "It increased 20."),
            ("The value is +2.", "The value is -2."),
            ("I can't leave.", "I cant leave."),
            ("They re-sign today.", "They resign today."),
        ] {
            let mut ts = transcript_pair();
            ts[0].segments = vec![cue(119_000, 121_000, left)];
            ts[1].segments = vec![cue(119_000, 121_000, right)];
            let expected: Vec<_> = ts.iter().flat_map(|t| t.segments.clone()).collect();
            let out = stitch_chunks(ts).unwrap();
            assert_eq!(out.boundary_conflicts.len(), 1, "{left} / {right}");
            assert_eq!(out.segments, expected);
            assert_eq!(out.boundary_conflicts[0].left_alternative, expected[..1]);
            assert_eq!(out.boundary_conflicts[0].right_alternative, expected[1..]);
        }
    }
    #[test]
    fn presentation_punctuation_and_spacing_still_match_without_losing_repetitions() {
        let mut ts = transcript_pair();
        ts[0].segments = vec![cue(119_000, 121_000, "No,  no! It is 3.5%.")];
        ts[1].segments = vec![cue(119_000, 121_000, "no no; it is 3.5%")];
        let out = stitch_chunks(ts).unwrap();
        assert!(out.boundary_conflicts.is_empty());
        assert_eq!(out.segments.len(), 1);
        assert_eq!(out.segments[0].text, "no no; it is 3.5%");
        assert!(same_spoken_interval(
            &cue(1, 10, "Un CAFÉ noir."),
            &cue(1, 10, "un cafe\u{301} noir")
        ));
    }
    fn cue(start_ms: u64, end_ms: u64, text: &str) -> TimedText {
        TimedText {
            start_ms,
            end_ms,
            text: text.into(),
        }
    }
    #[test]
    fn request_edge_fragments_keep_complete_counterparts_and_original_times() {
        let mut ts = transcript_pair();
        ts[0].segments = vec![
            cue(115_000, 118_020, "They waited for the train."),
            cue(119_000, 121_000, "No, no, no."),
            cue(122_000, 122_900, "After early"),
        ];
        ts[1].segments = vec![
            cue(117_100, 118_000, "the train."),
            cue(119_050, 121_050, "No, no, no."),
            cue(122_020, 126_000, "After early nightfall, we left."),
        ];
        let originals = ts.clone();
        let out = stitch_chunks(ts).unwrap();
        assert!(out.boundary_conflicts.is_empty());
        assert_eq!(out.segments.len(), 3);
        assert_eq!(out.segments[0], originals[0].segments[0]);
        assert_eq!(out.segments[2], originals[1].segments[2]);
        assert_eq!(out.segments[1].text, "No, no, no.");
    }
    #[test]
    fn fragment_matching_requires_transport_edge_lexical_boundary_and_intact_time() {
        for (fragment, full) in [
            (
                cue(120_000, 121_000, "we can"),
                cue(120_000, 126_000, "we can leave"),
            ),
            (
                cue(122_000, 122_900, "we can"),
                cue(122_000, 126_000, "we cannot leave"),
            ),
            (
                cue(120_000, 122_900, "we can"),
                cue(122_000, 126_000, "we can leave"),
            ),
            (
                cue(122_000, 122_900, "it increased 20%"),
                cue(122_000, 126_000, "it increased 20 yesterday"),
            ),
            (
                cue(122_000, 122_900, "the value is 3.5"),
                cue(122_000, 126_000, "the value is 3 5 today"),
            ),
        ] {
            let mut ts = transcript_pair();
            ts[0].segments = vec![fragment.clone()];
            ts[1].segments = vec![full.clone()];
            let out = stitch_chunks(ts).unwrap();
            assert_eq!(out.boundary_conflicts.len(), 1);
            assert_eq!(out.segments, vec![fragment, full]);
        }
    }
    #[test]
    fn matched_fragment_does_not_hide_a_separate_contradiction_or_lose_repeats() {
        let mut ts = transcript_pair();
        ts[0].segments = vec![
            cue(119_000, 120_000, "a cat"),
            cue(122_000, 122_900, "no no"),
        ];
        ts[1].segments = vec![
            cue(119_000, 120_000, "a cap"),
            cue(122_000, 126_000, "no no no"),
        ];
        let out = stitch_chunks(ts).unwrap();
        assert_eq!(out.boundary_conflicts.len(), 1);
        assert_eq!(out.segments.len(), 4);
        assert_eq!(out.boundary_conflicts[0].left_alternative[1].text, "no no");
        assert_eq!(
            out.boundary_conflicts[0].right_alternative[1].text,
            "no no no"
        );
    }
    #[test]
    fn japanese_punctuation_does_not_hide_particle_changes() {
        assert!(same_spoken_interval(
            &cue(1, 10, "大声で、泣いた。"),
            &cue(1, 10, "大声で泣いた。")
        ));
        let mut ts = transcript_pair();
        ts[0].segments = vec![cue(115_000, 118_000, "血圧は重要である。")];
        ts[1].segments = vec![cue(117_100, 118_000, "が重要である。")];
        assert_eq!(stitch_chunks(ts).unwrap().boundary_conflicts.len(), 1);
    }
    const SHARED: &str = "alpha beta gamma delta epsilon zeta eta theta";
    fn group_pair() -> Vec<ChunkTranscript> {
        let mut ts = transcript_pair();
        ts[0].segments = vec![cue(115_000, 122_800, &format!("Before we paused {SHARED}"))];
        ts[1].segments = vec![cue(
            117_100,
            126_000,
            &format!("{SHARED} after we continued."),
        )];
        ts
    }
    #[test]
    fn complementary_groups_preserve_observed_endpoints_and_join_provenance() {
        for split_left in [false, true] {
            let mut ts = group_pair();
            if split_left {
                ts[0].segments = vec![
                    cue(115_000, 119_000, "Before we paused alpha beta gamma"),
                    cue(119_300, 122_800, "delta epsilon zeta eta theta"),
                ];
            } else {
                ts[1].segments = vec![
                    cue(117_100, 120_000, "alpha beta gamma delta"),
                    cue(
                        120_300,
                        126_000,
                        "epsilon zeta eta theta after we continued.",
                    ),
                ];
            }
            let originals = ts.clone();
            let out = stitch_chunks(ts).unwrap();
            assert!(out.boundary_conflicts.is_empty());
            assert_eq!(
                out.segments,
                vec![cue(
                    115_000,
                    126_000,
                    &format!("Before we paused {SHARED} after we continued.")
                )]
            );
            assert_eq!(out.group_joins.len(), 1);
            let proof = &out.group_joins[0];
            assert_eq!(
                proof.left_segment_indices.len(),
                originals[0].segments.len()
            );
            assert_eq!(
                proof.right_segment_indices.len(),
                originals[1].segments.len()
            );
            assert_eq!(proof.overlap_units, 8);
            assert_eq!(proof.joined, out.segments[0]);
        }
    }
    #[test]
    fn group_join_retains_natural_repetitions_but_rejects_ambiguous_overlap() {
        let phrase = "the words the words of a story bring us hope";
        let mut ts = group_pair();
        ts[0].segments[0].text = format!("Before we paused {phrase}");
        ts[1].segments[0].text = format!("{phrase} after we continued.");
        let out = stitch_chunks(ts).unwrap();
        assert_eq!(out.group_joins.len(), 1);
        assert_eq!(out.segments[0].text.matches("the words").count(), 2);
        let mut repeated = group_pair();
        repeated[0].segments[0].text = format!("Before {SHARED} then {SHARED}");
        assert_eq!(stitch_chunks(repeated).unwrap().boundary_conflicts.len(), 1);
        let mut ambiguous = group_pair();
        ambiguous[0].segments[0].text =
            "Before alpha beta gamma delta alpha beta gamma delta".into();
        ambiguous[1].segments[0].text =
            "alpha beta gamma delta alpha beta gamma delta after".into();
        assert_eq!(
            stitch_chunks(ambiguous).unwrap().boundary_conflicts.len(),
            1
        );
    }
    #[test]
    fn group_join_rejects_short_nonedge_contradictory_and_inconsistent_evidence() {
        let mut cases = Vec::new();
        let mut short = group_pair();
        short[0].segments[0].text = "Before one two three".into();
        short[1].segments[0].text = "one two three after".into();
        cases.push(short);
        let mut edge = group_pair();
        edge[0].segments[0].end_ms = 121_000;
        cases.push(edge);
        let mut changed = group_pair();
        changed[1].segments[0].text = "alpha beta wrong delta epsilon zeta eta theta after".into();
        cases.push(changed);
        let mut extra = group_pair();
        extra[0]
            .segments
            .insert(0, cue(114_000, 117_200, "Unmatched claim."));
        cases.push(extra);
        let mut timing = group_pair();
        timing[1].segments = vec![
            cue(117_100, 123_900, "alpha beta gamma delta"),
            cue(124_000, 126_000, "epsilon zeta eta theta after"),
        ];
        cases.push(timing);
        for ts in cases {
            let count = ts.iter().map(|c| c.segments.len()).sum::<usize>();
            let out = stitch_chunks(ts).unwrap();
            assert_eq!(out.boundary_conflicts.len(), 1);
            assert!(out.group_joins.is_empty());
            assert_eq!(out.segments.len(), count);
        }
    }
    #[test]
    fn group_join_uses_the_same_number_and_symbol_evidence_as_exact_matching() {
        let shared = "alpha beta gamma delta epsilon zeta eta theta costs $3.5";
        let mut original = group_pair();
        original[0].segments[0].text = format!("Before {shared}");
        original[1].segments[0].text = format!("{shared} after we continued.");
        let matched = stitch_chunks(original.clone()).unwrap();
        assert!(matched.boundary_conflicts.is_empty());
        assert_eq!(matched.group_joins.len(), 1);
        assert_eq!(
            matched.segments[0],
            cue(
                115_000,
                126_000,
                &format!("Before {shared} after we continued.")
            )
        );
        for altered in ["costs 3.5", "costs $3 5", "costs $35"] {
            let mut changed = original.clone();
            changed[1].segments[0].text =
                changed[1].segments[0].text.replace("costs $3.5", altered);
            let expected: Vec<_> = changed.iter().flat_map(|t| t.segments.clone()).collect();
            let out = stitch_chunks(changed).unwrap();
            assert_eq!(out.boundary_conflicts.len(), 1);
            assert!(out.group_joins.is_empty());
            assert_eq!(out.segments, expected);
        }
        let mut short = group_pair();
        short[0].segments[0].text = "Before alpha beta + $3.5 % gamma".into();
        short[1].segments[0].text = "alpha beta + $3.5 % gamma after".into();
        let out = stitch_chunks(short).unwrap();
        assert_eq!(out.boundary_conflicts.len(), 1);
        assert!(out.group_joins.is_empty());
    }
    #[test]
    fn brief_unmatched_context_is_retained_without_inferring_silence() {
        let mut ts = transcript_pair();
        let omitted = cue(115_000, 117_060, "Keep the earlier sentence.");
        let common = cue(119_000, 121_000, "They agreed on this sentence.");
        ts[0].segments = vec![omitted.clone(), common.clone()];
        ts[1].segments = vec![common];
        let out = stitch_chunks(ts).unwrap();
        assert_eq!(out.boundary_conflicts.len(), 1);
        assert_eq!(out.boundary_conflicts[0].left_alternative[0], omitted);
        assert!(out.segments.contains(&omitted));
    }
    #[test]
    fn conflicts_retain_both_source_versions() {
        let mut ts = transcript_pair();
        ts[0].segments = vec![TimedText {
            start_ms: 119_000,
            end_ms: 120_000,
            text: "a cat".into(),
        }];
        ts[1].segments = vec![TimedText {
            start_ms: 119_000,
            end_ms: 120_000,
            text: "a cap".into(),
        }];
        let out = stitch_chunks(ts).unwrap();
        assert_eq!(out.boundary_conflicts.len(), 1);
        assert_eq!(out.boundary_conflicts[0].right_alternative[0].text, "a cap");
    }
    #[test]
    fn gaps_in_input_timeline_are_rejected() {
        let mut ts = transcript_pair();
        ts[1].chunk.core_start_sample += 100;
        assert!(stitch_chunks(ts).is_err());
    }
}
