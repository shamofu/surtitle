// SPDX-License-Identifier: GPL-3.0-or-later
//! Presentation around Kit's single interactive button. Only the decorative
//! surface scales; Kit continues to own focus, input, naming and activation.
use super::motion;
use gpui_kit::base::motion::{Interpolate, transition};
use gpui_kit::base::{Disableable, Selectable};
use gpui_kit::component::{
    ActiveTheme, Icon, Sizable, Size,
    button::{
        Button as KitButton, ButtonCustomVariant, ButtonRounded, ButtonVariant, ButtonVariants,
    },
};
use gpui_kit::{prelude::*, *};

#[derive(Default)]
struct Interaction {
    hovered: bool,
    pressed: bool,
    releasing: bool,
}

#[derive(Clone, Copy, PartialEq)]
struct SurfaceColor(Background);
impl Interpolate for SurfaceColor {
    fn interpolate(&self, target: &Self, progress: f32) -> Self {
        match (self.0.as_solid(), target.0.as_solid()) {
            (Some(from), Some(to)) => Self(from.interpolate(&to, progress).into()),
            // Pattern/gradient fills remain caller owned. They have no public
            // interpolation interface, so preserve their exact paint value.
            _ => {
                if progress < 0.5 {
                    *self
                } else {
                    *target
                }
            }
        }
    }
}

#[derive(IntoElement)]
pub(crate) struct Button {
    inner: KitButton,
    id: ElementId,
    variant: ButtonVariant,
    disabled: bool,
    loading: bool,
    selected: bool,
    open: bool,
    radius: Pixels,
    surface: Option<[Hsla; 3]>,
    motion_id: Option<ElementId>,
}
impl Button {
    pub fn new(id: impl Into<ElementId>) -> Self {
        let id = id.into();
        Self {
            inner: KitButton::new(id.clone()),
            id,
            variant: ButtonVariant::Default,
            disabled: false,
            loading: false,
            selected: false,
            open: false,
            radius: px(6.),
            surface: None,
            motion_id: None,
        }
    }
    pub fn label(mut self, value: impl Into<SharedString>) -> Self {
        self.inner = self.inner.label(value);
        self
    }
    pub fn accessibility_id(mut self, value: impl Into<SharedString>) -> Self {
        self.inner = self.inner.accessibility_id(value);
        self
    }
    pub fn accessibility_label(mut self, value: impl Into<SharedString>) -> Self {
        self.inner = self.inner.accessibility_label(value);
        self
    }
    pub fn icon(mut self, value: impl Into<Icon>) -> Self {
        self.inner = self.inner.icon(value.into());
        self
    }
    pub fn tooltip(mut self, value: impl Into<SharedString>) -> Self {
        self.inner = self.inner.tooltip(value);
        self
    }

    pub fn track_focus(mut self, value: &FocusHandle) -> Self {
        self.inner = self.inner.track_focus(value);
        self
    }
    pub fn toggled(mut self, value: bool) -> Self {
        self.inner = self.inner.toggled(value);
        self
    }
    pub fn role(mut self, value: impl Into<gpui_kit::base::RoleOverride>) -> Self {
        self.inner = self.inner.role(value);
        self
    }

    pub fn loading(mut self, value: bool) -> Self {
        self.loading = value;
        self.inner = self.inner.loading(value);
        self
    }

    pub fn rounded(mut self, value: impl Into<ButtonRounded>) -> Self {
        let value = value.into();
        self.radius = match value {
            ButtonRounded::None => px(0.),
            ButtonRounded::Small => px(3.),
            ButtonRounded::Large => px(12.),
            ButtonRounded::Size(value) => value,
            ButtonRounded::Medium => px(6.),
        };
        self.inner = self.inner.rounded(value);
        self
    }
    pub fn on_click(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.inner = self.inner.on_click(handler);
        self
    }
    /// Explicit colors for app-owned compound rows, whose custom Kit palette is opaque.
    pub fn surface_colors(mut self, normal: Hsla, hover: Hsla, active: Hsla) -> Self {
        self.surface = Some([normal, hover, active]);
        self
    }
    pub fn motion_identity(mut self, id: impl Into<ElementId>) -> Self {
        self.motion_id = Some(id.into());
        self
    }
}
impl Styled for Button {
    fn style(&mut self) -> &mut StyleRefinement {
        self.inner.style()
    }
}
impl InteractiveElement for Button {
    fn interactivity(&mut self) -> &mut Interactivity {
        self.inner.interactivity()
    }
}
impl ParentElement for Button {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.inner.extend(elements);
    }
}
impl Disableable for Button {
    fn disabled(mut self, value: bool) -> Self {
        self.disabled = value;
        self.inner = self.inner.disabled(value);
        self
    }
}
impl Selectable for Button {
    fn selected(mut self, value: bool) -> Self {
        self.selected = value;
        self.inner = self.inner.selected(value);
        self
    }
    fn is_selected(&self) -> bool {
        self.selected
    }
    fn open(mut self, value: bool) -> Self {
        self.open = value;
        self.inner = self.inner.open(value);
        self
    }
    fn is_open(&self) -> bool {
        self.open
    }
}
impl Sizable for Button {
    fn with_size(mut self, value: impl Into<Size>) -> Self {
        self.inner = self.inner.with_size(value);
        self
    }
}
impl ButtonVariants for Button {
    fn with_variant(mut self, value: ButtonVariant) -> Self {
        self.variant = value;
        self.inner = self.inner.with_variant(value);
        self
    }
}
impl gpui_kit::component::menu::DropdownMenu for Button {}

impl RenderOnce for Button {
    fn render(mut self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let motion_id = self.motion_id.as_ref().unwrap_or(&self.id).clone();
        let state = window.use_keyed_state((motion_id.clone(), "interaction"), cx, |_, _| {
            Interaction::default()
        });
        let inert = self.disabled || self.loading;
        if inert {
            state.update(cx, |state, _| {
                state.hovered = false;
                state.pressed = false;
            });
        }
        let hovered = state.read(cx).hovered;
        let pressed = state.read(cx).pressed;
        let duration = if pressed {
            motion::CONTROL_PRESS
        } else if state.read(cx).releasing {
            motion::CONTROL_RELEASE
        } else if hovered {
            motion::CONTROL_HOVER
        } else {
            motion::CONTROL_RELEASE
        };
        let scale = transition(
            (motion_id.clone(), "surface-scale"),
            if inert {
                1.
            } else if pressed {
                0.94
            } else if hovered {
                1.025
            } else {
                1.
            },
            motion::enter(duration),
            window,
            cx,
        );
        let theme = cx.theme().clone();
        let style = self.inner.style().clone();
        let explicit_background = style.background.as_ref().and_then(Fill::color);
        let (normal, hover, active, foreground, border) = match self.variant {
            ButtonVariant::Primary => (
                theme.button_primary,
                theme.button_primary_hover,
                theme.button_primary_active,
                theme.button_primary_foreground,
                theme.primary,
            ),
            ButtonVariant::Secondary => (
                theme.secondary,
                theme.secondary_hover,
                theme.secondary_active,
                theme.secondary_foreground,
                theme.border,
            ),
            ButtonVariant::Danger => (
                theme.button_danger,
                theme.button_danger_hover,
                theme.button_danger_active,
                theme.button_danger_foreground,
                theme.button_danger,
            ),
            ButtonVariant::Warning => (
                theme.button_warning,
                theme.button_warning_hover,
                theme.button_warning_active,
                theme.button_warning_foreground,
                theme.button_warning,
            ),
            ButtonVariant::Ghost | ButtonVariant::Text | ButtonVariant::Link => (
                theme.transparent,
                theme.accent,
                theme.accent,
                theme.foreground,
                theme.transparent,
            ),
            _ => (
                theme.button,
                theme.button_hover,
                theme.button_active,
                theme.button_foreground,
                theme.input,
            ),
        };
        let [normal, hover, active] = self.surface.unwrap_or([normal, hover, active]);
        let normal = explicit_background.unwrap_or_else(|| normal.into());
        let target = if self.disabled {
            normal.opacity(0.5)
        } else if self.selected || self.open {
            explicit_background.unwrap_or_else(|| active.into())
        } else if pressed {
            active.into()
        } else if hovered {
            hover.into()
        } else {
            normal
        };
        let background = transition(
            (motion_id, "surface-color"),
            SurfaceColor(target),
            motion::enter(motion::CONTROL_HOVER),
            window,
            cx,
        )
        .0;
        let border_color = style.border_color.unwrap_or(border);
        // The surface paints the original border while the layout widths remain
        // on the Kit root, preserving its exact content and focus geometry.
        let border_widths = style.border_widths.clone();
        self.inner.style().background = None;
        self.inner.style().border_color = Some(theme.transparent);
        let flat = ButtonCustomVariant::new(cx)
            .color(theme.transparent)
            .hover(theme.transparent)
            .active(theme.transparent)
            .foreground(foreground);
        let hover_state = state.clone();
        let press_state = state.clone();
        let release_state = state.clone();
        let outside_state = state.clone();
        let key_press_state = state.clone();
        let key_release_state = state.clone();
        let observer = (!inert).then(|| {
            div()
                .id(ElementId::NamedChild(
                    self.id.clone().into(),
                    "hover-observer".into(),
                ))
                .size_full()
                .on_hover(move |hovered, window, cx| {
                    hover_state.update(cx, |state, _| {
                        if state.hovered != *hovered {
                            state.releasing = false;
                        }
                        state.hovered = *hovered;
                    });
                    window.refresh();
                })
                .into_any_element()
        });
        if self.variant == ButtonVariant::Default {
            let widths = &mut self.inner.style().border_widths;
            widths.top.get_or_insert(px(1.).into());
            widths.right.get_or_insert(px(1.).into());
            widths.bottom.get_or_insert(px(1.).into());
            widths.left.get_or_insert(px(1.).into());
        }
        let child = self
            .inner
            .custom(flat)
            .disabled(inert)
            .relative()
            .bg(theme.transparent)
            .border_color(theme.transparent)
            .when(!inert, |this| {
                this.capture_any_mouse_down(move |event, window, cx| {
                    if event.button != MouseButton::Left {
                        return;
                    }
                    press_state.update(cx, |state, _| {
                        state.pressed = true;
                        state.releasing = false;
                    });
                    window.refresh();
                })
                .on_mouse_up(MouseButton::Left, move |_, window, cx| {
                    release_state.update(cx, |state, _| {
                        state.pressed = false;
                        state.releasing = true;
                    });
                    window.refresh();
                })
                .on_mouse_up_out(MouseButton::Left, move |_, window, cx| {
                    outside_state.update(cx, |state, _| {
                        state.pressed = false;
                        state.hovered = false;
                        state.releasing = true;
                    });
                    window.refresh();
                })
                .on_key_down(move |event, window, cx| {
                    if !event.is_held && matches!(event.keystroke.key.as_str(), "enter" | "space") {
                        key_press_state.update(cx, |state, _| {
                            state.pressed = true;
                            state.releasing = false;
                        });
                        window.refresh();
                    }
                })
                .on_key_up(move |event, window, cx| {
                    if matches!(event.keystroke.key.as_str(), "enter" | "space") {
                        key_release_state.update(cx, |state, _| {
                            state.pressed = false;
                            state.releasing = true;
                        });
                        window.refresh();
                    }
                })
            })
            .into_any_element();
        Surface {
            child,
            observer,
            scale,
            background: background.opacity(style.opacity.unwrap_or(1.)),
            border: border_color.opacity(style.opacity.unwrap_or(1.)),
            radius: self.radius,
            border_widths,
            default_border: self.variant == ButtonVariant::Default,
            hidden: style.visibility == Some(Visibility::Hidden),
        }
    }
}

/// Layout-transparent decoration: it delegates the child's layout and prepaint,
/// and therefore never moves its hitbox or accessible bounds.
struct Surface {
    child: AnyElement,
    observer: Option<AnyElement>,
    scale: f32,
    background: Background,
    border: Hsla,
    radius: Pixels,
    border_widths: gpui_kit::EdgesRefinement<gpui_kit::AbsoluteLength>,
    default_border: bool,
    hidden: bool,
}
impl IntoElement for Surface {
    type Element = Self;
    fn into_element(self) -> Self {
        self
    }
}
impl Element for Surface {
    type RequestLayoutState = ();
    type PrepaintState = ();
    fn id(&self) -> Option<ElementId> {
        None
    }
    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }
    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        (self.child.request_layout(window, cx), ())
    }
    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        if let Some(observer) = self.observer.take() {
            let mut observer = div()
                .w(bounds.size.width)
                .h(bounds.size.height)
                .child(observer)
                .into_any_element();
            observer.layout_as_root(
                size(
                    AvailableSpace::Definite(bounds.size.width),
                    AvailableSpace::Definite(bounds.size.height),
                ),
                window,
                cx,
            );
            observer.prepaint_at(bounds.origin, window, cx);
            self.observer = Some(observer);
        }
        self.child.prepaint(window, cx);
    }
    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        if self.hidden {
            return;
        }
        if let Some(observer) = &mut self.observer {
            observer.paint(window, cx);
        }
        let size = size(
            bounds.size.width * self.scale,
            bounds.size.height * self.scale,
        );
        let decoration = Bounds::new(
            bounds.center() - point(size.width * 0.5, size.height * 0.5),
            size,
        );
        let rem_size = window.rem_size();
        let edge = |value: Option<AbsoluteLength>| match value {
            Some(value) => value.to_pixels(rem_size),
            _ => {
                if self.default_border {
                    px(1.)
                } else {
                    px(0.)
                }
            }
        };
        window.paint_quad(
            fill(decoration, self.background)
                .corner_radii(self.radius)
                .border_widths(Edges {
                    top: edge(self.border_widths.top),
                    right: edge(self.border_widths.right),
                    bottom: edge(self.border_widths.bottom),
                    left: edge(self.border_widths.left),
                })
                .border_color(self.border),
        );
        self.child.paint(window, cx);
    }
}

/// Determinate decoration only: callers keep semantic values and live labels direct.
pub(crate) fn progress(
    id: impl Into<ElementId>,
    value: f32,
    window: &mut Window,
    cx: &mut App,
) -> f32 {
    transition(
        (id.into(), "progress-fill"),
        value.clamp(0., 1.),
        motion::enter(motion::PROGRESS),
        window,
        cx,
    )
}

/// Reveal opaque content inside its current scroll viewport without changing
/// intrinsic layout or scroll extent. Current semantics remain independently
/// controlled by the caller, even while the visual mask is still empty.
pub(crate) fn reveal_vertical(child: impl IntoElement, progress: f32) -> impl IntoElement {
    VerticalReveal {
        child: child.into_any_element(),
        progress: progress.clamp(0., 1.),
    }
}

struct VerticalReveal {
    child: AnyElement,
    progress: f32,
}
impl IntoElement for VerticalReveal {
    type Element = Self;
    fn into_element(self) -> Self {
        self
    }
}
impl Element for VerticalReveal {
    type RequestLayoutState = ();
    type PrepaintState = ();
    fn id(&self) -> Option<ElementId> {
        None
    }
    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }
    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        (self.child.request_layout(window, cx), ())
    }
    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        self.child.prepaint(window, cx);
    }
    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        // A long answer can be thousands of pixels tall. Expand over the
        // visible viewport, including after scrolling, rather than that full
        // intrinsic height; otherwise it would appear almost immediately.
        let visible = bounds.intersect(&window.content_mask().bounds);
        let mask = ContentMask {
            bounds: Bounds::from_corners(
                visible.origin,
                point(
                    visible.right(),
                    visible.top() + visible.size.height * self.progress,
                ),
            ),
        };
        window.with_content_mask(Some(mask), |window| self.child.paint(window, cx));
    }
}

/// Opaque complementary masks share exactly one edge: outgoing text never
/// crossfades over incoming text, and there is no empty middle frame.
pub(crate) fn wipe(
    current: AnyElement,
    outgoing: Option<AnyElement>,
    progress: f32,
) -> impl IntoElement {
    Wipe {
        current: super::motion::interactive(current, true).into_any_element(),
        outgoing: outgoing.map(|child| super::motion::interactive(child, false).into_any_element()),
        progress,
    }
}
struct Wipe {
    current: AnyElement,
    outgoing: Option<AnyElement>,
    progress: f32,
}
impl IntoElement for Wipe {
    type Element = Self;
    fn into_element(self) -> Self {
        self
    }
}
impl Element for Wipe {
    type RequestLayoutState = ();
    type PrepaintState = ();
    fn id(&self) -> Option<ElementId> {
        None
    }
    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }
    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        (self.current.request_layout(window, cx), ())
    }
    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        if let Some(outgoing) = self.outgoing.take() {
            let mut outgoing = div()
                .w(bounds.size.width)
                .h(bounds.size.height)
                .flex()
                .flex_col()
                .child(outgoing)
                .into_any_element();
            outgoing.layout_as_root(
                size(
                    AvailableSpace::Definite(bounds.size.width),
                    AvailableSpace::Definite(bounds.size.height),
                ),
                window,
                cx,
            );
            outgoing.prepaint_at(bounds.origin, window, cx);
            self.outgoing = Some(outgoing);
        }
        // Current semantics/focus become active on the very first frame, even
        // while the wipe edge is still at the beginning of the visual region.
        self.current.prepaint(window, cx);
    }
    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        let edge = bounds.left() + bounds.size.width * self.progress;
        if let Some(outgoing) = &mut self.outgoing {
            let mask = ContentMask {
                bounds: Bounds::from_corners(point(edge, bounds.top()), bounds.bottom_right()),
            };
            window.with_content_mask(Some(mask), |window| outgoing.paint(window, cx));
        }
        let mask = ContentMask {
            bounds: Bounds::from_corners(bounds.origin, point(edge, bounds.bottom())),
        };
        window.with_content_mask(Some(mask), |window| self.current.paint(window, cx));
    }
}
