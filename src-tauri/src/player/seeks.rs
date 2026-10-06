use super::stops::PlaybackStops;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct SeekRequest {
    pub(super) target: u64,
    pub(super) end: Option<u64>,
    pub(super) paused: bool,
    pub(super) repeating: bool,
}

#[derive(Clone, Copy)]
pub(super) enum SeekEvent {
    Started,
    Restarted,
}

/// Only one native seek is in flight. Later requests replace the queued target,
/// so completion events cannot accidentally acknowledge another native seek.
pub(super) struct PendingSeek {
    pub(super) active: SeekRequest,
    pub(super) queued: Option<SeekRequest>,
    started: bool,
    complete: bool,
}

impl PendingSeek {
    pub(super) fn new(active: SeekRequest) -> Self {
        Self {
            active,
            queued: None,
            started: false,
            complete: false,
        }
    }

    pub(super) fn latest(&mut self) -> &mut SeekRequest {
        self.queued.as_mut().unwrap_or(&mut self.active)
    }

    pub(super) fn observe(&mut self, event: SeekEvent) {
        match event {
            SeekEvent::Started => {
                self.started = true;
                self.complete = false;
            }
            SeekEvent::Restarted if self.started => self.complete = true,
            SeekEvent::Restarted => {}
        }
    }

    pub(super) fn complete(&self) -> bool {
        self.complete
    }
}

impl SeekRequest {
    pub(super) fn arm(self, stops: &mut PlaybackStops) {
        stops.seek(self.target, self.end);
        if self.repeating {
            stops.set_repeat(true, self.target);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(target: u64, end: Option<u64>) -> SeekRequest {
        SeekRequest {
            target,
            end,
            paused: false,
            repeating: false,
        }
    }

    #[test]
    fn stale_position_does_not_complete_a_pending_range_and_restart_arms_its_real_end() {
        let mut pending = PendingSeek::new(request(2850, Some(3900)));
        let mut stops = PlaybackStops::default();
        stops.configure(true, vec![3900], 2850);
        assert!(!pending.complete());
        assert!(!stops.should_pause(6000, true, false, !pending.complete()));
        // A file-load restart preceding this seek belongs to the old decoder.
        pending.observe(SeekEvent::Restarted);
        assert!(!pending.complete());
        pending.observe(SeekEvent::Started);
        assert!(!pending.complete());
        assert!(!stops.should_pause(6000, true, false, !pending.complete()));
        pending.observe(SeekEvent::Restarted);
        assert!(pending.complete());
        pending.active.arm(&mut stops);
        assert!(!stops.should_pause(2850, true, false, !pending.complete()));
        assert!(stops.should_pause(3900, true, false, !pending.complete()));
        stops.completed();
        assert!(!stops.should_pause(3900, true, false, !pending.complete()));
    }

    #[test]
    fn a_short_range_still_stops_if_the_first_completed_clock_sample_is_past_its_end() {
        let mut pending = PendingSeek::new(request(2850, Some(2860)));
        pending.observe(SeekEvent::Started);
        pending.observe(SeekEvent::Restarted);
        let mut stops = PlaybackStops::default();
        pending.active.arm(&mut stops);
        assert!(stops.should_pause(2875, true, false, !pending.complete()));
    }

    #[test]
    fn rapid_seeks_keep_only_the_latest_target_and_its_pause_choice() {
        let mut pending = PendingSeek::new(request(1000, Some(2000)));
        pending.queued = Some(request(3000, Some(4000)));
        pending.queued = Some(request(5000, Some(6000)));
        pending.latest().paused = true;
        pending.observe(SeekEvent::Started);
        pending.observe(SeekEvent::Restarted);
        assert!(pending.complete());
        assert_eq!(pending.active.target, 1000);
        assert_eq!(
            pending.queued.unwrap(),
            SeekRequest {
                target: 5000,
                end: Some(6000),
                paused: true,
                repeating: false
            }
        );
        let mut next = PendingSeek::new(pending.queued.unwrap());
        next.latest().paused = false;
        assert!(!next.latest().paused);
        // The first seek's completion never completes the next queued request.
        next.observe(SeekEvent::Restarted);
        assert!(!next.complete());
    }

    #[test]
    fn repeat_selected_during_a_seek_takes_priority_over_its_old_range_end() {
        let mut pending = PendingSeek::new(request(2850, Some(3900)));
        pending.latest().repeating = true;
        pending.latest().end = None;
        let mut stops = PlaybackStops::default();
        pending.active.arm(&mut stops);
        assert!(!stops.reached(6000));
        assert!(stops.repeating);
    }
}
