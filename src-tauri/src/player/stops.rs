/// Stops stay native so backgrounding the webview cannot defer a sentence pause.
#[derive(Default)]
pub(super) struct PlaybackStops {
    pub(super) explicit_end: Option<u64>,
    pub(super) sentence_end: Option<u64>,
    pub(super) sentence_ends: Vec<u64>,
    pub(super) enabled: bool,
    pub(super) suspended: bool,
    pub(super) repeating: bool,
}
impl PlaybackStops {
    pub(super) fn reset_media(&mut self) {
        self.explicit_end = None;
        self.sentence_end = None;
        self.sentence_ends.clear();
        self.repeating = false;
        self.suspended = false;
    }
    pub(super) fn configure(&mut self, enabled: bool, mut ends: Vec<u64>, position: u64) {
        ends.sort_unstable();
        ends.dedup();
        self.enabled = enabled;
        self.sentence_ends = ends;
        self.arm_sentence(position);
    }
    pub(super) fn arm_sentence(&mut self, position: u64) {
        self.sentence_end =
            if self.enabled && !self.suspended && !self.repeating && self.explicit_end.is_none() {
                self.sentence_ends
                    .iter()
                    .copied()
                    .find(|end| *end > position)
            } else {
                None
            };
    }
    pub(super) fn seek(&mut self, position: u64, explicit_end: Option<u64>) {
        self.repeating = false;
        self.explicit_end = explicit_end;
        self.arm_sentence(position);
    }
    pub(super) fn set_repeat(&mut self, repeating: bool, position: u64) {
        self.repeating = repeating;
        self.explicit_end = None;
        self.arm_sentence(position);
    }
    pub(super) fn reached(&self, position: u64) -> bool {
        !self.repeating
            && self
                .explicit_end
                .or(self.sentence_end)
                .is_some_and(|end| position >= end)
    }
    pub(super) fn should_pause(
        &self,
        position: u64,
        ready: bool,
        paused: bool,
        seek_pending: bool,
    ) -> bool {
        ready && !paused && !seek_pending && self.reached(position)
    }
    pub(super) fn completed(&mut self) {
        self.explicit_end = None;
        self.sentence_end = None;
    }
}
