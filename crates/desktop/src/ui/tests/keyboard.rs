// SPDX-License-Identifier: GPL-3.0-or-later
use super::*;

fn tab_to(window: &mut Window, app: &mut App, id: &'static str) {
    for _ in 0..40 {
        if window.find(id).focused() == Some(true) {
            return;
        }
        window.press("tab", app);
    }
    panic!("keyboard focus did not reach {id}");
}

fn assert_accessible_heading_focus(window: &Window, id: &'static str, label: &str) {
    let heading = window.find(id);
    assert_eq!(heading.role(), Some(gpui_kit::accesskit::Role::Heading));
    assert_eq!(heading.label(), Some(label));
    assert_eq!(heading.focused(), Some(true));
}

pub(super) fn assert_accessible_static_text(window: &Window, id: &'static str, expected: &str) {
    use gpui_kit::accesskit::{Node, NodeId, Role, Tree, TreeId, TreeUpdate};

    // Consume the real rendered node's native accessibility properties.
    // UIA obtains a Label's name from the consumer's value, not label().
    let rendered = window.find(id);
    let mut node = Node::new(rendered.role().unwrap());
    if let Some(label) = rendered.label() {
        node.set_label(label);
    }
    if let Some(value) = rendered.value() {
        node.set_value(value);
    }
    let tree = accesskit_consumer::Tree::new(
        TreeUpdate {
            nodes: vec![(NodeId(1), node)],
            tree: Some(Tree::new(NodeId(1))),
            tree_id: TreeId::ROOT,
            focus: NodeId(1),
        },
        true,
    );
    let consumed = tree.state().root();
    assert_eq!(consumed.role(), Role::Label);
    assert!(consumed.label_comes_from_value());
    assert_eq!(consumed.value().as_deref(), Some(expected), "{id}");
}

#[gpui_kit::test]
fn review_revealed_text_has_the_values_used_by_native_accessible_names(cx: &mut TestAppContext) {
    let harness = Harness::open(cx);
    let mut card = commands::cards::get_card_edit_state(&harness.state, "ui-card".into())
        .unwrap()
        .card;
    card.explanation = Some("自宅にいるように安心する表現。".into());
    Store::open(harness.root.path().join("learning.sqlite"))
        .unwrap()
        .put_card(&card)
        .unwrap();
    harness
        .state
        .changes
        .publish(ChangeDomain::Cards, Some(card.id));
    harness.wait(cx, "review explanation loaded", |root, app| {
        root.session
            .read(app)
            .snapshot
            .as_ref()
            .is_some_and(|snapshot| {
                snapshot.cards[0].explanation.as_deref() == Some("自宅にいるように安心する表現。")
            })
    });
    harness.route(cx, "review");
    cx.update_window(harness.window, |_, window, app| {
        window.press("space", app);
        assert_eq!(window.find("review-meaning").focused(), Some(true));
        for (id, expected) in [
            ("review-meaning", "くつろいで"),
            ("review-translation", "くつろいでください。"),
            ("review-explanation", "自宅にいるように安心する表現。"),
        ] {
            assert_accessible_static_text(window, id, expected);
        }
    })
    .unwrap();
    harness.close(cx);
}

#[gpui_kit::test]
fn review_rating_focus_advances_to_the_next_prompt_and_completion(cx: &mut TestAppContext) {
    let harness = Harness::open(cx);
    let mut next = commands::cards::get_card_edit_state(&harness.state, "ui-card".into())
        .unwrap()
        .card;
    next.id = "ui-card-next".into();
    next.term = "Next review prompt".into();
    next.due_at = "2001-01-01T00:00:00Z".into();
    Store::open(harness.root.path().join("learning.sqlite"))
        .unwrap()
        .put_card(&next)
        .unwrap();
    harness
        .state
        .changes
        .publish(ChangeDomain::Cards, Some(next.id.clone()));
    harness.wait(cx, "second review card", |root, app| {
        root.session
            .read(app)
            .snapshot
            .as_ref()
            .is_some_and(|s| s.cards.len() == 2)
    });
    harness.route(cx, "review");
    cx.update_window(harness.window, |_, window, app| {
        window.press("space", app);
        tab_to(window, app, "good");
        window.press("enter", app);
    })
    .unwrap();
    harness.wait(cx, "first rating persisted", |root, app| {
        root.session
            .read(app)
            .snapshot
            .as_ref()
            .is_some_and(|s| s.cards.iter().filter(|card| card.review_count == 1).count() == 1)
    });
    let next_term = commands::ai::get_app_snapshot(&harness.state)
        .unwrap()
        .cards
        .into_iter()
        .find(|card| card.review_count == 0)
        .unwrap()
        .term;
    cx.update_window(harness.window, |_, window, app| {
        window.render_frame(app);
        assert_accessible_heading_focus(window, "review-prompt", &next_term);
        window.press("space", app);
        window.press("3", app);
    })
    .unwrap();
    harness.wait(cx, "last rating persisted", |root, app| {
        root.session
            .read(app)
            .snapshot
            .as_ref()
            .is_some_and(|s| s.cards.iter().all(|card| card.review_count == 1))
    });
    cx.update_window(harness.window, |_, window, app| {
        window.render_frame(app);
        assert_accessible_heading_focus(window, "review-complete", "Review complete");
    })
    .unwrap();
    harness.close(cx);
}

#[gpui_kit::test]
fn review_rating_completion_does_not_take_focus_moved_to_navigation_while_pending(
    cx: &mut TestAppContext,
) {
    let harness = Harness::open(cx);
    harness.route(cx, "review");
    // Delay the actual durable rating, not its UI callback or a mock service.
    let writer = rusqlite::Connection::open(harness.root.path().join("learning.sqlite")).unwrap();
    writer.execute_batch("BEGIN IMMEDIATE").unwrap();
    cx.update_window(harness.window, |_, window, app| {
        window.press("space", app);
        tab_to(window, app, "good");
        window.press("enter", app);
        assert_eq!(window.find("good").disabled(), Some(true));
        tab_to(window, app, "settings");
    })
    .unwrap();
    writer.execute_batch("ROLLBACK").unwrap();
    harness.wait(cx, "delayed rating persisted", |root, app| {
        root.session
            .read(app)
            .snapshot
            .as_ref()
            .is_some_and(|s| s.cards[0].review_count == 1)
    });
    cx.update_window(harness.window, |_, window, app| {
        window.render_frame(app);
        assert_eq!(
            window.find("settings").focused(),
            Some(true),
            "a completed rating must not steal the user's new focus"
        );
    })
    .unwrap();
    harness.close(cx);
}

#[gpui_kit::test]
fn review_rating_started_from_pointer_preserves_unrelated_keyboard_focus(cx: &mut TestAppContext) {
    let harness = Harness::open(cx);
    harness.route(cx, "review");
    cx.update_window(harness.window, |_, window, app| {
        window.press("space", app);
        tab_to(window, app, "settings");
        window.click("good", app);
        assert_eq!(window.find("settings").focused(), Some(true));
    })
    .unwrap();
    harness.wait(cx, "pointer rating persisted", |root, app| {
        root.session
            .read(app)
            .snapshot
            .as_ref()
            .is_some_and(|s| s.cards[0].review_count == 1)
    });
    cx.update_window(harness.window, |_, window, app| {
        window.render_frame(app);
        assert_eq!(window.find("settings").focused(), Some(true));
    })
    .unwrap();
    harness.close(cx);
}

#[gpui_kit::test]
fn page_shortcuts_do_not_consume_spaces_in_the_actual_subtitle_search(cx: &mut TestAppContext) {
    let harness = Harness::open(cx);
    cx.update_window(harness.window, |_, window, app| {
        window.render_frame(app);
        window.click(("study", 0usize), app);
    })
    .unwrap();
    harness.wait_window(cx, harness.window, "subtitle search", |window| {
        window
            .try_find("subtitle-search")
            .is_some_and(|input| input.visible())
    });
    cx.update_window(harness.window, |_, window, app| {
        window.click("subtitle-search", app);
        window.input("first", app);
        window.press("space", app);
        window.input("second", app);
        assert_eq!(window.find("subtitle-search").value(), Some("first second"));
    })
    .unwrap();
    harness.close(cx);
}

#[gpui_kit::test]
fn native_surface_click_returns_keyboard_focus_from_subtitle_search(cx: &mut TestAppContext) {
    let harness = Harness::open(cx);
    cx.update_window(harness.window, |_, window, app| {
        window.click(("study", 0usize), app);
    })
    .unwrap();
    harness.wait_window(cx, harness.window, "subtitle search", |window| {
        window
            .try_find("subtitle-search")
            .is_some_and(|input| input.visible())
    });
    cx.update_window(harness.window, |_, window, app| {
        window.click("subtitle-search", app);
        window.input("saved search", app);
        assert_eq!(window.find("subtitle-search").focused(), Some(true));
    })
    .unwrap();
    harness.host.emit(DesktopEvent::PlayerSurfaceClick);
    harness.wait_window(
        cx,
        harness.window,
        "native surface focus handoff",
        |window| window.find("subtitle-search").focused() == Some(false),
    );
    cx.update_window(harness.window, |_, window, app| {
        window.press("space", app);
        assert_eq!(window.find("subtitle-search").value(), Some("saved search"));
    })
    .unwrap();
    harness.close(cx);
}

#[gpui_kit::test]
fn page_shortcuts_do_not_grade_from_a_focused_button_but_work_on_review_surface(
    cx: &mut TestAppContext,
) {
    let harness = Harness::open(cx);
    harness.route(cx, "review");
    cx.update_window(harness.window, |_, window, app| {
        window.render_frame(app);
        window.press("space", app);
        assert_eq!(window.find("review-meaning").focused(), Some(true));
        assert_eq!(window.find("review").checked(), Some(true));
        assert_eq!(window.find("review").label(), Some("Review — Current page"));
        assert_eq!(window.find("cards").checked(), Some(false));
        for _ in 0..32 {
            if window.find("good").focused() == Some(true) {
                break;
            }
            window.press("tab", app);
        }
        assert_eq!(window.find("good").focused(), Some(true));
        window.press("1", app);
    })
    .unwrap();
    harness.drain_callbacks(cx);
    assert_eq!(
        commands::ai::get_app_snapshot(&harness.state)
            .unwrap()
            .cards[0]
            .review_count,
        0,
        "number shortcuts must not change a card while an interactive control has focus"
    );

    cx.update_window(harness.window, |_, window, app| {
        window.click("review-meaning", app);
        assert_eq!(window.find("review-meaning").focused(), Some(true));
        window.press("1", app);
    })
    .unwrap();
    harness.wait(cx, "page-focused rating persisted", |root, app| {
        root.session
            .read(app)
            .snapshot
            .as_ref()
            .is_some_and(|snapshot| snapshot.cards[0].review_count == 1)
    });
    harness.close(cx);
}

use super::super::keyboard::Slider;
use gpui_kit::component::{
    input::{Input, InputState},
    menu::{DropdownMenu, PopupMenuItem},
    slider::{SliderEvent, SliderState},
};
use gpui_kit::{
    FocusHandle,
    base::TestSupportExt,
    test::{TestEventExt, TestInput},
};

struct Controls {
    surface: FocusHandle,
    slider: Entity<SliderState>,
    input: Entity<InputState>,
    shortcuts: usize,
    clicks: usize,
    changes: Vec<f32>,
    disabled: bool,
    keyboard_step: Option<f32>,
    _subscription: Subscription,
}

impl Render for Controls {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .id("keyboard-surface")
            .test_support()
            .track_focus(&self.surface)
            .size_full()
            .flex()
            .flex_col()
            .gap_4()
            .p_4()
            .on_key_down(
                cx.listener(|this, event: &gpui_kit::KeyDownEvent, window, cx| {
                    if super::super::keyboard::page_shortcut(event, &[&this.surface], window)
                        && matches!(
                            event.keystroke.key.as_str(),
                            "space" | "left" | "right" | "1"
                        )
                    {
                        this.shortcuts += 1;
                        cx.stop_propagation();
                    }
                }),
            )
            .child(Input::new(&self.input))
            .child(
                style::button("keyboard-button")
                    .label("Button")
                    .on_click(cx.listener(|this, _, _, _| this.clicks += 1)),
            )
            .child(
                Slider::new(&self.slider)
                    .disabled(self.disabled)
                    .when_some(self.keyboard_step, |slider, step| {
                        slider.keyboard_step(step)
                    })
                    .accessibility_label("Keyboard value")
                    .accessibility_value(format!("{} units", self.slider.read(cx).value().end()))
                    .w(px(250.)),
            )
            .child(
                style::button("keyboard-menu")
                    .label("Menu")
                    .dropdown_menu(|menu, _, _| {
                        menu.item(PopupMenuItem::new("Menu action").on_click(|_, _, _| {}))
                    }),
            )
    }
}

#[gpui_kit::test]
fn focused_controls_keep_their_keys_and_ime_preedit_out_of_page_shortcuts(cx: &mut TestAppContext) {
    let harness = Harness::open(cx);
    let (window_handle, controls) = cx.update(|app| {
        gpui_kit::open_window(WindowOptions::default(), app, |window, app| {
            app.new(|cx| {
                let slider = cx.new(|_| {
                    SliderState::new()
                        .min(0.)
                        .max(10.)
                        .step(1.)
                        .default_value(5.)
                });
                let subscription =
                    cx.subscribe(&slider, |this: &mut Controls, _, event: &SliderEvent, _| {
                        if let SliderEvent::Change(value) = event {
                            this.changes.push(value.end());
                        }
                    });
                Controls {
                    surface: cx.focus_handle(),
                    slider,
                    input: cx.new(|cx| InputState::new(window, cx).placeholder("Composing input")),
                    shortcuts: 0,
                    clicks: 0,
                    changes: vec![],
                    disabled: false,
                    keyboard_step: None,
                    _subscription: subscription,
                }
            })
        })
        .unwrap()
    });
    cx.update_window(window_handle, |_, window, app| {
        controls.read(app).surface.clone().focus(window, app);
        window.press("space", app);
        assert_eq!(
            controls.read(app).shortcuts,
            1,
            "page focus retains page shortcuts"
        );
        for _ in 0..12 {
            if window.find("keyboard-button").focused() == Some(true) {
                break;
            }
            window.press("tab", app);
        }
        assert_eq!(window.find("keyboard-button").focused(), Some(true));
        window.press("space", app);
        assert_eq!(controls.read(app).clicks, 1);
        assert_eq!(controls.read(app).shortcuts, 1);

        window.press("tab", app);
        assert_eq!(
            window.find_by_label("Keyboard value").focused(),
            Some(true),
            "the actual slider must be keyboard reachable"
        );
        window.press("right", app);
        assert_eq!(controls.read(app).slider.read(app).value().end(), 6.);
        assert_eq!(
            window.find_by_label("Keyboard value").value(),
            Some("6 units")
        );
        window.press("home", app);
        assert_eq!(controls.read(app).slider.read(app).value().end(), 0.);
        window.press("end", app);
        assert_eq!(controls.read(app).slider.read(app).value().end(), 10.);
        window.press("space", app);
        assert_eq!(controls.read(app).shortcuts, 1);

        window.click("keyboard-menu", app);
        let menus = window.find_all_by_role(gpui_kit::accesskit::Role::Menu);
        assert!(menus.iter().any(|menu| menu.focused() == Some(true)));
        window.press("1", app);
        assert_eq!(controls.read(app).shortcuts, 1);
        window.press("escape", app);

        let input = controls.read(app).input.clone();
        input.update(app, |input, cx| input.focus(window, cx));
        window.render_frame(app);
        let bounds = window.find_by_label("Composing input").bounds();
        TestInput::new(
            gpui_kit::ElementInputHandler::new(bounds, input.clone()),
            window,
        )
        .compose_text(None, "にほんご", Some(0..4), app);
        // This exercises the GPUI input protocol and event routing, not a Windows IME.
        window.key_down("space", false, app);
        window.key_up("space", app);
        assert_eq!(controls.read(app).shortcuts, 1);
        let mut ime = TestInput::new(gpui_kit::ElementInputHandler::new(bounds, input), window);
        assert_eq!(ime.marked_text_range(app), Some(0..4));
        ime.commit_text("日本語", app);
        assert_eq!(
            controls.read(app).input.read(app).value().as_str(),
            "日本語"
        );
    })
    .unwrap();
    cx.read(|app| {
        assert_eq!(
            controls.read(app).changes,
            vec![6., 0., 10.],
            "keyboard adjustments must reach the existing change-event consumers"
        )
    });
    cx.update_window(window_handle, |_, window, app| {
        let bounds = window.find_by_label("Keyboard value").bounds();
        let point = gpui_kit::point(bounds.left() + bounds.size.width / 4., bounds.center().y);
        window.pointer_down(point, gpui_kit::MouseButton::Left, app);
        window.pointer_up(point, gpui_kit::MouseButton::Left, app);
        let value = controls.read(app).slider.read(app).value().end();
        assert!(
            (2. ..=4.).contains(&value),
            "the pointer still changes the same slider state"
        );
        assert_eq!(window.find_by_label("Keyboard value").focused(), Some(true));
        let thumb = window.find(("slider-thumb", 0u32)).bounds().center();
        window.drag(
            thumb,
            gpui_kit::point(bounds.left() + bounds.size.width * 0.75, bounds.center().y),
            app,
        );
        let value = controls.read(app).slider.read(app).value().end();
        assert!(
            (7. ..=9.).contains(&value),
            "the thumb drag must still change the same slider state"
        );
        for (x, expected) in [
            (bounds.left() + px(0.5), 0.),
            (bounds.right() - px(0.5), 10.),
        ] {
            let position = gpui_kit::point(x, bounds.center().y);
            window.pointer_move(position, None, app);
            window.pointer_down(position, gpui_kit::MouseButton::Left, app);
            window.pointer_up(position, gpui_kit::MouseButton::Left, app);
            assert_eq!(
                controls.read(app).slider.read(app).value().end(),
                expected,
                "the accessible slider's endpoint must be part of its pointer track"
            );
        }
        let value = controls.read(app).slider.read(app).value().end();
        controls.update(app, |controls, cx| {
            controls.disabled = true;
            cx.notify();
        });
        window.render_frame(app);
        assert_eq!(
            window.find_by_label("Keyboard value").disabled(),
            Some(true)
        );
        window.press("right", app);
        window.pointer_down(point, gpui_kit::MouseButton::Left, app);
        window.pointer_up(point, gpui_kit::MouseButton::Left, app);
        assert_eq!(controls.read(app).slider.read(app).value().end(), value);
        window.press("tab", app);
        assert_eq!(window.find("keyboard-menu").focused(), Some(true));
        assert_eq!(controls.read(app).shortcuts, 1);
    })
    .unwrap();
    cx.read(|app| {
        let controls = controls.read(app);
        assert_eq!(
            controls.changes.last(),
            Some(&controls.slider.read(app).value().end()),
            "pointer changes still reach the existing event consumer"
        );
    });
    // The seek control uses a normalized pointer range, but keyboard nudges
    // retain the original 100 ms precision for both short and long media.
    for duration_ms in [1_000u64, 6 * 60 * 60 * 1_000] {
        cx.update_window(window_handle, |_, window, app| {
            controls.update(app, |controls, cx| {
                controls.disabled = false;
                controls.keyboard_step = Some(1_000_000. / duration_ms as f32);
                controls.slider.update(cx, |slider, cx| {
                    *slider = SliderState::new()
                        .min(0.)
                        .max(10_000.)
                        .step(1.)
                        .default_value(5_000.);
                    cx.notify();
                });
                cx.notify();
            });
            window.render_frame(app);
            if window.find_by_label("Keyboard value").focused() != Some(true) {
                window.press("shift-tab", app);
            }
            assert_eq!(window.find_by_label("Keyboard value").focused(), Some(true));
            window.press("right", app);
            let value = controls.read(app).slider.read(app).value().end();
            let elapsed_ms = f64::from(value - 5_000.) * duration_ms as f64 / 10_000.;
            assert!(
                (elapsed_ms - 100.).abs() < 1.,
                "one nudge on {duration_ms} ms media moved {elapsed_ms} ms"
            );
        })
        .unwrap();
    }
    harness.close(cx);
}
