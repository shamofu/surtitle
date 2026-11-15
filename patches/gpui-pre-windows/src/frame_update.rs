//! Native child geometry submitted next to its owning window's presentation.
use crate::window::{WindowsWindowInner, window_from_hwnd};
use anyhow::Result;
use std::{
    cell::Cell,
    rc::Weak,
    time::{Duration, Instant},
};
use windows::Win32::{
    Foundation::HWND, System::Threading::GetCurrentThreadId,
    UI::WindowsAndMessaging::GetWindowThreadProcessId,
};

/// Restores the previously accepted geometry if swapchain submission fails.
pub type FrameUpdateRollback = Box<dyn FnOnce()>;
type Update = Box<dyn FnMut() -> Result<Option<FrameUpdateRollback>>>;

#[derive(Default)]
pub(crate) struct PendingFrameUpdate {
    pending: Cell<Option<Update>>,
    retired: Cell<bool>,
    retry_at: Cell<Option<Instant>>,
    failures: Cell<u32>,
}
impl PendingFrameUpdate {
    fn stage(&self, update: Update) -> bool {
        if self.retired.get() {
            return false;
        }
        self.pending.set(Some(update));
        true
    }
    pub(crate) fn retire(&self) {
        self.retired.set(true);
        self.pending.take();
        self.retry_at.set(None);
        self.failures.set(0);
    }
    fn has_pending(&self) -> bool {
        let pending = self.pending.take();
        let has_pending = pending.is_some();
        self.pending.set(pending);
        has_pending
    }
    pub(crate) fn retry_due(&self, now: Instant, visible: bool) -> bool {
        visible
            && !self.retired.get()
            && self.has_pending()
            && self.retry_at.get().is_some_and(|at| now >= at)
    }
    fn record_result(&self, result: &Result<bool>, now: Instant) {
        if matches!(result, Ok(true)) || self.retired.get() || !self.has_pending() {
            self.retry_at.set(None);
            self.failures.set(0);
        } else {
            let failures = self.failures.get().min(4);
            self.retry_at.set(Some(
                now + Duration::from_millis((16u64 << failures).min(250)),
            ));
            self.failures.set(failures + 1);
        }
    }
    fn requeue(&self, update: Option<Update>) {
        // A reentrant stage takes precedence over retrying this older frame.
        let newer = self.pending.take();
        if !self.retired.get() {
            self.pending.set(newer.or(update));
        }
    }
    pub(crate) fn present(
        &self,
        rendered: Result<bool>,
        present: impl FnOnce() -> Result<()>,
    ) -> Result<bool> {
        let result = self.try_present(rendered, present);
        self.record_result(&result, Instant::now());
        result
    }
    fn try_present(
        &self,
        rendered: Result<bool>,
        present: impl FnOnce() -> Result<()>,
    ) -> Result<bool> {
        if !rendered? {
            return Ok(false);
        }
        let mut update = self.pending.take();
        let rollback = match update.as_mut().map(|update| update()).transpose() {
            Ok(rollback) => rollback.flatten(),
            Err(error) => {
                self.requeue(update);
                return Err(error);
            }
        };
        if let Err(error) = present() {
            if let Some(rollback) = rollback {
                rollback();
            }
            self.requeue(update);
            return Err(error);
        }
        Ok(true)
    }
}

/// One latest native-child update for one GPUI window generation. Stage on the
/// GUI thread during prepaint. Runs after GPU encoding, immediately before
/// Present; this reduces presentation skew, not a cross-HWND atomicity promise.
#[derive(Clone)]
pub struct WindowFrameUpdate(Weak<WindowsWindowInner>);
impl WindowFrameUpdate {
    pub fn supports_composition_video(&self) -> bool {
        self.0.upgrade().is_some_and(|inner| {
            !inner.state.frame_update.retired.get()
                && inner.state.renderer.borrow().supports_composition_video()
        })
    }

    /// Stage owned composition content for the next matching GPUI scene.
    /// `request_frame` is needed when detaching outside the render pass.
    pub fn stage_composition_video(
        &self,
        frame: Option<crate::CompositionVideoFrame>,
        request_frame: bool,
    ) -> Result<()> {
        let inner = self
            .0
            .upgrade()
            .ok_or_else(|| anyhow::anyhow!("video parent retired"))?;
        anyhow::ensure!(
            !inner.state.frame_update.retired.get(),
            "video parent retired"
        );
        inner
            .state
            .renderer
            .borrow_mut()
            .stage_composition_video(frame)?;
        // Reuse the established failed-submission retry/retirement contract.
        inner.state.frame_update.stage(Box::new(|| Ok(None)));
        if request_frame {
            inner.state.force_render_pending.set(true);
        }
        Ok(())
    }

    /// Replaces pending geometry. Return a rollback for failed Present; the same
    /// update can be retried, or superseded by the next prepaint.
    /// On error, the update must undo any partial native changes itself; the
    /// parent frame is not submitted and the update is retained for retry.
    pub fn stage(
        &self,
        update: impl FnMut() -> Result<Option<FrameUpdateRollback>> + 'static,
    ) -> bool {
        self.0
            .upgrade()
            .is_some_and(|inner| inner.state.frame_update.stage(Box::new(update)))
    }
}

/// Acquire a frame update slot for a GPUI window; foreign window classes return None.
///
/// # Safety
/// `hwnd` must be a live window on the calling GUI thread in this process.
pub unsafe fn window_frame_update(hwnd: isize) -> Option<WindowFrameUpdate> {
    let hwnd = HWND(hwnd as *mut _);
    if unsafe { GetWindowThreadProcessId(hwnd, None) != GetCurrentThreadId() }
        || !crate::window::is_gpui_window(hwnd)
    {
        return None;
    }
    window_from_hwnd(hwnd).map(|inner| WindowFrameUpdate(std::rc::Rc::downgrade(&inner)))
}

#[cfg(test)]
#[path = "frame_update_native_tests.rs"]
mod native_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::RefCell, rc::Rc};

    #[test]
    fn latest_geometry_waits_for_encoded_frame_and_precedes_present() {
        let slot = PendingFrameUpdate::default();
        let observed = Rc::new(RefCell::new(Vec::new()));
        for value in [1, 2] {
            let observed = observed.clone();
            assert!(slot.stage(Box::new(move || {
                observed.borrow_mut().push(value);
                Ok(None)
            })));
        }
        assert!(
            !slot
                .present(Ok(false), || panic!("skipped frame presented"))
                .unwrap()
        );
        assert!(
            slot.present(Err(anyhow::anyhow!("render failed")), || panic!(
                "failed frame presented"
            ))
            .is_err()
        );
        assert!(observed.borrow().is_empty());
        slot.present(Ok(true), || {
            observed.borrow_mut().push(3);
            Ok(())
        })
        .unwrap();
        assert_eq!(*observed.borrow(), [2, 3]);
        slot.present(Ok(true), || Ok(())).unwrap();
        assert_eq!(*observed.borrow(), [2, 3]);
    }

    #[test]
    fn destruction_discards_pending_geometry_and_rejects_new_work() {
        let slot = PendingFrameUpdate::default();
        slot.stage(Box::new(|| panic!("destroyed window updated")));
        slot.retire();
        assert!(!slot.stage(Box::new(|| panic!("retired slot accepted work"))));
        slot.present(Ok(true), || Ok(())).unwrap();
    }

    #[test]
    fn failed_present_rolls_back_and_retries_latest_geometry() {
        let slot = PendingFrameUpdate::default();
        let visible = Rc::new(Cell::new(10));
        let geometry = visible.clone();
        slot.stage(Box::new(move || {
            let previous = geometry.replace(20);
            let geometry = geometry.clone();
            Ok(Some(Box::new(move || geometry.set(previous))))
        }));
        assert!(
            slot.present(Ok(true), || {
                assert_eq!(visible.get(), 20);
                Err(anyhow::anyhow!("Present failed"))
            })
            .is_err()
        );
        assert_eq!(visible.get(), 10);
        slot.present(Ok(true), || {
            assert_eq!(visible.get(), 20);
            Ok(())
        })
        .unwrap();
        assert_eq!(visible.get(), 20);
    }

    #[test]
    fn native_failure_aborts_present_and_backs_off_without_idle_demand() {
        let slot = PendingFrameUpdate::default();
        let failed = Rc::new(Cell::new(true));
        let update_failed = failed.clone();
        slot.stage(Box::new(move || {
            if update_failed.get() {
                anyhow::bail!("native mutation failed");
            }
            Ok(None)
        }));
        let mut now = Instant::now();
        for delay in [16, 32, 64, 128, 250, 250] {
            assert!(
                slot.try_present(Ok(true), || panic!("failed native mutation presented"))
                    .is_err()
            );
            slot.record_result(&Err(anyhow::anyhow!("native mutation failed")), now);
            let deadline = now + Duration::from_millis(delay);
            assert!(!slot.retry_due(deadline - Duration::from_millis(1), true));
            assert!(
                !slot.retry_due(deadline, false),
                "hidden/minimized must wait"
            );
            assert!(slot.retry_due(deadline, true));
            now = deadline;
        }
        failed.set(false);
        assert!(slot.present(Ok(true), || Ok(())).unwrap());
        assert!(!slot.retry_due(now + Duration::from_secs(5), true));
        assert_eq!(slot.failures.get(), 0);
        assert!(slot.retry_at.get().is_none());
    }
}
