//! Windows production host; all GPUI and native-window mutations stay here on GUI.
use super::{
    geometry::{self, Environment, PhysicalPosition, PhysicalSize},
    native,
    placement::{Persistence, Placement},
};
use crate::{
    application::AppState,
    runtime::{DesktopEvent, DesktopHost, MainThreadTask, WindowAction},
    ui::DesktopView,
};
use anyhow::{Context as _, Result, ensure};
use gpui_kit::{AppContext, SendForegroundExecutor, Window, WindowBounds, WindowOptions, px, size};
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use std::{
    cell::RefCell,
    collections::HashMap,
    path::Path,
    rc::Rc,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc,
    },
    time::Duration,
};
use windows_sys::Win32::{
    Foundation::{HWND, RECT},
    Graphics::Gdi::{
        GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromRect, MonitorFromWindow,
    },
    UI::{
        HiDpi::{GetDpiForMonitor, GetDpiForWindow, MDT_EFFECTIVE_DPI},
        WindowsAndMessaging::*,
    },
};

type GuiWindowAction = Box<dyn FnMut(WindowAction) -> Result<()>>;
thread_local! { static WINDOW_ACTION: RefCell<Option<GuiWindowAction>> = RefCell::new(None); }

/// Own queued closures independently from GPUI futures, so shutdown can drop
/// their oneshot senders immediately even if no further foreground frame runs.
#[derive(Clone)]
struct Dispatcher {
    foreground: SendForegroundExecutor,
    alive: Arc<AtomicBool>,
    pending: Arc<Mutex<HashMap<u64, MainThreadTask>>>,
    next: Arc<AtomicU64>,
}
impl Dispatcher {
    fn submit(&self, task: MainThreadTask) -> Result<()> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        {
            let mut pending = self
                .pending
                .lock()
                .map_err(|_| anyhow::anyhow!("GUI dispatcher interrupted"))?;
            ensure!(self.alive.load(Ordering::Acquire), "GUI thread unavailable");
            pending.insert(id, task);
        }
        let pending = self.pending.clone();
        let alive = self.alive.clone();
        self.foreground
            .spawn(async move {
                let task = pending.lock().ok().and_then(|mut queue| queue.remove(&id));
                if alive.load(Ordering::Acquire)
                    && let Some(task) = task
                {
                    task();
                }
            })
            .detach();
        Ok(())
    }
    fn shutdown(&self) {
        self.alive.store(false, Ordering::Release);
        if let Ok(mut pending) = self.pending.lock() {
            pending.clear();
        }
    }
}

struct Lifecycle {
    services: AppState,
    host: DesktopHost,
    dispatcher: Dispatcher,
    placement: Persistence,
    stopped: bool,
    placement_error: bool,
    environment: Option<Environment>,
}
impl Lifecycle {
    fn stop(&mut self) {
        if self.stopped {
            return;
        }
        self.stopped = true;
        self.host.shutdown();
        self.dispatcher.shutdown();
        // This method only runs from GUI callbacks or after the GUI event loop
        // returns to its owning main thread. Never drop the HWND on a worker.
        self.services.shutdown();
        WINDOW_ACTION.with(|action| *action.borrow_mut() = None);
    }
    fn capture(&mut self, window: &Window) -> Result<()> {
        let hwnd = native_handle(window)?;
        let minimized = unsafe { IsIconic(hwnd) != 0 };
        let maximized = unsafe { IsZoomed(hwnd) != 0 };
        let normal = if minimized || maximized || window.is_fullscreen() {
            None
        } else {
            let (outer, inner) = rectangles(hwnd)?;
            let scale = window_scale(hwnd);
            Some(Placement {
                version: 1,
                x: outer.left,
                y: outer.top,
                width: f64::from(inner.right - inner.left) / scale,
                height: f64::from(inner.bottom - inner.top) / scale,
                scale_factor: scale,
                maximized: false,
            })
        };
        self.placement
            .capture(normal, maximized, minimized || window.is_fullscreen());
        self.placement.save()
    }
    fn tick(&mut self, window: &mut Window, persist: bool) {
        if self.stopped {
            return;
        }
        if persist {
            let result = fit_current_window(window, &mut self.environment)
                .and_then(|_| self.capture(window));
            if let Err(error) = result {
                if !self.placement_error {
                    eprintln!("Could not update window placement: {error:#}");
                }
                self.placement_error = true;
            } else {
                self.placement_error = false;
            }
        }
        match self.services.playback_tick(persist) {
            Ok(state) => self.host.emit(DesktopEvent::PlayerState(state)),
            Err(error) => eprintln!("Could not sample playback: {error:#}"),
        }
    }
}

fn native_handle(window: &Window) -> Result<HWND> {
    let RawWindowHandle::Win32(handle) = HasWindowHandle::window_handle(window)
        .map_err(|error| anyhow::anyhow!("{error}"))?
        .as_raw()
    else {
        anyhow::bail!("Surtitle requires a native Windows window");
    };
    Ok(handle.hwnd.get() as HWND)
}
pub(super) fn set_caption_theme(window: &Window, dark: bool) -> Result<()> {
    use windows_sys::Win32::Graphics::Dwm::{DWMWA_USE_IMMERSIVE_DARK_MODE, DwmSetWindowAttribute};
    let hwnd = native_handle(window)?;
    let value = i32::from(dark);
    let result = unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_USE_IMMERSIVE_DARK_MODE as u32,
            (&value as *const i32).cast(),
            std::mem::size_of::<i32>() as u32,
        )
    };
    ensure!(
        result >= 0,
        "Could not update the native window theme: {result}"
    );
    Ok(())
}
pub(super) fn request_close(window: &mut Window) -> Result<()> {
    ensure!(
        unsafe { PostMessageW(native_handle(window)?, WM_CLOSE, 0, 0) } != 0,
        "Could not request window close: {}",
        std::io::Error::last_os_error()
    );
    Ok(())
}
fn window_scale(hwnd: HWND) -> f64 {
    f64::from(unsafe { GetDpiForWindow(hwnd) }.max(96)) / 96.
}
fn rectangles(hwnd: HWND) -> Result<(RECT, RECT)> {
    let mut outer = RECT::default();
    let mut inner = RECT::default();
    ensure!(
        unsafe { GetWindowRect(hwnd, &mut outer) } != 0
            && unsafe { GetClientRect(hwnd, &mut inner) } != 0,
        "Could not read window geometry: {}",
        std::io::Error::last_os_error()
    );
    Ok((outer, inner))
}
fn environment(hwnd: HWND, previous: Option<Placement>) -> Result<Environment> {
    let monitor = if let Some(previous) = previous {
        let rect = RECT {
            left: previous.x,
            top: previous.y,
            right: (f64::from(previous.x) + previous.width * previous.scale_factor)
                .clamp(f64::from(i32::MIN), f64::from(i32::MAX)) as i32,
            bottom: (f64::from(previous.y) + previous.height * previous.scale_factor)
                .clamp(f64::from(i32::MIN), f64::from(i32::MAX)) as i32,
        };
        unsafe { MonitorFromRect(&rect, MONITOR_DEFAULTTONEAREST) }
    } else {
        unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) }
    };
    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    ensure!(
        !monitor.is_null() && unsafe { GetMonitorInfoW(monitor, &mut info) } != 0,
        "Could not locate the window work area"
    );
    let mut dpi = 96;
    let mut dpi_y = 96;
    if unsafe { GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut dpi, &mut dpi_y) } < 0 {
        dpi = unsafe { GetDpiForWindow(hwnd) }.max(96);
    }
    Ok(Environment {
        origin: (info.rcWork.left, info.rcWork.top).into(),
        size: (
            (info.rcWork.right - info.rcWork.left) as u32,
            (info.rcWork.bottom - info.rcWork.top) as u32,
        )
            .into(),
        scale: f64::from(dpi) / 96.,
    })
}

fn apply_geometry(
    hwnd: HWND,
    area: Environment,
    requested: PhysicalSize<u32>,
    position: PhysicalPosition<i32>,
) -> Result<()> {
    let (outer, client) = rectangles(hwnd)?;
    let frame_scale = area.scale / window_scale(hwnd);
    let frame = PhysicalSize::new(
        ((outer.right - outer.left - client.right + client.left) as f64 * frame_scale)
            .round()
            .max(0.) as u32,
        ((outer.bottom - outer.top - client.bottom + client.top) as f64 * frame_scale)
            .round()
            .max(0.) as u32,
    );
    let fitted = geometry::plan(
        area,
        requested,
        PhysicalSize::new(
            requested.width + frame.width,
            requested.height + frame.height,
        ),
        position,
        native::insets(hwnd).scaled(frame_scale),
    );
    ensure!(
        unsafe {
            SetWindowPos(
                hwnd,
                std::ptr::null_mut(),
                fitted.position.x,
                fitted.position.y,
                (fitted.size.width + frame.width) as i32,
                (fitted.size.height + frame.height) as i32,
                SWP_NOZORDER | SWP_NOACTIVATE,
            )
        } != 0,
        "Could not fit the window: {}",
        std::io::Error::last_os_error()
    );
    Ok(())
}
fn fit_current_window(window: &mut Window, previous: &mut Option<Environment>) -> Result<()> {
    let hwnd = native_handle(window)?;
    if unsafe { IsIconic(hwnd) != 0 || IsZoomed(hwnd) != 0 } || window.is_fullscreen() {
        return Ok(());
    }
    let area = environment(hwnd, None)?;
    let (outer, inner) = rectangles(hwnd)?;
    let requested = PhysicalSize::new(
        (inner.right - inner.left) as u32,
        (inner.bottom - inner.top) as u32,
    );
    // Do not snap a freely dragged, same-monitor window back on every tick.
    let fit = geometry::plan(
        area,
        requested,
        PhysicalSize::new(
            (outer.right - outer.left) as u32,
            (outer.bottom - outer.top) as u32,
        ),
        (outer.left, outer.top).into(),
        native::insets(hwnd),
    );
    if *previous != Some(area) || fit.size != requested {
        apply_geometry(hwnd, area, requested, (outer.left, outer.top).into())?;
        *previous = Some(area);
    }
    Ok(())
}
fn restore(window: &mut Window, persistence: &mut Persistence) -> Result<()> {
    let hwnd = native_handle(window)?;
    let area = environment(hwnd, persistence.placement)?;
    let (outer, inner) = rectangles(hwnd)?;
    let requested = persistence
        .placement
        .map(|value| {
            PhysicalSize::new(
                (value.width * area.scale).round() as u32,
                (value.height * area.scale).round() as u32,
            )
        })
        .unwrap_or_else(|| {
            PhysicalSize::new(
                (inner.right - inner.left) as u32,
                (inner.bottom - inner.top) as u32,
            )
        });
    let position = persistence
        .placement
        .map(Placement::position)
        .unwrap_or((outer.left, outer.top).into());
    apply_geometry(hwnd, area, requested, position)?;
    if persistence.placement.is_some_and(|value| value.maximized) {
        unsafe {
            ShowWindow(hwnd, SW_MAXIMIZE);
        }
    }
    Ok(())
}

fn apply_window_action(window: &mut Window, action: WindowAction) -> Result<()> {
    match action {
        WindowAction::SetFullscreen(target) => {
            let current = window.is_fullscreen();
            if target.unwrap_or(!current) != current {
                window.toggle_fullscreen();
            }
        }
        WindowAction::SetSizePreset(preset) => {
            ensure!(
                !window.is_fullscreen(),
                "Exit full screen before changing window size"
            );
            let hwnd = native_handle(window)?;
            if unsafe { IsZoomed(hwnd) != 0 } {
                unsafe {
                    ShowWindow(hwnd, SW_RESTORE);
                }
            }
            let area = environment(hwnd, None)?;
            let logical = geometry::preset_size(&preset)?;
            let requested = PhysicalSize::new(
                (f64::from(logical.width) * area.scale).round() as u32,
                (f64::from(logical.height) * area.scale).round() as u32,
            );
            let (outer, _) = rectangles(hwnd)?;
            apply_geometry(hwnd, area, requested, (outer.left, outer.top).into())?;
        }
    }
    Ok(())
}

pub(super) fn run() -> Result<()> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_name("surtitle-service")
        .build()?;
    let workspace = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let resources = super::resources(
        &std::env::current_exe()?,
        if cfg!(debug_assertions) {
            Some(workspace.as_path())
        } else {
            None
        },
    )?;
    let (root, services) = crate::startup::open_services(
        std::env::var_os("SURTITLE_E2E_DATA_DIR"),
        || super::normal_profile(std::env::var_os("LOCALAPPDATA")),
        runtime.handle().clone(),
    )?;
    #[cfg(feature = "e2e-test")]
    {
        crate::application::ai::fixtures::seed_ai_recovery_fixture(&services)?;
        crate::application::transcript::fixtures::seed_transcript_review_fixture(&services)?;
    }
    let executor = runtime.handle().clone();
    let launch_error = Arc::new(Mutex::new(None));
    let final_error = launch_error.clone();
    let final_services = services.clone();
    let lifecycle_slot: Rc<RefCell<Option<Rc<RefCell<Lifecycle>>>>> = Rc::new(RefCell::new(None));
    let final_lifecycle = lifecycle_slot.clone();
    gpui_kit::application()
        .with_assets(crate::ui::assets::Assets)
        .run(move |cx| {
            gpui_kit::init(cx);
            let (send, events) = mpsc::channel();
            let dispatcher = Dispatcher {
                foreground: cx.foreground_executor().to_send(),
                alive: Arc::new(AtomicBool::new(true)),
                pending: Arc::default(),
                next: Arc::new(AtomicU64::new(1)),
            };
            let enqueue = dispatcher.clone();
            let host = DesktopHost::new(
                executor.clone(),
                move |task| enqueue.submit(task),
                |action| {
                    WINDOW_ACTION.with(|callback| {
                        callback
                            .try_borrow_mut()
                            .map_err(|_| anyhow::anyhow!("Window action is already running"))?
                            .as_mut()
                            .context("GUI thread unavailable")?(action)
                    })
                },
                move |event| {
                    let _ = send.send(event);
                },
            );
            let change_host = host.clone();
            let progress_host = host.clone();
            let initialization = (|| -> Result<()> {
                services.changes.install(move |change| {
                    change_host.emit(DesktopEvent::DataChanged(change.clone()))
                })?;
                crate::application::ai::runtime::install_publisher(&services, move |snapshot| {
                    progress_host.emit(DesktopEvent::AiRuntime(snapshot.clone()))
                })?;
                let lifecycle = Rc::new(RefCell::new(Lifecycle {
                    services: services.clone(),
                    host: host.clone(),
                    dispatcher: dispatcher.clone(),
                    placement: Persistence::open(root.join("window-state.json")),
                    stopped: false,
                    placement_error: false,
                    environment: None,
                }));
                let state = lifecycle.clone();
                let bounds = gpui_kit::Bounds::centered(None, size(px(1440.), px(900.)), cx);
                let resources = resources.clone();
                let view_services = services.clone();
                let view_host = host.clone();
                let root = root.clone();
                let build_error = Rc::new(RefCell::new(None));
                let construction_error = build_error.clone();
                gpui_kit::open_window(
                    WindowOptions {
                        window_bounds: Some(WindowBounds::Windowed(bounds)),
                        titlebar: Some(gpui_kit::TitlebarOptions {
                            title: Some(crate::startup::identity().product_name.into()),
                            ..Default::default()
                        }),
                        app_id: Some(crate::startup::identity().identifier.into()),
                        // WM_GETMINMAXINFO enforces the existing logical minimum,
                        // capped to the current monitor's usable physical area.
                        window_min_size: None,
                        ..Default::default()
                    },
                    cx,
                    move |window, cx| {
                        let setup = (|| -> Result<()> {
                            let hwnd = native_handle(window)?;
                            unsafe {
                                let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
                                SetWindowLongPtrW(
                                    hwnd,
                                    GWL_STYLE,
                                    style | WS_CLIPCHILDREN as isize,
                                );
                            }
                            native::install_hwnd(hwnd)?;
                            restore(window, &mut state.borrow_mut().placement)?;
                            let click_host = view_host.clone();
                            view_services.initialize_player(
                                &resources,
                                hwnd as isize,
                                move || click_host.emit(DesktopEvent::PlayerSurfaceClick),
                            )?;
                            Ok(())
                        })();
                        if let Err(error) = setup {
                            *construction_error.borrow_mut() = Some(error);
                        }
                        let mut async_window = window.to_async(cx);
                        WINDOW_ACTION.with(|callback| {
                            *callback.borrow_mut() = Some(Box::new(move |action| {
                                async_window
                                    .update(|window, _| apply_window_action(window, action))?
                            }))
                        });
                        let entity = cx.new(|cx| {
                            DesktopView::new(root, view_services, view_host, events, window, cx)
                        });
                        let weak = entity.downgrade();
                        let closing = state.clone();
                        window.on_window_should_close(cx, move |window, cx| {
                            let ready = weak
                                .update(cx, |view, cx| view.prepare_close(window, cx))
                                .unwrap_or(false);
                            if !ready {
                                return false;
                            }
                            let mut lifecycle = closing.borrow_mut();
                            if let Err(error) = lifecycle.capture(window) {
                                eprintln!("Could not save window placement: {error:#}");
                            }
                            if let Err(error) = lifecycle.services.playback_tick(true) {
                                eprintln!("Could not save playback position: {error:#}");
                            }
                            lifecycle.stop();
                            true
                        });
                        let polling = state.clone();
                        let mut poll_window = window.to_async(cx);
                        cx.spawn(async move |cx| {
                            let mut tick = 0u64;
                            loop {
                                cx.background_executor()
                                    .timer(Duration::from_millis(100))
                                    .await;
                                if polling.borrow().stopped {
                                    break;
                                }
                                if poll_window
                                    .update(|window, _| {
                                        polling.borrow_mut().tick(window, tick.is_multiple_of(10))
                                    })
                                    .is_err()
                                {
                                    break;
                                }
                                tick = tick.wrapping_add(1);
                            }
                        })
                        .detach();
                        entity
                    },
                )?;
                if let Some(error) = build_error.borrow_mut().take() {
                    lifecycle.borrow_mut().stop();
                    return Err(error);
                }
                *lifecycle_slot.borrow_mut() = Some(lifecycle);
                let update_state = services.clone();
                host.runtime().spawn(async move {
                    crate::application::tool_updates::run(update_state).await;
                });
                Ok(())
            })();
            if let Err(error) = initialization {
                host.shutdown();
                dispatcher.shutdown();
                services.shutdown();
                *launch_error.lock().unwrap() = Some(error);
                cx.quit();
            }
            let closing = lifecycle_slot.clone();
            cx.on_window_closed(move |cx, _| {
                if cx.windows().is_empty() {
                    if let Some(lifecycle) = closing.borrow().as_ref() {
                        lifecycle.borrow_mut().stop();
                    }
                    cx.quit();
                }
            })
            .detach();
        });
    if let Some(lifecycle) = final_lifecycle.borrow().as_ref() {
        lifecycle.borrow_mut().stop();
    } else {
        final_services.shutdown();
    }
    // Keep the executor alive until all native HWND teardown has completed.
    runtime.shutdown_timeout(Duration::from_secs(5));
    if let Some(error) = final_error.lock().unwrap().take() {
        return Err(error);
    }
    Ok(())
}
