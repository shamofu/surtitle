//! Reconcile transcript overlap without discarding spoken content.
use super::AudioChunk;
use crate::{AiError, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use unicode_normalization::UnicodeNormalization;

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
pub(super) fn same_spoken_interval(a: &TimedText, b: &TimedText) -> bool {
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
