// SPDX-License-Identifier: GPL-3.0-or-later
//! Form projections preserve incomplete input separately from typed preferences.
use crate::controller::editing::EditFields;
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use surtitle_core::{AiModelPreference, AiPricePreference};

pub fn number(raw: &str) -> Option<f64> {
    raw.trim()
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite())
}
pub fn retention_patch(raw: &str) -> EditFields {
    EditFields::from([
        ("retentionInput".into(), raw.into()),
        (
            "retention".into(),
            number(raw)
                .map(|number| (number / 100.).to_string())
                .unwrap_or_else(|| raw.into()),
        ),
    ])
}
pub fn budget_key(provider: &str, key: &str) -> String {
    if provider == "openai" {
        format!("openai{}{}", key[..1].to_uppercase(), &key[1..])
    } else {
        key.into()
    }
}
pub fn budget_identity(key: &str) -> Option<(&'static str, &'static str)> {
    for budget in ["dailyBudgetUsd", "monthlyBudgetUsd", "perJobBudgetUsd"] {
        for provider in ["vertex", "openai"] {
            if key == budget_key(provider, budget) {
                return Some((provider, budget));
            }
        }
    }
    None
}
pub fn budget_patch(
    fields: &EditFields,
    provider: &str,
    key: &str,
    raw: &str,
    anchor: f64,
) -> EditFields {
    let anchor = fields
        .get(&budget_key(provider, "monthlyBudgetUsd"))
        .and_then(|raw| number(raw))
        .unwrap_or(anchor);
    let mut patch = EditFields::from([(budget_key(provider, key), raw.into())]);
    if key == "monthlyBudgetUsd" && number(raw).is_some() {
        for linked in ["dailyBudgetUsd", "perJobBudgetUsd"] {
            let field = budget_key(provider, linked);
            if fields.get(&field).and_then(|value| number(value)) == Some(anchor) {
                patch.insert(field, raw.into());
            }
        }
    }
    patch
}
pub fn recommended_tokens(purpose: &str) -> u32 {
    match purpose {
        "explanation" => 4096,
        "vocabulary" => 8192,
        _ => 12288,
    }
}
fn empty_model(purpose: &str) -> AiModelPreference {
    AiModelPreference {
        model_id: String::new(),
        transcription_mode: "transcribe".into(),
        max_output_tokens: recommended_tokens(purpose),
        thinking_level: None,
        thinking_budget: None,
        price: None,
    }
}
pub fn model_field(provider: &str) -> &'static str {
    if provider == "openai" {
        "openaiModels"
    } else {
        "aiModels"
    }
}
fn models(
    fields: &EditFields,
    provider: &str,
) -> Result<BTreeMap<String, AiModelPreference>, String> {
    serde_json::from_str(
        fields
            .get(model_field(provider))
            .map(String::as_str)
            .unwrap_or("{}"),
    )
    .map_err(|error| format!("Invalid model input: {error}"))
}
pub fn model(fields: &EditFields, provider: &str, purpose: &str) -> AiModelPreference {
    models(fields, provider)
        .ok()
        .and_then(|mut values| values.remove(purpose))
        .unwrap_or_else(|| empty_model(purpose))
}
fn inputs(fields: &EditFields) -> Result<Map<String, Value>, String> {
    serde_json::from_str(
        fields
            .get("modelInputs")
            .map(String::as_str)
            .unwrap_or("{}"),
    )
    .map_err(|error| format!("Invalid model form input: {error}"))
}
fn input_draft(
    all: &Map<String, Value>,
    provider: &str,
    purpose: &str,
    value: &AiModelPreference,
) -> Map<String, Value> {
    all.get(&format!("{provider}:{purpose}"))
        .or_else(|| {
            if provider == "vertex" {
                all.get(purpose)
            } else {
                None
            }
        })
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_else(|| {
            let mut raw = Map::new();
            raw.insert(
                "manual".into(),
                Value::Bool(
                    value
                        .price
                        .as_ref()
                        .is_some_and(|price| price.source == "user"),
                ),
            );
            for (key, rate) in [
                (
                    "input",
                    value
                        .price
                        .as_ref()
                        .map(|price| price.input_microusd_per_million),
                ),
                (
                    "output",
                    value
                        .price
                        .as_ref()
                        .map(|price| price.output_microusd_per_million),
                ),
                (
                    "audio",
                    value
                        .price
                        .as_ref()
                        .and_then(|price| price.audio_microusd_per_minute),
                ),
            ] {
                raw.insert(
                    key.into(),
                    Value::from(
                        rate.map(|rate| (rate as f64 / 1_000_000.).to_string())
                            .unwrap_or_default(),
                    ),
                );
            }
            raw
        })
}
pub fn model_values(fields: &EditFields, provider: &str, purpose: &str) -> EditFields {
    let value = model(fields, provider, purpose);
    let raw = input_draft(
        &inputs(fields).unwrap_or_default(),
        provider,
        purpose,
        &value,
    );
    let mut result = EditFields::from([
        ("modelId".into(), value.model_id),
        (
            "maxOutputTokens".into(),
            value.max_output_tokens.to_string(),
        ),
        (
            "thinkingBudget".into(),
            value.thinking_budget.unwrap_or(1024).to_string(),
        ),
    ]);
    for key in [
        "maxOutputTokens",
        "thinkingBudget",
        "input",
        "output",
        "audio",
    ] {
        if let Some(text) = raw.get(key).and_then(Value::as_str) {
            result.insert(key.into(), text.into());
        } else if ["input", "output", "audio"].contains(&key) {
            result.entry(key.into()).or_default();
        }
    }
    result
}
pub fn valid_tokens(raw: &str, min: u32, max: u32) -> Option<u32> {
    if raw.is_empty() || !raw.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    raw.parse::<u32>()
        .ok()
        .filter(|value| (min..=max).contains(value))
}
/// Parse decimal USD exactly; partial decimals and more than six places remain drafts.
pub fn rate(raw: &str) -> Option<u64> {
    let (whole, fraction) = raw
        .split_once('.')
        .map_or((raw, None), |(whole, part)| (whole, Some(part)));
    if whole.is_empty() || !whole.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let whole = whole.parse::<u64>().ok()?;
    let fractional = match fraction {
        Some(part)
            if !part.is_empty()
                && part.len() <= 6
                && part.bytes().all(|byte| byte.is_ascii_digit()) =>
        {
            part.parse::<u64>().ok()? * 10_u64.pow(6 - part.len() as u32)
        }
        Some(_) => return None,
        None => 0,
    };
    let micros = whole.checked_mul(1_000_000)?.checked_add(fractional)?;
    (micros <= 1_000_000_000_000).then_some(micros)
}
fn timestamp() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |value| value.as_millis().min(i64::MAX as u128) as i64)
}
fn manual_price(raw: &Map<String, Value>, audio: bool) -> Option<AiPricePreference> {
    let parse = |key: &str| rate(raw.get(key)?.as_str()?);
    let (input, output, audio) = if audio {
        (0, 0, Some(parse("audio")?))
    } else {
        (parse("input")?, parse("output")?, None)
    };
    let now = timestamp();
    Some(AiPricePreference {
        id: format!("user-{now}"),
        source: "user".into(),
        observed_at_ms: now,
        input_microusd_per_million: input,
        output_microusd_per_million: output,
        audio_microusd_per_minute: audio,
    })
}
pub fn model_patch(
    fields: &EditFields,
    provider: &str,
    purpose: &str,
    key: &str,
    raw: &str,
) -> Result<EditFields, String> {
    let mut values = models(fields, provider)?;
    let configured = values.contains_key(purpose);
    let mut value = values
        .remove(purpose)
        .unwrap_or_else(|| empty_model(purpose));
    let before = serde_json::to_value(&value).map_err(|error| error.to_string())?;
    let mut all = inputs(fields)?;
    let mut input = input_draft(&all, provider, purpose, &value);
    match key {
        "modelId" => {
            value.model_id = raw.into();
            value.price = None;
            if provider == "vertex" && purpose == "transcription" {
                let lower = raw.to_ascii_lowercase();
                if lower.contains("transcribe") {
                    value.transcription_mode = "transcribe".into();
                } else if lower.contains("flash") {
                    value.transcription_mode = "subtitles".into();
                }
            }
            input.insert("manual".into(), Value::Bool(false));
            for key in ["input", "output", "audio"] {
                input.insert(key.into(), Value::from(""));
            }
        }
        "maxOutputTokens" => {
            input.insert(key.into(), Value::from(raw));
            if let Some(tokens) = valid_tokens(raw, 1, 1_048_576) {
                value.max_output_tokens = tokens;
            }
        }
        "thinkingBudget" => {
            input.insert(key.into(), Value::from(raw));
            if let Some(tokens) = valid_tokens(raw, 0, 65_536) {
                value.thinking_level = None;
                value.thinking_budget = Some(tokens as i32);
            }
        }
        "thinkingMode" => {
            value.thinking_level = (raw == "level").then(|| "LOW".into());
            value.thinking_budget = (raw == "budget").then_some(1024);
            input.remove("thinkingBudget");
        }
        "thinkingLevel" => {
            value.thinking_budget = None;
            value.thinking_level = Some(raw.into());
        }
        "transcriptionMode" => value.transcription_mode = raw.into(),
        "standardTokens" => {
            value.max_output_tokens = recommended_tokens(purpose);
            input.remove("maxOutputTokens");
        }
        "input" | "output" | "audio" => {
            input.insert(key.into(), Value::from(raw));
            input.insert("manual".into(), Value::Bool(true));
            if let Some(price) =
                manual_price(&input, provider == "openai" && purpose == "transcription")
            {
                value.price = Some(price);
            }
        }
        "clearPrice" => {
            value.price = None;
            input.insert("manual".into(), Value::Bool(false));
            for key in ["input", "output", "audio"] {
                input.insert(key.into(), Value::from(""));
            }
        }
        _ => return Err(format!("Unknown model form field: {key}")),
    }
    // Editing an incomplete token/rate only creates raw form input. A default
    // placeholder must not become a saved model configuration as a side effect.
    if configured || serde_json::to_value(&value).map_err(|error| error.to_string())? != before {
        values.insert(purpose.into(), value);
    }
    all.insert(format!("{provider}:{purpose}"), Value::Object(input));
    Ok(EditFields::from([
        (
            model_field(provider).into(),
            serde_json::to_string(&values).map_err(|error| error.to_string())?,
        ),
        (
            "modelInputs".into(),
            serde_json::to_string(&all).map_err(|error| error.to_string())?,
        ),
    ]))
}
pub fn price_patch(
    fields: &EditFields,
    provider: &str,
    purpose: &str,
    price: AiPricePreference,
) -> Result<EditFields, String> {
    let mut values = models(fields, provider)?;
    let mut value = values
        .remove(purpose)
        .unwrap_or_else(|| empty_model(purpose));
    value.price = Some(price);
    let mut all = inputs(fields)?;
    // Public prices replace this task's rate inputs only, keeping unfinished token inputs.
    let mut draft = input_draft(&all, provider, purpose, &value);
    let actual = value.price.as_ref().unwrap();
    draft.insert("manual".into(), Value::Bool(false));
    draft.insert(
        "input".into(),
        Value::from((actual.input_microusd_per_million as f64 / 1_000_000.).to_string()),
    );
    draft.insert(
        "output".into(),
        Value::from((actual.output_microusd_per_million as f64 / 1_000_000.).to_string()),
    );
    all.insert(format!("{provider}:{purpose}"), Value::Object(draft));
    values.insert(purpose.into(), value);
    Ok(EditFields::from([
        (
            model_field(provider).into(),
            serde_json::to_string(&values).map_err(|error| error.to_string())?,
        ),
        (
            "modelInputs".into(),
            serde_json::to_string(&all).map_err(|error| error.to_string())?,
        ),
    ]))
}
pub fn field_error(name: &str, raw: &str) -> Option<(&'static str, &'static str)> {
    if name == "retentionInput" && number(raw).is_none_or(|value| !(70.0..=97.0).contains(&value)) {
        return Some((
            "70〜97%を入力してください。",
            "Enter a retention rate from 70% to 97%.",
        ));
    }
    if name == "replayContextMs"
        && number(raw).is_none_or(|value| !(0.0..=1000.0).contains(&value) || value.fract() != 0.)
    {
        return Some((
            "0〜1000 msの整数を入力してください。",
            "Enter a whole number from 0 to 1,000 ms.",
        ));
    }
    if budget_identity(name).is_some()
        && number(raw).is_none_or(|value| !(0.0..=1000.0).contains(&value))
    {
        return Some((
            "0〜1000 USDを入力してください。",
            "Enter an amount from 0 to 1,000 USD.",
        ));
    }
    if ["learningLanguage", "explanationLanguage"].contains(&name) && raw.trim().is_empty() {
        return Some(("言語を指定してください。", "Enter a language."));
    }
    None
}

pub fn location_patch(fields: &EditFields, raw: &str) -> Result<EditFields, String> {
    if fields
        .get("vertexLocation")
        .is_some_and(|value| value == raw)
    {
        return Ok(EditFields::new());
    }
    let mut values = models(fields, "vertex")?;
    for model in values.values_mut() {
        model.price = None;
    }
    let mut all = inputs(fields)?;
    for (key, value) in &mut all {
        if (key.starts_with("vertex:")
            || ["transcription", "translation", "explanation", "vocabulary"]
                .contains(&key.as_str()))
            && let Some(input) = value.as_object_mut()
        {
            input.insert("manual".into(), Value::Bool(false));
            for key in ["input", "output", "audio"] {
                input.insert(key.into(), Value::from(""));
            }
        }
    }
    Ok(EditFields::from([
        ("vertexLocation".into(), raw.into()),
        (
            "aiModels".into(),
            serde_json::to_string(&values).map_err(|error| error.to_string())?,
        ),
        (
            "modelInputs".into(),
            serde_json::to_string(&all).map_err(|error| error.to_string())?,
        ),
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn percentage_input_keeps_incomplete_text_without_reusing_old_valid_retention() {
        let valid = retention_patch("85.5");
        assert_eq!(valid.get("retention").map(String::as_str), Some("0.855"));
        assert_eq!(
            valid.get("retentionInput").map(String::as_str),
            Some("85.5")
        );
        let invalid = retention_patch("-");
        assert_eq!(invalid.get("retention").map(String::as_str), Some("-"));
        assert_eq!(invalid.get("retentionInput").map(String::as_str), Some("-"));
    }
    #[test]
    fn monthly_budget_tracks_matching_caps_but_preserves_independent_and_incomplete_caps() {
        let fields = EditFields::from([
            ("openaiMonthlyBudgetUsd".into(), "-".into()),
            ("openaiDailyBudgetUsd".into(), "5".into()),
            ("openaiPerJobBudgetUsd".into(), "1".into()),
        ]);
        let changed = budget_patch(&fields, "openai", "monthlyBudgetUsd", "10", 5.);
        assert_eq!(
            changed.get("openaiMonthlyBudgetUsd").map(String::as_str),
            Some("10")
        );
        assert_eq!(
            changed.get("openaiDailyBudgetUsd").map(String::as_str),
            Some("10")
        );
        assert!(!changed.contains_key("openaiPerJobBudgetUsd"));
        let unfinished = budget_patch(&fields, "openai", "monthlyBudgetUsd", "", 5.);
        assert_eq!(
            unfinished.get("openaiMonthlyBudgetUsd").map(String::as_str),
            Some("")
        );
        assert_eq!(unfinished.len(), 1);
    }

    #[test]
    fn matching_caps_follow_the_latest_visible_monthly_budget_after_an_external_change() {
        let fields = EditFields::from([
            ("monthlyBudgetUsd".into(), "10".into()),
            ("dailyBudgetUsd".into(), "10".into()),
            ("perJobBudgetUsd".into(), "2".into()),
        ]);
        let changed = budget_patch(&fields, "vertex", "monthlyBudgetUsd", "20", 5.);
        assert_eq!(
            changed.get("dailyBudgetUsd").map(String::as_str),
            Some("20")
        );
        assert!(!changed.contains_key("perJobBudgetUsd"));
    }
    #[test]
    fn model_token_draft_survives_partial_edit_without_mutating_the_last_valid_limit() {
        let mut fields = EditFields::new();
        fields.extend(
            model_patch(&fields, "vertex", "translation", "maxOutputTokens", "1234").unwrap(),
        );
        fields
            .extend(model_patch(&fields, "vertex", "translation", "maxOutputTokens", "-").unwrap());
        assert_eq!(
            model(&fields, "vertex", "translation").max_output_tokens,
            1234
        );
        let input: serde_json::Value = serde_json::from_str(&fields["modelInputs"]).unwrap();
        assert_eq!(input["vertex:translation"]["maxOutputTokens"], "-");
    }

    #[test]
    fn invalid_input_for_an_unconfigured_model_does_not_create_a_configuration() {
        let fields = model_patch(
            &EditFields::new(),
            "vertex",
            "translation",
            "maxOutputTokens",
            "-",
        )
        .unwrap();
        let models: serde_json::Value = serde_json::from_str(&fields["aiModels"]).unwrap();
        assert!(models.as_object().unwrap().is_empty());
        let inputs: serde_json::Value = serde_json::from_str(&fields["modelInputs"]).unwrap();
        assert_eq!(inputs["vertex:translation"]["maxOutputTokens"], "-");
    }
    #[test]
    fn audio_price_uses_minutes_and_malformed_decimal_cannot_replace_a_valid_price() {
        let mut fields = EditFields::new();
        fields.extend(model_patch(&fields, "openai", "transcription", "audio", "0.006").unwrap());
        let priced = model(&fields, "openai", "transcription").price.unwrap();
        assert_eq!(priced.audio_microusd_per_minute, Some(6000));
        assert_eq!(priced.input_microusd_per_million, 0);
        fields
            .extend(model_patch(&fields, "openai", "transcription", "audio", "0.0000001").unwrap());
        assert_eq!(
            model(&fields, "openai", "transcription")
                .price
                .unwrap()
                .audio_microusd_per_minute,
            Some(6000)
        );
        let input: serde_json::Value = serde_json::from_str(&fields["modelInputs"]).unwrap();
        assert_eq!(input["openai:transcription"]["audio"], "0.0000001");
    }

    #[test]
    fn changing_vertex_location_clears_rate_drafts_but_preserves_unfinished_tokens_and_openai_rates()
     {
        let mut fields = EditFields::new();
        for (provider, purpose, key, raw) in [
            ("vertex", "translation", "input", "1"),
            ("vertex", "translation", "output", "2"),
            ("vertex", "translation", "maxOutputTokens", "-"),
            ("openai", "transcription", "audio", "0.006"),
        ] {
            fields.extend(model_patch(&fields, provider, purpose, key, raw).unwrap());
        }
        fields.extend(location_patch(&fields, "us-central1").unwrap());
        assert!(model(&fields, "vertex", "translation").price.is_none());
        let vertex = model_values(&fields, "vertex", "translation");
        assert_eq!(vertex["input"], "");
        assert_eq!(vertex["output"], "");
        assert_eq!(vertex["maxOutputTokens"], "-");
        assert_eq!(
            model(&fields, "openai", "transcription")
                .price
                .unwrap()
                .audio_microusd_per_minute,
            Some(6000)
        );
    }
}
