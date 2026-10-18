//! Main-window drag snapping. Keep this subclass independent of Tauri's own
//! window procedure and user data, and never move/resize from WM_MOVE itself.
use super::{Environment, Insets, snapping};
use std::cell::Cell;
use tauri::{PhysicalPosition, PhysicalSize, WebviewWindow};
use windows_sys::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
    Graphics::{
        Dwm::{DWMWA_EXTENDED_FRAME_BOUNDS, DwmGetWindowAttribute},
        Gdi::{GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromRect},
    },
    UI::{
        HiDpi::GetDpiForWindow,
        Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON},
        Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
        WindowsAndMessaging::{
            GetCursorPos, GetSystemMetrics, GetWindowRect, IsIconic, IsZoomed, SM_SWAPBUTTON,
            WM_ENTERSIZEMOVE, WM_EXITSIZEMOVE, WM_MOVING, WM_NCDESTROY,
        },
    },
};

const SUBCLASS_ID: usize = 0x5355_5254;

struct DragState {
    // DWM updates may trail the current drag rectangle. Cache resize borders
    // within one DPI so animation/compositor latency cannot move the snap edge.
    measured: Cell<Option<(u32, Insets)>>,
    drag: Cell<Option<snapping::Drag>>,
    pointer_drag: Cell<bool>,
}

fn primary_button_down() -> bool {
    let button = if unsafe { GetSystemMetrics(SM_SWAPBUTTON) } == 0 {
        VK_LBUTTON
    } else {
        VK_RBUTTON
    };
    unsafe { GetAsyncKeyState(i32::from(button)) < 0 }
}

fn cursor_position() -> Option<PhysicalPosition<i32>> {
    let mut point = POINT::default();
    (unsafe { GetCursorPos(&mut point) } != 0).then(|| PhysicalPosition::new(point.x, point.y))
}

fn geometry(hwnd: HWND, rectangle: &RECT, state: &DragState) -> Option<snapping::Geometry> {
    let width = i64::from(rectangle.right) - i64::from(rectangle.left);
    let height = i64::from(rectangle.bottom) - i64::from(rectangle.top);
    if width <= 0 || height <= 0 || width > i64::from(i32::MAX) || height > i64::from(i32::MAX) {
        return None;
    }
    let monitor = unsafe { MonitorFromRect(rectangle, MONITOR_DEFAULTTONEAREST) };
    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    if monitor.is_null() || unsafe { GetMonitorInfoW(monitor, &mut info) } == 0 {
        return None;
    }
    let dpi = unsafe { GetDpiForWindow(hwnd) }.max(96);
    let insets = match state.measured.get() {
        Some((old, insets)) if old == dpi => insets,
        previous => measured_insets(hwnd).unwrap_or_else(|| {
            previous
                .map(|(old, insets)| insets.scaled(f64::from(dpi) / f64::from(old)))
                .unwrap_or_default()
        }),
    };
    state.measured.set(Some((dpi, insets)));
    Some(snapping::Geometry {
        environment: Environment {
            origin: PhysicalPosition::new(info.rcWork.left, info.rcWork.top),
            size: PhysicalSize::new(
                (info.rcWork.right - info.rcWork.left) as u32,
                (info.rcWork.bottom - info.rcWork.top) as u32,
            ),
            scale: f64::from(dpi) / 96.0,
        },
        outer: PhysicalSize::new(width as u32, height as u32),
        insets,
    })
}

fn measured_insets(hwnd: HWND) -> Option<Insets> {
    let mut outer = RECT::default();
    let mut visible = RECT::default();
    unsafe {
        if GetWindowRect(hwnd, &mut outer) == 0
            || DwmGetWindowAttribute(
                hwnd,
                DWMWA_EXTENDED_FRAME_BOUNDS as u32,
                (&mut visible as *mut RECT).cast(),
                std::mem::size_of::<RECT>() as u32,
            ) < 0
        {
            return None;
        }
    }
    if visible.right <= visible.left
        || visible.bottom <= visible.top
        || visible.left < outer.left
        || visible.top < outer.top
        || visible.right > outer.right
        || visible.bottom > outer.bottom
    {
        return None;
    }
    Some(Insets {
        left: (i64::from(visible.left) - i64::from(outer.left)) as u32,
        top: (i64::from(visible.top) - i64::from(outer.top)) as u32,
        right: (i64::from(outer.right) - i64::from(visible.right)) as u32,
        bottom: (i64::from(outer.bottom) - i64::from(visible.bottom)) as u32,
    })
}

pub(super) fn insets(hwnd: HWND) -> Insets {
    measured_insets(hwnd).unwrap_or_default()
}

pub(super) fn install(window: &WebviewWindow) -> anyhow::Result<()> {
    install_hwnd(window.hwnd()?.0)
}

fn install_hwnd(hwnd: HWND) -> anyhow::Result<()> {
    let state = Box::into_raw(Box::new(DragState {
        measured: Cell::new(None),
        drag: Cell::new(None),
        pointer_drag: Cell::new(false),
    }));
    // Called during setup on the owning GUI thread; comctl subclass helpers
    // cannot cross threads. Pair the allocation with WM_NCDESTROY cleanup.
    if unsafe { SetWindowSubclass(hwnd, Some(window_proc), SUBCLASS_ID, state as usize) } == 0 {
        unsafe {
            drop(Box::from_raw(state));
        }
        anyhow::bail!("Could not install window edge snapping");
    }
    Ok(())
}

unsafe extern "system" fn window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    id: usize,
    data: usize,
) -> LRESULT {
    let state = unsafe { &*(data as *const DragState) };
    match message {
        WM_ENTERSIZEMOVE => {
            state.measured.set(None);
            state.drag.set(None);
            // Fix the input policy for this loop. Keyboard/system moves must
            // retain the OS proposal even if Windows relocates the cursor.
            state.pointer_drag.set(primary_button_down());
            let mut rectangle = RECT::default();
            if unsafe { GetWindowRect(hwnd, &mut rectangle) } != 0
                && let Some(geometry) = geometry(hwnd, &rectangle, state)
            {
                state.drag.set(Some(snapping::Drag::new(
                    geometry,
                    PhysicalPosition::new(rectangle.left, rectangle.top),
                    state.pointer_drag.get().then(cursor_position).flatten(),
                )));
            }
        }
        WM_EXITSIZEMOVE => {
            state.measured.set(None);
            state.drag.set(None);
            state.pointer_drag.set(false);
        }
        WM_MOVING if lparam != 0 && unsafe { IsIconic(hwnd) == 0 && IsZoomed(hwnd) == 0 } => {
            let rectangle = unsafe { &mut *(lparam as *mut RECT) };
            if let Some(mut drag) = state.drag.get()
                && let Some(geometry) = geometry(hwnd, rectangle, state)
            {
                let position = drag.position(
                    geometry,
                    PhysicalPosition::new(rectangle.left, rectangle.top),
                    state.pointer_drag.get().then(cursor_position).flatten(),
                );
                state.drag.set(Some(drag));
                // Keep the system's dimensions, including during DPI changes.
                if let (Some(right), Some(bottom)) = (
                    position.x.checked_add(geometry.outer.width as i32),
                    position.y.checked_add(geometry.outer.height as i32),
                ) {
                    *rectangle = RECT {
                        left: position.x,
                        top: position.y,
                        right,
                        bottom,
                    };
                    return 1;
                }
            } else {
                state.drag.set(None);
            }
        }
        WM_NCDESTROY => unsafe {
            RemoveWindowSubclass(hwnd, Some(window_proc), id);
            drop(Box::from_raw(data as *mut DragState));
        },
        _ => {}
    }
    unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, SendMessageW, SetWindowPos, WS_OVERLAPPEDWINDOW,
    };

    #[test]
    fn owned_native_subclass_preserves_alignment_and_clears_finished_drags() {
        unsafe {
            let class: Vec<_> = "STATIC\0".encode_utf16().collect();
            let hwnd = CreateWindowExW(
                0,
                class.as_ptr(),
                std::ptr::null(),
                WS_OVERLAPPEDWINDOW,
                50,
                50,
                800,
                500,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null(),
            );
            assert!(!hwnd.is_null(), "Could not create the owned test window");
            install_hwnd(hwnd).unwrap();
            let mut rect = RECT::default();
            assert_ne!(GetWindowRect(hwnd, &mut rect), 0);
            let monitor = MonitorFromRect(&rect, MONITOR_DEFAULTTONEAREST);
            let mut info = MONITORINFO {
                cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                ..Default::default()
            };
            assert_ne!(GetMonitorInfoW(monitor, &mut info), 0);
            let border = insets(hwnd);
            let left = info.rcWork.left - border.left as i32;
            let top = info.rcWork.top - border.top as i32;
            assert_ne!(
                SetWindowPos(hwnd, std::ptr::null_mut(), left, top, 800, 500, 0x0014),
                0
            );
            SendMessageW(hwnd, WM_ENTERSIZEMOVE, 0, 0);
            let mut proposed = RECT {
                left,
                top,
                right: left + 800,
                bottom: top + 500,
            };
            assert_eq!(
                SendMessageW(hwnd, WM_MOVING, 0, (&mut proposed as *mut RECT) as isize),
                1
            );
            assert_eq!(proposed.left + border.left as i32, info.rcWork.left);
            assert_eq!(proposed.top + border.top as i32, info.rcWork.top);
            assert_eq!(
                (
                    proposed.right - proposed.left,
                    proposed.bottom - proposed.top
                ),
                (800, 500)
            );
            SendMessageW(hwnd, WM_EXITSIZEMOVE, 0, 0);
            proposed.left += 4;
            proposed.right += 4;
            SendMessageW(hwnd, WM_MOVING, 0, (&mut proposed as *mut RECT) as isize);
            assert_eq!(
                proposed.left,
                left + 4,
                "Finished drag must not retain its anchor"
            );
            assert_ne!(DestroyWindow(hwnd), 0);
        }
    }
}
