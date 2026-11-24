// SPDX-License-Identifier: GPL-3.0-or-later
use super::*;
use gpui_kit::{
    Modifiers, MouseButton, MouseDownEvent, MouseUpEvent, PlatformInput,
    component::{WindowExt, input::AnyInputState},
    test::{TestEventExt, TestInput},
};

fn advance(harness: &Harness, cx: &mut TestAppContext, millis: u64) {
    cx.executor().advance_clock(Duration::from_millis(millis));
    cx.update_window(harness.window, |_, window, app| window.render_frame(app))
        .unwrap();
}

fn open_study(harness: &Harness, cx: &mut TestAppContext) {
    cx.update_window(harness.window, |_, window, app| {
        window.activate_accessibility_for_test();
        window.click(("study", 0usize), app);
    })
    .unwrap();
    harness.wait_window(cx, harness.window, "study transcript ready", |window| {
        window
            .try_find("subtitle-search")
            .is_some_and(|node| node.visible())
    });
    harness.drain_callbacks(cx);
}

fn secondary_window(harness: &Harness, app: &gpui_kit::App) -> Option<AnyWindowHandle> {
    app.windows()
        .into_iter()
        .find(|window| *window != harness.window)
}

fn textarea_value(input: &AnyInputState, app: &gpui_kit::App) -> String {
    match input {
        AnyInputState::Input(state) => state.read(app).value().to_string(),
        AnyInputState::Textarea(state) => state.read(app).value().to_string(),
        _ => String::new(),
    }
}

fn with_focused_test_input<R>(
    window: &mut Window,
    bounds: Bounds<gpui_kit::Pixels>,
    app: &mut gpui_kit::App,
    run: impl FnOnce(&mut TestInput<'_>, &mut gpui_kit::App) -> R,
) -> R {
    match window.focused_input(app).expect("expected focused input") {
        AnyInputState::Input(state) => {
            let mut ime = TestInput::new(gpui_kit::ElementInputHandler::new(bounds, state), window);
            run(&mut ime, app)
        }
        AnyInputState::Textarea(state) => {
            let mut ime = TestInput::new(gpui_kit::ElementInputHandler::new(bounds, state), window);
            run(&mut ime, app)
        }
        _ => panic!("unexpected focused input type"),
    }
}

fn input_entity_id(window: &Window, label: &'static str) -> gpui_kit::ElementId {
    window
        .find_by_label(label)
        .path()
        .iter()
        .find(|element_id| {
            matches!(
                element_id,
                gpui_kit::ElementId::NamedInteger(name, _) if name.as_ref() == "input"
            )
        })
        .expect("expected Textarea parent NamedInteger(\"input\", _) id")
        .clone()
}

fn is_textarea_focused(window: &mut Window, label: &'static str) -> bool {
    if window.find_by_label(label).focused() == Some(true) {
        return true;
    }
    let input_id = input_entity_id(window, label);
    window
        .within(input_id)
        .try_find("input-state")
        .and_then(|node| node.focused())
        == Some(true)
}

fn click_textarea_by_label(window: &mut Window, label: &'static str, app: &mut gpui_kit::App) {
    let input_id = input_entity_id(window, label);
    window.within(input_id).click("input-state", app);
}

#[gpui_kit::test]
fn study_shortcuts_and_non_fullscreen_escape_respect_ime_and_companion_toggle(
    cx: &mut TestAppContext,
) {
    let harness = Harness::open(cx);
    open_study(&harness, cx);

    // 1. Focus subtitle-search and verify Escape during IME composition keeps search focus.
    cx.update_window(harness.window, |_, window, app| {
        window.click("subtitle-search", app);
        let bounds = window.find("subtitle-search").bounds();
        with_focused_test_input(window, bounds, app, |ime, app| {
            ime.compose_text(None, "にほん", Some(0..3), app);
            assert_eq!(ime.marked_text_range(app), Some(0..3));
        });
        window.press("escape", app);
        assert_eq!(
            window.find("subtitle-search").focused(),
            Some(true),
            "Escape during IME preedit must not exit subtitle-search"
        );
        window.press("ctrl-a", app);
        window.press("backspace", app);
        with_focused_test_input(window, bounds, app, |ime, app| {
            assert_eq!(ime.marked_text_range(app), None);
        });
    })
    .unwrap();

    cx.update_window(harness.window, |_, window, app| {
        assert_eq!(window.find("subtitle-search").focused(), Some(true));
        window.press("escape", app);
        window.render_frame(app);
        assert_ne!(
            window.find("subtitle-search").focused(),
            Some(true),
            "Escape outside IME preedit must return focus to StudyView surface"
        );
    })
    .unwrap();

    // 2. Press 't' on StudyView surface to toggle translation visibility.
    cx.update_window(harness.window, |_, window, app| {
        assert!(
            window
                .try_find("caption-translation-text")
                .is_none_or(|node| !node.visible())
        );
        window.press("t", app);
    })
    .unwrap();
    advance(&harness, cx, 320);
    cx.update_window(harness.window, |_, window, app| {
        assert!(
            window
                .try_find("caption-translation-text")
                .is_some_and(|node| node.visible()),
            "'t' shortcut must toggle subtitle translation visible"
        );
        window.press("m", app);
    })
    .unwrap();
    advance(&harness, cx, 320);
    cx.update_window(harness.window, |_, window, app| {
        assert!(
            window
                .try_find("study-page-meaning")
                .is_some_and(|node| node.visible()),
            "'m' shortcut must open Meaning panel"
        );
        window.click("close-study-companion", app);
    })
    .unwrap();
    advance(&harness, cx, 320);
    cx.update_window(harness.window, |_, window, app| {
        assert!(window.try_find("study-page-meaning").is_none());
        window.press("m", app);
    })
    .unwrap();
    advance(&harness, cx, 320);
    cx.update_window(harness.window, |_, window, app| {
        assert!(
            window
                .try_find("study-page-meaning")
                .is_some_and(|node| node.visible()),
            "'m' shortcut must reopen Meaning even when companion was closed"
        );
        window.press("s", app);
    })
    .unwrap();

    harness.wait(
        cx,
        "SourceForm window opened from 's' shortcut",
        |_, app| secondary_window(&harness, app).is_some(),
    );
    let dialog = cx
        .read(|app| secondary_window(&harness, app))
        .expect("SourceForm dialog window");
    harness.wait_window(cx, dialog, "SourceForm visible", |window| {
        window
            .try_find("close-source")
            .is_some_and(|node| node.visible() && node.disabled() != Some(true))
    });
    cx.update_window(dialog, |_, window, app| window.click("close-source", app))
        .unwrap();
    harness.wait(cx, "SourceForm closed", |_, app| app.windows().len() == 1);
    harness.close(cx);
}

#[gpui_kit::test]
fn transcript_drag_preserves_selection_cue_save_opens_directly_and_shift_click_selects_range(
    cx: &mut TestAppContext,
) {
    let harness = Harness::open(cx);
    let template = commands::subtitles::list_segments(&harness.state, "ui-media".into())
        .unwrap()
        .remove(0);
    let cues: Vec<SubtitleSegment> = [
        ("c1", "First transcript line.", 0, 900),
        ("c2", "Second transcript line.", 1000, 1900),
        ("c3", "Third transcript line.", 2000, 2900),
    ]
    .into_iter()
    .map(|(id, text, start_ms, end_ms)| SubtitleSegment {
        id: id.into(),
        text: text.into(),
        start_ms,
        end_ms,
        ..template.clone()
    })
    .collect();
    Store::open(harness.root.path().join("learning.sqlite"))
        .unwrap()
        .set_segments("ui-media", &cues)
        .unwrap();
    harness
        .state
        .changes
        .publish(ChangeDomain::Subtitles, Some("ui-media".into()));

    open_study(&harness, cx);
    harness.wait_window(cx, harness.window, "seeded cues rendered", |window| {
        window.try_find("cue-row-c1").is_some()
            && window.try_find("cue-row-c2").is_some()
            && window.try_find("cue-row-c3").is_some()
    });

    // 1. Shift+click on cue-select-c3 after selecting cue-select-c1 selects c1..=c3.
    cx.update_window(harness.window, |_, window, app| {
        window.click("cue-select-c1", app);
        let bounds = window.find("cue-select-c3").bounds();
        let pos = bounds.center();
        window.pointer_move(pos, None, app);
        window.dispatch_event(
            PlatformInput::MouseDown(MouseDownEvent {
                position: pos,
                button: MouseButton::Left,
                modifiers: Modifiers::shift(),
                click_count: 1,
                first_mouse: false,
            }),
            app,
        );
        window.dispatch_event(
            PlatformInput::MouseUp(MouseUpEvent {
                position: pos,
                button: MouseButton::Left,
                modifiers: Modifiers::shift(),
                click_count: 1,
            }),
            app,
        );
        window.render_frame(app);
    })
    .unwrap();
    cx.run_until_parked();

    // Open cue-save-c1 while c1..=c3 are selected: should stay on Transcript & include all 3 cues.
    cx.update_window(harness.window, |_, window, app| {
        window.click("cue-save-c1", app);
    })
    .unwrap();
    harness.wait(cx, "SourceForm opened from cue-save", |_, app| {
        secondary_window(&harness, app).is_some()
    });
    cx.update_window(harness.window, |_, window, app| {
        window.render_frame(app);
        assert!(
            window
                .try_find("study-page-transcript")
                .is_some_and(|node| node.visible()),
            "cue-save must open SourceForm directly without leaving Transcript"
        );
        assert!(window.try_find("study-page-meaning").is_none());
    })
    .unwrap();

    let dialog = cx
        .read(|app| secondary_window(&harness, app))
        .expect("SourceForm dialog window");
    harness.wait_window(
        cx,
        dialog,
        "SourceForm ready with multi-cue draft",
        |window| {
            window
                .try_find("save-source")
                .is_some_and(|node| node.disabled() != Some(true))
                && window
                    .try_find_by_label("Example and original context")
                    .is_some_and(|node| node.visible())
        },
    );
    cx.update_window(dialog, |_, window, app| {
        click_textarea_by_label(window, "Example and original context", app);
        let focused = window
            .focused_input(app)
            .expect("focused example textarea in SourceForm");
        let ex = textarea_value(&focused, app);
        assert!(
            ex.contains("First") && ex.contains("Third"),
            "Shift+click multi-cue example should include c1..=c3, got {ex:?}"
        );
        window.click("close-source", app);
    })
    .unwrap();
    harness.wait(cx, "SourceForm closed after Shift+click check", |_, app| {
        app.windows().len() == 1
    });

    // 2. Drag across cue-accessible-text-c1 (>= 5 px): creates TextSelection and stays on Transcript.
    cx.update_window(harness.window, |_, window, app| {
        window.render_frame(app);
        let bounds = window.find("cue-accessible-text-c1").bounds();
        window.drag(
            point(bounds.left() + px(2.), bounds.top() + px(12.)),
            point(bounds.left() + px(140.), bounds.top() + px(12.)),
            app,
        );
        window.render_frame(app);
        let selected = gpui_kit::base::TextSelection::selected_text(window, app);
        assert!(
            !selected.trim().is_empty(),
            "dragging across cue-scroll must create a TextSelection"
        );
    })
    .unwrap();
    advance(&harness, cx, 120);
    cx.update_window(harness.window, |_, window, app| {
        assert!(
            window
                .try_find("study-page-transcript")
                .is_some_and(|node| node.visible()),
            "dragging cue text must not switch companion tab to Meaning"
        );
        assert!(window.try_find("study-page-meaning").is_none());

        gpui_kit::base::TextSelection::clear(window, app);
        window.click("cue-scroll-c2", app);
    })
    .unwrap();
    advance(&harness, cx, 320);
    cx.update_window(harness.window, |_, window, _| {
        assert!(
            window
                .try_find("study-page-meaning")
                .is_some_and(|node| node.visible()),
            "plain click on cue-scroll must still open Meaning"
        );
    })
    .unwrap();
    harness.close(cx);
}

#[gpui_kit::test]
fn source_form_focus_quick_fill_and_ctrl_enter_respects_ime(cx: &mut TestAppContext) {
    let harness = Harness::open(cx);
    let template = commands::subtitles::list_segments(&harness.state, "ui-media".into())
        .unwrap()
        .remove(0);
    let cues: Vec<SubtitleSegment> = [
        ("c1", "Make yourself at home.", 0, 900),
        ("c2", "Help yourself to tea.", 1000, 1900),
    ]
    .into_iter()
    .map(|(id, text, start_ms, end_ms)| SubtitleSegment {
        id: id.into(),
        text: text.into(),
        start_ms,
        end_ms,
        ..template.clone()
    })
    .collect();
    Store::open(harness.root.path().join("learning.sqlite"))
        .unwrap()
        .set_segments("ui-media", &cues)
        .unwrap();
    harness
        .state
        .changes
        .publish(ChangeDomain::Subtitles, Some("ui-media".into()));

    open_study(&harness, cx);
    harness.wait_window(cx, harness.window, "seeded cues rendered", |window| {
        window.try_find("cue-row-c1").is_some() && window.try_find("cue-row-c2").is_some()
    });

    // 1. Open phrase SourceForm without preselection on c2 -> initial focus lands on source-term,
    // source-preview-audio is visible, and source-use-example fills term.
    cx.update_window(harness.window, |_, window, app| {
        window.click("cue-save-c2", app);
    })
    .unwrap();
    harness.wait(cx, "SourceForm window opened", |_, app| {
        secondary_window(&harness, app).is_some()
    });
    let dialog = cx
        .read(|app| secondary_window(&harness, app))
        .expect("SourceForm dialog window");
    harness.wait_window(cx, dialog, "SourceForm ready with source-term", |window| {
        window
            .try_find("source-preview-audio")
            .is_some_and(|node| node.visible())
            && window
                .try_find("save-source")
                .is_some_and(|node| node.disabled() != Some(true))
            && window
                .try_find_by_label("Word or phrase")
                .is_some_and(|node| node.visible())
    });
    cx.update_window(dialog, |_, window, app| {
        window.render_frame(app);
        assert!(
            is_textarea_focused(window, "Word or phrase"),
            "SourceForm with empty term must focus source-term initially"
        );
    })
    .unwrap();

    // Expand dialog viewport cleanly so the scrolled "source-use-example" control is visible.
    cx.simulate_window_resize(dialog, size(px(640.), px(980.)));

    cx.update_window(dialog, |_, window, app| {
        window.render_frame(app);
        window.click("source-use-example", app);
        window.render_frame(app);
        let focused = window
            .focused_input(app)
            .expect("source-use-example keeps focus on source-term");
        assert_eq!(textarea_value(&focused, app), "Help yourself to tea.");

        let bounds = window.find(("source-cue-accessible", 0usize)).bounds();
        window.drag(
            point(bounds.left() + px(2.), bounds.center().y),
            point(bounds.left() + px(80.), bounds.center().y),
            app,
        );
        window.render_frame(app);
        let cue_selected = gpui_kit::base::TextSelection::selected_text(window, app)
            .trim()
            .to_owned();
        assert!(
            !cue_selected.is_empty() && cue_selected.len() < "Help yourself to tea.".len(),
            "expected partial cue text selection in SourceForm, got {cue_selected:?}"
        );
        window.click("source-use-selection", app);
        window.render_frame(app);
        assert_eq!(
            window.find_by_label("Word or phrase").value(),
            Some(cue_selected.as_str())
        );
        window.click("close-source", app);
    })
    .unwrap();
    harness.wait(cx, "phrase SourceForm closed", |_, app| {
        app.windows().len() == 1
    });

    // 2. Prefilled term (via text selection on c1) starts initial focus on source-meaning.
    let selected = cx
        .update_window(harness.window, |_, window, app| {
            window.render_frame(app);
            let bounds = window.find("caption-accessible-text").bounds();
            window.drag(
                point(bounds.left() + px(2.), bounds.center().y),
                point(bounds.left() + px(90.), bounds.center().y),
                app,
            );
            let selected = gpui_kit::base::TextSelection::selected_text(window, app)
                .trim()
                .to_owned();
            assert!(!selected.is_empty());
            window.click("save-phrase", app);
            selected
        })
        .unwrap();
    harness.wait(cx, "prefilled SourceForm opened", |_, app| {
        secondary_window(&harness, app).is_some()
    });
    let second_dialog = cx
        .read(|app| secondary_window(&harness, app))
        .expect("second SourceForm window");
    harness.wait_window(cx, second_dialog, "prefilled SourceForm ready", |window| {
        window
            .try_find("save-source")
            .is_some_and(|node| node.disabled() != Some(true))
            && window
                .try_find_by_label("Meaning")
                .is_some_and(|node| node.visible())
    });
    cx.update_window(second_dialog, |_, window, app| {
        window.render_frame(app);
        assert!(
            is_textarea_focused(window, "Meaning"),
            "SourceForm with prefilled term must focus source-meaning initially"
        );
        assert_eq!(
            window.find_by_label("Word or phrase").value(),
            Some(selected.as_str())
        );
        window.click("close-source", app);
    })
    .unwrap();
    harness.wait(cx, "second SourceForm closed", |_, app| {
        app.windows().len() == 1
    });

    // 3. Open subtitle SourceForm via cue-more-c1 -> "Edit subtitle": verify initial focus on
    // Subtitle, IME marked_text_range protection on Ctrl+Enter, and commit via Ctrl+Enter.
    cx.update_window(harness.window, |_, window, app| {
        window.render_frame(app);
        window.click("cue-more-c1", app);
        window.render_frame(app);
        window.press("down", app);
        window.press("enter", app);
    })
    .unwrap();
    harness.wait(cx, "subtitle SourceForm opened", |_, app| {
        secondary_window(&harness, app).is_some()
    });
    let sub_dialog = cx
        .read(|app| secondary_window(&harness, app))
        .expect("subtitle SourceForm window");
    harness.wait_window(cx, sub_dialog, "subtitle SourceForm ready", |window| {
        window
            .try_find("save-source")
            .is_some_and(|node| node.disabled() != Some(true))
            && window
                .try_find_by_label("Subtitle")
                .is_some_and(|node| node.visible())
    });
    cx.update_window(sub_dialog, |_, window, app| {
        window.render_frame(app);
        assert!(
            is_textarea_focused(window, "Subtitle"),
            "subtitle SourceForm must focus source-text initially"
        );
        window.input(" Updated", app);
        let bounds = window.find_by_label("Subtitle").bounds();
        with_focused_test_input(window, bounds, app, |ime, app| {
            ime.compose_text(None, "てすと", Some(0..3), app);
            assert!(ime.marked_text_range(app).is_some());
        });
        window.press("ctrl-enter", app);
        assert!(
            window.find("save-source").disabled() != Some(true),
            "Ctrl+Enter during IME composition must not save SourceForm"
        );
        with_focused_test_input(window, bounds, app, |ime, app| {
            assert!(
                ime.marked_text_range(app).is_some(),
                "Ctrl+Enter during IME composition must preserve marked_text_range"
            );
            ime.commit_text("", app);
            assert_eq!(ime.marked_text_range(app), None);
        });
    })
    .unwrap();
    assert_eq!(
        commands::subtitles::list_segments(&harness.state, "ui-media".into()).unwrap()[0].text,
        "Make yourself at home."
    );

    cx.update_window(sub_dialog, |_, window, app| {
        window.press("ctrl-enter", app);
    })
    .unwrap();
    harness.wait_window(
        cx,
        sub_dialog,
        "subtitle SourceForm finishes saving and enables Close",
        |window| {
            window
                .try_find("save-source")
                .is_some_and(|node| node.disabled() == Some(true))
                && window.try_find("close-source").is_some_and(|node| {
                    node.disabled() != Some(true) && node.label() == Some("Close")
                })
        },
    );
    let updated_c1 = commands::subtitles::list_segments(&harness.state, "ui-media".into())
        .unwrap()
        .into_iter()
        .find(|cue| cue.id == "c1")
        .expect("c1 subtitle exists");
    assert!(
        updated_c1.text != "Make yourself at home." && updated_c1.text.contains("Updated"),
        "expected updated c1 text, got {:?}",
        updated_c1.text
    );
    cx.update_window(sub_dialog, |_, window, app| {
        window.render_frame(app);
        window.click("close-source", app);
    })
    .unwrap();
    harness.wait(cx, "subtitle SourceForm closed", |_, app| {
        app.windows().len() == 1
    });
    harness.close(cx);
}

#[gpui_kit::test]
fn review_intervals_undo_scope_card_audio_and_autoplay_setting(cx: &mut TestAppContext) {
    let harness = Harness::open(cx);

    let fr_file = harness.root.path().join("french-fixture.mp4");
    let clip_file = harness.root.path().join("fr-clip.flac");
    std::fs::write(&fr_file, b"French media fixture").unwrap();
    std::fs::write(&clip_file, b"Audio clip fixture").unwrap();
    {
        let mut store = Store::open(harness.root.path().join("learning.sqlite")).unwrap();
        store
            .put_media(&Media {
                id: "ui-media-fr".into(),
                title: "French clip".into(),
                path: fr_file.to_string_lossy().into_owned(),
                kind: "video".into(),
                duration_ms: 2000,
                learning_language: "fr".into(),
                explanation_language: "ja".into(),
                created_at: surtitle_core::now(),
                last_position_ms: 0,
                audio_stream_index: None,
                subtitle_stream_index: None,
                segment_count: 1,
                card_count: 1,
                status: "ready".into(),
                error: None,
            })
            .unwrap();
        let fr_cue = SubtitleSegment {
            timing_precision: "cue".into(),
            id: "fr-cue".into(),
            media_id: "ui-media-fr".into(),
            start_ms: 0,
            end_ms: 900,
            text: "Bonjour tout le monde.".into(),
            translation: Some("みなさんこんにちは。".into()),
            status: "confirmed".into(),
            review_issues: vec![],
        };
        store
            .set_segments("ui-media-fr", std::slice::from_ref(&fr_cue))
            .unwrap();
        store
            .put_card(&StudyCard {
                id: "card-fr".into(),
                media_id: "ui-media-fr".into(),
                segment_id: fr_cue.id.clone(),
                source_cues: vec![fr_cue.clone()],
                term: "bonjour".into(),
                meaning: "hello".into(),
                example: fr_cue.text,
                language: "fr".into(),
                due_at: "1999-01-01T00:00:00Z".into(),
                created_at: surtitle_core::now(),
                review_count: 0,
                audio_path: Some(clip_file.to_string_lossy().into_owned()),
                audio_clip_range: Some(surtitle_core::AudioClipRange {
                    start_ms: 0,
                    end_ms: 900,
                }),
                audio_stream_index: None,
                suspended: false,
                translation: fr_cue.translation,
                explanation: None,
                source_title: "French clip".into(),
                start_ms: 0,
                end_ms: 900,
                memory: None,
                last_review: None,
            })
            .unwrap();
    }
    harness
        .state
        .changes
        .publish(ChangeDomain::Media, Some("ui-media-fr".into()));
    harness
        .state
        .changes
        .publish(ChangeDomain::Cards, Some("card-fr".into()));
    harness.wait(cx, "both cards and media synced", |view, app| {
        view.session
            .read(app)
            .snapshot
            .as_ref()
            .is_some_and(|snap| snap.cards.len() == 2 && snap.media.len() == 2)
    });

    // 1. Filter Phrases by media ("French clip") and verify card-form-audio in CardForm.
    harness.route(cx, "cards");
    harness.wait_window(
        cx,
        harness.window,
        "card-media dropdown visible",
        |window| {
            window
                .try_find("card-media")
                .is_some_and(|node| node.visible())
        },
    );
    cx.update_window(harness.window, |_, window, app| {
        window.activate_accessibility_for_test();
        window.click("card-media", app);
        window.render_frame(app);
        window.press("down", app);
        window.press("down", app);
        window.press("enter", app);
        window.render_frame(app);
    })
    .unwrap();
    cx.run_until_parked();
    cx.update_window(harness.window, |_, window, app| {
        window.render_frame(app);
        let a11y = window.debug_a11y_tree_json().expect("a11y tree");
        assert!(a11y.contains("bonjour"));
        assert!(!a11y.contains("at home"));
        window.click(("edit-card", 0usize), app);
    })
    .unwrap();
    harness.wait(cx, "CardForm opened for audio-backed card", |_, app| {
        secondary_window(&harness, app).is_some()
    });
    let card_dialog = cx
        .read(|app| secondary_window(&harness, app))
        .expect("CardForm dialog window");
    harness.wait_window(cx, card_dialog, "card-form-audio visible", |window| {
        window
            .try_find("card-form-audio")
            .is_some_and(|node| node.visible())
    });
    cx.update_window(card_dialog, |_, window, app| {
        window.click("close-card", app)
    })
    .unwrap();
    harness.wait(cx, "CardForm closed", |_, app| app.windows().len() == 1);

    // 2. Carry filtered scope from Cards into Review via cards-review.
    cx.update_window(harness.window, |_, window, app| {
        window.click("cards-review", app);
    })
    .unwrap();
    harness.wait_window(cx, harness.window, "scoped review opened", |window| {
        window
            .try_find("review-reveal")
            .is_some_and(|node| node.visible())
    });
    cx.update_window(harness.window, |_, window, app| {
        window.click("review-reveal", app);
        window.render_frame(app);
        let a11y = window.debug_a11y_tree_json().expect("a11y tree");
        assert!(
            a11y.contains("bonjour"),
            "scoped review must start with filtered card"
        );
        assert!(
            a11y.contains("1 Again (1m)") && a11y.contains("3 Good ("),
            "rating buttons must expose predicted FSRS interval labels: {a11y}"
        );
        window.click("good", app);
    })
    .unwrap();

    harness.wait_window(cx, harness.window, "review complete with undo", |window| {
        window
            .try_find("review-complete")
            .is_some_and(|node| node.visible())
            && window
                .try_find("review-undo")
                .is_some_and(|node| node.visible())
    });

    // Concurrent text edit while at review-complete, then undo with 'z' -> schedule reverts & text edit remains!
    {
        let store = Store::open(harness.root.path().join("learning.sqlite")).unwrap();
        let mut card = store.card_edit_state("card-fr").unwrap().card;
        card.meaning = "hello updated concurrently".into();
        store.put_card(&card).unwrap();
    }
    harness
        .state
        .changes
        .publish(ChangeDomain::Cards, Some("card-fr".into()));
    harness.wait(cx, "concurrent card edit reflected", |view, app| {
        view.session
            .read(app)
            .snapshot
            .as_ref()
            .is_some_and(|snap| {
                snap.cards
                    .iter()
                    .any(|c| c.id == "card-fr" && c.meaning == "hello updated concurrently")
            })
    });

    cx.update_window(harness.window, |_, window, app| {
        window.render_frame(app);
        window.click("review-complete", app);
        window.press("z", app);
    })
    .unwrap();
    harness.wait_window(
        cx,
        harness.window,
        "undone card restored to review",
        |window| {
            window
                .try_find("review-reveal")
                .is_some_and(|node| node.visible())
        },
    );
    let restored = commands::cards::get_card_edit_state(&harness.state, "card-fr".into())
        .unwrap()
        .card;
    assert_eq!(restored.review_count, 0);
    assert_eq!(restored.due_at, "1999-01-01T00:00:00Z");
    assert_eq!(restored.meaning, "hello updated concurrently");

    // Clear scope from active Review via review-media ("All media"), rate card-fr to check
    // review-clear-scope too after undo, and test mid-session review-undo button.
    cx.update_window(harness.window, |_, window, app| {
        window.click("review-reveal", app);
        window.click("good", app);
    })
    .unwrap();
    harness.wait_window(
        cx,
        harness.window,
        "review complete with clear scope",
        |window| {
            window
                .try_find("review-clear-scope")
                .is_some_and(|node| node.visible())
        },
    );
    cx.update_window(harness.window, |_, window, app| {
        window.click("review-clear-scope", app);
    })
    .unwrap();
    harness.wait_window(
        cx,
        harness.window,
        "remaining due card after clearing scope",
        |window| {
            window
                .try_find("review-reveal")
                .is_some_and(|node| node.visible())
        },
    );
    cx.update_window(harness.window, |_, window, app| {
        window.click("review-undo", app);
    })
    .unwrap();
    harness.wait(
        cx,
        "mid-session undo restored both due cards",
        |view, app| {
            view.session
                .read(app)
                .snapshot
                .as_ref()
                .is_some_and(|snap| snap.cards.iter().all(|card| card.review_count == 0))
        },
    );
    harness.wait_window(
        cx,
        harness.window,
        "mid-session undo rendered restored review card",
        |window| {
            window.try_find("review-undo").is_none()
                && window
                    .try_find("review-reveal")
                    .is_some_and(|node| node.visible())
        },
    );

    // Verify disabled review_autoplay_audio never attempted playback earlier.
    cx.update_window(harness.window, |_, window, _| {
        assert!(
            window.try_find("review-error").is_none(),
            "autoplay must not fire when reviewAutoplayAudio is disabled"
        );
    })
    .unwrap();

    // 3. Toggle settings-review-autoplay-audio and verify returning to Review triggers autoplay.
    harness.route(cx, "settings");
    harness.wait_window(
        cx,
        harness.window,
        "settings-review-autoplay-audio visible",
        |window| {
            window
                .try_find("settings-review-autoplay-audio")
                .is_some_and(|node| node.visible())
        },
    );
    assert!(!harness.state.settings().unwrap().review_autoplay_audio);
    cx.update_window(harness.window, |_, window, app| {
        window.click("settings-review-autoplay-audio", app);
    })
    .unwrap();
    harness.wait(
        cx,
        "reviewAutoplayAudio saved to preferences",
        |view, app| {
            harness.state.settings().unwrap().review_autoplay_audio
                && !view.editors.read(app).pending()
                && view
                    .session
                    .read(app)
                    .snapshot
                    .as_ref()
                    .is_some_and(|snap| snap.settings.review_autoplay_audio)
        },
    );

    harness.route(cx, "review");
    harness.wait_window(
        cx,
        harness.window,
        "review re-entered with autoplay",
        |window| {
            window
                .try_find("review-reveal")
                .is_some_and(|node| node.visible())
        },
    );
    harness.wait_window(
        cx,
        harness.window,
        "autoplay dispatched audio attempt for active audio card",
        |window| {
            window
                .try_find("review-error")
                .is_some_and(|node| node.visible())
        },
    );

    harness.close(cx);
}
