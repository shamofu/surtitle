// SPDX-License-Identifier: GPL-3.0-or-later
use super::*;
use gpui_kit::{InputEvent as _, KeyDownEvent, Keystroke};
use std::sync::{Arc, Mutex};

fn record_fullscreen(harness: &Harness, cx: &mut TestAppContext) -> Arc<Mutex<Vec<Option<bool>>>> {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let recorded = requests.clone();
    let events = harness.host.clone();
    let host = DesktopHost::new(
        harness.host.runtime().clone(),
        |task| {
            task();
            Ok(())
        },
        move |action| {
            if let crate::runtime::WindowAction::SetFullscreen(value) = action {
                recorded.lock().unwrap().push(value);
            }
            Ok(())
        },
        move |event| events.emit(event),
    );
    harness.update(cx, |root, _, cx| {
        root.session
            .update(cx, |session, _| session.backend.host = host);
    });
    requests
}

fn open_study(harness: &Harness, cx: &mut TestAppContext) {
    cx.update_window(harness.window, |_, window, app| {
        window.click(("study", 0usize), app)
    })
    .unwrap();
    harness.wait_window(cx, harness.window, "study transport", |window| {
        window
            .try_find("playback-settings")
            .is_some_and(|button| button.visible())
    });
    harness.drain_callbacks(cx);
}

fn tab_to(window: &mut Window, app: &mut App, id: &'static str) {
    for _ in 0..100 {
        if window.find(id).focused() == Some(true) {
            return;
        }
        window.press("tab", app);
    }
    panic!("focus did not reach {id}");
}

fn escape(window: &mut Window, app: &mut App, prefer_character_input: bool) {
    window.dispatch_event(
        KeyDownEvent {
            keystroke: Keystroke::parse_with_os("escape", app.platform_info().os).unwrap(),
            is_held: false,
            prefer_character_input,
        }
        .to_platform_input(),
        app,
    );
}

#[gpui_kit::test]
fn study_fullscreen_escape_from_a_transport_button_requests_exit(cx: &mut TestAppContext) {
    let harness = Harness::open(cx);
    let requests = record_fullscreen(&harness, cx);
    open_study(&harness, cx);
    cx.update_window(harness.window, |_, window, app| {
        window.toggle_fullscreen();
        window.render_frame(app);
        tab_to(window, app, "playback-settings");
        assert!(window.is_fullscreen());
        window.press("escape", app);
    })
    .unwrap();
    harness.drain_callbacks(cx);
    assert_eq!(
        *requests.lock().unwrap(),
        vec![Some(false)],
        "Escape must request normal window mode from an ordinary transport button"
    );
    harness.close(cx);
}

#[gpui_kit::test]
fn study_fullscreen_escape_preserves_search_and_character_input(cx: &mut TestAppContext) {
    let harness = Harness::open(cx);
    let requests = record_fullscreen(&harness, cx);
    open_study(&harness, cx);
    cx.update_window(harness.window, |_, window, app| {
        window.click("subtitle-search", app);
        window.input("日本語", app);
        assert_eq!(window.find("subtitle-search").focused(), Some(true));
        // A native fullscreen transition can precede the next layout. The
        // still-focused editor must retain Escape during that interval too.
        window.toggle_fullscreen();
        escape(window, app, false);
        escape(window, app, true);
    })
    .unwrap();
    harness.drain_callbacks(cx);
    assert!(
        requests.lock().unwrap().is_empty(),
        "a focused editor must retain Escape"
    );
    cx.update_window(harness.window, |_, window, app| {
        window.render_frame(app);
        assert!(
            window
                .try_find("subtitle-search")
                .is_none_or(|search| !search.visible())
        );
        // Rendering the hidden companion must hand off the old editor focus;
        // Tab must work without test-only blur/focus repair.
        tab_to(window, app, "playback-settings");
        escape(window, app, true);
    })
    .unwrap();
    harness.drain_callbacks(cx);
    assert!(
        requests.lock().unwrap().is_empty(),
        "platform character/composition input must not exit fullscreen"
    );
    cx.update_window(harness.window, |_, window, app| window.press("escape", app))
        .unwrap();
    harness.drain_callbacks(cx);
    assert_eq!(
        *requests.lock().unwrap(),
        vec![Some(false)],
        "Escape must work after the hidden editor hands off focus"
    );
    cx.update_window(harness.window, |_, window, app| {
        window.toggle_fullscreen();
        window.render_frame(app);
        assert_eq!(window.find("subtitle-search").value(), Some("日本語"));
    })
    .unwrap();
    harness.close(cx);
}

#[cfg(all(not(windows), feature = "e2e-test"))]
#[gpui_kit::test]
fn study_fullscreen_popup_dismisses_before_exit_and_slider_can_exit(cx: &mut TestAppContext) {
    let harness = Harness::open(cx);
    harness
        .state
        .initialize_player(harness.root.path(), 0, || {})
        .unwrap();
    let requests = record_fullscreen(&harness, cx);
    open_study(&harness, cx);
    harness.host.emit(DesktopEvent::PlayerState(
        harness.state.player_state().unwrap(),
    ));
    harness.wait_window(cx, harness.window, "ready rate control", |window| {
        let trigger = window.find("playback-rate-trigger");
        trigger.visible() && trigger.disabled() != Some(true)
    });
    cx.update_window(harness.window, |_, window, app| {
        window.toggle_fullscreen();
        window.render_frame(app);
        window.click("playback-rate-trigger", app);
    })
    .unwrap();
    harness.wait_window(cx, harness.window, "open rate popup", |window| {
        window
            .try_find("close-playback-rate")
            .is_some_and(|button| button.visible())
    });
    cx.update_window(harness.window, |_, window, app| window.press("escape", app))
        .unwrap();
    harness.drain_callbacks(cx);
    assert!(
        requests.lock().unwrap().is_empty(),
        "the first Escape belongs to the open popup"
    );
    harness.wait_window(cx, harness.window, "dismissed rate popup", |window| {
        window
            .try_find("close-playback-rate")
            .is_none_or(|button| !button.visible())
    });
    cx.update_window(harness.window, |_, window, app| {
        for _ in 0..100 {
            if window.find_by_label("Playback position").focused() == Some(true) {
                break;
            }
            window.press("tab", app);
        }
        assert_eq!(
            window.find_by_label("Playback position").focused(),
            Some(true)
        );
        assert!(window.is_fullscreen());
        window.press("escape", app);
    })
    .unwrap();
    harness.drain_callbacks(cx);
    assert_eq!(
        *requests.lock().unwrap(),
        vec![Some(false)],
        "an ordinary focused slider must permit fullscreen exit after the popup closes"
    );
    harness.close(cx);
}
