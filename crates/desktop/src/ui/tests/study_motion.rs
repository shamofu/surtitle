// SPDX-License-Identifier: GPL-3.0-or-later
use super::*;
use gpui_kit::{
    component::{WindowExt, input::AnyInputState},
    test::TestInput,
};

#[gpui_kit::test]
fn companion_width_and_tab_midflight_reduction_settle_without_replay(cx: &mut TestAppContext) {
    let harness = Harness::open(cx);
    open(&harness, cx);
    let original = cx
        .update_window(harness.window, |_, window, app| {
            let original = window.find("player-viewport").bounds();
            window.click("close-study-companion", app);
            original
        })
        .unwrap();
    advance(&harness, cx, 100);
    cx.update_window(harness.window, |_, window, app| {
        assert!(window.find("player-viewport").bounds().size.width > original.size.width);
        window.click("study-tools", app);
    })
    .unwrap();
    advance(&harness, cx, 35);
    cx.update_window(harness.window, |_, window, app| {
        assert!(window.find("player-viewport").bounds().size.width > original.size.width);
        assert!(
            companion_poses(window).len() > 1,
            "tab and width must both be moving"
        );
        app.set_reduce_motion(true);
        window.render_frame(app);
        assert_eq!(window.find("player-viewport").bounds(), original);
        assert_eq!(companion_poses(window).len(), 1);
        assert!(window.find("study-page-tools").visible());
        assert_companion_covered(window);
        assert_accessibility_contains(window, "Add or switch subtitles", false);
        app.set_reduce_motion(false);
        window.render_frame(app);
        assert_eq!(window.find("player-viewport").bounds(), original);
        assert_eq!(companion_poses(window).len(), 1);
    })
    .unwrap();
    advance(&harness, cx, 400);
    cx.update_window(harness.window, |_, window, _| {
        assert_eq!(window.find("player-viewport").bounds(), original);
        assert_eq!(companion_poses(window).len(), 1);
        assert_companion_covered(window);
    })
    .unwrap();
    harness.close(cx);
}

#[gpui_kit::test]
fn preedit_panel_handoff_retires_the_outgoing_window_input_handler(cx: &mut TestAppContext) {
    let harness = Harness::open(cx);
    open(&harness, cx);
    let input = cx
        .update_window(harness.window, |_, window, app| {
            window.click("subtitle-search", app);
            let Some(AnyInputState::Input(input)) = window.focused_input(app) else {
                panic!("focused transcript search")
            };
            let bounds = window.find("subtitle-search").bounds();
            let mut ime = TestInput::new(
                gpui_kit::ElementInputHandler::new(bounds, input.clone()),
                window,
            );
            ime.compose_text(None, "にほん", Some(0..3), app);
            assert_eq!(ime.marked_text_range(app), Some(0..3));
            window.click("study-tools", app);
            input
        })
        .unwrap();
    advance(&harness, cx, 70);
    cx.update_window(harness.window, |_, window, app| {
        assert!(
            window.find("study-page-transcript").visible(),
            "old input remains painted during the test"
        );
        let previous = input.read(app).value().to_string();
        window.input("追加", app);
        assert_eq!(input.read(app).value().as_str(), previous);
        assert!(window.focused_input(app).is_none());
    })
    .unwrap();
    advance(&harness, cx, 310);
    cx.update_window(harness.window, |_, window, app| {
        window.press("tab", app);
        assert_eq!(window.find("close-study-companion").focused(), Some(true));
        window.press("tab", app);
        assert_eq!(window.find("manage-media").focused(), Some(true));
    })
    .unwrap();
    harness.close(cx);
}

#[gpui_kit::test]
fn repeated_companion_reversal_finishes_at_the_remaining_distance_deadline(
    cx: &mut TestAppContext,
) {
    let harness = Harness::open(cx);
    open(&harness, cx);
    let (opened, closed) = cx
        .update_window(harness.window, |_, window, app| {
            let opened = window.find("player-viewport").bounds();
            app.set_reduce_motion(true);
            window.click("close-study-companion", app);
            let closed = window.find("player-viewport").bounds();
            window.click("toggle-transcript", app);
            app.set_reduce_motion(false);
            window.render_frame(app);
            window.click("close-study-companion", app);
            (opened, closed)
        })
        .unwrap();
    advance(&harness, cx, 120);
    cx.update_window(harness.window, |_, window, app| {
        window.click("toggle-transcript", app)
    })
    .unwrap();
    advance(&harness, cx, 75);
    let remaining = cx
        .update_window(harness.window, |_, window, app| {
            let displayed = window.find("player-viewport").bounds();
            let fraction = f32::from(closed.size.width - displayed.size.width)
                / f32::from(closed.size.width - opened.size.width);
            assert!(
                fraction > 0.6 && fraction < 0.9,
                "second reversal must interrupt an actual partial reveal"
            );
            // The stationary header remains reachable while the panel's own
            // close button can still be clipped during its reveal.
            window.click("toggle-transcript", app);
            assert_eq!(window.find("player-viewport").bounds(), displayed);
            crate::ui::motion::EXIT.mul_f32(fraction) + Duration::from_millis(5)
        })
        .unwrap();
    cx.executor().advance_clock(remaining);
    cx.update_window(harness.window, |_, window, app| {
        window.render_frame(app);
        assert_eq!(
            window.find("player-viewport").bounds(),
            closed,
            "a second reversal must use remaining distance, not restart the full exit duration"
        );
        assert!(window.try_find("study-page-transcript").is_none());
    })
    .unwrap();
    harness.close(cx);
}

#[gpui_kit::test]
fn repeated_caption_reversal_finishes_at_the_remaining_distance_deadline(cx: &mut TestAppContext) {
    let harness = Harness::open(cx);
    open(&harness, cx);
    let shown = cx
        .update_window(harness.window, |_, window, app| {
            app.set_reduce_motion(true);
            window.click("caption-translation", app);
            let shown = window.find("caption-selection").bounds();
            window.click("caption-translation", app);
            app.set_reduce_motion(false);
            window.render_frame(app);
            window.click("caption-translation", app);
            shown
        })
        .unwrap();
    advance(&harness, cx, 170);
    cx.update_window(harness.window, |_, window, app| {
        window.click("caption-translation", app)
    })
    .unwrap();
    advance(&harness, cx, 65);
    cx.update_window(harness.window, |_, window, app| {
        let displayed = window.find("caption-selection").bounds();
        assert!(displayed.size.height > shown.size.height);
        window.click("caption-translation", app);
        assert_eq!(window.find("caption-selection").bounds(), displayed);
    })
    .unwrap();
    // Show340ms halfway -> hide130ms halfway leaves progress0.25.
    // The next show therefore has only340ms *0.75 =255ms of travel.
    advance(&harness, cx, 260);
    cx.update_window(harness.window, |_, window, _| {
        assert_eq!(
            window.find("caption-selection").bounds(),
            shown,
            "second reversal must finish after the remaining75% of its enter duration"
        );
    })
    .unwrap();
    harness.close(cx);
}

fn open(harness: &Harness, cx: &mut TestAppContext) {
    cx.update_window(harness.window, |_, window, app| {
        window.activate_accessibility_for_test();
        window.click(("study", 0usize), app)
    })
    .unwrap();
    harness.wait_window(cx, harness.window, "study transcript", |window| {
        window
            .try_find("subtitle-search")
            .is_some_and(|node| node.visible())
    });
    harness.drain_callbacks(cx);
    cx.update(|app| app.set_reduce_motion(false));
}

fn assert_accessibility_contains(window: &Window, text: &str, present: bool) {
    let tree = window
        .debug_a11y_tree_json()
        .expect("activated AccessKit tree");
    assert_eq!(
        tree.contains(text),
        present,
        "AccessKit visibility of {text}: {tree}"
    );
}

fn companion_poses(window: &Window) -> Vec<(&'static str, Bounds<gpui_kit::Pixels>)> {
    [
        "study-page-transcript",
        "study-page-transcription",
        "study-page-suggestions",
        "study-page-tools",
        "study-page-meaning",
    ]
    .into_iter()
    .filter_map(|id| window.try_find(id).map(|node| (id, node.bounds())))
    .collect()
}

fn assert_companion_covered(window: &Window) {
    let panel = window.find("subtitle-panel").bounds();
    let left = f32::from(panel.origin.x) + 1.;
    let right = f32::from(panel.origin.x + panel.size.width) - 1.;
    let mut intervals: Vec<_> = companion_poses(window)
        .into_iter()
        .map(|(_, bounds)| {
            (
                f32::from(bounds.origin.x),
                f32::from(bounds.origin.x + bounds.size.width),
            )
        })
        .collect();
    intervals.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut edge = left;
    for (start, end) in intervals {
        if end <= left || start >= right {
            continue;
        }
        assert!(
            start <= edge + 0.25,
            "blank companion strip at {edge}: {:?}",
            companion_poses(window)
        );
        edge = edge.max(end);
    }
    assert!(
        edge >= right - 0.25,
        "uncovered companion trailing edge in {panel:?}: {:?}",
        companion_poses(window)
    );
}

fn advance(harness: &Harness, cx: &mut TestAppContext, millis: u64) {
    cx.executor().advance_clock(Duration::from_millis(millis));
    cx.update_window(harness.window, |_, window, app| window.render_frame(app))
        .unwrap();
}

fn transcript_filter_fixture(harness: &Harness) -> Vec<SubtitleSegment> {
    let template = commands::subtitles::list_segments(&harness.state, "ui-media".into())
        .unwrap()
        .remove(0);
    let cues = [
        ("ui-cue", "Keep first", 0, true),
        ("motion-middle", "Remove middle", 1000, false),
        ("motion-last", "Keep last", 2000, true),
    ]
    .into_iter()
    .map(|(id, text, start, marked)| SubtitleSegment {
        id: id.into(),
        text: text.into(),
        start_ms: start,
        end_ms: start + 900,
        status: if marked {
            "generated_review"
        } else {
            "confirmed"
        }
        .into(),
        ..template.clone()
    })
    .collect::<Vec<_>>();
    Store::open(harness.root.path().join("learning.sqlite"))
        .unwrap()
        .set_segments("ui-media", &cues)
        .unwrap();
    cues
}

#[gpui_kit::test]
fn transcript_user_search_moves_visible_rows_and_their_real_click_targets(cx: &mut TestAppContext) {
    use gpui_kit::test::TestEventExt;
    let harness = Harness::open(cx);
    transcript_filter_fixture(&harness);
    open(&harness, cx);
    let original = cx
        .update_window(harness.window, |_, window, app| {
            window.render_frame(app);
            let original = window.find("cue-row-motion-last").bounds();
            assert!(window.find("cue-select-motion-last").visible());
            window.click("subtitle-search", app);
            window.input("Keep", app);
            original
        })
        .unwrap();
    cx.run_until_parked();
    cx.update_window(harness.window, |_, window, app| {
        window.render_frame(app);
        assert_eq!(window.find("subtitle-search").value(), Some("Keep"));
        assert_eq!(
            window.find("cue-row-motion-last").bounds(),
            original,
            "filter starts at the measured painted pose"
        );
        assert_eq!(window.find("subtitle-search").focused(), Some(true));
    })
    .unwrap();
    advance(&harness, cx, 190);
    cx.update_window(harness.window, |_, window, app| {
        let moving = window.find("cue-row-motion-last").bounds();
        assert!(moving.top() < original.top() && moving.top() > original.top() - px(132.));
        let target = window.find("cue-select-motion-last").bounds().center();
        window.pointer_down(target, gpui_kit::MouseButton::Left, app);
        window.pointer_up(target, gpui_kit::MouseButton::Left, app);
        assert_eq!(
            window.find("cue-select-motion-last").label(),
            Some("Deselect")
        );
        assert_eq!(window.find("cue-select-ui-cue").label(), Some("Select"));
    })
    .unwrap();
    advance(&harness, cx, 190);
    cx.update_window(harness.window, |_, window, app| {
        assert_eq!(
            window.find("cue-row-motion-last").bounds().top(),
            original.top() - px(132.)
        );
        window.click("reset-subtitle-filters", app);
        app.set_reduce_motion(true);
        window.render_frame(app);
        assert_eq!(
            window.find("cue-row-motion-last").bounds().top(),
            original.top()
        );
        app.set_reduce_motion(false);
        window.render_frame(app);
        assert_eq!(
            window.find("cue-row-motion-last").bounds().top(),
            original.top()
        );
        window.click("marked-subtitles", app);
        assert_eq!(
            window.find("cue-row-motion-last").bounds().top(),
            original.top()
        );
    })
    .unwrap();
    advance(&harness, cx, 380);
    cx.update_window(harness.window, |_, window, _| {
        assert_eq!(
            window.find("cue-row-motion-last").bounds().top(),
            original.top() - px(132.)
        )
    })
    .unwrap();
    harness.close(cx);
}

#[gpui_kit::test]
fn transcript_follow_and_background_updates_adopt_current_rows_without_filter_motion(
    cx: &mut TestAppContext,
) {
    let harness = Harness::open(cx);
    let mut cues = transcript_filter_fixture(&harness);
    open(&harness, cx);
    cx.update_window(harness.window, |_, window, app| {
        window.click("subtitle-search", app);
        window.input("Keep", app);
    })
    .unwrap();
    cx.run_until_parked();
    advance(&harness, cx, 60);
    cx.update_window(harness.window, |_, window, app| {
        window.click("follow-subtitles", app);
        let first = window.find("cue-row-ui-cue").bounds();
        let last = window.find("cue-row-motion-last").bounds();
        assert_eq!(
            last.top() - first.top(),
            px(132.),
            "follow cancels an outstanding user filter transform immediately"
        );
    })
    .unwrap();
    harness
        .host
        .emit(DesktopEvent::PlayerState(crate::player::PlayerState {
            revision: 500,
            media_id: Some("ui-media".into()),
            ready: true,
            position_ms: 2200,
            duration_ms: 4000,
            volume: 80.,
            rate: 1.,
            ..Default::default()
        }));
    harness.wait(cx, "new playback caption", |root, app| {
        root.session.read(app).player.revision == 500
    });
    cx.update_window(harness.window, |_, window, app| {
        window.render_frame(app);
        // This fake-platform fixture has no successfully loaded native player;
        // a later sample must not bypass that existing caption/load guard.
        assert_eq!(
            window.find("caption-accessible-text").value(),
            Some("Keep first")
        );
        assert_eq!(
            window.find("cue-row-motion-last").bounds().top()
                - window.find("cue-row-ui-cue").bounds().top(),
            px(132.)
        );
    })
    .unwrap();
    cues[1].text = "Keep incoming middle".into();
    Store::open(harness.root.path().join("learning.sqlite"))
        .unwrap()
        .set_segments("ui-media", &cues)
        .unwrap();
    harness
        .state
        .changes
        .publish(ChangeDomain::Subtitles, Some("ui-media".into()));
    harness.wait_window(
        cx,
        harness.window,
        "background subtitle projection",
        |window| {
            window
                .try_find("cue-accessible-text-motion-middle")
                .is_some_and(|node| node.value() == Some("Keep incoming middle"))
        },
    );
    cx.update_window(harness.window, |_, window, _| {
        assert_eq!(
            window.find("cue-row-motion-last").bounds().top()
                - window.find("cue-row-ui-cue").bounds().top(),
            px(264.),
            "source refresh and incoming rows adopt current layout immediately"
        );
    })
    .unwrap();
    harness.close(cx);
}

#[gpui_kit::test]
fn transcript_scroll_and_resize_rebase_an_active_user_filter(cx: &mut TestAppContext) {
    let harness = Harness::open(cx);
    let mut cues = transcript_filter_fixture(&harness);
    for index in 3..8 {
        cues.push(SubtitleSegment {
            id: format!("motion-extra-{index}"),
            text: format!("Keep extra {index}"),
            start_ms: index * 1000,
            end_ms: index * 1000 + 900,
            ..cues[1].clone()
        });
    }
    Store::open(harness.root.path().join("learning.sqlite"))
        .unwrap()
        .set_segments("ui-media", &cues)
        .unwrap();
    open(&harness, cx);
    cx.update_window(harness.window, |_, window, app| {
        window.click("subtitle-search", app);
        window.input("Keep", app);
    })
    .unwrap();
    cx.run_until_parked();
    advance(&harness, cx, 60);
    cx.update_window(harness.window, |_, window, app| {
        window.scroll(
            "cue-select-motion-last",
            ScrollDelta::Pixels(point(px(0.), px(-70.))),
            app,
        );
        assert_eq!(
            window.find("cue-row-motion-last").bounds().top()
                - window.find("cue-row-ui-cue").bounds().top(),
            px(132.),
            "wheel scrolling must cancel stale screen-space motion"
        );
        assert_eq!(
            window.find("cue-row-motion-extra-4").bounds().top()
                - window.find("cue-row-motion-last").bounds().top(),
            px(264.),
            "newly visible virtual rows adopt layout immediately"
        );
        window.click("reset-subtitle-filters", app);
    })
    .unwrap();
    cx.simulate_window_resize(harness.window, size(px(1300.), px(1000.)));
    cx.update_window(harness.window, |_, window, app| {
        window.render_frame(app);
        assert_eq!(
            window.find("cue-row-motion-last").bounds().top()
                - window.find("cue-row-ui-cue").bounds().top(),
            px(264.),
            "resize settles the active filter at the responsive viewport"
        );
    })
    .unwrap();
    harness.close(cx);
}

#[gpui_kit::test]
fn companion_motion_reverses_without_jumping_and_preserves_the_query(cx: &mut TestAppContext) {
    let harness = Harness::open(cx);
    open(&harness, cx);
    let original = cx
        .update_window(harness.window, |_, window, app| {
            window.click("subtitle-search", app);
            window.input("home", app);
            let bounds = window.find("player-viewport").bounds();
            window.click("close-study-companion", app);
            assert_eq!(
                window.find("player-viewport").bounds(),
                bounds,
                "closing starts at displayed geometry"
            );
            assert_accessibility_contains(window, "Add or switch subtitles", false);
            assert!(
                window
                    .try_find("subtitle-search")
                    .is_none_or(|node| node.focused() != Some(true))
            );
            window.input("must not edit hidden search", app);
            bounds
        })
        .unwrap();
    advance(&harness, cx, 120);
    let middle = cx
        .update_window(harness.window, |_, window, app| {
            let middle = window.find("player-viewport").bounds();
            assert!(middle.size.width > original.size.width);
            window.click("toggle-transcript", app);
            assert_eq!(
                window.find("player-viewport").bounds(),
                middle,
                "reversal must use displayed pose"
            );
            middle
        })
        .unwrap();
    advance(&harness, cx, 350);
    cx.update_window(harness.window, |_, window, _| {
        assert_eq!(window.find("player-viewport").bounds(), original);
        assert_eq!(window.find("subtitle-search").value(), Some("home"));
        assert!(middle.size.width > window.find("player-viewport").bounds().size.width);
    })
    .unwrap();
    harness.close(cx);
}

#[gpui_kit::test]
fn caption_translation_reallocates_inside_fixed_frame_and_reduced_motion_settles(
    cx: &mut TestAppContext,
) {
    let harness = Harness::open(cx);
    open(&harness, cx);
    let (video, original) = cx
        .update_window(harness.window, |_, window, app| {
            let video = window.find("player-viewport").bounds();
            let original = window.find("caption-selection").bounds();
            window.click("caption-translation", app);
            assert_eq!(window.find("caption-selection").bounds(), original);
            (video, original)
        })
        .unwrap();
    advance(&harness, cx, 170);
    let middle = cx
        .update_window(harness.window, |_, window, _| {
            let middle = window.find("caption-selection").bounds();
            assert!(middle.size.height < original.size.height);
            assert_eq!(window.find("player-viewport").bounds(), video);
            middle
        })
        .unwrap();
    cx.update(|app| app.set_reduce_motion(true));
    advance(&harness, cx, 0);
    let end = cx
        .update_window(harness.window, |_, window, _| {
            let end = window.find("caption-selection").bounds();
            assert!(end.size.height < middle.size.height);
            assert_eq!(window.find("player-viewport").bounds(), video);
            end
        })
        .unwrap();
    cx.update(|app| app.set_reduce_motion(false));
    advance(&harness, cx, 100);
    cx.update_window(harness.window, |_, window, _| {
        assert_eq!(window.find("caption-selection").bounds(), end)
    })
    .unwrap();
    harness.close(cx);
}

#[gpui_kit::test]
fn companion_pages_retarget_displayed_poses_and_select_immediately(cx: &mut TestAppContext) {
    let harness = Harness::open(cx);
    open(&harness, cx);
    let start = cx
        .update_window(harness.window, |_, window, app| {
            let start = window.find("study-page-transcript").bounds();
            window.click("study-tools", app);
            assert_eq!(window.find("study-page-transcript").bounds(), start);
            assert_accessibility_contains(window, "Add or switch subtitles", false);
            start
        })
        .unwrap();
    advance(&harness, cx, 120);
    cx.update_window(harness.window, |_, window, app| {
        assert!(
            window.try_find("study-page-transcription").is_none(),
            "skipped destinations must not fly through the panel"
        );
        assert!(window.try_find("study-page-suggestions").is_none());
        let displayed = window.find("study-page-transcript").bounds();
        assert!(
            displayed.origin.x < start.origin.x,
            "higher ordered Tools pushes Transcript left"
        );
        window.click("toggle-transcript", app);
        assert_eq!(window.find("study-page-transcript").bounds(), displayed);
        assert_accessibility_contains(window, "Manage media", false);
    })
    .unwrap();
    advance(&harness, cx, 350);
    cx.update_window(harness.window, |_, window, _| {
        assert_eq!(window.find("study-page-transcript").bounds(), start);
        assert!(window.try_find("study-page-tools").is_none());
    })
    .unwrap();
    harness.close(cx);
}

#[gpui_kit::test]
fn translation_exit_retains_paint_until_finished_and_reverses_continuously(
    cx: &mut TestAppContext,
) {
    let harness = Harness::open(cx);
    open(&harness, cx);
    cx.update_window(harness.window, |_, window, app| {
        window.click("caption-translation", app)
    })
    .unwrap();
    advance(&harness, cx, 350);
    let shown = cx
        .update_window(harness.window, |_, window, app| {
            let bounds = window.find("caption-selection").bounds();
            window.click("caption-translation", app);
            assert_eq!(window.find("caption-selection").bounds(), bounds);
            assert_accessibility_contains(window, "くつろいでください。", false);
            bounds
        })
        .unwrap();
    advance(&harness, cx, 130);
    cx.update_window(harness.window, |_, window, app| {
        let middle = window.find("caption-selection").bounds();
        assert!(middle.size.height > shown.size.height);
        assert!(window.find("caption-translation-text").visible());
        window.click("caption-translation", app);
        assert_eq!(window.find("caption-selection").bounds(), middle);
    })
    .unwrap();
    advance(&harness, cx, 350);
    cx.update_window(harness.window, |_, window, app| {
        assert_eq!(window.find("caption-selection").bounds(), shown);
        window.click("caption-translation", app);
    })
    .unwrap();
    advance(&harness, cx, 270);
    cx.update_window(harness.window, |_, window, _| {
        assert!(window.try_find("caption-translation-text").is_none())
    })
    .unwrap();
    harness.close(cx);
}

#[gpui_kit::test]
fn fullscreen_settles_companion_and_reopens_at_responsive_inner_width(cx: &mut TestAppContext) {
    let harness = Harness::open(cx);
    open(&harness, cx);
    cx.update_window(harness.window, |_, window, app| {
        window.click("close-study-companion", app);
    })
    .unwrap();
    advance(&harness, cx, 80);
    cx.update_window(harness.window, |_, window, app| {
        window.toggle_fullscreen();
        window.render_frame(app);
        assert!(window.try_find("study-page-transcript").is_none());
        window.toggle_fullscreen();
        window.render_frame(app);
    })
    .unwrap();
    cx.simulate_window_resize(harness.window, size(px(1100.), px(1000.)));
    cx.update_window(harness.window, |_, window, app| {
        window.render_frame(app);
        window.click("toggle-transcript", app);
    })
    .unwrap();
    advance(&harness, cx, 310);
    cx.update_window(harness.window, |_, window, _| {
        assert_eq!(window.find("subtitle-panel").bounds().size.width, px(320.));
        assert!(window.find("subtitle-search").visible());
    })
    .unwrap();
    harness.close(cx);
}

#[gpui_kit::test]
fn viewport_resize_settles_active_companion_and_caption_exits(cx: &mut TestAppContext) {
    let harness = Harness::open(cx);
    open(&harness, cx);
    cx.update_window(harness.window, |_, window, app| {
        window.click("caption-translation", app)
    })
    .unwrap();
    advance(&harness, cx, 350);
    cx.update_window(harness.window, |_, window, app| {
        window.click("caption-translation", app);
        window.click("close-study-companion", app);
    })
    .unwrap();
    advance(&harness, cx, 100);
    cx.simulate_window_resize(harness.window, size(px(1100.), px(1000.)));
    cx.update_window(harness.window, |_, window, app| {
        window.render_frame(app);
        assert!(window.try_find("study-page-transcript").is_none());
        assert!(window.try_find("caption-translation-text").is_none());
        let video = window.find("player-viewport").bounds();
        assert!(video.size.width > px(1000.) && video.size.width <= px(1100.));
    })
    .unwrap();
    harness.close(cx);
}

#[gpui_kit::test]
fn rapid_three_destination_retargets_keep_every_visible_pose_and_cover_the_companion(
    cx: &mut TestAppContext,
) {
    let harness = Harness::open(cx);
    open(&harness, cx);
    for action in [
        "explore-meaning",
        "study-tools",
        "toggle-transcript",
        "study-tools",
        "toggle-transcript",
    ] {
        cx.update_window(harness.window, |_, window, app| {
            let before = companion_poses(window);
            window.click(action, app);
            let after = companion_poses(window);
            for (id, bounds) in before {
                assert_eq!(
                    after
                        .iter()
                        .find(|(other, _)| other == &id)
                        .map(|(_, bounds)| *bounds),
                    Some(bounds),
                    "retarget moved or discarded visible {id}"
                );
            }
            assert_companion_covered(window);
        })
        .unwrap();
        for _ in 0..7 {
            advance(&harness, cx, 10);
            cx.update_window(harness.window, |_, window, _| {
                assert_companion_covered(window);
                assert!(window.try_find("study-page-transcription").is_none());
                assert!(window.try_find("study-page-suggestions").is_none());
            })
            .unwrap();
        }
    }
    advance(&harness, cx, 350);
    cx.update_window(harness.window, |_, window, _| {
        assert_eq!(companion_poses(window).len(), 1);
        assert_companion_covered(window);
        assert_accessibility_contains(window, "Add or switch subtitles", true);
    })
    .unwrap();
    harness.close(cx);
}

#[gpui_kit::test]
fn study_entry_reveals_safe_chrome_while_video_geometry_stays_stationary(cx: &mut TestAppContext) {
    let harness = Harness::open(cx);
    cx.update(|app| app.set_reduce_motion(false));
    cx.update_window(harness.window, |_, window, app| {
        window.click(("study", 0usize), app);
    })
    .unwrap();
    cx.run_until_parked();
    let start = cx
        .update_window(harness.window, |_, window, app| {
            window.render_frame(app);
            (
                window.find("player-viewport").bounds(),
                window.find("study-chrome-heading").bounds(),
                window.find("study-chrome-transport").bounds(),
            )
        })
        .unwrap();
    advance(&harness, cx, 150);
    let middle = cx
        .update_window(harness.window, |_, window, _| {
            assert_eq!(window.find("player-viewport").bounds(), start.0);
            let heading = window.find("study-chrome-heading").bounds();
            let transport = window.find("study-chrome-transport").bounds();
            assert!(heading.origin.y < start.1.origin.y);
            assert!(transport.origin.y < start.2.origin.y);
            (heading, transport)
        })
        .unwrap();
    advance(&harness, cx, 160);
    cx.update_window(harness.window, |_, window, _| {
        assert_eq!(window.find("player-viewport").bounds(), start.0);
        let heading = window.find("study-chrome-heading").bounds();
        let transport = window.find("study-chrome-transport").bounds();
        assert!(heading.origin.y < middle.0.origin.y);
        assert!(transport.origin.y < middle.1.origin.y);
        assert_eq!(start.1.origin.y - heading.origin.y, px(8.));
        assert_eq!(start.2.origin.y - transport.origin.y, px(8.));
    })
    .unwrap();
    harness.close(cx);
}

#[gpui_kit::test]
fn panel_change_keeps_real_tab_navigation_in_the_selected_panel_and_restores_search(
    cx: &mut TestAppContext,
) {
    let harness = Harness::open(cx);
    open(&harness, cx);
    cx.update_window(harness.window, |_, window, app| {
        window.click("subtitle-search", app);
        window.input("home", app);
        window.click("study-tools", app);
    })
    .unwrap();
    advance(&harness, cx, 310);
    cx.update_window(harness.window, |_, window, app| {
        window.press("tab", app);
        assert_eq!(
            window.find("close-study-companion").focused(),
            Some(true),
            "Tab must enter the selected Tools panel instead of an orphaned outgoing handle"
        );
        window.press("tab", app);
        assert_eq!(window.find("manage-media").focused(), Some(true));
        window.click("toggle-transcript", app);
    })
    .unwrap();
    advance(&harness, cx, 310);
    cx.update_window(harness.window, |_, window, app| {
        assert_eq!(window.find("subtitle-search").focused(), Some(true));
        assert_eq!(window.find("subtitle-search").value(), Some("home"));
        window.press("tab", app);
        assert_eq!(window.find("import-subtitles").focused(), Some(true));
    })
    .unwrap();
    harness.close(cx);
}

#[gpui_kit::test]
fn keyboard_panel_change_clears_old_copy_selection_without_moving_header_focus(
    cx: &mut TestAppContext,
) {
    let harness = Harness::open(cx);
    open(&harness, cx);
    cx.update_window(harness.window, |_, window, app| {
        // Exercise opening a different destination and closing it from the same
        // stationary header control, with a fresh real selection each time.
        for _ in 0..2 {
            let text = window.find("caption-accessible-text").bounds();
            window.drag(
                point(text.left() + px(2.), text.top() + px(14.)),
                point(text.left() + px(200.), text.top() + px(14.)),
                app,
            );
            let selected = gpui_kit::base::TextSelection::selected_text(window, app);
            assert!(
                !selected.is_empty(),
                "the test must create an actual selectable-text range"
            );
            window.press("ctrl-c", app);
            assert_eq!(
                app.read_from_clipboard().and_then(|item| item.text()),
                Some(selected)
            );
            for _ in 0..40 {
                if window.find("study-tools").focused() == Some(true) {
                    break;
                }
                window.press("tab", app);
            }
            assert_eq!(window.find("study-tools").focused(), Some(true));
            assert!(gpui_kit::base::TextSelection::has_selection(window, app));
            app.write_to_clipboard(gpui_kit::ClipboardItem::new_string(
                "clipboard sentinel".into(),
            ));
            window.press("enter", app);
            assert!(
                !gpui_kit::base::TextSelection::has_selection(window, app),
                "semantic panel change must clear the window's stale copy selection"
            );
            assert_eq!(
                window.find("study-tools").focused(),
                Some(true),
                "a stationary header control retains its own keyboard focus"
            );
            window.press("ctrl-c", app);
            assert_eq!(
                app.read_from_clipboard()
                    .and_then(|item| item.text())
                    .as_deref(),
                Some("clipboard sentinel")
            );
        }
    })
    .unwrap();
    harness.close(cx);
}
