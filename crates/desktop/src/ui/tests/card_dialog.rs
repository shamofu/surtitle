// SPDX-License-Identifier: GPL-3.0-or-later
use super::*;
use gpui_kit::{
    component::{WindowExt, input::AnyInputState},
    test::TestInput,
};

#[gpui_kit::test]
fn playback_settings_escape_preserves_menu_priority_and_closes_the_owned_dialog(
    cx: &mut TestAppContext,
) {
    let harness = Harness::open(cx);
    cx.update_window(harness.window, |_, window, app| {
        window.click(("study", 0usize), app)
    })
    .unwrap();
    harness.wait_window(cx, harness.window, "playback settings trigger", |window| {
        window
            .try_find("playback-settings")
            .is_some_and(|button| button.visible())
    });
    for nested_menu in [true, false] {
        cx.update_window(harness.window, |_, window, app| {
            window.click("playback-settings", app)
        })
        .unwrap();
        harness.wait(cx, "owned playback settings dialog", |_, app| {
            app.windows().len() == 2
        });
        let dialog = cx.read(|app| {
            app.windows()
                .into_iter()
                .find(|window| *window != harness.window)
                .unwrap()
        });
        cx.update_window(dialog, |_, window, app| {
            window.render_frame(app);
            if nested_menu {
                window.click("caption-gap-mode", app);
                assert!(
                    !window
                        .find_all_by_role(gpui_kit::accesskit::Role::Menu)
                        .is_empty()
                );
                window.press("escape", app);
            }
        })
        .unwrap();
        if nested_menu {
            cx.run_until_parked();
            assert_eq!(
                cx.read(|app| app.windows().len()),
                2,
                "first Escape dismisses only the menu"
            );
            cx.update_window(dialog, |_, window, app| {
                window.render_frame(app);
                assert!(
                    window
                        .find_all_by_role(gpui_kit::accesskit::Role::Menu)
                        .is_empty()
                );
            })
            .unwrap();
        }
        cx.update_window(dialog, |_, window, app| window.press("escape", app))
            .unwrap();
        harness.wait(cx, "Escape closes playback settings", |_, app| {
            app.windows().len() == 1
        });
    }
    harness.close(cx);
}

#[gpui_kit::test]
fn card_textareas_navigate_with_tab_without_changing_ime_or_multiline_input(
    cx: &mut TestAppContext,
) {
    let harness = Harness::open(cx);
    harness.route(cx, "cards");
    cx.update_window(harness.window, |_, window, app| {
        window.click(("edit-card", 0usize), app)
    })
    .unwrap();
    harness.wait(cx, "owned phrase editor", |_, app| app.windows().len() == 2);
    let dialog = cx.read(|app| {
        app.windows()
            .into_iter()
            .find(|window| *window != harness.window)
            .unwrap()
    });
    harness.wait_window(cx, dialog, "loaded meaning", |window| {
        window
            .try_find_by_label("Meaning")
            .is_some_and(|field| field.value() == Some("くつろいで"))
    });
    cx.update_window(dialog, |_, window, app| {
        let field = window.find_by_label("Meaning");
        let input_id = field.path().iter().find(|id| matches!(id, gpui::ElementId::NamedInteger(name, _) if name.as_ref() == "input")).unwrap().clone();
        window.within(input_id).click("input-state", app);
        window.press("ctrl-a", app);
        let Some(AnyInputState::Textarea(input)) = window.focused_input(app) else { panic!("actual meaning textarea must own input focus") };
        TestInput::new(gpui_kit::ElementInputHandler::new(field.bounds(), input.clone()), window)
            .compose_text(None, "にほんご", Some(0..4), app);
        // Simulate the text protocol only; this is not native IME evidence.
        TestInput::new(gpui_kit::ElementInputHandler::new(field.bounds(), input.clone()), window)
            .commit_text("日本語", app);
        window.press("tab", app);
        assert_eq!(window.find_by_label("Meaning").value(), Some("日本語"), "Tab must not insert indentation into a form value");
        assert_eq!(window.find_by_label("Example").focused(), Some(true));
        window.press("shift-tab", app);
        assert_eq!(window.find_by_label("Meaning").focused(), Some(true));
        window.press("shift-tab", app);
        assert_eq!(window.find_by_label("Phrase").focused(), Some(true));
        window.press("tab", app);
        assert_eq!(window.find_by_label("Meaning").focused(), Some(true));

        // Tab delivered during preedit must neither indent nor blur composition.
        window.press("ctrl-a", app);
        let mut ime = TestInput::new(gpui_kit::ElementInputHandler::new(field.bounds(), input.clone()), window);
        ime.compose_text(None, "にほんご", Some(0..4), app);
        window.press("tab", app);
        assert_eq!(window.find_by_label("Meaning").focused(), Some(true));
        assert_eq!(window.find_by_label("Meaning").value(), Some("にほんご"));
        let mut ime = TestInput::new(gpui_kit::ElementInputHandler::new(field.bounds(), input), window);
        assert_eq!(ime.marked_text_range(app), Some(0..4));
        ime.commit_text("日本語", app);
        window.press("enter", app);
        window.input("second line", app);
        window.press("tab", app);
        assert_eq!(window.find_by_label("Example").focused(), Some(true));
        assert_eq!(window.find_by_label("Meaning").value(), Some("日本語\nsecond line"));
    }).unwrap();
    harness.wait(
        cx,
        "multiline meaning is durable without Tab whitespace",
        |_, _| {
            commands::cards::get_card_edit_state(&harness.state, "ui-card".into())
                .unwrap()
                .card
                .meaning
                == "日本語\nsecond line"
        },
    );
    harness.close(cx);
}

#[gpui_kit::test]
fn card_dialog_keeps_unfinished_input_and_editor_owner_across_close_and_reopen(
    cx: &mut TestAppContext,
) {
    let harness = Harness::open(cx);
    harness.route(cx, "cards");
    cx.update_window(harness.window, |_, window, app| {
        window.click(("edit-card", 0usize), app);
    })
    .unwrap();
    harness.wait(cx, "owned phrase editor dialog", |_, app| {
        app.windows().len() == 2
    });
    let dialog = cx.read(|app| {
        app.windows()
            .into_iter()
            .find(|window| *window != harness.window)
            .unwrap()
    });
    harness.wait_window(cx, dialog, "loaded phrase editor", |window| {
        window
            .try_find_by_label("Phrase")
            .is_some_and(|field| field.value() == Some("at home"))
    });
    let owner = cx.read(|app| {
        harness
            .view
            .read(app)
            .editors
            .read(app)
            .key_for("card", "ui-card")
            .unwrap()
    });
    let lock = rusqlite::Connection::open(harness.root.path().join("workspace.sqlite")).unwrap();
    lock.execute_batch("BEGIN IMMEDIATE").unwrap();
    let raw = "   "; // Invalid canonical term, but meaningful unfinished input.
    cx.update_window(dialog, |_, window, app| {
        let input = window.find_by_label("Phrase").path().iter()
            .find(|id| matches!(id, gpui::ElementId::NamedInteger(name, _) if name.as_ref() == "input"))
            .unwrap().clone();
        window.within(input).click("input-state", app);
        window.press("ctrl-a", app);
        window.input(raw, app);
    }).unwrap();
    cx.run_until_parked();
    harness.wait(
        cx,
        "unfinished phrase reaches its existing editor",
        |root, app| {
            root.editors
                .read(app)
                .view(&owner)
                .is_some_and(|editor| editor.fields.get("term").is_some_and(|term| term == raw))
        },
    );
    cx.update_window(dialog, |_, window, app| window.click("close-card", app))
        .unwrap();
    cx.run_until_parked();
    assert_eq!(cx.read(|app| app.windows().len()), 1);
    harness.route(cx, "library");
    lock.execute_batch("ROLLBACK").unwrap();
    harness.wait(cx, "closed dialog input is durable", |root, app| {
        !root.editors.read(app).pending()
            && commands::ui_drafts::get_ui_draft(&harness.state, "card".into(), "ui-card".into())
                .unwrap()
                .is_some_and(|draft| draft.fields.get("term").is_some_and(|term| term == raw))
    });
    harness.route(cx, "cards");
    cx.update_window(harness.window, |_, window, app| {
        window.click(("edit-card", 0usize), app)
    })
    .unwrap();
    harness.wait(cx, "reopened phrase editor dialog", |_, app| {
        app.windows().len() == 2
    });
    let reopened = cx.read(|app| {
        app.windows()
            .into_iter()
            .find(|window| *window != harness.window)
            .unwrap()
    });
    harness.wait_window(cx, reopened, "exact unfinished phrase restored", |window| {
        window
            .try_find_by_label("Phrase")
            .is_some_and(|field| field.value() == Some(raw))
    });
    assert_eq!(
        cx.read(|app| harness
            .view
            .read(app)
            .editors
            .read(app)
            .key_for("card", "ui-card")),
        Some(owner)
    );
    assert_eq!(
        commands::cards::get_card_edit_state(&harness.state, "ui-card".into())
            .unwrap()
            .card
            .term,
        "at home"
    );
    harness.close(cx);
}
