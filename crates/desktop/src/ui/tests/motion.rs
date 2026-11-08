// SPDX-License-Identifier: GPL-3.0-or-later
use super::*;
use gpui_kit::{
    component::{WindowExt, input::AnyInputState},
    test::{TestEventExt, TestInput},
};
use std::{cell::Cell, rc::Rc};

struct IdleMotion {
    value: f32,
    reversed: bool,
    rows: crate::ui::list_motion::ListMotion,
}
impl Render for IdleMotion {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.rows
            .viewport(window.viewport_size(), point(px(0.), px(0.)));
        self.rows.begin_layout();
        let fill = crate::ui::motion_controls::progress("idle-task", self.value, window, cx);
        let reveal = crate::ui::motion::reveal(
            "idle-reveal",
            self.reversed,
            crate::ui::motion::ENTER,
            crate::ui::motion::resizing_easing(),
            window,
            cx,
        );
        div()
            .flex()
            .flex_col()
            .p_4()
            .child(style::button("idle-button").label("Hover").w(px(120.)))
            .child(
                div().w(px(200.)).h(px(8.)).child(
                    div()
                        .id("idle-fill")
                        .test_support()
                        .h_full()
                        .w(gpui_kit::relative(fill)),
                ),
            )
            .child(
                div()
                    .id("idle-reveal")
                    .test_support()
                    .h(px(8.))
                    .w(px(100. * reveal)),
            )
            .children(
                if self.reversed {
                    ["idle-b", "idle-a"]
                } else {
                    ["idle-a", "idle-b"]
                }
                .into_iter()
                .map(|id| {
                    self.rows.row(
                        id,
                        div()
                            .id(id)
                            .test_support()
                            .w(px(200.))
                            .h(px(60.))
                            .flex_shrink_0(),
                    )
                }),
            )
    }
}

fn assert_motion_frames_stop(window: &mut Window, app: &mut App) {
    // A running frame may already have queued one callback before settling.
    window.simulate_next_frame(app);
    for _ in 0..2 {
        window.render_frame(app);
        assert_eq!(
            window.simulate_next_frame(app),
            0,
            "settled decorations must not renew frame demand"
        );
    }
}

#[gpui_kit::test]
fn static_decorations_stop_requesting_frames_after_completion_and_midflight_reduction(
    cx: &mut TestAppContext,
) {
    cx.update(|app| {
        gpui_kit::init(app);
        style::init(app);
        app.set_reduce_motion(false);
    });
    let view = cx.new(|_| IdleMotion {
        value: 0.2,
        reversed: false,
        rows: Default::default(),
    });
    let (_, visual) = cx.add_window_view(|window, app| Root::new(view.clone(), window, app));
    visual.update(|window, app| {
        // The default pointer is0,0. Keep it outside the fixture before the
        // first paint so startup hover is not mistaken for idle frame demand.
        window.pointer_move(point(px(300.), px(250.)), None, app);
        window.render_frame(app);
        assert_motion_frames_stop(window, app);
        view.update(app, |view, cx| {
            view.value = 0.8;
            view.reversed = true;
            view.rows.filter_changed();
            cx.notify();
        });
        window.hover("idle-button", app);
        window.render_frame(app);
        assert!(
            window.simulate_next_frame(app) > 0,
            "fixture must really start motion"
        );
    });
    visual.executor().advance_clock(Duration::from_millis(500));
    visual.update(|window, app| {
        assert_motion_frames_stop(window, app);
        view.update(app, |view, cx| {
            view.value = 0.4;
            view.reversed = false;
            view.rows.filter_changed();
            cx.notify();
        });
        window.pointer_move(point(px(300.), px(250.)), None, app);
        window.render_frame(app);
        assert!(window.simulate_next_frame(app) > 0);
    });
    visual.executor().advance_clock(Duration::from_millis(50));
    visual.update(|window, app| {
        window.render_frame(app);
        let moving = window.find("idle-fill").bounds().size.width;
        assert!(moving > px(80.) && moving < px(160.));
        app.set_reduce_motion(true);
        window.render_frame(app);
        assert_eq!(window.find("idle-fill").bounds().size.width, px(80.));
        assert_eq!(window.find("idle-reveal").bounds().size.width, px(0.));
        assert_motion_frames_stop(window, app);
        app.set_reduce_motion(false);
        assert_motion_frames_stop(window, app);
        assert_eq!(window.find("idle-fill").bounds().size.width, px(80.));
    });
}

#[gpui_kit::test]
fn main_navigation_midflight_reduction_settles_and_does_not_replay(cx: &mut TestAppContext) {
    let harness = Harness::open(cx);
    cx.update(|app| app.set_reduce_motion(false));
    cx.update_window(harness.window, |_, window, app| {
        window.click("settings", app)
    })
    .unwrap();
    cx.executor().advance_clock(Duration::from_millis(90));
    cx.update_window(harness.window, |_, window, app| {
        window.render_frame(app);
        let moving = window.find(("main-page", 3usize)).bounds();
        assert!(moving.left() > px(0.) && moving.left() < window.viewport_size().width);
        assert!(window.try_find(("main-page", 0usize)).is_some());
        app.set_reduce_motion(true);
        window.render_frame(app);
        assert_eq!(window.find(("main-page", 3usize)).bounds().left(), px(0.));
        assert!(window.try_find(("main-page", 0usize)).is_none());
        app.set_reduce_motion(false);
        window.render_frame(app);
        assert_eq!(window.find(("main-page", 3usize)).bounds().left(), px(0.));
    })
    .unwrap();
    cx.executor().advance_clock(Duration::from_millis(400));
    cx.update_window(harness.window, |_, window, app| {
        window.render_frame(app);
        assert_eq!(window.find(("main-page", 3usize)).bounds().left(), px(0.));
        assert!(window.try_find(("main-page", 0usize)).is_none());
    })
    .unwrap();
    harness.close(cx);
}

#[gpui_kit::test]
fn preedit_navigation_does_not_dispatch_text_to_the_retained_outgoing_input(
    cx: &mut TestAppContext,
) {
    let harness = Harness::open(cx);
    cx.update(|app| app.set_reduce_motion(false));
    let input = cx
        .update_window(harness.window, |_, window, app| {
            let search = window
                .find_by_label("Search your library")
                .path()
                .last()
                .unwrap()
                .clone();
            window.click(search, app);
            let Some(AnyInputState::Input(input)) = window.focused_input(app) else {
                panic!("focused library input")
            };
            let bounds = window.find_by_label("Search your library").bounds();
            let mut ime = TestInput::new(
                gpui_kit::ElementInputHandler::new(bounds, input.clone()),
                window,
            );
            ime.compose_text(None, "にほん", Some(0..3), app);
            assert_eq!(ime.marked_text_range(app), Some(0..3));
            input
        })
        .unwrap();
    harness.update(cx, |root, window, app| {
        root.navigate(Route::Settings, window, app)
    });
    cx.update_window(harness.window, |_, window, app| {
        window.render_frame(app);
        assert!(window.find(("main-page", 0usize)).visible());
        assert_eq!(window.find("settings").focused(), Some(true));
        let previous = input.read(app).value().to_string();
        // This goes through the installed window handler, never a handler
        // manufactured for the stale input after navigation.
        window.input("追加", app);
        assert_eq!(input.read(app).value().as_str(), previous);
        assert!(window.focused_input(app).is_none());
        window.press("shift-tab", app);
        assert_eq!(window.find("review").focused(), Some(true));
    })
    .unwrap();
    harness.close(cx);
}

struct RetainedPage {
    active: bool,
    calls: Rc<Cell<usize>>,
}
impl Render for RetainedPage {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let calls = self.calls.clone();
        div()
            .id("retained-pages")
            .tab_group()
            .size_full()
            .child(super::super::motion::interactive(
                style::button("retained-action")
                    .label("Retained action")
                    .tooltip("Retained help")
                    .on_click(move |_, _, _| calls.set(calls.get() + 1)),
                self.active,
            ))
            .child(style::button("current-action").label("Current action"))
    }
}

#[gpui_kit::test]
fn already_open_tooltip_is_removed_when_its_owner_becomes_inert(cx: &mut TestAppContext) {
    cx.update(|app| {
        gpui_kit::init(app);
        style::init(app);
    });
    let view = cx.new(|_| RetainedPage {
        active: true,
        calls: Rc::new(Cell::new(0)),
    });
    let (_, visual) = cx.add_window_view(|window, app| Root::new(view.clone(), window, app));
    visual.update(|window, app| {
        window.activate_accessibility_for_test();
        window.render_frame(app);
        window.hover("retained-action", app);
    });
    visual.executor().advance_clock(Duration::from_secs(1));
    visual.run_until_parked();
    visual.update(|window, app| {
        window.render_frame(app);
        assert!(
            window
                .debug_a11y_tree_json()
                .unwrap()
                .contains("Retained help"),
            "tooltip must actually be open before navigation"
        );
        view.update(app, |view, cx| {
            view.active = false;
            cx.notify();
        });
        window.render_frame(app);
        assert!(
            !window
                .debug_a11y_tree_json()
                .unwrap()
                .contains("Retained help"),
            "outgoing tooltip cannot escape inert scope"
        );
    });
}

#[gpui_kit::test]
fn programmatic_navigation_hands_off_focus_before_the_outgoing_page_leaves(
    cx: &mut TestAppContext,
) {
    let harness = Harness::open(cx);
    cx.update(|app| app.set_reduce_motion(false));
    cx.update_window(harness.window, |_, window, app| {
        window.render_frame(app);
        let search = window
            .find_by_label("Search your library")
            .path()
            .last()
            .unwrap()
            .clone();
        window.click(search, app);
        assert_eq!(
            window.find_by_label("Search your library").focused(),
            Some(true)
        );
    })
    .unwrap();
    harness.update(cx, |root, window, app| {
        root.navigate(Route::Settings, window, app)
    });
    cx.update_window(harness.window, |_, window, app| {
        window.render_frame(app);
        assert!(window.find(("main-page", 0usize)).visible());
        assert_eq!(window.find("settings").focused(), Some(true));
        window.press("shift-tab", app);
        assert_eq!(
            window.find("review").focused(),
            Some(true),
            "Tab remains routed through the fixed header during the slide"
        );
    })
    .unwrap();
    harness.close(cx);
}

#[gpui_kit::test]
fn fullscreen_navigation_keeps_tab_routed_when_the_header_is_hidden(cx: &mut TestAppContext) {
    let harness = Harness::open(cx);
    harness.route(cx, "settings");
    cx.update_window(harness.window, |_, window, app| {
        window.toggle_fullscreen();
        window.render_frame(app);
        assert!(window.is_fullscreen());
    })
    .unwrap();
    harness.update(cx, |root, window, app| {
        root.navigate(Route::Library, window, app)
    });
    cx.update_window(harness.window, |_, window, app| {
        window.render_frame(app);
        assert!(window.try_find("library").is_none(), "header is unmounted");
        window.press("tab", app);
        assert_eq!(
            window.find("open-import").focused(),
            Some(true),
            "fullscreen navigation must retain a live Tab dispatch path"
        );
    })
    .unwrap();
    harness.close(cx);
}

#[gpui_kit::test]
fn actual_navigation_retains_page_geometry_and_keeps_header_operable(cx: &mut TestAppContext) {
    let harness = Harness::open(cx);
    cx.update(|app| app.set_reduce_motion(false));
    let header = cx
        .update_window(harness.window, |_, window, app| {
            window.render_frame(app);
            window.find("settings").bounds()
        })
        .unwrap();
    for (nav, index, elapsed) in [
        ("settings", 3usize, 90),
        ("review", 2, 45),
        ("library", 0, 110),
        ("cards", 1, 400),
    ] {
        cx.update_window(harness.window, |_, window, app| {
            let before: Vec<_> = (0usize..4)
                .filter_map(|id| {
                    window
                        .try_find(("main-page", id))
                        .map(|page| (id, page.bounds()))
                })
                .collect();
            window.click(nav, app);
            window.render_frame(app);
            assert_eq!(window.find("settings").bounds(), header);
            for (id, bounds) in before {
                if bounds.right() > px(0.) && bounds.left() < window.viewport_size().width {
                    assert_eq!(
                        window.find(("main-page", id)).bounds(),
                        bounds,
                        "navigation moved a retained page before time advanced"
                    );
                }
            }
            assert!(window.try_find(("main-page", index)).is_some());
        })
        .unwrap();
        for _ in 0..elapsed / 5 {
            cx.executor().advance_clock(Duration::from_millis(5));
            cx.run_until_parked();
            cx.update_window(harness.window, |_, window, app| {
                window.render_frame(app);
                let mut pages: Vec<_> = (0usize..4)
                    .filter_map(|id| window.try_find(("main-page", id)).map(|page| page.bounds()))
                    .collect();
                pages.sort_by(|a, b| f32::from(a.left()).total_cmp(&f32::from(b.left())));
                let mut edge = px(0.);
                for page in pages {
                    if page.right() <= px(0.) || page.left() >= window.viewport_size().width {
                        continue;
                    }
                    assert!(
                        page.left() <= edge + px(0.1),
                        "page gap: {page:?}, previous edge {edge:?}"
                    );
                    edge = edge.max(page.right());
                }
                assert!(edge >= window.viewport_size().width - px(0.1));
            })
            .unwrap();
        }
    }
    cx.update_window(harness.window, |_, window, app| {
        app.set_reduce_motion(true);
        window.render_frame(app);
        assert_eq!(window.find(("main-page", 1usize)).bounds().left(), px(0.));
        assert!(
            [0usize, 2, 3]
                .into_iter()
                .all(|id| window.try_find(("main-page", id)).is_none())
        );
    })
    .unwrap();
    harness.close(cx);
}

#[gpui_kit::test]
fn retained_visual_page_cannot_receive_input_or_accessibility_focus(cx: &mut TestAppContext) {
    cx.update(|app| {
        gpui_kit::init(app);
        style::init(app);
    });
    let calls = Rc::new(Cell::new(0));
    let view = cx.new(|_| RetainedPage {
        active: true,
        calls: calls.clone(),
    });
    let (_, visual) = cx.add_window_view(|window, app| Root::new(view.clone(), window, app));
    visual.update(|window, app| {
        window.activate_accessibility_for_test();
        window.render_frame(app);
        window.focus_next(app);
        window.render_frame(app);
        window.click("retained-action", app);
    });
    assert_eq!(calls.get(), 1);
    visual.update(|window, app| {
        view.update(app, |view, cx| {
            view.active = false;
            cx.notify();
        });
        window.render_frame(app);
        let retained = window.find("retained-action");
        assert!(retained.visible(), "outgoing page must still be drawn");
        let accessibility = window
            .debug_a11y_tree_json()
            .expect("test accessibility enabled");
        assert!(
            !accessibility.contains("Retained action"),
            "outgoing page is absent from AccessKit: {accessibility}"
        );
        assert!(accessibility.contains("Current action"));
        window.click("retained-action", app);
        window.press("enter", app);
        window.press("space", app);
        // Applications hand focus to the selected page during navigation.
        // Here inspect the low-level tab order independently of that handoff:
        // an inert focused node no longer supplies Root's key context.
        window.focus_next(app);
        window.render_frame(app);
        assert_eq!(window.find("current-action").focused(), Some(true));
    });
    assert_eq!(calls.get(), 1);
    visual.update(|window, app| {
        view.update(app, |view, cx| {
            view.active = true;
            cx.notify();
        });
        window.render_frame(app);
        window.click("retained-action", app);
    });
    assert_eq!(
        calls.get(),
        2,
        "reactivated retained view has fresh handlers"
    );
}
