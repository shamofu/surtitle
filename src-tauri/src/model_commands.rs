// SPDX-License-Identifier: GPL-3.0-or-later
use crate::service::*;
use anyhow::{Context, Result, ensure};
use serde::Serialize;
use surtitle_ai::{
    CredentialVault, ExecutionConfig, PriceSnapshot, ThinkingConfig, VertexDiscovery,
};
use surtitle_core::{AiModelPreference, AiPricePreference, AppSettings};
use tauri::State;

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

#[tauri::command]
pub fn update_appearance(
    state: State<'_, AppState>,
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
        let mut preferences = lock(&state.preferences)?;
        let mut next = preferences.clone();
        if let Some(locale) = locale {
            next.settings.locale = locale;
        }
        if let Some(theme) = theme {
            next.settings.theme = theme;
        }
        state.save_preferences(&next)?;
        *preferences = next;
        Ok(())
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

#[tauri::command]
pub async fn list_vertex_models(
    state: State<'_, AppState>,
    location: Option<String>,
) -> std::result::Result<Vec<surtitle_ai::DiscoveredModel>, String> {
    async {
        let (credential, location) = {
            let prefs = lock(&state.preferences)?;
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

#[tauri::command]
pub async fn lookup_vertex_price(
    state: State<'_, AppState>,
    model_id: String,
    location: Option<String>,
) -> std::result::Result<PriceLookup, String> {
    async {
        let (credential, location) = {
            let prefs = lock(&state.preferences)?;
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
