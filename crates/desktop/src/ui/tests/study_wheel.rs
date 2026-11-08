// SPDX-License-Identifier: GPL-3.0-or-later
use super::*;

fn open_study(harness: &Harness, cx: &mut TestAppContext) {
    cx.update_window(harness.window, |_, window, app| {
        window.click(("study", 0usize), app)
    })
    .unwrap();
    harness.wait_window(cx, harness.window, "study transcript", |window| {
        window
            .try_find("cue-scroll-ui-cue")
            .is_some_and(|row| row.visible())
    });
    harness.drain_callbacks(cx);
}

#[gpui_kit::test]
fn study_translation_and_search_keep_transcript_and_actions_in_place(cx: &mut TestAppContext) {
    let harness = Harness::open(cx);
    open_study(&harness, cx);
    cx.update_window(harness.window, |_, window, app| {
        window.render_frame(app);
        let transcript = window.find("cue-scroll-ui-cue").bounds();
        let translation = window.find("transcript-translation").bounds();
        let caption_translation = window.find("caption-translation").bounds();
        let following = window.find("follow-subtitles").bounds();
        window.click("transcript-translation", app);
        assert_eq!(window.find("transcript-translation").bounds(), translation);
        assert_eq!(
            window.find("caption-translation").bounds(),
            caption_translation
        );
        window.click("subtitle-search", app);
        window.input("safe", app);
        assert_eq!(window.find("follow-subtitles").bounds(), following);
        assert_eq!(window.find("cue-scroll-ui-cue").bounds(), transcript);
        assert_ne!(window.find("reset-subtitle-filters").disabled(), Some(true));
        window.click("reset-subtitle-filters", app);
        assert_eq!(window.find("reset-subtitle-filters").disabled(), Some(true));
        assert_eq!(window.find("cue-scroll-ui-cue").bounds(), transcript);
    })
    .unwrap();
    harness.close(cx);
}

#[gpui_kit::test]
fn wheel_over_unavailable_video_and_volume_preserves_search_focus(cx: &mut TestAppContext) {
    let harness = Harness::open(cx);
    open_study(&harness, cx);
    cx.update_window(harness.window, |_, window, app| {
        window.click("subtitle-search", app);
        window.input("safe", app);
        for id in ["player-viewport", "player-volume"] {
            window.scroll(id, ScrollDelta::Lines(point(0., 3.)), app);
            assert_eq!(window.find("subtitle-search").focused(), Some(true));
            assert_eq!(window.find("subtitle-search").value(), Some("safe"));
            assert_eq!(window.find("play-toggle").disabled(), Some(true));
        }
    })
    .unwrap();
    harness.close(cx);
}

// The existing synthetic player exercises real media leases and persistence
// without a native HWND. Windows routing is covered above and in native/input.
#[cfg(feature = "e2e-test")]
mod applied {
    use super::*;
    use gpui_kit::test::TestEventExt;
    use std::sync::{Arc, Mutex, atomic::AtomicBool};

    struct PlaybackFixture {
        #[cfg(windows)]
        parent: windows_sys::Win32::Foundation::HWND,
        #[cfg(windows)]
        state: AppState,
    }

    #[cfg(windows)]
    impl Drop for PlaybackFixture {
        fn drop(&mut self) {
            self.state.shutdown();
            unsafe {
                windows_sys::Win32::UI::WindowsAndMessaging::DestroyWindow(self.parent);
            }
        }
    }

    fn ready(harness: &Harness, cx: &mut TestAppContext) -> PlaybackFixture {
        let mut store = Store::open(harness.root.path().join("learning.sqlite")).unwrap();
        let mut media = store.media("ui-media").unwrap();
        media.last_position_ms = 20_000;
        #[cfg(windows)]
        let fixture = {
            use windows_sys::Win32::UI::WindowsAndMessaging::*;
            let data_len = 60 * 8_000 * 2u32;
            let mut wave = Vec::new();
            wave.extend_from_slice(b"RIFF");
            wave.extend_from_slice(&(36 + data_len).to_le_bytes());
            wave.extend_from_slice(b"WAVEfmt ");
            wave.extend_from_slice(&16u32.to_le_bytes());
            wave.extend_from_slice(&1u16.to_le_bytes());
            wave.extend_from_slice(&1u16.to_le_bytes());
            wave.extend_from_slice(&8_000u32.to_le_bytes());
            wave.extend_from_slice(&16_000u32.to_le_bytes());
            wave.extend_from_slice(&2u16.to_le_bytes());
            wave.extend_from_slice(&16u16.to_le_bytes());
            wave.extend_from_slice(b"data");
            wave.extend_from_slice(&data_len.to_le_bytes());
            wave.resize(44 + data_len as usize, 0);
            let path = harness.root.path().join("wheel.wav");
            std::fs::write(&path, wave).unwrap();
            media.path = path.to_string_lossy().into_owned();
            media.kind = "audio".into();
            media.duration_ms = 60_000;
            let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
            let parent = unsafe {
                CreateWindowExW(
                    0,
                    class.as_ptr(),
                    std::ptr::null(),
                    WS_POPUP,
                    -32000,
                    0,
                    320,
                    200,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null(),
                )
            };
            assert!(!parent.is_null());
            // The native parent never becomes visible or focused. Rendering and
            // pointer events use GPUI's fake platform; libmpv decodes only this WAV.
            let fixture = PlaybackFixture {
                parent,
                state: harness.state.clone(),
            };
            harness
                .state
                .initialize_player(&crate::runtime::test_resources(), parent as isize, || {})
                .unwrap();
            fixture
        };
        #[cfg(not(windows))]
        let fixture = {
            harness
                .state
                .initialize_player(harness.root.path(), 0, || {})
                .unwrap();
            PlaybackFixture {}
        };
        store.put_media(&media).unwrap();
        let mut cues =
            commands::subtitles::list_segments(&harness.state, "ui-media".into()).unwrap();
        cues[0].end_ms = 60_000;
        store.set_segments("ui-media", &cues).unwrap();
        open_study(harness, cx);
        harness.wait(cx, "decoded paused fixture", |_, _| {
            #[cfg(windows)]
            unsafe {
                use windows_sys::Win32::UI::WindowsAndMessaging::*;
                let mut message = std::mem::zeroed();
                while PeekMessageW(&mut message, fixture.parent, 0, 0, PM_REMOVE) != 0 {
                    TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
            }
            let player = harness.state.player_state().unwrap();
            assert!(player.error.is_none(), "{:?}", player.error);
            player.ready && player.position_ms.abs_diff(20_000) < 100
        });
        harness.host.emit(DesktopEvent::PlayerState(
            harness.state.player_state().unwrap(),
        ));
        harness.wait_window(cx, harness.window, "enabled player", |window| {
            window.find("play-toggle").disabled() != Some(true)
        });
        fixture
    }

    fn delayed(
        cx: &mut TestAppContext,
    ) -> (
        Harness,
        Arc<AtomicBool>,
        Arc<Mutex<Vec<crate::runtime::MainThreadTask>>>,
        PlaybackFixture,
    ) {
        let delay = Arc::new(AtomicBool::new(false));
        let queue = Arc::new(Mutex::new(Vec::new()));
        let held = delay.clone();
        let dispatches = queue.clone();
        let harness = Harness::open_with_dispatch(cx, move |task| {
            if held.load(Ordering::SeqCst) {
                dispatches.lock().unwrap().push(task);
            } else {
                task();
            }
            Ok(())
        });
        let fixture = ready(&harness, cx);
        (harness, delay, queue, fixture)
    }

    #[gpui_kit::test]
    #[cfg_attr(
        windows,
        ignore = "requires prepared native resources; uses only owned hidden HWNDs"
    )]
    fn composition_video_clicks_and_moving_overlay_use_gpui_hitboxes(cx: &mut TestAppContext) {
        let (harness, _, _, _fixture) = delayed(cx);
        cx.update(|app| app.set_reduce_motion(false));
        cx.update_window(harness.window, |_, window, app| {
            window.click("close-study-companion", app);
        })
        .unwrap();
        cx.executor().advance_clock(Duration::from_millis(220));
        let expanded = cx
            .update_window(harness.window, |_, window, app| {
                window.render_frame(app);
                let bounds = window.find("player-viewport").bounds();
                window.click("toggle-transcript", app);
                bounds
            })
            .unwrap();
        cx.executor().advance_clock(Duration::from_millis(180));
        let paused = harness.state.player_state().unwrap().paused;
        cx.update_window(harness.window, |_, window, app| {
            window.render_frame(app);
            let panel = window.find("subtitle-panel").bounds();
            let search = window.find("subtitle-search").bounds();
            let position = search.center();
            assert!(position.x > panel.left());
            assert!(
                expanded.contains(&position),
                "exercise the panel strip which an older, wider HWND can still cover"
            );
            assert!(
                position.x > window.find("player-viewport").bounds().right(),
                "the current GPUI video hitbox must exclude the moving panel"
            );
            window.pointer_down(position, gpui_kit::MouseButton::Left, app);
            window.pointer_up(position, gpui_kit::MouseButton::Left, app);
            assert_eq!(window.find("subtitle-search").focused(), Some(true));
        })
        .unwrap();
        harness.drain_callbacks(cx);
        assert_eq!(harness.state.player_state().unwrap().paused, paused);
        cx.update_window(harness.window, |_, window, app| {
            window.click("player-viewport", app);
            assert_eq!(window.find("subtitle-search").focused(), Some(false));
        })
        .unwrap();
        harness.drain_callbacks(cx);
        assert_eq!(harness.state.player_state().unwrap().paused, !paused);
        cx.update_window(harness.window, |_, window, app| {
            window.scroll("player-viewport", ScrollDelta::Lines(point(0., 3.)), app);
        })
        .unwrap();
        harness.drain_callbacks(cx);
        assert!(harness.state.player_state().unwrap().position_ms < 17_000);
        harness.close(cx);
    }

    #[gpui_kit::test]
    #[cfg_attr(
        windows,
        ignore = "requires prepared native resources; uses only owned hidden HWNDs"
    )]
    fn rapid_video_and_volume_wheels_accumulate_once_and_preserve_focus(cx: &mut TestAppContext) {
        let (harness, delay, queue, _fixture) = delayed(cx);
        delay.store(true, Ordering::SeqCst);
        cx.update_window(harness.window, |_, window, app| {
            window.click("subtitle-search", app);
            for _ in 0..2 {
                window.scroll("player-viewport", ScrollDelta::Lines(point(0., 3.)), app);
            }
            for _ in 0..3 {
                window.scroll("player-volume", ScrollDelta::Lines(point(0., -3.)), app);
            }
            assert_eq!(window.find("subtitle-search").focused(), Some(true));
        })
        .unwrap();
        harness.wait(cx, "one active seek and volume", |_, _| {
            queue.lock().unwrap().len() == 2
        });
        delay.store(false, Ordering::SeqCst);
        for task in std::mem::take(&mut *queue.lock().unwrap()) {
            cx.update(|_| task());
        }
        harness.drain_callbacks(cx);
        let player = harness.state.player_state().unwrap();
        assert_eq!(
            player.position_ms, 10_000,
            "upward wheel goes back five seconds per event"
        );
        assert_eq!(player.volume, 65.);
        assert!(player.paused);
        // At boundaries extra events remain local and do not wrap or overshoot.
        cx.update_window(harness.window, |_, window, app| {
            for _ in 0..4 {
                window.scroll("player-viewport", ScrollDelta::Lines(point(0., 3.)), app);
            }
            for _ in 0..12 {
                window.scroll("player-volume", ScrollDelta::Lines(point(0., 3.)), app);
            }
        })
        .unwrap();
        harness.drain_callbacks(cx);
        let player = harness.state.player_state().unwrap();
        assert_eq!(player.position_ms, 0);
        assert_eq!(player.volume, 100.);
        let duration = player.duration_ms;
        harness
            .host
            .runtime()
            .block_on(commands::playback::player_control(
                harness.host.clone(),
                &harness.state,
                crate::player::Control {
                    action: "seek".into(),
                    value: Some(duration.saturating_sub(1_000) as f64),
                    start_ms: None,
                    end_ms: None,
                    bounds: None,
                    track_kind: None,
                },
            ))
            .unwrap();
        harness.host.emit(DesktopEvent::PlayerState(
            harness.state.player_state().unwrap(),
        ));
        harness.wait(cx, "near media end", |root, app| {
            root.session.read(app).player.position_ms >= duration - 1_100
        });
        cx.update_window(harness.window, |_, window, app| {
            window.scroll("player-viewport", ScrollDelta::Lines(point(0., -3.)), app);
            for _ in 0..24 {
                window.scroll("player-volume", ScrollDelta::Lines(point(0., -3.)), app);
            }
        })
        .unwrap();
        harness.drain_callbacks(cx);
        let player = harness.state.player_state().unwrap();
        assert!(player.position_ms.abs_diff(duration) <= 2);
        assert_eq!(player.volume, 0.);
        harness.close(cx);
    }

    #[gpui_kit::test]
    #[cfg_attr(
        windows,
        ignore = "requires prepared native resources; uses only owned hidden HWNDs"
    )]
    fn frozen_source_discards_queued_wheel_and_resumes_from_applied_position(
        cx: &mut TestAppContext,
    ) {
        let (harness, delay, queue, _fixture) = delayed(cx);
        delay.store(true, Ordering::SeqCst);
        cx.update_window(harness.window, |_, window, app| {
            for _ in 0..2 {
                window.scroll("player-viewport", ScrollDelta::Lines(point(0., -3.)), app);
            }
        })
        .unwrap();
        harness.wait(cx, "first seek held", |_, _| {
            queue.lock().unwrap().len() == 1
        });
        harness.update(cx, |root, _, cx| {
            root.sources
                .update(cx, |sources, cx| sources.freeze(true, cx))
        });
        delay.store(false, Ordering::SeqCst);
        let first = queue.lock().unwrap().remove(0);
        cx.update(|_| first());
        harness.drain_callbacks(cx);
        assert!(
            harness
                .state
                .player_state()
                .unwrap()
                .position_ms
                .abs_diff(25_000)
                <= 2
        );
        harness.update(cx, |root, _, cx| {
            root.sources
                .update(cx, |sources, cx| sources.freeze(false, cx))
        });
        cx.update_window(harness.window, |_, window, app| {
            window.scroll("player-viewport", ScrollDelta::Lines(point(0., 3.)), app)
        })
        .unwrap();
        harness.drain_callbacks(cx);
        assert!(
            harness
                .state
                .player_state()
                .unwrap()
                .position_ms
                .abs_diff(20_000)
                <= 2
        );
        harness.close(cx);
    }

    #[gpui_kit::test]
    #[cfg_attr(
        windows,
        ignore = "requires prepared native resources; uses only owned hidden HWNDs"
    )]
    fn replaced_media_rejects_active_and_queued_wheels_and_restores_volume(
        cx: &mut TestAppContext,
    ) {
        let (harness, delay, queue, _fixture) = delayed(cx);
        delay.store(true, Ordering::SeqCst);
        cx.update_window(harness.window, |_, window, app| {
            for _ in 0..2 {
                window.scroll("player-volume", ScrollDelta::Lines(point(0., -3.)), app);
            }
        })
        .unwrap();
        harness.wait(cx, "volume held", |_, _| queue.lock().unwrap().len() == 1);
        // Reserving a replacement of the same media invalidates both captured leases.
        let replacement =
            commands::playback::load_media(harness.host.clone(), &harness.state, "ui-media".into());
        delay.store(false, Ordering::SeqCst);
        let first = queue.lock().unwrap().remove(0);
        cx.update(|_| first());
        harness.drain_callbacks(cx);
        assert_eq!(harness.state.player_state().unwrap().volume, 80.);
        cx.update_window(harness.window, |_, window, app| {
            window.render_frame(app);
            assert_eq!(window.find_by_label("Volume").value(), Some("80%"));
        })
        .unwrap();
        assert!(queue.lock().unwrap().is_empty());
        drop(replacement);
        harness.close(cx);
    }

    #[gpui_kit::test]
    #[cfg_attr(
        windows,
        ignore = "requires prepared native resources; uses only owned hidden HWNDs"
    )]
    fn new_source_and_loop_intents_supersede_queued_wheel_in_both_orders(cx: &mut TestAppContext) {
        for next in ["cue-play-ui-cue", "loop-selection"] {
            let (harness, delay, queue, _fixture) = delayed(cx);
            delay.store(true, Ordering::SeqCst);
            cx.update_window(harness.window, |_, window, app| {
                window.scroll("player-viewport", ScrollDelta::Lines(point(0., 3.)), app);
                window.scroll("player-viewport", ScrollDelta::Lines(point(0., 3.)), app);
                window.click(next, app);
            })
            .unwrap();
            harness.wait(cx, "only oldest seek dispatched", |_, _| {
                queue.lock().unwrap().len() == 1
            });
            delay.store(false, Ordering::SeqCst);
            let first = queue.lock().unwrap().remove(0);
            cx.update(|_| first());
            harness.drain_callbacks(cx);
            let player = harness.state.player_state().unwrap();
            if next == "cue-play-ui-cue" {
                assert!(
                    player.position_ms < 1_000,
                    "new source play was replaced by old wheel: {}",
                    player.position_ms
                );
            } else {
                assert!(player.position_ms.abs_diff(15_000) <= 2);
                cx.update_window(harness.window, |_, window, app| {
                    window.render_frame(app);
                    assert_eq!(window.find("loop-selection").checked(), Some(true));
                })
                .unwrap();
            }
            harness.close(cx);
        }
        // A newer seek invalidates the held loop's lease. That expected old
        // rejection must still dispatch the valid latest wheel request.
        let (harness, delay, queue, _fixture) = delayed(cx);
        delay.store(true, Ordering::SeqCst);
        cx.update_window(harness.window, |_, window, app| {
            window.click("loop-selection", app);
            window.scroll("player-viewport", ScrollDelta::Lines(point(0., 3.)), app);
        })
        .unwrap();
        harness.wait(cx, "old loop held", |_, _| queue.lock().unwrap().len() == 1);
        delay.store(false, Ordering::SeqCst);
        let first = queue.lock().unwrap().remove(0);
        cx.update(|_| first());
        harness.drain_callbacks(cx);
        assert!(
            harness
                .state
                .player_state()
                .unwrap()
                .position_ms
                .abs_diff(15_000)
                <= 2
        );
        cx.update_window(harness.window, |_, window, app| {
            window.render_frame(app);
            assert_eq!(window.find("loop-selection").checked(), Some(false));
        })
        .unwrap();
        harness.close(cx);
    }

    #[gpui_kit::test]
    #[cfg_attr(
        windows,
        ignore = "requires prepared native resources; uses only owned hidden HWNDs"
    )]
    fn playback_time_and_pause_label_keep_transport_geometry(cx: &mut TestAppContext) {
        let (harness, _, _, _fixture) = delayed(cx);
        let mut player = harness.state.player_state().unwrap();
        player.duration_ms = 7_200_000;
        let mut expected = None;
        for (index, position) in [
            0, 59_000, 60_000, 599_000, 600_000, 3_599_000, 3_600_000, 7_200_000,
        ]
        .into_iter()
        .enumerate()
        {
            player.position_ms = position;
            player.paused = index % 2 == 0;
            player.revision += 1;
            harness.host.emit(DesktopEvent::PlayerState(player.clone()));
            harness.wait(cx, "new playback clock", |root, app| {
                root.session.read(app).player.revision == player.revision
            });
            let geometry = cx
                .update_window(harness.window, |_, window, app| {
                    window.render_frame(app);
                    [
                        "play-toggle",
                        "forward-five",
                        "playback-time",
                        "player-volume",
                    ]
                    .map(|id| window.find(id).bounds())
                })
                .unwrap();
            if let Some(expected) = expected {
                assert_eq!(geometry, expected);
            } else {
                expected = Some(geometry);
            }
        }
        harness.close(cx);
    }
}
