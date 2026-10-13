use super::{Environment, Insets};
use tauri::{PhysicalPosition, PhysicalSize};

const SNAP_DISTANCE: f64 = 12.0;

/// Align the visible frame, allowing only the invisible resize border outside
/// the work area. Each axis chooses its nearest edge and preserves the size.
pub(super) fn position(
    environment: Environment,
    outer: PhysicalSize<u32>,
    position: PhysicalPosition<i32>,
    insets: Insets,
) -> PhysicalPosition<i32> {
    let threshold = (SNAP_DISTANCE * environment.scale).round().max(1.0) as i64;
    let axis = |position: i32, size: u32, origin: i32, area: u32, leading: u32, trailing: u32| {
        let start = i64::from(position) + i64::from(leading);
        let end = i64::from(position) + i64::from(size) - i64::from(trailing);
        let near = i64::from(origin) - start;
        let far = i64::from(origin) + i64::from(area) - end;
        let delta = if near.abs() <= far.abs() { near } else { far };
        if delta.abs() <= threshold {
            (i64::from(position) + delta).clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32
        } else {
            position
        }
    };
    PhysicalPosition::new(
        axis(
            position.x,
            outer.width,
            environment.origin.x,
            environment.size.width,
            insets.left,
            insets.right,
        ),
        axis(
            position.y,
            outer.height,
            environment.origin.y,
            environment.size.height,
            insets.top,
            insets.bottom,
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn environment() -> Environment {
        Environment {
            origin: PhysicalPosition::new(-1920, 40),
            size: PhysicalSize::new(1920, 1040),
            scale: 1.0,
        }
    }

    #[test]
    fn each_visible_edge_and_corner_align_to_the_work_area() {
        let insets = Insets {
            left: 7,
            top: 0,
            right: 7,
            bottom: 7,
        };
        let size = PhysicalSize::new(1296, 759);
        // Visible right = outer x + 1296 - 7; bottom = outer y + 759 - 7.
        for (requested, expected) in [
            ((-1921, 100), (-1927, 100)),
            ((-1280, 100), (-1289, 100)),
            ((-1800, 48), (-1800, 40)),
            ((-1800, 322), (-1800, 328)),
            ((-1921, 322), (-1927, 328)),
        ] {
            assert_eq!(
                position(environment(), size, requested.into(), insets),
                expected.into()
            );
        }
    }

    #[test]
    fn threshold_is_in_logical_pixels_and_moving_away_releases_snap() {
        let area = Environment {
            scale: 1.5,
            ..environment()
        };
        let size = PhysicalSize::new(1300, 760);
        assert_eq!(
            position(
                area,
                size,
                PhysicalPosition::new(-1902, 100),
                Insets::default()
            )
            .x,
            -1920
        );
        assert_eq!(
            position(
                area,
                size,
                PhysicalPosition::new(-1901, 100),
                Insets::default()
            )
            .x,
            -1901
        );
        assert_eq!(
            position(
                environment(),
                size,
                PhysicalPosition::new(-1902, 100),
                Insets::default()
            )
            .x,
            -1902
        );
    }

    #[test]
    fn full_work_area_uses_the_nearest_edge_without_oscillation() {
        let area = environment();
        let insets = Insets {
            left: 7,
            top: 0,
            right: 7,
            bottom: 7,
        };
        let size = PhysicalSize::new(area.size.width + 14, area.size.height + 7);
        let snapped = position(area, size, PhysicalPosition::new(-1919, 44), insets);
        assert_eq!(snapped, PhysicalPosition::new(-1927, 40));
        assert_eq!(position(area, size, snapped, insets), snapped);
    }
}
