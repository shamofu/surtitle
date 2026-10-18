use super::{Environment, Insets};
use tauri::{PhysicalPosition, PhysicalSize};

const SNAP_DISTANCE: f64 = 32.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct Geometry {
    pub environment: Environment,
    pub outer: PhysicalSize<u32>,
    pub insets: Insets,
}

impl Geometry {
    fn targets(self) -> [[i64; 2]; 2] {
        let Self {
            environment,
            outer,
            insets,
        } = self;
        [
            [
                i64::from(environment.origin.x) - i64::from(insets.left),
                i64::from(environment.origin.x) + i64::from(environment.size.width)
                    - i64::from(outer.width)
                    + i64::from(insets.right),
            ],
            [
                i64::from(environment.origin.y) - i64::from(insets.top),
                i64::from(environment.origin.y) + i64::from(environment.size.height)
                    - i64::from(outer.height)
                    + i64::from(insets.bottom),
            ],
        ]
    }

    fn snap(self, position: PhysicalPosition<i32>) -> PhysicalPosition<i32> {
        let distance = (SNAP_DISTANCE * self.environment.scale).round().max(1.0) as i64;
        let axis = |position: i32, targets: [i64; 2]| {
            let target = targets
                .into_iter()
                .min_by_key(|target| (i64::from(position) - target).abs())
                .unwrap();
            if (i64::from(position) - target).abs() <= distance {
                i32::try_from(target).unwrap_or(position)
            } else {
                position
            }
        };
        let [x, y] = self.targets();
        PhysicalPosition::new(axis(position.x, x), axis(position.y, y))
    }
}

/// One native pointer move loop. Test the intended (unsnapped) frame against
/// fixed edge boundaries. WM_MOVING proposals can contain our last correction,
/// so they must not become the next pointer anchor.
#[derive(Clone, Copy, Debug)]
pub(super) struct Drag {
    geometry: Geometry,
    position: PhysicalPosition<i32>,
    cursor: Option<PhysicalPosition<i32>>,
}

impl Drag {
    pub fn new(
        geometry: Geometry,
        position: PhysicalPosition<i32>,
        cursor: Option<PhysicalPosition<i32>>,
    ) -> Self {
        Self {
            geometry,
            position,
            cursor,
        }
    }

    pub fn position(
        &mut self,
        geometry: Geometry,
        proposed: PhysicalPosition<i32>,
        cursor: Option<PhysicalPosition<i32>>,
    ) -> PhysicalPosition<i32> {
        if geometry == self.geometry
            && let (Some(anchor), Some(cursor)) = (self.cursor, cursor)
            && let (Ok(x), Ok(y)) = (
                i32::try_from(
                    i64::from(self.position.x) + i64::from(cursor.x) - i64::from(anchor.x),
                ),
                i32::try_from(
                    i64::from(self.position.y) + i64::from(cursor.y) - i64::from(anchor.y),
                ),
            )
        {
            return geometry.snap(PhysicalPosition::new(x, y));
        }
        // System relocations (including DPI/size changes) and missing pointer
        // data invalidate the anchor. Pass through once and resume from here.
        *self = Self::new(geometry, proposed, cursor);
        proposed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn geometry(scale: f64) -> Geometry {
        Geometry {
            environment: Environment {
                origin: (-1920, 40).into(),
                size: (1920, 1040).into(),
                scale,
            },
            outer: (1300, 760).into(),
            insets: Insets::default(),
        }
    }

    #[test]
    fn intended_edge_crosses_a_fixed_boundary_even_with_rebased_proposals() {
        for rebased in [false, true] {
            let g = geometry(1.0);
            let mut drag = Drag::new(g, (-1920, 100).into(), Some((500, 400).into()));
            let mut output = PhysicalPosition::new(-1920, 100);
            for step in 1..=40 {
                let proposed =
                    PhysicalPosition::new(if rebased { output.x + 1 } else { -1920 + step }, 100);
                output = drag.position(g, proposed, Some((500 + step, 400).into()));
                assert_eq!(
                    output.x,
                    if step <= 32 { -1920 } else { -1920 + step },
                    "step {step}, rebased {rebased}"
                );
            }
            for gap in [32_i32, 33, 31, 33, 0, -33, -32, -33] {
                output = drag.position(g, output, Some((500 + gap, 400).into()));
                assert_eq!(output.x, if gap.abs() <= 32 { -1920 } else { -1920 + gap });
            }
        }
    }

    #[test]
    fn each_visible_edge_has_the_same_inside_and_outside_boundary() {
        let g = Geometry {
            outer: (1296, 759).into(),
            insets: Insets {
                left: 7,
                top: 0,
                right: 7,
                bottom: 7,
            },
            ..geometry(1.0)
        };
        for (axis, target) in [(0, -1927), (0, -1289), (1, 40), (1, 328)] {
            for sign in [-1, 1] {
                let start = if axis == 0 {
                    (target, 100)
                } else {
                    (-1800, target)
                };
                let mut drag = Drag::new(g, start.into(), Some((500, 400).into()));
                for gap in [33, 32, 0, 32, 33] {
                    let offset = sign * gap;
                    let pointer = if axis == 0 {
                        (500 + offset, 400)
                    } else {
                        (500, 400 + offset)
                    };
                    let expected = target + if gap <= 32 { 0 } else { offset };
                    assert_eq!(
                        drag.position(g, start.into(), Some(pointer.into())),
                        if axis == 0 {
                            (expected, 100).into()
                        } else {
                            (-1800, expected).into()
                        }
                    );
                }
            }
        }
    }

    #[test]
    fn corner_axes_cross_their_boundaries_independently() {
        let g = geometry(1.0);
        let mut drag = Drag::new(g, (-1920, 40).into(), Some((500, 400).into()));
        for (dx, dy) in [
            (1, 0),
            (0, 1),
            (32, 32),
            (33, 32),
            (32, 33),
            (33, 33),
            (0, 0),
        ] {
            assert_eq!(
                drag.position(g, (-1920, 40).into(), Some((500 + dx, 400 + dy).into())),
                (
                    -1920 + if dx <= 32 { 0 } else { dx },
                    40 + if dy <= 32 { 0 } else { dy }
                )
                    .into()
            );
        }
    }

    #[test]
    fn boundary_scales_with_dpi_and_start_position() {
        for (scale, boundary) in [(1.0, 32), (1.25, 40), (1.5, 48), (2.0, 64)] {
            let g = geometry(scale);
            for initial_gap in [0, 3, 40] {
                let mut drag = Drag::new(
                    g,
                    (-1920 + initial_gap, 100).into(),
                    Some((500 + initial_gap, 400).into()),
                );
                for gap in (0..=boundary + 2).chain((0..=boundary + 2).rev()) {
                    assert_eq!(
                        drag.position(g, (-1920, 100).into(), Some((500 + gap, 400).into()))
                            .x,
                        if gap <= boundary { -1920 } else { -1920 + gap }
                    );
                }
            }
        }
    }

    #[test]
    fn full_work_area_uses_the_same_boundary_for_coincident_targets() {
        let g = Geometry {
            outer: (1920, 1040).into(),
            ..geometry(1.0)
        };
        let mut drag = Drag::new(g, (-1920, 40).into(), Some((500, 400).into()));
        for step in 1..=36 {
            assert_eq!(
                drag.position(g, (-1920, 40).into(), Some((500 + step, 400).into()))
                    .x,
                if step <= 32 { -1920 } else { -1920 + step }
            );
        }
    }

    #[test]
    fn environment_changes_reanchor_without_interpreting_system_relocation() {
        let g = geometry(1.0);
        for changed in [
            geometry(1.5),
            Geometry {
                outer: (1400, 800).into(),
                ..g
            },
            Geometry {
                environment: Environment {
                    origin: (0, 0).into(),
                    ..g.environment
                },
                ..g
            },
            Geometry {
                insets: Insets {
                    left: 7,
                    ..g.insets
                },
                ..g
            },
        ] {
            let mut drag = Drag::new(g, (-1920, 100).into(), Some((500, 400).into()));
            assert_eq!(
                drag.position(changed, (-1700, 100).into(), Some((501, 400).into())),
                (-1700, 100).into()
            );
            assert_eq!(
                drag.position(changed, (-1919, 100).into(), Some((502, 401).into())),
                (-1699, 101).into()
            );
        }
    }

    #[test]
    fn missing_pointer_passes_through_and_recovery_starts_a_fresh_anchor() {
        let g = geometry(1.0);
        let mut drag = Drag::new(g, (-1920, 100).into(), Some((500, 400).into()));
        assert_eq!(drag.position(g, (-1919, 100).into(), None).x, -1919);
        assert_eq!(drag.position(g, (-1918, 100).into(), None).x, -1918);
        assert_eq!(
            drag.position(g, (-1917, 100).into(), Some((502, 400).into()))
                .x,
            -1917
        );
        assert_eq!(
            drag.position(g, (-1916, 100).into(), Some((532, 400).into()))
                .x,
            -1887
        );
    }

    #[test]
    fn duplicate_proposals_never_move_the_pointer_anchor() {
        let g = geometry(1.0);
        let mut drag = Drag::new(g, (-1900, 100).into(), Some((520, 400).into()));
        for proposed in [-1888, -1920, -1919, -1920] {
            assert_eq!(
                drag.position(g, (proposed, 100).into(), Some((532, 400).into()))
                    .x,
                -1920
            );
        }
        assert_eq!(
            drag.position(g, (-1919, 100).into(), Some((533, 400).into()))
                .x,
            -1887
        );
    }

    #[test]
    fn overflow_fails_open_without_wrapping_coordinates() {
        let g = geometry(1.0);
        let mut drag = Drag::new(g, (i32::MAX, 100).into(), Some((0, 0).into()));
        assert_eq!(
            drag.position(g, (100, 100).into(), Some((1, 0).into())),
            (100, 100).into()
        );
        assert_eq!(
            drag.position(g, (100, 100).into(), Some((2, 0).into())),
            (101, 100).into()
        );
    }
}
