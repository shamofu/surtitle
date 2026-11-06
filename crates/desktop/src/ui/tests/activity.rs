// SPDX-License-Identifier: GPL-3.0-or-later
use super::*;
use crate::application::operations::OperationContext;

#[gpui_kit::test]
fn activity_shows_real_local_parent_child_progress_and_cancels_only_its_preparation(
    cx: &mut TestAppContext,
) {
    let harness = Harness::open(cx);
    let registry = harness.state.test_operations();
    let preparation = registry
        .start(
            "preparation",
            "Current media preparation",
            OperationContext {
                media_id: Some("ui-media"),
                ..Default::default()
            },
        )
        .unwrap();
    let preparation_id = preparation.reporter().id().to_owned();
    let child = registry
        .start(
            "tool",
            "Local tool acquisition",
            OperationContext {
                parent_id: Some(&preparation_id),
                tool_id: Some("ffmpeg"),
                ..Default::default()
            },
        )
        .unwrap();
    let child_id = child.reporter().id().to_owned();
    child
        .reporter()
        .progress("downloading", Some(17), Some(100), Some("bytes"));
    let (local_cancel, network_cancel) = harness
        .state
        .test_preparation_cancellation(preparation_id.clone());
    let failed = registry
        .start(
            "tool_check",
            "Tool check history",
            OperationContext::default(),
        )
        .unwrap();
    let failed_id = failed.reporter().id().to_owned();
    failed.finish::<()>(
        &Err(anyhow::anyhow!("Fixture tool check failure")),
        false,
        None,
    );
    harness.route(cx, "activity");
    let activity_window = harness.activity_window(cx);
    let parent_row = format!("local-operation-{preparation_id}");
    let child_row = format!("local-operation-{child_id}");
    let failed_row = format!("local-operation-{failed_id}");
    harness.wait_window(
        cx,
        activity_window,
        "actual local operations in Activity",
        |window| {
            window.try_find(parent_row.clone()).is_some()
                && window.try_find(child_row.clone()).is_some()
                && window.try_find(failed_row.clone()).is_some()
        },
    );
    cx.update_window(activity_window, |_, window, app| {
        assert!(
            window
                .within(parent_row.clone())
                .find(child_row.clone())
                .label()
                .unwrap()
                .contains("17 / 100 bytes")
        );
        assert!(
            window
                .find(failed_row.clone())
                .label()
                .unwrap()
                .contains("Fixture tool check failure")
        );
        assert!(
            window
                .try_find(format!("cancel-operation-{child_id}"))
                .is_none()
        );
        window.click(format!("cancel-operation-{preparation_id}"), app);
    })
    .unwrap();
    harness.wait(cx, "real preparation cancellation tokens", |_, _| {
        local_cancel.load(Ordering::Relaxed) && network_cancel.is_cancelled()
    });
    preparation.finish::<()>(
        &Err(anyhow::anyhow!("Cancelled fixture preparation")),
        true,
        None,
    );
    child.finish(&Ok(()), false, None);
    harness.wait_window(
        cx,
        activity_window,
        "terminal operation status refresh",
        |window| {
            window
                .find(parent_row.clone())
                .label()
                .unwrap()
                .contains("Cancelled")
                && window
                    .find(child_row.clone())
                    .label()
                    .unwrap()
                    .contains("Completed")
        },
    );
    cx.update_window(activity_window, |_, window, app| {
        assert!(
            window
                .try_find(format!("cancel-operation-{preparation_id}"))
                .is_none_or(|item| !item.visible())
        );
        window.click(format!("open-operation-{failed_id}"), app);
    })
    .unwrap();
    harness.wait(cx, "operation links to settings", |root, _| {
        root.route == Route::Settings
    });
    assert_eq!(
        commands::media_tools::list_operation_progress(&harness.state)
            .unwrap()
            .len(),
        3
    );
    harness.close(cx);
}

#[gpui_kit::test]
fn activity_entry_and_local_dialog_save_reload_durable_unfinished_requests(
    cx: &mut TestAppContext,
) {
    let harness = Harness::open(cx);
    // The existing Activity entity has already loaded. Saving unfinished input
    // intentionally emits no domain snapshot and grants no execution authority.
    let saved = commands::continuations::save_ai_continuation(
        &harness.state,
        serde_json::from_value(serde_json::json!({
            "id":"late-activity-input", "mediaId":"ui-media", "kind":"translate",
            "start":" 00:00 ", "end":"00:00.900", "wholeMedia":false, "focusTerm":""
        }))
        .unwrap(),
    )
    .unwrap();
    harness.route(cx, "activity");
    let activity_window = harness.activity_window(cx);
    harness.wait_window(
        cx,
        activity_window,
        "durable input loaded on Activity entry",
        |window| window.try_find(format!("resume-{}", saved.id)).is_some(),
    );
    harness.update(cx, |root, window, cx| {
        root.ai.update(cx, |view, cx| {
            view.request(
                ai::AiIntent {
                    media_id: "ui-media".into(),
                    kind: ai::AiKind::Vocabulary,
                    start_ms: 0,
                    end_ms: 900,
                    focus_term: None,
                },
                window,
                cx,
            )
        });
    });
    harness.wait(cx, "actual AI request dialog", |_, app| {
        app.windows().len() == 3
    });
    let dialog = cx.read(|app| {
        app.windows()
            .into_iter()
            .find(|window| *window != harness.window && *window != activity_window)
            .unwrap()
    });
    let label = "Phrase to explain; blank finds expressions";
    harness.wait_window(cx, dialog, "accessible request input", |window| {
        window.try_find_by_label(label).is_some()
    });
    cx.update_window(dialog, |_, window, app| {
        let input = window
            .find_by_label(label)
            .path()
            .iter()
            .find(|id| matches!(id, gpui::ElementId::NamedInteger(name, _) if name.as_ref() == "input"))
            .unwrap()
            .clone();
        window.within(input).click("input-state", app);
        window.input("  precise unfinished phrase  ", app);
    })
    .unwrap();
    cx.run_until_parked();
    cx.update_window(dialog, |_, window, _| window.remove_window())
        .unwrap();
    // Activity is already selected: local save/close must invalidate its list.
    let mut new_id = None;
    harness.wait(cx, "actual dialog input persisted", |_, _| {
        commands::continuations::list_ai_continuations(&harness.state)
            .unwrap()
            .iter()
            .any(|value| value.focus_term == "  precise unfinished phrase  ")
    });
    for value in commands::continuations::list_ai_continuations(&harness.state).unwrap() {
        if value.focus_term == "  precise unfinished phrase  " {
            new_id = Some(value.id);
        }
    }
    let new_id = new_id.unwrap();
    harness.wait_window(
        cx,
        activity_window,
        "locally saved request shown without snapshot",
        |window| window.try_find(format!("resume-{new_id}")).is_some(),
    );
    cx.update_window(activity_window, |_, window, app| {
        window.click(format!("discard-{new_id}"), app);
    })
    .unwrap();
    cx.run_until_parked();
    cx.update_window(activity_window, |_, window, app| {
        window.click(format!("discard-{new_id}"), app);
    })
    .unwrap();
    harness.wait(cx, "discarded request removed durably", |_, _| {
        !commands::continuations::list_ai_continuations(&harness.state)
            .unwrap()
            .iter()
            .any(|value| value.id == new_id)
    });
    harness.route(cx, "library");
    harness.route(cx, "activity");
    let activity_window = harness.activity_window(cx);
    harness.drain_callbacks(cx);
    cx.update_window(activity_window, |_, window, app| {
        window.render_frame(app);
        assert!(
            window
                .try_find(format!("resume-{new_id}"))
                .is_none_or(|item| !item.visible())
        );
    })
    .unwrap();
    assert!(
        commands::ai::get_app_snapshot(&harness.state)
            .unwrap()
            .jobs
            .is_empty()
    );
    harness.close(cx);
}
