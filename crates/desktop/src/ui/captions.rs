// SPDX-License-Identifier: GPL-3.0-or-later
//! Subtitle boundary index; playback ticks never scan all subtitle text.
use std::collections::{BTreeMap, BTreeSet};
use surtitle_core::SubtitleSegment;

pub(crate) fn marked(cue: &SubtitleSegment) -> bool {
    cue.status == "generated_review"
        || cue.timing_precision == "source_block"
        || !cue.review_issues.is_empty()
}

/// Cache this projection when input or subtitle data changes, not on playback ticks.
pub(crate) fn transcript_rows(
    cues: &[SubtitleSegment],
    query: &str,
    marked_only: bool,
) -> Vec<usize> {
    let query = query.trim().to_lowercase();
    cues.iter()
        .enumerate()
        .filter(|(_, cue)| {
            (!marked_only || marked(cue))
                && (query.is_empty()
                    || cue.text.to_lowercase().contains(&query)
                    || cue
                        .translation
                        .as_ref()
                        .is_some_and(|text| text.to_lowercase().contains(&query)))
        })
        .map(|(index, _)| index)
        .collect()
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct CaptionFrame {
    pub active: Option<usize>,
    pub previous: Option<usize>,
    pub next: Option<usize>,
}
pub(crate) struct CaptionIndex {
    boundaries: Vec<u64>,
    frames: Vec<CaptionFrame>,
    initial: CaptionFrame,
}
impl CaptionIndex {
    pub fn new(cues: &[SubtitleSegment]) -> Self {
        let mut events: BTreeMap<u64, (Vec<usize>, Vec<usize>)> = BTreeMap::new();
        let mut future = BTreeSet::new();
        for (index, cue) in cues.iter().enumerate() {
            if cue.timing_precision != "cue"
                || !surtitle_core::model::is_usable_subtitle_status(&cue.status)
                || cue.start_ms >= cue.end_ms
            {
                continue;
            }
            events.entry(cue.start_ms).or_default().0.push(index);
            events.entry(cue.end_ms).or_default().1.push(index);
            future.insert((cue.start_ms, index));
        }
        let initial = CaptionFrame {
            next: future.first().map(|(_, index)| *index),
            ..Default::default()
        };
        let mut frames = Vec::with_capacity(events.len());
        let mut boundaries = Vec::with_capacity(events.len());
        let mut active = BTreeSet::new();
        let mut previous = None;
        for (time, (starts, ends)) in events {
            for index in ends {
                active.remove(&index);
                previous = Some(index);
            }
            for index in starts {
                active.insert(index);
                future.remove(&(time, index));
            }
            boundaries.push(time);
            frames.push(CaptionFrame {
                active: active.first().copied(),
                previous,
                next: future.first().map(|(_, index)| *index),
            });
        }
        Self {
            boundaries,
            frames,
            initial,
        }
    }
    pub fn at(&self, position: u64) -> CaptionFrame {
        self.boundaries
            .partition_point(|boundary| *boundary <= position)
            .checked_sub(1)
            .map(|index| self.frames[index])
            .unwrap_or(self.initial)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn cue(id: &str, start: u64, end: u64) -> SubtitleSegment {
        SubtitleSegment {
            id: id.into(),
            media_id: "m".into(),
            start_ms: start,
            end_ms: end,
            text: id.into(),
            translation: None,
            timing_precision: "cue".into(),
            status: "confirmed".into(),
            review_issues: vec![],
        }
    }
    #[test]
    fn transcript_filter_retains_source_indices_and_matches_translation() {
        let mut cues: Vec<_> = (0..20_000)
            .map(|index| cue(&format!("cue-{index}"), index * 1000, index * 1000 + 900))
            .collect();
        cues[12_345].translation = Some("A Quiet Place".into());
        cues[12_345].status = "generated_review".into();
        cues[19_999].translation = Some("quiet ending".into());
        assert_eq!(
            transcript_rows(&cues, "  QUIET  ", false),
            vec![12_345, 19_999]
        );
        assert_eq!(transcript_rows(&cues, "quiet", true), vec![12_345]);
        assert_eq!(
            cues[transcript_rows(&cues, "quiet", true)[0]].id,
            "cue-12345"
        );
        cues[12_345].status = "confirmed".into();
        assert!(transcript_rows(&cues, "", true).is_empty());
        cues[19_999].timing_precision = "source_block".into();
        assert_eq!(transcript_rows(&cues, "", true), vec![19_999]);
    }
    #[test]
    fn cue_boundaries_preserve_overlap_order_and_gap_context() {
        let index = CaptionIndex::new(&[
            cue("first", 100, 500),
            cue("overlap", 200, 400),
            cue("next", 700, 900),
        ]);
        assert_eq!(
            index.at(0),
            CaptionFrame {
                active: None,
                previous: None,
                next: Some(0)
            }
        );
        assert_eq!(index.at(250).active, Some(0));
        assert_eq!(index.at(450).active, Some(0));
        assert_eq!(
            index.at(500),
            CaptionFrame {
                active: None,
                previous: Some(0),
                next: Some(2)
            }
        );
        assert_eq!(index.at(700).active, Some(2));
        assert_eq!(
            index.at(900),
            CaptionFrame {
                active: None,
                previous: Some(2),
                next: None
            }
        );
    }
    #[test]
    fn untimed_or_unusable_passages_do_not_become_timed_captions() {
        let mut untimed = cue("broad", 0, 5000);
        untimed.timing_precision = "range".into();
        let mut failed = cue("failed", 0, 1000);
        failed.status = "failed".into();
        let index = CaptionIndex::new(&[untimed, failed, cue("usable", 100, 300)]);
        assert_eq!(index.at(200).active, Some(2));
        assert_eq!(index.at(500).active, None);
    }
}
