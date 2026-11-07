// SPDX-License-Identifier: GPL-3.0-or-later
//! Owned native backup/export dialog. The root owns the combined save barrier.
use super::{
    DesktopView,
    session::{Session, run},
    style::{column, muted, row, title},
};
use crate::{
    application::transfer::{RestorePreview, RestoreResult},
    commands,
};
use gpui_kit::component::{
    ActiveTheme, Disableable,
    button::{Button, ButtonVariants},
};
use gpui_kit::{
    AnyWindowHandle, AppContext, Context, Entity, WeakEntity, Window, div, prelude::*, px, size,
};

pub(crate) enum Request {
    Export {
        format: String,
        media_id: Option<String>,
    },
    Restore {
        token: String,
    },
}
pub(crate) enum Outcome {
    Exported(Vec<String>),
    Restored(RestoreResult),
}

pub(crate) fn open(
    owner: WeakEntity<DesktopView>,
    session: Entity<Session>,
    media_id: Option<String>,
    main_window: AnyWindowHandle,
    cx: &mut gpui_kit::App,
) -> anyhow::Result<()> {
    let ja = session.read(cx).text("ja", "en") == "ja";
    let t = move |ja_text: &'static str, en_text: &'static str| if ja { ja_text } else { en_text };
    gpui_kit::open_window(
        gpui_kit::WindowOptions {
            titlebar: Some(gpui_kit::TitlebarOptions {
                title: Some(t("Surtitle · 学習データ", "Surtitle · Learning data").into()),
                ..Default::default()
            }),
            ..crate::desktop::dialog::options(size(px(720.), px(640.)), None, cx)
        },
        cx,
        move |window, cx| {
            cx.new(|cx| TransferDialog::new(owner, session, media_id, main_window, window, cx))
        },
    )?;
    Ok(())
}

pub(crate) struct TransferDialog {
    owner: WeakEntity<DesktopView>,
    session: Entity<Session>,
    main_window: AnyWindowHandle,
    media_id: Option<String>,
    format: &'static str,
    restore_tab: bool,
    busy: bool,
    preview: Option<RestorePreview>,
    paths: Vec<String>,
    restored: Option<Vec<String>>,
    error: Option<String>,
    cancelled: bool,
}
impl TransferDialog {
    fn new(
        owner: WeakEntity<DesktopView>,
        session: Entity<Session>,
        media_id: Option<String>,
        main_window: AnyWindowHandle,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let weak = cx.entity().downgrade();
        window.on_window_should_close(cx, move |_, cx| {
            weak.update(cx, |this, _| !this.busy).unwrap_or(true)
        });
        cx.on_release(|this, cx| {
            if let Some(preview) = this.preview.take() {
                let backend = this.session.read(cx).backend.clone();
                backend.host.runtime().spawn(async move {
                    let _ =
                        commands::transfer::discard_restore_preview(&backend.state, preview.token);
                });
            }
        })
        .detach();
        Self {
            owner,
            session,
            main_window,
            format: if media_id.is_some() { "srt" } else { "zip" },
            media_id,
            restore_tab: false,
            busy: false,
            preview: None,
            paths: vec![],
            restored: None,
            error: None,
            cancelled: false,
        }
    }
    fn choose(&mut self, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        self.busy = true;
        self.error = None;
        let backend = self.session.read(cx).backend.clone();
        let state = backend.state.clone();
        run(
            &backend,
            cx,
            async move { commands::transfer::preview_restore(&state).await },
            |this, result, _| {
                this.busy = false;
                match result {
                    Ok(Some(preview)) => {
                        this.preview = Some(preview);
                        this.restored = None;
                    }
                    Ok(None) => {}
                    Err(error) => this.error = Some(error),
                }
            },
        );
    }
    fn submit(&mut self, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        let request = if self.restore_tab {
            let Some(preview) = &self.preview else {
                return;
            };
            Request::Restore {
                token: preview.token.clone(),
            }
        } else {
            Request::Export {
                format: self.format.into(),
                media_id: self.media_id.clone(),
            }
        };
        self.busy = true;
        self.error = None;
        self.cancelled = false;
        let dialog = cx.entity().downgrade();
        let window = self.main_window;
        match self.owner.update(cx, |root, cx| {
            root.perform_transfer(request, dialog, window, cx)
        }) {
            Ok(Ok(())) => {}
            result => {
                self.busy = false;
                self.error = Some(match result {
                    Ok(Err(error)) => error,
                    Err(error) => error.to_string(),
                    _ => unreachable!(),
                });
            }
        }
        cx.notify();
    }
    pub fn finish(&mut self, result: Result<Outcome, String>, cx: &mut Context<Self>) {
        self.busy = false;
        match result {
            Ok(Outcome::Exported(paths)) => {
                self.cancelled = paths.is_empty();
                self.paths = paths;
            }
            Ok(Outcome::Restored(result)) => {
                self.preview = None;
                self.restored = Some(result.warnings);
            }
            Err(error) => self.error = Some(error),
        }
        cx.notify();
    }
}
impl Render for TransferDialog {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let ja = self.session.read(cx).text("ja", "en") == "ja";
        let t =
            move |ja_text: &'static str, en_text: &'static str| if ja { ja_text } else { en_text };
        column()
            .id("data-transfer")
            .size_full()
            .overflow_y_scroll()
            .p_6()
            .gap_4()
            .bg(cx.theme().background)
            .text_color(cx.theme().foreground)
            .child(title(t(
                "学習データを持ち運ぶ",
                "Take your learning with you",
            )))
            .child(
                row()
                    .child(
                        Button::new("export-tab")
                            .accessibility_id("export-tab")
                            .label(t("書き出す", "Export"))
                            .disabled(self.busy)
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.restore_tab = false;
                                cx.notify();
                            })),
                    )
                    .child(
                        Button::new("restore-tab")
                            .accessibility_id("restore-tab")
                            .label(t("復元する", "Restore"))
                            .disabled(self.busy)
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.restore_tab = true;
                                cx.notify();
                            })),
                    ),
            )
            .when(!self.restore_tab, |body| {
                body.children(
                    [
                        (
                            "zip",
                            t(
                                "ZIP · 学習データ・復習履歴・保存音声",
                                "ZIP · Learning data, reviews, and saved audio",
                            ),
                        ),
                        (
                            "json",
                            t(
                                "JSON · 学習データと復習履歴",
                                "JSON · Learning data and reviews",
                            ),
                        ),
                        (
                            "csv",
                            t("CSV · フレーズ一覧", "CSV · Phrases for spreadsheets"),
                        ),
                        (
                            "tsv",
                            t(
                                "TSV · フレーズ一覧",
                                "TSV · Phrases for other learning tools",
                            ),
                        ),
                        ("srt", t("SRT · 字幕", "SRT · Subtitles")),
                        ("vtt", t("WebVTT · 字幕", "WebVTT · Subtitles")),
                    ]
                    .into_iter()
                    .filter(|(format, _)| {
                        self.media_id.is_some() || !matches!(*format, "srt" | "vtt")
                    })
                    .map(|(format, label)| {
                        Button::new(format)
                            .accessibility_id(format!("export-format-{format}"))
                            .accessibility_label(if self.format == format {
                                format!("✓ {label}")
                            } else {
                                label.to_owned()
                            })
                            .child(
                                row()
                                    .gap_1()
                                    .child(div().w(px(14.)).child(if self.format == format {
                                        "✓"
                                    } else {
                                        ""
                                    }))
                                    .child(label),
                            )
                            .toggled(self.format == format)
                            .disabled(self.busy)
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.format = format;
                                cx.notify();
                            }))
                    }),
                )
                .child(
                    Button::new("export-data")
                        .accessibility_id("export-data")
                        .primary()
                        .label(t("書き出す", "Export"))
                        .disabled(self.busy)
                        .on_click(cx.listener(|this, _, _, cx| this.submit(cx))),
                )
                .children(self.paths.iter().enumerate().map(|(index, path)| {
                    let path = path.clone();
                    row().child(div().flex_1().child(path.clone())).child(
                        Button::new(("reveal-export", index))
                            .accessibility_id(format!("reveal-export-{index}"))
                            .label(t("フォルダーを開く", "Open folder"))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.error =
                                    commands::transfer::reveal_export_file(path.clone()).err();
                                cx.notify();
                            })),
                    )
                }))
            })
            .when(self.restore_tab, |body| {
                body.child(
                    Button::new("choose-backup")
                        .accessibility_id("choose-backup")
                        .label(t("バックアップを選ぶ", "Choose a backup"))
                        .disabled(self.busy)
                        .on_click(cx.listener(|this, _, _, cx| this.choose(cx))),
                )
                .when_some(self.preview.as_ref(), |body, preview| {
                    body.child(div().child(format!(
                        "{}: {} · {}: {} · {}: {} · {}: {}",
                        t("教材", "Media"),
                        preview.media_count,
                        t("フレーズ", "Phrases"),
                        preview.card_count,
                        t("復習", "Reviews"),
                        preview.review_count,
                        t("音声", "Audio"),
                        preview.audio_count
                    )))
                    .children(
                        preview
                            .warnings
                            .iter()
                            .map(|warning| muted(warning.clone())),
                    )
                    .child(
                        Button::new("confirm-restore")
                            .accessibility_id("confirm-restore")
                            .primary()
                            .label(t(
                                "現在の学習データを置き換えて復元",
                                "Replace current learning data and restore",
                            ))
                            .disabled(self.busy)
                            .on_click(cx.listener(|this, _, _, cx| this.submit(cx))),
                    )
                })
                .when_some(self.restored.as_ref(), |body, warnings| {
                    body.child(
                        div().child(t("学習データを復元しました。", "Learning data restored.")),
                    )
                    .when(!warnings.is_empty(), |body| {
                        body.child(muted(t(
                            "復元後の処理に問題がありました。復元をやり直す必要はありません。",
                            "Some follow-up work failed. Do not repeat the restore.",
                        )))
                    })
                    .children(warnings.iter().map(|warning| div().child(warning.clone())))
                })
            })
            .child(
                column()
                    .id("transfer-status")
                    .h(px(48.))
                    .flex_shrink_0()
                    .overflow_y_scroll()
                    .gap_1()
                    .when(self.busy, |body| {
                        body.child(muted(t(
                            "保存と処理が完了するまでお待ちください。",
                            "Waiting for saving and processing to finish.",
                        )))
                    })
                    .when(self.cancelled, |body| {
                        body.child(muted(t("キャンセルしました。", "Cancelled.")))
                    })
                    .when_some(self.error.clone(), |body, error| {
                        body.child(div().text_color(cx.theme().danger).child(error))
                    }),
            )
            .child(
                Button::new("close-transfer")
                    .accessibility_id("close-transfer")
                    .label(t("閉じる", "Close"))
                    .disabled(self.busy)
                    .on_click(|_, window, _| window.remove_window()),
            )
    }
}
