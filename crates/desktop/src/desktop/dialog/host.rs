// SPDX-License-Identifier: GPL-3.0-or-later
//! Lifecycle host. A single close callback owns both caller guards and motion.
use super::motion::{Motion, Phase};
use gpui_kit::{App, Global, Subscription, Window, WindowId};
use std::{cell::RefCell, collections::HashMap, rc::Rc, time::Instant};

type Guard = Box<dyn FnMut(&mut Window, &mut App) -> bool>;
type AfterClose = Box<dyn FnOnce(&mut App)>;
#[derive(Default)]
struct Hosts(HashMap<WindowId, Rc<RefCell<Host>>>);
impl Global for Hosts {}
struct Host {
    clock: Instant,
    motion: Motion,
    guard: Option<Guard>,
    after_close: Option<AfterClose>,
    closed_callbacks: Vec<AfterClose>,
    scheduled: bool,
    pending_close: bool,
    request_serial: u64,
    closed_subscription: Option<Subscription>,
    #[cfg(windows)]
    surface: Option<gpui_windows::DialogSurface>,
    #[cfg(windows)]
    geometry: Option<gpui_windows::DialogGeometry>,
}
fn host(window: &Window, cx: &App) -> Option<Rc<RefCell<Host>>> {
    cx.try_global::<Hosts>()?
        .0
        .get(&window.window_handle().window_id())
        .cloned()
}
pub(super) fn interactive(window: &Window, cx: &App) -> bool {
    host(window, cx).is_none_or(|shared| {
        !matches!(shared.borrow().motion.phase, Phase::Exiting | Phase::Closed)
    })
}

pub(crate) fn set_close_guard(
    window: &Window,
    cx: &App,
    guard: impl FnMut(&mut Window, &mut App) -> bool + 'static,
) {
    if let Some(shared) = host(window, cx) {
        shared.borrow_mut().guard = Some(Box::new(guard));
    }
}
pub(crate) fn on_closed(window: &Window, cx: &App, callback: impl FnOnce(&mut App) + 'static) {
    if let Some(shared) = host(window, cx) {
        shared
            .borrow_mut()
            .closed_callbacks
            .push(Box::new(callback));
    }
}

/// Install exactly once during construction. `guard` performs existing refusal
/// checks and accepted-close preparation; it is called once per accepted exit.
/// Use `open_window` (which starts Windows dialogs hidden). Render failures keep it hidden and
/// are returned asynchronously to `on_error`; synchronous setup errors return.
pub(crate) fn install(
    window: &mut Window,
    cx: &mut App,
    guard: impl FnMut(&mut Window, &mut App) -> bool + 'static,
) -> anyhow::Result<()> {
    install_with_error(window, cx, guard, |error, _| {
        eprintln!("dialog presentation failed: {error:#}")
    })
}
pub(crate) fn install_with_error(
    window: &mut Window,
    cx: &mut App,
    guard: impl FnMut(&mut Window, &mut App) -> bool + 'static,
    on_error: impl FnOnce(anyhow::Error, &mut App) + 'static,
) -> anyhow::Result<()> {
    anyhow::ensure!(host(window, cx).is_none(), "dialog host already installed");
    #[cfg(windows)]
    let surface = {
        use raw_window_handle::HasWindowHandle;
        match HasWindowHandle::window_handle(window).map(|handle| handle.as_raw()) {
            Ok(raw_window_handle::RawWindowHandle::Win32(handle)) => {
                // The handle is borrowed directly from this live GPUI Window
                // on its GUI thread; only the weak generation is retained.
                Some(unsafe { gpui_windows::prepare_hidden_dialog(handle.hwnd.get())? })
            }
            _ => None, // GPUI TestPlatform has no native surface.
        }
    };
    #[cfg(windows)]
    let geometry = surface
        .as_ref()
        .map(|surface| -> anyhow::Result<_> {
            let geometry = surface.geometry()?;
            let (x, y, displaced) = super::motion::fit_path(
                (geometry.x, geometry.y),
                (geometry.width, geometry.height),
                (
                    geometry.work_left,
                    geometry.work_top,
                    geometry.work_right,
                    geometry.work_bottom,
                ),
                geometry.dpi,
                cx.reduce_motion(),
            );
            surface.move_to(x, displaced)?;
            Ok((surface.geometry()?, y, displaced))
        })
        .transpose()?;
    #[cfg(windows)]
    if surface.is_some() {
        window.bounds_changed(cx);
    }
    #[cfg(windows)]
    let (rest, displaced) = geometry
        .map(|(_, y, displaced)| (y as f64, displaced as f64))
        .unwrap_or((0., crate::ui::motion::DIALOG_OFFSET));
    #[cfg(not(windows))]
    let (rest, displaced) = (0., crate::ui::motion::DIALOG_OFFSET);
    let shared = Rc::new(RefCell::new(Host {
        clock: cx.background_executor().now(),
        motion: Motion::new(rest, displaced),
        guard: Some(Box::new(guard)),
        after_close: None,
        closed_callbacks: Vec::new(),
        scheduled: false,
        pending_close: false,
        request_serial: 0,
        closed_subscription: None,
        #[cfg(windows)]
        surface: surface.clone(),
        #[cfg(windows)]
        geometry: geometry.map(|(geometry, _, _)| geometry),
    }));
    let id = window.window_handle().window_id();
    if cx.try_global::<Hosts>().is_none() {
        cx.set_global(Hosts::default());
    }
    cx.global_mut::<Hosts>().0.insert(id, shared.clone());
    window.on_window_should_close(cx, |window, cx| {
        request_close(window, cx);
        false
    });
    #[cfg(windows)]
    if let Some(surface) = surface {
        let (destroy_send, destroy_recv) = tokio::sync::oneshot::channel();
        surface.on_destroyed(move || {
            let _ = destroy_send.send(());
        })?;
        let closing = shared.clone();
        cx.spawn(async move |cx| {
            if destroy_recv.await.is_ok() {
                cx.update(|cx| destroyed(id, &closing, cx));
            }
        })
        .detach();
        let (send, recv) = tokio::sync::oneshot::channel();
        surface.reveal_after_present(move |result| {
            let _ = send.send(result);
        })?;
        let handle = window.window_handle();
        cx.spawn(async move |cx| {
            if let Ok(result) = recv.await {
                let _ = handle.update(cx, |_, window, cx| match result {
                    Ok(revealed) => {
                        let mut state = shared.borrow_mut();
                        let now = revealed.duration_since(state.clock).as_secs_f64();
                        state.motion.reveal(now);
                        // Showing can synchronously issue WM_SIZE/WM_MOVE. The
                        // first post-reveal geometry is the trajectory baseline.
                        state.geometry = state
                            .surface
                            .as_ref()
                            .and_then(|surface| surface.geometry().ok());
                        drop(state);
                        frame(shared, window, cx);
                    }
                    Err(error) => {
                        on_error(error, cx);
                        window.remove_window();
                    }
                });
            }
        })
        .detach();
        return Ok(());
    }
    let _ = on_error;
    let weak = Rc::downgrade(&shared);
    shared.borrow_mut().closed_subscription = Some(cx.on_window_closed(move |cx, closed_id| {
        if closed_id == id
            && let Some(shared) = weak.upgrade()
        {
            destroyed(id, &shared, cx);
        }
    }));
    window.defer(cx, move |window, cx| {
        let mut state = shared.borrow_mut();
        let now = cx
            .background_executor()
            .now()
            .duration_since(state.clock)
            .as_secs_f64();
        state.motion.reveal(now);
        drop(state);
        frame(shared, window, cx);
    });
    Ok(())
}

/// Returns whether a request was queued (false for duplicate/closed requests).
/// Guard evaluation is deferred out of the caller's entity borrow. Refused
/// continuations are discarded, never retained for an unrelated later close.
pub(crate) fn close_then(
    window: &mut Window,
    cx: &mut App,
    after: impl FnOnce(&mut App) + 'static,
) -> bool {
    queue_close(window, cx, Some(Box::new(after)))
}
pub(crate) fn request_close(window: &mut Window, cx: &mut App) -> bool {
    queue_close(window, cx, None)
}
fn queue_close(window: &mut Window, cx: &mut App, after: Option<AfterClose>) -> bool {
    let Some(shared) = host(window, cx) else {
        return false;
    };
    let mut state = shared.borrow_mut();
    if state.pending_close || matches!(state.motion.phase, Phase::Exiting | Phase::Closed) {
        return false;
    }
    state.pending_close = true;
    state.request_serial = state.request_serial.wrapping_add(1);
    let serial = state.request_serial;
    drop(state);
    window.defer(cx, move |window, cx| {
        let mut state = shared.borrow_mut();
        if state.request_serial != serial || !state.pending_close {
            return;
        }
        state.pending_close = false;
        drop(state);
        close(window, cx, after);
    });
    true
}
fn close(window: &mut Window, cx: &mut App, after: Option<AfterClose>) -> bool {
    let Some(shared) = host(window, cx) else {
        return false;
    };
    let mut state = shared.borrow_mut();
    if matches!(state.motion.phase, Phase::Exiting | Phase::Closed) {
        return false;
    }
    let Some(mut guard) = state.guard.take() else {
        return false;
    };
    drop(state);
    let accepted = guard(window, cx);
    let mut state = shared.borrow_mut();
    state.guard = Some(guard);
    if !accepted {
        return false;
    }
    if state.motion.phase == Phase::Preparing {
        // Never animate or expose a window closed before its first submission.
        state.motion.phase = Phase::Closed;
        state.after_close = after;
        #[cfg(windows)]
        if let Some(surface) = &state.surface {
            surface.cancel_reveal();
        }
        drop(state);
        window.remove_window();
        return true;
    }
    let now = cx
        .background_executor()
        .now()
        .duration_since(state.clock)
        .as_secs_f64();
    #[cfg(windows)]
    if state.motion.phase == Phase::Open
        && let Some(surface) = &state.surface
        && let Ok(current) = surface.geometry()
    {
        // New exits follow the user's idle move/resize, not an old origin.
        let (_, _, displaced) = super::motion::fit_path(
            (current.x, current.y),
            (current.width, current.height),
            (
                current.work_left,
                current.work_top,
                current.work_right,
                current.work_bottom,
            ),
            current.dpi,
            cx.reduce_motion() || current.suspended,
        );
        state.motion.rest = current.y as f64;
        state.motion.displaced = displaced as f64;
        state.geometry = Some(current);
    }
    let actual = actual_y(&state, now);
    state.motion.close(now, actual);
    state.after_close = after;
    window.refresh();
    #[cfg(windows)]
    if let Some(surface) = &state.surface {
        surface.cancel_reveal();
        surface.set_interactive(false);
    }
    drop(state);
    frame(shared, window, cx);
    true
}
/// Reopens an exit from its actual outer-window position and cancels handoff.
pub(crate) fn activate(window: &mut Window, cx: &mut App) {
    if let Some(shared) = host(window, cx) {
        let mut state = shared.borrow_mut();
        state.pending_close = false;
        state.request_serial = state.request_serial.wrapping_add(1);
        // Activation must never bypass the pending first-present barrier.
        if matches!(state.motion.phase, Phase::Preparing | Phase::Closed) {
            return;
        }
        let now = cx
            .background_executor()
            .now()
            .duration_since(state.clock)
            .as_secs_f64();
        let actual = actual_y(&state, now);
        #[cfg(windows)]
        let reversing_exit = state.motion.phase == Phase::Exiting;
        state.motion.activate(now, actual);
        state.after_close.take();
        #[cfg(windows)]
        if reversing_exit && let Some(surface) = &state.surface {
            surface.set_interactive(true);
        }
        window.refresh();
        drop(state);
        frame(shared, window, cx);
    }
    window.activate_window();
}
fn actual_y(state: &Host, _now: f64) -> f64 {
    #[cfg(windows)]
    if let Some(surface) = &state.surface
        && let Ok(geometry) = surface.geometry()
    {
        return geometry.y as f64;
    }
    // For fake platforms the last presented sample is tracked by the motion.
    state.motion.position()
}
fn frame(shared: Rc<RefCell<Host>>, window: &mut Window, cx: &mut App) {
    let mut state = shared.borrow_mut();
    #[cfg(windows)]
    if let Some(surface) = state.surface.clone()
        && let (Some(before), Ok(current)) = (state.geometry, surface.geometry())
    {
        if current.epoch != before.epoch
            || current.suspended
            || current.dpi != before.dpi
            || current.monitor != before.monitor
            || (
                current.width,
                current.height,
                current.work_left,
                current.work_top,
                current.work_right,
                current.work_bottom,
            ) != (
                before.width,
                before.height,
                before.work_left,
                before.work_top,
                before.work_right,
                before.work_bottom,
            )
        {
            state.motion.retire(current.y as f64);
        }
        state.geometry = Some(current);
    }
    let now = cx
        .background_executor()
        .now()
        .duration_since(state.clock)
        .as_secs_f64();
    let y = state.motion.sample(now, cx.reduce_motion());
    #[cfg(windows)]
    if let (Some(surface), Some(geometry)) = (&state.surface, state.geometry)
        && let Err(error) = surface.move_to(geometry.x, y.round() as i32)
    {
        eprintln!("dialog movement failed: {error:#}");
        state.motion.retire(y);
    }
    let phase = state.motion.phase;
    if phase == Phase::Closed {
        drop(state);
        window.remove_window();
    } else if matches!(phase, Phase::Entering | Phase::Exiting) && !state.scheduled {
        state.scheduled = true;
        drop(state);
        window.on_next_frame(move |window, cx| {
            shared.borrow_mut().scheduled = false;
            frame(shared, window, cx);
        });
    }
}
fn destroyed(id: WindowId, shared: &Rc<RefCell<Host>>, cx: &mut App) {
    let mut state = shared.borrow_mut();
    state.motion.phase = Phase::Closed;
    let after = state.after_close.take();
    let callbacks = std::mem::take(&mut state.closed_callbacks);
    drop(state);
    if let Some(hosts) = cx.try_global::<Hosts>()
        && hosts
            .0
            .get(&id)
            .is_some_and(|current| Rc::ptr_eq(current, shared))
    {
        cx.global_mut::<Hosts>().0.remove(&id);
    }
    for callback in callbacks {
        callback(cx);
    }
    if let Some(after) = after {
        after(cx);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui_kit::{Context, IntoElement, Render, TestAppContext, div};
    use std::cell::Cell;
    struct Empty;
    impl Render for Empty {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            div()
        }
    }
    #[gpui_kit::test]
    fn refusal_drops_continuation_and_accepted_handoff_waits_for_removal(cx: &mut TestAppContext) {
        cx.update(|cx| cx.set_reduce_motion(true));
        let busy = Rc::new(Cell::new(true));
        let preparations = Rc::new(Cell::new(0));
        let observed = Rc::new(Cell::new(0));
        let window = cx.add_window({
            let busy = busy.clone();
            let preparations = preparations.clone();
            move |window, cx| {
                install(window, cx, move |_, _| {
                    if busy.get() {
                        return false;
                    }
                    preparations.set(preparations.get() + 1);
                    true
                })
                .unwrap();
                Empty
            }
        });
        window
            .update(cx, |_, window, cx| {
                let refused = observed.clone();
                assert!(close_then(window, cx, move |_| refused.set(100)));
            })
            .unwrap();
        assert_eq!(preparations.get(), 0);
        busy.set(false);
        window
            .update(cx, |_, native, cx| {
                let completed = observed.clone();
                assert!(close_then(native, cx, move |cx| {
                    assert!(
                        window.update(cx, |_, _, _| ()).is_err(),
                        "handoff must not see previous window"
                    );
                    completed.set(1);
                }));
                assert!(!request_close(native, cx));
                assert_eq!(
                    observed.get(),
                    0,
                    "callback cannot run inside accepted request"
                );
            })
            .unwrap();
        cx.run_until_parked();
        assert_eq!(preparations.get(), 1);
        assert_eq!(observed.get(), 1);
        cx.update(|cx| assert!(cx.global::<Hosts>().0.is_empty()));
    }
    #[gpui_kit::test]
    fn reactivation_cancels_pending_handoff_and_stale_frame(cx: &mut TestAppContext) {
        let window = cx.add_window(|window, cx| {
            install(window, cx, |_, _| true).unwrap();
            Empty
        });
        let calls = Rc::new(Cell::new(0));
        window
            .update(cx, |_, native, cx| {
                let calls = calls.clone();
                assert!(close_then(native, cx, move |_| calls.set(1)));
                activate(native, cx);
                cx.set_reduce_motion(true);
                let shared = host(native, cx).unwrap();
                frame(shared, native, cx);
            })
            .unwrap();
        cx.run_until_parked();
        assert_eq!(calls.get(), 0);
        assert!(window.update(cx, |_, _, _| ()).is_ok());
        window
            .update(cx, |_, native, cx| {
                assert!(request_close(native, cx));
            })
            .unwrap();
        cx.run_until_parked();
        assert_eq!(calls.get(), 0);
    }

    struct ClickTarget(Rc<Cell<usize>>);
    impl Render for ClickTarget {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            use gpui_kit::prelude::*;
            let calls = self.0.clone();
            div()
                .id("dialog-action")
                .w(gpui_kit::px(100.))
                .h(gpui_kit::px(40.))
                .on_mouse_down(gpui_kit::MouseButton::Left, move |_, _, _| {
                    calls.set(calls.get() + 1)
                })
        }
    }
    #[gpui_kit::test]
    fn exit_content_is_inert_and_reactivation_restores_input(cx: &mut TestAppContext) {
        use gpui_kit::{
            AppContext,
            test::{TestEventExt, TestWindowExt},
        };
        cx.update(gpui_kit::init);
        let calls = Rc::new(Cell::new(0));
        let window = cx.update(|cx| {
            super::super::open_window(gpui_kit::WindowOptions::default(), cx, |_, cx| {
                cx.new(|_| ClickTarget(calls.clone()))
            })
            .unwrap()
            .0
        });
        cx.executor().advance_clock(crate::ui::motion::ENTER);
        window
            .update(cx, |_, window, cx| {
                frame(host(window, cx).unwrap(), window, cx);
                window.render_frame(cx);
                window.pointer_down(
                    gpui_kit::point(gpui_kit::px(10.), gpui_kit::px(10.)),
                    gpui_kit::MouseButton::Left,
                    cx,
                );
                assert!(request_close(window, cx));
            })
            .unwrap();
        assert_eq!(calls.get(), 1);
        window
            .update(cx, |_, window, cx| {
                assert!(!interactive(window, cx));
                window.render_frame(cx);
                window.pointer_down(
                    gpui_kit::point(gpui_kit::px(10.), gpui_kit::px(10.)),
                    gpui_kit::MouseButton::Left,
                    cx,
                );
                assert_eq!(
                    calls.get(),
                    1,
                    "exiting content cannot accept another action"
                );
                activate(window, cx);
                window.render_frame(cx);
                window.pointer_down(
                    gpui_kit::point(gpui_kit::px(10.), gpui_kit::px(10.)),
                    gpui_kit::MouseButton::Left,
                    cx,
                );
            })
            .unwrap();
        assert_eq!(calls.get(), 2);
    }
}
