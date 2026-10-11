//! Isolated CPU runtime comparison against identical PCM; no provider or profile access.
use std::{fs::File, io::BufReader, path::PathBuf, sync::atomic::AtomicBool, time::Instant};
use surtitle_ai::{hash_file, plan_chunks, sha256_bytes, ChunkOptions, SileroVad, VadAssets};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args_os().skip(1).map(PathBuf::from).collect();
    if args.len() != 4 {
        return Err("arguments: PCM16_MONO_16KHZ MODEL RUNTIME OUTPUT_JSON".into());
    }
    let model_sha256 = hash_file(&args[1])?;
    let started = Instant::now();
    let mut vad = SileroVad::open(VadAssets {
        model_path: args[1].clone(),
        runtime_path: args[2].clone(),
        model_sha256: model_sha256.clone(),
    })?;
    let initialization_ms = started.elapsed().as_secs_f64() * 1000.;
    let inference = Instant::now();
    let analysis = vad.analyze_pcm16(
        BufReader::new(File::open(&args[0])?),
        &AtomicBool::new(false),
        |_| {},
    )?;
    let inference_ms = inference.elapsed().as_secs_f64() * 1000.;
    let chunks = plan_chunks(
        0,
        analysis.total_samples,
        &analysis.pauses,
        ChunkOptions::default(),
    )?;
    let report = serde_json::json!({
        "initializationMs": initialization_ms, "inferenceMs": inference_ms,
        "modelSha256": model_sha256, "runtimeSha256": hash_file(&args[2])?,
        "pcmSha256": hash_file(&args[0])?, "totalSamples": analysis.total_samples,
        "analysisSha256": sha256_bytes(&serde_json::to_vec(&analysis)?),
        "pauses": analysis.pauses, "lowProbabilityPauses": analysis.low_probability_pauses,
        "chunks": chunks, "cloudCalls": 0,
    });
    std::fs::write(&args[3], serde_json::to_vec_pretty(&report)?)?;
    println!("{initialization_ms:.3} ms initialization; {inference_ms:.3} ms inference");
    Ok(())
}
