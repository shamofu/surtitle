// SPDX-License-Identifier: GPL-3.0-or-later
use super::*;
use gpui_kit::relative;
use gpui_kit::{base::TestSupportExt, test::TestEventExt};
use std::{cell::RefCell, rc::Rc};

struct Rows {
    order: Vec<&'static str>,
    motion: crate::ui::list_motion::ListMotion,
    clicks: Rc<RefCell<Vec<&'static str>>>,
    scroll: gpui_kit::ScrollHandle,
}
impl Render for Rows {
    fn render(&mut self, window: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        self.motion
            .viewport(window.viewport_size(), self.scroll.offset());
        self.motion.begin_layout();
        div()
            .id("moving-rows")
            .flex()
            .flex_col()
            .w(px(200.))
            .h(px(120.))
            .overflow_y_scroll()
            .track_scroll(&self.scroll)
            .children(self.order.iter().map(|id| {
                let id = *id;
                let clicks = self.clicks.clone();
                self.motion.row(
                    id,
                    style::button(id)
                        .label(id)
                        .w(px(200.))
                        .h(px(60.))
                        .on_click(move |_, _, _| clicks.borrow_mut().push(id)),
                )
            }))
    }
}

#[gpui_kit::test]
fn visible_reorder_preserves_identity_and_moves_real_hit_positions(cx: &mut TestAppContext) {
    cx.update(|app| {
        gpui_kit::component::init(app);
        style::init(app);
        app.set_reduce_motion(false);
    });
    let clicks = Rc::new(RefCell::new(Vec::new()));
    let (view, visual) = cx.add_window_view(|_, _| Rows {
        order: vec!["row-a", "row-b"],
        motion: Default::default(),
        clicks: clicks.clone(),
        scroll: gpui_kit::ScrollHandle::new(),
    });
    visual.update(|window, app| {
        window.render_frame(app);
        let original = window.find("row-b").bounds();
        view.update(app, |view, cx| {
            view.motion.filter_changed();
            view.order.reverse();
            cx.notify();
        });
        window.render_frame(app);
        assert_eq!(
            window.find("row-b").bounds(),
            original,
            "reorder begins at the painted bounds"
        );
    });
    visual.executor().advance_clock(Duration::from_millis(160));
    visual.update(|window, app| {
        window.render_frame(app);
        let current = window.find("row-b").bounds();
        assert!(current.top() > px(0.) && current.top() < px(60.));
        window.pointer_down(current.center(), gpui_kit::MouseButton::Left, app);
        window.pointer_up(current.center(), gpui_kit::MouseButton::Left, app);
    });
    assert_eq!(*clicks.borrow(), ["row-b"]);
    visual.update(|window, app| {
        app.set_reduce_motion(true);
        window.render_frame(app);
        assert_eq!(window.find("row-b").bounds().top(), px(0.));
    });
}

#[gpui_kit::test]
fn scrolling_rebases_row_motion_and_previously_clipped_rows_do_not_animate(
    cx: &mut TestAppContext,
) {
    cx.update(|app| {
        gpui_kit::component::init(app);
        style::init(app);
        app.set_reduce_motion(false);
    });
    let (view, visual) = cx.add_window_view(|_, _| Rows {
        order: vec!["row-a", "row-b", "row-c", "row-d"],
        motion: Default::default(),
        clicks: Default::default(),
        scroll: gpui_kit::ScrollHandle::new(),
    });
    visual.update(|window, app| {
        window.render_frame(app);
        view.update(app, |view, cx| {
            view.motion.filter_changed();
            view.order = vec!["row-c", "row-d"];
            cx.notify();
        });
        window.render_frame(app);
        assert_eq!(
            window.find("row-c").bounds().top(),
            px(0.),
            "mounting a previously clipped row adopts its current location"
        );
        view.update(app, |view, cx| {
            view.order = vec!["row-a", "row-b", "row-c", "row-d"];
            cx.notify();
        });
        window.render_frame(app);
        view.update(app, |view, cx| {
            view.motion.filter_changed();
            view.order.swap(0, 1);
            cx.notify();
        });
        window.render_frame(app);
    });
    visual.executor().advance_clock(Duration::from_millis(100));
    visual.update(|window, app| {
        window.render_frame(app);
        view.update(app, |view, cx| {
            view.scroll.set_offset(point(px(0.), px(-30.)));
            cx.notify();
        });
        window.render_frame(app);
        assert_eq!(
            window.find("row-b").bounds().top(),
            px(-30.),
            "scrolling removes the old screen-space transform"
        );
    });
}

struct Progress {
    value: f32,
    task: &'static str,
}

#[gpui_kit::test]
fn background_reintroduction_does_not_reuse_a_filtered_out_rows_old_bounds(
    cx: &mut TestAppContext,
) {
    cx.update(|app| {
        gpui_kit::init(app);
        style::init(app);
        app.set_reduce_motion(false);
    });
    let (view, visual) = cx.add_window_view(|_, _| Rows {
        order: vec!["row-a", "row-b"],
        motion: Default::default(),
        clicks: Default::default(),
        scroll: gpui_kit::ScrollHandle::new(),
    });
    visual.update(|window, app| {
        window.render_frame(app);
        view.update(app, |view, cx| {
            view.motion.filter_changed();
            view.order = vec!["row-b"];
            cx.notify();
        });
        window.render_frame(app);
        // A later snapshot can restore the ID without another user filter.
        view.update(app, |view, cx| {
            view.order = vec!["row-b", "row-a"];
            cx.notify();
        });
        window.render_frame(app);
        assert_eq!(
            window.find("row-a").bounds().top(),
            px(60.),
            "background refresh must not animate from a stale pre-filter pose"
        );
    });
}
struct ClockRows {
    motion: crate::ui::list_motion::ListMotion,
    reversed: bool,
    executor: gpui_kit::BackgroundExecutor,
}
impl Render for ClockRows {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        self.motion.begin_layout();
        let ids = if self.reversed {
            ["clock-b", "clock-a"]
        } else {
            ["clock-a", "clock-b"]
        };
        let executor = self.executor.clone();
        div()
            .flex()
            .flex_col()
            .w(px(200.))
            .child(
                self.motion
                    .row(ids[0], style::button(ids[0]).label(ids[0]).h(px(60.))),
            )
            .child(
                gpui_kit::canvas(
                    move |_, _, _| executor.advance_clock(Duration::from_millis(1)),
                    |_, _, _, _| {},
                )
                .h(px(0.)),
            )
            .child(
                self.motion
                    .row(ids[1], style::button(ids[1]).label(ids[1]).h(px(60.))),
            )
    }
}
#[gpui_kit::test]
fn one_layout_batch_retains_every_rows_pose_when_clock_advances_between_rows(
    cx: &mut TestAppContext,
) {
    cx.update(|app| {
        gpui_kit::init(app);
        style::init(app);
        app.set_reduce_motion(false);
    });
    let executor = cx.executor();
    let (view, visual) = cx.add_window_view(|_, _| ClockRows {
        motion: Default::default(),
        reversed: false,
        executor,
    });
    visual.update(|window, app| {
        window.render_frame(app);
        let first = window.find("clock-a").bounds().top();
        let second = window.find("clock-b").bounds().top();
        view.update(app, |view, cx| {
            view.motion.filter_changed();
            view.reversed = true;
            cx.notify();
        });
        window.render_frame(app);
        assert!(
            f32::from(window.find("clock-a").bounds().top() - first).abs() < 2.,
            "first row must retain its measured pose even though another row sampled a later time"
        );
        assert!(f32::from(window.find("clock-b").bounds().top() - second).abs() < 2.);
    });
}

impl Render for Progress {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let fill = motion_controls::progress(self.task, self.value, window, cx);
        div().w(px(200.)).h(px(8.)).child(
            div()
                .id("progress-decoration")
                .test_support()
                .h_full()
                .w(relative(fill)),
        )
    }
}
#[gpui_kit::test]
fn progress_retargets_displayed_fill_and_adopts_unrelated_task_immediately(
    cx: &mut TestAppContext,
) {
    cx.update(|app| app.set_reduce_motion(false));
    let (view, visual) = cx.add_window_view(|_, _| Progress {
        value: 0.25,
        task: "first",
    });
    visual.update(|window, app| {
        window.render_frame(app);
        assert_eq!(
            window.find("progress-decoration").bounds().size.width,
            px(50.)
        );
        view.update(app, |view, cx| {
            view.value = 0.75;
            cx.notify();
        });
        window.render_frame(app);
        assert_eq!(
            window.find("progress-decoration").bounds().size.width,
            px(50.)
        );
    });
    visual.executor().advance_clock(Duration::from_millis(60));
    visual.update(|window, app| {
        window.render_frame(app);
        let current = window.find("progress-decoration").bounds().size.width;
        assert!(current > px(50.) && current < px(150.));
        view.update(app, |view, cx| {
            view.value = 0.5;
            cx.notify();
        });
        window.render_frame(app);
        assert_eq!(
            window.find("progress-decoration").bounds().size.width,
            current
        );
        view.update(app, |view, cx| {
            view.task = "second";
            view.value = 0.1;
            cx.notify();
        });
        window.render_frame(app);
        assert_eq!(
            window.find("progress-decoration").bounds().size.width,
            px(20.)
        );
    });
}
