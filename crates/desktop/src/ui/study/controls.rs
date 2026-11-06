// SPDX-License-Identifier: GPL-3.0-or-later
use super::*;
use gpui_kit::component::{Icon, popover::Popover};
use gpui_kit::{WeakEntity, size};

impl StudyView {
    pub(super) fn transport(
        &self,
        player: &crate::player::PlayerState,
        disabled: bool,
        fullscreen: bool,
        cx: &mut Context<Self>,
    ) -> gpui_kit::Div {
        let ja = self.session.read(cx).text("ja", "en") == "ja";
        let t = |ja_text, en_text| if ja { ja_text } else { en_text };
        column()
            .gap_0()
            .px_3()
            .pt_1()
            .pb_2()
            .bg(cx.theme().popover)
            .child(
                Slider::new(&self.seek)
                    .disabled(disabled)
                    .when(player.duration_ms > 0, |slider| {
                        slider.keyboard_step(1_000_000. / player.duration_ms as f32)
                    })
                    .accessibility_label(t("再生位置", "Playback position"))
                    .accessibility_value(format!(
                        "{} / {}",
                        timestamp(player.position_ms),
                        timestamp(player.duration_ms)
                    ))
                    .h(px(18.))
                    .w_full(),
            )
            .child(
                row()
                    .gap_2()
                    .flex_wrap()
                    .justify_between()
                    .child(
                        row()
                            .gap_0()
                            .child(
                                compact_button("back-five")
                                    .ghost()
                                    .icon(IconName::RotateCcw)
                                    .label(t("5秒", "5s"))
                                    .tooltip(t("5 秒戻る", "Back 5 seconds"))
                                    .disabled(disabled)
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        let position = this
                                            .session
                                            .read(cx)
                                            .player
                                            .position_ms
                                            .saturating_sub(5000);
                                        this.control("seek", Some(position as f64), cx);
                                    })),
                            )
                            .child(
                                button("play-toggle")
                                    .icon(if player.paused {
                                        IconName::Play
                                    } else {
                                        IconName::Pause
                                    })
                                    .label(if player.paused {
                                        t("再生", "Play")
                                    } else {
                                        t("一時停止", "Pause")
                                    })
                                    .accessibility_id("play-toggle")
                                    .disabled(disabled)
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.control("toggle-pause", None, cx)
                                    })),
                            )
                            .child(
                                compact_button("forward-five")
                                    .ghost()
                                    .icon(IconName::RotateCw)
                                    .label(t("5秒", "5s"))
                                    .tooltip(t("5 秒進む", "Forward 5 seconds"))
                                    .disabled(disabled)
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        let position = this
                                            .session
                                            .read(cx)
                                            .player
                                            .position_ms
                                            .saturating_add(5000);
                                        this.control("seek", Some(position as f64), cx);
                                    })),
                            )
                            .child(div().px_2().text_size(px(12.)).child(format!(
                                "{} / {}",
                                timestamp(player.position_ms),
                                timestamp(player.duration_ms)
                            ))),
                    )
                    .child(
                        row()
                            .gap_2()
                            .child(self.rate_control(disabled, cx))
                            .child(
                                Icon::new(IconName::Volume2)
                                    .size(px(16.))
                                    .text_color(cx.theme().muted_foreground),
                            )
                            .child(
                                Slider::new(&self.volume)
                                    .disabled(disabled)
                                    .accessibility_label(t("音量", "Volume"))
                                    .accessibility_value(format!(
                                        "{:.0}%",
                                        self.volume.read(cx).value().end()
                                    ))
                                    .w(px(58.)),
                            )
                            .child(
                                div()
                                    .text_size(px(12.))
                                    .w(px(34.))
                                    .child(format!("{:.0}%", player.volume)),
                            )
                            .child(
                                compact_button("playback-settings")
                                    .ghost()
                                    .icon(IconName::Settings2)
                                    .label(t("再生設定", "Playback settings"))
                                    .disabled(self.sources.read(cx).frozen())
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.open_playback_settings(cx)
                                    })),
                            )
                            .child(
                                icon_button(
                                    "loop-selection",
                                    IconName::Repeat,
                                    if self.looping.is_some() {
                                        t("繰り返し解除", "Stop loop")
                                    } else {
                                        t("選択字幕を繰り返す", "Loop")
                                    },
                                )
                                .toggled(self.looping.is_some())
                                .text_color(if self.looping.is_some() {
                                    cx.theme().primary
                                } else {
                                    cx.theme().muted_foreground
                                })
                                .disabled(disabled)
                                .on_click(cx.listener(|this, _, _, cx| this.loop_selection(cx))),
                            )
                            .child(
                                icon_button(
                                    "fullscreen",
                                    IconName::Maximize,
                                    t("全画面表示を切り替える", "Toggle fullscreen"),
                                )
                                .toggled(fullscreen)
                                .accessibility_id("player-fullscreen")
                                .disabled(disabled)
                                .on_click(cx.listener(
                                    |this, _, _, cx| this.control("fullscreen", None, cx),
                                )),
                            ),
                    ),
            )
    }

    fn rate_control(&self, disabled: bool, cx: &mut Context<Self>) -> Popover {
        let ja = self.session.read(cx).text("ja", "en") == "ja";
        let t = move |ja_text, en_text| if ja { ja_text } else { en_text };
        let rate = self.rate.clone();
        let view = cx.entity().downgrade();
        let opening_view = view.clone();
        let footprint = self.rate_footprint.clone();
        Popover::new("playback-rate-popover")
            .open(self.rate_open)
            .anchor(gpui_kit::Anchor::BottomRight)
            .on_open_change(move |open, _, cx| {
                let _ = opening_view.update(cx, |this, cx| {
                    if this.rate_open != *open {
                        this.rate_open = *open;
                        if !open {
                            *this.rate_footprint.lock().unwrap() = None;
                        }
                        cx.notify();
                    }
                });
            })
            .trigger(
                compact_button("playback-rate-trigger")
                    .ghost()
                    .icon(IconName::Gauge)
                    .label(format!("{}×", self.rate.read(cx).value()))
                    .tooltip(t("再生速度", "Playback speed"))
                    .w(px(86.))
                    .disabled(disabled),
            )
            .content(move |_, _, cx| {
                let value = rate.read(cx).value().end();
                let measured = footprint.clone();
                let measurement_view = view.clone();
                column()
                    .relative()
                    .w(px(298.))
                    .gap_2()
                    .child(
                        row()
                            .justify_between()
                            .gap_2()
                            .child(
                                div()
                                    .text_size(px(13.))
                                    .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                                    .child(t("再生速度", "Playback speed")),
                            )
                            .child(
                                icon_button(
                                    "close-playback-rate",
                                    IconName::X,
                                    t("閉じる", "Close"),
                                )
                                .w(px(30.))
                                .h(px(30.))
                                .on_click(
                                    cx.listener(|state, _, window, cx| state.dismiss(window, cx)),
                                ),
                            ),
                    )
                    .child(
                        div()
                            .text_center()
                            .text_size(px(24.))
                            .child(format!("{value:.2}×")),
                    )
                    .child(
                        row()
                            .gap_3()
                            .child(
                                rate_step(
                                    "rate-decrease",
                                    IconName::Minus,
                                    t("再生速度を下げる", "Decrease playback speed"),
                                    -0.05,
                                    view.clone(),
                                    rate.clone(),
                                )
                                .disabled(disabled),
                            )
                            .child(
                                Slider::new(&rate)
                                    .disabled(disabled)
                                    .accessibility_label(t("再生速度", "Playback rate"))
                                    .accessibility_value(format!("{value:.2}×"))
                                    .flex_1(),
                            )
                            .child(
                                rate_step(
                                    "rate-increase",
                                    IconName::Plus,
                                    t("再生速度を上げる", "Increase playback speed"),
                                    0.05,
                                    view.clone(),
                                    rate.clone(),
                                )
                                .disabled(disabled),
                            ),
                    )
                    .children(
                        [vec![0.5, 0.75, 1.], vec![1.25, 1.5, 2., 3.]]
                            .into_iter()
                            .enumerate()
                            .map(|(row_index, rates)| {
                                row().gap_1().children(rates.into_iter().enumerate().map(
                                    |(index, preset)| {
                                        let view = view.clone();
                                        compact_button(("rate", row_index * 4 + index))
                                            .label(format!("{preset}×"))
                                            .toggled((value - preset).abs() < 0.001)
                                            .flex_1()
                                            .rounded_full()
                                            .h(px(34.))
                                            .disabled(disabled)
                                            .bg(if (value - preset).abs() < 0.001 {
                                                cx.theme().accent
                                            } else {
                                                cx.theme().secondary
                                            })
                                            .on_click(move |_, window, cx| {
                                                let _ = view.update(cx, |this, cx| {
                                                    this.rate.update(cx, |rate, cx| {
                                                        rate.set_value(preset, window, cx)
                                                    });
                                                    this.control(
                                                        "rate",
                                                        Some(f64::from(preset)),
                                                        cx,
                                                    );
                                                    cx.notify();
                                                });
                                            })
                                    },
                                ))
                            }),
                    )
                    .child(
                        canvas(
                            move |bounds, _, cx| {
                                let rect = crate::player::SurfaceRect {
                                    x: f32::from(bounds.origin.x) as f64 - 12.,
                                    y: f32::from(bounds.origin.y) as f64 - 12.,
                                    width: f32::from(bounds.size.width) as f64 + 24.,
                                    height: f32::from(bounds.size.height) as f64 + 24.,
                                };
                                let changed = {
                                    let mut stored = measured.lock().unwrap();
                                    let changed = stored.as_ref().is_none_or(|old| {
                                        old.x != rect.x
                                            || old.y != rect.y
                                            || old.width != rect.width
                                            || old.height != rect.height
                                    });
                                    if changed {
                                        *stored = Some(rect);
                                    }
                                    changed
                                };
                                if changed {
                                    let _ = measurement_view.update(cx, |_, cx| cx.notify());
                                }
                            },
                            |_, _, _, _| {},
                        )
                        .absolute()
                        .size_full(),
                    )
            })
    }

    fn open_playback_settings(&mut self, cx: &mut Context<Self>) {
        if self.settings_open {
            return;
        }
        self.settings_open = true;
        let session = self.session.clone();
        let editors = self.editors.clone();
        let owner = cx.entity().downgrade();
        let title = self
            .session
            .read(cx)
            .text("再生設定", "Playback settings")
            .to_owned();
        let error_owner = owner.clone();
        gpui_kit::App::defer(cx, move |cx| {
            if let Err(error) = gpui_kit::open_window(
                gpui_kit::WindowOptions {
                    titlebar: Some(gpui_kit::TitlebarOptions {
                        title: Some(title.into()),
                        ..Default::default()
                    }),
                    ..crate::desktop::dialog::options(size(px(640.), px(460.)), None, cx)
                },
                cx,
                move |window, cx| {
                    cx.new(|cx| {
                        let focus = cx.focus_handle();
                        focus.focus(window, cx);
                        let observed = cx.observe(&session, |_, _, cx| cx.notify());
                        let settings = cx.observe(&editors, |_, _, cx| cx.notify());
                        let mut subscriptions = vec![observed, settings];
                        if let Some(parent) = owner.upgrade() {
                            subscriptions.push(cx.observe(&parent, |_, _, cx| cx.notify()));
                        }
                        let released = owner.clone();
                        cx.on_release(move |_, cx| {
                            let _ = released.update(cx, |this, cx| {
                                this.settings_open = false;
                                cx.notify();
                            });
                        })
                        .detach();
                        PlaybackSettings {
                            session,
                            editors,
                            owner,
                            focus,
                            _subscriptions: subscriptions,
                        }
                    })
                },
            ) {
                let _ = error_owner.update(cx, |this, cx| {
                    this.settings_open = false;
                    this.error = Some(error.to_string());
                    cx.notify();
                });
            }
        });
    }

    fn select_track(&mut self, kind: &'static str, id: f64, cx: &mut Context<Self>) {
        if !self.playback_ready(cx) || self.sources.read(cx).frozen() {
            return;
        }
        let backend = self.session.read(cx).backend.clone();
        let task = commands::playback::player_control_for_media(
            backend.host.clone(),
            &backend.state,
            self.media_id.clone(),
            crate::player::Control {
                action: "track".into(),
                value: Some(id),
                track_kind: Some(kind.into()),
                start_ms: None,
                end_ms: None,
                bounds: None,
            },
        );
        run(&backend, cx, task, |this, result, _| {
            this.error = result.err()
        });
    }
}

fn rate_step(
    id: &'static str,
    icon: IconName,
    label: &'static str,
    delta: f32,
    owner: WeakEntity<StudyView>,
    rate: Entity<SliderState>,
) -> Button {
    icon_button(id, icon, label)
        .w(px(34.))
        .h(px(34.))
        .rounded_full()
        .on_click(move |_, window, cx| {
            let value = ((rate.read(cx).value().end() + delta) * 20.).round() / 20.;
            let value = value.clamp(0.25, 3.);
            let _ = owner.update(cx, |this, cx| {
                if !this.playback_ready(cx) || this.sources.read(cx).frozen() {
                    return;
                }
                this.rate
                    .update(cx, |rate, cx| rate.set_value(value, window, cx));
                this.control("rate", Some(f64::from(value)), cx);
                cx.notify();
            });
        })
}

struct PlaybackSettings {
    session: Entity<Session>,
    editors: Entity<super::super::editors::EditorRegistry>,
    owner: WeakEntity<StudyView>,
    focus: gpui_kit::FocusHandle,
    _subscriptions: Vec<Subscription>,
}

impl Render for PlaybackSettings {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let ja = self.session.read(cx).text("ja", "en") == "ja";
        let t = move |ja_text, en_text| if ja { ja_text } else { en_text };
        let parent = self.owner.upgrade();
        let ready = parent
            .as_ref()
            .is_some_and(|owner| owner.read(cx).playback_ready(cx));
        let frozen = parent
            .as_ref()
            .is_none_or(|owner| owner.read(cx).sources.read(cx).frozen());
        let key = self.editors.read(cx).key_for("settings", "default");
        let editing = key.as_ref().and_then(|key| self.editors.read(cx).view(key));
        let mode = editing
            .and_then(|view| view.fields.get("captionGapMode"))
            .map(String::as_str)
            .unwrap_or("review");
        let mode_ready = editing.is_some_and(|view| view.ready) && !self.editors.read(cx).frozen();
        let mode_error = editing.and_then(|view| view.error.clone());
        let editor = self.editors.clone();
        let mode_key = key.clone();
        let mode_selector = button("caption-gap-mode")
            .w_full()
            .icon(IconName::ChevronDown)
            .label(if mode == "preview" {
                t("次の字幕を予習", "Preview next caption")
            } else {
                t("直前の字幕を復習", "Review previous caption")
            })
            .disabled(!mode_ready)
            .dropdown_menu(move |mut menu, _, _| {
                for (value, label) in [
                    ("review", t("直前の字幕を復習", "Review previous caption")),
                    ("preview", t("次の字幕を予習", "Preview next caption")),
                ] {
                    let editor = editor.clone();
                    let key = mode_key.clone();
                    menu = menu.item(PopupMenuItem::new(label).on_click(move |_, _, cx| {
                        if let Some(key) = &key
                            && let Some(view) = editor.read(cx).view(key)
                        {
                            let mut fields = view.fields.clone();
                            fields.insert("captionGapMode".into(), value.into());
                            editor.update(cx, |registry, cx| {
                                registry.change(key, fields, cx);
                                registry.blur(key, cx);
                            });
                        }
                    }));
                }
                menu
            });
        // A settings window for an old Study entity never displays the replacement
        // media's tracks or acquires command authority over it.
        let player = if ready {
            self.session.read(cx).player.clone()
        } else {
            crate::player::PlayerState::default()
        };
        let sentence_pause = player.sentence_pause;
        let tracks = player.tracks;
        let native_error = parent
            .as_ref()
            .and_then(|owner| owner.read(cx).error.clone());
        let selected_embedded = tracks
            .iter()
            .find(|track| track.kind == "sub" && track.selected && !track.external)
            .and_then(|track| track.ff_index);
        column().id("playback-settings-body").size_full().overflow_y_scroll().p_6().gap_5().bg(cx.theme().popover)
            .role(gpui_kit::accesskit::Role::Dialog)
            .aria_label(t("再生設定", "Playback settings"))
            .track_focus(&self.focus)
            // Let the focused dropdown consume Escape before this dialog closes.
            .on_key_down(|event: &gpui_kit::KeyDownEvent, window, cx| {
                if event.keystroke.key == "escape"
                    && !event.is_held
                    && !event.prefer_character_input
                    && event.keystroke.modifiers == Default::default()
                {
                    cx.stop_propagation();
                    window.remove_window();
                }
            })
            .child(row().justify_between()
                .child(div().text_size(px(24.)).font_weight(gpui_kit::FontWeight::SEMIBOLD).child(t("再生設定","Playback settings")))
                .child(icon_button("close-playback-settings",IconName::X,t("閉じる","Close")).on_click(|_,window,_|window.remove_window())))
            .child(column().gap_2().child(div().text_size(px(14.)).child(t("字幕のない間","Between captions"))).child(mode_selector))
            .when_some(mode_error,|body,error|body.child(column().gap_2().p_3().bg(cx.theme().button_warning)
                .child(div().text_color(cx.theme().button_warning_foreground).child(error))
                .child(compact_button("retry-caption-gap").label(t("再試行","Retry")).disabled(!mode_ready)
                    .on_click(cx.listener(move|this,_,_,cx|{if let Some(key)=&key{this.editors.update(cx,|registry,cx|{registry.blur(key,cx);});}})))))
            .children([("audio",t("学習する音声","Study audio")),("sub",t("学習用の字幕ソース","Study subtitle source"))].into_iter().filter_map(|(kind,label)|{
                let matching=tracks.iter().filter(|track|track.kind==kind).cloned().collect::<Vec<_>>();
                if matching.is_empty(){return None;}
                let selected=matching.iter().find(|track|track.selected);
                let selected_label=selected.map(track_label).unwrap_or_else(||t("選択なし","None selected").into());
                let owner=self.owner.clone();
                Some(column().gap_2().child(div().text_size(px(14.)).child(label))
                    .child(button(format!("playback-track-{kind}")).icon(IconName::ChevronDown).w_full().label(selected_label).disabled(!ready||frozen)
                        .dropdown_menu(move|mut menu,_,_|{
                            if kind=="sub" {
                                let owner=owner.clone();
                                menu=menu.item(PopupMenuItem::new(t("選択なし","None selected")).on_click(move|_,_,cx|{let _=owner.update(cx,|this,cx|this.select_track("sub",0.,cx));}));
                            }
                            for track in &matching {
                                let id=track.id;let owner=owner.clone();
                                menu=menu.item(PopupMenuItem::new(track_label(track)).on_click(move|_,_,cx|{let _=owner.update(cx,|this,cx|this.select_track(kind,id as f64,cx));}));
                            }
                            menu
                        }))
                    .when(kind=="sub",|body|body.child(muted(t("字幕はプレイヤーの下に表示します。埋め込み字幕はここから学習用に取り込めます。","Captions appear below the player. You can import embedded captions here for study.")))))
            }))
            .when_some(selected_embedded,|body,stream_index|body.child(button("use-embedded-study-captions").label(t("この字幕を学習に使う","Use these captions for study")).disabled(!ready||frozen)
                .on_click(cx.listener(move|this,_,window,cx|{
                    let Some(owner)=this.owner.upgrade()else{return;};
                    if !owner.read(cx).playback_ready(cx)||owner.read(cx).sources.read(cx).frozen(){return;}
                    let media_id=owner.read(cx).media_id.clone();
                    this.session.update(cx,|_,cx|cx.emit(UiEvent::ManageSubtitles{media_id,stream_index}));
                    window.remove_window();
                }))))
            .child(button("sentence-pause").ghost().icon(if sentence_pause{IconName::SquareCheck}else{IconName::Square})
                .role(gpui_kit::accesskit::Role::CheckBox).toggled(sentence_pause)
                .label(t("字幕グループの終わりで一時停止","Pause at the end of a caption group")).disabled(!ready||frozen)
                .on_click(cx.listener(move|this,_,_,cx|{let _=this.owner.update(cx,|owner,cx|owner.control("sentence-pause",Some(if sentence_pause{0.}else{1.}),cx));})))
            .child(muted(t("句読点や字幕の間隔を目安に、字幕の終端で止まります。選択区間の再生・リピートを優先します。","Stops at subtitle ends, using punctuation and gaps to group sentences. Selected ranges and repeat take priority.")))
            .when_some(native_error,|body,error|body.child(div().p_3().text_color(cx.theme().danger).child(error)))
    }
}
fn track_label(track: &crate::player::Track) -> String {
    let title = if track.title.is_empty() {
        format!("{} {}", track.kind, track.id)
    } else {
        track.title.clone()
    };
    match track
        .language
        .as_deref()
        .filter(|language| !language.is_empty())
    {
        Some(language) => format!("{language} · {title}"),
        None => title,
    }
}
