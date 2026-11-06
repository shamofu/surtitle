use super::*;
use std::{
    fs::File,
    process::{Command, Stdio},
};

struct Empty;
impl Render for Empty {
    fn render(&mut self, _: &mut Window, _: &mut gpui::Context<Self>) -> impl IntoElement {
        div()
    }
}

#[::core::prelude::v1::test]
fn startup_display_change_is_deferred_and_pending_notifications_respect_close() {
    const CHILD: &str = "GPUI_DISPLAY_CHANGE_REGRESSION_CHILD";
    if std::env::var_os(CHILD).is_some() {
        run_hidden_application();
        return;
    }
    // A synchronous callback panics across the native window-procedure ABI and
    // aborts. Keep that regression isolated from the rest of the test process.
    let log = std::env::temp_dir().join(format!("gpui-display-change-{}.log", std::process::id()));
    let output = File::create(&log).unwrap();
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "window::display_change_tests::startup_display_change_is_deferred_and_pending_notifications_respect_close", "--nocapture"])
        .env(CHILD, "1")
        .env("GPUI_DISABLE_DIRECT_COMPOSITION", "true")
        .env("RUST_BACKTRACE", "0")
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
            panic!(
                "hidden display-change regression timed out; {}",
                log.display()
            );
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    assert!(
        status.success(),
        "hidden application failed: {status}\n{}",
        std::fs::read_to_string(&log).unwrap()
    );
}

fn run_hidden_application() {
    let platform = Rc::new(WindowsPlatform::new(false).unwrap());
    Application::with_platform(platform)
        .with_quit_mode(QuitMode::Explicit)
        .run(|cx| {
            let mut windows = Vec::new();
            for mode in 0..3 {
                let handle = cx
                    .open_window(
                        WindowOptions {
                            show: false,
                            focus: false,
                            window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
                                None,
                                size(px(320.), px(240.)),
                                cx,
                            ))),
                            ..Default::default()
                        },
                        |_, cx| cx.new(|_| Empty),
                    )
                    .unwrap();
                let hwnd = handle
                    .update(cx, |_, window, _| {
                        let rwh::RawWindowHandle::Win32(raw) =
                            rwh::HasWindowHandle::window_handle(window)
                                .unwrap()
                                .as_raw()
                        else {
                            panic!("native Windows handle");
                        };
                        HWND(raw.hwnd.get() as _)
                    })
                    .unwrap();
                assert!(!unsafe { IsWindowVisible(hwnd) }.as_bool());
                let native = window_from_hwnd(hwnd).unwrap();
                let calls = Rc::new(Cell::new(0));
                let observed = calls.clone();
                let mut callback = native.state.callbacks.display_changed.take().unwrap();
                let mut async_cx = cx.to_async();
                native
                    .state
                    .callbacks
                    .display_changed
                    .set(Some(Box::new(move || {
                        observed.set(observed.get() + 1);
                        callback(); // Exercise the actual GPUI AsyncApp callback.
                        if mode == 2 {
                            handle
                                .update(&mut async_cx, |_, window, _| window.remove_window())
                                .unwrap();
                        }
                    })));
                let actual = native.state.display.get().display_id;
                let mut stale = native.state.display.get();
                stale.display_id = DisplayId::new(u64::MAX);
                native.state.display.set(stale);
                // Application::run still owns its real App RefCell borrow here.
                unsafe {
                    SendMessageW(hwnd, WM_DISPLAYCHANGE, None, None);
                }
                assert_eq!(
                    native.state.display.get().display_id,
                    actual,
                    "native display state updates immediately"
                );
                assert_eq!(
                    calls.get(),
                    0,
                    "App callback must not run inside the native message"
                );
                unsafe {
                    SendMessageW(hwnd, WM_DISPLAYCHANGE, None, None);
                }
                if mode == 1 {
                    handle
                        .update(cx, |_, window, _| window.remove_window())
                        .unwrap();
                }
                // Retain the inner state just as asynchronous native teardown does.
                windows.push((handle, hwnd, native, calls));
            }
            cx.spawn(async move |cx| {
                let deadline = Instant::now() + Duration::from_secs(5);
                loop {
                    let delivered = windows[0].3.get() == 2 && windows[2].3.get() == 1;
                    let closed = !unsafe { IsWindow(Some(windows[1].1)) }.as_bool()
                        && !unsafe { IsWindow(Some(windows[2].1)) }.as_bool();
                    if delivered && closed {
                        break;
                    }
                    assert!(
                        Instant::now() < deadline,
                        "queued display changes or close did not complete"
                    );
                    cx.background_executor()
                        .timer(Duration::from_millis(5))
                        .await;
                }
                assert_eq!(
                    windows[1].3.get(),
                    0,
                    "closing before delivery retires the callback"
                );
                assert!(
                    windows[2]
                        .2
                        .state
                        .callbacks
                        .display_changed
                        .take()
                        .is_none(),
                    "closing during delivery must not reinstall the callback"
                );
                cx.update(|app| {
                    assert_eq!(
                        app.windows().len(),
                        1,
                        "App remains responsive after native notifications"
                    );
                    windows[0]
                        .0
                        .update(app, |_, window, _| window.remove_window())
                        .unwrap();
                    app.quit();
                });
            })
            .detach();
        });
}
