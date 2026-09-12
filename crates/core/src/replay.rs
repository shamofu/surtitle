use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};

/// Actual source-media range of a saved clip, separate from its cited subtitles.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioClipRange {
    pub start_ms: u64,
    pub end_ms: u64,
}

impl AudioClipRange {
    pub fn validate_source(&self, start_ms: u64, end_ms: u64) -> Result<()> {
        ensure!(
            end_ms > start_ms && end_ms - start_ms <= 180_000,
            "Invalid source range"
        );
        ensure!(
            self.start_ms <= start_ms
                && self.end_ms >= end_ms
                && start_ms - self.start_ms <= 1000
                && self.end_ms - end_ms <= 1000,
            "Clip context does not match its source range"
        );
        Ok(())
    }
}

/// Add playback context without changing subtitle times or removing source audio.
pub fn replay_range(
    start_ms: u64,
    end_ms: u64,
    duration_ms: u64,
    context_ms: u16,
) -> Result<AudioClipRange> {
    ensure!(
        context_ms <= 1000,
        "Playback context must be between 0 and 1000 ms"
    );
    ensure!(
        start_ms < end_ms && end_ms <= duration_ms && end_ms - start_ms <= 180_000,
        "Source range is outside the media or exceeds 180 seconds"
    );
    Ok(AudioClipRange {
        start_ms: start_ms.saturating_sub(u64::from(context_ms)),
        end_ms: end_ms
            .saturating_add(u64::from(context_ms))
            .min(duration_ms),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn context_preserves_source_and_clamps_only_added_audio() {
        assert_eq!(
            replay_range(100, 1900, 2000, 150).unwrap(),
            AudioClipRange {
                start_ms: 0,
                end_ms: 2000
            }
        );
        assert_eq!(
            replay_range(1000, 2000, 4000, 0).unwrap(),
            AudioClipRange {
                start_ms: 1000,
                end_ms: 2000
            }
        );
        let range = replay_range(1000, 181000, 182000, 1000).unwrap();
        assert_eq!(range.end_ms - range.start_ms, 182000);
        range.validate_source(1000, 181000).unwrap();
        assert!(replay_range(1000, 2001, 2000, 150).is_err());
        assert!(replay_range(1000, 1000, 2000, 150).is_err());
        assert!(replay_range(1000, 2000, 3000, 1001).is_err());
        assert!(replay_range(0, 180001, 200000, 0).is_err());
        assert!(
            AudioClipRange {
                start_ms: 1100,
                end_ms: 2000
            }
            .validate_source(1000, 2000)
            .is_err()
        );
        assert!(
            AudioClipRange {
                start_ms: 0,
                end_ms: 3001
            }
            .validate_source(1000, 2000)
            .is_err()
        );
        assert_eq!(
            replay_range(u64::MAX - 100, u64::MAX, u64::MAX, 150)
                .unwrap()
                .end_ms,
            u64::MAX
        );
    }
}
