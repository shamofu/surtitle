//! Prepare one immutable text/audio request without generation.
use super::arguments::{Arguments, format_usd, parse_audio_seconds, parse_execution};
use super::context::{Context, Manifest, manifest_path, read_manifest, valid_case_id};
use super::files::{absolute, read_bounded, read_document, reject_link, write_json_new, write_new};
use super::{MAX_AUDIO_SECONDS, Result, ai_error};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use surtitle_ai::{
    AudioAttachment, ExecutionConfig, PreparationBinding, PreparedJob, RequestTask, sha256_bytes,
};

pub(super) fn prepare(root: &Path, mut args: Arguments) -> Result<Value> {
    let id = args.string("--credential-id")?;
    let case_id = args.string("--case-id")?;
    valid_case_id(&case_id)?;
    let task_file = args.take("--task-file").map(PathBuf::from);
    let audio_file = args.take("--audio-file").map(PathBuf::from);
    let execution = parse_execution(&mut args)?;
    let max_audio_seconds = if audio_file.is_some() {
        Some(parse_audio_seconds(&args.string("--max-audio-seconds")?)?)
    } else {
        None
    };
    let audio_options = if audio_file.is_some() {
        Some((args.string("--adapter")?, args.string("--language")?))
    } else {
        None
    };
    args.finish()?;
    if task_file.is_some() == audio_file.is_some() {
        return Err("Choose exactly one task file or audio file".into());
    }
    let context = Context::open(root)?;
    let metadata = context
        .vault
        .list()
        .map_err(ai_error)?
        .into_iter()
        .find(|key| key.id == id)
        .ok_or("Import and select an unlocked credential first")?;
    let task = if let Some(path) = task_file {
        absolute(&path)?;
        let task: RequestTask = read_document(&path)?;
        if matches!(
            task,
            RequestTask::AudioTranscription { .. }
                | RequestTask::TranscribePreview { .. }
                | RequestTask::TranscribeDiagnostic { .. }
        ) {
            return Err("Audio tasks require --audio-file so duration is measured locally".into());
        }
        task
    } else {
        let path = audio_file.ok_or("Audio file is required")?;
        absolute(&path)?;
        let (model, language) = audio_options.ok_or("Audio model and language are required")?;
        let (bytes, duration) = read_wav(&path, max_audio_seconds.unwrap())?;
        let hash = sha256_bytes(&bytes);
        let prepared_path = context.root.join("inputs").join(format!("{hash}.wav"));
        if prepared_path.exists() {
            reject_link(&prepared_path)?;
            if surtitle_ai::hash_file(&prepared_path).map_err(ai_error)? != hash {
                return Err("Prepared audio hash mismatch".into());
            }
        } else {
            write_new(&prepared_path, &bytes)?;
        }
        let audio = bind_measured_audio(prepared_path, &bytes, duration)?;
        match model.as_str() {
            "transcribe" => RequestTask::TranscribePreview { language, audio },
            "transcribe-text" => RequestTask::TranscribeDiagnostic { language, audio },
            "audio" => RequestTask::AudioTranscription { language, audio },
            _ => {
                return Err("Audio adapter must be transcribe, transcribe-text or audio".into());
            }
        }
    };
    let prepared = make_plan(
        case_id.clone(),
        metadata.project_id,
        id,
        task,
        execution,
        max_audio_seconds,
    )?;
    let quote = context.store.prepare(prepared.clone()).map_err(ai_error)?;
    let manifest = Manifest {
        schema_version: 2,
        job_id: quote.id.clone(),
        case_id,
        plan_digest: quote.digest.clone(),
        prepared,
        max_audio_seconds,
    };
    let path = manifest_path(&context.root, &quote.id)?;
    if path.exists() {
        if read_manifest(&path)? != manifest {
            return Err("Existing preparation manifest differs".into());
        }
    } else {
        write_json_new(&path, &manifest)?;
    }
    Ok(
        json!({"manifest":manifest,"quote":quote,"approveChargeUsd":quote.additional_reservation_microusd.map(format_usd),"budget":context.store.budget().map_err(ai_error)?,"validation":context.store.validation_totals().map_err(ai_error)?,"networkRequests":0}),
    )
}

pub(super) fn make_plan(
    case_id: String,
    project: String,
    credential: String,
    task: RequestTask,
    execution: ExecutionConfig,
    max_audio_seconds: Option<u32>,
) -> Result<PreparedJob> {
    task.validate().map_err(ai_error)?;
    let source = source_metadata(&task);
    let source_hash = source
        .1
        .unwrap_or_else(|| sha256_bytes(&serde_json::to_vec(&source.0).unwrap_or_default()));
    let settings = settings_digest(&task, max_audio_seconds)?;
    let plan = PreparedJob::new(
        format!("Validation / {case_id}"),
        project,
        credential,
        PreparationBinding {
            media_id: format!("validation:{case_id}"),
            transcript_revision: source_hash.clone(),
            source_sha256: source_hash,
            settings_sha256: settings,
        },
        vec![task],
        execution,
    )
    .map_err(ai_error)?;
    plan.validate().map_err(ai_error)?;
    Ok(plan)
}

pub(super) fn settings_digest(
    task: &RequestTask,
    max_audio_seconds: Option<u32>,
) -> Result<String> {
    if max_audio_seconds.is_none() {
        return Ok(sha256_bytes(
            &serde_json::to_vec(task).map_err(|_| "Cannot encode preparation")?,
        ));
    }
    let value = if let Some(seconds) = max_audio_seconds {
        if seconds == 0 || seconds > MAX_AUDIO_SECONDS {
            return Err("Audio limit must be from 1 to 240 seconds".into());
        }
        let duration = match task {
            RequestTask::AudioTranscription { audio, .. }
            | RequestTask::TranscribePreview { audio, .. }
            | RequestTask::TranscribeDiagnostic { audio, .. } => audio.duration_ms,
            _ => return Err("Audio duration limits only apply to audio tasks".into()),
        };
        if duration > u64::from(seconds) * 1000 {
            return Err("Prepared audio exceeds the explicitly selected limit".into());
        }
        json!({"task":task,"maxAudioSeconds":seconds})
    } else {
        serde_json::to_value(task).map_err(|_| "Cannot encode preparation")?
    };
    Ok(sha256_bytes(
        &serde_json::to_vec(&value).map_err(|_| "Cannot encode preparation")?,
    ))
}

pub(super) fn source_metadata(task: &RequestTask) -> (Vec<surtitle_ai::SourceCue>, Option<String>) {
    match task {
        RequestTask::Vocabulary { cues, .. }
        | RequestTask::Explanation { cues, .. }
        | RequestTask::Translation { cues, .. } => (cues.clone(), None),
        RequestTask::AudioTranscription { audio, .. }
        | RequestTask::TranscribePreview { audio, .. }
        | RequestTask::TranscribeDiagnostic { audio, .. } => (vec![], Some(audio.sha256.clone())),
    }
}

pub(super) fn bind_measured_audio(
    path: PathBuf,
    measured_bytes: &[u8],
    duration_ms: u64,
) -> Result<AudioAttachment> {
    let audio = AudioAttachment::from_file(path, 0, duration_ms).map_err(ai_error)?;
    // Duration and the quoted audio identity must describe the same snapshot.
    // The staged file may have been replaced after it was written or checked.
    if audio.sha256 != sha256_bytes(measured_bytes) || audio.byte_len != measured_bytes.len() as u64
    {
        return Err(
            "Prepared audio changed after its duration was measured; prepare a new input".into(),
        );
    }
    Ok(audio)
}

pub(super) fn read_wav(path: &Path, max_audio_seconds: u32) -> Result<(Vec<u8>, u64)> {
    if max_audio_seconds == 0 || max_audio_seconds > MAX_AUDIO_SECONDS {
        return Err("Audio limit must be from 1 to 240 seconds".into());
    }
    // Bound metadata overhead as well as PCM bytes; do not read arbitrarily large files.
    let bytes = read_bounded(path, u64::from(max_audio_seconds) * 32_000 + 64 * 1024)?;
    if bytes.len() < 44
        || &bytes[..4] != b"RIFF"
        || &bytes[8..12] != b"WAVE"
        || u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize + 8 != bytes.len()
    {
        return Err("Use a complete RIFF WAV file".into());
    }
    let mut position = 12usize;
    let mut format = None;
    let mut data = None;
    while position + 8 <= bytes.len() {
        let length =
            u32::from_le_bytes(bytes[position + 4..position + 8].try_into().unwrap()) as usize;
        let start = position + 8;
        let end = start.checked_add(length).ok_or("WAV chunk overflow")?;
        if end > bytes.len() {
            return Err("Truncated WAV chunk".into());
        }
        match &bytes[position..position + 4] {
            b"fmt " => {
                if format.is_some() || length < 16 {
                    return Err("Invalid WAV format chunk".into());
                }
                format = Some(bytes[start..end].to_vec());
            }
            b"data" => {
                if data.is_some() {
                    return Err("Use one WAV data chunk".into());
                }
                data = Some(length);
            }
            _ => {}
        }
        position = end.checked_add(length % 2).ok_or("WAV chunk overflow")?;
    }
    if position != bytes.len() {
        return Err("Invalid trailing WAV bytes".into());
    }
    let format = format.ok_or("WAV format missing")?;
    let expected: [u8; 16] = [1, 0, 1, 0, 128, 62, 0, 0, 0, 125, 0, 0, 2, 0, 16, 0];
    if format[..16] != expected {
        return Err("Convert audio to 16 kHz mono PCM16 WAV before preparing it".into());
    }
    let length = data.ok_or("WAV audio data missing")?;
    if length == 0 || length % 2 != 0 || length as u64 > u64::from(max_audio_seconds) * 32_000 {
        return Err(
            "Validation audio must be nonempty and within the explicit duration limit".into(),
        );
    }
    let duration_ms = (length as u64 * 1000).div_ceil(32_000);
    Ok((bytes, duration_ms))
}
