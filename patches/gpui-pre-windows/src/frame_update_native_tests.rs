use super::*;
use crate::WindowsPlatform;
use gpui::*;
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use std::{
    fs::File,
    process::{Command, Stdio},
    rc::Rc,
};
use windows::Win32::UI::WindowsAndMessaging::*;

struct Empty;
impl Render for Empty {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
    }
}

#[::core::prelude::v1::test]
fn idle_native_window_retries_failed_submission_and_returns_to_idle() {
    const CHILD: &str = "GPUI_FRAME_RETRY_REGRESSION_CHILD";
    if std::env::var_os(CHILD).is_some() {
        run_application();
        return;
    }
    // GPUI's native event-loop globals belong to one process. Isolate this
    // real WM_PAINT/request_frame exercise from other platform tests.
    let log = std::env::temp_dir().join(format!("gpui-frame-retry-{}.log", std::process::id()));
    let output = File::create(&log).unwrap();
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "frame_update::native_tests::idle_native_window_retries_failed_submission_and_returns_to_idle", "--nocapture"])
        .env(CHILD, "1")
        .env("GPUI_DISABLE_DIRECT_COMPOSITION", "true")
        .stdout(Stdio::from(output.try_clone().unwrap()))
        .stderr(Stdio::from(output))
        .spawn().unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if Instant::now() >= deadline {
            child.kill().unwrap();
            let _ = child.wait();
            panic!("native retry regression timed out; {}", log.display());
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    assert!(
        status.success(),
        "native retry regression failed: {status}\n{}",
        std::fs::read_to_string(log).unwrap()
    );
}

fn run_application() {
    Application::with_platform(Rc::new(WindowsPlatform::new(false).unwrap()))
        .with_quit_mode(QuitMode::Explicit)
        .run(|cx| {
            let handle = cx
                .open_window(
                    WindowOptions {
                        show: false,
                        focus: false,
                        window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                            point(px(0.), px(0.)),
                            size(px(120.), px(80.)),
                        ))),
                        ..Default::default()
                    },
                    |_, cx| cx.new(|_| Empty),
                )
                .unwrap();
            let hwnd = handle
                .update(cx, |_, window, _| {
                    let RawWindowHandle::Win32(raw) = window.window_handle().unwrap().as_raw()
                    else {
                        panic!("Windows handle");
                    };
                    HWND(raw.hwnd.get() as _)
                })
                .unwrap();
            let native = window_from_hwnd(hwnd).unwrap();
            cx.spawn(async move |cx| {
                unsafe {
                    let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
                }
                cx.background_executor()
                    .timer(Duration::from_millis(120))
                    .await;
                let forced = Rc::new(Cell::new(0));
                let forced_calls = forced.clone();
                let mut request = native.state.callbacks.request_frame.take().unwrap();
                native
                    .state
                    .callbacks
                    .request_frame
                    .set(Some(Box::new(move |options| {
                        if options.force_render {
                            forced_calls.set(forced_calls.get() + 1);
                        }
                        request(options); // Actual GPUI clean-window demand handling.
                    })));
                let geometry = Rc::new(Cell::new(10));
                let updated = geometry.clone();
                native.state.frame_update.stage(Box::new(move || {
                    let previous = updated.replace(20);
                    let updated = updated.clone();
                    Ok(Some(Box::new(move || updated.set(previous))))
                }));
                assert!(
                    native
                        .state
                        .frame_update
                        .present(Ok(true), || anyhow::bail!("injected Present failure"))
                        .is_err()
                );
                assert_eq!(geometry.get(), 10);
                native
                    .state
                    .frame_update
                    .retry_at
                    .set(Some(Instant::now() + Duration::from_millis(100)));
                unsafe {
                    SendMessageW(hwnd, WM_PAINT, None, None);
                }
                assert_eq!(forced.get(), 0, "no forced work before retry deadline");
                assert_eq!(
                    geometry.get(),
                    10,
                    "clean frame must not consume pending geometry early"
                );
                let deadline = Instant::now() + Duration::from_secs(5);
                while geometry.get() != 20 {
                    assert!(
                        Instant::now() < deadline,
                        "idle window never retried its failed submission"
                    );
                    cx.background_executor()
                        .timer(Duration::from_millis(5))
                        .await;
                }
                assert!(
                    forced.get() > 0,
                    "retry must reach GPUI's force-render demand"
                );
                assert!(native.state.frame_update.retry_at.get().is_none());
                let completed_forces = forced.get();
                cx.background_executor()
                    .timer(Duration::from_millis(120))
                    .await;
                assert_eq!(
                    forced.get(),
                    completed_forces,
                    "success must leave no retry animation demand"
                );
                cx.update(|cx| {
                    handle
                        .update(cx, |_, window, _| window.remove_window())
                        .unwrap();
                    cx.quit();
                });
            })
            .detach();
        });
}
