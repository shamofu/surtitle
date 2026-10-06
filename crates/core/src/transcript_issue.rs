//! Portable transcript notes can describe a range even when it has no subtitle cue.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TranscriptIssueRecord {
    pub id: String,
    pub media_id: String,
    pub source_id: String,
    pub kind: String,
    pub start_ms: u64,
    pub end_ms: u64,
    #[serde(default = "active")]
    pub active: bool,
    #[serde(default)]
    pub alternatives: Vec<crate::SubtitleReviewAlternative>,
}

fn active() -> bool {
    true
}
