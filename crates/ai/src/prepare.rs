//! Free, local audio preparation. This module never accesses Vertex or credentials.
mod pause_evidence;
#[cfg(test)]
mod spoken_pause_test;
use crate::{
    hash_file, plan_chunks, sha256_bytes, AiError, AudioAttachment, AudioChunk, ChunkOptions,
    PreparationBinding, PreparedJob, RequestTask, Result, SileroVad, VadAssets,
};
pub use pause_evidence::VadPauseEvidence;
use serde::{Deserialize, Serialize};
use std::{
    ffi::OsString,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdout, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};
use surtitle_tools::{ToolKind, ToolSnapshot};

pub const SILERO_MODEL_URL: &str = "https://raw.githubusercontent.com/snakers4/silero-vad/be95df9152c0d7618fa1edfeb296fc3dae32376f/src/silero_vad/data/silero_vad.onnx";
pub const SILERO_MODEL_SHA256: &str =
    "1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3";

/// Explicit first-use installation; downloads a pinned public model, never media.
/// The native app chooses model_directory. No executable/runtime is downloaded here.
pub async fn install_silero_model(model_directory: &Path) -> Result<PathBuf> {
    std::fs::create_dir_all(model_directory)?;
    let directory = model_directory.canonicalize()?;
    let path = directory.join(format!("silero-v6.2-{SILERO_MODEL_SHA256}.onnx"));
    if path.exists() && hash_file(&path)? == SILERO_MODEL_SHA256 {
        return Ok(path);
    }
    let client = reqwest::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(local_error)?;
    let mut response = client
        .get(SILERO_MODEL_URL)
        .send()
        .await
        .map_err(local_error)?;
    if !response.status().is_success() {
        return Err(AiError::Invalid(format!(
            "Silero model download failed: HTTP {}",
            response.status().as_u16()
        )));
    }
    let mut temp = tempfile::NamedTempFile::new_in(&directory)?;
    let mut total = 0usize;
    while let Some(bytes) = response.chunk().await.map_err(local_error)? {
        total = total
            .checked_add(bytes.len())
            .ok_or_else(|| local_error("model size overflow"))?;
        if total > 16 * 1024 * 1024 {
            return Err(local_error("model download exceeded 16 MB"));
        }
        temp.write_all(&bytes)?;
    }
    temp.as_file().sync_all()?;
    if hash_file(temp.path())? != SILERO_MODEL_SHA256 {
        return Err(local_error("Silero model checksum mismatch"));
    }
    temp.persist(&path).map_err(|e| AiError::Io(e.error))?;
    Ok(path)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioPreparationOptions {
    pub media_id: String,
    pub transcript_revision: String,
    pub title: String,
    pub project_id: String,
    pub credential_id: String,
    pub language: String,
    pub start_ms: u64,
    pub end_ms: u64,
    #[serde(default)]
    pub audio_stream_index: Option<u32>,
    pub chunks: ChunkOptions,
    #[serde(default)]
    pub provider: AudioTranscriptionProvider,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AudioTranscriptionProvider {
    #[default]
    TranscribePreview,
    GeminiAudio,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreparationProgress {
    pub phase: String,
    pub processed_ms: u64,
    pub total_ms: u64,
    pub completed_chunks: u32,
    pub total_chunks: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioPreparationReceipt {
    pub id: String,
    pub directory: PathBuf,
    pub source_path: PathBuf,
    pub source_sha256: String,
    #[serde(default)]
    pub audio_stream_index: Option<u32>,
    pub model_sha256: String,
    pub ffmpeg: ToolSnapshot,
    pub chunks: Vec<AudioChunk>,
    /// VAD found no speech throughout these exact sent ranges. This is a review
    /// signal only: every sample is still prepared and sent if approved.
    #[serde(default)]
    pub vad_no_speech_ordinals: Vec<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vad_pause_evidence: Option<VadPauseEvidence>,
    pub prepared_job: PreparedJob,
    pub created_at_ms: i64,
}

/// Run on a blocking worker. Preparation is entirely local and must complete before
/// requesting a quote. Use native-selected paths and retain the tool manager's lease
/// for the duration of this call. Both extraction and VAD retain original media time.
pub fn prepare_audio(
    source: &Path,
    output_root: &Path,
    ffmpeg: &ToolSnapshot,
    assets: VadAssets,
    options: AudioPreparationOptions,
    cancel: Arc<AtomicBool>,
    mut progress: impl FnMut(PreparationProgress),
) -> Result<AudioPreparationReceipt> {
    let audio_stream_index = options
        .audio_stream_index
        .ok_or_else(|| local_error("Select and verify an audio stream before preparation"))?;
    if ffmpeg.tool.kind != ToolKind::FfmpegPair
        || options.start_ms >= options.end_ms
        || options.end_ms > 7 * 24 * 60 * 60 * 1000
        || options.chunks.sample_rate != 16_000
    {
        return Err(local_error("invalid audio selection or FFmpeg tool"));
    }
    // Validate identity/language up front without any paid call.
    if options.title.trim().is_empty()
        || options.title.len() > 500
        || options.language.trim().is_empty()
        || options.language.len() > 100
        || options.media_id.is_empty()
        || options.transcript_revision.is_empty()
    {
        return Err(local_error("media, revision, and language are required"));
    }
    plan_chunks(0, 16_000, &[], options.chunks)?;
    let source = source.canonicalize()?;
    if !source.is_file() {
        return Err(local_error("media source is not a file"));
    }
    std::fs::create_dir_all(output_root)?;
    let output_root = output_root.canonicalize()?;
    let total_ms = options.end_ms - options.start_ms;
    let required = total_ms
        .checked_mul(80)
        .and_then(|v| v.checked_add(64 * 1024 * 1024))
        .ok_or_else(|| local_error("audio size overflow"))?;
    if fs2::available_space(&output_root)? < required {
        return Err(local_error(
            "insufficient free disk space for prepared audio",
        ));
    }
    check_cancel(&cancel)?;
    progress(PreparationProgress {
        phase: "fingerprinting".into(),
        processed_ms: 0,
        total_ms,
        completed_chunks: 0,
        total_chunks: 0,
    });
    let source_sha256 = hash_source(&source, &cancel)?;
    let temporary = tempfile::Builder::new()
        .prefix("audio-preparation-")
        .tempdir_in(&output_root)?;
    let mut vad = SileroVad::open(assets.clone())?;
    let args = vec![
        "-nostdin".into(),
        "-hide_banner".into(),
        "-v".into(),
        "error".into(),
        "-i".into(),
        source.as_os_str().to_owned(),
        "-ss".into(),
        seconds(options.start_ms).into(),
        "-t".into(),
        seconds(total_ms).into(),
        "-map".into(),
        format!("0:{audio_stream_index}").into(),
        "-vn".into(),
        "-ac".into(),
        "1".into(),
        "-ar".into(),
        "16000".into(),
        "-f".into(),
        "s16le".into(),
        "-acodec".into(),
        "pcm_s16le".into(),
        "pipe:1".into(),
    ];
    let (mut process, reader) = LocalChild::start(
        ffmpeg,
        &args,
        true,
        cancel.clone(),
        Duration::from_secs((total_ms / 1000).saturating_mul(2).clamp(120, 24 * 60 * 60)),
    )?;
    let spool_path = temporary.path().join("decoded-selection.pcm");
    let spool_file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&spool_path)?;
    let mut recording = RecordingReader {
        reader: reader.ok_or_else(|| local_error("PCM pipe missing"))?,
        writer: std::io::BufWriter::with_capacity(65536, spool_file),
        written: 0,
        maximum: total_ms * 32 + 2048,
    };
    let analysis = vad.analyze_pcm16(&mut recording, &cancel, |samples| {
        progress(PreparationProgress {
            phase: "detecting_speech".into(),
            processed_ms: samples * 1000 / 16000,
            total_ms,
            completed_chunks: 0,
            total_chunks: 0,
        })
    })?;
    recording.writer.flush()?;
    recording.writer.get_ref().sync_all()?;
    if recording.written != analysis.total_samples * 2 {
        return Err(local_error("decoded PCM sample count mismatch"));
    }
    drop(recording);
    process.finish()?;
    // A selection beyond EOF may decode less than requested. Never invent samples.
    let selected_samples = total_ms * 16;
    if analysis.total_samples > selected_samples + 1024 {
        return Err(local_error(
            "decoded duration exceeds the selected audio span",
        ));
    }
    let start_sample = options.start_ms * 16;
    let vad_pause_evidence = VadPauseEvidence::from_analysis(
        &analysis.low_probability_pauses,
        start_sample,
        analysis.total_samples,
        &assets,
    )?;
    let pauses = analysis
        .pauses
        .iter()
        .map(|p| crate::Pause {
            start_sample: p.start_sample + start_sample,
            end_sample: p.end_sample + start_sample,
        })
        .collect::<Vec<_>>();
    let chunks = plan_chunks(
        start_sample,
        start_sample + analysis.total_samples,
        &pauses,
        options.chunks,
    )?;
    let total_chunks = chunks.len() as u32;
    if total_chunks > 5000 {
        return Err(local_error(
            "selection exceeds 5000 bounded requests; prepare a smaller interval",
        ));
    }
    let mut requests = Vec::with_capacity(chunks.len());
    let mut spool = std::fs::File::open(&spool_path)?;
    for chunk in &chunks {
        check_cancel(&cancel)?;
        let path = temporary
            .path()
            .join(format!("chunk-{:05}.flac", chunk.index));
        // The source is decoded once. Copy an exact sample range from the local
        // spool instead of repeatedly decoding each increasingly long source prefix.
        // A bounded temporary PCM file also avoids fractional FFmpeg seek rounding.
        use std::io::{Seek, SeekFrom};
        spool.seek(SeekFrom::Start(
            (chunk.request_start_sample - start_sample) * 2,
        ))?;
        let byte_count = (chunk.request_end_sample - chunk.request_start_sample) * 2;
        let mut chunk_pcm = tempfile::NamedTempFile::new_in(temporary.path())?;
        let copied = std::io::copy(
            &mut Read::by_ref(&mut spool).take(byte_count),
            chunk_pcm.as_file_mut(),
        )?;
        if copied != byte_count {
            return Err(local_error("decoded PCM ended before the prepared span"));
        }
        chunk_pcm.flush()?;
        let args = vec![
            "-nostdin".into(),
            "-hide_banner".into(),
            "-loglevel".into(),
            "error".into(),
            "-n".into(),
            "-f".into(),
            "s16le".into(),
            "-ar".into(),
            "16000".into(),
            "-ac".into(),
            "1".into(),
            "-i".into(),
            chunk_pcm.path().as_os_str().to_owned(),
            "-c:a".into(),
            "flac".into(),
            path.as_os_str().to_owned(),
        ];
        let (mut child, _) = LocalChild::start(
            ffmpeg,
            &args,
            false,
            cancel.clone(),
            Duration::from_secs(600),
        )?;
        child.finish()?;
        let audio = AudioAttachment::from_file(
            path,
            chunk.request_start_ms(),
            chunk.request_duration_ms(),
        )?;
        requests.push(match options.provider {
            AudioTranscriptionProvider::TranscribePreview => RequestTask::TranscribePreview {
                language: options.language.clone(),
                audio,
            },
            AudioTranscriptionProvider::GeminiAudio => RequestTask::AudioTranscription {
                language: options.language.clone(),
                audio,
            },
        });
        progress(PreparationProgress {
            phase: "extracting".into(),
            processed_ms: chunk.core_end_ms().saturating_sub(options.start_ms),
            total_ms,
            completed_chunks: chunk.index + 1,
            total_chunks,
        });
    }
    drop(spool);
    std::fs::remove_file(&spool_path)?;
    check_cancel(&cancel)?;
    if hash_source(&source, &cancel)? != source_sha256 {
        return Err(AiError::PreparationChanged);
    }
    ffmpeg.verify().map_err(local_error)?;
    let settings_sha256 = sha256_bytes(&serde_json::to_vec(
        &serde_json::json!({"options":options,"chunks":chunks,"vadModel":assets.model_sha256,"ffmpeg":ffmpeg,"vadPauseEvidence":vad_pause_evidence}),
    )?);
    let prepared_job = PreparedJob::local_audio_draft(
        options.title,
        PreparationBinding {
            media_id: options.media_id,
            transcript_revision: options.transcript_revision,
            source_sha256: source_sha256.clone(),
            settings_sha256,
        },
        requests,
    )?;
    // Local preparation is useful before credentials or billing are configured.
    // AiStore::prepare validates the completed identity binding before any quote;
    // the receipt itself grants no authority to send or to reserve paid work.
    for request in &prepared_job.requests {
        request.validate()?;
    }
    let directory = temporary.path().to_owned();
    let receipt = AudioPreparationReceipt {
        id: uuid::Uuid::new_v4().to_string(),
        directory: directory.clone(),
        source_path: source,
        source_sha256,
        audio_stream_index: Some(audio_stream_index),
        model_sha256: assets.model_sha256,
        ffmpeg: ffmpeg.clone(),
        vad_no_speech_ordinals: vad_no_speech_chunks(&chunks, &pauses),
        vad_pause_evidence: Some(vad_pause_evidence),
        chunks,
        prepared_job,
        created_at_ms: crate::now_ms(),
    };
    let receipt_path = directory.join("receipt.json");
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(receipt_path)?;
    file.write_all(&serde_json::to_vec_pretty(&receipt)?)?;
    file.sync_all()?;
    let _ = temporary.keep();
    progress(PreparationProgress {
        phase: "prepared".into(),
        processed_ms: total_ms,
        total_ms,
        completed_chunks: total_chunks,
        total_chunks,
    });
    Ok(receipt)
}

fn vad_no_speech_chunks(chunks: &[AudioChunk], pauses: &[crate::Pause]) -> Vec<u32> {
    chunks
        .iter()
        .filter(|chunk| {
            pauses.iter().any(|pause| {
                pause.start_sample <= chunk.request_start_sample
                    && pause.end_sample >= chunk.request_end_sample
            })
        })
        .map(|chunk| chunk.index)
        .collect()
}

fn seconds(ms: u64) -> String {
    format!("{}.{:03}", ms / 1000, ms % 1000)
}
struct RecordingReader<R, W> {
    reader: R,
    writer: W,
    written: u64,
    maximum: u64,
}
impl<R: Read, W: Write> Read for RecordingReader<R, W> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let count = self.reader.read(buffer)?;
        self.written = self
            .written
            .checked_add(count as u64)
            .ok_or_else(|| std::io::Error::other("PCM size overflow"))?;
        if self.written > self.maximum {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "decoded PCM exceeds selected duration",
            ));
        }
        self.writer.write_all(&buffer[..count])?;
        Ok(count)
    }
}
fn hash_source(path: &Path, cancel: &AtomicBool) -> Result<String> {
    use sha2::{Digest, Sha256};
    let mut source = std::fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 65536];
    loop {
        check_cancel(cancel)?;
        let count = source.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
fn local_error(e: impl std::fmt::Display) -> AiError {
    AiError::Invalid(format!("Local audio preparation: {e}"))
}
fn check_cancel(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::Relaxed) {
        Err(local_error("cancelled"))
    } else {
        Ok(())
    }
}

struct LocalChild {
    child: Arc<Mutex<Child>>,
    stop: Arc<AtomicBool>,
    timed_out: Arc<AtomicBool>,
    cancel: Arc<AtomicBool>,
    watcher: Option<JoinHandle<()>>,
    stderr: Option<JoinHandle<Vec<u8>>>,
}
impl LocalChild {
    fn start(
        snapshot: &ToolSnapshot,
        args: &[OsString],
        pipe: bool,
        cancel: Arc<AtomicBool>,
        timeout: Duration,
    ) -> Result<(Self, Option<ChildStdout>)> {
        check_cancel(&cancel)?;
        snapshot.verify().map_err(local_error)?;
        let mut command = Command::new(&snapshot.tool.executable);
        command
            .args(args)
            .stdin(Stdio::null())
            .stdout(if pipe { Stdio::piped() } else { Stdio::null() })
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command.spawn()?;
        let stdout = child.stdout.take();
        let mut error = child
            .stderr
            .take()
            .ok_or_else(|| local_error("stderr pipe missing"))?;
        let stderr = std::thread::spawn(move || {
            let mut out = Vec::new();
            let mut buf = [0u8; 4096];
            loop {
                match error.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let take = n.min(32768usize.saturating_sub(out.len()));
                        out.extend_from_slice(&buf[..take]);
                    }
                }
            }
            out
        });
        let child = Arc::new(Mutex::new(child));
        let stop = Arc::new(AtomicBool::new(false));
        let timed_out = Arc::new(AtomicBool::new(false));
        let (watch_child, watch_stop, watch_timeout, watch_cancel) = (
            child.clone(),
            stop.clone(),
            timed_out.clone(),
            cancel.clone(),
        );
        let watcher = std::thread::spawn(move || {
            let began = Instant::now();
            while !watch_stop.load(Ordering::Relaxed) {
                let expired = began.elapsed() > timeout;
                if expired || watch_cancel.load(Ordering::Relaxed) {
                    watch_timeout.store(expired, Ordering::Relaxed);
                    if let Ok(mut c) = watch_child.lock() {
                        let _ = c.kill();
                    }
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        });
        Ok((
            Self {
                child,
                stop,
                timed_out,
                cancel,
                watcher: Some(watcher),
                stderr: Some(stderr),
            },
            stdout,
        ))
    }
    fn finish(&mut self) -> Result<()> {
        let status = loop {
            if let Some(status) = self
                .child
                .lock()
                .map_err(|_| local_error("child lock"))?
                .try_wait()?
            {
                break status;
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        self.stop.store(true, Ordering::Relaxed);
        if let Some(watcher) = self.watcher.take() {
            let _ = watcher.join();
        }
        let stderr = self
            .stderr
            .take()
            .and_then(|t| t.join().ok())
            .unwrap_or_default();
        check_cancel(&self.cancel)?;
        if self.timed_out.load(Ordering::Relaxed) {
            return Err(local_error("FFmpeg timed out"));
        }
        if !status.success() {
            return Err(local_error(format!(
                "FFmpeg failed: {}",
                String::from_utf8_lossy(&stderr)
            )));
        }
        Ok(())
    }
}
impl Drop for LocalChild {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
        if let Some(watcher) = self.watcher.take() {
            let _ = watcher.join();
        }
        if let Some(stderr) = self.stderr.take() {
            let _ = stderr.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn vad_warning_requires_entire_sent_range_including_overlap_to_have_no_speech() {
        let chunks = vec![AudioChunk {
            index: 0,
            sample_rate: 1000,
            core_start_sample: 3000,
            core_end_sample: 6000,
            request_start_sample: 0,
            request_end_sample: 9000,
            boundary: crate::BoundaryKind::Forced,
        }];
        let pause = |start_sample, end_sample| crate::Pause {
            start_sample,
            end_sample,
        };
        assert_eq!(vad_no_speech_chunks(&chunks, &[pause(0, 9000)]), vec![0]);
        assert!(vad_no_speech_chunks(&chunks, &[pause(3000, 6000)]).is_empty());
        assert!(vad_no_speech_chunks(&chunks, &[pause(0, 4500), pause(4501, 9000)]).is_empty());
        assert!(vad_no_speech_chunks(&chunks, &[]).is_empty());
    }
    #[test]
    fn source_time_decimal_is_exact() {
        assert_eq!(seconds(120_003), "120.003");
        assert_eq!(seconds(1), "0.001");
    }
    #[test]
    #[ignore = "explicit six-hour local acceptance; requires pinned fixtures and SURTITLE_LONG_AUDIO_FILE"]
    fn six_hour_streaming_acceptance() {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .parent()
            .unwrap();
        let source = PathBuf::from(
            std::env::var_os("SURTITLE_LONG_AUDIO_FILE").expect("explicit long audio fixture"),
        );
        let assets = VadAssets {
            runtime_path: repo.join("src-tauri/resources/native/onnxruntime.dll"),
            runtime_sha256: "69d8e6d3879a3b4001cdc74c8ed9ccc7e7f799a5b847059738323404519ec471"
                .into(),
            model_path: repo.join("work/native-fixtures/silero_vad.onnx"),
            model_sha256: SILERO_MODEL_SHA256.into(),
        };
        let ffmpeg = ToolSnapshot::capture(
            surtitle_tools::resolve_external(
                ToolKind::FfmpegPair,
                &PathBuf::from(
                    std::env::var_os("SURTITLE_TEST_FFMPEG").expect("explicit FFmpeg path"),
                ),
            )
            .unwrap(),
        )
        .unwrap();
        let output = repo.join("work/ai-six-hour-acceptance");
        let cancel = Arc::new(AtomicBool::new(false));
        let finished = Arc::new(AtomicBool::new(false));
        let (watch_cancel, watch_finished) = (cancel.clone(), finished.clone());
        let watchdog = std::thread::spawn(move || {
            let start = Instant::now();
            while !watch_finished.load(Ordering::Relaxed) {
                if start.elapsed() > Duration::from_secs(360) {
                    watch_cancel.store(true, Ordering::Relaxed);
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        });
        let began = Instant::now();
        let mut last = Instant::now();
        let options = AudioPreparationOptions {
            media_id: "six-hour-local-fixture".into(),
            transcript_revision: "none".into(),
            title: "Six hour local acceptance".into(),
            project_id: String::new(),
            credential_id: String::new(),
            language: "auto".into(),
            start_ms: 0,
            end_ms: 21_600_000,
            audio_stream_index: Some(0),
            chunks: ChunkOptions::default(),
            provider: AudioTranscriptionProvider::TranscribePreview,
        };
        let result = prepare_audio(&source, &output, &ffmpeg, assets, options, cancel, |p| {
            if last.elapsed() > Duration::from_secs(10) || p.phase == "prepared" {
                eprintln!(
                    "{}: {} / {} ms, chunks {} / {}",
                    p.phase, p.processed_ms, p.total_ms, p.completed_chunks, p.total_chunks
                );
                last = Instant::now();
            }
        });
        finished.store(true, Ordering::Relaxed);
        watchdog.join().unwrap();
        let receipt = result.unwrap();
        assert_eq!(receipt.chunks.first().unwrap().core_start_sample, 0);
        assert_eq!(receipt.chunks.last().unwrap().core_end_sample, 345_600_000);
        assert!(receipt
            .chunks
            .windows(2)
            .all(|p| p[0].core_end_sample == p[1].core_start_sample));
        assert!(receipt
            .chunks
            .iter()
            .all(|c| c.request_duration_ms() <= 186_000));
        assert!(!receipt.directory.join("decoded-selection.pcm").exists());
        let bytes: u64 = std::fs::read_dir(&receipt.directory)
            .unwrap()
            .map(|e| e.unwrap().metadata().unwrap().len())
            .sum();
        #[cfg(windows)]
        let peak_bytes = {
            use windows_sys::Win32::System::{
                ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS_EX},
                Threading::GetCurrentProcess,
            };
            let mut m: PROCESS_MEMORY_COUNTERS_EX = unsafe { std::mem::zeroed() };
            m.cb = std::mem::size_of_val(&m) as u32;
            assert_ne!(
                unsafe {
                    GetProcessMemoryInfo(
                        GetCurrentProcess(),
                        (&mut m as *mut PROCESS_MEMORY_COUNTERS_EX).cast(),
                        m.cb,
                    )
                },
                0
            );
            m.PeakWorkingSetSize as u64
        };
        #[cfg(not(windows))]
        let peak_bytes = 0_u64;
        let wall_seconds = began.elapsed().as_secs_f64();
        let sent_samples = crate::total_request_samples(&receipt.chunks).unwrap();
        assert!(wall_seconds > 0.0 && wall_seconds <= 360.0);
        assert!(sent_samples >= 345_600_000);
        assert!(bytes > 0);
        #[cfg(windows)]
        assert!(peak_bytes > 0);
        let report = serde_json::json!({"source_duration_ms":21_600_000,"wall_seconds":wall_seconds,"peak_working_set_bytes":peak_bytes,"memory_scope":"Rust acceptance process only; external FFmpeg excluded","chunk_count":receipt.chunks.len(),"core_samples":345_600_000_u64,"sent_samples_including_context":sent_samples,"retained_bytes":bytes,"temporary_pcm_removed":true,"receipt_path":receipt.directory.join("receipt.json"),"cloud_calls":0});
        std::fs::write(
            output.join("report.json"),
            serde_json::to_vec_pretty(&report).unwrap(),
        )
        .unwrap();
        eprintln!("{report}");
    }
    #[test]
    #[ignore = "requires pinned native fixtures and explicit SURTITLE_TEST_FFMPEG path; never calls Vertex"]
    fn real_silero_and_ffmpeg_preserve_selection_time() {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .parent()
            .unwrap();
        let assets = VadAssets {
            runtime_path: repo.join("src-tauri/resources/native/onnxruntime.dll"),
            runtime_sha256: "69d8e6d3879a3b4001cdc74c8ed9ccc7e7f799a5b847059738323404519ec471"
                .into(),
            model_path: repo.join("work/native-fixtures/silero_vad.onnx"),
            model_sha256: SILERO_MODEL_SHA256.into(),
        };
        let mut vad = SileroVad::open(assets.clone()).unwrap();
        let pcm = vec![0u8; (16000 + 7) * 2];
        let first = vad
            .analyze_pcm16(pcm.as_slice(), &AtomicBool::new(false), |_| {})
            .unwrap();
        let second = vad
            .analyze_pcm16(pcm.as_slice(), &AtomicBool::new(false), |_| {})
            .unwrap();
        assert_eq!(first.total_samples, 16007);
        assert_eq!(first.pauses, second.pauses);
        assert_eq!(first.low_probability_pauses, second.low_probability_pauses);
        assert!(!first.pauses.is_empty());
        let path =
            PathBuf::from(std::env::var_os("SURTITLE_TEST_FFMPEG").expect("explicit FFmpeg path"));
        let ffmpeg = ToolSnapshot::capture(
            surtitle_tools::resolve_external(ToolKind::FfmpegPair, &path).unwrap(),
        )
        .unwrap();
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("selection.wav");
        let mut wav = Vec::new();
        let data_len = 4 * 16000 * 2_u32;
        wav.extend(b"RIFF");
        wav.extend((36 + data_len).to_le_bytes());
        wav.extend(b"WAVEfmt ");
        wav.extend(16_u32.to_le_bytes());
        wav.extend(1_u16.to_le_bytes());
        wav.extend(1_u16.to_le_bytes());
        wav.extend(16000_u32.to_le_bytes());
        wav.extend(32000_u32.to_le_bytes());
        wav.extend(2_u16.to_le_bytes());
        wav.extend(16_u16.to_le_bytes());
        wav.extend(b"data");
        wav.extend(data_len.to_le_bytes());
        wav.resize(wav.len() + data_len as usize, 0);
        std::fs::write(&source, wav).unwrap();
        let options = AudioPreparationOptions {
            media_id: "media".into(),
            transcript_revision: "1".into(),
            title: "Local fixture".into(),
            project_id: String::new(),
            credential_id: String::new(),
            language: "en".into(),
            start_ms: 1000,
            end_ms: 3500,
            audio_stream_index: Some(0),
            chunks: ChunkOptions::default(),
            provider: AudioTranscriptionProvider::TranscribePreview,
        };
        let receipt = prepare_audio(
            &source,
            &temp.path().join("prepared"),
            &ffmpeg,
            assets,
            options,
            Arc::new(AtomicBool::new(false)),
            |_| {},
        )
        .unwrap();
        assert_eq!(receipt.chunks.len(), 1);
        assert!(
            receipt.prepared_job.validate().is_err(),
            "free receipt with no identity cannot become a paid job"
        );
        assert_eq!(receipt.chunks[0].core_start_ms(), 1000);
        assert_eq!(receipt.chunks[0].core_end_ms(), 3500);
        let evidence = receipt.vad_pause_evidence.as_ref().unwrap();
        evidence.validate().unwrap();
        assert_eq!(
            (evidence.source_start_sample, evidence.source_end_sample),
            (16_000, 56_000)
        );
        assert_eq!(evidence.model_sha256, receipt.model_sha256);
        assert!(!evidence.pauses.is_empty());
        let saved: AudioPreparationReceipt =
            serde_json::from_slice(&std::fs::read(receipt.directory.join("receipt.json")).unwrap())
                .unwrap();
        assert_eq!(saved.vad_pause_evidence, receipt.vad_pause_evidence);
        let draft = crate::build_transcript_draft(
            &saved,
            &[crate::ChunkResponse {
                ordinal: 0,
                output: crate::ParsedOutput::Transcript {
                    cues: vec![crate::GeneratedCue {
                        start_ms: 1500,
                        end_ms: 2000,
                        text: "Review this generated speech.".into(),
                    }],
                },
            }],
        )
        .unwrap();
        assert!(!draft.can_adopt);
        assert_eq!(draft.warnings.len(), 1);
        assert!(draft.chunks[0].vad_pause_evidence.is_some());
        assert_eq!(
            draft.chunks[0].segments[0].text,
            "Review this generated speech."
        );
        let RequestTask::TranscribePreview { audio, .. } = &receipt.prepared_job.requests[0] else {
            panic!("expected audio")
        };
        assert_eq!(audio.source_start_ms, 1000);
        assert_eq!(audio.duration_ms, 2500);
        assert!(audio.verified_bytes().unwrap().starts_with(b"fLaC"));
        assert!(receipt.directory.join("receipt.json").is_file());
    }
}
