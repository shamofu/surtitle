//! Cue-aligned sentence ranges for local playback. These are punctuation/gap
//! heuristics, not inferred word timings; original subtitles are never changed.
use crate::{SentenceBoundary, SentenceRange, SubtitleSegment};
use anyhow::{Result, ensure};
use std::collections::HashSet;

const SENTENCE_GAP_MS: u64 = 2_000;

/// Group adjacent cues without inventing an endpoint inside an original cue.
/// Overlapping cues stay together so a stop does not cut another visible cue.
pub fn sentence_ranges(segments: &[SubtitleSegment]) -> Result<Vec<SentenceRange>> {
    let Some(first) = segments.first() else {
        return Ok(Vec::new());
    };
    let mut ids = HashSet::with_capacity(segments.len());
    for cue in segments {
        ensure!(
            cue.media_id == first.media_id
                && !cue.id.trim().is_empty()
                && cue.end_ms > cue.start_ms
                && !cue.text.trim().is_empty()
                && ids.insert(cue.id.as_str()),
            "Sentence playback requires valid, unique subtitles from one media item"
        );
    }
    let mut ordered: Vec<_> = segments.iter().collect();
    ordered.sort_by(|a, b| (a.start_ms, a.end_ms, &a.id).cmp(&(b.start_ms, b.end_ms, &b.id)));
    let mut ranges = Vec::new();
    let mut terminal_at_end = false;
    let mut group = SentenceRange {
        start_ms: ordered[0].start_ms,
        end_ms: ordered[0].end_ms,
        segment_ids: Vec::new(),
        boundary: SentenceBoundary::EndOfSubtitles,
    };
    for (index, cue) in ordered.iter().enumerate() {
        if group.segment_ids.is_empty() {
            group.start_ms = cue.start_ms;
            group.end_ms = cue.end_ms;
            terminal_at_end = terminal_punctuation(&cue.text);
        } else if cue.end_ms > group.end_ms {
            terminal_at_end = terminal_punctuation(&cue.text);
        } else if cue.end_ms == group.end_ms {
            terminal_at_end &= terminal_punctuation(&cue.text);
        }
        group.end_ms = group.end_ms.max(cue.end_ms);
        group.segment_ids.push(cue.id.clone());
        let next = ordered.get(index + 1);
        let boundary = if next.is_none() {
            Some(SentenceBoundary::EndOfSubtitles)
        } else if next.is_some_and(|next| next.start_ms < group.end_ms) {
            None
        } else if terminal_at_end {
            Some(SentenceBoundary::Punctuation)
        } else if next
            .is_some_and(|next| next.start_ms.saturating_sub(group.end_ms) >= SENTENCE_GAP_MS)
        {
            Some(SentenceBoundary::Gap)
        } else {
            None
        };
        if let Some(boundary) = boundary {
            group.boundary = boundary;
            ranges.push(group);
            group = SentenceRange {
                start_ms: 0,
                end_ms: 0,
                segment_ids: Vec::new(),
                boundary: SentenceBoundary::EndOfSubtitles,
            };
        }
    }
    Ok(ranges)
}

fn terminal_punctuation(text: &str) -> bool {
    let mut end = text.trim();
    loop {
        let trimmed = end.trim_end_matches(|c: char| {
            c.is_whitespace()
                || matches!(
                    c,
                    '"' | '\''
                        | '”'
                        | '’'
                        | ')'
                        | ']'
                        | '}'
                        | '」'
                        | '』'
                        | '）'
                        | '】'
                        | '》'
                        | '〉'
                )
        });
        if trimmed != end {
            end = trimmed;
            continue;
        }
        if end.ends_with('>')
            && let Some(open) = end.rfind("</")
        {
            let tag = &end[open + 2..end.len() - 1];
            if ["b", "i", "u", "font", "ruby", "rt", "c", "v", "lang"]
                .iter()
                .any(|known| tag.eq_ignore_ascii_case(known))
            {
                end = end[..open].trim_end();
                continue;
            }
        }
        break;
    }
    if end.ends_with([
        '!', '?', '。', '！', '？', '…', '؟', '۔', '।', '॥', '｡', '．',
    ]) {
        return true;
    }
    if !end.ends_with('.') {
        return false;
    }
    let token = end.rsplit(char::is_whitespace).next().unwrap_or(end);
    // A subtitle style tag can be attached directly to an abbreviation.
    let token = token.rsplit('>').next().unwrap_or(token);
    let token = token.trim_start_matches(|c: char| !c.is_alphanumeric());
    if [
        "mr.", "mrs.", "ms.", "dr.", "prof.", "sr.", "jr.", "st.", "vs.", "etc.", "e.g.", "i.e.",
    ]
    .iter()
    .any(|abbreviation| token.eq_ignore_ascii_case(abbreviation))
    {
        return false;
    }
    // Initials and dotted initialisms commonly continue into the next cue.
    let letters = token.trim_end_matches('.');
    !(!letters.is_empty()
        && letters
            .split('.')
            .all(|part| part.len() == 1 && part.as_bytes()[0].is_ascii_alphabetic()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cue(id: &str, start: u64, end: u64, text: &str) -> SubtitleSegment {
        SubtitleSegment {
            id: id.into(),
            media_id: "media".into(),
            start_ms: start,
            end_ms: end,
            text: text.into(),
            translation: None,
            status: "confirmed".into(),
        }
    }

    #[test]
    fn a_sentence_can_span_cues_without_changing_their_text_or_times() {
        let cues = vec![
            cue("a", 100, 800, "We need to"),
            cue("b", 900, 1900, "look into this."),
            cue("c", 2000, 3000, "Then we can decide."),
        ];
        let before = serde_json::to_vec(&cues).unwrap();
        let ranges = sentence_ranges(&cues).unwrap();
        assert_eq!(ranges.len(), 2);
        assert_eq!(ranges[0].segment_ids, ["a", "b"]);
        assert_eq!((ranges[0].start_ms, ranges[0].end_ms), (100, 1900));
        assert_eq!(ranges[0].boundary, SentenceBoundary::Punctuation);
        assert_eq!(serde_json::to_vec(&cues).unwrap(), before);
    }

    #[test]
    fn japanese_quotes_and_formatted_subtitles_preserve_cue_endpoints() {
        let cues = vec![
            cue("a", 0, 1000, "「次の文まで"),
            cue("b", 1000, 2000, "<i>続きます。」</i>"),
            cue("c", 2000, 3000, "Ready?\""),
            cue("d", 3000, 4000, "Yes!"),
        ];
        let ranges = sentence_ranges(&cues).unwrap();
        assert_eq!(
            ranges.iter().map(|s| s.end_ms).collect::<Vec<_>>(),
            [2000, 3000, 4000]
        );
        assert_eq!(ranges[0].segment_ids, ["a", "b"]);
    }

    #[test]
    fn honorifics_initials_and_acronyms_do_not_split_continuing_cues() {
        for prefix in [
            "Ask Dr.",
            "The U.S.",
            "A.",
            "For example, e.g.",
            "<i>Dr.</i>",
        ] {
            let ranges = sentence_ranges(&[
                cue("a", 0, 1000, prefix),
                cue("b", 1000, 2000, "continues here."),
            ])
            .unwrap();
            assert_eq!(ranges.len(), 1, "{prefix}");
        }
        assert!(terminal_punctuation("It costs 2.50."));
        assert!(!terminal_punctuation("It costs 2.50"));
    }

    #[test]
    fn gaps_and_final_cues_are_marked_without_claiming_punctuation() {
        let ranges = sentence_ranges(&[
            cue("a", 0, 1000, "no punctuation"),
            cue("b", 3000, 4000, "still no punctuation"),
        ])
        .unwrap();
        assert_eq!(ranges.len(), 2);
        assert_eq!(ranges[0].boundary, SentenceBoundary::Gap);
        assert_eq!(ranges[1].boundary, SentenceBoundary::EndOfSubtitles);
    }

    #[test]
    fn overlapping_cues_remain_together_even_when_input_is_unsorted() {
        let ranges = sentence_ranges(&[
            cue("c", 3000, 4000, "Next."),
            cue("b", 1000, 2000, "Brief interjection"),
            cue("a", 0, 3000, "Long sentence."),
        ])
        .unwrap();
        assert_eq!(ranges.len(), 2);
        assert_eq!(ranges[0].segment_ids, ["a", "b"]);
        assert_eq!(ranges[0].end_ms, 3000);
        let continuing = sentence_ranges(&[
            cue("a", 0, 3000, "A longer unfinished"),
            cue("b", 1000, 2000, "Interjection!"),
            cue("c", 3000, 4000, "sentence."),
        ])
        .unwrap();
        assert_eq!(continuing.len(), 1);
        assert_eq!(continuing[0].end_ms, 4000);
    }

    #[test]
    fn invalid_or_mixed_sources_cannot_arm_sentence_stops() {
        let original = cue("a", 0, 1000, "Text.");
        assert!(sentence_ranges(&[original.clone(), original.clone()]).is_err());
        let mut other = cue("b", 1000, 2000, "Text.");
        other.media_id = "other".into();
        assert!(sentence_ranges(&[original, other]).is_err());
        assert!(sentence_ranges(&[cue("a", 1000, 1000, "Text.")]).is_err());
        assert!(sentence_ranges(&[]).unwrap().is_empty());
    }
}
