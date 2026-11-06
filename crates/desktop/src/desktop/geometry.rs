//! Physical work-area geometry, shared by placement and pointer drag snapping.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(super) struct PhysicalPosition<T> {
    pub(super) x: T,
    pub(super) y: T,
}
impl<T> PhysicalPosition<T> {
    pub(super) const fn new(x: T, y: T) -> Self {
        Self { x, y }
    }
}
impl<T> From<(T, T)> for PhysicalPosition<T> {
    fn from((x, y): (T, T)) -> Self {
        Self { x, y }
    }
}
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(super) struct PhysicalSize<T> {
    pub(super) width: T,
    pub(super) height: T,
}
impl<T> PhysicalSize<T> {
    pub(super) const fn new(width: T, height: T) -> Self {
        Self { width, height }
    }
}
impl<T> From<(T, T)> for PhysicalSize<T> {
    fn from((width, height): (T, T)) -> Self {
        Self { width, height }
    }
}
const MINIMUM_WIDTH: f64 = 1280.0;
const MINIMUM_HEIGHT: f64 = 720.0;

/// Physical resize borders outside the visible DWM frame. These may extend
/// beyond the work area while the visible titlebar and client remain inside it.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(super) struct Insets {
    pub(super) left: u32,
    pub(super) top: u32,
    pub(super) right: u32,
    pub(super) bottom: u32,
}

impl Insets {
    pub(super) fn scaled(self, scale: f64) -> Self {
        Self {
            left: (f64::from(self.left) * scale).round() as u32,
            top: (f64::from(self.top) * scale).round() as u32,
            right: (f64::from(self.right) * scale).round() as u32,
            bottom: (f64::from(self.bottom) * scale).round() as u32,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct Environment {
    pub(super) origin: PhysicalPosition<i32>,
    pub(super) size: PhysicalSize<u32>,
    pub(super) scale: f64,
}

#[derive(Debug, PartialEq)]
pub(super) struct Fit {
    pub(super) minimum: PhysicalSize<u32>,
    pub(super) size: PhysicalSize<u32>,
    pub(super) position: PhysicalPosition<i32>,
}

pub(super) fn plan(
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

pub(super) fn preset_size(preset: &str) -> anyhow::Result<PhysicalSize<u32>> {
    match preset {
        "hd" => Ok(PhysicalSize::new(1280, 720)),
        "standard" => Ok(PhysicalSize::new(1600, 900)),
        "full-hd" => Ok(PhysicalSize::new(1920, 1080)),
        _ => anyhow::bail!("Unknown window size preset: {preset}"),
    }
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
