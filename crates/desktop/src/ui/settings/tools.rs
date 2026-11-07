use super::*;

impl SettingsView {
    pub(super) fn scan_tools(&mut self, rescan: bool, cx: &mut Context<Self>) {
        if self.pending.contains("scan") || (rescan && self.frozen(cx)) {
            return;
        }
        self.pending.insert("scan".into());
        let backend = self.session.read(cx).backend.clone();
        let state = backend.state.clone();
        session::run(
            &backend,
            cx,
            async move { commands::media_tools::scan_external_tools(&state, Some(rescan)) },
            |this, result, _| {
                this.pending.remove("scan");
                match result {
                    Ok(candidates) => this.candidates = candidates,
                    Err(error) => this.error = Some(error),
                }
            },
        );
    }
    fn tool_action(
        &mut self,
        id: &str,
        action: &str,
        path: Option<String>,
        cx: &mut Context<Self>,
    ) {
        let state = self.session.read(cx).backend.state.clone();
        let id = id.to_owned();
        let action = action.to_owned();
        let name = format!("tool:{id}");
        let success = self.t(
            "ツールの設定を更新しました。",
            "Tool configuration updated.",
            cx,
        );
        self.action(
            &name,
            success,
            async move {
                match action.as_str() {
                    "install" => commands::media_tools::install_tool(&state, id).await,
                    "update" => commands::media_tools::update_tool(&state, id).await,
                    "rollback" => commands::media_tools::rollback_tool(&state, id),
                    "managed" | "external" => {
                        commands::media_tools::set_tool_provider(
                            &state,
                            crate::application::tool_runtime::ProviderRequest {
                                tool_id: id,
                                provider: action,
                                path,
                            },
                        )
                        .await
                    }
                    _ => Err("Unknown tool action".into()),
                }
            },
            cx,
        );
    }
    pub(super) fn tools_panel(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let frozen = self.frozen(cx);
        let mut content=column().gap_5().child(row().flex_wrap()
            .child(compact_button("tool-update-check").label(self.t("更新を確認","Check updates",cx)).disabled(frozen||self.pending.contains("updates")).loading(self.pending.contains("updates"))
                .on_click(cx.listener(|this,_,_,cx|{let state=this.session.read(cx).backend.state.clone();let notice=this.t("更新情報を確認しました。","Update information checked.",cx);this.action("updates",notice,async move{commands::tool_updates::check_tool_updates(&state).await},cx);})))
            .child(compact_button("tool-rescan").label(self.t("PATHを再検索","Rescan PATH",cx)).disabled(frozen||self.pending.contains("scan")).loading(self.pending.contains("scan"))
                .on_click(cx.listener(|this,_,_,cx|this.scan_tools(true,cx)))))
            .child(muted(self.t("動画プレイヤーとCPU推論ランタイムは同梱されています。FFmpegとffprobeはペアで使用します。","The native player and CPU inference runtime are bundled. FFmpeg and ffprobe are used as a pair.",cx)));
        let snapshot = self.session.read(cx).snapshot.clone();
        if let Some(snapshot) = snapshot {
            for tool in &snapshot.tools {
                let id = tool.id.clone();
                let busy = frozen
                    || self.pending.contains(&format!("tool:{id}"))
                    || self.operations.iter().any(|operation| {
                        operation.tool_id.as_deref() == Some(id.as_str())
                            && operation.status == "running"
                    });
                let mut section = column()
                    .py_5()
                    .border_b_1()
                    .border_color(cx.theme().border)
                    .gap_3()
                    .child(
                        row()
                            .justify_between()
                            .child(
                                div()
                                    .text_size(px(15.))
                                    .font_weight(gpui_kit::FontWeight::MEDIUM)
                                    .child(tool.name.clone()),
                            )
                            .child(muted(if tool.status == "ready" {
                                self.t("利用可能", "Ready", cx)
                            } else {
                                self.t("要セットアップ", "Setup needed", cx)
                            })),
                    )
                    .child(muted(format!(
                        "{}  /  {}",
                        tool.version.as_deref().unwrap_or("—"),
                        if tool.provider == "managed" {
                            self.t("Surtitleが管理", "Managed by Surtitle", cx)
                        } else {
                            self.t("外部ツール", "External tool", cx)
                        }
                    )));
                if let Some(path) = &tool.path {
                    section = section.child(
                        div()
                            .px_3()
                            .py_2()
                            .rounded(px(6.))
                            .bg(cx.theme().background)
                            .child(muted(path.clone())),
                    );
                }
                if let Some(error) = &tool.error {
                    section =
                        section.child(div().text_color(cx.theme().danger).child(error.clone()));
                }
                if tool.update_available {
                    section = section.child(muted(format!(
                        "{} {}",
                        self.t("利用できる更新:", "Update available:", cx),
                        tool.latest_version.as_deref().unwrap_or("")
                    )));
                }
                for operation in self.operations.iter().filter(|operation| {
                    operation.tool_id.as_deref() == Some(id.as_str())
                        && operation.status == "running"
                }) {
                    section = section.child(muted(format!(
                        "{}  {} / {} {}",
                        operation.phase,
                        operation
                            .completed
                            .map_or("—".into(), |value| value.to_string()),
                        operation
                            .total
                            .map_or("—".into(), |value| value.to_string()),
                        operation.unit.as_deref().unwrap_or("")
                    )));
                }
                let mut actions = row().flex_wrap();
                if id != "vad" {
                    let managed = id.clone();
                    let external = id.clone();
                    actions = actions
                        .child(
                            compact_button(gpui_kit::SharedString::from(format!("managed-{id}")))
                                .label(self.t("アプリ管理", "Managed", cx))
                                .disabled(busy)
                                .selected(
                                    tool.provider == "managed"
                                        && !self.choose_external.contains(&id),
                                )
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.choose_external.remove(&managed);
                                    this.tool_action(&managed, "managed", None, cx);
                                })),
                        )
                        .child(
                            compact_button(gpui_kit::SharedString::from(format!("external-{id}")))
                                .label(self.t("外部を使う", "External", cx))
                                .disabled(busy)
                                .selected(self.choose_external.contains(&id))
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.choose_external.insert(external.clone());
                                    cx.notify();
                                })),
                        );
                }
                if tool.provider == "managed" {
                    let action_id = id.clone();
                    let action = if tool.status == "ready" {
                        "update"
                    } else {
                        "install"
                    };
                    actions = actions.child(
                        compact_button(gpui_kit::SharedString::from(format!("install-{id}")))
                            .label(if action == "update" {
                                self.t("更新する", "Update tool", cx)
                            } else {
                                self.t("ダウンロード", "Download", cx)
                            })
                            .disabled(busy)
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.tool_action(&action_id, action, None, cx)
                            })),
                    );
                    if tool.can_rollback {
                        let rollback = id.clone();
                        actions = actions.child(
                            compact_button(gpui_kit::SharedString::from(format!("rollback-{id}")))
                                .label(self.t("前の版へ", "Roll back", cx))
                                .disabled(busy)
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.tool_action(&rollback, "rollback", None, cx)
                                })),
                        );
                    }
                }
                section = section.child(actions);
                if self.choose_external.contains(&id) {
                    let name = format!("toolPath:{id}");
                    let path = self
                        .inputs
                        .get(&name)
                        .map(|binding| binding.state.read(cx).value().to_string())
                        .unwrap_or_else(|| tool.path.clone().unwrap_or_default());
                    section = section.child(muted(self.t(
                        "候補は未検証です。パスを選び、検証してから適用します。",
                        "Candidates are unverified. Choose a path, then verify and apply it.",
                        cx,
                    )));
                    for (index, candidate) in self
                        .candidates
                        .iter()
                        .filter(|candidate| candidate.tool_id == id)
                        .enumerate()
                    {
                        let path = candidate.path.clone();
                        let field = name.clone();
                        section = section.child(
                            column()
                                .gap_1()
                                .child(muted(candidate.path.clone()))
                                .when_some(candidate.reason.clone(), |row, reason| {
                                    row.child(muted(reason))
                                })
                                .child(
                                    compact_button(gpui_kit::SharedString::from(format!(
                                        "candidate-{id}-{index}"
                                    )))
                                    .label(self.t("この候補を選択", "Choose candidate", cx))
                                    .disabled(busy || !candidate.selectable)
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        this.ensure_input(&field, &path, false, window, cx);
                                        cx.notify();
                                    })),
                                ),
                        );
                    }
                    let label = self.t("実行ファイルの絶対パス", "Absolute executable path", cx);
                    let hint = self.t(
                        "選んだ外部ツールをSurtitleが更新・削除することはありません。",
                        "Surtitle does not update or delete the selected external tool.",
                        cx,
                    );
                    section = section.child(self.input(
                        &name,
                        (label, Some(hint)),
                        path.clone(),
                        busy,
                        window,
                        cx,
                    ));
                    let verify = id.clone();
                    let field = name.clone();
                    section = section.child(
                        compact_button(gpui_kit::SharedString::from(format!("verify-{id}")))
                            .primary()
                            .label(self.t("検証してこのパスを使用", "Verify and use this path", cx))
                            .disabled(busy || path.trim().is_empty())
                            .on_click(cx.listener(move |this, _, _, cx| {
                                let path = this.inputs.get(&field).map(|binding| {
                                    binding.state.read(cx).value().trim().to_owned()
                                });
                                this.tool_action(&verify, "external", path, cx);
                            })),
                    );
                }
                content = content.child(section);
            }
        }
        content.into_any_element()
    }
}
