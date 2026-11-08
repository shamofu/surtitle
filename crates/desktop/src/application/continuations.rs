//! Local unfinished AI flows. Restoring one never grants execution authority.
use super::{AppState, err, lock};
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use surtitle_core::AiModelPreference;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiContinuation {
    #[serde(default)]
    pub provider: surtitle_core::AiProvider,
    #[serde(default)]
    pub ai_configuration_generation: u64,
    pub id: String,
    pub media_id: String,
    pub kind: String,
    pub start: String,
    pub end: String,
    pub whole_media: bool,
    pub focus_term: String,
    #[serde(default)]
    pub models: HashMap<String, AiModelPreference>,
    /// Unfinished non-secret per-request controls, separate from executable models.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub model_inputs: HashMap<String, BTreeMap<String, String>>,
    pub preparation_id: Option<String>,
    pub quote_id: Option<String>,
    #[serde(default)]
    pub source_cue_ids: Vec<String>,
    #[serde(default)]
    pub source_revision: Option<String>,
    #[serde(default)]
    pub source_media_signature: Option<String>,
    #[serde(default)]
    pub updated_at_ms: i64,
}
impl AiContinuation {
    fn validate(&self) -> Result<()> {
        ensure!(
            !self.id.is_empty() && self.id.len() <= 128,
            "Invalid continuation ID"
        );
        ensure!(
            ["transcribe", "translate", "vocabulary"].contains(&self.kind.as_str()),
            "Invalid AI purpose"
        );
        ensure!(
            self.start.len() <= 64 && self.end.len() <= 64 && self.focus_term.len() <= 64 * 1024,
            "Unfinished input is too large"
        );
        ensure!(
            self.models.len() <= 4
                && self.models.keys().all(|key| [
                    "transcription",
                    "translation",
                    "explanation",
                    "vocabulary"
                ]
                .contains(&key.as_str())),
            "Invalid model overrides"
        );
        ensure!(
            self.source_cue_ids.len() <= 1000,
            "Too many source subtitles"
        );
        ensure!(
            self.model_inputs.len() <= 8
                && self.model_inputs.iter().all(|(purpose, fields)| {
                    purpose.split_once(':').is_some_and(|(provider, purpose)| {
                        ["vertex", "openai"].contains(&provider)
                            && ["transcription", "translation", "explanation", "vocabulary"]
                                .contains(&purpose)
                    }) && fields.len() <= 10
                        && fields.iter().all(|(key, value)| {
                            [
                                "enabled",
                                "manualPrice",
                                "modelId",
                                "transcriptionMode",
                                "maxOutputTokens",
                                "thinkingLevel",
                                "thinkingBudget",
                                "inputPrice",
                                "outputPrice",
                                "audioPrice",
                            ]
                            .contains(&key.as_str())
                                && value.len() <= 4096
                        })
                }),
            "Invalid unfinished model input"
        );
        ensure!(
            serde_json::to_vec(self)?.len() <= 128 * 1024,
            "Unfinished operation is too large"
        );
        Ok(())
    }
}
pub fn save(
    state: AppState,
    mut continuation: AiContinuation,
) -> std::result::Result<AiContinuation, String> {
    (|| {
        continuation.validate()?;
        lock(&state.db)?.media(&continuation.media_id)?;
        continuation.updated_at_ms = chrono::Utc::now().timestamp_millis();
        state.preferences.update(|preferences| {
            preferences
                .ai_continuations
                .insert(continuation.id.clone(), continuation.clone());
            Ok(())
        })?;
        Ok(continuation)
    })()
    .map_err(err)
}
pub fn list(state: AppState) -> std::result::Result<Vec<AiContinuation>, String> {
    (|| {
        let existing: std::collections::HashSet<_> = lock(&state.db)?
            .list_media()?
            .into_iter()
            .map(|m| m.id)
            .collect();
        let mut items: Vec<_> = state
            .preferences
            .read()?
            .ai_continuations
            .values()
            .filter(|item| existing.contains(&item.media_id))
            .cloned()
            .collect();
        items.sort_by_key(|item| std::cmp::Reverse(item.updated_at_ms));
        Ok(items)
    })()
    .map_err(err)
}
pub fn discard(state: AppState, id: String) -> std::result::Result<(), String> {
    state
        .preferences
        .update(|preferences| {
            preferences.ai_continuations.remove(&id);
            Ok(())
        })
        .map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn continuation_survives_atomic_preferences_restart_without_authority() {
        let d = tempfile::tempdir_in(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../work"),
        )
        .unwrap();
        let path = d.path().join("preferences.json");
        let p = super::super::PreferencesStore::open(path.clone()).unwrap();
        let mut item = AiContinuation {
            provider: surtitle_core::AiProvider::Vertex,
            ai_configuration_generation: 0,
            id: "resume".into(),
            media_id: "media".into(),
            kind: "transcribe".into(),
            start: "00:00:00".into(),
            end: "00:36:34.474".into(),
            whole_media: true,
            focus_term: String::new(),
            models: HashMap::new(),
            model_inputs: HashMap::new(),
            preparation_id: Some("prepared".into()),
            quote_id: None,
            source_cue_ids: vec![],
            source_revision: None,
            source_media_signature: Some("[\"C:/video.mkv\",null,\"en\",\"ja\"]".into()),
            updated_at_ms: 1,
        };
        item.model_inputs.insert(
            "vertex:transcription".into(),
            [
                ("enabled".into(), "true".into()),
                ("maxOutputTokens".into(), "4096.".into()),
                ("thinkingBudget".into(), "-".into()),
                ("inputPrice".into(), "1.".into()),
            ]
            .into(),
        );
        item.validate().unwrap();
        let mut private = item.clone();
        private
            .model_inputs
            .get_mut("vertex:transcription")
            .unwrap()
            .insert("credentialId".into(), "private".into());
        assert!(private.validate().is_err());
        let mut oversized = item.clone();
        oversized
            .model_inputs
            .get_mut("vertex:transcription")
            .unwrap()
            .insert("modelId".into(), "x".repeat(4097));
        assert!(oversized.validate().is_err());
        p.update(|value| {
            value.ai_continuations.insert(item.id.clone(), item);
            Ok(())
        })
        .unwrap();
        let reopened = super::super::PreferencesStore::open(path).unwrap();
        let serialized =
            serde_json::to_value(&reopened.read().unwrap().ai_continuations["resume"]).unwrap();
        assert_eq!(serialized["end"], "00:36:34.474");
        assert_eq!(
            serialized["modelInputs"]["vertex:transcription"]["maxOutputTokens"],
            "4096."
        );
        assert!(serialized["models"].as_object().unwrap().is_empty());
        assert_eq!(
            serialized["sourceMediaSignature"],
            "[\"C:/video.mkv\",null,\"en\",\"ja\"]"
        );
        let mut legacy = serialized.clone();
        legacy
            .as_object_mut()
            .unwrap()
            .remove("sourceMediaSignature");
        legacy.as_object_mut().unwrap().remove("modelInputs");
        assert!(
            serde_json::from_value::<AiContinuation>(legacy.clone())
                .unwrap()
                .model_inputs
                .is_empty()
        );
        assert!(
            serde_json::from_value::<AiContinuation>(legacy)
                .unwrap()
                .source_media_signature
                .is_none()
        );
        assert!(serialized.get("approved").is_none());
        assert!(serialized.get("credentialId").is_none());
    }
}
