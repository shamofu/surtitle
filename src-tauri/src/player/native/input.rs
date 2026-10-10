use anyhow::{Result, ensure};
use std::{cell::Cell, sync::Arc};
use windows_sys::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM},
    UI::{
        Input::KeyboardAndMouse::{GetCapture, ReleaseCapture, SetCapture},
        WindowsAndMessaging::*,
    },
};

struct SurfaceInput {
    original: WNDPROC,
    click: Arc<dyn Fn() + Send + Sync>,
    pressed: Cell<Option<(i32, i32)>>,
}

/// Only our GUI-thread host is subclassed. In wid mode mpv creates a disabled
/// child on its own thread, so Windows routes its mouse input to this host.
pub(super) fn install(hwnd: HWND, click: Arc<dyn Fn() + Send + Sync>) -> Result<()> {
    unsafe {
        ensure!(
            GetWindowLongPtrW(hwnd, GWLP_USERDATA) == 0,
            "video click handler is already installed"
        );
        let original = GetWindowLongPtrW(hwnd, GWLP_WNDPROC);
        ensure!(original != 0, "invalid video host window");
        let input = Box::into_raw(Box::new(SurfaceInput {
            original: std::mem::transmute::<isize, WNDPROC>(original),
            click,
            pressed: Cell::new(None),
        }));
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, input as isize);
        if GetWindowLongPtrW(hwnd, GWLP_USERDATA) != input as isize {
            drop(Box::from_raw(input));
            anyhow::bail!("could not install video click handler");
        }
        if SetWindowLongPtrW(hwnd, GWLP_WNDPROC, surface_proc as *const () as isize) == 0 {
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
            drop(Box::from_raw(input));
            anyhow::bail!("could not subclass video host");
        }
    }
    Ok(())
}

fn point(value: LPARAM) -> (i32, i32) {
    (value as i16 as i32, (value >> 16) as i16 as i32)
}

unsafe fn inside(hwnd: HWND, (x, y): (i32, i32)) -> bool {
    let mut rect: RECT = unsafe { std::mem::zeroed() };
    (unsafe { GetClientRect(hwnd, &mut rect) != 0 })
        && x >= 0
        && y >= 0
        && x < rect.right
        && y < rect.bottom
}

unsafe fn moved((x, y): (i32, i32), (next_x, next_y): (i32, i32)) -> bool {
    (next_x - x).abs() > unsafe { GetSystemMetrics(SM_CXDRAG) }.max(1)
        || (next_y - y).abs() > unsafe { GetSystemMetrics(SM_CYDRAG) }.max(1)
}

unsafe extern "system" fn surface_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    // No Rust borrow is held across a Win32 call: releasing capture and emitting
    // an event may re-enter a window procedure or destroy the host.
    unsafe {
        let input = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const SurfaceInput;
        if input.is_null() {
            return DefWindowProcW(hwnd, message, wparam, lparam);
        }
        let original = (*input).original;
        match message {
            // STATIC otherwise returns HTTRANSPARENT and passes clicks through
            // the video to a sibling webview. No parent STN_CLICKED is needed.
            WM_NCHITTEST => return HTCLIENT as LRESULT,
            WM_LBUTTONDOWN | WM_LBUTTONDBLCLK => {
                let position = point(lparam);
                if IsWindowVisible(hwnd) != 0 && inside(hwnd, position) {
                    (*input).pressed.set(Some(position));
                    SetCapture(hwnd);
                }
                return 0;
            }
            WM_MOUSEMOVE => {
                if let Some(start) = (*input).pressed.get() {
                    let position = point(lparam);
                    if moved(start, position) || !inside(hwnd, position) {
                        (*input).pressed.set(None);
                    }
                }
            }
            WM_LBUTTONUP => {
                let click = (*input)
                    .pressed
                    .take()
                    .filter(|start| {
                        IsWindowVisible(hwnd) != 0
                            && inside(hwnd, point(lparam))
                            && !moved(*start, point(lparam))
                    })
                    .map(|_| Arc::clone(&(*input).click));
                if GetCapture() == hwnd {
                    ReleaseCapture();
                }
                if let Some(click) = click {
                    // Never unwind a caller-supplied callback through the ABI.
                    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| click()));
                }
                return 0;
            }
            WM_CANCELMODE | WM_SHOWWINDOW if message == WM_CANCELMODE || wparam == 0 => {
                (*input).pressed.set(None);
                if GetCapture() == hwnd {
                    ReleaseCapture();
                }
            }
            WM_CAPTURECHANGED => (*input).pressed.set(None),
            WM_NCDESTROY => {
                SetWindowLongPtrW(
                    hwnd,
                    GWLP_WNDPROC,
                    std::mem::transmute::<WNDPROC, isize>(original),
                );
                SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
                drop(Box::from_raw(input as *mut SurfaceInput));
            }
            _ => {}
        }
        CallWindowProcW(original, hwnd, message, wparam, lparam)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        ptr,
        sync::atomic::{AtomicUsize, Ordering},
    };

    struct Window(HWND);
    impl Window {
        fn new(parent: HWND, style: u32) -> Self {
            let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
            let hwnd = unsafe {
                CreateWindowExW(
                    0,
                    class.as_ptr(),
                    ptr::null(),
                    style,
                    if parent.is_null() { -32000 } else { 0 },
                    0,
                    100,
                    100,
                    parent,
                    ptr::null_mut(),
                    ptr::null_mut(),
                    ptr::null(),
                )
            };
            assert!(!hwnd.is_null());
            Self(hwnd)
        }
    }
    impl Drop for Window {
        fn drop(&mut self) {
            unsafe {
                DestroyWindow(self.0);
            }
        }
    }
    fn at(x: i16, y: i16) -> LPARAM {
        ((y as u16 as u32) << 16 | x as u16 as u32) as LPARAM
    }
    fn send(hwnd: HWND, message: u32, x: i16, y: i16) {
        unsafe {
            SendMessageW(hwnd, message, 0, at(x, y));
        }
    }

    #[test]
    fn clicks_are_local_and_drags_right_clicks_and_cancelled_presses_are_ignored() {
        let parent = Window::new(ptr::null_mut(), WS_POPUP | WS_VISIBLE);
        let host = Window::new(parent.0, WS_CHILD | WS_VISIBLE);
        let sibling = Window::new(parent.0, WS_CHILD | WS_VISIBLE);
        let decoder = Window::new(host.0, WS_CHILD | WS_VISIBLE | WS_DISABLED);
        let clicks = Arc::new(AtomicUsize::new(0));
        let observed = clicks.clone();
        install(
            host.0,
            Arc::new(move || {
                observed.fetch_add(1, Ordering::Relaxed);
            }),
        )
        .unwrap();
        unsafe {
            assert_eq!(SendMessageW(host.0, WM_NCHITTEST, 0, 0), HTCLIENT as isize);
            assert_ne!(
                GetWindowLongPtrW(decoder.0, GWL_STYLE) as u32 & WS_DISABLED,
                0
            );
            assert_eq!(
                ChildWindowFromPointEx(
                    host.0,
                    windows_sys::Win32::Foundation::POINT { x: 10, y: 10 },
                    CWP_SKIPDISABLED
                ),
                host.0
            );
        }
        for down in [WM_LBUTTONDOWN, WM_LBUTTONDBLCLK] {
            send(host.0, down, 10, 10);
            send(host.0, WM_LBUTTONUP, 10, 10);
        }
        assert_eq!(clicks.load(Ordering::Relaxed), 2);
        for target in [sibling.0, parent.0] {
            send(target, WM_LBUTTONDOWN, 10, 10);
            send(target, WM_LBUTTONUP, 10, 10);
        }
        send(host.0, WM_RBUTTONDOWN, 10, 10);
        send(host.0, WM_RBUTTONUP, 10, 10);
        send(host.0, WM_LBUTTONUP, 10, 10); // No matching press.
        send(host.0, WM_LBUTTONDOWN, 10, 10);
        send(host.0, WM_MOUSEMOVE, 80, 80);
        send(host.0, WM_LBUTTONUP, 10, 10); // Dragging back is still a drag.
        send(host.0, WM_LBUTTONDOWN, 10, 10);
        send(host.0, WM_LBUTTONUP, -1, 10);
        send(host.0, WM_LBUTTONDOWN, 10, 10);
        send(host.0, WM_CANCELMODE, 0, 0);
        send(host.0, WM_LBUTTONUP, 10, 10);
        send(host.0, WM_LBUTTONDOWN, 10, 10);
        unsafe {
            SetCapture(sibling.0);
        }
        send(host.0, WM_LBUTTONUP, 10, 10);
        unsafe {
            ReleaseCapture();
        }
        send(host.0, WM_LBUTTONDOWN, 10, 10);
        unsafe {
            ShowWindow(host.0, SW_HIDE);
            ShowWindow(host.0, SW_SHOWNOACTIVATE);
        }
        send(host.0, WM_LBUTTONUP, 10, 10);
        assert_eq!(clicks.load(Ordering::Relaxed), 2);
    }

    #[test]
    fn callback_lives_until_host_destruction_and_duplicate_install_is_rejected() {
        let parent = Window::new(ptr::null_mut(), WS_POPUP);
        let host = Window::new(parent.0, WS_CHILD);
        let held = Arc::new(());
        let weak = Arc::downgrade(&held);
        install(
            host.0,
            Arc::new(move || {
                let _ = &held;
            }),
        )
        .unwrap();
        assert!(install(host.0, Arc::new(|| {})).is_err());
        assert!(weak.upgrade().is_some());
        drop(host);
        assert!(weak.upgrade().is_none());
        assert!(install(ptr::null_mut(), Arc::new(|| {})).is_err());
    }
}
