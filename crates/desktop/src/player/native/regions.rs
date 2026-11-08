use super::{Bounds, SurfaceOcclusion, SurfaceRect};
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

    #[cfg(test)]
    fn occlusion(bounds: &Bounds, exclusion: &SurfaceOcclusion) -> Result<Self> {
        let (rect, diameter) = occlusion_shape(bounds, exclusion);
        Self::rounded(rect, diameter)
    }

    fn rounded(rect: [i32; 4], diameter: i32) -> Result<Self> {
        if diameter <= 0 {
            return Self::rectangle(rect);
        }
        let handle = unsafe {
            CreateRoundRectRgn(
                rect[0],
                rect[1],
                rect[2] + 1,
                rect[3] + 1,
                diameter,
                diameter,
            )
        };
        ensure!(
            !handle.is_null(),
            "could not allocate rounded video clipping region"
        );
        Ok(Self(handle))
    }
}

fn occlusion_shape(bounds: &Bounds, exclusion: &SurfaceOcclusion) -> ([i32; 4], i32) {
    let diameter = (exclusion.border_radius * 2.)
        .min(exclusion.rect.width)
        .min(exclusion.rect.height);
    let diameter = (diameter * bounds.scale_factor).round() as i32;
    if diameter <= 0 {
        return (rectangle(bounds, &exclusion.rect, true), diameter);
    }
    // Round the original card, not its intersection with the player: a card
    // crossing the video edge must not acquire corners at that cut edge.
    let rect = physical_rectangle(bounds, &exclusion.rect, true);
    // Unlike CreateRectRgn, GDI's rounded rectangle drops the last row and
    // column. Include them so the opaque right/bottom borders stay covered.
    (rect, diameter)
}
impl Drop for Region {
    fn drop(&mut self) {
        unsafe {
            DeleteObject(self.0);
        }
    }
}

fn physical_rectangle(bounds: &Bounds, rect: &SurfaceRect, exclude: bool) -> [i32; 4] {
    let scale = bounds.scale_factor;
    let [x, y, _, _] = physical_bounds(bounds);
    let origin = [x as f64, y as f64];
    let low = |value: f64| if exclude { value.floor() } else { value.ceil() };
    let high = |value: f64| if exclude { value.ceil() } else { value.floor() };
    let left = low(rect.x * scale - origin[0]) as i32;
    let top = low(rect.y * scale - origin[1]) as i32;
    let right = high((rect.x + rect.width) * scale - origin[0]) as i32;
    let bottom = high((rect.y + rect.height) * scale - origin[1]) as i32;
    [left, top, right.max(left), bottom.max(top)]
}

fn rectangle(bounds: &Bounds, rect: &SurfaceRect, exclude: bool) -> [i32; 4] {
    let [left, top, right, bottom] = physical_rectangle(bounds, rect, exclude);
    let [_, _, width, height] = physical_bounds(bounds);
    [
        left.clamp(0, width),
        top.clamp(0, height),
        right.clamp(0, width),
        bottom.clamp(0, height),
    ]
}

/// All coordinates are converted relative to the same physical window origin.
/// Exclusions round outward so fractional DPI never leaves a native pixel above UI.
#[cfg(test)]
pub(super) fn apply(hwnd: HWND, bounds: &Bounds) -> Result<()> {
    shape(bounds).apply(hwnd)
}

/// Physical region identity, independent of unrelated input state or subpixel
/// layout changes that rasterize to the same native pixels.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Shape {
    clip: [i32; 4],
    holes: Vec<([i32; 4], i32)>,
}

/// Match GPUI Window::snap_bounds: snap near/far edges independently in f32,
/// rounding exact halves toward zero, then derive size from those same edges.
pub(super) fn physical_bounds(bounds: &Bounds) -> [i32; 4] {
    let scale = bounds.scale_factor as f32;
    let snap = |value: f32| {
        let value = value * scale;
        (value.abs() - 0.5).ceil().copysign(value) as i32
    };
    let (x, y) = (bounds.x as f32, bounds.y as f32);
    let left = snap(x);
    let top = snap(y);
    let right = snap(x + bounds.width as f32).max(left);
    let bottom = snap(y + bounds.height as f32).max(top);
    [left, top, right - left, bottom - top]
}

pub(super) fn shape(bounds: &Bounds) -> Shape {
    let [_, _, width, height] = physical_bounds(bounds);
    let full = [0, 0, width, height];
    Shape {
        clip: bounds
            .clip
            .as_ref()
            .map_or(full, |clip| rectangle(bounds, clip, false)),
        holes: bounds
            .occlusions
            .iter()
            .filter(|exclusion| exclusion.rect.width > 0. && exclusion.rect.height > 0.)
            .map(|exclusion| occlusion_shape(bounds, exclusion))
            .collect(),
    }
}

impl Shape {
    pub(super) fn apply(&self, hwnd: HWND) -> Result<()> {
        let region = Region::rectangle(self.clip)?;
        for &(rect, diameter) in &self.holes {
            let hole = Region::rounded(rect, diameter)?;
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ptr;
    use windows_sys::Win32::UI::WindowsAndMessaging::*;

    #[test]
    fn native_rectangle_matches_near_and_far_pixel_edges() {
        for (x, width, scale_factor, expected) in [
            (10.4, 100.4, 1., [10, 0, 101, 10]),
            (10., 100., 1.25, [12, 0, 125, 12]),
            (-10.5, 20., 1., [-10, 0, 19, 10]),
            (0.5, 100., 2., [1, 0, 200, 20]),
        ] {
            let bounds = Bounds {
                x,
                y: 0.,
                width,
                height: 10.,
                scale_factor,
                clip: None,
                occlusions: vec![],
                input_blocked: false,
            };
            assert_eq!(physical_bounds(&bounds), expected);
            assert_eq!(shape(&bounds).clip, [0, 0, expected[2], expected[3]]);
        }
    }

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
    fn rounded_occlusions_preserve_transparent_corners_at_each_dpi() {
        for scale_factor in [1., 1.25, 1.5, 2.] {
            let bounds = Bounds {
                x: 0.,
                y: 0.,
                width: 100.,
                height: 80.,
                scale_factor,
                clip: None,
                occlusions: vec![],
                input_blocked: false,
            };
            let card = SurfaceOcclusion {
                rect: SurfaceRect {
                    x: 10.,
                    y: 10.,
                    width: 60.,
                    height: 40.,
                },
                border_radius: 12.,
            };
            let hole = Region::occlusion(&bounds, &card).unwrap();
            for (x, y) in [(10.5, 10.5), (69., 10.5), (10.5, 49.), (69., 49.)] {
                assert_eq!(
                    unsafe {
                        PtInRegion(hole.0, (x * scale_factor) as i32, (y * scale_factor) as i32)
                    },
                    0,
                    "transparent corner ({x}, {y}) was excluded at {scale_factor} DPI"
                );
            }
            for (x, y) in [(40., 10.5), (10.5, 30.), (40., 30.), (69., 30.), (40., 49.)] {
                assert_ne!(
                    unsafe {
                        PtInRegion(hole.0, (x * scale_factor) as i32, (y * scale_factor) as i32)
                    },
                    0,
                    "opaque card point ({x}, {y}) was not excluded at {scale_factor} DPI"
                );
            }
        }
    }

    #[test]
    fn partially_overlapping_rounded_card_keeps_its_original_corners() {
        let bounds = Bounds {
            x: 0.,
            y: 0.,
            width: 100.,
            height: 80.,
            scale_factor: 1.25,
            clip: None,
            occlusions: vec![],
            input_blocked: false,
        };
        let card = SurfaceOcclusion {
            rect: SurfaceRect {
                x: -20.,
                y: 10.,
                width: 60.,
                height: 40.,
            },
            border_radius: 12.,
        };
        let hole = Region::occlusion(&bounds, &card).unwrap();
        assert_ne!(unsafe { PtInRegion(hole.0, 1, 13) }, 0);
        assert_eq!(unsafe { PtInRegion(hole.0, 49, 13) }, 0);
        assert_ne!(unsafe { PtInRegion(hole.0, 49, 37) }, 0);
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
                    SurfaceOcclusion {
                        rect: SurfaceRect {
                            x: 70.,
                            y: 30.,
                            width: 50.,
                            height: 30.,
                        },
                        border_radius: 0.,
                    },
                    SurfaceOcclusion {
                        rect: SurfaceRect {
                            x: 60.,
                            y: 40.,
                            width: 20.,
                            height: 40.,
                        },
                        border_radius: 0.,
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
