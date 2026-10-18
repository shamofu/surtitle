use crate::{CommandSpec, ToolKind, ToolSnapshot};
use anyhow::{Result, bail, ensure};
use std::{ffi::OsString, path::Path};

/// Accurate transcoded span; output is mono 16 kHz PCM WAV or FLAC. `-n` avoids
/// overwriting a pre-existing user file. Fingerprint the source separately.
pub fn ffmpeg_extract_audio(
    ffmpeg: &ToolSnapshot,
    input: &Path,
    stream_index: u32,
    start_seconds: f64,
    duration_seconds: f64,
    output: &Path,
) -> Result<CommandSpec> {
    ensure!(
        ffmpeg.tool.kind == ToolKind::FfmpegPair,
        "FFmpeg tool required"
    );
    ensure!(
        input.is_absolute() && output.is_absolute(),
        "audio paths must be absolute"
    );
    ensure!(
        start_seconds.is_finite()
            && start_seconds >= 0.0
            && duration_seconds.is_finite()
            && duration_seconds > 0.0,
        "invalid audio interval"
    );
    let codec = match output.extension().and_then(|s| s.to_str()) {
        Some("flac") => "flac",
        Some("wav") => "pcm_s16le",
        _ => bail!("audio output must be .flac or .wav"),
    };
    let mut args: Vec<OsString> = ["-nostdin", "-hide_banner", "-loglevel", "error", "-n", "-i"]
        .into_iter()
        .map(Into::into)
        .collect();
    args.push(input.into());
    args.extend([
        "-ss".into(),
        start_seconds.to_string().into(),
        "-t".into(),
        duration_seconds.to_string().into(),
    ]);
    args.extend([OsString::from("-map"), format!("0:{stream_index}").into()]);
    args.extend(
        ["-vn", "-ac", "1", "-ar", "16000", "-c:a", codec]
            .into_iter()
            .map(Into::into),
    );
    args.push(output.into());
    Ok(CommandSpec {
        program: ffmpeg.tool.executable.clone(),
        args,
        guards: vec![ffmpeg.clone()],
    })
}
