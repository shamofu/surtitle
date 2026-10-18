//! Unfinished local input is separate from subtitles, cards and AI authority.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditorDraft {
    pub id: String,
    pub media_id: String,
    pub kind: String,
    pub source_key: String,
    pub version: u64,
    pub fields: BTreeMap<String, String>,
    pub source_cues: Vec<crate::SubtitleSegment>,
    #[serde(default)]
    pub source_media_signature: String,
    #[serde(default)]
    pub binding_verified: bool,
    pub created_at: String,
    pub updated_at: String,
}

impl EditorDraft {
    pub fn detached(&self) -> Self {
        let mut draft = self.clone();
        draft.binding_verified = false;
        draft.source_media_signature.clear();
        draft
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveEditorDraft {
    pub id: String,
    pub media_id: String,
    pub kind: String,
    pub source_key: String,
    pub expected_version: u64,
    pub fields: BTreeMap<String, String>,
    pub source_cues: Vec<crate::SubtitleSegment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditorDraftVersion {
    pub id: String,
    pub version: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorDraftView {
    #[serde(flatten)]
    pub draft: EditorDraft,
    pub stale: bool,
}
