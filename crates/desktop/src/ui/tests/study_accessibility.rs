// SPDX-License-Identifier: GPL-3.0-or-later
use super::keyboard::assert_accessible_static_text;
use super::*;

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

fn assert_caption_and_transcript(window: &Window, source: &str, translation: Option<&str>) {
    assert_eq!(
        window.find("caption-selection").label(),
        Some("Current subtitle")
    );
    assert_eq!(
        window.find("cue-scroll-ui-cue").label(),
        Some("Subtitle text")
    );
    for id in ["caption-accessible-text", "cue-accessible-text-ui-cue"] {
        assert_accessible_static_text(window, id, source);
    }
    for id in ["caption-translation-text", "cue-translation-ui-cue"] {
        if let Some(translation) = translation {
            assert_accessible_static_text(window, id, translation);
        } else {
            assert!(
                window.try_find(id).is_none(),
                "hidden translation remains exposed: {id}"
            );
        }
    }
}

#[gpui_kit::test]
fn caption_and_transcript_expose_updated_text_and_only_visible_translations(
    cx: &mut TestAppContext,
) {
    let harness = Harness::open(cx);
    open_study(&harness, cx);
    cx.update_window(harness.window, |_, window, app| {
        assert_caption_and_transcript(window, "Make yourself at home.", None);
        window.click("transcript-translation", app);
        assert_caption_and_transcript(
            window,
            "Make yourself at home.",
            Some("くつろいでください。"),
        );
    })
    .unwrap();

    let mut cue = commands::subtitles::list_segments(&harness.state, "ui-media".into())
        .unwrap()
        .remove(0);
    cue.text = "Please take a seat.".into();
    cue.translation = Some("どうぞお座りください。".into());
    Store::open(harness.root.path().join("learning.sqlite"))
        .unwrap()
        .set_segments("ui-media", &[cue])
        .unwrap();
    harness
        .state
        .changes
        .publish(ChangeDomain::Subtitles, Some("ui-media".into()));
    harness.wait_window(cx, harness.window, "updated current subtitle", |window| {
        window.find("caption-accessible-text").value() == Some("Please take a seat.")
    });
    cx.update_window(harness.window, |_, window, app| {
        assert_caption_and_transcript(
            window,
            "Please take a seat.",
            Some("どうぞお座りください。"),
        );
        window.click("caption-translation", app);
        assert_caption_and_transcript(window, "Please take a seat.", None);
    })
    .unwrap();
    harness.close(cx);
}

#[cfg(all(not(windows), feature = "e2e-test"))]
#[gpui_kit::test]
fn current_caption_accessible_values_follow_the_playback_clock(cx: &mut TestAppContext) {
    let harness = Harness::open(cx);
    let first = commands::subtitles::list_segments(&harness.state, "ui-media".into())
        .unwrap()
        .remove(0);
    let second = SubtitleSegment {
        id: "second-cue".into(),
        start_ms: 5000,
        end_ms: 6000,
        text: "Please take a seat.".into(),
        translation: Some("どうぞお座りください。".into()),
        ..first.clone()
    };
    Store::open(harness.root.path().join("learning.sqlite"))
        .unwrap()
        .set_segments("ui-media", &[first, second])
        .unwrap();
    harness
        .state
        .initialize_player(harness.root.path(), 0, || {})
        .unwrap();
    open_study(&harness, cx);
    harness.host.emit(DesktopEvent::PlayerState(
        harness.state.player_state().unwrap(),
    ));
    harness.wait_window(cx, harness.window, "ready seek action", |window| {
        window.find("forward-five").disabled() != Some(true)
    });
    cx.update_window(harness.window, |_, window, app| {
        window.click("caption-translation", app);
        assert_accessible_static_text(window, "caption-accessible-text", "Make yourself at home.");
        assert_accessible_static_text(window, "caption-translation-text", "くつろいでください。");
        window.click("forward-five", app);
    })
    .unwrap();
    harness.drain_callbacks(cx);
    let player = harness.state.player_state().unwrap();
    assert_eq!(player.position_ms, 5000);
    harness.host.emit(DesktopEvent::PlayerState(player));
    harness.wait_window(cx, harness.window, "next current subtitle", |window| {
        window.find("caption-accessible-text").value() == Some("Please take a seat.")
    });
    cx.update_window(harness.window, |_, window, _| {
        assert_accessible_static_text(window, "caption-accessible-text", "Please take a seat.");
        assert_accessible_static_text(window, "caption-translation-text", "どうぞお座りください。");
        // Advancing the current caption does not replace the first transcript row.
        assert_accessible_static_text(
            window,
            "cue-accessible-text-ui-cue",
            "Make yourself at home.",
        );
        assert_accessible_static_text(
            window,
            "cue-accessible-text-second-cue",
            "Please take a seat.",
        );
    })
    .unwrap();
    harness.close(cx);
}
