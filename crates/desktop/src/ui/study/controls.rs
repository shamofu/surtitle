// SPDX-License-Identifier: GPL-3.0-or-later
use super::*;
use gpui_kit::component::{Icon, popover::Popover};
use gpui_kit::{WeakEntity, size};
use std::{future::Future, pin::Pin};

type ControlTask = Pin<Box<dyn Future<Output = Result<(), String>> + Send>>;
type ControlCompletion =
    Box<dyn FnOnce(&mut StudyView, Result<(), String>, &mut Context<StudyView>)>;

#[cfg(test)]
mod wheel_tests {
    use super::*;
    use gpui_kit::{Modifiers, ScrollDelta, ScrollEvent, TouchPhase, point};

    fn lines(x: f32, y: f32) -> ScrollEvent {
        ScrollEvent {
            delta: ScrollDelta::Lines(point(x, y)),
            ..Default::default()
        }
    }

    #[test]
    fn wheel_steps_ignore_horizontal_modifier_and_jitter_input() {
        let mut wheel = WheelSteps::default();
        for delta in [1., 3., 120.] {
            assert_eq!(wheel.step(&lines(0., delta)), Some(1.));
            assert_eq!(wheel.step(&lines(0., -delta)), Some(-1.));
        }
        for event in [
            lines(3., 0.),
            lines(3., 0.1),
            lines(0., 0.),
            lines(0., f32::NAN),
        ] {
            assert_eq!(wheel.step(&event), None);
        }
        for modifiers in [
            Modifiers {
                control: true,
                ..Default::default()
            },
            Modifiers {
                platform: true,
                ..Default::default()
            },
            Modifiers {
                alt: true,
                ..Default::default()
            },
            Modifiers {
                shift: true,
                ..Default::default()
            },
        ] {
            assert_eq!(
                wheel.step(&ScrollEvent {
                    modifiers,
                    ..lines(0., 3.)
                }),
                None
            );
        }
        for _ in 0..3 {
            assert_eq!(wheel.step(&lines(0., 0.25)), None);
        }
        assert_eq!(wheel.step(&lines(0., 0.25)), Some(1.));
        let pixels = |y| ScrollEvent {
            delta: ScrollDelta::Pixels(point(px(0.), px(y))),
            ..Default::default()
        };
        assert_eq!(wheel.step(&pixels(20.)), None);
        assert_eq!(wheel.step(&pixels(-20.)), None);
        assert_eq!(wheel.step(&pixels(-20.)), Some(-1.));
        assert_eq!(wheel.step(&pixels(20.)), None);
        assert_eq!(
            wheel.step(&ScrollEvent {
                touch_phase: TouchPhase::Ended,
                ..pixels(0.)
            }),
            None
        );
        assert_eq!(wheel.step(&pixels(20.)), None);
    }

    #[test]
    fn rapid_control_intents_execute_first_then_latest_and_failure_discards_queue() {
        let applied = Arc::new(std::sync::Mutex::new(Vec::new()));
        let task = |value| {
            let applied = applied.clone();
            Box::pin(async move {
                applied.lock().unwrap().push(value);
                Ok(())
            }) as ControlTask
        };
        let runtime = crate::runtime::test_runtime();
        let mut pending = PendingControl::default();
        pending.enqueue(75., task(75));
        let (epoch, first, _) = pending.take().unwrap();
        pending.enqueue(70., task(70));
        pending.enqueue(65., task(65));
        assert_eq!(pending.target, Some(65.));
        assert!(pending.take().is_none());
        runtime.block_on(first).unwrap();
        assert!(pending.finish(epoch, false));
        let (epoch, latest, _) = pending.take().unwrap();
        runtime.block_on(latest).unwrap();
        assert!(pending.finish(epoch, false));
        assert_eq!(*applied.lock().unwrap(), [75, 65]);
        assert!(pending.target.is_none());

        pending.enqueue(60., Box::pin(async { Err("rejected".into()) }));
        let (epoch, rejected, _) = pending.take().unwrap();
        pending.enqueue(55., task(55));
        assert!(runtime.block_on(rejected).is_err());
        assert!(pending.finish(epoch, true));
        assert!(pending.target.is_none());
        assert!(pending.take().is_none());
        assert_eq!(*applied.lock().unwrap(), [75, 65]);
    }

    #[test]
    fn old_completion_after_reset_cannot_clear_the_new_media_intent() {
        let mut pending = PendingControl::default();
        pending.enqueue(10., Box::pin(async { Ok(()) }));
        let (old_epoch, _, _) = pending.take().unwrap();
        pending.reset();
        pending.enqueue(20., Box::pin(async { Ok(()) }));
        assert!(!pending.finish(old_epoch, true));
        assert_eq!(pending.target, Some(20.));
        assert!(pending.take().is_some());
    }
}

/// Keep rapid pointer intents ordered while retaining only the latest queued
/// value. Each future already owns the media lease captured at input time.
#[derive(Default)]
pub(super) struct PendingControl {
    pub(super) target: Option<f64>,
    next: Option<ControlTask>,
    completion: Option<ControlCompletion>,
    active: bool,
    epoch: u64,
}

impl PendingControl {
    pub(super) fn enqueue(&mut self, value: f64, task: ControlTask) {
        self.target = Some(value);
        self.next = Some(task);
        self.completion = None;
    }
    fn take(&mut self) -> Option<(u64, ControlTask, Option<ControlCompletion>)> {
        if self.active {
            return None;
        }
        let next = self.next.take()?;
        self.active = true;
        Some((self.epoch, next, self.completion.take()))
    }
    fn finish(&mut self, epoch: u64, failed: bool) -> bool {
        if self.epoch != epoch {
            return false;
        }
        self.active = false;
        if failed {
            self.next = None;
            self.completion = None;
        }
        if self.next.is_none() {
            self.target = None;
        }
        true
    }
    pub(super) fn reset(&mut self) {
        self.epoch += 1;
        self.active = false;
        self.target = None;
        self.next = None;
        self.completion = None;
    }
}

#[derive(Default)]
pub(super) struct WheelSteps {
    partial: f32,
    precise: bool,
}

impl WheelSteps {
    fn vertical(event: &gpui_kit::ScrollEvent) -> bool {
        if event.modifiers.control
            || event.modifiers.platform
            || event.modifiers.alt
            || event.modifiers.shift
        {
            return false;
        }
        let (x, y) = match event.delta {
            gpui_kit::ScrollDelta::Lines(delta) => (delta.x, delta.y),
            gpui_kit::ScrollDelta::Pixels(delta) => (f32::from(delta.x), f32::from(delta.y)),
        };
        y.is_finite() && x.is_finite() && y.abs() > x.abs()
    }
    fn step(&mut self, event: &gpui_kit::ScrollEvent) -> Option<f64> {
        if !Self::vertical(event)
            || matches!(
                event.touch_phase,
                gpui_kit::TouchPhase::Cancelled | gpui_kit::TouchPhase::Ended
            )
        {
            self.partial = 0.;
            return None;
        }
        if event.touch_phase == gpui_kit::TouchPhase::Started {
            self.partial = 0.;
        }
        let (delta, precise) = match event.delta {
            gpui_kit::ScrollDelta::Lines(delta) => (delta.y, false),
            // Accumulate small trackpad movements to one deliberate 40px step.
            gpui_kit::ScrollDelta::Pixels(delta) => (f32::from(delta.y) / 40., true),
        };
        if !delta.is_finite() || delta == 0. {
            return None;
        }
        if precise != self.precise || self.partial.signum() != delta.signum() {
            self.partial = 0.;
        }
        self.precise = precise;
        self.partial += delta;
        if self.partial.abs() < 1. {
            return None;
        }
        // The Windows value is scaled by system lines-per-notch. One event
        // still means one step; never multiply a seek by that preference.
        self.partial = 0.;
        Some(f64::from(delta.signum()))
    }
}

impl StudyView {
    pub(super) fn queue_position_control(
        &mut self,
        task: impl Future<Output = Result<(), String>> + Send + 'static,
        completion: impl FnOnce(&mut StudyView, Result<(), String>, &mut Context<StudyView>) + 'static,
        cx: &mut Context<Self>,
    ) {
        self.seek_target = None;
        self.seek_control.target = None;
        self.seek_control.next = Some(Box::pin(task));
        self.seek_control.completion = Some(Box::new(completion));
        self.start_pending_control("seek", cx);
    }

    fn pending_control(&mut self, action: &str) -> &mut PendingControl {
        if action == "seek" {
            &mut self.seek_control
        } else {
            &mut self.volume_control
        }
    }

    pub(super) fn start_pending_control(&mut self, action: &'static str, cx: &mut Context<Self>) {
        if self.sources.read(cx).frozen() || !self.playback_ready(cx) {
            self.pending_control(action).reset();
            if action == "seek" {
                self.seek_target = None;
            }
            return;
        }
        let Some((epoch, task, completion)) = self.pending_control(action).take() else {
            return;
        };
        let backend = self.session.read(cx).backend.clone();
        run(&backend, cx, task, move |this, result, cx| {
            let failed = result.is_err();
            let superseded = action == "seek" && this.seek_control.next.is_some();
            // A loop may be superseded by a newer queued position intent. Its
            // rejected lease must not discard that newer intent.
            if !this
                .pending_control(action)
                .finish(epoch, failed && action == "volume")
            {
                return;
            }
            if !superseded {
                this.error = result.as_ref().err().cloned();
                if let Some(completion) = completion {
                    completion(this, result, cx);
                }
            }
            if failed && action == "seek" && !superseded {
                this.seek_target = None;
            }
            this.start_pending_control(action, cx);
            // Resynchronize after success or rollback, including persisted-volume
            // failures. Playback subscriptions update the real slider with its window.
            if let Ok(player) = this.session.read(cx).backend.state.player_state() {
                this.session.update(cx, |session, cx| {
                    session.receive(crate::runtime::DesktopEvent::PlayerState(player), cx);
                });
            }
        });
    }

    pub(super) fn scroll_video(&mut self, event: &gpui_kit::ScrollEvent, cx: &mut Context<Self>) {
        if self.sources.read(cx).frozen() || !self.playback_ready(cx) {
            return;
        }
        if WheelSteps::vertical(event) {
            cx.stop_propagation();
        }
        let Some(step) = self.video_wheel.step(event) else {
            return;
        };
        let player = &self.session.read(cx).player;
        let position = self
            .seek_control
            .target
            .unwrap_or(self.seek_target.unwrap_or(player.position_ms) as f64);
        let target = (position - step * 5000.).clamp(0., player.duration_ms as f64);
        self.control("seek", Some(target), cx);
        cx.stop_propagation();
    }

    fn scroll_volume(
        &mut self,
        event: &gpui_kit::ScrollEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.sources.read(cx).frozen() || !self.playback_ready(cx) {
            return;
        }
        if WheelSteps::vertical(event) {
            cx.stop_propagation();
        }
        let Some(step) = self.volume_wheel.step(event) else {
            return;
        };
        let current = self
            .volume_control
            .target
            .unwrap_or(self.session.read(cx).player.volume);
        let target = (current + step * 5.).clamp(0., 100.);
        self.volume
            .update(cx, |volume, cx| volume.set_value(target as f32, window, cx));
        self.control("volume", Some(target), cx);
        cx.stop_propagation();
    }

    pub(super) fn transport(
        &self,
        player: &crate::player::PlayerState,
        disabled: bool,
        fullscreen: bool,
        cx: &mut Context<Self>,
    ) -> gpui_kit::Div {
        let ja = self.session.read(cx).text("ja", "en") == "ja";
        let t = |ja_text, en_text| if ja { ja_text } else { en_text };
        let play_label = if player.paused {
            t("再生", "Play")
        } else {
            t("一時停止", "Pause")
        };
        let shown_position = self.seek_target.unwrap_or(player.position_ms);
        let time_width = timestamp(player.duration_ms.max(shown_position));
        let time_reservation = format!("{time_width} / {time_width}");
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
                                    .child(state_label(
                                        play_label,
                                        &[t("再生", "Play"), t("一時停止", "Pause")],
                                    ))
                                    .accessibility_label(play_label)
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
                            .child(
                                div()
                                    .id("playback-time")
                                    .test_support()
                                    .px_2()
                                    .text_size(px(12.))
                                    .font_features(tabular_numbers())
                                    .child(state_label(
                                        format!(
                                            "{} / {}",
                                            timestamp(shown_position),
                                            timestamp(player.duration_ms)
                                        ),
                                        &[time_reservation.as_str()],
                                    )),
                            ),
                    )
                    .child(
                        row()
                            .gap_2()
                            .child(self.rate_control(disabled, cx))
                            .child(
                                row()
                                    .id("player-volume")
                                    .test_support()
                                    .gap_2()
                                    .on_scroll(cx.listener(|this, event, window, cx| {
                                        this.scroll_volume(event, window, cx)
                                    }))
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
                                            .font_features(tabular_numbers())
                                            .w(px(34.))
                                            .child(format!(
                                                "{:.0}%",
                                                self.volume_control.target.unwrap_or(player.volume)
                                            )),
                                    ),
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
