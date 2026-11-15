// SPDX-License-Identifier: GPL-3.0-or-later
//! Real Windows composition exercise. Takes a resource root and a local media
//! file; never opens a Surtitle profile or sends an AI request.
#![cfg_attr(not(windows), allow(unused_imports, dead_code))]

use crate::player;

use gpui_kit::component::button::{Button, ButtonVariants};
use gpui_kit::{
    AppContext, Context, InteractiveElement, IntoElement, ParentElement, Render,
    StatefulInteractiveElement, Styled, Window, WindowBounds, WindowOptions, canvas, div, px, rgb,
    size,
};
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

struct NativeHost {
    player: Option<player::Player>,
    state: player::PlayerState,
    clicked: Arc<AtomicBool>,
    error: Option<String>,
}

impl NativeHost {
    fn new(
        resources: &std::path::Path,
        media: &std::path::Path,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> anyhow::Result<Self> {
        let RawWindowHandle::Win32(handle) = HasWindowHandle::window_handle(window)
            .map_err(|error| anyhow::anyhow!("{error}"))?
            .as_raw()
        else {
            anyhow::bail!("The native video host requires Windows");
        };
        // Keep GPUI's opaque backing paintable beneath the DComp video child.
        let clicked = Arc::new(AtomicBool::new(false));
        let click_flag = clicked.clone();
        let mut player = player::Player::new(resources, handle.hwnd.get())?;
        player.on_surface_click(move || {
            click_flag.store(true, Ordering::Release);
        })?;
        player.load(media)?;
        let view = cx.entity().downgrade();
        window.on_window_should_close(cx, move |_, cx| {
            let _ = view.update(cx, |this, _| {
                this.player.take();
            });
            true
        });
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(100))
                    .await;
                if this
                    .update(cx, |this, cx| {
                        if this.clicked.swap(false, Ordering::AcqRel) {
                            this.control("toggle-pause", None);
                        }
                        if let Some(player) = &mut this.player {
                            this.state = player.poll();
                        }
                        cx.notify();
                    })
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
        Ok(Self {
            player: Some(player),
            state: player::PlayerState::default(),
            clicked,
            error: None,
        })
    }

    fn control(&mut self, action: &str, value: Option<f64>) {
        if let Some(player) = &mut self.player
            && let Err(error) = player.control(&player::Control {
                action: action.into(),
                value,
                start_ms: None,
                end_ms: None,
                bounds: None,
                track_kind: None,
            })
        {
            self.error = Some(error.to_string());
        }
    }
}

impl Render for NativeHost {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let view = cx.entity().downgrade();
        div()
            .flex()
            .flex_col()
            .size_full()
            .bg(rgb(0x181d26))
            .text_color(rgb(0xedf2f7))
            .child(div().p_3().child("Surtitle · Native video host validation"))
            .child(
                div()
                    .id("native-host-video")
                    .w_full()
                    .flex_1()
                    .min_h(px(0.))
                    .on_click(cx.listener(|this, _, _, _| this.control("toggle-pause", None)))
                    .child(
                        canvas(
                            move |bounds, window, cx| {
                                let _ = view.update(cx, |this, _| {
                                    if let Some(player) = &mut this.player {
                                        let rect = player::Bounds {
                                            x: f32::from(bounds.origin.x) as f64,
                                            y: f32::from(bounds.origin.y) as f64,
                                            width: f32::from(bounds.size.width) as f64,
                                            height: f32::from(bounds.size.height) as f64,
                                            scale_factor: window.scale_factor() as f64,
                                            clip: None,
                                            occlusions: vec![],
                                            input_blocked: false,
                                        };
                                        if let Err(error) = player.control(&player::Control {
                                            action: "bounds".into(),
                                            value: None,
                                            start_ms: None,
                                            end_ms: None,
                                            bounds: Some(rect),
                                            track_kind: None,
                                        }) {
                                            this.error = Some(error.to_string());
                                        }
                                    }
                                });
                            },
                            |bounds, _, window, _| {
                                #[cfg(windows)]
                                window.paint_native_aperture(bounds);
                                #[cfg(not(windows))]
                                let _ = (bounds, window);
                            },
                        )
                        .size_full(),
                    ),
            )
            .child(
                div()
                    .p_3()
                    .text_size(px(22.))
                    .child("動画の下に字幕を表示 — Captions stay outside the video."),
            )
            .child(
                div()
                    .flex()
                    .gap_3()
                    .p_3()
                    .child(
                        Button::new("toggle")
                            .primary()
                            .label(if self.state.paused {
                                "再生 / Play"
                            } else {
                                "停止 / Pause"
                            })
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.control("toggle-pause", None);
                                cx.notify();
                            })),
                    )
                    .child(Button::new("rewind").label("−5秒").on_click(cx.listener(
                        |this, _, _, cx| {
                            this.control(
                                "seek",
                                Some(this.state.position_ms.saturating_sub(5000) as f64),
                            );
                            cx.notify();
                        },
                    )))
                    .child(
                        Button::new("fullscreen")
                            .label("全画面")
                            .on_click(|_, window, _| window.toggle_fullscreen()),
                    )
                    .child(Button::new("dialog").label("ダイアログを開く").on_click(
                        |_, window, cx| {
                            let result = gpui_kit::open_window(
                                WindowOptions {
                                    titlebar: Some(gpui_kit::TitlebarOptions {
                                        title: Some("Surtitle · Dialog".into()),
                                        ..Default::default()
                                    }),
                                    ..crate::desktop::dialog::options(
                                        size(px(520.), px(240.)),
                                        None,
                                        cx,
                                    )
                                },
                                cx,
                                |_, cx| cx.new(|_| HostDialog),
                            );
                            if let Err(error) = result {
                                eprintln!("dialog: {error:#}");
                            }
                            let _ = window;
                        },
                    ))
                    .child(format!(
                        "{} / {} ms · {}×{}",
                        self.state.position_ms,
                        self.state.duration_ms,
                        self.state.video_width,
                        self.state.video_height
                    )),
            )
            .child(
                div().px_3().pb_3().child(
                    self.error
                        .clone()
                        .or(self.state.error.clone())
                        .unwrap_or_default(),
                ),
            )
    }
}

struct HostDialog;
impl Render for HostDialog {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .size_full()
            .flex()
            .flex_col()
            .p_6()
            .gap_4()
            .bg(rgb(0x222b37))
            .text_color(rgb(0xedf2f7))
            .child("動画の上に表示され、親ウィンドウへの入力を遮断します。")
            .child("Playback continues beneath this owned dialog.")
            .child(
                Button::new("close")
                    .primary()
                    .label("閉じる / Close")
                    .on_click(|_, window, _| window.remove_window()),
            )
    }
}

pub fn run() -> anyhow::Result<()> {
    let mut args = std::env::args_os().skip(1);
    let resources = PathBuf::from(
        args.next()
            .ok_or_else(|| anyhow::anyhow!("resource root required"))?,
    )
    .canonicalize()?;
    let media = PathBuf::from(
        args.next()
            .ok_or_else(|| anyhow::anyhow!("local media required"))?,
    )
    .canonicalize()?;
    // Must precede GPUI and its worker threads. This affects only this process.
    unsafe {
        std::env::set_var("GPUI_DISABLE_DIRECT_COMPOSITION", "false");
    }
    gpui_kit::application()
        .with_assets(crate::ui::assets::Assets)
        .run(move |cx| {
            gpui_kit::init(cx);
            let bounds = gpui_kit::Bounds::centered(None, size(px(1280.), px(800.)), cx);
            let result = gpui_kit::open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(bounds)),
                    titlebar: Some(gpui_kit::TitlebarOptions {
                        title: Some("Surtitle · Native host".into()),
                        ..Default::default()
                    }),
                    window_min_size: Some(size(px(800.), px(600.))),
                    ..Default::default()
                },
                cx,
                |window, cx| {
                    cx.new(|cx| {
                        NativeHost::new(&resources, &media, window, cx)
                            .expect("native player startup")
                    })
                },
            );
            if let Err(error) = result {
                eprintln!("native host: {error:#}");
                cx.quit();
            }
            cx.on_window_closed(|cx, _| {
                if cx.windows().is_empty() {
                    cx.quit();
                }
            })
            .detach();
        });
    Ok(())
}
