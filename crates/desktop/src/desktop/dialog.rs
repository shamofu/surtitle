// SPDX-License-Identifier: GPL-3.0-or-later
//! Placement for owned GPUI dialogs, using the owner's current monitor.
use gpui_kit::component::{WindowExt, input::AnyInputState};
use gpui_kit::{
    App, Bounds, DevicePixels, DisplayId, EntityInputHandler, Pixels, Size, WindowBounds,
    WindowKind, WindowOptions, point, prelude::*, size,
};

type DisplayArea = (DisplayId, Bounds<Pixels>);
mod host;
mod motion;
pub(crate) use host::{activate, close_then, install, on_closed, request_close, set_close_guard};

struct DialogContent<V: gpui_kit::Render> {
    view: gpui_kit::Entity<V>,
    focus: gpui_kit::FocusHandle,
    escape_blocked: bool,
}
fn escape_belongs_to_child(window: &mut gpui_kit::Window, cx: &mut App) -> bool {
    if gpui_kit::base::active_focus_trap(window, cx).is_some()
        || window.has_active_dialog(cx)
        || window.has_active_sheet(cx)
    {
        return true;
    }
    match window.focused_input(cx) {
        Some(AnyInputState::Input(input)) => input.update(cx, |input, cx| {
            input.marked_text_range(window, cx).is_some()
        }),
        Some(AnyInputState::Textarea(input)) => input.update(cx, |input, cx| {
            input.marked_text_range(window, cx).is_some()
        }),
        Some(AnyInputState::Editor(input)) => input.update(cx, |input, cx| {
            input.marked_text_range(window, cx).is_some()
        }),
        Some(AnyInputState::Otp(_)) | None => false,
    }
}
impl<V: gpui_kit::Render> gpui_kit::Render for DialogContent<V> {
    fn render(
        &mut self,
        window: &mut gpui_kit::Window,
        cx: &mut gpui_kit::Context<Self>,
    ) -> impl gpui_kit::IntoElement {
        let enabled = host::interactive(window, cx);
        gpui_kit::div()
            .id("owned-dialog-content")
            .size_full()
            .track_focus(&self.focus)
            .capture_key_down(
                cx.listener(|this, event: &gpui_kit::KeyDownEvent, window, cx| {
                    // Snapshot composition/popup ownership before a child consumes
                    // Escape and removes its marked range or closes its surface.
                    if event.keystroke.key == "escape" {
                        this.escape_blocked |=
                            event.prefer_character_input || escape_belongs_to_child(window, cx);
                    } else {
                        this.escape_blocked = false;
                    }
                }),
            )
            .capture_action(
                cx.listener(|this, _: &gpui_kit::base::input::Escape, window, cx| {
                    // Input Escape can unmark composition and propagate before
                    // GPUI retries the keystroke as a plain KeyDown event.
                    this.escape_blocked |= escape_belongs_to_child(window, cx);
                }),
            )
            .capture_key_up(cx.listener(|this, event: &gpui_kit::KeyUpEvent, _, _| {
                if event.keystroke.key == "escape" {
                    this.escape_blocked = false;
                }
            }))
            .on_key_down(
                cx.listener(|this, event: &gpui_kit::KeyDownEvent, window, cx| {
                    if event.keystroke.key == "escape"
                        && !event.is_held
                        && !event.prefer_character_input
                        && event.keystroke.modifiers == Default::default()
                        && !this.escape_blocked
                        && host::interactive(window, cx)
                    {
                        cx.stop_propagation();
                        request_close(window, cx);
                    }
                }),
            )
            .child(crate::ui::motion::interactive(self.view.clone(), enabled))
    }
}

/// Open an owned dialog with the first-present barrier and default close host.
/// The constructor may install its guard with `set_close_guard`.
pub(crate) fn open_window<V: gpui_kit::Render>(
    mut options: WindowOptions,
    cx: &mut App,
    build: impl FnOnce(&mut gpui_kit::Window, &mut App) -> gpui_kit::Entity<V>,
) -> anyhow::Result<(gpui_kit::AnyWindowHandle, gpui_kit::Entity<V>)> {
    #[cfg(windows)]
    {
        options.show = false;
        options.focus = false;
    }
    let mut setup_error = None;
    let mut built = None;
    let result = gpui_kit::open_window(options, cx, |window, cx| {
        if let Err(error) = install(window, cx, |_, _| true) {
            setup_error = Some(error);
        }
        let view = build(window, cx);
        built = Some(view.clone());
        // GPUI drops its root before the Windows backend asynchronously destroys
        // the HWND. Keep entity release/autosave tied to native destruction.
        let retained = view.clone();
        on_closed(window, cx, move |_| drop(retained));
        gpui_kit::AppContext::new(cx, |cx| {
            let focus = cx.focus_handle().tab_stop(false);
            if window.focused(cx).is_none() {
                focus.focus(window, cx);
            }
            DialogContent {
                view,
                focus,
                escape_blocked: false,
            }
        })
    })?;
    if let Some(error) = setup_error {
        let _ = result.0.update(cx, |_, window, _| window.remove_window());
        return Err(error);
    }
    Ok((result.0, built.expect("dialog build ran")))
}

#[derive(Clone, Copy)]
struct Frame {
    scale: f32,
    width: i32,
    height: i32,
}

impl Default for Frame {
    fn default() -> Self {
        Self {
            scale: 1.,
            width: 0,
            height: 0,
        }
    }
}

pub(crate) fn options(
    requested: Size<Pixels>,
    minimum: Option<Size<Pixels>>,
    cx: &App,
) -> WindowOptions {
    let owner = owner_display(cx);
    let primary = cx
        .primary_display()
        .map(|display| (display.id(), display.visible_bounds()));
    let frame = owner
        .or(primary)
        .and_then(|(id, _)| native_frame(id))
        .unwrap_or_default();
    centered_options(requested, minimum, frame, owner, primary)
}

#[cfg(windows)]
fn owner_display(cx: &App) -> Option<DisplayArea> {
    use windows_sys::Win32::{
        Graphics::Gdi::{MONITOR_DEFAULTTONEAREST, MonitorFromWindow},
        UI::Input::KeyboardAndMouse::GetActiveWindow,
    };
    // The Windows GPUI backend uses this same GUI-thread active HWND as the
    // dialog owner. Reading it directly also works while the parent is borrowed
    // by a GPUI callback, when App::active_window().update() cannot reenter it.
    let owner = unsafe { GetActiveWindow() };
    if owner.is_null() {
        return None;
    }
    let monitor = unsafe { MonitorFromWindow(owner, MONITOR_DEFAULTTONEAREST) };
    if monitor.is_null() {
        return None;
    }
    // GPUI WindowsDisplay identifies a display by its HMONITOR value.
    cx.find_display(DisplayId::new(monitor as usize as u64))
        .map(|display| (display.id(), display.visible_bounds()))
}

#[cfg(not(windows))]
fn owner_display(_cx: &App) -> Option<DisplayArea> {
    None
}

#[cfg(windows)]
fn native_frame(display: DisplayId) -> Option<Frame> {
    use windows_sys::Win32::{
        Foundation::RECT,
        Graphics::Gdi::HMONITOR,
        UI::{
            HiDpi::{AdjustWindowRectExForDpi, GetDpiForMonitor, MDT_EFFECTIVE_DPI},
            WindowsAndMessaging::{
                USER_DEFAULT_SCREEN_DPI, WS_CAPTION, WS_EX_DLGMODALFRAME, WS_MAXIMIZEBOX,
                WS_MINIMIZEBOX, WS_POPUP, WS_SYSMENU, WS_THICKFRAME,
            },
        },
    };
    let monitor = u64::from(display) as usize as HMONITOR;
    let mut dpi = 0;
    let mut dpi_y = 0;
    if unsafe { GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut dpi, &mut dpi_y) } < 0 || dpi == 0
    {
        // A non-native GPUI platform has no Windows monitor or native frame.
        return None;
    }
    // Match GPUI's resizable/minimizable Dialog with a standard native caption.
    // All callers retain those options; custom titlebars need different metrics.
    let style =
        WS_POPUP | WS_CAPTION | WS_SYSMENU | WS_THICKFRAME | WS_MAXIMIZEBOX | WS_MINIMIZEBOX;
    let mut rect = RECT::default();
    if unsafe { AdjustWindowRectExForDpi(&mut rect, style, 0, WS_EX_DLGMODALFRAME, dpi) } == 0 {
        return None;
    }
    Some(Frame {
        scale: dpi as f32 / USER_DEFAULT_SCREEN_DPI as f32,
        width: rect.right - rect.left,
        height: rect.bottom - rect.top,
    })
}

#[cfg(not(windows))]
fn native_frame(_display: DisplayId) -> Option<Frame> {
    None
}

fn centered_options(
    requested: Size<Pixels>,
    minimum: Option<Size<Pixels>>,
    frame: Frame,
    owner: Option<DisplayArea>,
    primary: Option<DisplayArea>,
) -> WindowOptions {
    let display = owner.or(primary);
    let (bounds, minimum) = display
        .map(|(_, area)| {
            // GPUI expands its requested bounds by the physical native frame.
            // Reserve that frame before fitting either client size or minimum,
            // and stay on the physical pixel grid to avoid fractional-DPI overflow.
            let area = area.to_device_pixels(frame.scale);
            let available = size(
                DevicePixels((area.size.width.0 - frame.width).max(1)),
                DevicePixels((area.size.height.0 - frame.height).max(1)),
            );
            let minimum = minimum.map(|value| value.to_device_pixels(frame.scale).min(&available));
            let requested = requested.to_device_pixels(frame.scale);
            let client = minimum
                .map_or(requested, |minimum| requested.max(&minimum))
                .min(&available);
            // GPUI splits frame totals equally around these bounds (the trailing
            // side receives an odd extra pixel), rather than using the native
            // caption's asymmetric top/bottom offsets.
            let origin = point(
                DevicePixels(
                    area.left().0
                        + (area.size.width.0 - client.width.0 - frame.width) / 2
                        + frame.width / 2,
                ),
                DevicePixels(
                    area.top().0
                        + (area.size.height.0 - client.height.0 - frame.height) / 2
                        + frame.height / 2,
                ),
            );
            (
                Bounds::new(origin, client).to_pixels(frame.scale),
                minimum.map(|value| value.to_pixels(frame.scale)),
            )
        })
        .unwrap_or_else(|| {
            (
                Bounds::new(
                    Default::default(),
                    minimum.map_or(requested, |minimum| requested.max(&minimum)),
                ),
                minimum,
            )
        });
    WindowOptions {
        kind: WindowKind::Dialog,
        display_id: display.map(|(id, _)| id),
        window_bounds: Some(WindowBounds::Windowed(bounds)),
        window_min_size: minimum,
        ..Default::default()
    }
}

#[cfg(test)]
mod keyboard_tests {
    use super::*;
    use gpui_kit::{
        AppContext, Context, Entity, Focusable, IntoElement, Render, TestAppContext,
        component::input::{Textarea, TextareaState},
        test::{TestInput, TestQueryExt, TestWindowExt},
    };
    use std::{cell::Cell, rc::Rc};

    struct Editing {
        input: Entity<TextareaState>,
    }
    impl Render for Editing {
        fn render(&mut self, _: &mut gpui_kit::Window, _: &mut Context<Self>) -> impl IntoElement {
            gpui_kit::div()
                .size_full()
                .child(Textarea::new(&self.input).aria_label("Owned input"))
        }
    }
    #[gpui_kit::test]
    fn common_escape_keeps_builder_focus_and_ime_then_saves_accepted_close_once(
        cx: &mut TestAppContext,
    ) {
        cx.update(|app| {
            gpui_kit::init(app);
            crate::ui::style::init(app);
            app.set_reduce_motion(false);
        });
        let attempts = Rc::new(Cell::new(0));
        let saves = Rc::new(Cell::new(0));
        let closed = Rc::new(Cell::new(0));
        let busy = Rc::new(Cell::new(true));
        let (dialog, editing) = cx.update(|app| {
            open_window(WindowOptions::default(), app, |window, app| {
                let attempts = attempts.clone();
                let saves = saves.clone();
                let busy = busy.clone();
                set_close_guard(window, app, move |_, _| {
                    attempts.set(attempts.get() + 1);
                    if busy.get() {
                        false
                    } else {
                        saves.set(saves.get() + 1);
                        true
                    }
                });
                let closed = closed.clone();
                on_closed(window, app, move |_| closed.set(closed.get() + 1));
                let input = app.new(|cx| TextareaState::new(window, cx));
                input.focus_handle(app).focus(window, app);
                app.new(|_| Editing { input })
            })
            .unwrap()
        });
        dialog
            .update(cx, |_, window, app| {
                window.render_frame(app);
                let field = window.find_by_label("Owned input");
                assert_eq!(
                    field.focused(),
                    Some(true),
                    "common fallback must preserve builder-owned input focus"
                );
                let input = editing.read(app).input.clone();
                TestInput::new(
                    gpui_kit::ElementInputHandler::new(field.bounds(), input),
                    window,
                )
                .compose_text(None, "にほん", Some(0..3), app);
                window.press("escape", app);
            })
            .unwrap();
        cx.run_until_parked();
        assert_eq!(
            attempts.get(),
            0,
            "composition owns its Escape even if the input unmarks before bubbling"
        );
        dialog
            .update(cx, |_, window, app| window.press("escape", app))
            .unwrap();
        cx.run_until_parked();
        assert_eq!(attempts.get(), 1);
        assert_eq!(saves.get(), 0, "refusal must not save or remove the window");
        assert!(dialog.update(cx, |_, _, _| ()).is_ok());
        busy.set(false);
        dialog
            .update(cx, |_, window, app| {
                window.press("escape", app);
                window.press("escape", app);
            })
            .unwrap();
        cx.run_until_parked();
        assert_eq!(attempts.get(), 2);
        assert_eq!(saves.get(), 1);
        cx.executor().advance_clock(crate::ui::motion::EXIT);
        let _ = dialog.update(cx, |_, window, app| window.render_frame(app));
        cx.run_until_parked();
        assert_eq!(closed.get(), 1);
        assert!(dialog.update(cx, |_, _, _| ()).is_err());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui_kit::{point, px, size};

    fn area(id: u64, x: f32, y: f32, width: f32, height: f32) -> DisplayArea {
        (
            DisplayId::new(id),
            Bounds::new(point(px(x), px(y)), size(px(width), px(height))),
        )
    }

    fn bounds(options: &WindowOptions) -> Bounds<Pixels> {
        match options.window_bounds.unwrap() {
            WindowBounds::Windowed(bounds) => bounds,
            other => panic!("dialog must be windowed: {other:?}"),
        }
    }

    #[test]
    fn dialog_follows_current_owner_to_a_negative_origin_monitor() {
        let primary = area(1, 0., 0., 2560., 1392.);
        let secondary = area(2, -1920., 0., 1920., 1032.);
        let requested = size(px(640.), px(460.));
        let options = centered_options(
            requested,
            None,
            Frame::default(),
            Some(secondary),
            Some(primary),
        );
        assert_eq!(options.display_id, Some(secondary.0));
        assert_eq!(
            bounds(&options),
            Bounds::new(point(px(-1280.), px(286.)), requested)
        );
        assert_eq!(options.kind, WindowKind::Dialog);
        assert!(options.focus);
        assert!(options.show);

        let returned = centered_options(
            requested,
            None,
            Frame::default(),
            Some(primary),
            Some(primary),
        );
        assert_eq!(returned.display_id, Some(primary.0));
        assert_eq!(bounds(&returned).origin, point(px(960.), px(466.)));
    }

    #[test]
    fn dialog_uses_work_area_and_preserves_logical_coordinates_at_fractional_dpi() {
        // A 1920x1080 monitor to the left and above the primary at 150% DPI,
        // with a 48 physical-pixel taskbar on its top edge.
        let owner = area(2, -1280., -688., 1280., 688.);
        let options = centered_options(
            size(px(640.), px(460.)),
            None,
            Frame::default(),
            Some(owner),
            None,
        );
        assert_eq!(options.display_id, Some(owner.0));
        assert_eq!(bounds(&options).origin, point(px(-960.), px(-574.)));
        assert_eq!(bounds(&options).size, size(px(640.), px(460.)));
    }

    #[test]
    fn oversized_dialog_is_capped_to_its_owners_work_area() {
        let owner = area(2, 100., -900., 600., 420.);
        let options = centered_options(
            size(px(1000.), px(760.)),
            None,
            Frame::default(),
            Some(owner),
            None,
        );
        assert_eq!(bounds(&options), owner.1);
    }

    fn assert_outer_inside(options: &WindowOptions, area: Bounds<Pixels>, frame: Frame) {
        let client = bounds(options).to_device_pixels(frame.scale);
        let work = area.to_device_pixels(frame.scale);
        // Match GPUI's physical client-to-outer expansion, including odd totals.
        assert!(client.left().0 - frame.width / 2 >= work.left().0);
        assert!(client.top().0 - frame.height / 2 >= work.top().0);
        assert!(client.right().0 + frame.width - frame.width / 2 <= work.right().0);
        assert!(client.bottom().0 + frame.height - frame.height / 2 <= work.bottom().0);
    }

    #[test]
    fn oversized_dialog_reserves_frame_and_caps_its_minimum() {
        let owner = area(2, -600., 40., 600., 420.);
        let frame = Frame {
            scale: 1.,
            width: 16,
            height: 39,
        };
        let options = centered_options(
            size(px(1000.), px(760.)),
            Some(size(px(720.), px(480.))),
            frame,
            Some(owner),
            None,
        );
        assert_outer_inside(&options, owner.1, frame);
        assert_eq!(bounds(&options).size, size(px(584.), px(381.)));
        assert_eq!(options.window_min_size, Some(size(px(584.), px(381.))));
    }

    #[test]
    fn fractional_dpi_and_odd_frame_totals_stay_inside_physical_work_area() {
        let owner = area(2, -1280., -688., 1280., 688.);
        for scale in [1.25, 1.5, 1.75] {
            let frame = Frame {
                scale,
                width: 25,
                height: 59,
            };
            let options = centered_options(
                size(px(2000.), px(2000.)),
                Some(size(px(1440.), px(900.))),
                frame,
                Some(owner),
                None,
            );
            assert_outer_inside(&options, owner.1, frame);
            assert_eq!(options.window_min_size, Some(bounds(&options).size));
        }
    }

    #[test]
    fn frame_reservation_preserves_normal_client_dimensions_and_minimum() {
        let owner = area(2, -1920., 0., 1920., 1032.);
        let frame = Frame {
            scale: 1.,
            width: 16,
            height: 39,
        };
        let requested = size(px(840.), px(700.));
        let minimum = Some(size(px(600.), px(420.)));
        let options = centered_options(requested, minimum, frame, Some(owner), None);
        assert_outer_inside(&options, owner.1, frame);
        assert_eq!(bounds(&options).size, requested);
        assert_eq!(options.window_min_size, minimum);
    }

    #[test]
    fn initial_client_size_respects_a_larger_minimum_that_fits() {
        let owner = area(2, 0., 0., 1920., 1032.);
        let frame = Frame {
            scale: 1.,
            width: 16,
            height: 39,
        };
        let minimum = size(px(720.), px(480.));
        let options = centered_options(
            size(px(300.), px(200.)),
            Some(minimum),
            frame,
            Some(owner),
            None,
        );
        assert_eq!(bounds(&options).size, minimum);
        assert_outer_inside(&options, owner.1, frame);
    }

    #[test]
    fn dialog_without_owner_uses_primary_or_requested_size_without_a_display() {
        let primary = area(1, 0., 24., 2560., 1368.);
        let requested = size(px(640.), px(460.));
        let options = centered_options(requested, None, Frame::default(), None, Some(primary));
        assert_eq!(options.display_id, Some(primary.0));
        assert_eq!(bounds(&options).origin, point(px(960.), px(478.)));
        let no_display = centered_options(requested, None, Frame::default(), None, None);
        assert_eq!(no_display.display_id, None);
        assert_eq!(
            bounds(&no_display),
            Bounds::new(point(px(0.), px(0.)), requested)
        );
    }
}
