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

pub struct Player {
    #[cfg(windows)]
    native: native::Mpv,
    state: PlayerState,
    stops: PlaybackStops,
    pending_load: Option<(String, u64, Option<u32>)>,
    #[cfg(windows)]
    subtitle_track: Option<i64>,
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
            Ok(Self {
                #[cfg(windows)]
                native,
                state: PlayerState::default(),
                stops: PlaybackStops::default(),
                pending_load: None,
                #[cfg(windows)]
                subtitle_track: None,
                tick: Instant::now(),
            })
        }
    }
    pub fn load(&mut self, path: &Path) -> Result<()> {
        self.load_selected(path, 0, None)
    }
    /// Unload the old file and its pending stops without changing window geometry.
    /// The caller hides the surface when no replacement media can be opened.
    pub fn stop(&mut self) -> Result<()> {
        self.set("pause", "yes")?;
        #[cfg(windows)]
        self.native.command(&["stop"])?;
        self.state = PlayerState {
            rate: self.state.rate,
            volume: self.state.volume,
            sentence_pause: self.state.sentence_pause,
            ..Default::default()
        };
        self.pending_load = None;
        self.stops.reset_media();
        #[cfg(windows)]
        {
            self.subtitle_track = None;
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
            let selected = self.native.number("sid").map(|v| v as i64);
            clear_managed_subtitle(&mut self.subtitle_track, selected, |args| {
                self.native.command(args)
            })?;
        }
        Ok(())
    }
    pub fn control(&mut self, c: &Control) -> Result<()> {
        match c.action.as_str() {
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
                self.stops.arm_sentence(self.state.position_ms);
                self.state.paused = false;
                self.set("pause", "no")?;
            }
            "pause" => {
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
                self.state.position_ms = target;
                self.set("time-pos", &(target as f64 / 1000.).to_string())?;
                self.stops.seek(target, c.end_ms);
                if c.end_ms.is_some() {
                    self.state.paused = false;
                    self.set("pause", "no")?;
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
                self.native.bounds(b);
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
    pub fn configure_sentence_pause(&mut self, enabled: bool, ends: Vec<u64>) {
        self.state.sentence_pause = enabled;
        self.stops.configure(enabled, ends, self.state.position_ms);
    }
    pub fn poll(&mut self) -> PlayerState {
        #[cfg(windows)]
        {
            let (loaded, load_error) = self.native.drain_events();
            if let Some(error) = load_error {
                self.state.error = Some(format!(
                    "Media playback failed (mpv error {error}). Check the file or choose another media source."
                ));
                self.state.ready = false;
                self.pending_load = None;
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
                    if let Some(index) = audio {
                        let track = tracks
                            .iter()
                            .find(|t| t.kind == "audio" && !t.external && t.ff_index == Some(index))
                            .context("Saved audio stream is unavailable; choose another track")?;
                        self.native.set("aid", &track.id.to_string())?;
                    }
                    if position > 0 {
                        let duration = self.native.number("duration").unwrap_or(f64::MAX) * 1000.;
                        let position = position.min(duration.max(0.) as u64);
                        self.native
                            .set("time-pos", &(position as f64 / 1000.).to_string())?;
                        self.state.position_ms = position;
                    }
                    self.native
                        .set("pause", if self.state.paused { "yes" } else { "no" })?;
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
                && let Some(p) = self.native.string("pause")
            {
                self.state.paused = p == "yes";
            }
            self.state.tracks = self.native.tracks();
            self.state.surface_visible = self.native.visible();
            self.state.video_width = self.native.number("video-params/w").unwrap_or(0.) as u32;
            self.state.video_height = self.native.number("video-params/h").unwrap_or(0.) as u32;
        }
        #[cfg(all(not(windows), feature = "e2e-test"))]
        {
            if !self.state.paused {
                self.state.position_ms +=
                    (self.tick.elapsed().as_millis() as f64 * self.state.rate) as u64;
            }
            self.tick = Instant::now();
        }
        if !self.state.paused && self.state.ready && self.stops.reached(self.state.position_ms) {
            match self.set("pause", "yes") {
                Ok(()) => {
                    self.state.paused = true;
                    self.stops.completed();
                }
                Err(error) => self.state.error = Some(error.to_string()),
            }
        }
        self.state.clone()
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
                "-t",
                "3",
                "-map",
                "0:v",
                "-map",
                "1:a",
                "-map",
                "2:a",
                "-c:v",
                "ffv1",
                "-c:a",
                "pcm_s16le",
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
                0,
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
            let resources = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources");
            let mut player = Player::new(&resources, parent as isize).unwrap();
            player
                .load_selected(&source.canonicalize().unwrap(), 1500, Some(2))
                .unwrap();
            assert!(!player.state.ready);
            assert_eq!(player.state.position_ms, 1500);
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
            player.load(&source).unwrap();
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
            // Exercise the real decoder clock, independently of webview timers.
            player.configure_sentence_pause(true, vec![500, 1500, 2500]);
            player.control(&command("seek", Some(0), None)).unwrap();
            wait_for_stop(&mut player, 500);
            player.control(&command("play", None, None)).unwrap();
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
