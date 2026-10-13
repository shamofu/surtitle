//! Keep the normal window and its minimum client size within the active work area.
//! All geometry is physical: mixed-DPI monitor origins are not logical coordinates.
use std::path::PathBuf;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
    mpsc,
};
use std::time::Duration;
use tauri::{PhysicalPosition, PhysicalSize, WebviewWindow, WindowEvent};
#[cfg(windows)]
mod native;
mod persistence;
#[cfg(any(windows, test))]
mod snapping;

const MINIMUM_WIDTH: f64 = 1280.0;
const MINIMUM_HEIGHT: f64 = 720.0;

/// Physical resize borders outside the visible DWM frame. These may extend
/// beyond the work area while the visible titlebar and client remain inside it.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct Insets {
    left: u32,
    top: u32,
    right: u32,
    bottom: u32,
}

impl Insets {
    fn scaled(self, scale: f64) -> Self {
        Self {
            left: (f64::from(self.left) * scale).round() as u32,
            top: (f64::from(self.top) * scale).round() as u32,
            right: (f64::from(self.right) * scale).round() as u32,
            bottom: (f64::from(self.bottom) * scale).round() as u32,
        }
    }
}

fn invisible_insets(window: &WebviewWindow) -> Insets {
    #[cfg(windows)]
    {
        window
            .hwnd()
            .map(|handle| native::insets(handle.0))
            .unwrap_or_default()
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        Insets::default()
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Environment {
    origin: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    scale: f64,
}

#[derive(Debug, PartialEq)]
struct Fit {
    minimum: PhysicalSize<u32>,
    size: PhysicalSize<u32>,
    position: PhysicalPosition<i32>,
}

fn plan(
    environment: Environment,
    inner: PhysicalSize<u32>,
    outer: PhysicalSize<u32>,
    position: PhysicalPosition<i32>,
    insets: Insets,
) -> Fit {
    let frame = PhysicalSize::new(
        outer.width.saturating_sub(inner.width),
        outer.height.saturating_sub(inner.height),
    );
    let leading = PhysicalSize::new(insets.left.min(frame.width), insets.top.min(frame.height));
    let visible_frame = PhysicalSize::new(
        frame
            .width
            .saturating_sub(leading.width)
            .saturating_sub(insets.right),
        frame
            .height
            .saturating_sub(leading.height)
            .saturating_sub(insets.bottom),
    );
    let available = PhysicalSize::new(
        environment
            .size
            .width
            .saturating_sub(visible_frame.width)
            .max(1),
        environment
            .size
            .height
            .saturating_sub(visible_frame.height)
            .max(1),
    );
    // Floor before clamping so fractional DPI never adds a pixel outside the work area.
    let minimum = PhysicalSize::new(
        ((MINIMUM_WIDTH * environment.scale).floor() as u32).clamp(1, available.width),
        ((MINIMUM_HEIGHT * environment.scale).floor() as u32).clamp(1, available.height),
    );
    let size = PhysicalSize::new(
        inner.width.clamp(minimum.width, available.width),
        inner.height.clamp(minimum.height, available.height),
    );
    let clamp_axis =
        |current: i32, origin: i32, area: u32, client: u32, border: u32, inset: u32| {
            let start = i64::from(origin) - i64::from(inset);
            let end = start + i64::from(area.saturating_sub(client.saturating_add(border)));
            i64::from(current)
                .clamp(start, end)
                .clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32
        };
    Fit {
        minimum,
        size,
        position: PhysicalPosition::new(
            clamp_axis(
                position.x,
                environment.origin.x,
                environment.size.width,
                size.width,
                visible_frame.width,
                leading.width,
            ),
            clamp_axis(
                position.y,
                environment.origin.y,
                environment.size.height,
                size.height,
                visible_frame.height,
                leading.height,
            ),
        ),
    }
}

#[derive(Default)]
struct State {
    environment: Option<Environment>,
    minimum: Option<PhysicalSize<u32>>,
    persistence: Option<persistence::Persistence>,
}

fn apply(window: &WebviewWindow, state: &mut State) -> tauri::Result<()> {
    // Size constraints can restore a maximized window on Windows. Leave system
    // states alone and re-fit when it returns to the normal state.
    if window.is_minimized()? || window.is_maximized()? || window.is_fullscreen()? {
        return Ok(());
    }
    let Some(monitor) = window.current_monitor()?.or(window.primary_monitor()?) else {
        return Ok(());
    };
    let work_area = monitor.work_area();
    let environment = Environment {
        origin: work_area.position,
        size: work_area.size,
        scale: window.scale_factor()?,
    };
    let inner = window.inner_size()?;
    let position = window.outer_position()?;
    let fit = plan(
        environment,
        inner,
        window.outer_size()?,
        position,
        invisible_insets(window),
    );
    let changed_environment = state.environment != Some(environment);
    if state.minimum != Some(fit.minimum) {
        window.set_min_size(Some(fit.minimum))?;
        state.minimum = Some(fit.minimum);
    }
    if inner != fit.size {
        window.set_size(fit.size)?;
    }
    // A same-monitor drag may intentionally leave part of a window offscreen.
    // Clamp when its monitor/DPI/work area changes, or a size correction was needed.
    if (changed_environment || inner != fit.size) && position != fit.position {
        window.set_position(fit.position)?;
    }
    state.environment = Some(environment);
    Ok(())
}

fn preset_size(preset: &str) -> anyhow::Result<PhysicalSize<u32>> {
    match preset {
        "hd" => Ok(PhysicalSize::new(1280, 720)),
        "standard" => Ok(PhysicalSize::new(1600, 900)),
        "full-hd" => Ok(PhysicalSize::new(1920, 1080)),
        _ => anyhow::bail!("Unknown window size preset: {preset}"),
    }
}

/// Apply a device-local window action; existing placement events save the result.
pub async fn apply_preset(window: WebviewWindow, preset: &str) -> anyhow::Result<()> {
    let logical = preset_size(preset)?;
    let target = window.clone();
    let (send, receive) = tokio::sync::oneshot::channel();
    window.run_on_main_thread(move || {
        let result = (|| -> anyhow::Result<()> {
            if target.is_fullscreen()? {
                target.set_fullscreen(false)?;
            }
            if target.is_minimized()? {
                target.unminimize()?;
            }
            if target.is_maximized()? {
                target.unmaximize()?;
            }
            let monitor = target
                .current_monitor()?
                .or(target.primary_monitor()?)
                .ok_or_else(|| anyhow::anyhow!("No display is available for the window"))?;
            let area = monitor.work_area();
            let scale = target.scale_factor()?;
            let inner = target.inner_size()?;
            let outer = target.outer_size()?;
            let requested = PhysicalSize::new(
                (f64::from(logical.width) * scale).round() as u32,
                (f64::from(logical.height) * scale).round() as u32,
            );
            let fit = plan(
                Environment {
                    origin: area.position,
                    size: area.size,
                    scale,
                },
                requested,
                PhysicalSize::new(
                    requested.width + outer.width.saturating_sub(inner.width),
                    requested.height + outer.height.saturating_sub(inner.height),
                ),
                target.outer_position()?,
                invisible_insets(&target),
            );
            target.set_min_size(Some(fit.minimum))?;
            target.set_size(fit.size)?;
            target.set_position(fit.position)?;
            Ok(())
        })();
        let _ = send.send(result);
    })?;
    receive.await?
}

pub fn install(window: &WebviewWindow, path: PathBuf) -> anyhow::Result<()> {
    #[cfg(windows)]
    native::install(window)?;
    let mut persistence = persistence::Persistence::open(path);
    let maximized = match persistence.restore(window) {
        Ok(maximized) => maximized,
        Err(error) => {
            eprintln!("Could not restore window placement: {error}");
            false
        }
    };
    let mut initial = State::default();
    apply(window, &mut initial)?;
    if let Err(error) = persistence.capture(window) {
        eprintln!("Could not capture initial window placement: {error}");
    }
    if maximized {
        if let Err(error) = window.maximize() {
            eprintln!("Could not restore maximized window: {error}");
        } else if let Err(error) = persistence.capture(window) {
            eprintln!("Could not capture maximized window placement: {error}");
        }
    }
    initial.persistence = Some(persistence);
    let state = Arc::new(Mutex::new(initial));
    let alive = Arc::new(AtomicBool::new(true));
    let (sender, receiver) = mpsc::sync_channel(1);
    let event_alive = alive.clone();
    let event_state = state.clone();
    let event_window = window.clone();
    window.on_window_event(move |event| {
        // Preserve the latest normal bounds even when the user maximizes before
        // the settle timer fires. Capture is read-only; fitting and disk writes
        // still wait until the native resize/DPI event burst has finished. A
        // synchronous event caused by our own fitting is captured after apply.
        if matches!(event, WindowEvent::Moved(_) | WindowEvent::Resized(_))
            && let Ok(mut state) = event_state.try_lock()
            && let Some(persistence) = &mut state.persistence
            && let Err(error) = persistence.capture(&event_window)
        {
            eprintln!("Could not capture window placement: {error}");
        }
        if matches!(
            event,
            WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed
        ) && let Ok(mut state) = event_state.lock()
            && let Some(persistence) = &mut state.persistence
        {
            if !matches!(event, WindowEvent::Destroyed)
                && let Err(error) = persistence.capture(&event_window)
            {
                eprintln!("Could not capture window placement: {error}");
            }
            // Flush on close as well as after idle. A canceled close can safely
            // retain placement; it does not commit or discard any learning input.
            if let Err(error) = persistence.save() {
                eprintln!("{error:#}");
            }
        }
        if matches!(event, WindowEvent::Destroyed) {
            event_alive.store(false, Ordering::Relaxed);
            let _ = sender.try_send(());
        } else if matches!(
            event,
            WindowEvent::Moved(_)
                | WindowEvent::Resized(_)
                | WindowEvent::ScaleFactorChanged { .. }
                | WindowEvent::Focused(true)
        ) {
            let _ = sender.try_send(());
        }
    });
    let window = window.clone();
    std::thread::Builder::new()
        .name("surtitle-window-fit".into())
        .spawn(move || {
            while receiver.recv().is_ok() && alive.load(Ordering::Relaxed) {
                // WM_DPICHANGED supplies its own size after notifying listeners.
                // Apply after the burst, not in the middle of that native transition.
                while receiver.recv_timeout(Duration::from_millis(100)).is_ok() {
                    if !alive.load(Ordering::Relaxed) {
                        return;
                    }
                }
                if !alive.load(Ordering::Relaxed) {
                    return;
                }
                let target = window.clone();
                let state = state.clone();
                let alive = alive.clone();
                let (complete, completed) = mpsc::sync_channel(1);
                let capture_state = state.clone();
                if window
                    .run_on_main_thread(move || {
                        if alive.load(Ordering::Relaxed)
                            && let Ok(mut state) = capture_state.lock()
                        {
                            if let Err(error) = apply(&target, &mut state) {
                                eprintln!("Could not fit window to monitor work area: {error}");
                            }
                            if let Some(persistence) = &mut state.persistence
                                && let Err(error) = persistence.capture(&target)
                            {
                                eprintln!("Could not capture window placement: {error}");
                            }
                        }
                        let _ = complete.send(());
                    })
                    .is_err()
                {
                    return;
                }
                if completed.recv().is_err() {
                    return;
                }
                // Serialize writes on this existing worker, outside normal UI
                // interaction. Save the newest capture if close raced this task.
                if let Ok(mut state) = state.lock()
                    && let Some(persistence) = &mut state.persistence
                    && let Err(error) = persistence.save()
                {
                    eprintln!("{error:#}");
                }
            }
        })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn environment(width: u32, height: u32, scale: f64) -> Environment {
        Environment {
            origin: PhysicalPosition::new(0, 0),
            size: PhysicalSize::new(width, height),
            scale,
        }
    }

    #[test]
    fn normal_monitor_retains_logical_minimum_and_requested_size() {
        let fit = plan(
            environment(2560, 1400, 1.25),
            PhysicalSize::new(1800, 1175),
            PhysicalSize::new(1816, 1219),
            PhysicalPosition::new(50, 50),
            Insets::default(),
        );
        assert_eq!(fit.minimum, PhysicalSize::new(1600, 900));
        assert_eq!(fit.size, PhysicalSize::new(1800, 1175));
        assert_eq!(fit.position, PhysicalPosition::new(50, 50));
    }

    #[test]
    fn two_hundred_percent_accounts_for_actual_frame_and_fractional_client_height() {
        let fit = plan(
            environment(2560, 1344, 2.0),
            PhysicalSize::new(2880, 1880),
            PhysicalSize::new(2906, 1951),
            PhysicalPosition::new(0, 0),
            Insets::default(),
        );
        assert_eq!(fit.minimum, PhysicalSize::new(2534, 1273));
        assert_eq!(fit.size, PhysicalSize::new(2534, 1273));
        assert_eq!(fit.size.height as f64 / 2.0, 636.5);
        assert_eq!(fit.position, PhysicalPosition::new(0, 0));
    }

    #[test]
    fn smaller_work_area_caps_both_minimum_dimensions() {
        let fit = plan(
            environment(1280, 720, 1.5),
            PhysicalSize::new(2160, 1410),
            PhysicalSize::new(2180, 1465),
            PhysicalPosition::new(400, 300),
            Insets::default(),
        );
        assert_eq!(fit.minimum, PhysicalSize::new(1260, 665));
        assert_eq!(fit.size, fit.minimum);
        assert_eq!(fit.position, PhysicalPosition::new(0, 0));
    }

    #[test]
    fn negative_monitor_origin_and_top_taskbar_remain_physical() {
        let mut area = environment(1920, 1030, 1.0);
        area.origin = PhysicalPosition::new(-1920, 50);
        let fit = plan(
            area,
            PhysicalSize::new(1440, 940),
            PhysicalSize::new(1456, 979),
            PhysicalPosition::new(-1000, -40),
            Insets::default(),
        );
        assert_eq!(fit.position, PhysicalPosition::new(-1456, 50));
        assert_eq!(fit.size, PhysicalSize::new(1440, 940));
    }

    #[test]
    fn dpi_transition_restores_normal_minimum_and_is_idempotent() {
        let compact = plan(
            environment(2560, 1344, 2.0),
            PhysicalSize::new(2880, 1880),
            PhysicalSize::new(2906, 1951),
            PhysicalPosition::new(0, 0),
            Insets::default(),
        );
        let mut destination = environment(1920, 1040, 1.0);
        destination.origin = PhysicalPosition::new(2560, 0);
        let normal = plan(
            destination,
            PhysicalSize::new(compact.size.width / 2, compact.size.height / 2),
            PhysicalSize::new(compact.size.width / 2 + 16, compact.size.height / 2 + 39),
            PhysicalPosition::new(2600, 100),
            Insets::default(),
        );
        assert_eq!(normal.minimum, PhysicalSize::new(1280, 720));
        assert_eq!(normal.size, PhysicalSize::new(1280, 720));
        assert_eq!(
            plan(
                destination,
                normal.size,
                PhysicalSize::new(normal.size.width + 16, normal.size.height + 39),
                normal.position,
                Insets::default(),
            ),
            normal
        );
    }

    #[test]
    fn invisible_resize_borders_remain_outside_without_moving_the_visible_frame() {
        let area = environment(1920, 1040, 1.0);
        let inner = PhysicalSize::new(1280, 720);
        let outer = PhysicalSize::new(1296, 759);
        let insets = Insets {
            left: 7,
            top: 0,
            right: 7,
            bottom: 7,
        };
        for position in [
            PhysicalPosition::new(-7, 0),
            PhysicalPosition::new(631, 288),
        ] {
            let fit = plan(area, inner, outer, position, insets);
            assert_eq!(fit.position, position);
            assert_eq!(fit.size, inner);
        }
        let large = plan(
            area,
            PhysicalSize::new(1920, 1080),
            PhysicalSize::new(1936, 1119),
            PhysicalPosition::new(100, 100),
            insets,
        );
        assert_eq!(large.size, PhysicalSize::new(1918, 1008));
        assert_eq!(large.position, PhysicalPosition::new(-7, 0));
    }

    #[test]
    fn all_presets_use_the_same_work_area_policy_and_reject_unknown_ids() {
        for (id, expected) in [
            ("hd", (1280, 720)),
            ("standard", (1600, 900)),
            ("full-hd", (1920, 1080)),
        ] {
            let requested = preset_size(id).unwrap();
            assert_eq!(requested, PhysicalSize::from(expected));
            let fit = plan(
                environment(3840, 2160, 1.0),
                requested,
                PhysicalSize::new(requested.width + 16, requested.height + 39),
                PhysicalPosition::new(20, 20),
                Insets::default(),
            );
            assert_eq!(fit.size, requested);
            let small = plan(
                environment(1024, 720, 1.0),
                requested,
                PhysicalSize::new(requested.width + 16, requested.height + 39),
                PhysicalPosition::new(20, 20),
                Insets::default(),
            );
            assert_eq!(small.size, PhysicalSize::new(1008, 681));
        }
        assert!(preset_size("custom").is_err());
    }
}
