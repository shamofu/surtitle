//! Real, local comparison of retained serial preparation and the production pipeline.
//! No ledger, credentials, or network. All outputs belong to the supplied workspace.
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Instant,
};
use surtitle_ai::*;
use surtitle_tools::{ToolKind, ToolSnapshot};
type AnyResult<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

fn options() -> AudioPreparationOptions {
    AudioPreparationOptions {
        media_id: "evaluation".into(),
        transcript_revision: "fixture".into(),
        title: "Six-minute synthesized speech fixture".into(),
        project_id: String::new(),
        credential_id: String::new(),
        language: "en".into(),
        start_ms: 0,
        end_ms: 360_000,
        audio_stream_index: Some(0),
        chunks: ChunkOptions::default(),
        provider: AudioTranscriptionProvider::TranscribePreview,
    }
}
fn run(
    source: &Path,
    output: &Path,
    tool: &ToolSnapshot,
    assets: VadAssets,
    serial: bool,
) -> AnyResult<(AudioPreparationReceipt, f64, f64)> {
    let began = Instant::now();
    let mut first = None;
    let progress = |event: PreparationProgress| {
        if event.completed_chunks > 0 && first.is_none() {
            first = Some(began.elapsed().as_secs_f64());
        }
    };
    let receipt = if serial {
        prepare_audio_serial(
            source,
            output,
            tool,
            assets,
            options(),
            Arc::new(AtomicBool::new(false)),
            progress,
        )?
    } else {
        prepare_audio(
            source,
            output,
            tool,
            assets,
            options(),
            Arc::new(AtomicBool::new(false)),
            progress,
        )?
    };
    Ok((
        receipt,
        first.ok_or("missing completion progress")?,
        began.elapsed().as_secs_f64(),
    ))
}
fn audio_hashes(receipt: &AudioPreparationReceipt) -> Vec<String> {
    receipt
        .prepared_job
        .requests
        .iter()
        .map(|request| match request {
            RequestTask::TranscribePreview { audio, .. } => audio.sha256.clone(),
            _ => panic!("audio expected"),
        })
        .collect()
}
fn main() -> AnyResult<()> {
    let args = std::env::args_os()
        .skip(1)
        .map(PathBuf::from)
        .collect::<Vec<_>>();
    if args.len() != 5 {
        return Err("arguments: SOURCE FFMPEG SILERO_MODEL ONNX_RUNTIME OUTPUT".into());
    }
    let source = args[0].canonicalize()?;
    let output = &args[4];
    std::fs::create_dir_all(output)?;
    let assets = VadAssets {
        model_path: args[2].clone(),
        runtime_path: args[3].clone(),
        model_sha256: SILERO_MODEL_SHA256.into(),
    };
    let tool = ToolSnapshot::capture(surtitle_tools::resolve_external(
        ToolKind::FfmpegPair,
        &args[1].canonicalize()?,
    )?)?;
    let mut runs = Vec::new();
    for round in 0..3 {
        // Alternate order to reduce a systematic warm-cache advantage.
        let baseline;
        let staged;
        if round % 2 == 0 {
            baseline = run(
                &source,
                &output.join(format!("baseline-{round}")),
                &tool,
                assets.clone(),
                true,
            )?;
            staged = run(
                &source,
                &output.join(format!("staged-{round}")),
                &tool,
                assets.clone(),
                false,
            )?;
        } else {
            staged = run(
                &source,
                &output.join(format!("staged-{round}")),
                &tool,
                assets.clone(),
                false,
            )?;
            baseline = run(
                &source,
                &output.join(format!("baseline-{round}")),
                &tool,
                assets.clone(),
                true,
            )?;
        }
        let identical = baseline.0.chunks == staged.0.chunks
            && audio_hashes(&baseline.0) == audio_hashes(&staged.0)
            && baseline.0.vad_pause_evidence == staged.0.vad_pause_evidence
            && baseline.0.prepared_job.binding == staged.0.prepared_job.binding;
        if !identical {
            return Err(
                "production pipeline changed boundaries, bytes, VAD evidence or binding".into(),
            );
        }
        runs.push(serde_json::json!({"round":round,"baselineFirstFlacSeconds":baseline.1,"baselineQuoteReadySeconds":baseline.2,
            "stagedFirstFlacSeconds":staged.1,"stagedQuoteReadySeconds":staged.2,"requestCount":staged.0.chunks.len(),
            "sentSamples":total_request_samples(&staged.0.chunks)?,"boundariesIdentical":true,"flacBytesIdentical":true,"bindingIdentical":true}));
        println!("{}", runs.last().unwrap());
    }
    // Exercise actual cancellation while local encoders can already be active.
    let cancel_output = output.join("cancelled");
    let cancel = Arc::new(AtomicBool::new(false));
    let signal = cancel.clone();
    let cancelled = prepare_audio(
        &source,
        &cancel_output,
        &tool,
        assets.clone(),
        options(),
        cancel,
        |p| {
            if p.phase == "detecting_speech" && p.processed_ms >= 200_000 {
                signal.store(true, Ordering::Relaxed);
            }
        },
    );
    if cancelled.is_ok() || std::fs::read_dir(&cancel_output)?.next().is_some() {
        return Err("cancelled preparation left a receipt or temporary files".into());
    }
    // Mutate only an isolated source copy after decoding. Nothing can publish it.
    let changed_source = output.join("changed-source.flac");
    std::fs::copy(&source, &changed_source)?;
    let changed_output = output.join("changed");
    let changed = prepare_audio(
        &changed_source,
        &changed_output,
        &tool,
        assets,
        options(),
        Arc::new(AtomicBool::new(false)),
        |p| {
            if p.phase == "verifying" {
                std::fs::write(&changed_source, b"changed after extraction").unwrap();
            }
        },
    );
    if !matches!(changed, Err(AiError::PreparationChanged))
        || std::fs::read_dir(&changed_output)?.next().is_some()
    {
        return Err("changed source was not rejected and cleaned up".into());
    }
    let report = serde_json::json!({"fixture":"360-second Windows speech synthesis loop, mono16kHz FLAC","sourceSha256":hash_file(&source)?,
        "vadModelSha256":SILERO_MODEL_SHA256,"cloudCalls":0,"runs":runs,"cancellationCleanupPassed":true,"sourceChangeCleanupPassed":true,"maximumEncoderWorkers":2,
        "limits":"Same-host debug builds, alternating order; no recognition-quality comparison. First FLAC timing is when progress observes a completed worker. Quote requires all immutable requests and final source/tool verification."});
    std::fs::write(
        output.join("preparation.json"),
        serde_json::to_vec_pretty(&report)?,
    )?;
    Ok(())
}
