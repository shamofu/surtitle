// SPDX-License-Identifier: GPL-3.0-or-later
use super::*;
use gpui_kit::{Role, test::ElementSnapshot};

fn assert_toggle(node: ElementSnapshot, role: Role, checked: bool) {
    // These snapshots read the rendered AccessKit node's role and toggled state.
    assert_eq!(node.role(), Some(role), "{node:?}");
    assert_eq!(node.checked(), Some(checked), "{node:?}");
}

fn open_study(harness: &Harness, cx: &mut TestAppContext) {
    cx.update_window(harness.window, |_, window, app| {
        window.click(("study", 0usize), app)
    })
    .unwrap();
    harness.wait_window(cx, harness.window, "loaded transcript", |window| {
        window
            .try_find("cue-scroll-ui-cue")
            .is_some_and(|cue| cue.visible())
    });
    harness.drain_callbacks(cx);
}

#[gpui_kit::test]
fn study_toggles_report_filter_and_translation_state_after_real_actions(cx: &mut TestAppContext) {
    let harness = Harness::open(cx);
    let mut marked = commands::subtitles::list_segments(&harness.state, "ui-media".into())
        .unwrap()
        .remove(0);
    let plain = SubtitleSegment {
        id: "plain-cue".into(),
        ..marked.clone()
    };
    marked.status = "generated_review".into();
    Store::open(harness.root.path().join("learning.sqlite"))
        .unwrap()
        .set_segments("ui-media", &[marked, plain])
        .unwrap();
    open_study(&harness, cx);
    cx.update_window(harness.window, |_, window, app| {
        assert_toggle(window.find("marked-subtitles"), Role::CheckBox, false);
        assert_toggle(window.find("transcript-translation"), Role::Button, false);
        assert_toggle(window.find("caption-translation"), Role::Button, false);
        window.click("transcript-translation", app);
        assert_toggle(window.find("transcript-translation"), Role::Button, true);
        assert_toggle(window.find("caption-translation"), Role::Button, true);
        assert_eq!(
            window.find("caption-translation").label(),
            Some("Hide translation")
        );
        window.click("caption-translation", app);
        assert_toggle(window.find("transcript-translation"), Role::Button, false);
        assert_toggle(window.find("caption-translation"), Role::Button, false);
        assert_eq!(
            window.find("transcript-translation").label(),
            Some("Show translations")
        );
        assert!(window.find("cue-scroll-plain-cue").visible());
        window.click("marked-subtitles", app);
        assert_toggle(window.find("marked-subtitles"), Role::CheckBox, true);
        assert!(window.find("cue-scroll-ui-cue").visible());
        assert!(
            window
                .try_find("cue-scroll-plain-cue")
                .is_none_or(|node| !node.visible())
        );
        window.click("reset-subtitle-filters", app);
        assert_toggle(window.find("marked-subtitles"), Role::CheckBox, false);
        assert!(window.find("cue-scroll-plain-cue").visible());
    })
    .unwrap();
    harness.close(cx);
}

#[gpui_kit::test]
fn study_toggles_keep_state_when_disabled_and_report_actual_fullscreen(cx: &mut TestAppContext) {
    let harness = Harness::open(cx);
    open_study(&harness, cx);
    cx.update_window(harness.window, |_, window, app| {
        for (id, role) in [
            ("marked-subtitles", Role::CheckBox),
            ("loop-selection", Role::Button),
            ("fullscreen", Role::Button),
        ] {
            assert_eq!(window.find(id).disabled(), Some(true));
            assert_toggle(window.find(id), role, false);
            window.click(id, app);
            assert_toggle(window.find(id), role, false);
        }
        assert!(!window.is_fullscreen());
        // The semantic value follows the actual window state, even if media is unavailable.
        window.toggle_fullscreen();
        window.render_frame(app);
        assert_toggle(window.find("fullscreen"), Role::Button, true);
        window.toggle_fullscreen();
        window.render_frame(app);
        assert_toggle(window.find("fullscreen"), Role::Button, false);
        window.click("playback-settings", app);
    })
    .unwrap();
    harness.wait(cx, "playback settings", |_, app| app.windows().len() == 2);
    let dialog = cx.read(|app| {
        app.windows()
            .into_iter()
            .find(|window| *window != harness.window)
            .unwrap()
    });
    cx.update_window(dialog, |_, window, app| {
        window.render_frame(app);
        assert_eq!(window.find("sentence-pause").disabled(), Some(true));
        assert_toggle(window.find("sentence-pause"), Role::CheckBox, false);
        window.click("sentence-pause", app);
        assert_toggle(window.find("sentence-pause"), Role::CheckBox, false);
        window.remove_window();
    })
    .unwrap();
    harness.close(cx);
}

// The existing synthetic player executes the media-bound commands without an HWND or libmpv.
#[cfg(all(not(windows), feature = "e2e-test"))]
#[gpui_kit::test]
fn study_toggles_report_pause_loop_and_rate_after_applied_playback_actions(
    cx: &mut TestAppContext,
) {
    let harness = Harness::open(cx);
    harness
        .state
        .initialize_player(harness.root.path(), 0, || {})
        .unwrap();
    open_study(&harness, cx);
    harness.host.emit(DesktopEvent::PlayerState(
        harness.state.player_state().unwrap(),
    ));
    harness.wait_window(cx, harness.window, "ready playback", |window| {
        window.find("playback-rate-trigger").disabled() != Some(true)
    });
    cx.update_window(harness.window, |_, window, app| {
        window.click("playback-settings", app)
    })
    .unwrap();
    harness.wait(cx, "playback settings", |_, app| app.windows().len() == 2);
    let dialog = cx.read(|app| {
        app.windows()
            .into_iter()
            .find(|window| *window != harness.window)
            .unwrap()
    });
    for checked in [true, false] {
        cx.update_window(dialog, |_, window, app| {
            window.render_frame(app);
            assert_toggle(window.find("sentence-pause"), Role::CheckBox, !checked);
            assert_ne!(window.find("sentence-pause").disabled(), Some(true));
            window.click("sentence-pause", app);
        })
        .unwrap();
        harness.drain_callbacks(cx);
        assert_eq!(
            harness.state.player_state().unwrap().sentence_pause,
            checked
        );
        harness.host.emit(DesktopEvent::PlayerState(
            harness.state.player_state().unwrap(),
        ));
        harness.wait_window(cx, dialog, "applied sentence pause", |window| {
            window.find("sentence-pause").checked() == Some(checked)
        });
    }
    cx.update_window(dialog, |_, window, _| window.remove_window())
        .unwrap();
    for checked in [true, false] {
        cx.update_window(harness.window, |_, window, app| {
            window.render_frame(app);
            assert_toggle(window.find("loop-selection"), Role::Button, !checked);
            window.click("loop-selection", app);
        })
        .unwrap();
        harness.drain_callbacks(cx);
        harness.wait_window(cx, harness.window, "applied loop state", |window| {
            window.find("loop-selection").checked() == Some(checked)
        });
    }
    cx.update_window(harness.window, |_, window, app| {
        window.click("playback-rate-trigger", app)
    })
    .unwrap();
    harness.wait_window(cx, harness.window, "rate presets", |window| {
        window
            .try_find(("rate", 5usize))
            .is_some_and(|button| button.visible())
    });
    cx.update_window(harness.window, |_, window, app| {
        assert_toggle(window.find(("rate", 2usize)), Role::Button, true);
        assert_toggle(window.find(("rate", 5usize)), Role::Button, false);
        window.click(("rate", 5usize), app);
    })
    .unwrap();
    harness.drain_callbacks(cx);
    assert_eq!(harness.state.player_state().unwrap().rate, 1.5);
    cx.update_window(harness.window, |_, window, app| {
        window.render_frame(app);
        assert_toggle(window.find(("rate", 2usize)), Role::Button, false);
        assert_toggle(window.find(("rate", 5usize)), Role::Button, true);
    })
    .unwrap();
    harness.close(cx);
}
