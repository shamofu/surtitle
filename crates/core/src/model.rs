use crate::AudioClipRange;
use serde::{Deserialize, Serialize};

pub fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}
pub fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Media {
    pub id: String,
    pub title: String,
    pub path: String,
    pub source_url: Option<String>,
    pub kind: String,
    pub duration_ms: u64,
    pub learning_language: String,
    pub explanation_language: String,
    pub created_at: String,
    pub last_position_ms: u64,
    pub segment_count: usize,
    pub card_count: usize,
    pub status: String,
    pub error: Option<String>,
    #[serde(default)]
    pub audio_stream_index: Option<u32>,
    #[serde(default)]
    pub subtitle_stream_index: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleSegment {
    pub id: String,
    pub media_id: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
    pub translation: Option<String>,
    #[serde(default = "confirmed")]
    pub status: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub review_issues: Vec<SubtitleReviewIssue>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleReviewIssue {
    pub id: String,
    pub kind: String,
    pub start_ms: u64,
    pub end_ms: u64,
    #[serde(default)]
    pub alternatives: Vec<SubtitleReviewAlternative>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleReviewAlternative {
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}
pub fn is_usable_subtitle_status(status: &str) -> bool {
    matches!(status, "confirmed" | "generated" | "generated_review")
}
fn confirmed() -> String {
    "confirmed".into()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SentenceBoundary {
    Punctuation,
    Gap,
    EndOfSubtitles,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SentenceRange {
    pub start_ms: u64,
    pub end_ms: u64,
    pub segment_ids: Vec<String>,
    pub boundary: SentenceBoundary,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StudyCard {
    pub id: String,
    pub media_id: String,
    pub segment_id: String,
    #[serde(default)]
    pub source_cues: Vec<SubtitleSegment>,
    pub term: String,
    pub meaning: String,
    pub example: String,
    pub language: String,
    pub due_at: String,
    pub created_at: String,
    pub review_count: u32,
    pub audio_path: Option<String>,
    #[serde(default)]
    pub audio_clip_range: Option<AudioClipRange>,
    #[serde(default)]
    pub audio_stream_index: Option<u32>,
    pub suspended: bool,
    #[serde(default)]
    pub translation: Option<String>,
    #[serde(default)]
    pub explanation: Option<String>,
    #[serde(default)]
    pub source_title: String,
    #[serde(default)]
    pub source_url: Option<String>,
    #[serde(default)]
    pub start_ms: u64,
    #[serde(default)]
    pub end_ms: u64,
    #[serde(default)]
    pub memory: Option<MemoryState>,
    #[serde(default)]
    pub last_review: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct MemoryState {
    pub stability: f32,
    pub difficulty: f32,
}
impl From<MemoryState> for fsrs::MemoryState {
    fn from(m: MemoryState) -> Self {
        Self {
            stability: m.stability,
            difficulty: m.difficulty,
        }
    }
}
impl From<fsrs::MemoryState> for MemoryState {
    fn from(m: fsrs::MemoryState) -> Self {
        Self {
            stability: m.stability,
            difficulty: m.difficulty,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    pub id: String,
    pub card_id: String,
    pub rating: String,
    pub reviewed_at: String,
    pub scheduled_days: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub theme: String,
    pub locale: String,
    pub learning_language: String,
    pub explanation_language: String,
    pub daily_budget_usd: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub monthly_budget_usd: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub per_job_budget_usd: Option<f64>,
    pub vertex_project: String,
    pub vertex_location: String,
    pub credential_configured: bool,
    pub retention: f32,
    #[serde(default)]
    pub sentence_pause: bool,
    #[serde(default = "default_replay_context")]
    pub replay_context_ms: u16,
    #[serde(default = "default_proficiency")]
    pub proficiency: String,
    #[serde(default = "default_channel")]
    pub yt_dlp_channel: String,
    #[serde(default)]
    pub ai_models: std::collections::BTreeMap<String, AiModelPreference>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiModelPreference {
    pub model_id: String,
    #[serde(default = "default_transcription_mode")]
    pub transcription_mode: String,
    pub max_output_tokens: u32,
    pub thinking_level: Option<String>,
    pub thinking_budget: Option<i32>,
    pub price: Option<AiPricePreference>,
}
fn default_transcription_mode() -> String {
    "transcribe".into()
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiPricePreference {
    pub id: String,
    pub source: String,
    pub observed_at_ms: i64,
    pub input_microusd_per_million: u64,
    pub output_microusd_per_million: u64,
}
fn default_proficiency() -> String {
    "B1".into()
}
fn default_replay_context() -> u16 {
    150
}
fn default_channel() -> String {
    "stable".into()
}
impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme: "dark".into(),
            locale: "ja".into(),
            learning_language: "en".into(),
            explanation_language: "ja".into(),
            daily_budget_usd: 0.,
            monthly_budget_usd: Some(0.),
            per_job_budget_usd: Some(0.),
            vertex_project: String::new(),
            vertex_location: "global".into(),
            credential_configured: false,
            retention: 0.9,
            sentence_pause: false,
            replay_context_ms: default_replay_context(),
            proficiency: default_proficiency(),
            yt_dlp_channel: default_channel(),
            ai_models: Default::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveCard {
    pub media_id: String,
    pub segment_id: String,
    #[serde(default)]
    pub source_cue_ids: Vec<String>,
    pub term: String,
    pub meaning: String,
    pub example: String,
    #[serde(default)]
    pub translation: Option<String>,
    #[serde(default)]
    pub explanation: Option<String>,
}

/// Only editable study content. Scheduling and source audio are immutable here.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditCard {
    pub id: String,
    pub term: String,
    pub meaning: String,
    pub example: String,
    pub translation: Option<String>,
    pub explanation: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleVersion {
    pub id: String,
    pub media_id: String,
    pub created_at: String,
    pub label: String,
    pub stream_index: Option<u32>,
    pub segments: Vec<SubtitleSegment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LearningArchive {
    pub format: String,
    pub schema_version: u32,
    pub exported_at: String,
    pub media: Vec<Media>,
    pub segments: Vec<SubtitleSegment>,
    pub cards: Vec<StudyCard>,
    pub reviews: Vec<Review>,
    #[serde(default)]
    pub subtitle_versions: Vec<SubtitleVersion>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub draft_study_selections: Vec<DraftStudySelection>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub editor_drafts: Vec<crate::EditorDraft>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub transcript_issues: Vec<crate::TranscriptIssueRecord>,
}

/// A local learning excerpt, independent of canonical subtitles and saved cards.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DraftStudySelection {
    pub id: String,
    pub media_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub job_id: Option<String>,
    pub version: u64,
    pub text: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub source_start_ms: u64,
    pub source_end_ms: u64,
    pub cue_ids: Vec<String>,
    pub ordinal: Option<u32>,
    pub origin: String,
    pub timing: String,
    pub confirmed: bool,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
    pub source_snapshot: serde_json::Value,
}

impl DraftStudySelection {
    /// Exports preserve the bookmark without transferring operational authority.
    pub fn detached(&self) -> Self {
        let mut value = self.clone();
        value.job_id = None;
        value.source_snapshot = serde_json::Value::Null;
        value.confirmed = false;
        value
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DraftStudySelectionEdit {
    pub text: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub confirmed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DraftStudyCardFields {
    pub term: String,
    pub meaning: String,
    /// The persisted card always uses the confirmed selection text as its example.
    pub example: String,
    pub translation: Option<String>,
    pub explanation: Option<String>,
}

#[cfg(test)]
mod settings_tests {
    use super::AppSettings;

    #[test]
    fn legacy_settings_preserve_budget_fallback_and_explicit_channel() {
        let mut value = serde_json::to_value(AppSettings::default()).unwrap();
        for field in ["monthlyBudgetUsd", "perJobBudgetUsd", "ytDlpChannel"] {
            value.as_object_mut().unwrap().remove(field);
        }
        value["dailyBudgetUsd"] = serde_json::json!(12.);
        let legacy: AppSettings = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(legacy.daily_budget_usd, 12.);
        assert_eq!(legacy.monthly_budget_usd, None);
        assert_eq!(legacy.per_job_budget_usd, None);
        assert_eq!(legacy.yt_dlp_channel, "stable");
        value["ytDlpChannel"] = serde_json::json!("nightly");
        let explicit: AppSettings = serde_json::from_value(value).unwrap();
        assert_eq!(explicit.yt_dlp_channel, "nightly");
        assert_eq!(AppSettings::default().yt_dlp_channel, "stable");
    }
}
