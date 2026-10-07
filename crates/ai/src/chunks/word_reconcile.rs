//! Word-aware overlap selection. Only the shared transport context is selected;
//! every original response remains available through the review chunks.
use super::{BoundaryConflict, ChunkTranscript, StitchedTranscript, TimedText};
use crate::Result;

#[derive(Clone)]
struct Piece {
    chunk: usize,
    cue: usize,
    first: usize,
    last: usize,
    value: TimedText,
    keep: bool,
    group: Option<usize>,
}

fn fragment(cue: &TimedText, first: usize, last: usize) -> TimedText {
    if cue.word_anchors.is_empty() {
        return cue.clone();
    }
    let words = &cue.word_anchors;
    let lo = if first == 0 {
        0
    } else {
        words[first].text_start
    };
    let hi = words
        .get(last + 1)
        .map_or(cue.text.len(), |word| word.text_start);
    let raw = &cue.text[lo..hi];
    let offset = lo + raw.len() - raw.trim_start().len();
    TimedText {
        start_ms: words[first].start_ms,
        end_ms: words[first..=last]
            .iter()
            .map(|word| word.end_ms)
            .max()
            .unwrap(),
        text: raw.trim().to_owned(),
        timing_precision: "cue".into(),
        word_anchors: words[first..=last]
            .iter()
            .map(|word| crate::WordAnchor {
                text_start: word.text_start - offset,
                text_end: word.text_end - offset,
                ..word.clone()
            })
            .collect(),
    }
}

fn values(indices: &[usize], pieces: &[Piece], transcripts: &[ChunkTranscript]) -> Vec<TimedText> {
    let mut out = Vec::new();
    let mut cursor = 0;
    while cursor < indices.len() {
        let first = &pieces[indices[cursor]];
        let mut last = first;
        cursor += 1;
        while cursor < indices.len() {
            let next = &pieces[indices[cursor]];
            if next.chunk != first.chunk
                || next.cue != first.cue
                || next.group != first.group
                || next.first != last.last + 1
                || first.value.word_anchors.is_empty()
            {
                break;
            }
            last = next;
            cursor += 1;
        }
        out.push(fragment(
            &transcripts[first.chunk].segments[first.cue],
            first.first,
            last.last,
        ));
    }
    out
}

pub(super) fn ranking(chunk: &ChunkTranscript, at: u64) -> (bool, u64, std::cmp::Reverse<u32>) {
    let c = &chunk.chunk;
    let owns = c.core_start_ms() <= at && at < c.core_end_ms();
    let margin = at
        .saturating_sub(c.request_start_ms())
        .min((c.request_start_ms() + c.request_duration_ms()).saturating_sub(at));
    (owns, margin, std::cmp::Reverse(c.index))
}

pub(super) fn stitch(transcripts: &[ChunkTranscript]) -> Result<StitchedTranscript> {
    let mut pieces = Vec::new();
    for (chunk, transcript) in transcripts.iter().enumerate() {
        for (cue_index, cue) in transcript.segments.iter().enumerate() {
            if cue.word_anchors.is_empty() {
                pieces.push(Piece {
                    chunk,
                    cue: cue_index,
                    first: 0,
                    last: 0,
                    value: cue.clone(),
                    keep: true,
                    group: None,
                });
                continue;
            }
            let mut first = 0;
            let mut group_end = 0;
            let start_count = pieces.len();
            for last in 0..cue.word_anchors.len() {
                group_end = group_end.max(cue.word_anchors[last].end_ms);
                if cue.word_anchors[first].start_ms == group_end {
                    continue;
                }
                let value = fragment(cue, first, last);
                pieces.push(Piece {
                    chunk,
                    cue: cue_index,
                    first,
                    last,
                    value,
                    keep: true,
                    group: None,
                });
                first = last + 1;
                group_end = 0;
            }
            if first < cue.word_anchors.len() && pieces.len() > start_count {
                let last = pieces.last_mut().unwrap();
                last.last = cue.word_anchors.len() - 1;
                last.value = fragment(cue, last.first, last.last);
            }
        }
    }
    let mut conflicts = Vec::new();
    for pair in 0..transcripts.len().saturating_sub(1) {
        let left = &transcripts[pair];
        let right = &transcripts[pair + 1];
        let lo = right.chunk.request_start_ms();
        let hi = left.chunk.request_start_ms() + left.chunk.request_duration_ms();
        let indices = |side| {
            pieces
                .iter()
                .enumerate()
                .filter_map(|(index, piece)| {
                    let middle =
                        piece.value.start_ms + (piece.value.end_ms - piece.value.start_ms) / 2;
                    (piece.chunk == side
                        && piece.keep
                        && piece.value.timing_precision != "source_block"
                        && middle >= lo
                        && middle < hi)
                        .then_some(index)
                })
                .collect::<Vec<_>>()
        };
        let l = indices(pair);
        let r = indices(pair + 1);
        let mut matched = std::collections::HashSet::new();
        // A unique match in both directions protects repeated occurrences.
        for &li in l
            .iter()
            .filter(|_| l.len().saturating_mul(r.len()) <= 1_000_000)
        {
            let candidates = r
                .iter()
                .copied()
                .filter(|&ri| {
                    super::reconcile::same_spoken_interval(&pieces[li].value, &pieces[ri].value)
                })
                .collect::<Vec<_>>();
            if candidates.len() != 1 {
                continue;
            }
            let ri = candidates[0];
            if l.iter()
                .filter(|&&other| {
                    super::reconcile::same_spoken_interval(&pieces[other].value, &pieces[ri].value)
                })
                .count()
                != 1
            {
                continue;
            }
            let start = pieces[li].value.start_ms.min(pieces[ri].value.start_ms);
            let end = pieces[li].value.end_ms.max(pieces[ri].value.end_ms);
            let at = start + (end - start) / 2;
            let discard = if ranking(left, at) >= ranking(right, at) {
                ri
            } else {
                li
            };
            pieces[discard].keep = false;
            matched.extend([li, ri]);
        }
        let mut remaining = l
            .into_iter()
            .chain(r)
            .filter(|index| !matched.contains(index))
            .collect::<Vec<_>>();
        remaining.sort_by_key(|&index| {
            (
                pieces[index].value.start_ms,
                pieces[index].chunk,
                pieces[index].first,
            )
        });
        let mut cursor = 0;
        while cursor < remaining.len() {
            let start = cursor;
            let begin = pieces[remaining[cursor]].value.start_ms;
            let mut end = pieces[remaining[cursor]].value.end_ms;
            cursor += 1;
            while cursor < remaining.len() && pieces[remaining[cursor]].value.start_ms < end {
                end = end.max(pieces[remaining[cursor]].value.end_ms);
                cursor += 1;
            }
            let mut a = remaining[start..cursor]
                .iter()
                .copied()
                .filter(|&i| pieces[i].chunk == pair)
                .collect::<Vec<_>>();
            let mut b = remaining[start..cursor]
                .iter()
                .copied()
                .filter(|&i| pieces[i].chunk == pair + 1)
                .collect::<Vec<_>>();
            if a.is_empty() || b.is_empty() {
                continue;
            }
            // Coarse legacy cues crossing a context edge cannot be safely cut.
            if a.iter().chain(&b).any(|&i| {
                pieces[i].value.word_anchors.is_empty()
                    && (pieces[i].value.start_ms < lo || pieces[i].value.end_ms > hi)
            }) {
                continue;
            }
            a.sort_unstable();
            b.sort_unstable();
            let group = conflicts.len();
            for &i in a.iter().chain(&b) {
                pieces[i].group = Some(group);
            }
            let at = begin + (end - begin) / 2;
            let choose_left = ranking(left, at) >= ranking(right, at);
            for &i in if choose_left { &b } else { &a } {
                pieces[i].keep = false;
            }
            conflicts.push(BoundaryConflict {
                at_ms: right.chunk.core_start_ms(),
                left_chunk: left.chunk.index,
                right_chunk: right.chunk.index,
                reason: "Selected by core ownership, then context margin and source order; originals are retained.".into(),
                left_alternative: values(&a, &pieces, transcripts),
                right_alternative: values(&b, &pieces, transcripts),
            });
        }
    }
    let kept = pieces
        .iter()
        .enumerate()
        .filter_map(|(i, piece)| piece.keep.then_some(i))
        .collect::<Vec<_>>();
    let mut segments = values(&kept, &pieces, transcripts);
    segments.sort_by_key(|cue| cue.start_ms);
    Ok(StitchedTranscript {
        segments,
        boundary_conflicts: conflicts,
        group_joins: vec![],
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AudioChunk, BoundaryKind, WordAnchor};

    fn cue(text: &str, words: &[(&str, u64, u64)]) -> TimedText {
        let mut cursor = 0;
        let anchors = words
            .iter()
            .map(|&(word, start_ms, end_ms)| {
                let start = cursor + text[cursor..].find(word).unwrap();
                cursor = start + word.len();
                WordAnchor {
                    start_ms,
                    end_ms,
                    text_start: start,
                    text_end: cursor,
                }
            })
            .collect::<Vec<_>>();
        TimedText {
            start_ms: anchors[0].start_ms,
            end_ms: anchors.last().unwrap().end_ms,
            text: text.into(),
            timing_precision: "cue".into(),
            word_anchors: anchors,
        }
    }

    fn pair(left: Vec<TimedText>, right: Vec<TimedText>) -> Vec<ChunkTranscript> {
        [left, right]
            .into_iter()
            .enumerate()
            .map(|(i, segments)| ChunkTranscript {
                chunk: AudioChunk {
                    index: i as u32,
                    sample_rate: 1000,
                    core_start_sample: i as u64 * 10_000,
                    core_end_sample: (i as u64 + 1) * 10_000,
                    request_start_sample: if i == 0 { 0 } else { 7000 },
                    request_end_sample: if i == 0 { 13000 } else { 20000 },
                    boundary: BoundaryKind::Forced,
                },
                segments,
            })
            .collect()
    }

    #[test]
    fn differently_grouped_words_dedupe_and_keep_nonoverlap_tails() {
        let chunks = pair(
            vec![cue(
                "Before. Same words.",
                &[
                    ("Before", 6000, 6500),
                    ("Same", 8000, 8500),
                    ("words", 9000, 9500),
                ],
            )],
            vec![
                cue("Same", &[("Same", 8000, 8500)]),
                cue(
                    "words. After.",
                    &[("words", 9000, 9500), ("After", 14000, 15000)],
                ),
            ],
        );
        let output = crate::stitch_chunks(chunks).unwrap();
        let text = output
            .segments
            .iter()
            .map(|row| row.text.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        assert_eq!(text, "Before. Same words. After.");
        assert!(output.boundary_conflicts.is_empty());
    }

    #[test]
    fn conflict_chooses_core_owner_and_keeps_both_original_alternatives() {
        let chunks = pair(
            vec![cue(
                "Before wrong.",
                &[("Before", 6000, 6500), ("wrong", 10100, 10600)],
            )],
            vec![cue(
                "right. After.",
                &[("right", 10100, 10600), ("After", 14000, 15000)],
            )],
        );
        let output = crate::stitch_chunks(chunks).unwrap();
        let text = output
            .segments
            .iter()
            .map(|row| row.text.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        assert_eq!(text, "Before right. After.");
        assert_eq!(output.boundary_conflicts.len(), 1);
        assert_eq!(
            output.boundary_conflicts[0].left_alternative[0].text,
            "wrong."
        );
        assert_eq!(
            output.boundary_conflicts[0].right_alternative[0].text,
            "right."
        );
    }

    #[test]
    fn different_occurrences_and_source_blocks_are_never_guessed_away() {
        let chunks = pair(
            vec![cue("No, no.", &[("No", 8000, 8500), ("no", 9000, 9500)])],
            vec![
                TimedText {
                    start_ms: 7000,
                    end_ms: 20000,
                    text: "Unaligned original text".into(),
                    timing_precision: "source_block".into(),
                    word_anchors: vec![],
                },
                cue("No, no.", &[("No", 8000, 8500), ("no", 9000, 9500)]),
            ],
        );
        let output = crate::stitch_chunks(chunks).unwrap();
        assert!(output.segments.iter().any(|row| row.text == "No, no."));
        assert!(output
            .segments
            .iter()
            .any(|row| row.text == "Unaligned original text"
                && row.timing_precision == "source_block"));
        assert_eq!(output.segments.len(), 2);
    }

    #[test]
    fn malformed_utf8_or_whitespace_anchor_is_rejected_before_slicing() {
        for (text, start, end) in [("語", 1, 3), (" word", 0, 5), ("word", 0, 8)] {
            let mut chunks = pair(
                vec![TimedText {
                    start_ms: 8000,
                    end_ms: 8500,
                    text: text.into(),
                    timing_precision: "cue".into(),
                    word_anchors: vec![WordAnchor {
                        start_ms: 8000,
                        end_ms: 8500,
                        text_start: start,
                        text_end: end,
                    }],
                }],
                vec![],
            );
            assert!(crate::stitch_chunks(std::mem::take(&mut chunks)).is_err());
        }
    }
}
