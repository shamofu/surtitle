//! Typed boundary between application workers and the desktop GUI thread.
use anyhow::{Result, ensure};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

pub(crate) type MainThreadTask = Box<dyn FnOnce() + Send + 'static>;
type Dispatcher = dyn Fn(MainThreadTask) -> Result<()> + Send + Sync;
type WindowHandler = dyn Fn(WindowAction) -> Result<()> + Send + Sync;
type EventHandler = dyn Fn(DesktopEvent) + Send + Sync;

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum WindowAction {
    SetFullscreen(Option<bool>),
    SetSizePreset(String),
}

#[derive(Debug, Clone)]
pub(crate) enum DesktopEvent {
    PreparationProgress(surtitle_ai::PreparationProgress),
    DataChanged(crate::application::changes::DataChange),
    AiRuntime(crate::application::ai::runtime::RuntimeSnapshot),
    PlayerState(crate::player::PlayerState),
    PlayerSurfaceClick,
}

#[derive(Clone)]
pub(crate) struct DesktopHost {
    runtime: tokio::runtime::Handle,
    dispatch: Arc<Dispatcher>,
    window: Arc<WindowHandler>,
    event: Arc<EventHandler>,
    alive: Arc<AtomicBool>,
}

impl DesktopHost {
    pub(crate) fn new(
        runtime: tokio::runtime::Handle,
        dispatch: impl Fn(MainThreadTask) -> Result<()> + Send + Sync + 'static,
        window: impl Fn(WindowAction) -> Result<()> + Send + Sync + 'static,
        event: impl Fn(DesktopEvent) + Send + Sync + 'static,
    ) -> Self {
        Self {
            runtime,
            dispatch: Arc::new(dispatch),
            window: Arc::new(window),
            event: Arc::new(event),
            alive: Arc::new(AtomicBool::new(true)),
        }
    }

    pub(crate) fn runtime(&self) -> &tokio::runtime::Handle {
        &self.runtime
    }

    pub(crate) fn run_on_main_thread(&self, task: impl FnOnce() + Send + 'static) -> Result<()> {
        self.ensure_alive()?;
        let alive = self.alive.clone();
        (self.dispatch)(Box::new(move || {
            if alive.load(Ordering::Acquire) {
                task();
            }
        }))
    }

    /// Called on the GUI thread by playback's main-thread operation.
    pub(crate) fn set_fullscreen(&self, value: Option<bool>) -> Result<()> {
        self.ensure_alive()?;
        (self.window)(WindowAction::SetFullscreen(value))
    }

    pub(crate) fn set_window_size_preset(&self, preset: &str) -> Result<()> {
        ensure!(
            matches!(preset, "hd" | "standard" | "full-hd"),
            "Unknown window size preset: {preset}"
        );
        self.ensure_alive()?;
        (self.window)(WindowAction::SetSizePreset(preset.to_owned()))
    }

    /// Event callbacks enqueue UI work; they must not reenter service/player locks.
    pub(crate) fn emit(&self, event: DesktopEvent) {
        if self.alive.load(Ordering::Acquire) {
            (self.event)(event);
        }
    }

    pub(crate) fn shutdown(&self) {
        self.alive.store(false, Ordering::Release);
    }

    fn ensure_alive(&self) -> Result<()> {
        ensure!(self.alive.load(Ordering::Acquire), "GUI thread unavailable");
        Ok(())
    }
}

#[cfg(test)]
pub(crate) fn test_runtime() -> tokio::runtime::Handle {
    // Synchronous service tests also exercise blocking work. The test executor
    // owns this runtime for the entire process; production always injects its handle.
    static RUNTIME: std::sync::OnceLock<tokio::runtime::Runtime> = std::sync::OnceLock::new();
    RUNTIME
        .get_or_init(|| tokio::runtime::Runtime::new().expect("test runtime"))
        .handle()
        .clone()
}

#[cfg(all(windows, test, feature = "e2e-test"))]
pub(crate) fn test_resources() -> std::path::PathBuf {
    let root = std::env::var_os("SURTITLE_RESOURCE_DIR")
        .map(std::path::PathBuf::from)
        .expect("native player tests require SURTITLE_RESOURCE_DIR supplied by the test host");
    assert!(root.is_absolute(), "SURTITLE_RESOURCE_DIR must be absolute");
    root
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, atomic::AtomicUsize};

    fn host(
        dispatch: impl Fn(MainThreadTask) -> Result<()> + Send + Sync + 'static,
    ) -> DesktopHost {
        DesktopHost::new(test_runtime(), dispatch, |_| Ok(()), |_| {})
    }

    #[test]
    fn rejected_dispatch_returns_an_error_without_running_work() {
        let host = host(|_| anyhow::bail!("dispatcher closed"));
        let ran = Arc::new(AtomicBool::new(false));
        let called = ran.clone();
        assert!(
            host.run_on_main_thread(move || called.store(true, Ordering::Release))
                .is_err()
        );
        assert!(!ran.load(Ordering::Acquire));
    }

    #[test]
    fn shutdown_discards_pending_work_and_rejects_new_actions() {
        let queued = Arc::new(Mutex::new(None));
        let queue = queued.clone();
        let host = host(move |work| {
            *queue.lock().unwrap() = Some(work);
            Ok(())
        });
        let ran = Arc::new(AtomicBool::new(false));
        let called = ran.clone();
        host.run_on_main_thread(move || called.store(true, Ordering::Release))
            .unwrap();
        host.clone().shutdown();
        queued.lock().unwrap().take().unwrap()();
        assert!(!ran.load(Ordering::Acquire));
        assert!(host.run_on_main_thread(|| {}).is_err());
        assert!(host.set_fullscreen(None).is_err());
        assert!(host.set_window_size_preset("hd").is_err());
    }

    #[test]
    fn typed_window_actions_keep_toggle_intent_and_validate_presets() {
        let actions = Arc::new(Mutex::new(Vec::new()));
        let captured = actions.clone();
        let events = Arc::new(AtomicUsize::new(0));
        let received = events.clone();
        let host = DesktopHost::new(
            test_runtime(),
            |work| {
                work();
                Ok(())
            },
            move |action| {
                captured.lock().unwrap().push(action);
                Ok(())
            },
            move |_| {
                received.fetch_add(1, Ordering::Relaxed);
            },
        );
        host.set_fullscreen(None).unwrap();
        host.set_fullscreen(Some(false)).unwrap();
        host.set_window_size_preset("standard").unwrap();
        assert!(host.set_window_size_preset("arbitrary").is_err());
        assert_eq!(
            *actions.lock().unwrap(),
            vec![
                WindowAction::SetFullscreen(None),
                WindowAction::SetFullscreen(Some(false)),
                WindowAction::SetSizePreset("standard".into())
            ]
        );
        host.emit(DesktopEvent::PlayerSurfaceClick);
        host.shutdown();
        host.emit(DesktopEvent::PlayerSurfaceClick);
        assert_eq!(events.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn explicit_handle_runs_work_without_an_entered_runtime() {
        assert!(tokio::runtime::Handle::try_current().is_err());
        let host = host(|work| {
            work();
            Ok(())
        });
        let result = host
            .runtime()
            .block_on(host.runtime().spawn_blocking(|| 42));
        assert_eq!(result.unwrap(), 42);
    }
}
