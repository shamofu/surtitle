// SPDX-License-Identifier: GPL-3.0-or-later
//! Shared timing policy for the application's motion, including native dialogs.
use gpui_kit::base::motion::{Easing, Interpolate, Transition, TransitionId};
use gpui_kit::{App, ElementId, Window};
use std::time::{Duration, Instant};

mod interaction;
pub(crate) use interaction::interactive;
pub(crate) mod pages;

pub(crate) const ENTER: Duration = Duration::from_millis(300);
pub(crate) const EXIT: Duration = Duration::from_millis(240);
pub(crate) const PAGE: Duration = Duration::from_millis(360);
pub(crate) const PANEL: Duration = Duration::from_millis(300);
pub(crate) const DISCLOSE_ENTER: Duration = Duration::from_millis(340);
pub(crate) const DISCLOSE_EXIT: Duration = Duration::from_millis(260);
pub(crate) const REVIEW: Duration = Duration::from_millis(380);
pub(crate) const PROGRESS: Duration = Duration::from_millis(160);
pub(crate) const CONTROL_HOVER: Duration = Duration::from_millis(200);
pub(crate) const CONTROL_PRESS: Duration = Duration::from_millis(100);
pub(crate) const CONTROL_RELEASE: Duration = Duration::from_millis(240);
pub(crate) const SELECTION: Duration = Duration::from_millis(380);
pub(crate) const DIALOG_OFFSET: f64 = 48.;

pub(crate) fn entering_easing() -> Easing {
    Easing::cubic_bezier(0.33, 1., 0.68, 1.).unwrap()
}
pub(crate) fn exiting_easing() -> Easing {
    Easing::cubic_bezier(0.32, 0., 0.67, 0.).unwrap()
}
pub(crate) fn resizing_easing() -> Easing {
    Easing::cubic_bezier(0.65, 0., 0.35, 1.).unwrap()
}

pub(crate) fn enter(duration: Duration) -> Transition {
    Transition::new(duration).easing(entering_easing())
}
#[derive(Clone)]
struct BinaryReveal {
    from: f32,
    target: f32,
    started: Instant,
    duration: Duration,
    easing: Easing,
}

impl BinaryReveal {
    fn settled(target: f32, now: Instant, easing: Easing) -> Self {
        Self {
            from: target,
            target,
            started: now,
            duration: Duration::ZERO,
            easing,
        }
    }

    fn sample(&self, now: Instant) -> (f32, bool) {
        let elapsed = now.saturating_duration_since(self.started);
        if elapsed >= self.duration {
            return (self.target, false);
        }
        let progress = elapsed.as_secs_f32() / self.duration.as_secs_f32();
        (
            self.from
                .interpolate(&self.target, self.easing.sample(progress)),
            true,
        )
    }
}

/// A binary reveal uses a normalized range, so every interruption can time
/// its remaining travel, including a second or later reversal. Continuous
/// values (progress, colors, markers) retain their existing Kit transitions.
pub(crate) fn reveal(
    id: impl Into<TransitionId>,
    visible: bool,
    full_duration: Duration,
    easing: Easing,
    window: &mut Window,
    cx: &mut App,
) -> f32 {
    let target = if visible { 1. } else { 0. };
    let now = cx.background_executor().now();
    let id: TransitionId = id.into();
    let id = ElementId::NamedChild(ElementId::from(id).into(), "app-binary-reveal".into());
    let state = window.use_keyed_state(id, cx, |_, _| {
        BinaryReveal::settled(target, now, easing.clone())
    });
    let mut current = state.read(cx).clone();
    if cx.reduce_motion() || full_duration.is_zero() || !window.is_visible() {
        if current.from != target || current.target != target || !current.duration.is_zero() {
            state.update(cx, |state, _| {
                *state = BinaryReveal::settled(target, now, easing)
            });
        }
        return target;
    }
    let (mut value, mut running) = current.sample(now);
    if current.target != target {
        current = BinaryReveal {
            from: value,
            target,
            started: now,
            duration: full_duration.mul_f32((target - value).abs().clamp(0., 1.)),
            easing,
        };
        (value, running) = current.sample(now);
        state.update(cx, |state, _| *state = current);
    }
    if running {
        window.request_animation_frame();
    }
    value
}
