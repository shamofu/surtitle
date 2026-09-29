use crate::SubtitleSegment;
use anyhow::{Context, Result, ensure};

/// A source range resolved from trusted, ordered subtitle records.
pub struct ConfirmedCueRange<'a> {
    pub cues: &'a [SubtitleSegment],
    pub start_ms: u64,
    pub end_ms: u64,
}
/// Shared by card creation and source playback so their selection rules agree.
pub fn confirmed_cue_range<'a>(
    segments: &'a [SubtitleSegment],
    media_id: &str,
    ids: &[String],
) -> Result<ConfirmedCueRange<'a>> {
    ensure!(
        !ids.is_empty() && ids.len() <= 64,
        "Choose 1–64 source subtitles"
    );
    let first = segments
        .iter()
        .position(|cue| cue.id == ids[0])
        .context("Source subtitle is missing")?;
    let cues = segments
        .get(first..first + ids.len())
        .context("Source subtitles are no longer adjacent")?;
    ensure!(
        cues.iter().zip(ids).all(|(cue, id)| cue.id == *id
            && cue.media_id == media_id
            && cue.status == "confirmed"),
        "Source subtitles must be confirmed, ordered and adjacent"
    );
    let start_ms = cues[0].start_ms;
    let end_ms = cues
        .iter()
        .map(|cue| cue.end_ms)
        .max()
        .context("Source subtitle is missing")?;
    ensure!(
        end_ms > start_ms && end_ms - start_ms <= 180_000,
        "Source range must be at most 180 seconds"
    );
    Ok(ConfirmedCueRange {
        cues,
        start_ms,
        end_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn cue(id: &str, start_ms: u64, end_ms: u64) -> SubtitleSegment {
        SubtitleSegment {
            id: id.into(),
            media_id: "media".into(),
            start_ms,
            end_ms,
            text: id.into(),
            translation: None,
            status: "confirmed".into(),
        }
    }
    fn ids(values: &[&str]) -> Vec<String> {
        values.iter().map(|id| (*id).into()).collect()
    }
    #[test]
    fn overlap_uses_the_latest_end_and_keeps_exact_source_records() {
        let cues = vec![
            cue("a", 100, 3000),
            cue("b", 1200, 2000),
            cue("c", 3100, 4000),
        ];
        let range = confirmed_cue_range(&cues, "media", &ids(&["a", "b"])).unwrap();
        assert_eq!((range.start_ms, range.end_ms), (100, 3000));
        assert_eq!(range.cues.len(), 2);
        assert!(std::ptr::eq(range.cues.as_ptr(), cues.as_ptr()));
    }
    #[test]
    fn invalid_selection_cannot_cross_media_order_confirmation_or_limits() {
        let mut cues = vec![
            cue("a", 0, 1000),
            cue("b", 1000, 2000),
            cue("c", 2000, 3000),
        ];
        for selection in [
            ids(&[]),
            ids(&["missing"]),
            ids(&["a", "c"]),
            ids(&["b", "a"]),
            ids(&["a", "a"]),
        ] {
            assert!(confirmed_cue_range(&cues, "media", &selection).is_err());
        }
        assert!(confirmed_cue_range(&cues, "other", &ids(&["a"])).is_err());
        cues[1].media_id = "other".into();
        assert!(confirmed_cue_range(&cues, "media", &ids(&["a", "b"])).is_err());
        cues[1].media_id = "media".into();
        cues[1].status = "draft".into();
        assert!(confirmed_cue_range(&cues, "media", &ids(&["a", "b"])).is_err());
        assert!(confirmed_cue_range(&[cue("a", 0, 180_000)], "media", &ids(&["a"])).is_ok());
        assert!(confirmed_cue_range(&[cue("a", 0, 180_001)], "media", &ids(&["a"])).is_err());
        assert!(confirmed_cue_range(&[cue("a", 0, 0)], "media", &ids(&["a"])).is_err());
        let many = (0..65)
            .map(|index| cue(&index.to_string(), index * 100, index * 100 + 50))
            .collect::<Vec<_>>();
        let selected = many.iter().map(|cue| cue.id.clone()).collect::<Vec<_>>();
        assert!(confirmed_cue_range(&many, "media", &selected[..64]).is_ok());
        assert!(confirmed_cue_range(&many, "media", &selected).is_err());
    }
}
