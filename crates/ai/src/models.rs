//! AI request plans and the task/output contracts they freeze.
mod audio;
mod output;
mod plan;
mod task;

pub use audio::{hash_file, AudioAttachment};
pub(crate) use output::parse_output;
pub use output::{CueTranslation, GeneratedCue, ParsedOutput, VocabularyItem};
pub use plan::{PreparationBinding, PreparedJob, RequestEstimate, TranscriptApplyPolicy};
pub use task::{RequestTask, SourceCue};
#[cfg(any(test, feature = "development-validation", feature = "e2e-fixtures"))]
pub use task::{AUDIO_MODEL, TRANSCRIBE_MODEL, VOCABULARY_MODEL};

#[cfg(test)]
use crate::AiError;
use serde::{Deserialize, Serialize};
#[cfg(test)]
use serde_json::{json, Value};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderCapability {
    pub model: String,
    pub available: bool,
    pub qualification: String,
}

/// Discovery and quality evidence do not constitute a model allowlist.
pub fn provider_capabilities() -> Vec<ProviderCapability> {
    Vec::new()
}

pub(crate) fn valid_project_id(s: &str) -> bool {
    (6..=63).contains(&s.len())
        && s.bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        && s.as_bytes()[0].is_ascii_lowercase()
        && !s.ends_with('-')
}

fn valid_sha(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|c| c.is_ascii_hexdigit())
}

#[cfg(test)]
mod fixture_tests;

#[cfg(test)]
mod explanation_tests;
