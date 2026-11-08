// SPDX-License-Identifier: GPL-3.0-or-later
use super::*;

#[gpui_kit::test]
fn review_concealed_answers_leave_accesskit_until_reveal_then_focus_immediately(
    cx: &mut TestAppContext,
) {
    let harness = Harness::open(cx);
    let card = harness.replace_card(cx, |card| {
        card.meaning = "Concealed meaning sentinel".into();
        card.translation = Some("Concealed translation sentinel".into());
        card.explanation = Some("Concealed notes sentinel".into());
    });
    harness.route(cx, "review");
    cx.update(|app| app.set_reduce_motion(false));
    cx.update_window(harness.window, |_, window, app| {
        window.activate_accessibility_for_test();
        window.render_frame(app);
        let hidden = window.debug_a11y_tree_json().unwrap();
        for answer in [
            card.meaning.as_str(),
            card.translation.as_deref().unwrap(),
            card.explanation.as_deref().unwrap(),
        ] {
            assert!(
                !hidden.contains(answer),
                "concealed answer leaked through actual AccessKit: {answer}: {hidden}"
            );
        }
        window.press("space", app);
        let disclosed = window.debug_a11y_tree_json().unwrap();
        for answer in [
            card.meaning.as_str(),
            card.translation.as_deref().unwrap(),
            card.explanation.as_deref().unwrap(),
        ] {
            assert!(
                disclosed.contains(answer),
                "revealed answer missing: {disclosed}"
            );
        }
        assert_eq!(window.find("review-meaning").focused(), Some(true));
        window.press("3", app);
    })
    .unwrap();
    wait_for_review_count(&harness, cx, 1);
    harness.close(cx);
}

fn long_answer(card: &mut StudyCard) {
    card.meaning = (0..80)
        .map(|line| format!("Opaque answer line {line}: keep the complete scroll range.\n"))
        .collect();
    card.explanation = Some("Final opaque answer note".into());
}

// Observe the actual long answer's background and its composed paint mask,
// rather than a transition's configuration or un-clipped element metadata.
fn answer_surface_pose(window: &Window, app: &App) -> (f32, f32, f32) {
    use gpui_kit::component::ActiveTheme;
    let secondary = app.theme().secondary;
    let quad = window
        .painted_quads()
        .into_iter()
        .find(|quad| {
            quad.bounds.size.height.0 > 1_000. * window.scale_factor()
                && quad.bounds.size.width.0 > 500. * window.scale_factor()
                && quad.background.as_solid().is_some_and(|color| {
                    color.h == secondary.h && color.s == secondary.s && color.l == secondary.l
                })
        })
        .expect("actual long answer background must be painted");
    let visible = quad.bounds.intersect(&quad.content_mask.bounds);
    (
        visible.top().0 / window.scale_factor(),
        visible.size.height.0 / window.scale_factor(),
        quad.background.as_solid().unwrap().a,
    )
}

#[gpui_kit::test]
fn review_long_answer_expands_opaque_clip_over_the_viewport_and_keeps_scroll_range(
    cx: &mut TestAppContext,
) {
    let harness = Harness::open(cx);
    harness.replace_card(cx, long_answer);
    harness.route(cx, "review");
    cx.update(|app| app.set_reduce_motion(false));
    let (reserved, prompt) = cx
        .update_window(harness.window, |_, window, app| {
            window.render_frame(app);
            let reserved = window.find("review-answer-scroll").bounds();
            let prompt = window.find("review-prompt").bounds();
            window.press("space", app);
            (reserved, prompt)
        })
        .unwrap();
    cx.executor().advance_clock(Duration::from_millis(170));
    cx.update_window(harness.window, |_, window, app| {
        window.render_frame(app);
        let before_scroll = answer_surface_pose(window, app);
        let expected = f32::from(reserved.size.height)
            * super::super::motion::entering_easing().sample(0.5);
        assert!(
            (before_scroll.1 - expected).abs() < 1.1,
            "reveal must expand over the scroll viewport, not the intrinsic long answer: {before_scroll:?} vs {expected}"
        );
        assert_eq!(before_scroll.2, 1., "revealed pixels must be opaque");
        assert_eq!(window.find("review-answer-scroll").bounds(), reserved);
        assert_eq!(window.find("review-prompt").bounds(), prompt);
        let meaning_top = window.find("review-meaning").bounds().top();
        window.scroll(
            "review-answer-scroll",
            ScrollDelta::Pixels(point(px(0.), px(-300.))),
            app,
        );
        let after_scroll = answer_surface_pose(window, app);
        assert!((after_scroll.0 - before_scroll.0).abs() < 1.1);
        assert!((after_scroll.1 - before_scroll.1).abs() < 1.1);
        assert!(window.find("review-meaning").bounds().top() < meaning_top);
    })
    .unwrap();
    cx.executor().advance_clock(Duration::from_millis(170));
    cx.update_window(harness.window, |_, window, app| {
        window.render_frame(app);
        let complete = answer_surface_pose(window, app);
        assert!((complete.1 - f32::from(reserved.size.height)).abs() < 1.1);
        window.scroll(
            "review-answer-scroll",
            ScrollDelta::Pixels(point(px(0.), px(-100_000.))),
            app,
        );
        assert!(window.find("review-explanation").visible());
        assert_eq!(window.find("review-answer-scroll").bounds(), reserved);
    })
    .unwrap();
    harness.close(cx);
}

#[gpui_kit::test]
fn review_early_grade_preserves_the_outgoing_answer_reveal_pose(cx: &mut TestAppContext) {
    let harness = Harness::open(cx);
    let first = harness.replace_card(cx, long_answer);
    let mut next = first.clone();
    next.id = "early-grade-next".into();
    next.term = "Next concealed prompt".into();
    next.due_at = "2001-01-01T00:00:00Z".into();
    Store::open(harness.root.path().join("learning.sqlite"))
        .unwrap()
        .put_card(&next)
        .unwrap();
    harness
        .state
        .changes
        .publish(ChangeDomain::Cards, Some(next.id));
    harness.wait(cx, "two early-grade cards", |root, app| {
        root.session
            .read(app)
            .snapshot
            .as_ref()
            .is_some_and(|snapshot| snapshot.cards.len() == 2)
    });
    harness.route(cx, "review");
    cx.update(|app| app.set_reduce_motion(false));
    cx.update_window(harness.window, |_, window, app| window.press("space", app))
        .unwrap();
    cx.executor().advance_clock(Duration::from_millis(80));
    let before = cx
        .update_window(harness.window, |_, window, app| {
            window.render_frame(app);
            let pose = answer_surface_pose(window, app);
            window.press("3", app);
            pose
        })
        .unwrap();
    wait_for_review_count(&harness, cx, 1);
    cx.update_window(harness.window, |_, window, app| {
        window.render_frame(app);
        let after = answer_surface_pose(window, app);
        assert!(
            (before.0 - after.0).abs() < 1.1
                && (before.1 - after.1).abs() < 1.1
                && (before.2 - after.2).abs() < 0.001,
            "the first wipe frame must retain the displayed answer pose: {before:?} -> {after:?}"
        );
        assert_eq!(window.find("review-prompt").focused(), Some(true));
        assert!(window.try_find("good").is_none());
    })
    .unwrap();
    harness.close(cx);
}

#[gpui_kit::test]
fn review_reveal_reserves_answer_geometry_and_rapid_grades_keep_one_active_card(
    cx: &mut TestAppContext,
) {
    let harness = Harness::open(cx);
    let store = Store::open(harness.root.path().join("learning.sqlite")).unwrap();
    let mut next = commands::cards::get_card_edit_state(&harness.state, "ui-card".into())
        .unwrap()
        .card;
    next.id = "motion-next".into();
    next.term = "Next prompt".into();
    next.due_at = "2001-01-01T00:00:00Z".into();
    store.put_card(&next).unwrap();
    next.id = "motion-third".into();
    next.term = "Third prompt".into();
    store.put_card(&next).unwrap();
    harness
        .state
        .changes
        .publish(ChangeDomain::Cards, Some(next.id));
    harness.wait(cx, "three review cards", |root, app| {
        root.session
            .read(app)
            .snapshot
            .as_ref()
            .is_some_and(|snapshot| snapshot.cards.len() == 3)
    });
    harness.route(cx, "review");
    cx.update(|app| app.set_reduce_motion(false));
    let previous_prompt = cx
        .update_window(harness.window, |_, window, app| {
            window.activate_accessibility_for_test();
            window.render_frame(app);
            let previous = window.find("review-prompt").label().unwrap().to_owned();
            let reserved = window.find("review-answer-scroll").bounds();
            window.press("space", app);
            assert_eq!(window.find("review-answer-scroll").bounds(), reserved);
            assert_eq!(window.find("review-meaning").focused(), Some(true));
            window.press("3", app);
            window.press("3", app);
            previous
        })
        .unwrap();
    wait_for_review_count(&harness, cx, 1);
    cx.update_window(harness.window, |_, window, app| {
        window.render_frame(app);
        let current_prompt = commands::ai::get_app_snapshot(&harness.state)
            .unwrap()
            .cards
            .into_iter()
            .find(|card| card.review_count == 0)
            .unwrap()
            .term;
        let tree = window
            .debug_a11y_tree_json()
            .expect("active fake-platform AccessKit tree");
        assert!(
            tree.contains(&current_prompt),
            "current prompt must enter AccessKit immediately: {tree}"
        );
        assert!(
            !tree.contains(&previous_prompt),
            "outgoing prompt must leave AccessKit immediately: {tree}"
        );
        let current_node = window
            .find_all("review-prompt")
            .into_iter()
            .find(|node| node.label() == Some(current_prompt.as_str()))
            .expect("current prompt snapshot");
        assert_eq!(current_node.focused(), Some(true));
        assert!(
            window.try_find("good").is_none(),
            "next card does not retain old grading controls"
        );
    })
    .unwrap();
    cx.executor().advance_clock(Duration::from_millis(80));
    let before_second_grade = cx
        .update_window(harness.window, |_, window, app| {
            window.render_frame(app);
            window.press("space", app);
            let poses = review_surface_masks(window, app);
            assert!(
                poses.len() >= 2,
                "first wipe must still contain both opaque card regions"
            );
            window.press("3", app);
            poses
        })
        .unwrap();
    wait_for_review_count(&harness, cx, 2);
    cx.update_window(harness.window, |_, window, app| {
        window.render_frame(app);
        let after = review_surface_masks(window, app);
        assert_eq!(
            after.len(),
            before_second_grade.len(),
            "new wipe must retain the displayed composite at its first frame"
        );
        for (before, after) in before_second_grade.iter().zip(&after) {
            assert!(
                (before.0 - after.0).abs() < 1.1 && (before.1 - after.1).abs() < 1.1,
                "interrupted wipe jumped: {before_second_grade:?} -> {after:?}"
            );
        }
        for pair in after.windows(2) {
            assert!(
                (pair[0].1 - pair[1].0).abs() < 1.1,
                "opaque masks must meet without a gap or overlapping text"
            );
        }
        let current = commands::ai::get_app_snapshot(&harness.state)
            .unwrap()
            .cards
            .into_iter()
            .find(|card| card.review_count == 0)
            .unwrap()
            .term;
        let tree = window.debug_a11y_tree_json().unwrap();
        assert!(tree.contains(&current));
        assert_eq!(window.find("review-prompt").focused(), Some(true));
        app.set_reduce_motion(true);
        window.render_frame(app);
        assert_eq!(window.find_all("review-prompt").len(), 1);
        assert_eq!(review_surface_masks(window, app).len(), 1);
    })
    .unwrap();
    harness.close(cx);
}

fn wait_for_review_count(harness: &Harness, cx: &mut TestAppContext, expected: u32) {
    // Persistence and snapshot delivery use real IO. Keep their wall-clock
    // wait separate from presentation time for both grades, otherwise a busy
    // test runner can finish the first wipe before its intermediate assertion.
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        cx.run_until_parked();
        let ready = cx.read(|app| {
            harness
                .view
                .read(app)
                .session
                .read(app)
                .snapshot
                .as_ref()
                .is_some_and(|snapshot| {
                    snapshot
                        .cards
                        .iter()
                        .map(|card| card.review_count)
                        .sum::<u32>()
                        == expected
                })
        });
        if ready {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "grade callback did not finish for review count {expected}"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
}

fn review_surface_masks(window: &Window, app: &App) -> Vec<(f32, f32)> {
    use gpui_kit::component::ActiveTheme;
    let mut intervals = window
        .painted_quads()
        .into_iter()
        .filter(|quad| {
            quad.background.as_solid() == Some(app.theme().popover)
                && quad.bounds.size.width.0 > 400. * window.scale_factor()
                && quad.bounds.size.height.0 > 300. * window.scale_factor()
        })
        .map(|quad| {
            let clipped = quad.bounds.intersect(&quad.content_mask.bounds);
            (
                clipped.left().0 / window.scale_factor(),
                clipped.right().0 / window.scale_factor(),
            )
        })
        .filter(|(left, right)| right > left)
        .collect::<Vec<_>>();
    intervals.sort_by(|a, b| a.0.total_cmp(&b.0));
    intervals
}
