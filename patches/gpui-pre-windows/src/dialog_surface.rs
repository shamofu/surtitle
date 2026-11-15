//! Opt-in hidden-first-present barrier for owned native dialog motion.
use crate::{
    WM_GPUI_FORCE_UPDATE_WINDOW,
    window::{WindowsWindowInner, window_from_hwnd},
};
use anyhow::{Context as _, Result, anyhow, ensure};
use std::{
    cell::{Cell, RefCell},
    rc::{Rc, Weak},
    time::Instant,
};
use windows::Win32::{
    Foundation::*,
    Graphics::{
        Dwm::{DWMWA_TRANSITIONS_FORCEDISABLED, DwmSetWindowAttribute},
        Gdi::*,
    },
    UI::{HiDpi::GetDpiForWindow, WindowsAndMessaging::*},
};

type Reveal = Box<dyn FnOnce(Result<Instant>)>;
#[derive(Default)]
pub(crate) struct SurfaceState {
    active: Cell<bool>,
    destroyed: Cell<bool>,
    own_move: Cell<bool>,
    epoch: Cell<u64>,
    exit_input: ExitInputBlock,
    reveal: RefCell<Option<Reveal>>,
    destroyed_callback: RefCell<Option<Box<dyn FnOnce()>>>,
}
/// Input suppression belongs to one accepted exit. A modal parent's prior
/// disablement belongs to its child and must never be undone by activation.
#[derive(Default)]
struct ExitInputBlock {
    prior_enabled: Cell<Option<bool>>,
}
impl ExitInputBlock {
    fn begin(&self, was_enabled: bool) -> bool {
        if self.prior_enabled.get().is_some() {
            return false;
        }
        self.prior_enabled.set(Some(was_enabled));
        was_enabled
    }
    fn cancel(&self) -> bool {
        self.prior_enabled.take() == Some(true)
    }
}
impl SurfaceState {
    pub(crate) fn moving(&self) -> bool {
        self.own_move.get()
    }
    pub(crate) fn needs_first_present(&self) -> bool {
        self.reveal.borrow().is_some()
    }
    fn finish_first_frame(&self, result: &Result<bool>) -> Option<(Reveal, Result<()>)> {
        if !self.active.get() || self.destroyed.get() || matches!(result, Ok(false)) {
            return None;
        }
        let callback = self.reveal.borrow_mut().take()?;
        let outcome = result
            .as_ref()
            .map(|_| ())
            .map_err(|error| anyhow!("first dialog frame failed: {error:#}"));
        Some((callback, outcome))
    }
}
/// Weak identity of one GPUI window generation; never retains a recycled HWND.
#[derive(Clone)]
pub struct DialogSurface(Weak<WindowsWindowInner>);
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DialogGeometry {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub work_left: i32,
    pub work_top: i32,
    pub work_right: i32,
    pub work_bottom: i32,
    pub dpi: u32,
    pub monitor: isize,
    pub epoch: u64,
    pub suspended: bool,
}
/// Must run on the GUI thread with a hidden HWND obtained from GPUI's Window.
/// Placement is applied without showing; the caller chooses the entry origin
/// before requesting a forced render through `reveal_after_present`.
///
/// # Safety
/// `hwnd` must be the live raw handle of a GPUI Windows backend window on the
/// calling GUI thread. It must not be a foreign window or a retained old HWND.
pub unsafe fn prepare_hidden_dialog(hwnd: isize) -> Result<DialogSurface> {
    let inner =
        window_from_hwnd(HWND(hwnd as *mut _)).ok_or_else(|| anyhow!("not a live GPUI window"))?;
    ensure!(
        !inner.state.dialog_surface.active.replace(true),
        "dialog surface already installed"
    );
    inner.state.dialog_surface.own_move.set(true);
    let placement = inner.apply_hidden_placement();
    inner.state.dialog_surface.own_move.set(false);
    placement?;
    // This newly owned HWND uses the host's opaque whole-window trajectory.
    // Keep DWM's additional show/hide scaling and fading disabled for its
    // lifetime, including exit; destruction retires this per-window attribute.
    let disable_transitions: windows::core::BOOL = true.into();
    unsafe {
        DwmSetWindowAttribute(
            inner.native_hwnd(),
            DWMWA_TRANSITIONS_FORCEDISABLED,
            (&disable_transitions as *const windows::core::BOOL).cast(),
            std::mem::size_of_val(&disable_transitions) as u32,
        )
    }
    .context("disabling native dialog DWM transitions")?;
    Ok(DialogSurface(Rc::downgrade(&inner)))
}
impl DialogSurface {
    /// `false` claims an exit input block once. `true` releases only this
    /// block, restoring its captured state without enabling a modal parent
    /// that was already disabled by another owner.
    pub fn set_interactive(&self, enabled: bool) {
        if let Ok(inner) = self.inner() {
            use windows::Win32::UI::Input::KeyboardAndMouse::{EnableWindow, IsWindowEnabled};
            let block = &inner.state.dialog_surface.exit_input;
            let change = if enabled {
                block.cancel()
            } else {
                block.begin(unsafe { IsWindowEnabled(inner.native_hwnd()).as_bool() })
            };
            if !change {
                return;
            }
            unsafe {
                let _ = EnableWindow(inner.native_hwnd(), enabled);
            }
        }
    }
    fn inner(&self) -> Result<Rc<WindowsWindowInner>> {
        self.0
            .upgrade()
            .filter(|inner| !inner.state.dialog_surface.destroyed.get())
            .ok_or_else(|| anyhow!("dialog destroyed"))
    }
    pub fn geometry(&self) -> Result<DialogGeometry> {
        let inner = self.inner()?;
        let hwnd = inner.native_hwnd();
        let mut rect = RECT::default();
        unsafe {
            GetWindowRect(hwnd, &mut rect)?;
        }
        let monitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        unsafe {
            GetMonitorInfoW(monitor, &mut info).ok()?;
        }
        Ok(DialogGeometry {
            x: rect.left,
            y: rect.top,
            width: rect.right - rect.left,
            height: rect.bottom - rect.top,
            work_left: info.rcWork.left,
            work_top: info.rcWork.top,
            work_right: info.rcWork.right,
            work_bottom: info.rcWork.bottom,
            dpi: unsafe { GetDpiForWindow(hwnd) },
            monitor: monitor.0 as isize,
            epoch: inner.state.dialog_surface.epoch.get(),
            suspended: unsafe { IsIconic(hwnd).as_bool() || IsZoomed(hwnd).as_bool() },
        })
    }
    pub fn move_to(&self, x: i32, y: i32) -> Result<()> {
        let inner = self.inner()?;
        let before = self.geometry()?;
        if (before.x, before.y) == (x, y) {
            return Ok(());
        }
        inner.state.dialog_surface.own_move.set(true);
        let result = unsafe {
            SetWindowPos(
                inner.native_hwnd(),
                None,
                x,
                y,
                0,
                0,
                SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
            )
        };
        inner.state.dialog_surface.own_move.set(false);
        Ok(result?)
    }
    pub fn reveal_after_present(
        &self,
        callback: impl FnOnce(Result<Instant>) + 'static,
    ) -> Result<()> {
        let inner = self.inner()?;
        *inner.state.dialog_surface.reveal.borrow_mut() = Some(Box::new(callback));
        // Start on the foreground executor after construction/App borrows unwind,
        // then queue the platform's validated forced-frame message. The task
        // retains a weak generation, never a bare HWND across the delay.
        let weak = self.0.clone();
        inner
            .executor
            .spawn(async move {
                if let Some(inner) = weak.upgrade() {
                    if !inner.state.dialog_surface.destroyed.get()
                        && inner.state.dialog_surface.needs_first_present()
                    {
                        if let Err(error) = inner.request_dialog_frame() {
                            if let Some(callback) =
                                inner.state.dialog_surface.reveal.borrow_mut().take()
                            {
                                callback(Err(error));
                            }
                        }
                    }
                }
            })
            .detach();
        Ok(())
    }
    pub fn cancel_reveal(&self) {
        if let Ok(inner) = self.inner() {
            inner.state.dialog_surface.reveal.borrow_mut().take();
        }
    }
    pub fn on_destroyed(&self, callback: impl FnOnce() + 'static) -> Result<()> {
        let inner = self.inner()?;
        *inner.state.dialog_surface.destroyed_callback.borrow_mut() = Some(Box::new(callback));
        Ok(())
    }
}
impl WindowsWindowInner {
    pub(crate) fn request_dialog_frame(&self) -> Result<()> {
        unsafe {
            PostMessageW(
                Some(self.native_hwnd()),
                WM_GPUI_FORCE_UPDATE_WINDOW,
                WPARAM(self.validation_number),
                LPARAM(0),
            )?;
        }
        Ok(())
    }
    pub(crate) fn dialog_frame_result(&self, result: &Result<bool>) {
        if let Some((callback, result)) = self.state.dialog_surface.finish_first_frame(result) {
            if let Err(error) = result {
                callback(Err(error));
                return;
            }
            // Synchronous visibility means the returned instant is the reveal,
            // not construction time or the previous on_next_frame callback.
            unsafe {
                let _ = ShowWindow(self.native_hwnd(), SW_SHOWNOACTIVATE);
                let _ = SetForegroundWindow(self.native_hwnd());
            }
            callback(Ok(Instant::now()));
        }
    }
    pub(crate) fn dialog_destroyed(&self) {
        let state = &self.state.dialog_surface;
        state.destroyed.set(true);
        state.reveal.borrow_mut().take();
        if let Some(callback) = state.destroyed_callback.borrow_mut().take() {
            callback();
        }
    }
    pub(crate) fn dialog_native_event(&self, msg: u32) {
        let state = &self.state.dialog_surface;
        if state.active.get()
            && !state.own_move.get()
            && matches!(
                msg,
                WM_MOVE
                    | WM_SIZE
                    | WM_ENTERSIZEMOVE
                    | WM_DPICHANGED
                    | WM_DISPLAYCHANGE
                    | WM_SETTINGCHANGE
            )
        {
            state.epoch.set(state.epoch.get().wrapping_add(1));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn pending() -> SurfaceState {
        let state = SurfaceState::default();
        state.active.set(true);
        *state.reveal.borrow_mut() = Some(Box::new(|_| {}));
        state
    }
    #[test]
    fn skipped_renderer_frame_keeps_window_hidden_until_one_submission() {
        let state = pending();
        assert!(state.finish_first_frame(&Ok(false)).is_none());
        assert!(state.needs_first_present());
        let (_, outcome) = state
            .finish_first_frame(&Ok(true))
            .expect("submission unlocks reveal");
        assert!(outcome.is_ok());
        assert!(
            state.finish_first_frame(&Ok(true)).is_none(),
            "activate only once"
        );
    }
    #[test]
    fn renderer_failure_propagates_without_unlocking_visibility() {
        let state = pending();
        let (_, outcome) = state
            .finish_first_frame(&Err(anyhow!("device failure")))
            .unwrap();
        assert!(outcome.unwrap_err().to_string().contains("device failure"));
        assert!(!state.needs_first_present());
    }
    #[test]
    fn retired_window_cannot_consume_a_late_submission() {
        let state = pending();
        state.reveal.borrow_mut().take();
        assert!(state.finish_first_frame(&Ok(true)).is_none());
        let state = pending();
        state.destroyed.set(true);
        assert!(state.finish_first_frame(&Ok(true)).is_none());
    }
    #[test]
    fn nested_modal_parent_remains_disabled_on_activation_and_exit_reversal() {
        let parent = ExitInputBlock::default();
        assert!(!parent.cancel(), "ordinary activation owns no disablement");
        assert!(
            !parent.begin(false),
            "child already disabled the modal parent"
        );
        assert!(
            !parent.begin(false),
            "duplicate exit must retain prior state"
        );
        assert!(
            !parent.cancel(),
            "reversal must preserve the child's disablement"
        );
    }
    #[test]
    fn exit_reversal_restores_only_its_own_disable_once() {
        let dialog = ExitInputBlock::default();
        assert!(dialog.begin(true));
        assert!(
            !dialog.begin(false),
            "duplicate request cannot replace the saved enabled state"
        );
        assert!(dialog.cancel());
        assert!(
            !dialog.cancel(),
            "ordinary subsequent activation cannot enable the HWND"
        );
        assert!(
            !dialog.begin(false),
            "a later external disablement belongs to its new owner"
        );
        assert!(!dialog.cancel());
    }
}
