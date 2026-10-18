// SPDX-License-Identifier: GPL-3.0-or-later
use crate::application::*;
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use surtitle_ai::{
    CredentialMetadata, CredentialVault, ExecutionConfig, PriceSnapshot, ThinkingConfig,
    VertexDiscovery,
};
use surtitle_core::{AiModelPreference, AiPricePreference, AppSettings};

pub(crate) fn execution_for(
    settings: &AppSettings,
    purpose: &str,
    selected: Option<AiModelPreference>,
) -> Result<ExecutionConfig> {
    let model = selected
        .or_else(|| settings.ai_models.get(purpose).cloned())
        .context("Select a Gemini model in the AI settings or this job")?;
    validate_model(&model, &settings.vertex_location, false)?;
    let mut execution = to_execution(&model, &settings.vertex_location);
    if purpose == "transcription" && model.transcription_mode == "transcribe" {
        // Word timestamps are only supported by Transcribe's synchronous API.
        execution.response_mode = surtitle_ai::ResponseMode::GenerateContent;
    }
    Ok(execution)
}

pub(crate) fn to_execution(model: &AiModelPreference, location: &str) -> ExecutionConfig {
    ExecutionConfig {
        model_id: model.model_id.trim().to_owned(),
        response_mode: surtitle_ai::ResponseMode::StreamGenerateContent,
        location: location.to_owned(),
        max_output_tokens: model.max_output_tokens,
        thinking: match (&model.thinking_level, model.thinking_budget) {
            (Some(level), _) => ThinkingConfig::Level {
                level: level.clone(),
            },
            (_, Some(tokens)) => ThinkingConfig::Budget { tokens },
            _ => ThinkingConfig::Omit,
        },
        price: model.price.as_ref().map(|price| PriceSnapshot {
            id: price.id.clone(),
            source: price.source.clone(),
            observed_at_ms: price.observed_at_ms,
            input_microusd_per_million: price.input_microusd_per_million,
            output_microusd_per_million: price.output_microusd_per_million,
        }),
    }
}

pub(crate) fn preference_for(execution: &ExecutionConfig, transcribe: bool) -> AiModelPreference {
    AiModelPreference {
        model_id: execution.model_id.clone(),
        transcription_mode: if transcribe {
            "transcribe"
        } else {
            "subtitles"
        }
        .into(),
        max_output_tokens: execution.max_output_tokens,
        thinking_level: match &execution.thinking {
            ThinkingConfig::Level { level } => Some(level.clone()),
            _ => None,
        },
        thinking_budget: match execution.thinking {
            ThinkingConfig::Budget { tokens } => Some(tokens),
            _ => None,
        },
        price: execution.price.as_ref().map(|p| AiPricePreference {
            id: p.id.clone(),
            source: p.source.clone(),
            observed_at_ms: p.observed_at_ms,
            input_microusd_per_million: p.input_microusd_per_million,
            output_microusd_per_million: p.output_microusd_per_million,
        }),
    }
}

fn validate_model(model: &AiModelPreference, location: &str, allow_empty: bool) -> Result<()> {
    ensure!(
        ["transcribe", "subtitles"].contains(&model.transcription_mode.as_str()),
        "Choose a transcription API mode"
    );
    ensure!(
        model.thinking_level.is_none() || model.thinking_budget.is_none(),
        "Choose either thinking level or thinking budget"
    );
    if allow_empty && model.model_id.trim().is_empty() {
        return Ok(());
    }
    to_execution(model, location).validate()?;
    Ok(())
}

pub(crate) fn validate_settings(settings: &AppSettings) -> Result<()> {
    ensure!(
        ["system", "reduce"].contains(&settings.motion_preference.as_str()),
        "Invalid animation preference"
    );
    ensure!(
        ["review", "preview"].contains(&settings.caption_gap_mode.as_str()),
        "Invalid caption gap mode"
    );
    ensure!(
        !settings.vertex_location.is_empty()
            && settings.vertex_location.len() <= 63
            && settings
                .vertex_location
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'),
        "Invalid Vertex location"
    );
    ensure!(settings.ai_models.len() <= 4, "Invalid AI preferences");
    for (purpose, model) in &settings.ai_models {
        ensure!(
            ["transcription", "vocabulary", "explanation", "translation"]
                .contains(&purpose.as_str()),
            "Invalid AI purpose"
        );
        validate_model(model, &settings.vertex_location, true)?;
    }
    Ok(())
}

pub fn update_appearance(
    state: AppState,
    locale: Option<String>,
    theme: Option<String>,
) -> std::result::Result<(), String> {
    (|| -> Result<()> {
        let _transition = state.preferences.settings_transition()?;
        ensure!(
            locale.as_deref().is_none_or(|v| ["ja", "en"].contains(&v)),
            "Invalid interface language"
        );
        ensure!(
            theme
                .as_deref()
                .is_none_or(|v| ["dark", "light", "system"].contains(&v)),
            "Invalid theme"
        );
        state.preferences.update(|next| {
            if let Some(locale) = locale {
                next.settings.locale = locale;
            }
            if let Some(theme) = theme {
                next.settings.theme = theme;
            }
            Ok(())
        })
    })()
    .map_err(err)
}

#[cfg(any(test, feature = "e2e-test"))]
pub(crate) fn fixture_execution() -> ExecutionConfig {
    ExecutionConfig {
        model_id: "gemini-offline-fixture".into(),
        response_mode: surtitle_ai::ResponseMode::GenerateContent,
        location: "global".into(),
        max_output_tokens: 12288,
        thinking: ThinkingConfig::Omit,
        price: Some(PriceSnapshot {
            id: "offline-fixture".into(),
            source: "offline".into(),
            observed_at_ms: 1_788_825_600_000,
            input_microusd_per_million: 2_000_000,
            output_microusd_per_million: 12_000_000,
        }),
    }
}

pub async fn list_vertex_models(
    state: AppState,
    location: Option<String>,
) -> std::result::Result<Vec<surtitle_ai::DiscoveredModel>, String> {
    async {
        let (credential, location) = {
            let prefs = state.preferences.read()?;
            (
                prefs
                    .credential_id
                    .clone()
                    .context("Import a service-account key in Settings")?,
                location.unwrap_or_else(|| prefs.settings.vertex_location.clone()),
            )
        };
        let discovery =
            VertexDiscovery::new(CredentialVault::new(state.root.join("credentials"))?)?;
        Ok(discovery.list_models(&credential, &location).await?)
    }
    .await
    .map_err(err)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceLookup {
    price: Option<AiPricePreference>,
    candidates: Vec<surtitle_ai::PriceCandidate>,
    observed_at_ms: i64,
    complete: bool,
}

pub async fn lookup_vertex_price(
    state: AppState,
    model_id: String,
    location: Option<String>,
) -> std::result::Result<PriceLookup, String> {
    async {
        let (credential, location) = {
            let prefs = state.preferences.read()?;
            (
                prefs
                    .credential_id
                    .clone()
                    .context("Import a service-account key in Settings")?,
                location.unwrap_or_else(|| prefs.settings.vertex_location.clone()),
            )
        };
        let lookup = VertexDiscovery::new(CredentialVault::new(state.root.join("credentials"))?)?
            .pricing(&credential, &model_id, &location)
            .await?;
        Ok(PriceLookup {
            price: lookup.price.map(|p| AiPricePreference {
                id: p.id,
                source: p.source,
                observed_at_ms: p.observed_at_ms,
                input_microusd_per_million: p.input_microusd_per_million,
                output_microusd_per_million: p.output_microusd_per_million,
            }),
            candidates: lookup.candidates,
            observed_at_ms: lookup.observed_at_ms,
            complete: lookup.complete,
        })
    }
    .await
    .map_err(err)
}

use super::playback::configure_sentence_pause;
type IpcResult<T> = std::result::Result<T, String>;

pub(super) fn reconcile_credential_project(
    preferences: &PreferencesStore,
    root: &std::path::Path,
) -> Result<()> {
    let credential_id = preferences.read()?.credential_id.clone();
    let Some(credential_id) = credential_id else {
        return Ok(());
    };
    let vault = CredentialVault::new(root.join("credentials"))?;
    // An unavailable key must not prevent offline learning or a replacement import.
    // Only validated metadata can repair an old manually entered project ID.
    if let Ok(metadata) = vault.metadata(&credential_id) {
        apply_credential_metadata(preferences, &metadata)?;
    }
    Ok(())
}

fn apply_credential_metadata(
    preferences: &PreferencesStore,
    metadata: &CredentialMetadata,
) -> Result<()> {
    preferences.update_if(|p| {
        // A newer import wins if identity changed while the old key was being read.
        if p.credential_id.as_deref() != Some(metadata.id.as_str()) {
            return Ok(false);
        }
        if p.settings.vertex_project == metadata.project_id && p.settings.credential_configured {
            return Ok(false);
        }
        p.settings.vertex_project.clone_from(&metadata.project_id);
        p.settings.credential_configured = true;
        Ok(true)
    })
}

fn budget_limits(settings: &AppSettings) -> Result<surtitle_ai::BudgetLimits> {
    // Missing new fields denote the old single-cap request format.
    let daily = settings.daily_budget_usd;
    let monthly = settings.monthly_budget_usd.unwrap_or(daily);
    let per_job = settings.per_job_budget_usd.unwrap_or(daily);
    ensure!(
        [daily, monthly, per_job]
            .into_iter()
            .all(|amount| amount.is_finite() && (0.0..=1000.).contains(&amount)),
        "invalid budget"
    );
    let microusd = |amount: f64| (amount * 1_000_000.).floor() as u64;
    Ok(surtitle_ai::BudgetLimits {
        per_job_microusd: microusd(per_job),
        daily_microusd: microusd(daily),
        monthly_microusd: microusd(monthly),
    })
}

fn validate_application_settings(settings: &AppSettings) -> Result<()> {
    ensure!(
        ["dark", "light", "system"].contains(&settings.theme.as_str())
            && ["ja", "en"].contains(&settings.locale.as_str()),
        "invalid settings"
    );
    ensure!(
        (0.7..=0.97).contains(&settings.retention),
        "invalid retention"
    );
    ensure!(
        settings.replay_context_ms <= 1000,
        "Playback context must be between 0 and 1000 ms"
    );
    ensure!(
        !settings.learning_language.trim().is_empty()
            && !settings.explanation_language.trim().is_empty(),
        "language is required"
    );
    crate::application::models::validate_settings(settings)?;
    Ok(())
}

fn save_application_settings(state: &AppState, mut settings: AppSettings) -> Result<()> {
    // Monetary limits live only in charges.sqlite. Wire fields are filled
    // from the ledger by Services::settings, never persisted as a second cap.
    settings.daily_budget_usd = 0.;
    settings.monthly_budget_usd = None;
    settings.per_job_budget_usd = None;
    state.preferences.update(|preferences| {
        // Credential identity is owned by JSON import, never by a stale form.
        settings.vertex_project = preferences.settings.vertex_project.clone();
        settings.credential_configured = preferences.credential_id.is_some();
        preferences.settings = settings;
        Ok(())
    })?;
    Ok(())
}

fn refresh_playback_settings(state: &AppState) -> Result<()> {
    let mut playback = state.playback.operation()?;
    let media_id = playback.current_media();
    if let Some(media_id) = media_id {
        let segments = lock(&state.db)?.list_segments(&media_id)?;
        configure_sentence_pause(&mut playback, &segments, state.settings()?.sentence_pause)?;
    }
    Ok(())
}

/// Compatibility entrypoint for older clients. New autosave uses separate
/// budget-only and preference-only patches, each with one durable authority.
pub fn update_settings(state: AppState, settings: AppSettings) -> IpcResult<()> {
    (|| {
        let _transition = state.preferences.settings_transition()?;
        validate_application_settings(&settings)?;
        let limits = budget_limits(&settings)?;
        save_application_settings(&state, settings)?;
        state.ai.set_budget(limits)?;
        refresh_playback_settings(&state)
    })()
    .map_err(err)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsState {
    settings: AppSettings,
    revision: String,
}

fn settings_state(state: &AppState) -> Result<SettingsState> {
    let settings = state.settings()?;
    let revision = surtitle_ai::sha256_bytes(&serde_json::to_vec(&settings)?);
    Ok(SettingsState { settings, revision })
}

pub fn get_settings_state(state: AppState) -> IpcResult<SettingsState> {
    (|| {
        let _transition = state.preferences.settings_transition()?;
        settings_state(&state)
    })()
    .map_err(err)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BudgetPatch {
    daily_budget_usd: f64,
    monthly_budget_usd: f64,
    per_job_budget_usd: f64,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsPatch {
    theme: Option<String>,
    motion_preference: Option<String>,
    caption_gap_mode: Option<String>,
    locale: Option<String>,
    learning_language: Option<String>,
    explanation_language: Option<String>,
    vertex_location: Option<String>,
    retention: Option<f32>,
    sentence_pause: Option<bool>,
    replay_context_ms: Option<u16>,
    proficiency: Option<String>,
    ai_models: Option<std::collections::BTreeMap<String, AiModelPreference>>,
    budgets: Option<BudgetPatch>,
}

impl SettingsPatch {
    fn has_preferences(&self) -> bool {
        self.theme.is_some()
            || self.motion_preference.is_some()
            || self.caption_gap_mode.is_some()
            || self.locale.is_some()
            || self.learning_language.is_some()
            || self.explanation_language.is_some()
            || self.vertex_location.is_some()
            || self.retention.is_some()
            || self.sentence_pause.is_some()
            || self.replay_context_ms.is_some()
            || self.proficiency.is_some()
            || self.ai_models.is_some()
    }
    fn apply(self, settings: &mut AppSettings) {
        let location_changed = self
            .vertex_location
            .as_ref()
            .is_some_and(|value| value != &settings.vertex_location);
        macro_rules! assign {
            ($($name:ident),+ $(,)?) => { $(if let Some(value) = self.$name { settings.$name = value; })+ };
        }
        assign!(
            theme,
            motion_preference,
            caption_gap_mode,
            locale,
            learning_language,
            explanation_language,
            vertex_location,
            retention,
            sentence_pause,
            replay_context_ms,
            proficiency
        );
        if let Some(models) = self.ai_models {
            settings.ai_models.extend(models);
        }
        if location_changed {
            for model in settings.ai_models.values_mut() {
                model.price = None;
            }
        }
    }
}

pub fn update_settings_patch(
    state: AppState,
    expected_revision: String,
    patch: SettingsPatch,
) -> IpcResult<SettingsState> {
    (|| {
        let _transition = state.preferences.settings_transition()?;
        let current = settings_state(&state)?;
        ensure!(
            current.revision == expected_revision,
            "Settings changed; reload before saving"
        );
        ensure!(
            patch.budgets.is_none() || !patch.has_preferences(),
            "Save budgets separately from other settings"
        );
        if let Some(budgets) = patch.budgets {
            let mut settings = current.settings;
            settings.daily_budget_usd = budgets.daily_budget_usd;
            settings.monthly_budget_usd = Some(budgets.monthly_budget_usd);
            settings.per_job_budget_usd = Some(budgets.per_job_budget_usd);
            state.ai.set_budget(budget_limits(&settings)?)?;
        } else if patch.has_preferences() {
            let playback_changed = patch
                .sentence_pause
                .is_some_and(|value| value != current.settings.sentence_pause);
            let mut settings = current.settings;
            patch.apply(&mut settings);
            validate_application_settings(&settings)?;
            save_application_settings(&state, settings)?;
            if playback_changed {
                refresh_playback_settings(&state)?;
            }
        }
        settings_state(&state)
    })()
    .map_err(err)
}

pub async fn import_credential(state: AppState) -> std::result::Result<bool, String> {
    let file = rfd::AsyncFileDialog::new()
        .add_filter("Service account JSON", &["json"])
        .pick_file()
        .await;
    import_credential_file(&state, file.as_ref().map(|file| file.path())).map_err(err)
}

fn import_credential_file(state: &AppState, file: Option<&std::path::Path>) -> Result<bool> {
    let Some(file) = file else {
        return Ok(false);
    };
    let _transition = state.preferences.settings_transition()?;
    let vault = CredentialVault::new(state.root.join("credentials"))?;
    let credential = vault.import_service_account(file)?;
    state.preferences.update(|p| {
        p.settings.vertex_project = credential.project_id;
        p.credential_id = Some(credential.id);
        p.settings.credential_configured = true;
        Ok(())
    })?;
    Ok(true)
}

#[cfg(test)]
mod settings_tests {
    use super::*;

    #[test]
    fn selected_minimal_thinking_survives_native_preference_conversion() {
        let mut preference = preference_for(&fixture_execution(), false);
        preference.model_id = "gemini-3.1-flash-lite".into();
        preference.thinking_level = Some("MINIMAL".into());
        let serialized = serde_json::to_value(&preference).unwrap();
        assert_eq!(serialized["thinkingLevel"], "MINIMAL");
        let selected = serde_json::from_value(serialized).unwrap();
        let execution =
            execution_for(&AppSettings::default(), "transcription", Some(selected)).unwrap();
        assert_eq!(
            execution.thinking,
            ThinkingConfig::Level {
                level: "MINIMAL".into()
            }
        );
        assert_eq!(
            preference_for(&execution, false).thinking_level.as_deref(),
            Some("MINIMAL")
        );
    }

    #[test]
    fn new_ai_jobs_stream_except_synchronous_transcribe_without_switching_models() {
        for purpose in ["vocabulary", "explanation", "translation", "transcription"] {
            for transcribe in [false, true] {
                let mut settings = AppSettings::default();
                let preference = preference_for(&fixture_execution(), transcribe);
                settings
                    .ai_models
                    .insert(purpose.into(), preference.clone());
                let expected = if purpose == "transcription" && transcribe {
                    surtitle_ai::ResponseMode::GenerateContent
                } else {
                    surtitle_ai::ResponseMode::StreamGenerateContent
                };
                let stored = execution_for(&settings, purpose, None).unwrap();
                assert_eq!(stored.response_mode, expected, "{purpose} / {transcribe}");
                assert_eq!(stored.model_id, preference.model_id);

                let mut selected = preference.clone();
                selected.model_id = "gemini-selected-fixture".into();
                let overridden = execution_for(&settings, purpose, Some(selected.clone())).unwrap();
                assert_eq!(
                    overridden.response_mode, expected,
                    "{purpose} / {transcribe}"
                );
                assert_eq!(overridden.model_id, selected.model_id);
            }
        }
    }

    #[test]
    fn motion_preference_is_saved_reopened_and_invalid_values_are_rejected() {
        let root = tempfile::tempdir().unwrap();
        let state = Services::open(root.path().to_path_buf()).unwrap();
        assert_eq!(state.settings().unwrap().motion_preference, "system");
        let mut settings = state.settings().unwrap();
        settings.motion_preference = "reduce".into();
        update_settings(state.clone(), settings).unwrap();
        drop(state);
        let reopened = Services::open(root.path().to_path_buf()).unwrap();
        assert_eq!(reopened.settings().unwrap().motion_preference, "reduce");
        for invalid in ["", "always", "full"] {
            let mut settings = reopened.settings().unwrap();
            settings.motion_preference = invalid.into();
            assert!(update_settings(reopened.clone(), settings).is_err());
            assert_eq!(reopened.settings().unwrap().motion_preference, "reduce");
        }
        let mut settings = reopened.settings().unwrap();
        settings.motion_preference = "system".into();
        update_settings(reopened.clone(), settings).unwrap();
        assert_eq!(reopened.settings().unwrap().motion_preference, "system");
    }

    #[test]
    fn cancelled_or_failed_credential_import_never_reports_a_saved_key() {
        let root = tempfile::tempdir().unwrap();
        let state = Services::open(root.path().to_path_buf()).unwrap();
        assert!(!import_credential_file(&state, None).unwrap());
        let invalid = root.path().join("invalid-key.json");
        std::fs::write(&invalid, b"{}").unwrap();
        assert!(import_credential_file(&state, Some(&invalid)).is_err());
        assert!(!state.settings().unwrap().credential_configured);
        assert!(!root.path().join("preferences.json").exists());
    }

    fn assert_displayed_budget(state: &Services, daily: f64, monthly: f64, per_job: f64) {
        let settings = state.settings().unwrap();
        assert_eq!(settings.daily_budget_usd, daily);
        assert_eq!(settings.monthly_budget_usd, Some(monthly));
        assert_eq!(settings.per_job_budget_usd, Some(per_job));
    }

    #[test]
    fn legacy_preferences_do_not_replace_independent_ledger_limits() {
        let root = tempfile::tempdir().unwrap();
        let state = Services::open(root.path().to_path_buf()).unwrap();
        state
            .preferences
            .update(|p| {
                p.settings.daily_budget_usd = 99.;
                p.settings.monthly_budget_usd = None;
                p.settings.per_job_budget_usd = None;
                Ok(())
            })
            .unwrap();
        state
            .ai
            .set_budget(surtitle_ai::BudgetLimits {
                daily_microusd: 3_000_000,
                monthly_microusd: 20_000_000,
                per_job_microusd: 1_000_000,
            })
            .unwrap();
        drop(state);
        let reopened = Services::open(root.path().to_path_buf()).unwrap();
        assert_displayed_budget(&reopened, 3., 20., 1.);
        let mut settings = reopened.settings().unwrap();
        settings.monthly_budget_usd = Some(30.);
        settings.per_job_budget_usd = Some(0.);
        update_settings(reopened.clone(), settings).unwrap();
        assert_displayed_budget(&reopened, 3., 30., 0.);
        assert_eq!(
            reopened.ai.budget().unwrap(),
            surtitle_ai::BudgetLimits {
                daily_microusd: 3_000_000,
                monthly_microusd: 30_000_000,
                per_job_microusd: 0,
            }
        );
    }

    #[test]
    fn legacy_save_sets_all_caps_and_every_explicit_cap_is_validated() {
        let root = tempfile::tempdir().unwrap();
        let state = Services::open(root.path().to_path_buf()).unwrap();
        let mut wire = serde_json::to_value(state.settings().unwrap()).unwrap();
        wire.as_object_mut().unwrap().remove("monthlyBudgetUsd");
        wire.as_object_mut().unwrap().remove("perJobBudgetUsd");
        wire["dailyBudgetUsd"] = serde_json::json!(7.);
        update_settings(state.clone(), serde_json::from_value(wire).unwrap()).unwrap();
        assert_displayed_budget(&state, 7., 7., 7.);
        for field in ["daily", "monthly", "per_job"] {
            for invalid in [-0.01, 1000.01, f64::INFINITY, f64::NAN] {
                let mut settings = state.settings().unwrap();
                match field {
                    "daily" => settings.daily_budget_usd = invalid,
                    "monthly" => settings.monthly_budget_usd = Some(invalid),
                    _ => settings.per_job_budget_usd = Some(invalid),
                }
                assert!(update_settings(state.clone(), settings).is_err());
                assert_displayed_budget(&state, 7., 7., 7.);
            }
        }
    }

    #[test]
    fn old_form_cannot_replace_a_newly_imported_credential_identity() {
        let root = tempfile::tempdir().unwrap();
        let state = Services::open(root.path().to_path_buf()).unwrap();
        let mut old_form = state.settings().unwrap();
        old_form.vertex_project = "old-or-manually-entered".into();
        old_form.credential_configured = false;
        state
            .preferences
            .update(|p| {
                p.credential_id = Some("new-key".into());
                p.settings.vertex_project = "imported-project".into();
                p.settings.credential_configured = true;
                Ok(())
            })
            .unwrap();
        update_settings(state.clone(), old_form).unwrap();
        let settings = state.settings().unwrap();
        assert_eq!(settings.vertex_project, "imported-project");
        assert!(settings.credential_configured);
        assert_eq!(
            state.preferences.read().unwrap().credential_id.as_deref(),
            Some("new-key")
        );
    }

    #[test]
    fn credential_project_repair_requires_the_current_validated_identity() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("preferences.json");
        let preferences = PreferencesStore::open(path.clone()).unwrap();
        preferences
            .update(|p| {
                p.credential_id = Some("current-key".into());
                p.settings.vertex_project = "incorrect-project".into();
                Ok(())
            })
            .unwrap();
        // Missing or unreadable keys leave offline settings available and unchanged.
        reconcile_credential_project(&preferences, root.path()).unwrap();
        assert_eq!(
            preferences.read().unwrap().settings.vertex_project,
            "incorrect-project"
        );
        let mut metadata = CredentialMetadata {
            id: "outdated-key".into(),
            project_id: "json-project".into(),
            client_email: "fixture@json-project.iam.gserviceaccount.com".into(),
            imported_at_ms: 0,
        };
        apply_credential_metadata(&preferences, &metadata).unwrap();
        assert_eq!(
            preferences.read().unwrap().settings.vertex_project,
            "incorrect-project"
        );
        metadata.id = "current-key".into();
        apply_credential_metadata(&preferences, &metadata).unwrap();
        let reopened = PreferencesStore::open(path).unwrap();
        assert_eq!(
            reopened.read().unwrap().settings.vertex_project,
            "json-project"
        );
        assert!(reopened.read().unwrap().settings.credential_configured);
    }
    #[test]
    fn failed_preferences_save_cannot_raise_the_ledger_or_displayed_budget() {
        let root = tempfile::tempdir().unwrap();
        let state = Services::open(root.path().to_path_buf()).unwrap();
        let previous = state.ai.budget().unwrap();
        std::fs::create_dir(root.path().join("preferences.json")).unwrap();
        let mut settings = state.settings().unwrap();
        settings.daily_budget_usd = 10.;
        settings.monthly_budget_usd = Some(100.);
        settings.per_job_budget_usd = Some(1.);
        assert!(update_settings(state.clone(), settings).is_err());
        assert_eq!(state.ai.budget().unwrap(), previous);
        assert_displayed_budget(&state, 0., 0., 0.);
        assert_eq!(
            state.preferences.read().unwrap().settings.daily_budget_usd,
            0.
        );
    }
    #[test]
    fn failed_ledger_update_never_advertises_the_uncommitted_budget_after_reopen() {
        let root = tempfile::tempdir().unwrap();
        let state = Services::open(root.path().to_path_buf()).unwrap();
        let connection = rusqlite::Connection::open(root.path().join("charges.sqlite")).unwrap();
        connection.execute_batch("CREATE TRIGGER reject_budget BEFORE UPDATE ON ai_settings BEGIN SELECT RAISE(ABORT, 'fixture rejects budget'); END;").unwrap();
        let mut settings = state.settings().unwrap();
        settings.daily_budget_usd = 10.;
        settings.monthly_budget_usd = Some(100.);
        settings.per_job_budget_usd = Some(1.);
        assert!(update_settings(state.clone(), settings).is_err());
        assert_eq!(
            state.preferences.read().unwrap().settings.daily_budget_usd,
            0.
        );
        assert_displayed_budget(&state, 0., 0., 0.);
        drop(state);
        let reopened = Services::open(root.path().to_path_buf()).unwrap();
        assert_displayed_budget(&reopened, 0., 0., 0.);
        assert_eq!(
            reopened.ai.budget().unwrap(),
            surtitle_ai::BudgetLimits::default()
        );
        connection
            .execute_batch("DROP TRIGGER reject_budget;")
            .unwrap();
        let mut settings = reopened.settings().unwrap();
        settings.daily_budget_usd = 2.;
        settings.monthly_budget_usd = Some(20.);
        settings.per_job_budget_usd = Some(0.5);
        update_settings(reopened.clone(), settings).unwrap();
        assert_displayed_budget(&reopened, 2., 20., 0.5);
        assert_eq!(reopened.ai.budget().unwrap().daily_microusd, 2_000_000);
    }
    fn patch(json: serde_json::Value) -> SettingsPatch {
        serde_json::from_value(json).unwrap()
    }

    #[test]
    fn caption_gap_mode_patch_persists_without_replacing_other_preferences() {
        let root = tempfile::tempdir().unwrap();
        let state = Services::open(root.path().to_path_buf()).unwrap();
        let initial = get_settings_state(state.clone()).unwrap();
        assert_eq!(initial.settings.caption_gap_mode, "review");
        let saved = update_settings_patch(
            state.clone(),
            initial.revision.clone(),
            patch(serde_json::json!({"captionGapMode":"preview"})),
        )
        .unwrap();
        assert_eq!(saved.settings.caption_gap_mode, "preview");
        assert_eq!(saved.settings.theme, initial.settings.theme);
        assert_eq!(
            saved.settings.replay_context_ms,
            initial.settings.replay_context_ms
        );
        assert!(
            update_settings_patch(
                state.clone(),
                initial.revision,
                patch(serde_json::json!({"captionGapMode":"review"}))
            )
            .is_err()
        );
        for invalid in ["", "current", "Preview"] {
            assert!(
                update_settings_patch(
                    state.clone(),
                    saved.revision.clone(),
                    patch(serde_json::json!({"captionGapMode":invalid}))
                )
                .is_err()
            );
            let unchanged = get_settings_state(state.clone()).unwrap();
            assert_eq!(unchanged.revision, saved.revision);
            assert_eq!(unchanged.settings.caption_gap_mode, "preview");
        }
        drop(state);
        let reopened = Services::open(root.path().to_path_buf()).unwrap();
        assert_eq!(reopened.settings().unwrap().caption_gap_mode, "preview");
        let current = get_settings_state(reopened.clone()).unwrap();
        let reviewed = update_settings_patch(
            reopened,
            current.revision,
            patch(serde_json::json!({"captionGapMode":"review"})),
        )
        .unwrap();
        assert_eq!(reviewed.settings.caption_gap_mode, "review");
    }

    #[test]
    fn autosave_patch_has_one_authority_and_cannot_apply_a_stale_revision() {
        let root = tempfile::tempdir().unwrap();
        let state = Services::open(root.path().to_path_buf()).unwrap();
        let initial = get_settings_state(state.clone()).unwrap();
        let saved = update_settings_patch(
            state.clone(),
            initial.revision.clone(),
            patch(serde_json::json!({"theme":"light"})),
        )
        .unwrap();
        assert_eq!(saved.settings.theme, "light");
        assert!(
            update_settings_patch(
                state.clone(),
                initial.revision,
                patch(serde_json::json!({"locale":"en"}))
            )
            .is_err()
        );
        assert!(
            update_settings_patch(
                state.clone(),
                saved.revision.clone(),
                patch(serde_json::json!({"retention":0.1}))
            )
            .is_err()
        );
        let next = update_settings_patch(
            state.clone(),
            saved.revision,
            patch(serde_json::json!({"locale":"en"})),
        )
        .unwrap();
        assert_eq!(next.settings.locale, "en");
        assert_eq!(next.settings.theme, "light");
        for field in [
            "credentialConfigured",
            "credentialId",
            "vertexProject",
            "privateKey",
        ] {
            assert!(
                serde_json::from_value::<SettingsPatch>(serde_json::json!({field:"forbidden"}))
                    .is_err()
            );
        }
    }

    #[test]
    fn budgets_are_atomic_separate_and_never_written_to_preferences() {
        let root = tempfile::tempdir().unwrap();
        let state = Services::open(root.path().to_path_buf()).unwrap();
        let initial = get_settings_state(state.clone()).unwrap();
        let budgets =
            serde_json::json!({"dailyBudgetUsd":1.,"monthlyBudgetUsd":5.,"perJobBudgetUsd":0.5});
        assert!(
            update_settings_patch(
                state.clone(),
                initial.revision.clone(),
                patch(serde_json::json!({"budgets":budgets,"theme":"light"}))
            )
            .is_err()
        );
        let saved = update_settings_patch(
            state.clone(),
            initial.revision,
            patch(serde_json::json!({"budgets":budgets})),
        )
        .unwrap();
        assert_displayed_budget(&state, 1., 5., 0.5);
        assert!(
            !root.path().join("preferences.json").exists(),
            "budget-only saves must not touch JSON"
        );
        update_settings_patch(
            state.clone(),
            saved.revision,
            patch(serde_json::json!({"theme":"light"})),
        )
        .unwrap();
        let disk: serde_json::Value = serde_json::from_reader(
            std::fs::File::open(root.path().join("preferences.json")).unwrap(),
        )
        .unwrap();
        for field in ["dailyBudgetUsd", "monthlyBudgetUsd", "perJobBudgetUsd"] {
            assert!(disk["settings"].get(field).is_none());
        }
        drop(state);
        let reopened = Services::open(root.path().to_path_buf()).unwrap();
        assert_displayed_budget(&reopened, 1., 5., 0.5);
    }

    #[test]
    fn failed_budget_patch_leaves_both_readback_and_revision_unchanged() {
        let root = tempfile::tempdir().unwrap();
        let state = Services::open(root.path().to_path_buf()).unwrap();
        let initial = get_settings_state(state.clone()).unwrap();
        let connection = rusqlite::Connection::open(root.path().join("charges.sqlite")).unwrap();
        connection.execute_batch("CREATE TRIGGER reject_budget BEFORE UPDATE ON ai_settings BEGIN SELECT RAISE(ABORT,'fixture failure'); END;").unwrap();
        assert!(update_settings_patch(state.clone(),initial.revision.clone(),patch(serde_json::json!({"budgets":{"dailyBudgetUsd":3.,"monthlyBudgetUsd":8.,"perJobBudgetUsd":1.}}))).is_err());
        assert_eq!(
            get_settings_state(state.clone()).unwrap().revision,
            initial.revision
        );
        assert!(!root.path().join("preferences.json").exists());
    }

    #[test]
    fn location_patch_invalidates_all_model_prices_without_changing_credential_identity() {
        let root = tempfile::tempdir().unwrap();
        let state = Services::open(root.path().to_path_buf()).unwrap();
        let mut model = preference_for(&fixture_execution(), false);
        model.price = Some(AiPricePreference {
            id: "price".into(),
            source: "user".into(),
            observed_at_ms: 1,
            input_microusd_per_million: 1,
            output_microusd_per_million: 1,
        });
        state
            .preferences
            .update(|p| {
                p.settings.ai_models.insert("translation".into(), model);
                Ok(())
            })
            .unwrap();
        let before = get_settings_state(state.clone()).unwrap();
        let next = update_settings_patch(
            state.clone(),
            before.revision,
            patch(serde_json::json!({"vertexLocation":"us-central1"})),
        )
        .unwrap();
        assert!(next.settings.ai_models["translation"].price.is_none());
        assert!(!next.settings.credential_configured);
    }
}
