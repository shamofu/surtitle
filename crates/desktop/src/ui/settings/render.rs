use super::*;
use gpui_kit::component::switch::Switch;

impl SettingsView {
    fn learning_panel(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let fields = self.fields(cx);
        let frozen = self.frozen(cx);
        let learning = self.raw_input(
            "learningLanguage",
            self.t("学習する言語", "Learning language", cx),
            Some(self.t(
                "一覧にない言語はコードでも指定できます。",
                "You can also enter a language code.",
                cx,
            )),
            window,
            cx,
        );
        let explanation = self.raw_input(
            "explanationLanguage",
            self.t("説明・翻訳の言語", "Explanation language", cx),
            None,
            window,
            cx,
        );
        let proficiency = self.choices(
            "proficiency",
            self.t("学習レベルの目安", "Learning level", cx),
            [
                (
                    "A1",
                    "挨拶や簡単な自己紹介ができる",
                    "Greetings and simple introductions",
                ),
                (
                    "A2",
                    "買い物など身近な会話ができる",
                    "Everyday exchanges, such as shopping",
                ),
                (
                    "B1",
                    "経験や考えを日常的な言葉で説明できる",
                    "Explain experiences and opinions in everyday language",
                ),
                (
                    "B2",
                    "複雑な話題でも議論や説明ができる",
                    "Discuss and explain complex topics",
                ),
                (
                    "C1",
                    "専門的な内容を理解し柔軟に表現できる",
                    "Understand specialist content and express yourself flexibly",
                ),
                (
                    "C2",
                    "細かなニュアンスまで理解し表現できる",
                    "Understand and express subtle nuances",
                ),
            ]
            .into_iter()
            .map(|(level, ja, en)| (level, format!("{level} — {}", self.t(ja, en, cx))))
            .collect(),
            cx,
        );
        let retention = self.choices(
            "retentionInput",
            self.t("復習の頻度", "Review frequency", cx),
            vec![
                (
                    "85",
                    self.t("少なめ — 復習の負担を抑える", "Lighter — fewer reviews", cx),
                ),
                (
                    "90",
                    self.t(
                        "標準（おすすめ）— バランスよく復習",
                        "Standard (recommended) — balanced reviews",
                        cx,
                    ),
                ),
                (
                    "95",
                    self.t(
                        "多め — 忘れる前にこまめに復習",
                        "More frequent — review before forgetting",
                        cx,
                    ),
                ),
                (
                    "custom",
                    self.t("カスタム — 詳細を調整", "Custom — adjust the details", cx),
                ),
            ],
            cx,
        );
        let custom = self.retention_details
            || fields
                .get("retentionInput")
                .is_none_or(|value| !["85", "90", "95"].contains(&value.as_str()));
        let mut review = column()
            .flex_1()
            .min_w(px(260.))
            .gap_2()
            .child(retention)
            .child(muted(self.t(
                "記憶力の自己評価は不要です。復習の負担に合わせて選べます。",
                "No need to judge your memory. Choose the review workload that suits you.",
                cx,
            )))
            .child(
                div().child(
                    compact_button("settings-retention-details")
                        .ghost()
                        .icon(if custom {
                            IconName::ChevronDown
                        } else {
                            IconName::ChevronRight
                        })
                        .label(self.t("復習の詳細設定", "Advanced review settings", cx))
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.retention_details = !this.retention_details;
                            cx.notify();
                        })),
                ),
            );
        if custom {
            review = review.child(self.raw_input(
                "retentionInput",
                self.t("目標の記憶保持率（%）", "Target retention (%)", cx),
                Some(self.t(
                    "高い値ほど復習が増えます。70〜97%、標準は90%です。",
                    "Higher values mean more reviews. Range: 70–97%; standard: 90%.",
                    cx,
                )),
                window,
                cx,
            ));
        }
        let playback=self.raw_input("replayContextMs",self.t("区間再生の前後の余白（ms）","Playback context on each side (ms)",cx),Some(self.t("出典の再生・リピートと新しく保存する音声に適用します。字幕の時刻や既存のカード音声は変わりません。","Applies to source playback, repeat and newly saved audio. Subtitle times and existing card audio stay unchanged.",cx)),window,cx);
        settings_card(cx).child(section_heading(IconName::Globe,self.t("学習","Learning",cx),Some(self.t("新しい教材に使う初期設定です。教材ごとに言語を選べます。","Defaults for new content. Choose languages for each import.",cx)),cx))
            .child(row().items_start().gap_4().flex_wrap().child(div().flex_1().min_w(px(260.)).child(learning)).child(div().flex_1().min_w(px(260.)).child(explanation)))
            .child(row().items_start().gap_4().flex_wrap()
                .child(column().flex_1().min_w(px(260.)).gap_2().child(proficiency).child(muted(self.t("選択した表現のAI解説の難しさに反映します。迷ったらB1から始め、解説に合わせて調整してください。","Controls the difficulty of AI explanations for selected phrases. Start at B1 if unsure, then adjust to suit the explanations.",cx))))
                .child(review))
            .child(playback)
            .child(column().pt_4().border_t_1().border_color(cx.theme().border).gap_3()
                .child(Switch::new("settings-sentence-pause").label(self.t("文末で一時停止","Pause at sentence boundaries",cx)).checked(fields.get("sentencePause").is_some_and(|raw|raw=="true")).disabled(frozen).on_change(cx.listener(|this,checked:&bool,_,cx|this.change_one("sentencePause",if *checked{"true"}else{"false"},cx))))
                .child(self.choices("captionGapMode",self.t("字幕のない区間","Gaps between subtitles",cx),vec![("review",self.t("直前の字幕を表示","Review previous subtitle",cx)),("preview",self.t("次の字幕を表示","Preview next subtitle",cx))],cx)))
            .into_any_element()
    }
    fn appearance_panel(&self, cx: &mut Context<Self>) -> AnyElement {
        settings_card(cx)
            .child(section_heading(
                IconName::SlidersHorizontal,
                self.t("表示", "Appearance", cx),
                None,
                cx,
            ))
            .child(
                row()
                    .items_start()
                    .gap_4()
                    .flex_wrap()
                    .child(div().flex_1().min_w(px(240.)).child(self.choices(
                        "locale",
                        self.t("表示言語", "Interface language", cx),
                        vec![("ja", "日本語".into()), ("en", "English".into())],
                        cx,
                    )))
                    .child(div().flex_1().min_w(px(240.)).child(self.choices(
                        "theme",
                        self.t("テーマ", "Theme", cx),
                        vec![
                            ("dark", self.t("ダーク", "Dark", cx)),
                            ("light", self.t("ライト", "Light", cx)),
                            ("system", self.t("システムに合わせる", "System", cx)),
                        ],
                        cx,
                    ))),
            )
            .child(self.choices(
                "motionPreference",
                self.t("アニメーション", "Animations", cx),
                vec![
                    (
                        "system",
                        self.t("OS設定に従う", "Follow system settings", cx),
                    ),
                    (
                        "reduce",
                        self.t("アニメーションを減らす", "Reduce motion", cx),
                    ),
                ],
                cx,
            ))
            .child(muted(self.t(
                "動きを減らすと、画面の切り替えや開閉をすぐに完了します。",
                "Reduced motion makes transitions and dialogs complete immediately.",
                cx,
            )))
            .child(
                column()
                    .pt_5()
                    .border_t_1()
                    .border_color(cx.theme().border)
                    .child(
                        div()
                            .text_size(px(18.))
                            .font_weight(gpui_kit::FontWeight::MEDIUM)
                            .child(self.t("ウィンドウサイズ", "Window size", cx)),
                    )
                    .child(muted(self.t(
                        "画面に収まらない場合は作業領域に合わせて縮小します。",
                        "Sizes are reduced to fit the display work area when needed.",
                        cx,
                    )))
                    .child(
                        row().flex_wrap().gap_2().children(
                            [
                                ("hd", "1280 × 720"),
                                ("standard", "1600 × 900"),
                                ("full-hd", "1920 × 1080"),
                            ]
                            .into_iter()
                            .map(|(preset, label)| {
                                button(preset)
                                    .label(label)
                                    .disabled(
                                        self.frozen(cx) || self.pending.contains("window-size"),
                                    )
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        let host = this.session.read(cx).backend.host.clone();
                                        let message = this.t(
                                            "ウィンドウサイズを変更しました。",
                                            "Window size updated.",
                                            cx,
                                        );
                                        this.action(
                                            "window-size",
                                            message,
                                            async move {
                                                commands::window::set_window_size_preset(
                                                    host,
                                                    preset.into(),
                                                )
                                                .await
                                            },
                                            cx,
                                        );
                                    }))
                            }),
                        ),
                    ),
            )
            .into_any_element()
    }
    pub(super) fn budget_panel(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let fields = self.fields(cx);
        let provider = self.budget_provider.clone().unwrap_or_else(|| {
            fields
                .get("activeProvider")
                .cloned()
                .unwrap_or_else(|| "vertex".into())
        });
        let frozen = self.frozen(cx);
        let snapshot = self.session.read(cx).snapshot.clone();
        let mut section =
            models::section(self.t("AIの利用額と予算", "AI usage and budgets", cx), cx);
        if let Some(snapshot) = snapshot {
            for (service, summary) in &snapshot.budgets {
                let label = if *service == surtitle_core::AiProvider::Openai {
                    "OpenAI"
                } else {
                    "Vertex AI"
                };
                let amounts = [
                    (
                        self.t("今月の算定済み利用額", "Calculated spending this month", cx),
                        format!("${:.6}", summary.spent_usd),
                    ),
                    (
                        self.t("現在の予約額", "Current reservations", cx),
                        format!("${:.6}", summary.reserved_usd),
                    ),
                    (
                        self.t("保存済みの月額上限", "Saved monthly limit", cx),
                        if summary.limit_usd == 0. {
                            self.t("上限なし", "Unlimited", cx)
                        } else {
                            format!("${:.2}", summary.limit_usd)
                        },
                    ),
                ];
                section=section.child(column().gap_3().child(div().text_size(px(15.)).font_weight(gpui_kit::FontWeight::MEDIUM).child(label))
                    .child(row().gap_0().items_stretch().border_1().border_color(cx.theme().border).rounded(px(9.)).bg(cx.theme().background)
                        .children(amounts.into_iter().enumerate().map(|(index,(label,amount))|column().flex_1().min_w(px(0.)).px_4().py_4().gap_2()
                            .when(index>0,|cell|cell.border_l_1().border_color(cx.theme().border)).child(muted(label)).child(div().text_size(px(23.)).font_weight(gpui_kit::FontWeight::MEDIUM).child(amount)))))
                    .when(!summary.monetary_totals_complete,|view|view.child(muted(self.t(&format!("料金未算定の{}件は上記に含みません。請求総額ではありません。",summary.unpriced_attempts),&format!("{} unpriced requests are excluded. These amounts are not your total bill.",summary.unpriced_attempts),cx)))));
            }
        }
        section=section.child(div().child(self.t("予算を編集するサービス","Budget provider",cx)))
            .child(row().children([("vertex","Vertex AI"),("openai","OpenAI")].into_iter().map(|(id,label)|{
                button(gpui_kit::SharedString::from(format!("budget-provider-{id}"))).label(label).selected(provider==id).disabled(frozen)
                    .on_click(cx.listener(move|this,_,_,cx|{this.budget_provider=Some(id.into());cx.notify();}))
            })))
            .child(muted(self.t("ここで予算の編集先を選んでも、新しい依頼のサービスは変わりません。0はその期間・処理の上限なしです。","Choosing a budget provider does not change the provider for new requests. Zero removes that period or job limit.",cx)));
        for (key, ja, en) in [
            (
                "monthlyBudgetUsd",
                "1か月のAI予算（USD）",
                "Monthly AI budget (USD)",
            ),
            ("dailyBudgetUsd", "1日の上限（USD）", "Daily limit (USD)"),
            (
                "perJobBudgetUsd",
                "1処理の上限（USD）",
                "Per-job limit (USD)",
            ),
        ] {
            let field = forms::budget_key(&provider, key);
            section = section.child(self.raw_input(
                &field,
                self.t(ja, en, cx),
                Some(self.t(
                    if key == "perJobBudgetUsd" {
                        "1処理に複数のリクエストが含まれる場合があります。"
                    } else {
                        "UTC基準の暦月・暦日で集計します。"
                    },
                    if key == "perJobBudgetUsd" {
                        "One job may contain multiple requests."
                    } else {
                        "Usage follows UTC calendar months and days."
                    },
                    cx,
                )),
                window,
                cx,
            ));
            if key != "monthlyBudgetUsd" {
                let monthly = fields
                    .get(&forms::budget_key(&provider, "monthlyBudgetUsd"))
                    .cloned()
                    .unwrap_or_default();
                let field_key = field.clone();
                section = section.child(
                    button(gpui_kit::SharedString::from(format!("match-monthly-{key}")))
                        .label(self.t("月額と同じに戻す", "Match monthly budget", cx))
                        .disabled(
                            frozen
                                || forms::number(&monthly).is_none()
                                || fields.get(&field) == Some(&monthly),
                        )
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.input_changed(&field_key, &monthly, cx)
                        })),
                );
            }
        }
        section.child(muted(self.t("月額と同じ日額・処理上限は月額変更に追従し、独立した上限は維持します。料金未設定の処理は金額上限の対象外で、送信範囲を別途承認します。","Daily and per-job caps matching the monthly cap follow its changes; independent caps stay unchanged. Unpriced requests require separate approval of their scope.",cx)))
            .child(muted(self.t("結果不明の依頼は自動再試行せず、日・月が変わっても予約額を維持します。復元でも利用額は巻き戻りません。","Unknown requests are not retried automatically and retain reservations across days and months. Restoring a backup does not roll back spending.",cx))).into_any_element()
    }
    fn data_panel(&self, cx: &mut Context<Self>) -> AnyElement {
        column().gap_4().child(muted(self.t("CSV・TSVはフレーズ一覧、JSONは学習履歴を含むデータ、ZIPは保存した復習音声も含みます。元の動画と認証情報は含みません。","CSV and TSV export phrases. JSON preserves learning history. ZIP includes saved review audio. Original media and credentials are excluded.",cx)))
            .child(button("settings-transfer").primary().label(self.t("エクスポート・復元を開く","Export or restore",cx)).disabled(self.frozen(cx))
                .on_click(cx.listener(|this,_,_,cx|this.session.update(cx,|session,cx|session.request_transfer(cx)))))
            .child(button("settings-recovery").label(self.t("保存されている未完了の入力","Recovered unfinished input",cx)).disabled(self.frozen(cx))
                .on_click(cx.listener(|this,_,_,cx|this.session.update(cx,|session,cx|session.request_recovery(cx))))).into_any_element()
    }
}

impl Render for SettingsView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let editing = self.editing(cx);
        let frozen = self.editors.read(cx).frozen();
        let content = match self.category {
            "appearance" => self.appearance_panel(cx),
            "ai" => self.ai_panel(window, cx),
            "tools" => settings_card(cx)
                .child(section_heading(
                    IconName::Wrench,
                    self.t("外部ツール", "External tools", cx),
                    None,
                    cx,
                ))
                .child(self.tools_panel(window, cx))
                .into_any_element(),
            "data" => settings_card(cx)
                .child(section_heading(
                    IconName::Archive,
                    self.t("データ", "Data", cx),
                    None,
                    cx,
                ))
                .child(self.data_panel(cx))
                .into_any_element(),
            _ => self.learning_panel(window, cx),
        };
        let status = if frozen {
            self.t(
                "処理を完了するまで入力を一時停止しています。",
                "Editing is paused while the current operation finishes.",
                cx,
            )
        } else if !editing.ready {
            self.t("設定を読み込み中…", "Loading settings…", cx)
        } else if editing.saving {
            self.t("保存中…", "Saving…", cx)
        } else if editing.dirty {
            self.t(
                "入力途中の内容を保持しています。有効な変更は自動保存します。",
                "Unfinished input is kept. Valid changes save automatically.",
                cx,
            )
        } else {
            self.t(
                "変更は自動保存されます。",
                "Changes save automatically.",
                cx,
            )
        };
        let error = editing.error.clone().or_else(|| self.error.clone());
        let compact = window.viewport_size().width < px(980.);
        let nav = column()
            .gap_1()
            .w(px(168.))
            .flex_shrink_0()
            .when(compact, |nav| nav.w_full().flex_row().flex_wrap())
            .children(
                [
                    ("learning", "学習", "Learning", IconName::Globe),
                    (
                        "appearance",
                        "表示",
                        "Appearance",
                        IconName::SlidersHorizontal,
                    ),
                    ("ai", "AI", "AI", IconName::KeyRound),
                    ("tools", "ツール", "Tools", IconName::Wrench),
                    ("data", "データ", "Data", IconName::Archive),
                ]
                .into_iter()
                .map(|(id, ja, en, icon)| {
                    let selected = self.category == id;
                    button(gpui_kit::SharedString::from(format!("settings-tab-{id}")))
                        .ghost()
                        .icon(icon)
                        .label(self.t(ja, en, cx))
                        .selected(selected)
                        .justify_start()
                        .h(px(50.))
                        .px_3()
                        .when(!compact, |button| button.w_full())
                        .when(selected, |button| {
                            button
                                .bg(cx.theme().accent)
                                .border_1()
                                .border_color(cx.theme().primary)
                                .text_color(cx.theme().primary)
                        })
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.blur(cx);
                            this.category = id;
                            cx.notify();
                        }))
                }),
            );
        column().size_full().gap_0().text_color(cx.theme().foreground).bg(cx.theme().background)
            .child(column().px_6().pt_8().pb_6().gap_2()
                .child(title(self.t("設定","Settings",cx)))
                .child(div().text_size(px(15.)).text_color(cx.theme().muted_foreground).child(self.t("学習・AI・外部ツールの設定を調整できます。","Adjust your learning, AI, and external tool settings.",cx))))
            .child(row().items_start().gap_6().px_6().flex_1().min_h(px(0.)).when(compact,|body|body.flex_col().gap_4())
                .child(nav)
                .child(div().id("settings-scroll").flex_1().min_w(px(0.)).h_full().overflow_y_scroll().pb_6()
                    .child(column().w_full().gap_4().child(content)
                        .when_some(self.notice.clone(),|body,notice|body.child(muted(notice)))
                        .when_some(editing.recovery.clone(),|body,recovery|body.child(settings_card(cx)
                            .child(div().child(self.t("以前の設定に対する入力が保存されています。","Input from an earlier settings revision is available.",cx)))
                            .child(muted(recovery.keys().filter(|key|!matches!(key.as_str(),"baseRevision"|"recovery")).cloned().collect::<Vec<_>>().join(", ")))
                            .child(button("settings-recover-input").label(self.t("この入力から編集を続ける","Continue editing this input",cx)).disabled(frozen).on_click(cx.listener(|this,_,_,cx|{
                                if let Some(key)=&this.key {this.editors.update(cx,|registry,cx|registry.recover(key,cx));}
                            }))))))))
            .child(
                column()
                    .px_6()
                    .py_3()
                    .border_t_1()
                    .border_color(cx.theme().border)
                    .gap_2()
                    .child(muted(status))
                    .when_some(error, |view, error| {
                        view.child(
                            row()
                                .flex_wrap()
                                .child(div().flex_1().text_color(cx.theme().danger).child(error))
                                .child(
                                    button("settings-retry")
                                        .label(self.t("再試行", "Retry", cx))
                                        .disabled(frozen)
                                        .on_click(cx.listener(|this, _, _, cx| {
                                            this.error = None;
                                            this.blur(cx);
                                            this.session
                                                .update(cx, |session, cx| session.refresh(cx));
                                        })),
                                ),
                        )
                    })
                    .when(!editing.ready, |view| {
                        view.child(
                            button("settings-reload")
                                .label(self.t("設定を再読み込み", "Reload settings", cx))
                                .disabled(frozen)
                                .on_click(cx.listener(|this, _, _, cx| {
                                    if let Some(key) = &this.key {
                                        this.editors.update(cx, |registry, cx| {
                                            registry.refresh(key, cx);
                                        });
                                    }
                                    this.session.update(cx, |session, cx| session.refresh(cx));
                                })),
                        )
                    }),
            )
    }
}

pub(super) fn settings_card(cx: &gpui_kit::App) -> gpui_kit::Div {
    column()
        .p_6()
        .gap_5()
        .rounded(px(12.))
        .border_1()
        .border_color(cx.theme().border)
        .bg(cx.theme().popover)
}
pub(super) fn section_heading(
    icon: IconName,
    heading: String,
    description: Option<String>,
    cx: &gpui_kit::App,
) -> gpui_kit::Div {
    row()
        .items_start()
        .gap_3()
        .mb_1()
        .child(Icon::new(icon).size(px(20.)).text_color(cx.theme().primary))
        .child(
            column()
                .flex_1()
                .gap_1()
                .child(
                    div()
                        .text_size(px(20.))
                        .font_weight(gpui_kit::FontWeight::MEDIUM)
                        .child(heading),
                )
                .when_some(description, |body, text| {
                    body.child(
                        div()
                            .text_size(px(13.))
                            .line_height(gpui_kit::relative(1.9))
                            .text_color(cx.theme().muted_foreground)
                            .child(text),
                    )
                }),
        )
}
