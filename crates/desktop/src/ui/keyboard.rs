// SPDX-License-Identifier: GPL-3.0-or-later
use gpui_kit::base::{Button as ControlRoot, SliderIndicator, SliderThumb, SliderTrack, StyledExt};
use gpui_kit::component::{
    ActiveTheme, WindowExt,
    input::AnyInputState,
    slider::{SliderEvent, SliderState},
};
use gpui_kit::{
    App, Context, Entity, EntityInputHandler, FocusHandle, KeyDownEvent, MouseButton, SharedString,
    StyleRefinement, Window, div, prelude::*, px, relative,
};

/// Owned form textareas use browser-like focus traversal, not code indentation.
/// Capture the multiline actions before the input engine inserts whitespace;
/// leave ordinary single-line inputs and other controls to their own handlers.
pub(super) fn form_tab_navigation<E: InteractiveElement>(element: E) -> E {
    element
        .capture_action(|_: &gpui_kit::base::input::IndentInline, window, cx| {
            textarea_tab(false, window, cx)
        })
        .capture_action(|_: &gpui_kit::base::input::OutdentInline, window, cx| {
            textarea_tab(true, window, cx)
        })
}

fn textarea_tab(backwards: bool, window: &mut Window, cx: &mut App) {
    let Some(AnyInputState::Textarea(input)) = window.focused_input(cx) else {
        cx.propagate();
        return;
    };
    let composing = input.update(cx, |input, cx| {
        input.marked_text_range(window, cx).is_some()
    });
    if !composing {
        if backwards {
            window.focus_prev(cx);
        } else {
            window.focus_next(cx);
        }
    }
    // A Tab reaching GPUI during preedit must not edit or blur that composition.
    cx.stop_propagation();
}

/// Page shortcuts belong to the page surface, never a focused descendant control.
/// `prefer_character_input` describes platform character translation; it does not
/// identify an input, IME composition, button, slider, or an open popup.
pub(super) fn page_shortcut(
    event: &KeyDownEvent,
    surfaces: &[&FocusHandle],
    window: &Window,
) -> bool {
    !event.prefer_character_input
        && event.keystroke.modifiers == Default::default()
        && surfaces.iter().any(|surface| surface.is_focused(window))
}

/// The application's horizontal, single-value slider. The pinned Kit slider's
/// pointer primitives retain drag/touch behavior; this owner adds keyboard focus
/// and sends keyboard/UIA adjustments through the same SliderEvent::Change path.
#[derive(IntoElement)]
pub(super) struct Slider {
    state: Entity<SliderState>,
    disabled: bool,
    label: Option<SharedString>,
    value_text: Option<SharedString>,
    keyboard_step: Option<f32>,
    style: StyleRefinement,
}

impl Slider {
    pub fn new(state: &Entity<SliderState>) -> Self {
        Self {
            state: state.clone(),
            disabled: false,
            label: None,
            value_text: None,
            keyboard_step: None,
            style: StyleRefinement::default(),
        }
    }
    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }
    pub fn accessibility_label(mut self, label: impl Into<SharedString>) -> Self {
        self.label = Some(label.into());
        self
    }
    pub fn accessibility_value(mut self, value: impl Into<SharedString>) -> Self {
        self.value_text = Some(value.into());
        self
    }
    /// Override discrete keyboard/UIA increments without changing pointer mapping.
    pub fn keyboard_step(mut self, step: f32) -> Self {
        self.keyboard_step = (step.is_finite() && step > 0.).then_some(step);
        self
    }
}

impl Styled for Slider {
    fn style(&mut self) -> &mut StyleRefinement {
        &mut self.style
    }
}

fn adjust(
    state: &mut SliderState,
    key: &str,
    step: f32,
    window: &mut Window,
    cx: &mut Context<SliderState>,
) {
    let current = state.value().end();
    let value = match key {
        "left" | "down" => current - step,
        "right" | "up" => current + step,
        "home" => state.min_value(),
        "end" => state.max_value(),
        _ => return,
    }
    .clamp(state.min_value(), state.max_value());
    if value != current {
        state.set_value(value, window, cx);
        cx.emit(SliderEvent::Change(state.value()));
    }
}

impl RenderOnce for Slider {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let focus = window
            .use_keyed_state(("slider-focus", self.state.entity_id()), cx, |_, cx| {
                cx.focus_handle()
            })
            .read(cx)
            .clone()
            .tab_stop(!self.disabled);
        let state = self.state.read(cx);
        debug_assert!(!state.value().is_range());
        let percentage = state.percentage().end;
        let step = self.keyboard_step.unwrap_or_else(|| state.step_value());
        let theme = cx.theme();
        let color = theme.primary;
        let border = theme.border;
        let thumb = theme.popover;
        let ring = theme.ring;
        let focus_on_press = focus.clone();
        let disabled = self.disabled;
        // Base's role-overridable control root supplies disabled accessibility
        // semantics without another accessible node or a dependency patch.
        ControlRoot::new(("slider", self.state.entity_id()))
            .role(gpui_kit::accesskit::Role::Slider)
            .when_some(self.label, |this, label| this.aria_label(label))
            .when_some(self.value_text, |this, value| this.aria_value(value))
            .aria_numeric_value(state.value().end() as f64)
            .aria_min_numeric_value(state.min_value() as f64)
            .aria_max_numeric_value(state.max_value() as f64)
            .aria_numeric_value_step(step as f64)
            .aria_orientation(gpui_kit::accesskit::Orientation::Horizontal)
            .disabled(disabled)
            .track_focus(&focus)
            .w_full()
            .h(px(24.))
            .flex()
            .items_center()
            .rounded(px(4.))
            // Paint focus without insetting the track: every point inside the
            // accessible control, including its endpoints, stays interactive.
            .focus_visible(move |style| {
                style.shadow(vec![
                    gpui_kit::BoxShadow::new(px(0.), px(0.), ring).spread_radius(px(1.)),
                ])
            })
            .refine_style(&self.style)
            .when(!disabled, |this| {
                this.capture_any_mouse_down(move |event, window, cx| {
                    if event.button == MouseButton::Left {
                        focus_on_press.focus(window, cx);
                    }
                })
                .on_key_down(window.listener_for(
                    &self.state,
                    move |state, event: &KeyDownEvent, window, cx| {
                        if event.prefer_character_input
                            || event.keystroke.modifiers != Default::default()
                            || !focus.is_focused(window)
                        {
                            return;
                        }
                        if matches!(
                            event.keystroke.key.as_str(),
                            "left" | "right" | "up" | "down" | "home" | "end"
                        ) {
                            adjust(state, &event.keystroke.key, step, window, cx);
                            cx.stop_propagation();
                        }
                    },
                ))
                .on_a11y_action(gpui_kit::AccessibleAction::Increment, {
                    let state = self.state.clone();
                    move |_, window, cx| {
                        state.update(cx, |state, cx| adjust(state, "right", step, window, cx))
                    }
                })
                .on_a11y_action(gpui_kit::AccessibleAction::Decrement, {
                    let state = self.state.clone();
                    move |_, window, cx| {
                        state.update(cx, |state, cx| adjust(state, "left", step, window, cx))
                    }
                })
                .on_mouse_up(
                    MouseButton::Left,
                    window.listener_for(&self.state, |state, _, _, cx| state.handle_release(cx)),
                )
                .on_mouse_up_out(
                    MouseButton::Left,
                    window.listener_for(&self.state, |state, _, _, cx| state.handle_release(cx)),
                )
            })
            .child(
                SliderTrack::new(&self.state)
                    .disabled(disabled)
                    .w_full()
                    .h_full()
                    .flex()
                    .items_center()
                    .child(
                        SliderIndicator::new(&self.state)
                            .relative()
                            .w_full()
                            .h(px(6.))
                            .rounded_full()
                            .bg(border)
                            .child(
                                div()
                                    .absolute()
                                    .left_0()
                                    .h_full()
                                    .w(relative(percentage))
                                    .rounded_full()
                                    .bg(color),
                            )
                            .child(
                                SliderThumb::new(&self.state)
                                    .disabled(disabled)
                                    .absolute()
                                    .top(px(-5.))
                                    .left(relative(percentage))
                                    .ml(px(-8.))
                                    .size(px(16.))
                                    .rounded_full()
                                    .border_1()
                                    .border_color(color)
                                    .bg(thumb),
                            ),
                    ),
            )
    }
}
