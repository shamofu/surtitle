//! Keep the normal window and its minimum client size within the active work area.
//! All geometry is physical: mixed-DPI monitor origins are not logical coordinates.
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
    mpsc,
};
use std::time::Duration;
use tauri::{PhysicalPosition, PhysicalSize, WebviewWindow, WindowEvent};

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
) -> Fit {
    let frame = PhysicalSize::new(
        outer.width.saturating_sub(inner.width),
        outer.height.saturating_sub(inner.height),
    );
    let available = PhysicalSize::new(
        environment.size.width.saturating_sub(frame.width).max(1),
        environment.size.height.saturating_sub(frame.height).max(1),
    );
    // Floor before clamping so fractional DPI never adds a pixel outside the work area.
    let minimum = PhysicalSize::new(
        ((1024.0 * environment.scale).floor() as u32).clamp(1, available.width),
        ((700.0 * environment.scale).floor() as u32).clamp(1, available.height),
    );
    let size = PhysicalSize::new(
        inner.width.clamp(minimum.width, available.width),
        inner.height.clamp(minimum.height, available.height),
    );
    let clamp_axis = |current: i32, origin: i32, area: u32, client: u32, border: u32| {
        let start = i64::from(origin);
        let end = start + i64::from(area.saturating_sub(client.saturating_add(border)));
        i64::from(current).clamp(start, end) as i32
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
                frame.width,
            ),
            clamp_axis(
                position.y,
                environment.origin.y,
                environment.size.height,
                size.height,
                frame.height,
            ),
        ),
    }
}

#[derive(Default)]
struct State {
    environment: Option<Environment>,
    minimum: Option<PhysicalSize<u32>>,
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
    let fit = plan(environment, inner, window.outer_size()?, position);
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

pub fn install(window: &WebviewWindow) -> anyhow::Result<()> {
    let mut initial = State::default();
    apply(window, &mut initial)?;
    let state = Arc::new(Mutex::new(initial));
    let alive = Arc::new(AtomicBool::new(true));
    let (sender, receiver) = mpsc::sync_channel(1);
    let event_alive = alive.clone();
    window.on_window_event(move |event| {
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
                if window
                    .run_on_main_thread(move || {
                        if alive.load(Ordering::Relaxed)
                            && let Ok(mut state) = state.lock()
                            && let Err(error) = apply(&target, &mut state)
                        {
                            eprintln!("Could not fit window to monitor work area: {error}");
                        }
                    })
                    .is_err()
                {
                    return;
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
        );
        assert_eq!(fit.minimum, PhysicalSize::new(1280, 875));
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
        );
        assert_eq!(fit.minimum, PhysicalSize::new(2048, 1273));
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
        );
        let mut destination = environment(1920, 1040, 1.0);
        destination.origin = PhysicalPosition::new(2560, 0);
        let normal = plan(
            destination,
            PhysicalSize::new(compact.size.width / 2, compact.size.height / 2),
            PhysicalSize::new(compact.size.width / 2 + 16, compact.size.height / 2 + 39),
            PhysicalPosition::new(2600, 100),
        );
        assert_eq!(normal.minimum, PhysicalSize::new(1024, 700));
        assert_eq!(normal.size, PhysicalSize::new(1267, 700));
        assert_eq!(
            plan(
                destination,
                normal.size,
                PhysicalSize::new(normal.size.width + 16, normal.size.height + 39),
                normal.position
            ),
            normal
        );
    }
}
