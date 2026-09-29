// SPDX-License-Identifier: GPL-3.0-or-later
use crate::application::*;
use anyhow::{Context, Result, ensure};
use serde::Serialize;
use surtitle_ai::{
    CredentialVault, ExecutionConfig, PriceSnapshot, ThinkingConfig, VertexDiscovery,
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
    Ok(to_execution(&model, &settings.vertex_location))
}

pub(crate) fn to_execution(model: &AiModelPreference, location: &str) -> ExecutionConfig {
    ExecutionConfig {
        model_id: model.model_id.trim().to_owned(),
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
pub fn update_settings(state: AppState, settings: AppSettings) -> IpcResult<()> {
    (|| {
        let _transition = state.preferences.settings_transition()?;
        ensure!(
            ["dark", "light", "system"].contains(&settings.theme.as_str())
                && ["ja", "en"].contains(&settings.locale.as_str()),
            "invalid settings"
        );
        ensure!(
            settings.daily_budget_usd.is_finite()
                && (0.0..=1000.).contains(&settings.daily_budget_usd),
            "invalid budget"
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
            !settings.learning_language.is_empty() && !settings.explanation_language.is_empty(),
            "language is required"
        );
        crate::application::models::validate_settings(&settings)?;
        ensure!(
            ["nightly", "stable"].contains(&settings.yt_dlp_channel.as_str()),
            "invalid yt-dlp channel"
        );
        let cap = (settings.daily_budget_usd * 1_000_000.).floor() as u64;
        // Preferences are saved before changing the independently durable ledger.
        // The ledger remains the authority for every displayed/enforced budget.
        state.preferences.update(|preferences| {
            preferences.settings = settings;
            Ok(())
        })?;
        state.ai.set_budget(surtitle_ai::BudgetLimits {
            per_job_microusd: cap,
            daily_microusd: cap,
            monthly_microusd: cap,
        })?;
        let mut playback = state.playback.operation()?;
        let media_id = playback.current_media();
        if let Some(media_id) = media_id {
            let segments = lock(&state.db)?.list_segments(&media_id)?;
            configure_sentence_pause(&mut playback, &segments, state.settings()?.sentence_pause)?;
        }
        Ok(())
    })()
    .map_err(err)
}

pub async fn import_credential(state: AppState) -> std::result::Result<(), String> {
    let Some(file) = rfd::AsyncFileDialog::new()
        .add_filter("Service account JSON", &["json"])
        .pick_file()
        .await
    else {
        return Ok(());
    };
    (|| {
        let vault = CredentialVault::new(state.root.join("credentials"))?;
        let credential = vault.import_service_account(file.path())?;
        state.preferences.update(|p| {
            p.settings.vertex_project = credential.project_id;
            p.credential_id = Some(credential.id);
            p.settings.credential_configured = true;
            Ok(())
        })
    })()
    .map_err(err)
}

#[cfg(test)]
mod settings_tests {
    use super::*;
    #[test]
    fn failed_preferences_save_cannot_raise_the_ledger_or_displayed_budget() {
        let root = tempfile::tempdir().unwrap();
        let state = Services::open(root.path().to_path_buf()).unwrap();
        let previous = state.ai.budget().unwrap();
        std::fs::create_dir(root.path().join("preferences.json")).unwrap();
        let mut settings = state.settings().unwrap();
        settings.daily_budget_usd = 10.;
        assert!(update_settings(state.clone(), settings).is_err());
        assert_eq!(state.ai.budget().unwrap(), previous);
        assert_eq!(state.settings().unwrap().daily_budget_usd, 0.);
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
        assert!(update_settings(state.clone(), settings).is_err());
        assert_eq!(
            state.preferences.read().unwrap().settings.daily_budget_usd,
            10.
        );
        assert_eq!(state.settings().unwrap().daily_budget_usd, 0.);
        drop(state);
        let reopened = Services::open(root.path().to_path_buf()).unwrap();
        assert_eq!(reopened.settings().unwrap().daily_budget_usd, 0.);
        assert_eq!(
            reopened.ai.budget().unwrap(),
            surtitle_ai::BudgetLimits::default()
        );
        connection
            .execute_batch("DROP TRIGGER reject_budget;")
            .unwrap();
        let mut settings = reopened.settings().unwrap();
        settings.daily_budget_usd = 2.;
        update_settings(reopened.clone(), settings).unwrap();
        assert_eq!(reopened.settings().unwrap().daily_budget_usd, 2.);
        assert_eq!(reopened.ai.budget().unwrap().daily_microusd, 2_000_000);
    }
}
