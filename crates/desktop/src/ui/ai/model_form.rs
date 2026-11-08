// SPDX-License-Identifier: GPL-3.0-or-later
//! Per-request non-secret model controls. Raw strings and executable preferences
//! are separate; an estimate uses only a fully validated preference snapshot.
use super::persistence::Persistence;
use super::{locale_format, localized};
use crate::{
    commands,
    ui::{
        session::{Session, UiEvent, run},
        style::{column, row},
    },
};
use gpui_kit::base::Disableable;
use gpui_kit::component::{
    ActiveTheme,
    button::Button,
    input::{Input, InputEditsEvent, InputState},
};
use gpui_kit::{AppContext, Context, Entity, EventEmitter, Subscription, Window, prelude::*};
use std::collections::{BTreeMap, HashMap};
use surtitle_core::{AiModelPreference, AiPricePreference, AiProvider};
pub(super) type RawModels = HashMap<String, BTreeMap<String, String>>;
#[derive(Clone)]
pub(super) struct ModelValues {
    pub models: HashMap<String, AiModelPreference>,
    pub raw: RawModels,
}
pub(super) struct ModelForm {
    session: Entity<Session>,
    store: Persistence,
    generation: u64,
    purpose: String,
    provider: AiProvider,
    configuration: u64,
    models: HashMap<String, AiModelPreference>,
    raw: RawModels,
    inputs: BTreeMap<&'static str, Entity<InputState>>,
    input_subscriptions: Vec<Subscription>,
    _settings: Subscription,
    busy: bool,
    disabled: bool,
    revision: u64,
    error: Option<String>,
    discovered: Vec<surtitle_ai::DiscoveredModel>,
    price_details: Vec<String>,
}
impl EventEmitter<ModelValues> for ModelForm {}
impl ModelForm {
    pub fn new(
        session: Entity<Session>,
        store: Persistence,
        purpose: String,
        models: HashMap<String, AiModelPreference>,
        raw: RawModels,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let generation = store.generation();
        let (provider, configuration) = session
            .read(cx)
            .snapshot
            .as_ref()
            .map(|s| {
                (
                    s.settings.active_provider,
                    s.settings.ai_configuration_generation,
                )
            })
            .unwrap_or_default();
        let settings = cx.subscribe(&session, |this, _, event: &UiEvent, cx| {
            if matches!(event, UiEvent::Snapshot) {
                let current = this
                    .session
                    .read(cx)
                    .snapshot
                    .as_ref()
                    .map(|s| {
                        (
                            s.settings.active_provider,
                            s.settings.ai_configuration_generation,
                        )
                    })
                    .unwrap_or_default();
                if current != (this.provider, this.configuration) {
                    this.provider = current.0;
                    this.configuration = current.1;
                    this.models.clear();
                    for raw in this.raw.values_mut() {
                        raw.insert("enabled".into(), "false".into());
                    }
                    this.inputs.clear();
                    this.input_subscriptions.clear();
                    this.revision += 1;
                    this.emit(cx);
                }
                cx.notify();
            }
        });
        Self {
            session,
            store,
            generation,
            purpose,
            provider,
            configuration,
            models,
            raw,
            inputs: BTreeMap::new(),
            input_subscriptions: vec![],
            _settings: settings,
            busy: false,
            disabled: false,
            revision: 0,
            error: None,
            discovered: vec![],
            price_details: vec![],
        }
    }
    pub fn set_purpose(&mut self, purpose: &str, cx: &mut Context<Self>) {
        if self.purpose != purpose {
            self.purpose = purpose.into();
            self.inputs.clear();
            self.input_subscriptions.clear();
            self.discovered.clear();
            self.price_details.clear();
            self.revision += 1;
            cx.notify();
        }
    }
    pub fn set_disabled(&mut self, disabled: bool, cx: &mut Context<Self>) {
        if self.disabled != disabled {
            self.disabled = disabled;
            cx.notify();
        }
    }
    pub fn restore(
        &mut self,
        models: HashMap<String, AiModelPreference>,
        raw: RawModels,
        cx: &mut Context<Self>,
    ) {
        self.models = models;
        self.raw = raw;
        self.inputs.clear();
        self.input_subscriptions.clear();
        self.revision += 1;
        cx.notify();
    }
    pub fn values(&self) -> ModelValues {
        ModelValues {
            models: self.models.clone(),
            raw: self.raw.clone(),
        }
    }
    fn key(&self) -> String {
        format!("{}:{}", self.provider.as_str(), self.purpose)
    }
    fn base(&self, cx: &gpui_kit::App) -> Option<AiModelPreference> {
        self.models.get(&self.purpose).cloned().or_else(|| {
            self.session.read(cx).snapshot.as_ref().and_then(|s| {
                s.settings
                    .models_for(self.provider)
                    .get(&self.purpose)
                    .cloned()
            })
        })
    }
    pub fn selected(&self, cx: &gpui_kit::App) -> Result<AiModelPreference, String> {
        if self.busy {
            return Err("Wait for model or price lookup to finish".into());
        }
        let configured = self
            .session
            .read(cx)
            .snapshot
            .as_ref()
            .and_then(|snapshot| {
                snapshot
                    .settings
                    .models_for(self.provider)
                    .get(&self.purpose)
                    .cloned()
            });
        let enabled = self
            .raw
            .get(&self.key())
            .map(|raw| raw.get("enabled").is_some_and(|value| value == "true"));
        let base = selection_base(enabled, self.models.get(&self.purpose).cloned(), configured);
        let Some(raw) = self
            .raw
            .get(&self.key())
            .filter(|raw| raw.get("enabled").is_some_and(|v| v == "true"))
        else {
            return base
                .ok_or_else(|| "Choose a configured model or enable a request override".into());
        };
        let base = base.unwrap_or(AiModelPreference {
            model_id: String::new(),
            transcription_mode: "transcribe".into(),
            max_output_tokens: 4096,
            thinking_level: None,
            thinking_budget: None,
            price: None,
        });
        parse_model(raw, &base, self.provider, &self.purpose)
    }
    fn emit(&mut self, cx: &mut Context<Self>) {
        cx.emit(self.values());
        cx.notify();
    }
    fn changed(&mut self, name: &str, value: String, cx: &mut Context<Self>) {
        if self.frozen() {
            return;
        }
        let key = self.key();
        self.raw.entry(key).or_default().insert(name.into(), value);
        self.revision += 1;
        self.error = None;
        self.emit(cx);
    }
    fn frozen(&self) -> bool {
        self.disabled || self.busy || self.store.frozen() || self.store.retired(self.generation)
    }
    fn initialize(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.inputs.is_empty() {
            return;
        }
        let base = self.base(cx).unwrap_or(AiModelPreference {
            model_id: String::new(),
            transcription_mode: "transcribe".into(),
            max_output_tokens: if self.purpose == "explanation" {
                4096
            } else if self.purpose == "vocabulary" {
                8192
            } else {
                12288
            },
            thinking_level: None,
            thinking_budget: None,
            price: None,
        });
        let key = self.key();
        let defaults = default_raw(&base, self.models.contains_key(&self.purpose));
        let raw = self.raw.entry(key.clone()).or_insert(defaults).clone();
        for name in [
            "modelId",
            "transcriptionMode",
            "maxOutputTokens",
            "thinkingLevel",
            "thinkingBudget",
            "inputPrice",
            "outputPrice",
            "audioPrice",
        ] {
            let input = cx.new(|cx| {
                InputState::new(window, cx)
                    .default_value(raw.get(name).cloned().unwrap_or_default())
            });
            self.input_subscriptions.push(cx.subscribe(
                &input,
                move |this, _, event: &InputEditsEvent, cx| {
                    if let Some((_, text)) = event.edits().last() {
                        this.changed(name, text.to_string(), cx);
                    }
                },
            ));
            self.inputs.insert(name, input);
        }
    }
    fn discover(&mut self, cx: &mut Context<Self>) {
        if self.frozen() {
            return;
        }
        let guard = match self.store.operation() {
            Ok(guard) => guard,
            Err(error) => {
                self.error = Some(error);
                return;
            }
        };
        let backend = self.session.read(cx).backend.clone();
        let state = backend.state.clone();
        let provider = self.provider;
        let location = self
            .session
            .read(cx)
            .snapshot
            .as_ref()
            .map(|s| s.settings.vertex_location.clone());
        let revision = self.revision;
        self.busy = true;
        run(
            &backend,
            cx,
            async move {
                let _guard = guard;
                if provider == AiProvider::Openai {
                    commands::models::list_openai_models(&state).await
                } else {
                    commands::models::list_vertex_models(&state, location).await
                }
            },
            move |this, result, _| {
                this.busy = false;
                if this.revision != revision {
                    return;
                }
                match result {
                    Ok(models) => {
                        this.discovered = models;
                        this.error = None;
                    }
                    Err(error) => this.error = Some(error),
                }
            },
        );
    }
    fn lookup(&mut self, cx: &mut Context<Self>) {
        if self.frozen() || self.provider != AiProvider::Vertex {
            return;
        }
        let model = match self.selected(cx) {
            Ok(model) => model,
            Err(error) => {
                self.error = Some(error);
                return;
            }
        };
        let guard = match self.store.operation() {
            Ok(guard) => guard,
            Err(error) => {
                self.error = Some(error);
                return;
            }
        };
        let backend = self.session.read(cx).backend.clone();
        let state = backend.state.clone();
        let location = self
            .session
            .read(cx)
            .snapshot
            .as_ref()
            .map(|s| s.settings.vertex_location.clone());
        let revision = self.revision;
        let purpose = self.purpose.clone();
        let model_id = model.model_id.clone();
        self.busy = true;
        self.emit(cx);
        run(
            &backend,
            cx,
            async move {
                let _guard = guard;
                commands::models::lookup_vertex_price(&state, model_id, location).await
            },
            move |this, result, cx| {
                this.busy = false;
                if this.revision != revision {
                    return;
                }
                match result {
                    Ok(lookup) => {
                        this.price_details = lookup
                            .candidates
                            .iter()
                            .map(|price| {
                                format!(
                                    "{} · {} · {} · {} microUSD/million",
                                    price.sku,
                                    price.description,
                                    price.direction,
                                    price.microusd_per_million
                                )
                            })
                            .collect();
                        let mut model = model;
                        model.price = lookup.price;
                        this.models.insert(purpose, model);
                        this.error=(!lookup.complete).then(||"Published price lookup is incomplete; review the candidates or set rates manually".into());
                        this.emit(cx);
                    }
                    Err(error) => this.error = Some(error),
                }
            },
        );
    }
}
fn selection_base(
    enabled: Option<bool>,
    overridden: Option<AiModelPreference>,
    configured: Option<AiModelPreference>,
) -> Option<AiModelPreference> {
    if enabled == Some(false) {
        configured
    } else {
        overridden.or(configured)
    }
}
fn default_raw(model: &AiModelPreference, enabled: bool) -> BTreeMap<String, String> {
    [
        ("enabled".into(), enabled.to_string()),
        (
            "manualPrice".into(),
            model
                .price
                .as_ref()
                .is_some_and(|p| p.source == "user")
                .to_string(),
        ),
        ("modelId".into(), model.model_id.clone()),
        ("transcriptionMode".into(), model.transcription_mode.clone()),
        (
            "maxOutputTokens".into(),
            model.max_output_tokens.to_string(),
        ),
        (
            "thinkingLevel".into(),
            model.thinking_level.clone().unwrap_or_default(),
        ),
        (
            "thinkingBudget".into(),
            model
                .thinking_budget
                .map(|n| n.to_string())
                .unwrap_or_default(),
        ),
        (
            "inputPrice".into(),
            model
                .price
                .as_ref()
                .map(|p| (p.input_microusd_per_million as f64 / 1_000_000.).to_string())
                .unwrap_or_default(),
        ),
        (
            "outputPrice".into(),
            model
                .price
                .as_ref()
                .map(|p| (p.output_microusd_per_million as f64 / 1_000_000.).to_string())
                .unwrap_or_default(),
        ),
        (
            "audioPrice".into(),
            model
                .price
                .as_ref()
                .and_then(|p| p.audio_microusd_per_minute)
                .map(|n| (n as f64 / 1_000_000.).to_string())
                .unwrap_or_default(),
        ),
    ]
    .into()
}
fn integer(raw: &str, min: u32, max: u32) -> Option<u32> {
    if raw.is_empty() || !raw.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    raw.parse::<u32>().ok().filter(|n| *n >= min && *n <= max)
}
fn rate(raw: &str) -> Option<u64> {
    if raw.trim().is_empty()
        || raw.ends_with('.')
        || raw.starts_with('-')
        || raw.contains(['e', 'E'])
    {
        return None;
    }
    let n = raw.parse::<f64>().ok()?;
    if !n.is_finite() || n < 0. || n > 1_000_000_000. {
        return None;
    }
    Some((n * 1_000_000.).round() as u64)
}
fn parse_model(
    raw: &BTreeMap<String, String>,
    base: &AiModelPreference,
    provider: AiProvider,
    purpose: &str,
) -> Result<AiModelPreference, String> {
    let value = |key: &str| raw.get(key).map(String::as_str).unwrap_or("");
    let id = value("modelId").trim();
    if id.is_empty() {
        return Err("Enter a model ID".into());
    }
    let tokens = integer(value("maxOutputTokens"), 1, 1_048_576)
        .ok_or("Output tokens must be a complete integer between 1 and 1,048,576")?;
    let level = value("thinkingLevel").trim();
    if !["", "minimal", "low", "medium", "high"].contains(&level) {
        return Err("Thinking level must be empty, minimal, low, medium or high".into());
    }
    let budget = if value("thinkingBudget").is_empty() {
        None
    } else {
        Some(
            integer(value("thinkingBudget"), 0, 65536)
                .ok_or("Thinking budget must be an integer between 0 and 65,536")?
                as i32,
        )
    };
    if !level.is_empty() && budget.is_some() {
        return Err("Choose a thinking level or a token budget, not both".into());
    }
    let mode = value("transcriptionMode");
    if !["transcribe", "subtitles"].contains(&mode) {
        return Err("Use a supported transcription mode".into());
    }
    if provider == AiProvider::Openai && budget.is_some() {
        return Err("OpenAI uses thinking levels, not a thinking token budget".into());
    }
    let mut model = AiModelPreference {
        model_id: id.into(),
        transcription_mode: mode.into(),
        max_output_tokens: tokens,
        thinking_level: (!level.is_empty()).then(|| level.into()),
        thinking_budget: budget,
        price: if id == base.model_id && mode == base.transcription_mode {
            base.price.clone()
        } else {
            None
        },
    };
    if value("manualPrice") == "true" {
        let audio_only = provider == AiProvider::Openai && purpose == "transcription";
        let input = if audio_only {
            0
        } else {
            rate(value("inputPrice"))
                .ok_or("Enter a complete nonnegative input price in USD per million tokens")?
        };
        let output = if audio_only {
            0
        } else {
            rate(value("outputPrice"))
                .ok_or("Enter a complete nonnegative output price in USD per million tokens")?
        };
        let audio = if value("audioPrice").is_empty() {
            None
        } else {
            Some(
                rate(value("audioPrice"))
                    .ok_or("Enter a complete nonnegative audio price in USD per minute")?,
            )
        };
        if audio_only && audio.is_none() {
            return Err("Enter the transcription price in USD per audio minute".into());
        }
        model.price = Some(AiPricePreference {
            id: format!("request-user-{}", uuid::Uuid::new_v4()),
            source: "user".into(),
            observed_at_ms: chrono::Utc::now().timestamp_millis(),
            input_microusd_per_million: input,
            output_microusd_per_million: output,
            audio_microusd_per_minute: audio,
        });
    }
    Ok(model)
}
impl Render for ModelForm {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.initialize(window, cx);
        let theme = cx.theme().clone();
        let frozen = self.frozen();
        let raw = self.raw.get(&self.key()).cloned().unwrap_or_default();
        let purpose = localized(
            cx,
            match self.purpose.as_str() {
                "transcription" => "文字起こし / Transcription",
                "translation" => "翻訳 / Translation",
                "explanation" => "解説 / Explanation",
                _ => "語彙提案 / Vocabulary suggestions",
            },
        );
        let model_scope = format!("{} · {}", self.provider.as_str(), purpose);
        let enabled = raw.get("enabled").is_some_and(|v| v == "true");
        let manual = raw.get("manualPrice").is_some_and(|v| v == "true");
        let mut content = column()
            .p_3()
            .border_1()
            .border_color(theme.border)
            .child(locale_format!(
                cx,
                "この要求のモデル設定 · {} · {}",
                "Model for this request · {} · {}",
                self.provider.as_str(),
                self.purpose
            ))
            .child(
                Button::new("override-request-model")
                    .label(if enabled {
                        localized(cx, "✓ この要求だけ上書き / Override this request")
                    } else {
                        localized(cx, "□ 設定済みモデルを使用 / Use configured model")
                    })
                    .disabled(frozen)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.changed("enabled", (!enabled).to_string(), cx)
                    })),
            );
        if enabled {
            for (name, label) in [
                ("modelId", localized(cx, "モデルID / Model ID")),
                (
                    "transcriptionMode",
                    localized(cx, "文字起こしモード / Transcription mode"),
                ),
                (
                    "maxOutputTokens",
                    localized(
                        cx,
                        "要求ごとの出力上限トークン / Maximum output tokens per request",
                    ),
                ),
                (
                    "thinkingLevel",
                    localized(
                        cx,
                        "思考レベル（空欄・minimal・low・medium・high） / Thinking level",
                    ),
                ),
                (
                    "thinkingBudget",
                    localized(
                        cx,
                        "思考トークン予算（レベル指定と併用不可） / Thinking token budget",
                    ),
                ),
            ] {
                if name == "transcriptionMode" && self.purpose != "transcription" {
                    continue;
                }
                if name == "thinkingBudget" && self.provider == AiProvider::Openai {
                    continue;
                }
                content = content.child(
                    column().child(label.clone()).child(
                        Input::new(&self.inputs[name])
                            .aria_label(format!("{model_scope} · {label}"))
                            .disabled(frozen),
                    ),
                );
            }
            content = content.child(
                row()
                    .child(
                        Button::new("discover-request-models")
                            .label(localized(cx, "利用可能なモデルを取得 / Discover models"))
                            .disabled(frozen)
                            .on_click(cx.listener(|this, _, _, cx| this.discover(cx))),
                    )
                    .child(
                        Button::new("request-price-lookup")
                            .label(localized(cx, "公開単価を確認 / Look up published prices"))
                            .disabled(frozen || self.provider != AiProvider::Vertex)
                            .on_click(cx.listener(|this, _, _, cx| this.lookup(cx))),
                    ),
            );
            for (index, model) in self.discovered.iter().take(100).enumerate() {
                let id = model.id.clone();
                content = content.child(
                    Button::new(("choose-request-model", index))
                        .label(format!("{} · {}", model.id, model.display_name))
                        .disabled(frozen)
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.inputs["modelId"]
                                .update(cx, |input, cx| input.set_value(id.clone(), window, cx));
                            this.changed("modelId", id.clone(), cx);
                        })),
                );
            }
            content = content.child(
                Button::new("request-manual-price")
                    .label(if manual {
                        localized(cx, "✓ この要求の単価を手動設定 / Manual rates")
                    } else {
                        localized(cx, "□ この要求の単価を手動設定 / Set rates manually")
                    })
                    .disabled(frozen)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.changed("manualPrice", (!manual).to_string(), cx)
                    })),
            );
            if manual {
                for (name, label) in [
                    (
                        "inputPrice",
                        localized(
                            cx,
                            "入力 USD / 100万トークン / Input USD per million tokens",
                        ),
                    ),
                    (
                        "outputPrice",
                        localized(
                            cx,
                            "出力 USD / 100万トークン / Output USD per million tokens",
                        ),
                    ),
                    (
                        "audioPrice",
                        localized(cx, "音声 USD / 分（音声課金用） / Audio USD per minute"),
                    ),
                ] {
                    let audio_only =
                        self.provider == AiProvider::Openai && self.purpose == "transcription";
                    if (audio_only && name != "audioPrice") || (!audio_only && name == "audioPrice")
                    {
                        continue;
                    }
                    content = content.child(
                        column().child(label.clone()).child(
                            Input::new(&self.inputs[name])
                                .aria_label(format!("{model_scope} · {label}"))
                                .disabled(frozen),
                        ),
                    );
                }
            }
            if self.provider == AiProvider::Openai {
                content=content.child(localized(cx, "OpenAIのモデルAPIは単価を返しません。公表料金を確認し、必要に応じて手動で設定してください。 / Model discovery does not provide OpenAI prices; review published rates and enter them manually."));
            }
            for detail in &self.price_details {
                content = content.child(detail.clone());
            }
            if let Err(error) = self.selected(cx) {
                content = content.child(error);
            }
        }
        if let Some(error) = &self.error {
            content = content.child(error.clone());
        }
        content
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn base() -> AiModelPreference {
        AiModelPreference {
            model_id: "configured".into(),
            transcription_mode: "transcribe".into(),
            max_output_tokens: 4096,
            thinking_level: None,
            thinking_budget: None,
            price: Some(AiPricePreference {
                id: "known".into(),
                source: "google".into(),
                observed_at_ms: 0,
                input_microusd_per_million: 1,
                output_microusd_per_million: 2,
                audio_microusd_per_minute: None,
            }),
        }
    }
    #[test]
    fn unfinished_integer_or_price_controls_never_reuse_an_older_executable_value() {
        let b = base();
        let mut raw = default_raw(&b, true);
        raw.insert("maxOutputTokens".into(), "4096.".into());
        assert!(parse_model(&raw, &b, AiProvider::Vertex, "translation").is_err());
        raw.insert("maxOutputTokens".into(), "8192".into());
        raw.insert("manualPrice".into(), "true".into());
        raw.insert("inputPrice".into(), "1.".into());
        raw.insert("outputPrice".into(), "2".into());
        assert!(parse_model(&raw, &b, AiProvider::Vertex, "translation").is_err());
        assert_eq!(raw["inputPrice"], "1.");
    }
    #[test]
    fn changing_a_model_drops_its_preceding_price_and_manual_rates_are_explicit() {
        let b = base();
        let mut raw = default_raw(&b, true);
        raw.insert("modelId".into(), "new-model".into());
        let selected = parse_model(&raw, &b, AiProvider::Vertex, "translation").unwrap();
        assert!(selected.price.is_none());
        raw.insert("manualPrice".into(), "true".into());
        raw.insert("inputPrice".into(), "0.25".into());
        raw.insert("outputPrice".into(), "1.5".into());
        let price = parse_model(&raw, &b, AiProvider::Vertex, "translation")
            .unwrap()
            .price
            .unwrap();
        assert_eq!(price.input_microusd_per_million, 250000);
        assert_eq!(price.output_microusd_per_million, 1500000);
        assert_eq!(price.source, "user");
    }
    #[test]
    fn audio_pricing_and_thinking_controls_remain_typed() {
        let b = base();
        let mut raw = default_raw(&b, true);
        raw.insert("manualPrice".into(), "true".into());
        raw.insert("audioPrice".into(), "0.006".into());
        let price = parse_model(&raw, &b, AiProvider::Openai, "transcription")
            .unwrap()
            .price
            .unwrap();
        assert_eq!(price.audio_microusd_per_minute, Some(6000));
        raw.insert("thinkingLevel".into(), "high".into());
        raw.insert("thinkingBudget".into(), "1024".into());
        assert!(parse_model(&raw, &b, AiProvider::Openai, "transcription").is_err());
    }
    #[test]
    fn turning_off_a_restored_override_uses_the_current_global_model_and_price() {
        let configured = base();
        let mut custom = base();
        custom.model_id = "restored-custom".into();
        custom.price.as_mut().unwrap().input_microusd_per_million = 99;
        let chosen =
            selection_base(Some(false), Some(custom.clone()), Some(configured.clone())).unwrap();
        assert_eq!(chosen.model_id, "configured");
        assert_eq!(chosen.price.unwrap().input_microusd_per_million, 1);
        assert_eq!(
            selection_base(Some(true), Some(custom.clone()), Some(configured.clone()))
                .unwrap()
                .model_id,
            "restored-custom"
        );
        assert_eq!(
            selection_base(None, Some(custom), Some(configured))
                .unwrap()
                .model_id,
            "restored-custom"
        );
    }
}
