// SPDX-License-Identifier: GPL-3.0-or-later
//! Positions of retained pages, in viewport-width units.
//! One shared clock keeps their edges continuous through interrupted changes.
use super::PAGE;
use std::time::{Duration, Instant};

pub(crate) struct Pages<const N: usize = 4> {
    selected: usize,
    from: [f32; N],
    target: [f32; N],
    order: Vec<usize>,
    started: Option<Instant>,
    duration: Duration,
    full_duration: Duration,
}

pub(crate) struct PageFrame {
    pub layers: Vec<(usize, f32)>,
    pub running: bool,
}

fn positions<const N: usize>(selected: usize) -> [f32; N] {
    std::array::from_fn(|index| (index as i32 - selected as i32).signum() as f32)
}

impl<const N: usize> Pages<N> {
    pub fn new(selected: usize) -> Self {
        Self::with_duration(selected, PAGE)
    }

    pub fn with_duration(selected: usize, full_duration: Duration) -> Self {
        Self {
            selected,
            from: positions(selected),
            target: positions(selected),
            order: vec![selected],
            started: None,
            duration: Duration::ZERO,
            full_duration,
        }
    }

    fn sample(&self, now: Instant) -> ([f32; N], bool) {
        let Some(started) = self.started else {
            return (self.target, false);
        };
        let elapsed = now.saturating_duration_since(started);
        if elapsed >= self.duration {
            return (self.target, false);
        }
        let t = elapsed.as_secs_f32() / self.duration.as_secs_f32();
        let eased = super::entering_easing().sample(t);
        (
            std::array::from_fn(|index| {
                self.from[index] + (self.target[index] - self.from[index]) * eased
            }),
            true,
        )
    }

    pub fn frame(&mut self, selected: usize, now: Instant, settle: bool) -> PageFrame {
        if settle {
            *self = Self::with_duration(selected, self.full_duration);
        } else if selected != self.selected {
            let (mut from, _) = self.sample(now);
            self.order
                .retain(|index| *index == self.selected || from[*index].abs() < 1.);
            // Pages not yet visible stay offscreen. In particular, skipping a
            // tab must not make that page travel through the viewport.
            for (index, position) in from.iter_mut().enumerate() {
                if !self.order.contains(&index) && index != selected {
                    *position = positions::<N>(selected)[index];
                }
            }
            if !self.order.contains(&selected) {
                from[selected] = if selected > self.selected { 1. } else { -1. };
                self.order.push(selected);
            }
            // Preserve the *displayed* ordering after an interruption, which
            // can differ from navigation order (e.g. Library → Settings →
            // Review). Adjacent intervals remain at most one viewport apart
            // throughout interpolation, and all outgoing layers fully leave.
            let target = std::array::from_fn(|index| {
                if index == selected {
                    0.
                } else if from[index] < from[selected] {
                    -1.
                } else {
                    1.
                }
            });
            self.duration = self.full_duration.mul_f32(from[selected].abs().min(1.));
            self.from = from;
            self.target = target;
            self.selected = selected;
            self.started = Some(now);
        }
        let (pose, running) = self.sample(now);
        if !running {
            self.started = None;
            self.order.retain(|index| *index == self.selected);
        }
        PageFrame {
            layers: self
                .order
                .iter()
                .filter(|index| **index == selected || pose[**index].abs() < 1.)
                .map(|index| (*index, pose[*index]))
                .collect(),
            running,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn covered(frame: &PageFrame) {
        let mut intervals: Vec<_> = frame.layers.iter().map(|(_, x)| (*x, *x + 1.)).collect();
        intervals.sort_by(|a, b| a.0.total_cmp(&b.0));
        let mut edge = 0_f32;
        for (left, right) in intervals {
            if right <= 0. || left >= 1. {
                continue;
            }
            assert!(
                left <= edge + 0.0001,
                "visible gap at {edge}: {:?}",
                frame.layers
            );
            edge = edge.max(right);
        }
        assert!(
            edge >= 1. - 0.0001,
            "uncovered trailing edge: {:?}",
            frame.layers
        );
    }

    #[test]
    fn rapid_forward_and_reverse_preserve_every_visible_pose_without_a_gap() {
        let start = Instant::now();
        let mut pages = Pages::<4>::new(0);
        let mut target = 0;
        for ms in 0..650 {
            let now = start + Duration::from_millis(ms);
            let before = pages.frame(target, now, false);
            if let Some(next) = match ms {
                0 => Some(1),
                70 => Some(2),
                135 => Some(0),
                190 => Some(3),
                245 => Some(1),
                _ => None,
            } {
                target = next;
                let after = pages.frame(target, now, false);
                for (index, x) in before.layers {
                    let new_x = after
                        .layers
                        .iter()
                        .find(|(other, _)| *other == index)
                        .map(|(_, x)| *x);
                    assert_eq!(
                        new_x,
                        Some(x),
                        "navigation discarded/moved visible page {index}"
                    );
                }
            }
            covered(&pages.frame(target, now, false));
        }
        let final_frame = pages.frame(target, start + Duration::from_secs(1), false);
        assert_eq!(final_frame.layers, [(1, 0.)]);
        assert!(!final_frame.running);
    }

    #[test]
    fn skipped_pages_do_not_cross_the_viewport_and_reduction_does_not_replay() {
        let start = Instant::now();
        let mut pages = Pages::<4>::new(0);
        pages.frame(3, start, false);
        let middle = pages.frame(3, start + Duration::from_millis(100), false);
        assert!(
            middle
                .layers
                .iter()
                .all(|(index, _)| [0, 3].contains(index))
        );
        covered(&middle);
        let settled = pages.frame(3, start + Duration::from_millis(100), true);
        assert_eq!(settled.layers, [(3, 0.)]);
        assert!(
            !pages
                .frame(3, start + Duration::from_millis(101), false)
                .running
        );
    }

    #[test]
    fn interrupted_skips_keep_coverage_and_evacuate_every_outgoing_layer() {
        // Exhaust every three-step route choice and several interruption
        // points, including selecting a newly revealed intermediate page.
        for first in 1..4 {
            for second in 0..4 {
                for third in 0..4 {
                    for interrupt in [20, 90, 180, 300] {
                        let start = Instant::now();
                        let mut pages = Pages::<4>::new(0);
                        let mut target = first;
                        pages.frame(target, start, false);
                        for ms in 0..800 {
                            let now = start + Duration::from_millis(ms);
                            let before = pages.frame(target, now, false);
                            if ms == interrupt || ms == interrupt + 37 {
                                target = if ms == interrupt { second } else { third };
                                let after = pages.frame(target, now, false);
                                for (index, x) in before.layers {
                                    if x.abs() < 1. {
                                        assert_eq!(
                                            after
                                                .layers
                                                .iter()
                                                .find(|(id, _)| *id == index)
                                                .map(|(_, x)| *x),
                                            Some(x)
                                        );
                                    }
                                }
                            }
                            covered(&pages.frame(target, now, false));
                        }
                        assert_eq!(
                            pages
                                .frame(target, start + Duration::from_secs(1), false)
                                .layers,
                            [(third, 0.)]
                        );
                    }
                }
            }
        }
    }
}
