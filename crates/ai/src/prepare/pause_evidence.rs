use crate::{AiError, AudioChunk, Pause, Result, VadAssets};
use serde::{Deserialize, Serialize};

pub(crate) const PAUSE_POLICY: &str = "silero-low-posterior-0.35-2s-250ms-v1";
const MINIMUM_PAUSE_MS: u64 = 2000;
const BOUNDARY_GUARD_MS: u64 = 250;
const MAX_PAUSES: usize = 50_000;

/// Review evidence from sustained low-posterior frames, not proof of silence.
/// Every range refers to original PCM samples; no audio is removed or retimed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VadPauseEvidence {
    pub policy: String,
    pub model_sha256: String,
    pub runtime_sha256: String,
    pub sample_rate: u32,
    pub source_start_sample: u64,
    pub source_end_sample: u64,
    pub minimum_pause_ms: u64,
    pub boundary_guard_ms: u64,
    pub pauses: Vec<Pause>,
}

impl VadPauseEvidence {
    pub(crate) fn from_analysis(
        relative_pauses: &[Pause],
        source_start_sample: u64,
        total_samples: u64,
        assets: &VadAssets,
    ) -> Result<Self> {
        let source_end_sample = source_start_sample
            .checked_add(total_samples)
            .ok_or_else(|| invalid("source sample overflow"))?;
        let mut pauses = Vec::new();
        for pause in relative_pauses {
            if pause.end_sample.saturating_sub(pause.start_sample) < MINIMUM_PAUSE_MS * 16 {
                continue;
            }
            pauses.push(Pause {
                start_sample: source_start_sample
                    .checked_add(pause.start_sample)
                    .ok_or_else(|| invalid("pause sample overflow"))?,
                end_sample: source_start_sample
                    .checked_add(pause.end_sample)
                    .ok_or_else(|| invalid("pause sample overflow"))?,
            });
        }
        let evidence = Self {
            policy: PAUSE_POLICY.into(),
            model_sha256: assets.model_sha256.clone(),
            runtime_sha256: assets.runtime_sha256.clone(),
            sample_rate: 16_000,
            source_start_sample,
            source_end_sample,
            minimum_pause_ms: MINIMUM_PAUSE_MS,
            boundary_guard_ms: BOUNDARY_GUARD_MS,
            pauses,
        };
        evidence.validate()?;
        Ok(evidence)
    }

    pub(crate) fn validate(&self) -> Result<()> {
        let hash = |s: &str| s.len() == 64 && s.bytes().all(|c| c.is_ascii_hexdigit());
        if self.policy != PAUSE_POLICY
            || !hash(&self.model_sha256)
            || !hash(&self.runtime_sha256)
            || self.sample_rate != 16_000
            || self.source_start_sample >= self.source_end_sample
            || self.source_end_sample > u64::MAX / 1000
            || self.minimum_pause_ms != MINIMUM_PAUSE_MS
            || self.boundary_guard_ms != BOUNDARY_GUARD_MS
            || self.pauses.len() > MAX_PAUSES
        {
            return Err(invalid("invalid policy, provenance or source range"));
        }
        let mut previous_end = self.source_start_sample;
        for pause in &self.pauses {
            if pause.start_sample < previous_end
                || pause.start_sample >= pause.end_sample
                || pause.end_sample > self.source_end_sample
                || pause.end_sample - pause.start_sample < MINIMUM_PAUSE_MS * 16
                || !(pause.start_sample - self.source_start_sample).is_multiple_of(512)
                || (pause.end_sample != self.source_end_sample
                    && !(pause.end_sample - self.source_start_sample).is_multiple_of(512))
            {
                return Err(invalid("pause ranges must be ordered, bounded VAD frames"));
            }
            previous_end = pause.end_sample;
        }
        Ok(())
    }

    pub(crate) fn for_chunk(&self, chunk: &AudioChunk) -> Option<Self> {
        let first = self
            .pauses
            .partition_point(|pause| pause.end_sample <= chunk.request_start_sample);
        let pauses: Vec<_> = self.pauses[first..]
            .iter()
            .take_while(|pause| pause.start_sample < chunk.request_end_sample)
            .copied()
            .collect();
        if pauses.is_empty() {
            return None;
        }
        Some(Self {
            policy: self.policy.clone(),
            model_sha256: self.model_sha256.clone(),
            runtime_sha256: self.runtime_sha256.clone(),
            sample_rate: self.sample_rate,
            source_start_sample: self.source_start_sample,
            source_end_sample: self.source_end_sample,
            minimum_pause_ms: self.minimum_pause_ms,
            boundary_guard_ms: self.boundary_guard_ms,
            pauses,
        })
    }

    pub(crate) fn guarded_range(&self, pause: &Pause) -> (u64, u64) {
        let guard = self.boundary_guard_ms * 16;
        (
            (pause.start_sample + guard).div_ceil(16),
            (pause.end_sample - guard) / 16,
        )
    }
}

fn invalid(reason: &str) -> AiError {
    AiError::Invalid(format!("Invalid VAD pause evidence: {reason}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assets() -> VadAssets {
        VadAssets {
            model_path: "unused.onnx".into(),
            runtime_path: "unused.dll".into(),
            model_sha256: crate::sha256_bytes(b"vad"),
            runtime_sha256: crate::sha256_bytes(b"runtime"),
        }
    }

    #[test]
    fn pause_evidence_keeps_exact_source_samples_and_inward_guarded_times() {
        let evidence = VadPauseEvidence::from_analysis(
            &[
                Pause {
                    start_sample: 0,
                    end_sample: 31_744,
                },
                Pause {
                    start_sample: 32_768,
                    end_sample: 65_536,
                },
                Pause {
                    start_sample: 66_048,
                    end_sample: 100_003,
                },
            ],
            16_016,
            100_003,
            &assets(),
        )
        .unwrap();
        assert_eq!(evidence.pauses.len(), 2);
        assert_eq!(
            evidence.pauses[0],
            Pause {
                start_sample: 48_784,
                end_sample: 81_552
            }
        );
        assert_eq!(evidence.pauses[1].end_sample, 116_019);
        assert_eq!(evidence.guarded_range(&evidence.pauses[0]), (3299, 4847));
        assert_eq!(evidence.guarded_range(&evidence.pauses[1]).1, 7001);
        assert_eq!(evidence.model_sha256, assets().model_sha256);
        assert_eq!(evidence.runtime_sha256, assets().runtime_sha256);
        let encoded = serde_json::to_vec(&evidence).unwrap();
        let saved: VadPauseEvidence = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(saved, evidence);
        assert_eq!(serde_json::to_vec(&saved).unwrap(), encoded);
    }

    #[test]
    fn pause_evidence_rejects_changed_policy_provenance_and_invalid_sample_ranges() {
        let original = VadPauseEvidence::from_analysis(
            &[Pause {
                start_sample: 512,
                end_sample: 65_536,
            }],
            16_000,
            100_000,
            &assets(),
        )
        .unwrap();
        let mutations: [fn(&mut VadPauseEvidence); 11] = [
            |value| value.policy = "relaxed".into(),
            |value| value.model_sha256.clear(),
            |value| value.runtime_sha256 = "not-a-hash".into(),
            |value| value.sample_rate = 1000,
            |value| value.minimum_pause_ms = 200,
            |value| value.boundary_guard_ms = 0,
            |value| value.pauses[0].start_sample += 1,
            |value| value.pauses[0].end_sample -= 1,
            |value| value.pauses[0].end_sample = value.source_end_sample + 512,
            |value| value.pauses[0].end_sample = value.pauses[0].start_sample + 31_744,
            |value| value.pauses.push(value.pauses[0]),
        ];
        for mutate in mutations {
            let mut value = original.clone();
            mutate(&mut value);
            assert!(
                value.validate().is_err(),
                "Accepted invalid evidence: {value:?}"
            );
        }
    }
}
