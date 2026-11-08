//! Opt-in support measurements; no playback controls or UI transport.
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::{
    fs::File,
    io::{self, Write},
    path::Path,
    time::Duration,
};

const SAMPLE_INTERVAL: Duration = Duration::from_millis(250);
const SESSION_LIMIT: Duration = Duration::from_secs(600);
#[cfg(windows)]
const BYTE_LIMIT: usize = 8 * 1024 * 1024;

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Properties {
    pub values: BTreeMap<String, Value>,
    pub errors: BTreeMap<String, i32>,
}

impl Properties {
    pub fn insert(&mut self, name: &str, result: Result<Value, i32>) {
        match result {
            Ok(value) => {
                self.errors.remove(name);
                self.values.insert(name.into(), value);
            }
            Err(code) => {
                self.values.insert(name.into(), Value::Null);
                self.errors.insert(name.into(), code);
            }
        }
    }
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Interval {
    av_sync_eligible: bool,
    counter_reset: bool,
    vo_drops_since_previous: Option<i64>,
    decoder_drops_since_previous: Option<i64>,
}

#[derive(Default)]
struct Sampler {
    previous: Option<Previous>,
}

struct Previous {
    active: bool,
    position: Option<f64>,
    vo: Option<i64>,
    decoder: Option<i64>,
}

impl Sampler {
    fn reset(&mut self) {
        self.previous = None;
    }
    fn observe(&mut self, p: &Properties, ready_av: bool) -> Interval {
        let number = |name| {
            p.values
                .get(name)
                .and_then(Value::as_f64)
                .filter(|v| v.is_finite())
        };
        let count = |name| {
            p.values
                .get(name)
                .and_then(Value::as_i64)
                .filter(|v| *v >= 0)
        };
        let current = Previous {
            active: ready_av
                && [
                    "pause",
                    "seeking",
                    "idle-active",
                    "eof-reached",
                    "core-idle",
                    "paused-for-cache",
                ]
                .iter()
                .all(|name| p.values.get(*name).and_then(Value::as_bool) == Some(false))
                && number("audio-pts").is_some(),
            position: number("time-pos"),
            vo: count("frame-drop-count"),
            decoder: count("decoder-frame-drop-count"),
        };
        let mut interval = Interval::default();
        if let Some(previous) = &self.previous {
            let reset = |before: Option<i64>, after: Option<i64>| {
                before.zip(after).is_some_and(|(a, b)| b < a)
            };
            interval.counter_reset =
                reset(previous.vo, current.vo) || reset(previous.decoder, current.decoder);
            let advancing = previous
                .position
                .zip(current.position)
                .is_some_and(|(a, b)| b > a);
            if previous.active && current.active && advancing && !interval.counter_reset {
                interval.av_sync_eligible = number("avsync").is_some();
                interval.vo_drops_since_previous = previous.vo.zip(current.vo).map(|(a, b)| b - a);
                interval.decoder_drops_since_previous =
                    previous.decoder.zip(current.decoder).map(|(a, b)| b - a);
            }
        }
        self.previous = Some(current);
        interval
    }
}

#[derive(Default)]
struct Schedule {
    previous: Option<Duration>,
}
impl Schedule {
    fn due(&mut self, elapsed: Duration) -> bool {
        if elapsed >= SESSION_LIMIT
            || self
                .previous
                .is_some_and(|last| elapsed.saturating_sub(last) < SAMPLE_INTERVAL)
        {
            return false;
        }
        self.previous = Some(elapsed);
        true
    }
}
fn open_output(path: &Path) -> io::Result<File> {
    if !path.is_absolute() {
        return Err(io::Error::other(
            "Playback diagnostics require an absolute file path",
        ));
    }
    #[cfg(windows)]
    if !matches!(path.components().next(), Some(std::path::Component::Prefix(p))
        if matches!(p.kind(), std::path::Prefix::Disk(_) | std::path::Prefix::VerbatimDisk(_)))
    {
        return Err(io::Error::other(
            "Playback diagnostics require a local disk path",
        ));
    }
    File::options().write(true).create_new(true).open(path)
}
fn write_record(
    output: &mut impl Write,
    remaining: &mut usize,
    record: &impl Serialize,
) -> io::Result<bool> {
    let mut bytes = serde_json::to_vec(record)?;
    bytes.push(b'\n');
    if bytes.len() > *remaining {
        return Ok(false);
    }
    output.write_all(&bytes)?;
    output.flush()?;
    *remaining -= bytes.len();
    Ok(true)
}

#[cfg(windows)]
pub(super) struct Diagnostics {
    started: std::time::Instant,
    sender: Option<std::sync::mpsc::SyncSender<Value>>,
    schedule: Schedule,
    sampler: Sampler,
    source_path_sha256: Option<String>,
    load_sequence: u64,
    epoch: u64,
    sequence: u64,
    omitted: u64,
}

#[cfg(windows)]
impl Diagnostics {
    pub fn from_env() -> Option<Self> {
        let path = std::env::var_os("SURTITLE_PLAYBACK_DIAGNOSTICS")?;
        match Self::open(Path::new(&path)) {
            Ok(diagnostics) => Some(diagnostics),
            Err(error) => {
                eprintln!("Playback diagnostics disabled: {error}");
                None
            }
        }
    }

    fn open(path: &Path) -> io::Result<Self> {
        let mut file = open_output(path)?;
        let started = std::time::Instant::now();
        let (sender, receiver) = std::sync::mpsc::sync_channel::<Value>(32);
        let header = serde_json::json!({
            "type": "session", "schemaVersion": 1, "pid": std::process::id(),
            "appVersion": env!("CARGO_PKG_VERSION"), "startedUtc": chrono::Utc::now().to_rfc3339(),
            "minimumSampleIntervalMs": SAMPLE_INTERVAL.as_millis(),
            "maximumSessionMs": SESSION_LIMIT.as_millis(), "maximumBytes": BYTE_LIMIT,
            "avSyncClock": "mpv audio output delay adjusted playback clock minus video PTS plus configured delay/timing offset; not physical speaker/display arrival",
            "dropCounters": "mpv decoder and video-output counters, not compositor/display-present counters",
            "sourceIdentity": "SHA256 of the UTF-8 source path, not file contents"
        });
        std::thread::Builder::new()
            .name("playback-diagnostics".into())
            .spawn(move || {
                let result = (|| -> io::Result<()> {
                    let mut remaining = BYTE_LIMIT;
                    write_record(&mut file, &mut remaining, &header)?;
                    while let Some(wait) = SESSION_LIMIT.checked_sub(started.elapsed()) {
                        let Ok(record) = receiver.recv_timeout(wait) else {
                            break;
                        };
                        if !write_record(&mut file, &mut remaining, &record)? {
                            break;
                        }
                    }
                    Ok(())
                })();
                if let Err(error) = result {
                    eprintln!("Playback diagnostics stopped: {error}");
                }
            })?;
        Ok(Self {
            started,
            sender: Some(sender),
            schedule: Schedule::default(),
            sampler: Sampler::default(),
            source_path_sha256: None,
            load_sequence: 0,
            epoch: 0,
            sequence: 0,
            omitted: 0,
        })
    }

    pub fn source(&mut self, path: Option<&Path>) {
        use sha2::{Digest, Sha256};
        self.source_path_sha256 =
            path.map(|p| format!("{:x}", Sha256::digest(p.to_string_lossy().as_bytes())));
        self.load_sequence += 1;
        self.discontinuity();
    }

    pub fn discontinuity(&mut self) {
        self.epoch += 1;
        self.sampler.reset();
    }

    pub fn due(&mut self) -> bool {
        self.sender.is_some() && self.schedule.due(self.started.elapsed())
    }

    pub fn record(
        &mut self,
        properties: Properties,
        state: &super::PlayerState,
        seek_pending: bool,
        property_read: Duration,
    ) {
        let audio = state
            .tracks
            .iter()
            .find(|t| t.kind == "audio" && t.selected)
            .map(|t| t.id);
        let video = state
            .tracks
            .iter()
            .find(|t| t.kind == "video" && t.selected)
            .map(|t| t.id);
        let interval = self.sampler.observe(
            &properties,
            state.ready && !seek_pending && audio.is_some() && video.is_some(),
        );
        if interval.counter_reset {
            self.epoch += 1;
        }
        let record = serde_json::json!({
            "type": "sample", "sequence": self.sequence, "utc": chrono::Utc::now().to_rfc3339(),
            "elapsedMs": self.started.elapsed().as_secs_f64() * 1000.0,
            "propertyReadMs": property_read.as_secs_f64() * 1000.0,
            "loadSequence": self.load_sequence, "epoch": self.epoch,
            "sourcePathSha256": self.source_path_sha256, "samplesOmitted": self.omitted,
            "ready": state.ready, "seekPending": seek_pending, "surfaceVisible": state.surface_visible,
            "videoWidth": state.video_width, "videoHeight": state.video_height,
            "audioTrackId": audio, "videoTrackId": video,
            "properties": properties.values, "propertyErrors": properties.errors, "interval": interval
        });
        self.sequence += 1;
        if let Some(sender) = &self.sender {
            match sender.try_send(record) {
                Ok(()) => {}
                Err(std::sync::mpsc::TrySendError::Full(_)) => {
                    self.omitted += 1;
                }
                Err(std::sync::mpsc::TrySendError::Disconnected(_)) => {
                    self.sender = None;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn playing(position: f64, vo: i64, decoder: i64) -> Properties {
        let mut p = Properties::default();
        for name in [
            "pause",
            "seeking",
            "idle-active",
            "eof-reached",
            "core-idle",
            "paused-for-cache",
        ] {
            p.insert(name, Ok(json!(false)));
        }
        for (name, value) in [
            ("time-pos", position),
            ("audio-pts", position),
            ("avsync", 0.0),
        ] {
            p.insert(name, Ok(json!(value)));
        }
        p.insert("frame-drop-count", Ok(json!(vo)));
        p.insert("decoder-frame-drop-count", Ok(json!(decoder)));
        p
    }

    #[test]
    fn advancing_playback_measures_separate_counter_deltas_after_a_baseline() {
        let mut s = Sampler::default();
        assert!(!s.observe(&playing(1.0, 4, 2), true).av_sync_eligible);
        let measured = s.observe(&playing(1.3, 7, 3), true);
        assert!(measured.av_sync_eligible);
        assert_eq!(measured.vo_drops_since_previous, Some(3));
        assert_eq!(measured.decoder_drops_since_previous, Some(1));
    }

    #[test]
    fn paused_seeking_buffering_and_unavailable_state_never_certify_zero_sync() {
        for name in [
            "pause",
            "seeking",
            "idle-active",
            "eof-reached",
            "core-idle",
            "paused-for-cache",
        ] {
            let mut s = Sampler::default();
            s.observe(&playing(1.0, 0, 0), true);
            let mut p = playing(1.3, 0, 0);
            p.insert(name, Ok(json!(true)));
            assert!(!s.observe(&p, true).av_sync_eligible, "{name}");
            assert!(
                !s.observe(&playing(1.6, 0, 0), true).av_sync_eligible,
                "baseline after {name}"
            );
        }
        let mut s = Sampler::default();
        s.observe(&playing(1.0, 0, 0), true);
        assert!(!s.observe(&playing(1.0, 0, 0), true).av_sync_eligible);
        assert!(!s.observe(&playing(1.3, 0, 0), false).av_sync_eligible);
    }

    #[test]
    fn counter_reset_and_new_source_start_a_new_measurement_interval() {
        let mut s = Sampler::default();
        s.observe(&playing(1.0, 4, 2), true);
        let reset = s.observe(&playing(1.3, 0, 0), true);
        assert!(reset.counter_reset);
        assert!(!reset.av_sync_eligible);
        assert_eq!(reset.vo_drops_since_previous, None);
        assert_eq!(
            s.observe(&playing(1.6, 1, 0), true).vo_drops_since_previous,
            Some(1)
        );
        s.reset();
        assert_eq!(
            s.observe(&playing(0.3, 10, 0), true)
                .vo_drops_since_previous,
            None
        );
    }

    #[test]
    fn unavailable_values_remain_null_with_the_mpv_error_and_break_measurements() {
        let mut s = Sampler::default();
        s.observe(&playing(1.0, 0, 0), true);
        let mut p = playing(1.3, 0, 0);
        p.insert("avsync", Err(-10));
        p.insert("frame-drop-count", Err(-11));
        let result = s.observe(&p, true);
        assert!(!result.av_sync_eligible);
        assert_eq!(result.vo_drops_since_previous, None);
        let data = serde_json::to_value(p).unwrap();
        assert!(data["values"]["avsync"].is_null());
        assert!(data["values"]["frame-drop-count"].is_null());
        assert_eq!(data["errors"]["avsync"], -10);
        assert_eq!(data["errors"]["frame-drop-count"], -11);
        let mut missing_state = playing(1.6, 0, 0);
        missing_state.insert("pause", Err(-10));
        assert!(!s.observe(&missing_state, true).av_sync_eligible);
        assert!(!s.observe(&playing(1.9, 0, 0), true).av_sync_eligible);
    }

    #[test]
    fn repeated_polling_is_bounded_and_expired_sessions_stop_sampling() {
        let mut schedule = Schedule::default();
        assert!(schedule.due(Duration::ZERO));
        assert!(!schedule.due(Duration::from_millis(100)));
        assert!(!schedule.due(Duration::from_millis(249)));
        assert!(schedule.due(Duration::from_millis(300)));
        assert!(!schedule.due(Duration::from_secs(601)));
    }

    #[test]
    fn log_creation_requires_a_fresh_absolute_path_and_preserves_existing_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("capture.jsonl");
        assert!(open_output(Path::new("relative.jsonl")).is_err());
        let mut file = open_output(&path).unwrap();
        file.write_all(b"existing evidence").unwrap();
        drop(file);
        assert!(open_output(&path).is_err());
        assert_eq!(std::fs::read(path).unwrap(), b"existing evidence");
    }

    #[test]
    fn byte_limit_keeps_complete_json_records_and_io_failure_is_reported() {
        let mut output = Vec::new();
        let mut budget = 8;
        assert!(write_record(&mut output, &mut budget, &json!({"a":1})).unwrap());
        assert_eq!(output, b"{\"a\":1}\n");
        assert!(!write_record(&mut output, &mut budget, &json!({"a":2})).unwrap());
        assert_eq!(output, b"{\"a\":1}\n");
        struct Broken;
        impl Write for Broken {
            fn write(&mut self, _: &[u8]) -> io::Result<usize> {
                Err(io::Error::other("disk full"))
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        assert!(write_record(&mut Broken, &mut 1024, &json!({"a":1})).is_err());
    }

    #[cfg(windows)]
    fn recorder(sender: std::sync::mpsc::SyncSender<Value>) -> Diagnostics {
        Diagnostics {
            started: std::time::Instant::now(),
            sender: Some(sender),
            schedule: Schedule::default(),
            sampler: Sampler::default(),
            source_path_sha256: None,
            load_sequence: 0,
            epoch: 0,
            sequence: 0,
            omitted: 0,
        }
    }

    #[test]
    #[cfg(windows)]
    fn backpressure_records_omissions_and_writer_failure_disables_only_logging() {
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        let mut d = recorder(sender);
        let state = super::super::PlayerState::default();
        d.record(playing(1.0, 0, 0), &state, false, Duration::ZERO);
        d.record(playing(1.3, 0, 0), &state, false, Duration::ZERO);
        assert_eq!(receiver.try_recv().unwrap()["sequence"], 0);
        d.record(playing(1.6, 0, 0), &state, false, Duration::ZERO);
        let recovered = receiver.try_recv().unwrap();
        assert_eq!(recovered["sequence"], 2);
        assert_eq!(recovered["samplesOmitted"], 1);
        drop(receiver);
        d.record(playing(1.9, 0, 0), &state, false, Duration::ZERO);
        assert!(d.sender.is_none());
        assert!(!d.due());
    }
}
