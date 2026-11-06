// SPDX-License-Identifier: GPL-3.0-or-later
//! Existing service boundaries for durable raw editing sessions.
use super::editing::{
    Action, Completion, EditFields, EditState, Effect, Loaded, SaveResult, UiDraft,
};
use crate::{application::AppState, commands};
use serde_json::{Map, Value};
use surtitle_core::workspace::{ArchiveUiDraft, SaveUiDraft};
use surtitle_core::{AppSettings, EditCard, StudyCard};

pub const SETTINGS_DRAFT_ONLY: &[&str] = &["modelInputs", "retentionInput"];
pub const DRAFT_CARD_ONLY: &[&str] = &["term", "meaning", "explanation", "translation"];
const BUDGET_KEYS: &[&str] = &["dailyBudgetUsd", "monthlyBudgetUsd", "perJobBudgetUsd"];
const SETTINGS_KEYS: &[&str] = &[
    "locale",
    "theme",
    "motionPreference",
    "captionGapMode",
    "learningLanguage",
    "explanationLanguage",
    "retention",
    "sentencePause",
    "replayContextMs",
    "proficiency",
    "vertexLocation",
    "dailyBudgetUsd",
    "monthlyBudgetUsd",
    "perJobBudgetUsd",
    "aiModels",
    "activeProvider",
    "openaiModels",
    "openaiDailyBudgetUsd",
    "openaiMonthlyBudgetUsd",
    "openaiPerJobBudgetUsd",
];

/// Run on the desktop's service executor, never while holding a GPUI update.
/// Each commit writes at most one settings/ledger transaction, returning its CAS revision.
pub async fn execute(state: AppState, effect: Effect) -> Completion {
    let Effect {
        kind,
        entity_id,
        action,
        ..
    } = effect;
    if !["settings", "card", "draft_card"].contains(&kind.as_str())
        || entity_id.is_empty()
        || entity_id.len() > 128
        || (kind == "settings" && entity_id != "default")
    {
        let error = format!("Unsupported editing target: {kind}/{entity_id}");
        return match action {
            Action::Load => Completion::Loaded(Err(error)),
            Action::ReadState => Completion::State(Err(error)),
            Action::ReadDraft => Completion::DraftRead(Err(error)),
            Action::SaveDraft { .. } => Completion::Draft(Err(error)),
            Action::RemoveDraft { .. } => Completion::Removed(Err(error)),
            Action::ArchiveDraft { .. } => Completion::Archived(Err(error)),
            Action::Commit { .. } => Completion::Committed(Err(error)),
        };
    }
    match action {
        Action::Load => Completion::Loaded((|| {
            Ok(Loaded {
                state: read_state(&state, &kind, &entity_id)?,
                draft: read_draft(&state, &kind, &entity_id)?,
            })
        })()),
        Action::ReadState => Completion::State(read_state(&state, &kind, &entity_id)),
        Action::ReadDraft => Completion::DraftRead(read_draft(&state, &kind, &entity_id)),
        Action::SaveDraft {
            expected_revision,
            fields,
        } => Completion::Draft(
            commands::ui_drafts::save_ui_draft(
                &state,
                SaveUiDraft {
                    kind,
                    entity_id,
                    expected_revision,
                    fields,
                },
            )
            .map(draft),
        ),
        Action::RemoveDraft { expected_revision } => Completion::Removed(
            commands::ui_drafts::delete_ui_draft(&state, kind, entity_id, expected_revision),
        ),
        Action::ArchiveDraft { fields } => Completion::Archived(
            commands::ui_drafts::archive_ui_draft(
                &state,
                ArchiveUiDraft {
                    kind,
                    entity_id,
                    fields,
                },
            )
            .map(|_| ()),
        ),
        Action::Commit { fields, previous } => Completion::Committed(match kind.as_str() {
            "settings" => commit_settings(&state, fields, previous),
            "card" => commit_card(&state, &entity_id, fields, previous),
            // Raw bookmark form input cannot create a card without an explicit Save action.
            "draft_card" => Ok(SaveResult {
                state: previous,
                applied: vec![],
            }),
            _ => unreachable!(),
        }),
    }
}

fn draft(value: surtitle_core::workspace::UiDraft) -> UiDraft {
    UiDraft {
        fields: value.fields,
        revision: value.revision,
        stale: value.stale,
    }
}

fn read_draft(state: &AppState, kind: &str, id: &str) -> Result<Option<UiDraft>, String> {
    // Only get()'s active record belongs in the session. Archived records are recovery UI data.
    commands::ui_drafts::get_ui_draft(state, kind.into(), id.into()).map(|value| value.map(draft))
}

fn read_state(state: &AppState, kind: &str, id: &str) -> Result<EditState, String> {
    match kind {
        "settings" => commands::models::get_settings_state(state).map(settings_state),
        "card" => commands::cards::get_card_edit_state(state, id.into()).map(card_state),
        "draft_card" => Ok(EditState {
            fields: DRAFT_CARD_ONLY
                .iter()
                .map(|key| ((*key).into(), String::new()))
                .collect(),
            revision: crate::application::ui_drafts::draft_card_revision(state.clone(), id.into())?,
        }),
        _ => Err(format!("Unsupported editing kind: {kind}")),
    }
}

pub fn settings_fields(settings: &AppSettings) -> EditFields {
    let mut fields = EditFields::new();
    macro_rules! text {
        ($($key:literal => $field:ident),* $(,)?) => { $(fields.insert($key.into(), settings.$field.to_string());)* };
    }
    text!("locale" => locale, "theme" => theme, "motionPreference" => motion_preference,
        "captionGapMode" => caption_gap_mode, "learningLanguage" => learning_language,
        "explanationLanguage" => explanation_language, "retention" => retention,
        "sentencePause" => sentence_pause, "replayContextMs" => replay_context_ms,
        "proficiency" => proficiency, "vertexLocation" => vertex_location,
        "dailyBudgetUsd" => daily_budget_usd);
    fields.insert(
        "monthlyBudgetUsd".into(),
        settings
            .monthly_budget_usd
            .unwrap_or(settings.daily_budget_usd)
            .to_string(),
    );
    fields.insert(
        "perJobBudgetUsd".into(),
        settings
            .per_job_budget_usd
            .unwrap_or(settings.daily_budget_usd)
            .to_string(),
    );
    fields.insert(
        "activeProvider".into(),
        settings.active_provider.as_str().into(),
    );
    fields.insert(
        "aiModels".into(),
        serde_json::to_string(&settings.ai_models).expect("model preferences serialize"),
    );
    fields.insert(
        "openaiModels".into(),
        serde_json::to_string(&settings.openai.ai_models).expect("model preferences serialize"),
    );
    for (key, value) in [
        ("openaiDailyBudgetUsd", settings.openai.daily_budget_usd),
        ("openaiMonthlyBudgetUsd", settings.openai.monthly_budget_usd),
        ("openaiPerJobBudgetUsd", settings.openai.per_job_budget_usd),
    ] {
        fields.insert(key.into(), value.to_string());
    }
    fields.insert(
        "retentionInput".into(),
        ((f64::from(settings.retention) * 1_000_000.).round() / 10_000.).to_string(),
    );
    fields
}

/// Typed projection for controls that need model/settings values. Invalid raw input
/// remains in EditFields; it must never be replaced by this projection.
pub fn settings_from_fields(fields: &EditFields, base: &AppSettings) -> AppSettings {
    let mut next = serde_json::to_value(base).expect("settings serialize");
    for key in SETTINGS_KEYS {
        let Some(value) = fields.get(*key).and_then(|raw| setting_value(key, raw)) else {
            continue;
        };
        if *key == "openaiModels" {
            next["openai"]["aiModels"] = value;
        } else if let Some(key) = openai_budget_key(key) {
            next["openai"][key] = value;
        } else {
            next[*key] = value;
        }
    }
    serde_json::from_value(next).expect("validated editable settings preserve the DTO")
}

pub fn settings_state(value: crate::application::models::SettingsState) -> EditState {
    EditState {
        fields: settings_fields(&value.settings),
        revision: value.revision,
    }
}

pub fn card_fields(card: &StudyCard) -> EditFields {
    [
        ("term", card.term.clone()),
        ("meaning", card.meaning.clone()),
        ("example", card.example.clone()),
        ("translation", card.translation.clone().unwrap_or_default()),
        ("explanation", card.explanation.clone().unwrap_or_default()),
    ]
    .into_iter()
    .map(|(key, value)| (key.into(), value))
    .collect()
}

pub fn card_state(value: surtitle_core::store::CardEditState) -> EditState {
    EditState {
        fields: card_fields(&value.card),
        revision: value.revision,
    }
}

pub fn card_from_fields(id: &str, fields: &EditFields) -> Option<EditCard> {
    let term = fields.get("term")?.trim();
    if term.is_empty() {
        return None;
    }
    let text = |key: &str| fields.get(key).cloned().unwrap_or_default();
    let optional = |key: &str| fields.get(key).filter(|value| !value.is_empty()).cloned();
    Some(EditCard {
        id: id.into(),
        term: term.into(),
        meaning: text("meaning"),
        example: text("example"),
        translation: optional("translation"),
        explanation: optional("explanation"),
    })
}

fn commit_card(
    state: &AppState,
    id: &str,
    fields: EditFields,
    previous: EditState,
) -> Result<SaveResult, String> {
    let Some(request) = card_from_fields(id, &fields) else {
        return Ok(SaveResult {
            state: previous,
            applied: vec![],
        });
    };
    let saved = commands::cards::save_card_edit(state, request, previous.revision)?;
    Ok(SaveResult {
        state: card_state(saved),
        applied: fields.into_keys().collect(),
    })
}

fn openai_budget_key(key: &str) -> Option<&'static str> {
    match key {
        "openaiDailyBudgetUsd" => Some("dailyBudgetUsd"),
        "openaiMonthlyBudgetUsd" => Some("monthlyBudgetUsd"),
        "openaiPerJobBudgetUsd" => Some("perJobBudgetUsd"),
        _ => None,
    }
}

fn setting_value(key: &str, raw: &str) -> Option<Value> {
    let key = openai_budget_key(key).unwrap_or(key);
    match key {
        "retention" | "replayContextMs" | "dailyBudgetUsd" | "monthlyBudgetUsd"
        | "perJobBudgetUsd" => {
            let number: f64 = raw.trim().parse().ok()?;
            let valid = number.is_finite()
                && if key == "retention" {
                    (0.7..=0.97).contains(&number)
                } else {
                    (0.0..=1000.).contains(&number)
                        && (key != "replayContextMs" || number.fract() == 0.)
                };
            if !valid {
                return None;
            }
            Some(if key == "replayContextMs" {
                Value::from(number as u16)
            } else {
                Value::from(number)
            })
        }
        "aiModels" | "openaiModels" => {
            let models: std::collections::BTreeMap<String, surtitle_core::AiModelPreference> =
                serde_json::from_str(raw).ok()?;
            models
                .values()
                .all(|model| (1..=1_048_576).contains(&model.max_output_tokens))
                .then(|| serde_json::to_value(models).expect("models serialize"))
        }
        "sentencePause" => Some(Value::Bool(raw == "true")),
        "theme" if !["dark", "light", "system"].contains(&raw) => None,
        "locale" if !["ja", "en"].contains(&raw) => None,
        "activeProvider" if !["vertex", "openai"].contains(&raw) => None,
        "motionPreference" if !["system", "reduce"].contains(&raw) => None,
        "captionGapMode" if !["review", "preview"].contains(&raw) => None,
        "learningLanguage" | "explanationLanguage" | "vertexLocation" if raw.trim().is_empty() => {
            None
        }
        _ => Some(Value::String(raw.into())),
    }
}

fn commit_settings(
    state: &AppState,
    fields: EditFields,
    previous: EditState,
) -> Result<SaveResult, String> {
    let latest = commands::models::get_settings_state(state)?;
    let latest_fields = settings_fields(&latest.settings);
    let current = if latest.revision != previous.revision
        && SETTINGS_KEYS
            .iter()
            .all(|key| latest_fields.get(*key) == previous.fields.get(*key))
    {
        EditState {
            fields: latest_fields,
            revision: latest.revision,
        }
    } else {
        previous.clone()
    };
    let changed: Vec<(&str, Value)> = SETTINGS_KEYS
        .iter()
        .filter_map(|key| {
            let raw = fields.get(*key)?;
            if previous.fields.get(*key) == Some(raw) {
                return None;
            }
            let value = setting_value(key, raw)?;
            // A malformed model configuration must not block independent appearance fields.
            let projected = settings_from_fields(
                &EditFields::from([((*key).into(), raw.clone())]),
                &latest.settings,
            );
            crate::application::models::validate_settings(&projected).ok()?;
            Some((*key, value))
        })
        .collect();
    let normal: Map<String, Value> = changed
        .iter()
        .filter(|(key, _)| !BUDGET_KEYS.contains(key) && openai_budget_key(key).is_none())
        .map(|(key, value)| ((*key).into(), value.clone()))
        .collect();
    if !normal.is_empty() {
        let mut applied: Vec<String> = changed
            .iter()
            .filter(|(key, _)| normal.contains_key(*key))
            .map(|(key, _)| (*key).into())
            .collect();
        let patch =
            serde_json::from_value(Value::Object(normal)).map_err(|error| error.to_string())?;
        let saved = settings_state(commands::models::update_settings_patch(
            state,
            current.revision,
            patch,
        )?);
        // Domain normalization can change another unchanged field (a location
        // change clears model prices). Adopt that result only when it was not
        // edited in this submission. The session also checks for newer input.
        for key in SETTINGS_KEYS {
            if saved.fields.get(*key) != previous.fields.get(*key)
                && fields.get(*key) == previous.fields.get(*key)
                && !applied.iter().any(|applied| applied == key)
            {
                applied.push((*key).into());
            }
        }
        return Ok(SaveResult {
            state: saved,
            applied,
        });
    }
    for provider in ["vertex", "openai"] {
        let field_key = |key: &str| {
            if provider == "openai" {
                format!("openai{}{}", key[..1].to_uppercase(), &key[1..])
            } else {
                key.into()
            }
        };
        let applied: Vec<String> = BUDGET_KEYS
            .iter()
            .map(|key| field_key(key))
            .filter(|field| changed.iter().any(|(key, _)| key == field))
            .collect();
        if applied.is_empty() {
            continue;
        }
        let mut budgets = Map::from_iter([("provider".into(), Value::from(provider))]);
        for key in BUDGET_KEYS {
            let field = field_key(key);
            let raw = if applied.contains(&field) {
                fields.get(&field)
            } else {
                current.fields.get(&field)
            }
            .ok_or_else(|| format!("Missing budget field: {field}"))?;
            budgets.insert(
                (*key).into(),
                setting_value(key, raw).ok_or_else(|| format!("Invalid budget field: {field}"))?,
            );
        }
        let patch = serde_json::from_value(serde_json::json!({"budgets": budgets}))
            .map_err(|error| error.to_string())?;
        let saved = commands::models::update_settings_patch(state, current.revision, patch)?;
        return Ok(SaveResult {
            state: settings_state(saved),
            applied,
        });
    }
    Ok(SaveResult {
        state: current,
        applied: vec![],
    })
}

#[cfg(test)]
#[path = "adapters/tests.rs"]
mod tests;
