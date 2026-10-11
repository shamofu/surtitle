use super::{Bounds, SurfaceRect};
use anyhow::{Result, ensure};
use windows_sys::Win32::{Foundation::HWND, Graphics::Gdi::*};

struct Region(HRGN);
impl Region {
    fn rectangle(rect: [i32; 4]) -> Result<Self> {
        let handle = unsafe { CreateRectRgn(rect[0], rect[1], rect[2], rect[3]) };
        ensure!(
            !handle.is_null(),
            "could not allocate video clipping region"
        );
        Ok(Self(handle))
    }
}
impl Drop for Region {
    fn drop(&mut self) {
        unsafe {
            DeleteObject(self.0);
        }
    }
}

fn rectangle(bounds: &Bounds, rect: &SurfaceRect, exclude: bool) -> [i32; 4] {
    let scale = bounds.scale_factor;
    let origin = [(bounds.x * scale).round(), (bounds.y * scale).round()];
    let size = [
        (bounds.width * scale).round().max(0.),
        (bounds.height * scale).round().max(0.),
    ];
    let low = |value: f64| if exclude { value.floor() } else { value.ceil() };
    let high = |value: f64| if exclude { value.ceil() } else { value.floor() };
    let left = low(rect.x * scale - origin[0]).clamp(0., size[0]) as i32;
    let top = low(rect.y * scale - origin[1]).clamp(0., size[1]) as i32;
    let right = high((rect.x + rect.width) * scale - origin[0]).clamp(0., size[0]) as i32;
    let bottom = high((rect.y + rect.height) * scale - origin[1]).clamp(0., size[1]) as i32;
    [left, top, right.max(left), bottom.max(top)]
}

/// All coordinates are converted relative to the same physical window origin.
/// Exclusions round outward so fractional DPI never leaves a native pixel above UI.
pub(super) fn apply(hwnd: HWND, bounds: &Bounds) -> Result<()> {
    let full = [
        0,
        0,
        (bounds.width * bounds.scale_factor).round() as i32,
        (bounds.height * bounds.scale_factor).round() as i32,
    ];
    let region = Region::rectangle(
        bounds
            .clip
            .as_ref()
            .map_or(full, |clip| rectangle(bounds, clip, false)),
    )?;
    for exclusion in &bounds.occlusions {
        if exclusion.width <= 0. || exclusion.height <= 0. {
            continue;
        }
        let hole = Region::rectangle(rectangle(bounds, exclusion, true))?;
        ensure!(
            unsafe { CombineRgn(region.0, region.0, hole.0, RGN_DIFF) } != RGN_ERROR,
            "could not subtract video occlusion"
        );
    }
    ensure!(
        unsafe { SetWindowRgn(hwnd, region.0, 1) } != 0,
        "could not apply video clipping: {}",
        std::io::Error::last_os_error()
    );
    // SetWindowRgn takes ownership only on success.
    std::mem::forget(region);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ptr;
    use windows_sys::Win32::UI::WindowsAndMessaging::*;

    #[test]
    fn fractional_occlusions_round_outward_and_page_clip_rounds_inward() {
        let bounds = Bounds {
            x: 10.2,
            y: 20.2,
            width: 100.,
            height: 80.,
            scale_factor: 1.25,
            clip: None,
            occlusions: vec![],
            input_blocked: false,
        };
        let rect = SurfaceRect {
            x: 11.,
            y: 21.,
            width: 10.1,
            height: 10.1,
        };
        assert_eq!(rectangle(&bounds, &rect, true), [0, 1, 14, 14]);
        assert_eq!(rectangle(&bounds, &rect, false), [1, 2, 13, 13]);
        let outside = SurfaceRect {
            x: -100.,
            y: -100.,
            width: 1.,
            height: 1.,
        };
        assert_eq!(rectangle(&bounds, &outside, true), [0, 0, 0, 0]);
    }

    #[test]
    fn window_region_preserves_video_excludes_overlapping_cards_and_resets() {
        unsafe {
            let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
            let host = CreateWindowExW(
                0,
                class.as_ptr(),
                ptr::null(),
                WS_POPUP,
                -32000,
                0,
                100,
                80,
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null(),
            );
            assert!(!host.is_null());
            let mut bounds = Bounds {
                x: 10.,
                y: 20.,
                width: 100.,
                height: 80.,
                scale_factor: 1.,
                clip: Some(SurfaceRect {
                    x: 10.,
                    y: 30.,
                    width: 100.,
                    height: 70.,
                }),
                occlusions: vec![
                    SurfaceRect {
                        x: 70.,
                        y: 30.,
                        width: 50.,
                        height: 30.,
                    },
                    SurfaceRect {
                        x: 60.,
                        y: 40.,
                        width: 20.,
                        height: 40.,
                    },
                ],
                input_blocked: false,
            };
            apply(host, &bounds).unwrap();
            let result = Region::rectangle([0, 0, 0, 0]).unwrap();
            assert_eq!(GetWindowRgn(host, result.0), COMPLEXREGION);
            assert_eq!(PtInRegion(result.0, 20, 5), 0); // Above visible page.
            assert_ne!(PtInRegion(result.0, 20, 20), 0);
            assert_eq!(PtInRegion(result.0, 80, 20), 0); // First card.
            assert_eq!(PtInRegion(result.0, 55, 50), 0); // Overlapping card.
            assert_ne!(PtInRegion(result.0, 80, 70), 0);
            bounds.clip = None;
            bounds.occlusions.clear();
            apply(host, &bounds).unwrap();
            assert_eq!(GetWindowRgn(host, result.0), SIMPLEREGION);
            assert_ne!(PtInRegion(result.0, 80, 20), 0);
            DestroyWindow(host);
        }
    }
}
