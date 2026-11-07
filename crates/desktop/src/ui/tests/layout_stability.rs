// SPDX-License-Identifier: GPL-3.0-or-later
use super::*;
use crate::application::operations::OperationContext;

fn geometry(
    harness: &Harness,
    cx: &mut TestAppContext,
    ids: &[&'static str],
) -> Vec<Bounds<gpui_kit::Pixels>> {
    cx.update_window(harness.window, |_, window, app| {
        window.render_frame(app);
        ids.iter().map(|id| window.find(*id).bounds()).collect()
    })
    .unwrap()
}

#[gpui_kit::test]
fn background_activity_keeps_header_controls_in_place(cx: &mut TestAppContext) {
    for (locale, width) in [
        ("en", 1600.),
        ("ja", 1600.),
        ("en", 900.),
        ("ja", 900.),
        ("en", 720.),
        ("ja", 720.),
    ] {
        let harness = Harness::open(cx);
        let mut settings = harness.state.settings().unwrap();
        settings.locale = locale.into();
        commands::models::update_settings(&harness.state, settings).unwrap();
        harness.update(cx, |root, _, cx| {
            root.session.update(cx, |session, cx| session.refresh(cx));
        });
        harness.wait(cx, "requested locale", |root, app| {
            root.session
                .read(app)
                .snapshot
                .as_ref()
                .unwrap()
                .settings
                .locale
                == locale
        });
        cx.simulate_window_resize(harness.window, size(px(width), px(1000.)));
        let ids = [
            "activity",
            "locale-toggle",
            "theme-toggle",
            "library",
            "review",
        ];
        let before = geometry(&harness, cx, &ids);
        let registry = harness.state.test_operations();
        let operation = registry
            .start(
                "tool_check",
                "Geometry fixture",
                OperationContext::default(),
            )
            .unwrap();
        harness.wait(cx, "running activity", |root, app| {
            root.session
                .read(app)
                .operations
                .iter()
                .any(|operation| operation.status == "running")
        });
        let during = geometry(&harness, cx, &ids);
        assert_eq!(
            before, during,
            "{locale} at {width}px: starting background work moved header controls"
        );
        cx.update_window(harness.window, |_, window, _| {
            let label = window.find("activity").label().unwrap().to_owned();
            assert!(
                label.contains('1'),
                "activity still announces the real running count: {label}"
            );
        })
        .unwrap();
        let extra = (0..9)
            .map(|_| {
                registry
                    .start("tool_check", "Counter fixture", OperationContext::default())
                    .unwrap()
            })
            .collect::<Vec<_>>();
        harness.wait(cx, "two-digit activity count", |root, app| {
            root.session
                .read(app)
                .operations
                .iter()
                .filter(|operation| operation.status == "running")
                .count()
                == 10
        });
        assert_eq!(
            before,
            geometry(&harness, cx, &ids),
            "{locale} at {width}px: two-digit count moved header controls"
        );
        harness.update(cx, |root, _, cx| {
            root.session.update(cx, |session, cx| {
                session.error = Some("Fixture refresh failure".into());
                cx.notify();
            });
            cx.notify();
        });
        assert_eq!(
            before,
            geometry(&harness, cx, &ids),
            "{locale} at {width}px: failure indicator moved header controls"
        );
        harness.update(cx, |root, _, cx| {
            root.session.update(cx, |session, cx| {
                session.error = None;
                cx.notify();
            });
        });
        for operation in extra {
            operation.finish(&Ok(()), false, None);
        }
        operation.finish(&Ok(()), false, None);
        harness.wait(cx, "completed activity", |root, app| {
            root.session
                .read(app)
                .operations
                .iter()
                .all(|operation| operation.status != "running")
        });
        assert_eq!(
            before,
            geometry(&harness, cx, &ids),
            "{locale} at {width}px: completion moved header controls"
        );
        harness.close(cx);
    }
}

#[gpui_kit::test]
fn phrase_due_count_does_not_move_export_or_review_controls(cx: &mut TestAppContext) {
    for (locale, width) in [("en", 1600.), ("ja", 900.)] {
        let harness = Harness::open(cx);
        let mut settings = harness.state.settings().unwrap();
        settings.locale = locale.into();
        commands::models::update_settings(&harness.state, settings).unwrap();
        harness.update(cx, |root, _, cx| {
            root.session.update(cx, |session, cx| session.refresh(cx))
        });
        harness.wait(cx, "requested locale", |root, app| {
            root.session
                .read(app)
                .snapshot
                .as_ref()
                .unwrap()
                .settings
                .locale
                == locale
        });
        cx.simulate_window_resize(harness.window, size(px(width), px(1000.)));
        harness.route(cx, "cards");
        let ids = [
            "cards-export",
            "cards-review",
            "card-language",
            "card-search",
        ];
        let before = geometry(&harness, cx, &ids);
        harness.replace_card(cx, |card| card.due_at = "2099-01-01T00:00:00Z".into());
        assert_eq!(
            before,
            geometry(&harness, cx, &ids),
            "{locale} at {width}px: removing the last due count shifted controls"
        );
        harness.replace_card(cx, |card| card.due_at = "2000-01-01T00:00:00Z".into());
        assert_eq!(
            before,
            geometry(&harness, cx, &ids),
            "{locale} at {width}px: restoring the due count shifted controls"
        );
        harness.close(cx);
    }
}

#[gpui_kit::test]
fn operation_progress_and_completion_preserve_the_neighbor_action(cx: &mut TestAppContext) {
    let harness = Harness::open(cx);
    let registry = harness.state.test_operations();
    let operation = registry
        .start(
            "preparation",
            "Current media preparation",
            OperationContext {
                media_id: Some("ui-media"),
                ..Default::default()
            },
        )
        .unwrap();
    let id = operation.reporter().id().to_owned();
    harness.route(cx, "activity");
    let dialog = harness.activity_window(cx);
    let row = format!("local-operation-{id}");
    let open = format!("open-operation-{id}");
    harness.wait_window(cx, dialog, "preparation row", |window| {
        window.try_find(row.clone()).is_some()
    });
    let before = cx
        .update_window(dialog, |_, window, app| {
            window.render_frame(app);
            (
                window.find(row.clone()).bounds(),
                window.find(open.clone()).bounds(),
            )
        })
        .unwrap();
    operation.reporter().progress(
        "downloading",
        Some(9_999_999_999),
        Some(10_000_000_000),
        Some("bytes"),
    );
    harness.wait_window(cx, dialog, "progress received", |window| {
        window
            .find(row.clone())
            .label()
            .unwrap()
            .contains("9999999999")
    });
    cx.update_window(dialog, |_, window, app| {
        window.render_frame(app);
        assert_eq!(
            (
                window.find(row.clone()).bounds(),
                window.find(open.clone()).bounds()
            ),
            before
        );
    })
    .unwrap();
    operation.finish::<()>(
        &Err(anyhow::anyhow!("A detailed fixture failure. ".repeat(35))),
        false,
        None,
    );
    harness.wait_window(cx, dialog, "terminal operation", |window| {
        window.find(row.clone()).label().unwrap().contains("Failed")
    });
    cx.update_window(dialog, |_, window, app| {
        window.render_frame(app);
        assert_eq!(
            (
                window.find(row.clone()).bounds(),
                window.find(open.clone()).bounds()
            ),
            before,
            "terminal error or disappearing Cancel shifted the neighboring action"
        );
        assert!(
            window
                .try_find(format!("cancel-operation-{id}"))
                .is_none_or(|button| !button.visible())
        );
        assert!(
            window
                .find(row.clone())
                .label()
                .unwrap()
                .contains("detailed fixture failure"),
            "full failure is retained in accessible content"
        );
        let error_body = format!("operation-error-body-{id}");
        let scroll = format!("operation-details-{id}");
        let text_before = window.find(error_body.clone()).bounds();
        let viewport = window.find(scroll.clone()).bounds();
        assert!(
            text_before.size.height > viewport.size.height,
            "the long error must retain its full text extent"
        );
        window.scroll(
            scroll.clone(),
            ScrollDelta::Pixels(point(px(0.), px(-100.))),
            app,
        );
        assert!(
            window.find(error_body).bounds().origin.y < text_before.origin.y,
            "the complete error remains readable by scrolling"
        );
        assert_eq!(window.find(scroll).bounds(), viewport);
    })
    .unwrap();
    harness.close(cx);
}

#[gpui_kit::test]
fn discard_confirmation_preserves_its_target_and_announces_the_current_action(
    cx: &mut TestAppContext,
) {
    for locale in ["en", "ja"] {
        let harness = Harness::open(cx);
        let mut settings = harness.state.settings().unwrap();
        settings.locale = locale.into();
        commands::models::update_settings(&harness.state, settings).unwrap();
        harness.update(cx, |root, _, cx| {
            root.session.update(cx, |session, cx| session.refresh(cx))
        });
        harness.wait(cx, "requested locale", |root, app| {
            root.session
                .read(app)
                .snapshot
                .as_ref()
                .unwrap()
                .settings
                .locale
                == locale
        });
        harness.route(cx, "activity");
        let dialog = harness.activity_window(cx);
        harness.wait_window(cx, dialog, "saved unfinished flow", |window| {
            window.try_find("discard-ui-flow").is_some()
        });
        cx.update_window(dialog, |_, window, app| {
            window.render_frame(app);
            let before = window.find("discard-ui-flow").bounds();
            let neighbor = window.find("resume-ui-flow").bounds();
            window.click("discard-ui-flow", app);
            window.render_frame(app);
            assert_eq!(
                window.find("discard-ui-flow").bounds(),
                before,
                "confirmation target moved in {locale}"
            );
            assert_eq!(window.find("resume-ui-flow").bounds(), neighbor);
            assert_eq!(
                window.find("discard-ui-flow").label(),
                Some(if locale == "ja" {
                    "入力を完全に破棄"
                } else {
                    "Confirm discard input"
                })
            );
            assert_eq!(
                window
                    .find_all_by_role(gpui_kit::Role::Button)
                    .iter()
                    .filter(|node| node.label()
                        == Some(if locale == "ja" {
                            "入力を完全に破棄"
                        } else {
                            "Confirm discard input"
                        }))
                    .count(),
                1,
                "only the active accessible action exists"
            );
        })
        .unwrap();
        harness.close(cx);
    }
}
