use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use std::{path::Path, time::Instant};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: i64,
    pub kind: String,
    pub title: String,
    pub language: Option<String>,
    pub selected: bool,
    pub ff_index: Option<u32>,
    pub external: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerState {
    /// Orders sampled states even when IPC replies and events arrive out of order.
    #[serde(default)]
    pub revision: u64,
    pub position_ms: u64,
    pub duration_ms: u64,
    pub paused: bool,
    pub rate: f64,
    pub volume: f64,
    pub tracks: Vec<Track>,
    pub error: Option<String>,
    pub surface_visible: bool,
    pub video_width: u32,
    pub video_height: u32,
    pub ready: bool,
    pub sentence_pause: bool,
}
impl Default for PlayerState {
    fn default() -> Self {
        Self {
            revision: 0,
            position_ms: 0,
            duration_ms: 0,
            paused: true,
            rate: 1.,
            volume: 80.,
            tracks: vec![],
            error: None,
            surface_visible: false,
            video_width: 0,
            video_height: 0,
            ready: false,
            sentence_pause: false,
        }
    }
}
impl PlayerState {
    fn snapshot(&mut self) -> Self {
        self.revision = self.revision.saturating_add(1);
        self.clone()
    }
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub scale_factor: f64,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Control {
    pub action: String,
    pub value: Option<f64>,
    pub start_ms: Option<u64>,
    pub end_ms: Option<u64>,
    pub bounds: Option<Bounds>,
    pub track_kind: Option<String>,
}

mod stops;
use stops::PlaybackStops;
#[cfg(any(windows, test))]
mod seeks;
#[cfg(windows)]
use seeks::{PendingSeek, SeekRequest};
#[cfg(windows)]
const SEEK_TIMEOUT_ERROR: &str = "Media seek did not finish. Try seeking again.";

pub struct Player {
    #[cfg(windows)]
    native: native::Mpv,
    state: PlayerState,
    stops: PlaybackStops,
    pending_load: Option<(String, u64, Option<u32>)>,
    #[cfg(windows)]
    pending_seek: Option<(PendingSeek, Instant)>,
    #[cfg(windows)]
    loading_seek: Option<SeekRequest>,
    #[cfg(windows)]
    subtitle_track: Option<i64>,
    #[cfg(windows)]
    pending_subtitle: Option<tempfile::TempPath>,
    #[allow(dead_code)]
    tick: Instant,
}
impl Player {
    /// Called on the Tauri main thread. Windows builds always load the real libmpv.
    pub fn new(resource_dir: &Path, parent: isize) -> Result<Self> {
        #[cfg(windows)]
        let native = native::Mpv::new(&resource_dir.join("native/mpv-2.dll"), parent)?;
        #[cfg(not(windows))]
        {
            let _ = (resource_dir, parent);
            #[cfg(not(feature = "e2e-test"))]
            bail!("Native playback is supported on Windows 11 x64");
        }
        #[cfg(any(windows, feature = "e2e-test"))]
        {
            let state = PlayerState::default();
            #[cfg(windows)]
            native.set("volume", &state.volume.to_string())?;
            Ok(Self {
                #[cfg(windows)]
                native,
                state,
                stops: PlaybackStops::default(),
                pending_load: None,
                #[cfg(windows)]
                pending_seek: None,
                #[cfg(windows)]
                loading_seek: None,
                #[cfg(windows)]
                subtitle_track: None,
                #[cfg(windows)]
                pending_subtitle: None,
                tick: Instant::now(),
            })
        }
    }
    pub fn load(&mut self, path: &Path) -> Result<()> {
        self.load_selected(path, 0, None)
    }
    /// Install on the GUI thread; the callback must not acquire the player lock.
    pub fn on_surface_click(&self, callback: impl Fn() + Send + Sync + 'static) -> Result<()> {
        #[cfg(windows)]
        self.native.on_surface_click(callback)?;
        #[cfg(not(windows))]
        let _ = callback;
        Ok(())
    }
    /// Unload the old file and its pending stops without changing window geometry.
    /// The caller hides the surface when no replacement media can be opened.
    pub fn stop(&mut self) -> Result<()> {
        self.set("pause", "yes")?;
        #[cfg(windows)]
        self.native.command(&["stop"])?;
        self.state = PlayerState {
            revision: self.state.revision,
            rate: self.state.rate,
            volume: self.state.volume,
            sentence_pause: self.state.sentence_pause,
            ..Default::default()
        };
        self.pending_load = None;
        self.stops.reset_media();
        #[cfg(windows)]
        {
            self.pending_seek = None;
            self.loading_seek = None;
            self.subtitle_track = None;
            self.pending_subtitle = None;
        }
        Ok(())
    }
    pub fn hide(&mut self) {
        #[cfg(windows)]
        self.native.hide();
        self.state.surface_visible = false;
    }
    pub fn set_error(&mut self, message: String) {
        self.state.error = Some(message);
    }
    #[cfg(all(windows, test, feature = "e2e-test"))]
    pub(crate) fn subtitle_text(&self) -> Option<String> {
        self.native.string("sub-text")
    }
    pub fn load_selected(
        &mut self,
        path: &Path,
        position_ms: u64,
        audio_stream_index: Option<u32>,
    ) -> Result<()> {
        ensure!(
            path.is_file() && path.is_absolute(),
            "media file is missing; relink the original file"
        );
        #[cfg(windows)]
        {
            self.pending_seek = None;
            self.loading_seek = None;
            self.pending_subtitle = None;
            self.native.drain_events();
            self.native.command(&[
                "loadfile",
                path.to_str().context("invalid Unicode path")?,
                "replace",
            ])?;
            self.native.set("pause", "yes")?;
            self.native.set("ab-loop-a", "no")?;
            self.native.set("ab-loop-b", "no")?;
        }
        self.state.position_ms = position_ms;
        self.state.duration_ms = 0;
        self.state.tracks.clear();
        self.state.error = None;
        self.state.ready = false;
        self.pending_load = Some((
            path.to_string_lossy().into_owned(),
            position_ms,
            audio_stream_index,
        ));
        self.state.paused = true;
        self.stops.reset_media();
        #[cfg(windows)]
        {
            self.subtitle_track = None;
        }
        #[cfg(all(not(windows), feature = "e2e-test"))]
        {
            self.state.duration_ms = 21_600_000;
            self.state.ready = true;
            self.pending_load = None;
        }
        Ok(())
    }
    pub fn select_audio_stream(&mut self, index: u32) -> Result<()> {
        let tracks = self.poll().tracks;
        let track = tracks
            .iter()
            .find(|t| t.kind == "audio" && !t.external && t.ff_index == Some(index))
            .context("Selected audio stream is unavailable in the player")?;
        self.set("aid", &track.id.to_string())
    }
    pub fn subtitle(&mut self, path: &Path) -> Result<()> {
        #[cfg(windows)]
        {
            if self.pending_load.is_some() {
                // loadfile is asynchronous; sub-add can fail while a previous
                // file is being unloaded. Own a copy because the caller removes
                // its generated SRT as soon as this method returns.
                let pending = tempfile::Builder::new()
                    .prefix("surtitle-caption-")
                    .suffix(".srt")
                    .tempfile()?
                    .into_temp_path();
                std::fs::copy(path, &pending).context("Could not prepare playback subtitles")?;
                self.pending_subtitle = Some(pending);
                return Ok(());
            }
            self.native.command(&[
                "sub-add",
                path.to_str().context("invalid Unicode path")?,
                "select",
                "Surtitle",
            ])?;
            let current = self.native.number("sid").map(|v| v as i64);
            if let Some(previous) = self.subtitle_track.take().filter(|id| Some(*id) != current) {
                self.native
                    .command(&["sub-remove", &previous.to_string()])?;
            }
            self.subtitle_track = current;
        }
        #[cfg(not(windows))]
        let _ = path;
        Ok(())
    }
    pub fn clear_subtitle(&mut self) -> Result<()> {
        #[cfg(windows)]
        {
            self.pending_subtitle = None;
            let selected = self.native.number("sid").map(|v| v as i64);
            clear_managed_subtitle(&mut self.subtitle_track, selected, |args| {
                self.native.command(args)
            })?;
        }
        Ok(())
    }
    pub fn control(&mut self, c: &Control) -> Result<()> {
        match c.action.as_str() {
            "toggle-pause" => {
                // Sample the actual clock and pending seek intent under the same
                // session lock, so rapid clicks never toggle a stale UI snapshot.
                let state = self.poll();
                ensure!(state.ready, "Wait for the media player to finish loading");
                self.control(&Control {
                    action: if state.paused { "play" } else { "pause" }.into(),
                    ..c.clone()
                })?;
            }
            "draft-mode" => {
                ensure!(
                    matches!(c.value, Some(0. | 1.)),
                    "Invalid draft playback mode"
                );
                // Suppress only inferred caption stops. Keep the saved preference
                // and explicit selected-range stops independent of the study tab.
                self.stops.suspended = c.value == Some(1.);
                self.stops.arm_sentence(self.state.position_ms);
            }
            "play" => {
                #[cfg(windows)]
                if let Some((pending, _)) = &mut self.pending_seek {
                    pending.latest().paused = false;
                    self.state.paused = false;
                    return Ok(());
                }
                #[cfg(windows)]
                if let Some(request) = &mut self.loading_seek {
                    request.paused = false;
                    self.state.paused = false;
                    return Ok(());
                }
                self.stops.arm_sentence(self.state.position_ms);
                self.state.paused = false;
                self.set("pause", "no")?;
            }
            "pause" => {
                #[cfg(windows)]
                if let Some((pending, _)) = &mut self.pending_seek {
                    pending.latest().paused = true;
                }
                #[cfg(windows)]
                if let Some(request) = &mut self.loading_seek {
                    request.paused = true;
                }
                self.state.paused = true;
                self.set("pause", "yes")?;
            }
            "seek" => {
                let target = c
                    .start_ms
                    .unwrap_or_else(|| c.value.unwrap_or(0.).max(0.) as u64);
                ensure!(
                    c.end_ms.is_none_or(|end| end > target),
                    "invalid playback range"
                );
                self.set("ab-loop-a", "no")?;
                self.set("ab-loop-b", "no")?;
                #[cfg(windows)]
                {
                    let paused = c.end_ms.is_none()
                        && self
                            .pending_seek
                            .as_mut()
                            .map(|(pending, _)| pending.latest().paused)
                            .unwrap_or(self.state.paused);
                    let request = SeekRequest {
                        target,
                        end: c.end_ms,
                        paused,
                        repeating: false,
                    };
                    if let Some((pending, _)) = &mut self.pending_seek {
                        pending.queued = Some(request);
                        self.state.position_ms = target;
                        self.state.paused = paused;
                    } else if self.pending_load.is_some() {
                        // A seek requested while opening a file belongs to that
                        // file. Preserve FILE_LOADED until its target can be sent.
                        self.loading_seek = Some(request);
                        self.state.position_ms = target;
                        self.state.paused = paused;
                    } else {
                        self.begin_seek(request)?;
                    }
                }
                #[cfg(not(windows))]
                {
                    self.state.position_ms = target;
                    self.set("time-pos", &(target as f64 / 1000.).to_string())?;
                    self.stops.seek(target, c.end_ms);
                    if c.end_ms.is_some() {
                        self.state.paused = false;
                        self.set("pause", "no")?;
                    }
                }
            }
            "rate" => {
                let v = c.value.context("missing rate")?;
                ensure!(
                    v.is_finite() && (0.25..=4.).contains(&v),
                    "rate out of range"
                );
                self.set("speed", &v.to_string())?;
                self.state.rate = v;
            }
            "volume" => {
                let v = c.value.context("missing volume")?;
                ensure!(
                    v.is_finite() && (0.0..=100.).contains(&v),
                    "volume out of range"
                );
                self.set("volume", &v.to_string())?;
                self.state.volume = v;
            }
            "loop" => {
                if let (Some(a), Some(b)) = (c.start_ms, c.end_ms) {
                    ensure!(b > a, "invalid loop");
                    self.set("ab-loop-a", &(a as f64 / 1000.).to_string())?;
                    self.set("ab-loop-b", &(b as f64 / 1000.).to_string())?;
                    self.stops.set_repeat(true, self.state.position_ms);
                } else {
                    self.set("ab-loop-a", "no")?;
                    self.set("ab-loop-b", "no")?;
                    self.stops.set_repeat(false, self.state.position_ms);
                }
                #[cfg(windows)]
                if let Some((pending, _)) = &mut self.pending_seek {
                    let latest = pending.latest();
                    latest.end = None;
                    latest.repeating = c.start_ms.is_some() && c.end_ms.is_some();
                }
                #[cfg(windows)]
                if let Some(request) = &mut self.loading_seek {
                    request.end = None;
                    request.repeating = c.start_ms.is_some() && c.end_ms.is_some();
                }
            }
            "track" => {
                let key = match c.track_kind.as_deref() {
                    Some("audio") => "aid",
                    Some("sub") => "sid",
                    _ => bail!("invalid track kind"),
                };
                let value = c.value.context("missing track")?;
                ensure!(value >= 0. && value.is_finite(), "invalid track");
                self.set(
                    key,
                    &if value == 0. {
                        "no".into()
                    } else {
                        (value as i64).to_string()
                    },
                )?;
            }
            "bounds" => {
                let b = c.bounds.as_ref().context("missing player bounds")?;
                ensure!(
                    [b.x, b.y, b.width, b.height, b.scale_factor]
                        .iter()
                        .all(|v| v.is_finite())
                        && b.width >= 0.
                        && b.height >= 0.
                        && (0.5..=8.).contains(&b.scale_factor),
                    "invalid player bounds"
                );
                #[cfg(windows)]
                self.native.bounds(b)?;
            }
            "hide" => {
                self.hide();
            }
            _ => bail!("unsupported player action"),
        }
        Ok(())
    }
    fn set(&self, key: &str, value: &str) -> Result<()> {
        #[cfg(windows)]
        self.native.set(key, value)?;
        #[cfg(not(windows))]
        let _ = (key, value);
        Ok(())
    }
    #[cfg(windows)]
    fn begin_seek(&mut self, request: SeekRequest) -> Result<()> {
        // time-pos only queues a native seek. Keep playback paused until this
        // seek restarts, so an old clock cannot consume the new range stop.
        self.native.set("pause", "yes")?;
        self.state.paused = true;
        self.native.drain_events();
        self.native
            .set("time-pos", &(request.target as f64 / 1000.).to_string())?;
        self.state.position_ms = request.target;
        self.state.paused = request.paused;
        self.stops.seek(request.target, None);
        self.pending_seek = Some((PendingSeek::new(request), Instant::now()));
        Ok(())
    }
    pub fn configure_sentence_pause(&mut self, enabled: bool, ends: Vec<u64>) {
        self.state.sentence_pause = enabled;
        self.stops.configure(enabled, ends, self.state.position_ms);
    }
    pub fn poll(&mut self) -> PlayerState {
        #[cfg(windows)]
        {
            let (loaded, load_error, seek_events) = self.native.drain_events();
            if let Some(error) = load_error {
                self.state.error = Some(format!(
                    "Media playback failed (mpv error {error}). Check the file or choose another media source."
                ));
                self.state.ready = false;
                self.pending_load = None;
                self.pending_seek = None;
                self.loading_seek = None;
                self.pending_subtitle = None;
            }
            let mut restored_now = false;
            if loaded
                && self.pending_load.as_ref().is_some_and(|(path, _, _)| {
                    self.native
                        .string("path")
                        .is_some_and(|actual| same_media_path(path, &actual))
                })
            {
                let (_, position, audio) = self.pending_load.take().unwrap();
                let tracks = self.native.tracks();
                let restore = (|| -> Result<()> {
                    if let Some(path) = self.pending_subtitle.take() {
                        self.subtitle(&path)?;
                    }
                    if let Some(index) = audio {
                        let track = tracks
                            .iter()
                            .find(|t| t.kind == "audio" && !t.external && t.ff_index == Some(index))
                            .context("Saved audio stream is unavailable; choose another track")?;
                        self.native.set("aid", &track.id.to_string())?;
                    }
                    let request = self.loading_seek.take().or_else(|| {
                        (position > 0).then_some(SeekRequest {
                            target: position,
                            end: None,
                            paused: self.state.paused,
                            repeating: false,
                        })
                    });
                    if let Some(mut request) = request {
                        let duration = self.native.number("duration").unwrap_or(f64::MAX) * 1000.;
                        request.target = request.target.min(duration.max(0.) as u64);
                        self.begin_seek(request)?;
                    }
                    if self.pending_seek.is_none() {
                        self.native
                            .set("pause", if self.state.paused { "yes" } else { "no" })?;
                    }
                    Ok(())
                })();
                if let Err(error) = restore {
                    self.state.error = Some(error.to_string());
                }
                self.state.ready = true;
                restored_now = true;
            }
            if self.state.ready
                && !restored_now
                && self.pending_seek.is_none()
                && let Some(p) = self.native.number("time-pos")
            {
                self.state.position_ms = (p.max(0.) * 1000.) as u64;
            }
            if self.state.ready
                && let Some(d) = self.native.number("duration")
            {
                self.state.duration_ms = (d.max(0.) * 1000.) as u64;
            }
            if self.state.ready
                && self.pending_seek.is_none()
                && let Some(p) = self.native.string("pause")
            {
                self.state.paused = p == "yes";
            }
            self.state.tracks = self.native.tracks();
            self.state.surface_visible = self.native.visible();
            self.state.video_width = self.native.number("video-params/w").unwrap_or(0.) as u32;
            self.state.video_height = self.native.number("video-params/h").unwrap_or(0.) as u32;
            if !restored_now && let Some((pending, _)) = &mut self.pending_seek {
                for event in seek_events {
                    pending.observe(event);
                }
            }
            if self
                .pending_seek
                .as_ref()
                .is_some_and(|(pending, _)| pending.complete())
            {
                let (pending, _) = self.pending_seek.take().unwrap();
                if let Some(next) = pending.queued {
                    if let Err(error) = self.begin_seek(next) {
                        self.state.error = Some(error.to_string());
                    }
                } else {
                    if let Some(position) = self.native.number("time-pos") {
                        self.state.position_ms = (position.max(0.) * 1000.) as u64;
                    }
                    pending.active.arm(&mut self.stops);
                    if self.state.error.as_deref() == Some(SEEK_TIMEOUT_ERROR) {
                        self.state.error = None;
                    }
                    let paused = pending.active.paused
                        || self
                            .native
                            .string("eof-reached")
                            .is_some_and(|value| value == "yes");
                    match self.native.set("pause", if paused { "yes" } else { "no" }) {
                        Ok(()) => self.state.paused = paused,
                        Err(error) => self.state.error = Some(error.to_string()),
                    }
                }
            } else if self
                .pending_seek
                .as_ref()
                .is_some_and(|(_, started)| started.elapsed().as_secs() >= 15)
            {
                self.pending_seek = None;
                self.state.error = Some(SEEK_TIMEOUT_ERROR.into());
                self.state.paused = true;
            }
        }
        #[cfg(all(not(windows), feature = "e2e-test"))]
        {
            if !self.state.paused {
                self.state.position_ms +=
                    (self.tick.elapsed().as_millis() as f64 * self.state.rate) as u64;
            }
            self.tick = Instant::now();
        }
        #[cfg(windows)]
        let seek_pending = self.pending_seek.is_some() || self.loading_seek.is_some();
        #[cfg(not(windows))]
        let seek_pending = false;
        if self.stops.should_pause(
            self.state.position_ms,
            self.state.ready,
            self.state.paused,
            seek_pending,
        ) {
            match self.set("pause", "yes") {
                Ok(()) => {
                    self.state.paused = true;
                    self.stops.completed();
                }
                Err(error) => self.state.error = Some(error.to_string()),
            }
        }
        self.state.snapshot()
    }
}

#[cfg(test)]
mod revision_tests {
    use super::*;

    #[test]
    fn snapshots_order_unchanged_samples_and_preserve_older_values() {
        let mut state = PlayerState::default();
        let first = state.snapshot();
        let second = state.snapshot();
        assert_eq!((first.revision, second.revision), (1, 2));
        assert_eq!(first.position_ms, second.position_ms);
        assert_eq!(serde_json::to_value(second).unwrap()["revision"], 2);
        state.revision = u64::MAX;
        assert_eq!(state.snapshot().revision, u64::MAX);
    }

    #[test]
    fn older_state_payloads_default_to_revision_zero() {
        let mut payload = serde_json::to_value(PlayerState::default()).unwrap();
        payload.as_object_mut().unwrap().remove("revision");
        let restored: PlayerState = serde_json::from_value(payload).unwrap();
        assert_eq!(restored.revision, 0);
    }

    #[cfg(all(not(windows), feature = "e2e-test"))]
    #[test]
    fn poll_revisions_survive_loading_stopping_and_reloading_media() {
        let source = tempfile::NamedTempFile::new().unwrap();
        let mut player = Player::new(Path::new("."), 0).unwrap();
        let first = player.poll();
        let second = player.poll();
        assert_eq!(second.revision, first.revision + 1);
        player.load(source.path()).unwrap();
        let loaded = player.poll();
        assert_eq!(loaded.revision, second.revision + 1);
        player.stop().unwrap();
        let stopped = player.poll();
        assert_eq!(stopped.revision, loaded.revision + 1);
        player.load(source.path()).unwrap();
        assert_eq!(player.poll().revision, stopped.revision + 1);
    }
}

#[cfg(windows)]
fn same_media_path(expected: &str, actual: &str) -> bool {
    // mpv normalizes Windows extended-length prefixes and separators.
    match (
        Path::new(expected).canonicalize(),
        Path::new(actual).canonicalize(),
    ) {
        (Ok(expected), Ok(actual)) => expected == actual,
        _ => false,
    }
}

#[cfg(any(windows, test))]
fn accepts_mpv_option_result(key: &str, value: &str, result: i32) -> bool {
    // Builds without Lua omit these options entirely. A missing option is safe
    // only when disabling scripts; every other failure remains an error.
    result >= 0 || (result == -5 && value == "no" && matches!(key, "load-scripts" | "ytdl"))
}

#[cfg(any(windows, test))]
fn clear_managed_subtitle(
    owned: &mut Option<i64>,
    selected: Option<i64>,
    mut command: impl FnMut(&[&str]) -> Result<()>,
) -> Result<()> {
    if let Some(previous) = *owned {
        // Avoid mpv selecting another subtitle automatically after removal; an
        // explicitly selected unrelated track belongs to the user and stays on.
        if selected == Some(previous) {
            command(&["set", "sid", "no"])?;
        }
        command(&["sub-remove", &previous.to_string()])?;
        // Keep ownership on failure so a subsequent refresh can retry removal.
        *owned = None;
    }
    Ok(())
}

#[cfg(test)]
mod subtitle_tests {
    use super::*;

    #[test]
    fn draft_mode_suppresses_caption_stops_without_losing_the_preference_or_range_end() {
        let mut stops = PlaybackStops::default();
        stops.configure(true, vec![1000, 3000], 0);
        stops.suspended = true;
        stops.arm_sentence(0);
        assert!(stops.enabled);
        assert!(!stops.reached(1000));
        stops.seek(0, Some(2000));
        assert!(!stops.reached(1000));
        assert!(stops.reached(2000));
        stops.completed();
        stops.suspended = false;
        stops.arm_sentence(2000);
        assert!(stops.reached(3000));
        stops.suspended = true;
        stops.reset_media();
        assert!(!stops.suspended);
        assert!(stops.enabled);
    }

    #[test]
    fn sentence_stops_rearm_strictly_after_resume_and_seek() {
        let mut stops = PlaybackStops::default();
        stops.configure(true, vec![3000, 1000, 2000, 2000], 0);
        assert!(!stops.reached(999));
        assert!(stops.reached(1000));
        stops.completed();
        assert!(!stops.reached(1000));
        stops.arm_sentence(1000);
        assert!(!stops.reached(1999));
        assert!(stops.reached(2000));
        stops.seek(2500, None);
        assert!(!stops.reached(2999));
        assert!(stops.reached(3000));
        stops.seek(3000, None);
        assert!(!stops.reached(4000));
        stops.seek(0, None);
        assert!(stops.reached(1000));
    }

    #[test]
    fn explicit_range_and_repeat_take_priority_over_sentence_stops() {
        let mut stops = PlaybackStops::default();
        stops.configure(true, vec![1000, 2000, 3000], 0);
        stops.seek(200, Some(2500));
        assert!(!stops.reached(1000));
        stops.arm_sentence(1200);
        assert!(!stops.reached(2000));
        assert!(stops.reached(2500));
        stops.completed();
        stops.arm_sentence(2550);
        assert!(stops.reached(3000));
        stops.set_repeat(true, 0);
        assert!(!stops.reached(4000));
        stops.configure(true, vec![500, 1500], 0);
        assert!(!stops.reached(1500));
        stops.set_repeat(false, 500);
        assert!(!stops.reached(500));
        assert!(stops.reached(1500));
        stops.set_repeat(true, 0);
        stops.seek(200, None);
        assert!(stops.reached(500));
    }

    #[test]
    fn edits_mode_changes_and_media_switches_discard_old_sentence_endpoints() {
        let mut stops = PlaybackStops::default();
        stops.configure(true, vec![1000, 2000], 400);
        stops.configure(true, vec![1500, 2500], 400);
        assert!(!stops.reached(1000));
        assert!(stops.reached(1500));
        stops.configure(false, vec![1500, 2500], 400);
        assert!(!stops.reached(4000));
        stops.seek(400, Some(900));
        assert!(stops.reached(900));
        stops.reset_media();
        assert!(!stops.reached(4000));
        stops.configure(true, vec![], 0);
        assert!(!stops.reached(4000));
    }

    #[test]
    fn only_compiled_out_script_disabling_options_allow_option_not_found() {
        for key in ["load-scripts", "ytdl"] {
            assert!(accepts_mpv_option_result(key, "no", -5));
            assert!(!accepts_mpv_option_result(key, "yes", -5));
            for result in [-1, -2, -3, -4, -6, -7, -12, -20] {
                assert!(!accepts_mpv_option_result(key, "no", result));
            }
        }
        for key in [
            "config",
            "vo",
            "gpu-api",
            "wid",
            "hwdec",
            "ao",
            "d3d11-warp",
        ] {
            assert!(!accepts_mpv_option_result(key, "no", -5));
            assert!(accepts_mpv_option_result(key, "no", 0));
        }
    }

    #[test]
    fn silence_clears_only_the_managed_track_and_preserves_user_selection() {
        for (selected, expected) in [
            (
                Some(7),
                vec![vec!["set", "sid", "no"], vec!["sub-remove", "7"]],
            ),
            (Some(2), vec![vec!["sub-remove", "7"]]),
            (None, vec![vec!["sub-remove", "7"]]),
        ] {
            let mut owned = Some(7);
            let mut commands = Vec::new();
            clear_managed_subtitle(&mut owned, selected, |args| {
                commands.push(args.iter().map(|s| (*s).to_string()).collect::<Vec<_>>());
                Ok(())
            })
            .unwrap();
            assert_eq!(commands, expected);
            assert_eq!(owned, None);
            clear_managed_subtitle(&mut owned, selected, |_| {
                panic!("already cleared track must not remove a user track")
            })
            .unwrap();
        }
    }

    #[test]
    fn failed_clear_retains_ownership_for_explicit_refresh_retry() {
        let mut owned = Some(7);
        assert!(
            clear_managed_subtitle(&mut owned, Some(7), |args| {
                if args[0] == "sub-remove" {
                    bail!("fixture removal failed")
                }
                Ok(())
            })
            .is_err()
        );
        assert_eq!(owned, Some(7));
        clear_managed_subtitle(&mut owned, None, |args| {
            assert_eq!(args, ["sub-remove", "7"]);
            Ok(())
        })
        .unwrap();
        assert_eq!(owned, None);
    }
    #[cfg(all(windows, feature = "e2e-test"))]
    #[test]
    #[ignore = "explicit Windows libmpv regression; set SURTITLE_TEST_FFMPEG; requires prepared native DLLs"]
    fn real_mpv_load_restores_position_and_maps_audio_stream() {
        use windows_sys::Win32::UI::WindowsAndMessaging::*;
        fn pump_messages() {
            unsafe {
                let mut message = std::mem::zeroed();
                while PeekMessageW(&mut message, std::ptr::null_mut(), 0, 0, PM_REMOVE) != 0 {
                    TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
            }
        }
        fn command(action: &str, start_ms: Option<u64>, end_ms: Option<u64>) -> Control {
            Control {
                action: action.into(),
                value: None,
                start_ms,
                end_ms,
                bounds: None,
                track_kind: None,
            }
        }
        fn assert_subtitles_hidden(player: &Player) {
            for property in ["sub-visibility", "secondary-sub-visibility"] {
                assert_eq!(player.native.string(property).as_deref(), Some("no"));
            }
        }
        fn wait_for_hidden_subtitle(player: &mut Player, text: &str) {
            let deadline = Instant::now() + std::time::Duration::from_secs(5);
            loop {
                pump_messages();
                let state = player.poll();
                assert!(state.error.is_none(), "{:?}", state.error);
                assert_subtitles_hidden(player);
                if player
                    .subtitle_text()
                    .is_some_and(|value| value.contains(text))
                {
                    return;
                }
                assert!(
                    Instant::now() < deadline,
                    "hidden subtitle was not decoded: {text}"
                );
                std::thread::sleep(std::time::Duration::from_millis(30));
            }
        }
        fn wait_for_stop(player: &mut Player, expected: u64) {
            let deadline = Instant::now() + std::time::Duration::from_secs(5);
            loop {
                pump_messages();
                let state = player.poll();
                assert!(state.error.is_none(), "{:?}", state.error);
                if state.paused {
                    assert!(
                        (expected..=expected + 350).contains(&state.position_ms),
                        "expected stop near {expected}, got {}",
                        state.position_ms
                    );
                    return;
                }
                assert!(
                    Instant::now() < deadline,
                    "did not pause at {expected}: {}",
                    state.position_ms
                );
                std::thread::sleep(std::time::Duration::from_millis(30));
            }
        }
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("日本語 & resume.mkv");
        let embedded = temp.path().join("embedded.srt");
        std::fs::write(
            &embedded,
            "1\n00:00:00,000 --> 00:00:03,000\nEmbedded caption\n",
        )
        .unwrap();
        let ffmpeg = std::path::PathBuf::from(
            std::env::var_os("SURTITLE_TEST_FFMPEG").expect("explicit FFmpeg path"),
        );
        let snapshot = surtitle_tools::ToolSnapshot::capture(
            surtitle_tools::resolve_external(surtitle_tools::ToolKind::FfmpegPair, &ffmpeg)
                .unwrap(),
        )
        .unwrap();
        snapshot.verify().unwrap();
        let output = std::process::Command::new(&snapshot.tool.executable)
            .args([
                "-nostdin",
                "-v",
                "error",
                "-n",
                "-f",
                "lavfi",
                "-i",
                "color=c=black:s=32x32:r=5",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=16000",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=880:sample_rate=16000",
                "-i",
                embedded.to_str().unwrap(),
                "-t",
                "3",
                "-map",
                "0:v",
                "-map",
                "1:a",
                "-map",
                "2:a",
                "-map",
                "3:s",
                "-c:v",
                "ffv1",
                "-c:a",
                "pcm_s16le",
                "-c:s",
                "srt",
            ])
            .arg(&source)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let class = "STATIC\0".encode_utf16().collect::<Vec<_>>();
        let parent = unsafe {
            CreateWindowExW(
                0,
                class.as_ptr(),
                std::ptr::null(),
                WS_POPUP,
                -32000,
                0,
                32,
                32,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null(),
            )
        };
        assert!(!parent.is_null());
        {
            let bundled = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/native/mpv-2.dll");
            let resources = temp.path().join("resources");
            std::fs::create_dir_all(resources.join("native")).unwrap();
            let runtime = resources.join("native/mpv-2.dll");
            let mut bytes = std::fs::read(&bundled).unwrap();
            // A PE overlay changes the DLL digest without changing its exported API or code.
            bytes.extend_from_slice(b"\nSurtitle native runtime load regression\n");
            std::fs::write(&runtime, bytes).unwrap();
            assert_ne!(
                surtitle_tools::sha256_file(&runtime).unwrap(),
                surtitle_tools::sha256_file(&bundled).unwrap()
            );
            let mut reopening = Player::new(&resources, parent as isize).unwrap();
            assert_eq!(reopening.native.number("volume"), Some(80.));
            let invalid = reopening
                .native
                .command(&["surtitle-invalid-command"])
                .unwrap_err()
                .to_string();
            assert!(
                invalid.contains("mpv command surtitle-invalid-command failed:"),
                "{invalid}"
            );
            assert!(invalid.contains("invalid parameter (-4)"), "{invalid}");
            // Development StrictMode and quick navigation can reopen media
            // before an earlier native load has finished.
            for attempt in 0..20 {
                let previous = reopening
                    .pending_subtitle
                    .as_ref()
                    .map(|path| path.to_path_buf());
                reopening.load(&source).unwrap();
                assert!(previous.is_none_or(|path| !path.exists()));
                let caption = temp.path().join("reopening.srt");
                std::fs::write(
                    &caption,
                    format!("1\n00:00:00,000 --> 00:00:03,000\nReopened caption {attempt}\n"),
                )
                .unwrap();
                reopening
                    .subtitle(&caption)
                    .unwrap_or_else(|error| panic!("rapid load {attempt}: {error}"));
                std::fs::remove_file(caption).unwrap();
            }
            let pending = reopening.pending_subtitle.as_ref().unwrap().to_path_buf();
            wait_for_hidden_subtitle(&mut reopening, "Reopened caption 19");
            assert!(!pending.exists());
            assert_eq!(
                reopening
                    .poll()
                    .tracks
                    .iter()
                    .filter(|track| track.title == "Surtitle")
                    .count(),
                1
            );

            // Clearing captions or stopping before FILE_LOADED must discard
            // both the deferred update and its private temporary file.
            reopening.load(&source).unwrap();
            reopening.subtitle(&embedded).unwrap();
            let pending = reopening.pending_subtitle.as_ref().unwrap().to_path_buf();
            reopening.clear_subtitle().unwrap();
            assert!(reopening.pending_subtitle.is_none());
            assert!(!pending.exists());
            reopening.subtitle(&embedded).unwrap();
            let pending = reopening.pending_subtitle.as_ref().unwrap().to_path_buf();
            reopening.stop().unwrap();
            assert!(reopening.pending_subtitle.is_none());
            assert!(!pending.exists());
        }
        for hook in ["on_load", "on_preloaded"] {
            // Hold mpv while it opens the file, so the first subtitle refresh
            // is guaranteed to happen during loading regardless of disk speed.
            let resources = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources");
            let mut delayed = Player::new(&resources, parent as isize).unwrap();
            let opening_subtitle = temp.path().join("delayed-opening.srt");
            std::fs::write(
                &opening_subtitle,
                "1\n00:00:00,000 --> 00:00:03,000\nQueued study caption\n",
            )
            .unwrap();
            delayed.native.hold_file_load_for_test(hook).unwrap();
            delayed.load(&source).unwrap();
            let hook_id = delayed.native.wait_file_load_hook_for_test().unwrap();
            delayed.subtitle(&embedded).unwrap();
            let replaced = delayed.pending_subtitle.as_ref().unwrap().to_path_buf();
            let subtitle_result = delayed.subtitle(&opening_subtitle);
            assert!(!replaced.exists());
            std::fs::remove_file(&opening_subtitle).unwrap();
            delayed.native.resume_file_load_for_test(hook_id).unwrap();
            subtitle_result.unwrap_or_else(|error| panic!("{hook}: {error}"));
            wait_for_hidden_subtitle(&mut delayed, "Queued study caption");
            let managed = delayed
                .poll()
                .tracks
                .into_iter()
                .find(|track| track.title == "Surtitle")
                .unwrap();
            assert_eq!(delayed.subtitle_track, Some(managed.id));
            delayed.subtitle(&embedded).unwrap();
            wait_for_hidden_subtitle(&mut delayed, "Embedded caption");
        }
        {
            let resources = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources");
            let mut player = Player::new(&resources, parent as isize).unwrap();
            assert_subtitles_hidden(&player);
            assert!(
                player
                    .control(&command("toggle-pause", None, None))
                    .is_err()
            );
            let initial_revision = player.poll().revision;
            player
                .load_selected(&source.canonicalize().unwrap(), 1500, Some(2))
                .unwrap();
            // The app refreshes its study subtitles immediately after loadfile,
            // before the first FILE_LOADED event, and removes the source file.
            let opening_subtitle = temp.path().join("opening.srt");
            std::fs::write(
                &opening_subtitle,
                "1\n00:00:00,000 --> 00:00:03,000\nFirst load study caption\n",
            )
            .unwrap();
            player.subtitle(&opening_subtitle).unwrap();
            std::fs::remove_file(&opening_subtitle).unwrap();
            assert!(!player.state.ready);
            assert_eq!(player.state.position_ms, 1500);
            assert_eq!(player.poll().revision, initial_revision + 1);
            let deadline = Instant::now() + std::time::Duration::from_secs(10);
            loop {
                pump_messages();
                let state = player.poll();
                if state.ready {
                    break;
                }
                assert!(
                    Instant::now() < deadline,
                    "mpv load did not become ready: {:?}; path={:?}; duration={:?}",
                    state.error,
                    player.native.string("path"),
                    player.native.number("duration")
                );
                std::thread::sleep(std::time::Duration::from_millis(30));
            }
            for _ in 0..10 {
                pump_messages();
                player.poll();
                std::thread::sleep(std::time::Duration::from_millis(30));
            }
            let state = player.poll();
            assert!(state.error.is_none(), "{:?}", state.error);
            assert!(state.paused);
            assert!(
                (1400..=1700).contains(&state.position_ms),
                "resume position was {}",
                state.position_ms
            );
            wait_for_hidden_subtitle(&mut player, "First load study caption");
            let embedded_track = state
                .tracks
                .iter()
                .find(|track| track.kind == "sub" && track.ff_index == Some(3))
                .unwrap();
            player
                .control(&Control {
                    value: Some(embedded_track.id as f64),
                    track_kind: Some("sub".into()),
                    ..command("track", None, None)
                })
                .unwrap();
            wait_for_hidden_subtitle(&mut player, "Embedded caption");
            for (index, text) in ["Study caption", "Updated caption"].into_iter().enumerate() {
                let subtitle = temp.path().join(format!("study-{index}.srt"));
                std::fs::write(
                    &subtitle,
                    format!("1\n00:00:00,000 --> 00:00:03,000\n{text}\n"),
                )
                .unwrap();
                player.subtitle(&subtitle).unwrap();
                wait_for_hidden_subtitle(&mut player, text);
                assert_eq!(
                    player
                        .poll()
                        .tracks
                        .iter()
                        .filter(|track| track.kind == "sub" && track.title == "Surtitle")
                        .count(),
                    1
                );
            }
            assert_eq!(
                state
                    .tracks
                    .iter()
                    .find(|t| t.kind == "audio" && t.selected)
                    .and_then(|t| t.ff_index),
                Some(2)
            );
            player.select_audio_stream(1).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(100));
            assert_eq!(
                player
                    .poll()
                    .tracks
                    .iter()
                    .find(|t| t.kind == "audio" && t.selected)
                    .and_then(|t| t.ff_index),
                Some(1)
            );
            let previous_revision = player.poll().revision;
            player.stop().unwrap();
            assert_eq!(player.poll().revision, previous_revision + 1);
            player.load(&source).unwrap();
            assert_subtitles_hidden(&player);
            assert_eq!(player.poll().revision, previous_revision + 2);
            player
                .control(&Control {
                    action: "play".into(),
                    value: None,
                    start_ms: None,
                    end_ms: None,
                    bounds: None,
                    track_kind: None,
                })
                .unwrap();
            let deadline = Instant::now() + std::time::Duration::from_secs(10);
            loop {
                pump_messages();
                let state = player.poll();
                if state.ready && state.position_ms >= 100 {
                    assert!(!state.paused, "explicit play during load was lost");
                    break;
                }
                assert!(
                    Instant::now() < deadline,
                    "explicit play did not start: {:?}",
                    state.error
                );
                std::thread::sleep(std::time::Duration::from_millis(30));
            }
            // Exercise the real video host, which contains mpv's disabled child.
            // Its click only emits an intent; playback remains owned by control.
            let clicks = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let observed = clicks.clone();
            player
                .on_surface_click(move || {
                    observed.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                })
                .unwrap();
            unsafe {
                ShowWindow(parent, SW_SHOWNOACTIVATE);
            }
            player
                .native
                .bounds(&Bounds {
                    x: 0.,
                    y: 0.,
                    width: 32.,
                    height: 32.,
                    scale_factor: 1.,
                })
                .unwrap();
            let host = player.native.surface_window();
            unsafe {
                let decoder = GetWindow(host, GW_CHILD);
                assert!(!decoder.is_null(), "mpv did not create its embedded child");
                assert_ne!(
                    GetWindowLongPtrW(decoder, GWL_STYLE) as u32 & WS_DISABLED,
                    0
                );
                assert_eq!(SendMessageW(host, WM_NCHITTEST, 0, 0), HTCLIENT as isize);
                SendMessageW(host, WM_LBUTTONDOWN, 0, 10 | (10 << 16));
                SendMessageW(host, WM_LBUTTONUP, 0, 10 | (10 << 16));
            }
            assert_eq!(clicks.load(std::sync::atomic::Ordering::Relaxed), 1);
            assert!(
                !player.poll().paused,
                "the native callback bypassed playback control"
            );
            player
                .control(&command("toggle-pause", None, None))
                .unwrap();
            assert!(player.poll().paused);
            assert_eq!(player.native.string("pause").as_deref(), Some("yes"));
            player
                .control(&command("toggle-pause", None, None))
                .unwrap();
            assert!(!player.poll().paused);
            assert_eq!(player.native.string("pause").as_deref(), Some("no"));
            // Exercise the real decoder clock, independently of webview timers.
            for target in [1800, 400] {
                let mut revision = player.poll().revision;
                player
                    .control(&command("seek", Some(target), None))
                    .unwrap();
                assert!(player.pending_seek.is_some());
                // Toggle intent during a native seek must survive its restart.
                player
                    .control(&command("toggle-pause", None, None))
                    .unwrap();
                assert!(player.state.paused);
                player
                    .control(&command("toggle-pause", None, None))
                    .unwrap();
                assert!(!player.state.paused);
                let deadline = Instant::now() + std::time::Duration::from_secs(5);
                loop {
                    pump_messages();
                    let state = player.poll();
                    assert!(state.revision > revision);
                    revision = state.revision;
                    assert!(state.error.is_none(), "{:?}", state.error);
                    if player.pending_seek.is_none() {
                        assert!(
                            state.position_ms.abs_diff(target) <= 250,
                            "settled seek to {target} reported {}",
                            state.position_ms
                        );
                        assert!(!state.paused, "seek to {target} lost playing state");
                        let decoder_ms = player.native.number("time-pos").unwrap() * 1000.;
                        assert!(
                            (decoder_ms - target as f64).abs() <= 250.,
                            "decoder seek to {target} settled at {decoder_ms}"
                        );
                        assert_eq!(player.native.string("pause").as_deref(), Some("no"));
                        break;
                    }
                    assert!(Instant::now() < deadline, "seek to {target} did not finish");
                    std::thread::sleep(std::time::Duration::from_millis(30));
                }
            }
            player.configure_sentence_pause(true, vec![500, 1500, 2500]);
            player.control(&command("seek", Some(0), None)).unwrap();
            wait_for_stop(&mut player, 500);
            player
                .control(&command("toggle-pause", None, None))
                .unwrap();
            wait_for_stop(&mut player, 1500);
            player
                .control(&command("seek", Some(0), Some(2100)))
                .unwrap();
            wait_for_stop(&mut player, 2100);
            player.control(&command("seek", Some(0), None)).unwrap();
            player
                .control(&command("loop", Some(0), Some(1000)))
                .unwrap();
            player.control(&command("play", None, None)).unwrap();
            let repeat_until = Instant::now() + std::time::Duration::from_millis(2200);
            let mut passed_sentence_end = false;
            let mut repeat_positions = Vec::new();
            while Instant::now() < repeat_until {
                pump_messages();
                let state = player.poll();
                assert!(
                    !state.paused,
                    "sentence mode interrupted the selected repeat"
                );
                passed_sentence_end |= state.position_ms > 500;
                repeat_positions.push(state.position_ms);
                std::thread::sleep(std::time::Duration::from_millis(30));
            }
            assert!(
                passed_sentence_end,
                "repeat did not cross the sentence endpoint: {repeat_positions:?}; seeking={:?}; eof={:?}",
                player.native.string("seeking"),
                player.native.string("eof-reached")
            );
            player.control(&command("pause", None, None)).unwrap();
            player.control(&command("loop", None, None)).unwrap();
            player.control(&command("seek", Some(0), None)).unwrap();
            player.configure_sentence_pause(true, vec![800, 1600, 2400]);
            player.control(&command("play", None, None)).unwrap();
            wait_for_stop(&mut player, 800);
            // A new load cancels both an active seek and its superseding target.
            player
                .control(&command("seek", Some(0), Some(2100)))
                .unwrap();
            player
                .control(&command("seek", Some(1000), Some(2500)))
                .unwrap();
            player.load(&source).unwrap();
            assert!(player.pending_seek.is_none());
            assert!(player.loading_seek.is_none());
            // Seeking before FILE_LOADED must preserve that event and apply to
            // the newly loaded file, with its own explicit range stop.
            player
                .control(&command("seek", Some(500), Some(900)))
                .unwrap();
            assert_eq!(player.loading_seek.unwrap().target, 500);
            wait_for_stop(&mut player, 900);
            let invalid = temp.path().join("broken.mkv");
            std::fs::write(&invalid, b"not a media container").unwrap();
            player.load(&invalid).unwrap();
            let deadline = Instant::now() + std::time::Duration::from_secs(10);
            loop {
                pump_messages();
                let state = player.poll();
                if state.error.is_some() {
                    assert!(!state.ready);
                    break;
                }
                assert!(
                    Instant::now() < deadline,
                    "invalid media remained in loading state"
                );
                std::thread::sleep(std::time::Duration::from_millis(30));
            }
        }
        unsafe {
            DestroyWindow(parent);
        }
    }
}

#[cfg(windows)]
mod native;
