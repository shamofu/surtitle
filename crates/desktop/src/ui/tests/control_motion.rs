// SPDX-License-Identifier: GPL-3.0-or-later
use super::*;
use gpui_kit::{
    base::{Disableable, Selectable},
    test::TestEventExt,
};
use std::{cell::Cell, rc::Rc};

struct Buttons {
    calls: Rc<Cell<usize>>,
    loading: bool,
    disabled: bool,
}

struct ExplicitSurface {
    selected: bool,
}
impl Render for ExplicitSurface {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().size_full().child(
            style::button("explicit-surface")
                .bg(gpui_kit::rgb(0x0ea76d))
                .label("Keep visible")
                .role(gpui_kit::Role::CheckBox)
                .toggled(self.selected)
                .selected(self.selected),
        )
    }
}

#[gpui_kit::test]
fn caller_background_survives_normal_and_selected_checkbox_presentation(cx: &mut TestAppContext) {
    cx.update(|app| {
        gpui_kit::init(app);
        style::init(app);
        app.set_reduce_motion(true);
    });
    for selected in [false, true] {
        let (_, visual) = cx.add_window_view(|window, cx| {
            let content = cx.new(|_| ExplicitSurface { selected });
            Root::new(content, window, cx)
        });
        visual.update(|window, app| {
            window.render_frame(app);
            window.pointer_move(point(px(500.), px(500.)), None, app);
            window.render_frame(app);
            let marker: gpui_kit::Hsla = gpui_kit::rgb(0x0ea76d).into();
            assert!(
                window
                    .painted_quads()
                    .iter()
                    .any(|quad| quad.background.as_solid() == Some(marker)),
                "caller background must actually paint"
            );
            let control = window.find("explicit-surface");
            assert_eq!(control.role(), Some(gpui_kit::Role::CheckBox));
            assert_eq!(control.checked(), Some(selected));
            assert_eq!(control.label(), Some("Keep visible"));
            // Kit's internal plain label does not register ObservedText. Keep
            // its real name and measured, visible control geometry intact.
            assert!(control.visible());
            assert_eq!(control.bounds().size.height, px(40.));
            assert!(control.bounds().size.width > px(40.));
        });
    }
}
impl Render for Buttons {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let calls = self.calls.clone();
        div().id("motion-buttons").tab_group().size_full().child(
            style::button("motion-button")
                .label("Action")
                .w(px(120.))
                .loading(self.loading)
                .disabled(self.disabled)
                .on_click(move |_, _, _| calls.set(calls.get() + 1)),
        )
    }
}

#[gpui_kit::test]
fn loading_button_is_inert_and_announces_disabled(cx: &mut TestAppContext) {
    cx.update(|app| {
        gpui_kit::component::init(app);
        style::init(app);
    });
    for (loading, disabled) in [(true, false), (false, true)] {
        let calls = Rc::new(Cell::new(0));
        let (_, visual) = cx.add_window_view(|window, cx| {
            let buttons = cx.new(|_| Buttons {
                calls: calls.clone(),
                loading,
                disabled,
            });
            Root::new(buttons, window, cx)
        });
        visual.update(|window, app| {
            window.render_frame(app);
            assert_eq!(window.find("motion-button").disabled(), Some(true));
            window.click("motion-button", app);
            window.press("enter", app);
            window.press("space", app);
        });
        assert_eq!(calls.get(), 0);
    }
}

#[gpui_kit::test]
fn button_activation_once_and_fixed_hitbox_through_pointer_release(cx: &mut TestAppContext) {
    cx.update(|app| {
        gpui_kit::component::init(app);
        style::init(app);
        app.set_reduce_motion(false);
    });
    let calls = Rc::new(Cell::new(0));
    let (_, visual) = cx.add_window_view(|window, cx| {
        let buttons = cx.new(|_| Buttons {
            calls: calls.clone(),
            loading: false,
            disabled: false,
        });
        Root::new(buttons, window, cx)
    });
    visual.update(|window, app| {
        window.render_frame(app);
        // Normal pages establish an initial focus target when opened. Seed
        // that platform precondition before exercising real Tab/activation.
        window.focus_next(app);
        window.render_frame(app);
        let bounds = window.find("motion-button").bounds();
        window.pointer_down(bounds.center(), gpui_kit::MouseButton::Left, app);
        window.render_frame(app);
        assert_eq!(window.find("motion-button").bounds(), bounds);
        window.pointer_up(point(px(300.), px(300.)), gpui_kit::MouseButton::Left, app);
        window.click("motion-button", app);
        window.press("tab", app);
        assert_eq!(window.find("motion-button").focused(), Some(true));
        window.press("enter", app);
        window.press("space", app);
        assert_eq!(window.find("motion-button").bounds(), bounds);
    });
    assert_eq!(calls.get(), 3);
}

fn painted_surface_width(window: &Window) -> f32 {
    window
        .painted_quads()
        .into_iter()
        .filter(|quad| {
            !quad.background.is_transparent()
                && quad.bounds.size.height.0 > 30. * window.scale_factor()
                && quad.bounds.size.height.0 < 50. * window.scale_factor()
        })
        .map(|quad| quad.bounds.size.width.0 / window.scale_factor())
        .fold(0., f32::max)
}

#[gpui_kit::test]
fn button_paints_scaled_surface_retargets_and_releases_outside(cx: &mut TestAppContext) {
    cx.update(|app| {
        gpui_kit::component::init(app);
        style::init(app);
        app.set_reduce_motion(false);
    });
    let calls = Rc::new(Cell::new(0));
    let (_, visual) = cx.add_window_view(|window, cx| {
        let buttons = cx.new(|_| Buttons {
            calls: calls.clone(),
            loading: false,
            disabled: false,
        });
        Root::new(buttons, window, cx)
    });
    let original = visual.update(|window, app| {
        window.render_frame(app);
        let bounds = window.find("motion-button").bounds();
        window.pointer_move(bounds.center(), None, app);
        window.render_frame(app);
        bounds
    });
    visual.executor().advance_clock(Duration::from_millis(200));
    visual.update(|window, app| {
        window.render_frame(app);
        assert!((painted_surface_width(window) - 123.).abs() < 0.1);
        window.pointer_down(original.center(), gpui_kit::MouseButton::Left, app);
        window.render_frame(app);
        assert!(
            (painted_surface_width(window) - 123.).abs() < 0.1,
            "press retargets the actual hover pose"
        );
    });
    visual.executor().advance_clock(Duration::from_millis(100));
    visual.update(|window, app| {
        window.render_frame(app);
        assert!(
            (painted_surface_width(window)
                - (112.8 * window.scale_factor()).round() / window.scale_factor())
            .abs()
                < 0.1,
            "actual painted press width: {}",
            painted_surface_width(window)
        );
        assert_eq!(window.find("motion-button").bounds(), original);
        window.pointer_up(point(px(300.), px(300.)), gpui_kit::MouseButton::Left, app);
        window.render_frame(app);
    });
    visual.executor().advance_clock(Duration::from_millis(240));
    visual.update(|window, app| {
        window.render_frame(app);
        assert!((painted_surface_width(window) - 120.).abs() < 0.1);
        assert_eq!(window.find("motion-button").bounds(), original);
    });
    assert_eq!(calls.get(), 0);
}
