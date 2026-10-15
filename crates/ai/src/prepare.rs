//! Free, local audio preparation. This module never accesses Vertex or credentials.
mod child;
mod encoding;
use encoding::{next_mature_chunk, Encoders};
mod pause_evidence;
#[cfg(test)]
mod spoken_pause_test;
use crate::{
    hash_file, plan_chunks, sha256_bytes, AiError, AudioChunk, ChunkOptions, PreparationBinding,
    PreparedJob, RequestTask, Result, SileroVad, VadAssets,
};
use child::LocalChild;
pub use pause_evidence::VadPauseEvidence;
use serde::{Deserialize, Serialize};
use std::{
    cell::RefCell,
    io::{Read, Write},
    path::{Path, PathBuf},
    rc::Rc,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use surtitle_tools::{ToolKind, ToolSnapshot};

// Generated from the same manifest used to fetch the native test fixtures.
include!(concat!(env!("OUT_DIR"), "/silero_model.rs"));

/// Explicit first-use installation; downloads a pinned public model, never media.
/// The native app chooses model_directory. No executable/runtime is downloaded here.
pub async fn install_silero_model(model_directory: &Path) -> Result<PathBuf> {
    install_silero_model_with_progress(
        model_directory,
        &surtitle_tools::CancellationToken::new(),
        |_| {},
    )
    .await
}

#[derive(Debug, Clone)]
pub struct ModelInstallationProgress {
    pub phase: &'static str,
    pub downloaded_bytes: Option<u64>,
    pub total_bytes: Option<u64>,
}

/// The existing installer remains a wrapper for callers that do not display progress.
pub async fn install_silero_model_with_progress(
    model_directory: &Path,
    cancel: &surtitle_tools::CancellationToken,
    mut progress: impl FnMut(ModelInstallationProgress) + Send,
) -> Result<PathBuf> {
    if cancel.is_cancelled() {
        return Err(local_error("cancelled"));
    }
    progress(ModelInstallationProgress {
        phase: "checking",
        downloaded_bytes: None,
        total_bytes: None,
    });
    std::fs::create_dir_all(model_directory)?;
    let directory = model_directory.canonicalize()?;
    let path = directory.join(SILERO_MODEL_FILENAME);
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
    progress(ModelInstallationProgress {
        phase: "connecting",
        downloaded_bytes: None,
        total_bytes: None,
    });
    let mut response = tokio::select! {
        biased;
        _ = cancel.cancelled() => return Err(local_error("cancelled")),
        response = client.get(SILERO_MODEL_URL).send() => response.map_err(local_error)?,
    };
    if !response.status().is_success() {
        return Err(AiError::Invalid(format!(
            "Silero model download failed: HTTP {}",
            response.status().as_u16()
        )));
    }
    let mut temp = tempfile::NamedTempFile::new_in(&directory)?;
    let mut total = 0usize;
    let expected = response.content_length();
    progress(ModelInstallationProgress {
        phase: "downloading",
        downloaded_bytes: Some(0),
        total_bytes: expected,
    });
    loop {
        let bytes = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(local_error("cancelled")),
            bytes = response.chunk() => bytes.map_err(local_error)?,
        };
        let Some(bytes) = bytes else { break };
        total = total
            .checked_add(bytes.len())
            .ok_or_else(|| local_error("model size overflow"))?;
        if total > 16 * 1024 * 1024 {
            return Err(local_error("model download exceeded 16 MB"));
        }
        temp.write_all(&bytes)?;
        progress(ModelInstallationProgress {
            phase: "downloading",
            downloaded_bytes: Some(total as u64),
            total_bytes: expected,
        });
    }
    if cancel.is_cancelled() {
        return Err(local_error("cancelled"));
    }
    progress(ModelInstallationProgress {
        phase: "verifying",
        downloaded_bytes: None,
        total_bytes: None,
    });
    temp.as_file().sync_all()?;
    if hash_file(temp.path())? != SILERO_MODEL_SHA256 {
        return Err(local_error("Silero model checksum mismatch"));
    }
    if cancel.is_cancelled() {
        return Err(local_error("cancelled"));
    }
    progress(ModelInstallationProgress {
        phase: "installing",
        downloaded_bytes: None,
        total_bytes: None,
    });
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
    progress: impl FnMut(PreparationProgress),
) -> Result<AudioPreparationReceipt> {
    prepare_audio_inner(
        source,
        output_root,
        ffmpeg,
        assets,
        options,
        cancel,
        progress,
    )
}

fn prepare_audio_inner(
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
    let writer = Rc::new(RefCell::new(std::io::BufWriter::with_capacity(
        65536, spool_file,
    )));
    let mut recording = RecordingReader {
        reader: reader.ok_or_else(|| local_error("PCM pipe missing"))?,
        writer: SharedWriter(writer.clone()),
        written: 0,
        maximum: total_ms * 32 + 2048,
    };
    let start_sample = options.start_ms * 16;
    let mut encoded_chunks = Vec::<AudioChunk>::new();
    // This is declared after the temp directory and decoder. Error unwinding
    // cancels/joins every encoder before either can be removed.
    let mut encoders = Encoders::new(cancel.clone(), 2);
    let analysis = vad.analyze_pcm16_staged(&mut recording, &cancel, |samples, pauses| {
        encoders.reap_ready()?;
        let pauses = pauses
            .iter()
            .map(|p| crate::Pause {
                start_sample: p.start_sample + start_sample,
                end_sample: p.end_sample + start_sample,
            })
            .collect::<Vec<_>>();
        loop {
            let next = encoded_chunks
                .last()
                .map_or(start_sample, |c| c.core_end_sample);
            let Some(chunk) = next_mature_chunk(
                start_sample,
                next,
                start_sample + samples,
                &pauses,
                options.chunks,
                encoded_chunks.len() as u32,
            )?
            else {
                break;
            };
            if encoded_chunks.len() >= 5000 {
                return Err(local_error(
                    "selection exceeds 5000 bounded requests; prepare a smaller interval",
                ));
            }
            writer.borrow_mut().flush()?;
            encoders.enqueue(&spool_path, temporary.path(), start_sample, &chunk, ffmpeg)?;
            encoded_chunks.push(chunk);
        }
        progress(PreparationProgress {
            phase: "detecting_speech".into(),
            processed_ms: samples * 1000 / 16000,
            total_ms,
            completed_chunks: encoders.completed(),
            total_chunks: 0,
        });
        Ok(())
    })?;
    writer.borrow_mut().flush()?;
    writer.borrow().get_ref().sync_all()?;
    if recording.written != analysis.total_samples * 2 {
        return Err(local_error("decoded PCM sample count mismatch"));
    }
    drop(recording);
    drop(writer);
    process.finish()?;
    // A selection beyond EOF may decode less than requested. Never invent samples.
    let selected_samples = total_ms * 16;
    if analysis.total_samples > selected_samples + 1024 {
        return Err(local_error(
            "decoded duration exceeds the selected audio span",
        ));
    }
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
    if !chunks.starts_with(&encoded_chunks) {
        return Err(local_error(
            "staged boundaries differ from final VAD analysis",
        ));
    }
    progress(PreparationProgress {
        phase: "extracting".into(),
        processed_ms: 0,
        total_ms,
        completed_chunks: encoders.completed(),
        total_chunks,
    });
    for chunk in chunks.iter().skip(encoded_chunks.len()) {
        encoders.enqueue(&spool_path, temporary.path(), start_sample, chunk, ffmpeg)?;
    }
    let audio = encoders.finish(|completed_chunks| {
        progress(PreparationProgress {
            phase: "extracting".into(),
            processed_ms: chunks[completed_chunks as usize - 1]
                .core_end_ms()
                .saturating_sub(options.start_ms),
            total_ms,
            completed_chunks,
            total_chunks,
        })
    })?;
    let requests = audio
        .into_iter()
        .map(|audio| match options.provider {
            AudioTranscriptionProvider::TranscribePreview => RequestTask::TranscribePreview {
                language: options.language.clone(),
                audio,
            },
            AudioTranscriptionProvider::GeminiAudio => RequestTask::AudioTranscription {
                language: options.language.clone(),
                audio,
            },
        })
        .collect();
    std::fs::remove_file(&spool_path)?;
    check_cancel(&cancel)?;
    progress(PreparationProgress {
        phase: "verifying".into(),
        processed_ms: 0,
        total_ms,
        completed_chunks: total_chunks,
        total_chunks,
    });
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
struct SharedWriter(Rc<RefCell<std::io::BufWriter<std::fs::File>>>);
impl Write for SharedWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.borrow_mut().write(bytes)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.0.borrow_mut().flush()
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn model_install_cancellation_does_not_start_network_or_change_existing_files() {
        let root = tempfile::tempdir().unwrap();
        let destination = root.path().join(SILERO_MODEL_FILENAME);
        std::fs::write(&destination, b"previous model").unwrap();
        let cancel = surtitle_tools::CancellationToken::new();
        cancel.cancel();
        let result = install_silero_model_with_progress(root.path(), &cancel, |_| {
            panic!("cancelled installation must not start")
        })
        .await;
        assert!(result.is_err());
        assert_eq!(std::fs::read(destination).unwrap(), b"previous model");
    }
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
    #[ignore = "run by required Windows native CI; requires pinned native fixtures and SURTITLE_TEST_FFMPEG; never calls Vertex"]
    fn real_preparation_failures_remove_receipts_and_temporary_files() {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .parent()
            .unwrap();
        let assets = VadAssets {
            runtime_path: repo.join("src-tauri/resources/native/onnxruntime.dll"),
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
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("six-minute-silence.wav");
        let data_len = 360 * 16_000 * 2_u32;
        let mut wav = Vec::new();
        wav.extend(b"RIFF");
        wav.extend((36 + data_len).to_le_bytes());
        wav.extend(b"WAVEfmt ");
        wav.extend(16_u32.to_le_bytes());
        wav.extend(1_u16.to_le_bytes());
        wav.extend(1_u16.to_le_bytes());
        wav.extend(16_000_u32.to_le_bytes());
        wav.extend(32_000_u32.to_le_bytes());
        wav.extend(2_u16.to_le_bytes());
        wav.extend(16_u16.to_le_bytes());
        wav.extend(b"data");
        wav.extend(data_len.to_le_bytes());
        wav.resize(wav.len() + data_len as usize, 0);
        std::fs::write(&source, wav).unwrap();
        let original_hash = hash_file(&source).unwrap();
        let options = AudioPreparationOptions {
            media_id: "preparation-failure-fixture".into(),
            transcript_revision: "fixture".into(),
            title: "Local preparation cleanup".into(),
            project_id: String::new(),
            credential_id: String::new(),
            language: "en".into(),
            start_ms: 0,
            end_ms: 360_000,
            audio_stream_index: Some(0),
            chunks: ChunkOptions::default(),
            provider: AudioTranscriptionProvider::TranscribePreview,
        };

        let cancelled_output = temp.path().join("cancelled");
        let cancel = Arc::new(AtomicBool::new(false));
        let signal = cancel.clone();
        let mut cancelled_during_analysis = false;
        let cancelled = prepare_audio(
            &source,
            &cancelled_output,
            &ffmpeg,
            assets.clone(),
            options.clone(),
            cancel,
            |progress| {
                if progress.phase == "detecting_speech" && progress.processed_ms >= 200_000 {
                    cancelled_during_analysis = true;
                    signal.store(true, Ordering::Relaxed);
                }
            },
        );
        assert!(
            cancelled_during_analysis,
            "must reach the cancellation point"
        );
        assert!(cancelled.is_err());
        assert!(std::fs::read_dir(&cancelled_output)
            .unwrap()
            .next()
            .is_none());

        // Silence keeps its pause open through EOF, so the analysis cancellation
        // above precedes encoding. Also cancel after real FLAC output exists,
        // while finish() still owns an unjoined encoder handle. The worker may
        // already have exited; live-thread cancellation is tested in encoding.rs.
        let encoding_output = temp.path().join("cancelled-after-encoding");
        let cancel = Arc::new(AtomicBool::new(false));
        let signal = cancel.clone();
        let mut cancelled_after_encoding = false;
        let cancelled = prepare_audio(
            &source,
            &encoding_output,
            &ffmpeg,
            assets.clone(),
            options.clone(),
            cancel,
            |progress| {
                if !cancelled_after_encoding
                    && progress.phase == "extracting"
                    && progress.completed_chunks > 0
                    && progress.completed_chunks < progress.total_chunks
                {
                    let preparation_directory = std::fs::read_dir(&encoding_output)
                        .unwrap()
                        .next()
                        .unwrap()
                        .unwrap()
                        .path();
                    let encoded =
                        std::fs::read(preparation_directory.join("chunk-00000.flac")).unwrap();
                    assert!(encoded.starts_with(b"fLaC"));
                    assert!(!preparation_directory.join("receipt.json").exists());
                    cancelled_after_encoding = true;
                    signal.store(true, Ordering::Relaxed);
                }
            },
        );
        assert!(
            cancelled_after_encoding,
            "must cancel with encoded output and pending handles"
        );
        assert!(cancelled.is_err());
        assert!(std::fs::read_dir(&encoding_output)
            .unwrap()
            .next()
            .is_none());

        let changed_source = temp.path().join("changed-source.wav");
        std::fs::copy(&source, &changed_source).unwrap();
        let changed_output = temp.path().join("changed");
        let mut changed_after_extraction = false;
        let changed = prepare_audio(
            &changed_source,
            &changed_output,
            &ffmpeg,
            assets,
            options,
            Arc::new(AtomicBool::new(false)),
            |progress| {
                if progress.phase == "verifying" {
                    changed_after_extraction = true;
                    std::fs::write(&changed_source, b"changed after extraction").unwrap();
                }
            },
        );
        assert!(changed_after_extraction, "must reach source verification");
        assert!(matches!(changed, Err(AiError::PreparationChanged)));
        assert!(std::fs::read_dir(&changed_output).unwrap().next().is_none());
        assert_eq!(hash_file(&source).unwrap(), original_hash);
    }
    #[test]
    #[ignore = "run by required Windows native CI; requires pinned native fixtures and SURTITLE_TEST_FFMPEG; never calls Vertex"]
    fn real_silero_and_ffmpeg_preserve_selection_time() {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .parent()
            .unwrap();
        let assets = VadAssets {
            runtime_path: repo.join("src-tauri/resources/native/onnxruntime.dll"),
            model_path: repo.join("work/native-fixtures/silero_vad.onnx"),
            model_sha256: SILERO_MODEL_SHA256.into(),
        };
        // Older callers may supply a stale DLL digest. It is no longer a load prerequisite.
        let mut legacy_assets = serde_json::to_value(&assets).unwrap();
        legacy_assets["runtime_sha256"] = serde_json::json!("0".repeat(64));
        assert_ne!(hash_file(&assets.runtime_path).unwrap(), "0".repeat(64));
        let assets: VadAssets = serde_json::from_value(legacy_assets).unwrap();
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
        let data_len = 360 * 16000 * 2_u32;
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
        let mut observed_progress = Vec::new();
        let receipt = prepare_audio(
            &source,
            &temp.path().join("prepared"),
            &ffmpeg,
            assets.clone(),
            options.clone(),
            Arc::new(AtomicBool::new(false)),
            |progress| observed_progress.push(progress),
        )
        .unwrap();
        let extraction = observed_progress
            .iter()
            .position(|progress| progress.phase == "extracting")
            .unwrap();
        assert_eq!(observed_progress[extraction].completed_chunks, 0);
        assert_eq!(observed_progress[extraction].processed_ms, 0);
        let verification = observed_progress
            .iter()
            .position(|progress| progress.phase == "verifying")
            .unwrap();
        assert!(verification > extraction);
        assert_eq!(observed_progress[verification].processed_ms, 0);
        assert_eq!(observed_progress.last().unwrap().phase, "prepared");
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
                        ..Default::default()
                    }],
                },
            }],
        )
        .unwrap();
        assert!(draft.can_adopt);
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

        // Complete several streaming encoders with a generated local source.
        // This checks sample preservation and cleanup without a wall-time or
        // memory benchmark whose outcome depends on the CI host's load.
        let complete = prepare_audio(
            &source,
            &temp.path().join("complete"),
            &ffmpeg,
            assets,
            AudioPreparationOptions {
                start_ms: 0,
                end_ms: 360_000,
                ..options
            },
            Arc::new(AtomicBool::new(false)),
            |_| {},
        )
        .unwrap();
        assert!(complete.chunks.len() > 1);
        assert_eq!(complete.chunks.first().unwrap().core_start_sample, 0);
        assert_eq!(
            complete.chunks.last().unwrap().core_end_sample,
            360 * 16_000
        );
        assert!(complete
            .chunks
            .windows(2)
            .all(|pair| pair[0].core_end_sample == pair[1].core_start_sample));
        assert!(complete
            .chunks
            .iter()
            .all(|chunk| chunk.request_duration_ms() <= 186_000));
        assert_eq!(complete.prepared_job.requests.len(), complete.chunks.len());
        for (request, chunk) in complete.prepared_job.requests.iter().zip(&complete.chunks) {
            let RequestTask::TranscribePreview { audio, .. } = request else {
                panic!("expected audio");
            };
            assert_eq!(audio.source_start_ms, chunk.request_start_ms());
            assert_eq!(audio.duration_ms, chunk.request_duration_ms());
            assert!(audio.verified_bytes().unwrap().starts_with(b"fLaC"));
        }
        assert!(!complete.directory.join("decoded-selection.pcm").exists());
        assert!(complete.directory.join("receipt.json").is_file());
    }
}
