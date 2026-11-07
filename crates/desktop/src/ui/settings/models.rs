use super::*;

impl SettingsView {
    fn catalogue_key(&self, cx: &Context<Self>) -> String {
        let fields = self.fields(cx);
        let snapshot = self.session.read(cx).snapshot.clone();
        format!(
            "{}:{}:{}:{}",
            fields
                .get("activeProvider")
                .map(String::as_str)
                .unwrap_or("vertex"),
            fields
                .get("vertexLocation")
                .map(String::as_str)
                .unwrap_or("global"),
            snapshot
                .as_ref()
                .map_or(0, |snapshot| snapshot.settings.ai_configuration_generation),
            snapshot
                .as_ref()
                .map_or("", |snapshot| snapshot.settings.vertex_project.as_str())
        )
    }
    fn discover_models(&mut self, cx: &mut Context<Self>) {
        if self.frozen(cx) || self.pending.contains("models") {
            return;
        }
        let fields = self.fields(cx);
        let provider = fields
            .get("activeProvider")
            .cloned()
            .unwrap_or_else(|| "vertex".into());
        let location = fields.get("vertexLocation").cloned();
        let requested = self.catalogue_key(cx);
        let backend = self.session.read(cx).backend.clone();
        let state = backend.state.clone();
        self.pending.insert("models".into());
        self.error = None;
        session::run(
            &backend,
            cx,
            async move {
                if provider == "openai" {
                    commands::models::list_openai_models(&state).await
                } else {
                    commands::models::list_vertex_models(&state, location).await
                }
            },
            move |this, result, cx| {
                this.pending.remove("models");
                if this.catalogue_key(cx) != requested {
                    return;
                }
                match result {
                    Ok(models) => {
                        this.notice=Some(this.t(&format!("{}件の候補を取得しました。掲載されても実行権限を保証するものではありません。",models.len()),&format!("Retrieved {} candidates. Listing does not confirm access to run them.",models.len()),cx));
                        this.catalogue = models;
                        this.catalogue_identity = requested;
                    }
                    Err(error) => {
                        this.error = Some(format!(
                            "{} {error}",
                            this.t(
                                "候補を取得できませんでした。モデルIDを直接入力できます。",
                                "Could not retrieve candidates. You can enter a model ID directly.",
                                cx
                            )
                        ))
                    }
                }
            },
        );
    }
    fn credential(
        &mut self,
        provider: &str,
        remove: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.frozen(cx) || self.pending.contains("credential") {
            return;
        }
        let key = self
            .inputs
            .get("apiKey")
            .map(|binding| binding.state.read(cx).value().trim().to_owned())
            .unwrap_or_default();
        if provider == "openai" && !remove && key.is_empty() {
            return;
        }
        if let Some(binding) = self.inputs.get_mut("apiKey") {
            binding
                .state
                .update(cx, |input, cx| input.set_value("", window, cx));
            binding.delivered.clear();
        }
        let provider = provider.to_owned();
        let backend = self.session.read(cx).backend.clone();
        let state = backend.state.clone();
        self.pending.insert("credential".into());
        self.error = None;
        self.notice = None;
        session::run(
            &backend,
            cx,
            async move {
                if provider == "vertex" {
                    commands::ai::import_credential(&state).await
                } else if remove {
                    commands::models::remove_openai_api_key(&state).map(|_| true)
                } else {
                    commands::models::save_openai_api_key(&state, key).map(|_| true)
                }
            },
            move |this, result, cx| {
                this.pending.remove("credential");
                match result {
                    Ok(true) => {
                        this.notice = Some(if remove {
                            this.t("APIキーを削除しました。", "API key removed.", cx)
                        } else {
                            this.t("認証情報を保存しました。", "Credential saved.", cx)
                        })
                    }
                    Ok(false) => {}
                    Err(error) => this.error = Some(error),
                }
                this.session.update(cx, |session, cx| session.refresh(cx));
                if let Some(key) = &this.key {
                    this.editors.update(cx, |registry, cx| {
                        registry.refresh(key, cx);
                    });
                }
            },
        );
    }
    fn model_change(
        &mut self,
        provider: &str,
        purpose: &str,
        key: &str,
        raw: &str,
        cx: &mut Context<Self>,
    ) {
        match forms::model_patch(&self.fields(cx), provider, purpose, key, raw) {
            Ok(patch) => self.change(patch, cx),
            Err(error) => self.error = Some(error),
        }
    }
    fn model_request_key(&self, provider: &str, purpose: &str, cx: &Context<Self>) -> String {
        let fields = self.fields(cx);
        format!(
            "{}:{}:{}",
            self.catalogue_key(cx),
            serde_json::to_string(&forms::model(&fields, provider, purpose)).unwrap_or_default(),
            serde_json::to_string(&forms::model_values(&fields, provider, purpose))
                .unwrap_or_default()
        )
    }
    fn public_price(&mut self, purpose: &str, cx: &mut Context<Self>) {
        let name = format!("price:{purpose}");
        if self.frozen(cx) || self.pending.contains(&name) {
            return;
        }
        let fields = self.fields(cx);
        let model = forms::model(&fields, "vertex", purpose);
        if model.model_id.trim().is_empty() {
            return;
        }
        let requested = self.model_request_key("vertex", purpose, cx);
        let purpose = purpose.to_owned();
        let backend = self.session.read(cx).backend.clone();
        let state = backend.state.clone();
        let location = fields.get("vertexLocation").cloned();
        self.pending.insert(name.clone());
        session::run(
            &backend,
            cx,
            async move {
                commands::models::lookup_vertex_price(
                    &state,
                    model.model_id.trim().into(),
                    location,
                )
                .await
            },
            move |this, result, cx| {
                this.pending.remove(&name);
                if this.model_request_key("vertex", &purpose, cx) != requested {
                    return;
                }
                let message=match result {
                Ok(result)=>if let Some(price)=result.price {
                    match forms::price_patch(&this.fields(cx),"vertex",&purpose,price){Ok(patch)=>this.change(patch,cx),Err(error)=>this.error=Some(error)}
                    this.t("公式SKUの最大単価を設定しました。","Applied the maximum public SKU rates.",cx)
                } else {this.t("適用単価を特定できませんでした。手動で設定するか料金未設定で利用できます。","Applicable rates could not be identified. Enter rates manually or use unknown pricing.",cx)},
                Err(error)=>format!("{} {error}",this.t("公式料金を取得できませんでした。Cloud Billing APIの設定を確認してください。","Could not retrieve public prices. Check your Cloud Billing API configuration.",cx)),
            };
                this.model_notices.insert(purpose, message);
            },
        );
    }
    fn model_choices(
        &self,
        provider: &str,
        purpose: &str,
        key: &str,
        current: &str,
        choices: Vec<(&'static str, String)>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let disabled = self.frozen(cx) || self.pending.contains(&format!("price:{purpose}"));
        row()
            .flex_wrap()
            .children(choices.into_iter().map(|(value, label)| {
                let provider = provider.to_owned();
                let purpose = purpose.to_owned();
                let key = key.to_owned();
                button(gpui_kit::SharedString::from(format!(
                    "model-choice-{provider}-{purpose}-{key}-{value}"
                )))
                .label(label)
                .selected(current == value)
                .disabled(disabled)
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.model_change(&provider, &purpose, &key, value, cx)
                }))
            }))
            .into_any_element()
    }
    fn model_input(
        &mut self,
        model: (&str, &str),
        key: &str,
        label: String,
        hint: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let (provider, purpose) = model;
        let values = forms::model_values(&self.fields(cx), provider, purpose);
        let raw = values.get(key).cloned().unwrap_or_default();
        let disabled = self.frozen(cx) || self.pending.contains(&format!("price:{purpose}"));
        let error = match key {
            "maxOutputTokens" if forms::valid_tokens(&raw, 1, 1_048_576).is_none() => Some(self.t(
                "1〜1,048,576の整数を入力してください。",
                "Enter a whole number from 1 to 1,048,576.",
                cx,
            )),
            "thinkingBudget" if forms::valid_tokens(&raw, 0, 65_536).is_none() => Some(self.t(
                "0〜65,536の整数を入力してください。",
                "Enter a whole number from 0 to 65,536.",
                cx,
            )),
            "input" | "output" | "audio" if !raw.is_empty() && forms::rate(&raw).is_none() => {
                Some(self.t(
                    "0〜1,000,000 USD、小数点以下6桁以内で入力してください。",
                    "Enter 0–1,000,000 USD with up to six decimal places.",
                    cx,
                ))
            }
            _ => None,
        };
        column()
            .gap_1()
            .child(self.input(
                &format!("model:{provider}:{purpose}:{key}"),
                (label, hint),
                raw,
                disabled,
                window,
                cx,
            ))
            .when_some(error, |view, error| {
                view.child(
                    div()
                        .text_size(px(13.))
                        .text_color(cx.theme().danger)
                        .child(error),
                )
            })
            .into_any_element()
    }
    pub(super) fn ai_panel(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let fields = self.fields(cx);
        let provider = fields
            .get("activeProvider")
            .map(String::as_str)
            .unwrap_or("vertex");
        let frozen = self.frozen(cx);
        let credential_busy = self.pending.contains("credential");
        let snapshot = self.session.read(cx).snapshot.clone();
        let mut panel=column().gap_5().child(self.choices("activeProvider",self.t("新しい依頼に使うAIサービス","AI provider for new requests",cx),vec![("vertex","Vertex AI".into()),("openai","OpenAI".into())],cx))
            .child(muted(self.t("設定と予算はサービスごとに保持します。実行中の依頼は元のサービスで続けます。","Each provider keeps its settings and budget. Existing jobs continue with their original provider.",cx)));
        if provider == "openai" {
            let configured = snapshot
                .as_ref()
                .is_some_and(|snapshot| snapshot.settings.openai.credential_configured);
            let raw = self
                .inputs
                .get("apiKey")
                .map(|binding| binding.state.read(cx).value().to_string())
                .unwrap_or_default();
            panel = panel.child(
                section(self.t("OpenAI認証", "OpenAI credentials", cx), cx)
                    .child(muted(if configured {
                        self.t("APIキーを設定済み", "API key configured", cx)
                    } else {
                        self.t("APIキー未設定", "No API key configured", cx)
                    }))
                    .child(self.input(
                        "apiKey",
                        (
                            self.t("OpenAI APIキー", "OpenAI API key", cx),
                            Some(self.t(
                                "このデバイスで保護して保存します。保存後にキーは表示されません。",
                                "Stored securely on this device. The saved key is never displayed.",
                                cx,
                            )),
                        ),
                        raw.clone(),
                        frozen || credential_busy,
                        window,
                        cx,
                    ))
                    .child(
                        row()
                            .flex_wrap()
                            .child(
                                button("openai-key-save")
                                    .primary()
                                    .label(self.t("APIキーを保存", "Save API key", cx))
                                    .disabled(frozen || credential_busy || raw.trim().is_empty())
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.credential("openai", false, window, cx)
                                    })),
                            )
                            .child(
                                button("openai-key-remove")
                                    .label(self.t("APIキーを削除", "Remove API key", cx))
                                    .disabled(frozen || credential_busy || !configured)
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.credential("openai", true, window, cx)
                                    })),
                            ),
                    ),
            );
        } else {
            let configured = snapshot
                .as_ref()
                .is_some_and(|snapshot| snapshot.settings.credential_configured);
            panel = panel.child(
                section("Vertex AI", cx)
                    .child(muted(if configured {
                        self.t(
                            "サービスアカウントを設定済み",
                            "Service account configured",
                            cx,
                        )
                    } else {
                        self.t(
                            "サービスアカウント未設定",
                            "No service account configured",
                            cx,
                        )
                    }))
                    .child(div().child(format!(
                        "{}: {}",
                        self.t("プロジェクトID", "Project ID", cx),
                        snapshot.as_ref().map_or("—", |snapshot| {
                            snapshot.settings.vertex_project.as_str()
                        })
                    )))
                    .child(muted(self.t(
                        "プロジェクトIDは読み込んだサービスアカウントから取得します。",
                        "The project ID comes from the imported service account.",
                        cx,
                    )))
                    .child(self.raw_input(
                        "vertexLocation",
                        self.t("ロケーション", "Location", cx),
                        Some("global / us-central1 / …".into()),
                        window,
                        cx,
                    ))
                    .child(
                        button("vertex-credential-import")
                            .label(self.t(
                                "サービスアカウントJSONを読み込む",
                                "Import service-account JSON",
                                cx,
                            ))
                            .disabled(frozen || credential_busy)
                            .loading(credential_busy)
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.credential("vertex", false, window, cx)
                            })),
                    ),
            );
        }
        let purpose = self.model_purpose;
        let model = forms::model(&fields, provider, purpose);
        let audio = provider == "openai" && purpose == "transcription";
        let mut model_section = section(self.t("用途ごとのモデル", "Models by task", cx), cx)
            .child(
                row().flex_wrap().children(
                    [
                        ("transcription", "文字起こし", "Transcription"),
                        ("translation", "翻訳", "Translation"),
                        ("explanation", "解説", "Explanation"),
                        ("vocabulary", "表現の抽出", "Vocabulary"),
                    ]
                    .into_iter()
                    .map(|(id, ja, en)| {
                        button(id)
                            .label(self.t(ja, en, cx))
                            .selected(id == purpose)
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.model_purpose = id;
                                cx.notify();
                            }))
                    }),
                ),
            )
            .child(
                button("model-discovery")
                    .label(self.t("サービスからモデル候補を取得", "Fetch model candidates", cx))
                    .disabled(frozen || self.pending.contains("models"))
                    .loading(self.pending.contains("models"))
                    .on_click(cx.listener(|this, _, _, cx| this.discover_models(cx))),
            )
            .child(self.model_input(
                (provider, purpose),
                "modelId",
                self.t("モデルID", "Model ID", cx),
                Some(self.t(
                    "候補から選ぶか、任意のIDを直接入力できます。",
                    "Choose a candidate or enter any model ID directly.",
                    cx,
                )),
                window,
                cx,
            ));
        if self.catalogue_identity == self.catalogue_key(cx) {
            let query = model.model_id.to_lowercase();
            let found: Vec<_> = self
                .catalogue
                .iter()
                .filter(|candidate| {
                    query.is_empty()
                        || candidate.id.to_lowercase().contains(&query)
                        || candidate.display_name.to_lowercase().contains(&query)
                })
                .collect();
            let mut choices = column().gap_1();
            for (index, candidate) in found.iter().take(12).enumerate() {
                let candidate_id = candidate.id.clone();
                let p = provider.to_owned();
                choices = choices.child(
                    button(("model-candidate", index))
                        .label(candidate.id.clone())
                        .tooltip(format!(
                            "{} {}",
                            candidate.display_name,
                            candidate.launch_stage.as_deref().unwrap_or("")
                        ))
                        .disabled(frozen)
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.model_change(&p, purpose, "modelId", &candidate_id, cx)
                        })),
                );
            }
            if found.len() > 12 {
                choices = choices.child(muted(self.t(
                    "モデルIDを入力すると候補を絞り込めます。",
                    "Type a model ID to narrow the candidates.",
                    cx,
                )));
            }
            model_section = model_section.child(choices);
        }
        if provider == "vertex" && purpose == "transcription" {
            model_section = model_section
                .child(div().child(self.t("字幕の作り方", "Subtitle generation", cx)))
                .child(self.model_choices(
                    provider,
                    purpose,
                    "transcriptionMode",
                    &model.transcription_mode,
                    vec![
                        (
                            "transcribe",
                            self.t("逐語・単語時刻", "Verbatim and word timing", cx),
                        ),
                        (
                            "subtitles",
                            self.t("字幕区間を生成", "Generate timed cues", cx),
                        ),
                    ],
                    cx,
                ));
        }
        if !audio {
            let p = provider.to_owned();
            model_section=model_section.child(self.model_input((provider,purpose),"maxOutputTokens",self.t("1要求の出力トークン上限","Maximum output tokens per request",cx),Some(self.t("小さすぎると回答が途中で切れます。大きい値は最大費用の見積もりを増やします。","A small limit can truncate an answer. A large limit increases the maximum cost estimate.",cx)),window,cx))
                .child(button("model-standard-tokens").label(format!("{} ({})",self.t("標準に戻す","Use standard limit",cx),forms::recommended_tokens(purpose))).disabled(frozen)
                    .on_click(cx.listener(move|this,_,_,cx|this.model_change(&p,purpose,"standardTokens","",cx))));
        }
        if provider == "vertex" {
            let mode = if model.thinking_level.is_some() {
                "level"
            } else if model.thinking_budget.is_some() {
                "budget"
            } else {
                "omit"
            };
            model_section = model_section
                .child(div().child(self.t("思考設定", "Thinking configuration", cx)))
                .child(self.model_choices(
                    provider,
                    purpose,
                    "thinkingMode",
                    mode,
                    vec![
                        ("omit", self.t("モデル既定値", "Model default", cx)),
                        ("level", self.t("レベル指定", "Set level", cx)),
                        ("budget", self.t("トークン予算", "Token budget", cx)),
                    ],
                    cx,
                ));
            if mode == "level" {
                model_section = model_section.child(
                    self.model_choices(
                        provider,
                        purpose,
                        "thinkingLevel",
                        model.thinking_level.as_deref().unwrap_or("LOW"),
                        ["MINIMAL", "LOW", "MEDIUM", "HIGH"]
                            .into_iter()
                            .map(|level| (level, level.into()))
                            .collect(),
                        cx,
                    ),
                );
            }
            if mode == "budget" {
                model_section = model_section.child(self.model_input(
                    (provider, purpose),
                    "thinkingBudget",
                    self.t("思考トークン予算", "Thinking token budget", cx),
                    None,
                    window,
                    cx,
                ));
            }
            model_section=model_section.child(muted(self.t("未対応の設定はAPIエラーになります。設定を変えて自動再送することはありません。","Unsupported settings produce an API error; settings are not changed and retried automatically.",cx)));
        }
        model_section = model_section.child(
            div()
                .text_size(px(17.))
                .child(self.t("料金", "Pricing", cx)),
        );
        if audio {
            model_section = model_section.child(self.model_input(
                (provider, purpose),
                "audio",
                self.t("音声 USD / 分", "Audio USD / minute", cx),
                None,
                window,
                cx,
            ));
        } else {
            model_section = model_section
                .child(self.model_input(
                    (provider, purpose),
                    "input",
                    self.t("入力 USD / 100万トークン", "Input USD / million tokens", cx),
                    None,
                    window,
                    cx,
                ))
                .child(self.model_input(
                    (provider, purpose),
                    "output",
                    self.t(
                        "出力 USD / 100万トークン",
                        "Output USD / million tokens",
                        cx,
                    ),
                    None,
                    window,
                    cx,
                ));
        }
        let p = provider.to_owned();
        let mut prices = row().flex_wrap();
        if provider == "vertex" {
            prices = prices.child(
                button("public-model-pricing")
                    .label(self.t("公式料金を取得", "Retrieve public prices", cx))
                    .disabled(
                        frozen
                            || model.model_id.trim().is_empty()
                            || self.pending.contains(&format!("price:{purpose}")),
                    )
                    .on_click(cx.listener(move |this, _, _, cx| this.public_price(purpose, cx))),
            );
        }
        prices = prices.child(
            button("clear-model-pricing")
                .label(self.t("料金未設定に戻す", "Clear pricing", cx))
                .disabled(frozen || model.price.is_none())
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.model_change(&p, purpose, "clearPrice", "", cx)
                })),
        );
        model_section=model_section.child(prices).child(muted(if let Some(price)=&model.price{
            if audio {format!("{}: ${:.6} / min",self.t("設定済み","Configured",cx),price.audio_microusd_per_minute.unwrap_or(0) as f64/1_000_000.)}
            else {format!("{}: ${:.6} / ${:.6} (1M tokens)",price.source,price.input_microusd_per_million as f64/1_000_000.,price.output_microusd_per_million as f64/1_000_000.)}
        }else{self.t("料金未設定です。送信範囲を承認して利用できますが、金額上限は算定できません。","Pricing is unset. You can approve a request scope, but a dollar limit cannot be calculated.",cx)}));
        if provider == "openai" {
            model_section=model_section.child(muted(self.t("OpenAI APIから料金は取得できません。公式料金を確認して入力してください。","The OpenAI API does not provide pricing. Check official prices and enter rates manually.",cx)));
        }
        if let Some(notice) = self.model_notices.get(purpose) {
            model_section = model_section.child(muted(notice.clone()));
        }
        panel
            .child(model_section)
            .child(self.budget_panel(window, cx))
            .child(
                button("settings-paused-jobs")
                    .label(self.t("保留中の依頼を確認", "Review pending requests", cx))
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.session
                            .update(cx, |session, cx| session.navigate(Route::Activity, cx))
                    })),
            )
            .into_any_element()
    }
}

pub(super) fn section(
    heading: impl Into<gpui_kit::SharedString>,
    cx: &gpui_kit::App,
) -> gpui_kit::Div {
    super::render::settings_card(cx).child(
        div()
            .text_size(px(20.))
            .font_weight(gpui_kit::FontWeight::MEDIUM)
            .child(heading.into()),
    )
}
