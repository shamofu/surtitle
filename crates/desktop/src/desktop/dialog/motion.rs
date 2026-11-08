// SPDX-License-Identifier: GPL-3.0-or-later
use crate::ui::motion as policy;
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn interruption_restarts_at_actual_position() {
        let mut motion = Motion::new(100., 148.);
        motion.reveal(0.);
        let halfway = motion.sample(0.15, false);
        assert!(halfway > 100. && halfway < 148.);
        assert!(motion.close(0.15, halfway));
        assert_eq!(motion.sample(0.15, false), halfway);
        assert!(!motion.close(0.16, halfway));
        let exiting = motion.sample(0.25, false);
        motion.activate(0.25, exiting);
        assert_eq!(motion.sample(0.25, false), exiting);
        assert_eq!(motion.sample(0.6, false), 100.);
        assert_eq!(motion.phase, Phase::Open);
    }
    #[test]
    fn reduced_motion_finishes_running_path_without_exit_travel() {
        let mut motion = Motion::new(100., 148.);
        motion.reveal(0.);
        assert_eq!(motion.sample(0.05, true), 100.);
        assert!(motion.close(0.1, 100.));
        assert_eq!(motion.sample(0.1, true), 100.);
        assert_eq!(motion.phase, Phase::Closed);
    }
    #[test]
    fn closed_generation_cannot_reveal_or_reactivate() {
        let mut motion = Motion::new(100., 148.);
        assert!(motion.close(0., 148.));
        motion.sample(1., false);
        motion.reveal(2.);
        motion.activate(2., 148.);
        assert_eq!(motion.phase, Phase::Closed);
    }
    #[test]
    fn partial_exit_and_reopen_finish_at_remaining_distance_deadlines() {
        let mut motion = Motion::new(100., 148.);
        motion.reveal(0.);
        assert!(motion.close(1., 136.)); // 12/48 travel: 60 ms exit.
        assert_eq!(motion.sample(1., false), 136.);
        motion.sample(1.059, false);
        assert_eq!(motion.phase, Phase::Exiting);
        assert_eq!(motion.sample(1.061, false), 148.);
        assert_eq!(motion.phase, Phase::Closed);

        let mut motion = Motion::new(100., 148.);
        motion.reveal(0.);
        motion.close(1., 100.);
        motion.activate(1.1, 112.); // Actual pixel position, 12/48: 75 ms enter.
        assert_eq!(motion.sample(1.1, false), 112.);
        motion.sample(1.174, false);
        assert_eq!(motion.phase, Phase::Entering);
        assert_eq!(motion.sample(1.176, false), 100.);
        assert_eq!(motion.phase, Phase::Open);
    }
    #[test]
    fn immediate_exit_reopen_and_zero_distance_settle_without_idle_animation() {
        let mut motion = Motion::new(100., 148.);
        motion.reveal(0.);
        motion.sample(0.3, false);
        motion.close(1., 100.);
        motion.activate(1., 100.);
        assert_eq!(motion.sample(1., false), 100.);
        assert_eq!(motion.phase, Phase::Open);
        motion.close(2., 148.);
        assert_eq!(motion.sample(2., false), 148.);
        assert_eq!(motion.phase, Phase::Closed);
        let mut fitted = Motion::new(100., 100.);
        fitted.reveal(0.);
        assert_eq!(fitted.sample(0., false), 100.);
        assert_eq!(fitted.phase, Phase::Open);
    }
    #[test]
    fn reduced_work_area_travel_is_the_full_distance_for_retarget_timing() {
        let mut motion = Motion::new(100., 110.);
        motion.reveal(0.);
        motion.close(1., 105.); // Half of the available 10 px: 120 ms.
        motion.sample(1.119, false);
        assert_eq!(motion.phase, Phase::Exiting);
        assert_eq!(motion.sample(1.121, false), 110.);
        assert_eq!(motion.phase, Phase::Closed);
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Phase {
    Preparing,
    Entering,
    Open,
    Exiting,
    Closed,
}
pub(crate) struct Motion {
    pub phase: Phase,
    pub rest: f64,
    pub displaced: f64,
    from: f64,
    start: f64,
    position: f64,
    duration: f64,
}
impl Motion {
    pub fn new(rest: f64, displaced: f64) -> Self {
        Self {
            phase: Phase::Preparing,
            rest,
            displaced,
            from: displaced,
            start: 0.,
            position: displaced,
            duration: 0.,
        }
    }
    pub fn reveal(&mut self, now: f64) {
        if self.phase == Phase::Preparing {
            self.phase = Phase::Entering;
            self.start = now;
            self.duration = self.remaining_duration(self.rest, policy::ENTER.as_secs_f64());
        }
    }
    pub fn position(&self) -> f64 {
        self.position
    }
    pub fn close(&mut self, now: f64, actual: f64) -> bool {
        if matches!(self.phase, Phase::Exiting | Phase::Closed) {
            return false;
        }
        self.phase = Phase::Exiting;
        self.start = now;
        self.from = actual;
        self.position = actual;
        self.duration = self.remaining_duration(self.displaced, policy::EXIT.as_secs_f64());
        true
    }
    pub fn activate(&mut self, now: f64, actual: f64) {
        if self.phase == Phase::Exiting {
            self.phase = Phase::Entering;
            self.start = now;
            self.from = actual;
            self.position = actual;
            self.duration = self.remaining_duration(self.rest, policy::ENTER.as_secs_f64());
        }
    }
    pub fn retire(&mut self, actual: f64) {
        self.rest = actual;
        self.displaced = actual;
        self.from = actual;
        self.position = actual;
        if self.phase == Phase::Entering {
            self.phase = Phase::Open;
        }
        if self.phase == Phase::Exiting {
            self.phase = Phase::Closed;
        }
    }
    pub fn sample(&mut self, now: f64, reduced: bool) -> f64 {
        let (target, easing) = match self.phase {
            Phase::Entering => (self.rest, policy::entering_easing()),
            Phase::Exiting => (self.displaced, policy::exiting_easing()),
            Phase::Open => return self.rest,
            _ => return self.from,
        };
        let progress = if reduced || self.duration == 0. {
            1.
        } else {
            ((now - self.start) / self.duration).clamp(0., 1.)
        };
        let value = if reduced {
            self.rest
        } else {
            self.from + (target - self.from) * easing.sample(progress as f32) as f64
        };
        if progress >= 1. {
            self.phase = if self.phase == Phase::Entering {
                Phase::Open
            } else {
                Phase::Closed
            };
            self.from = value;
        }
        self.position = value;
        value
    }
    fn remaining_duration(&self, target: f64, full_duration: f64) -> f64 {
        let full_distance = (self.displaced - self.rest).abs();
        if full_distance == 0. {
            return 0.;
        }
        full_duration * ((target - self.from).abs() / full_distance).clamp(0., 1.)
    }
}

/// Fit the full outer rectangle, then use only the downward space available.
/// Coordinates are physical pixels so negative monitors and fractional DPI do
/// not accumulate rounding errors.
pub(crate) fn fit_path(
    origin: (i32, i32),
    outer: (i32, i32),
    work: (i32, i32, i32, i32),
    dpi: u32,
    reduced: bool,
) -> (i32, i32, i32) {
    let x = origin.0.clamp(work.0, (work.2 - outer.0).max(work.0));
    let y = origin.1.clamp(work.1, (work.3 - outer.1).max(work.1));
    let distance = if reduced {
        0
    } else {
        (policy::DIALOG_OFFSET * dpi as f64 / 96.).round() as i32
    };
    (x, y, (y + distance).min((work.3 - outer.1).max(y)))
}
#[cfg(test)]
mod geometry_tests {
    use super::*;
    #[test]
    fn negative_monitor_fractional_dpi_and_bottom_edge_shrink_travel() {
        assert_eq!(
            fit_path((-1700, -400), (900, 600), (-1920, -900, 0, 300), 144, false),
            (-1700, -400, -328)
        );
        assert_eq!(
            fit_path((-1900, -330), (900, 600), (-1920, -900, 0, 300), 144, false),
            (-1900, -330, -300)
        );
        assert_eq!(
            fit_path(
                (-2500, -1000),
                (1920, 1200),
                (-1920, -900, 0, 300),
                168,
                false
            ),
            (-1920, -900, -900)
        );
        assert_eq!(
            fit_path((200, 200), (600, 400), (0, 0, 1920, 1080), 120, true),
            (200, 200, 200)
        );
    }
}
