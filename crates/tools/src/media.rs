use crate::{CancellationToken, CommandSpec, ToolKind, ToolSnapshot};
use anyhow::{Context, Result, bail, ensure};
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    time::Duration,
};
#[derive(Debug, Clone)]
pub enum YtDlpRequest {
    Metadata {
        url: String,
    },
    Download {
        url: String,
        output_directory: PathBuf,
    },
}
/// Caller checks playlist/live/access policy against Metadata before Download.
pub fn build_ytdlp_command(
    yt_dlp: &ToolSnapshot,
    deno: &ToolSnapshot,
    ffmpeg: &ToolSnapshot,
    request: YtDlpRequest,
) -> Result<CommandSpec> {
    ensure!(
        yt_dlp.tool.kind == ToolKind::YtDlp
            && deno.tool.kind == ToolKind::Deno
            && ffmpeg.tool.kind == ToolKind::FfmpegPair,
        "incorrect tool combination"
    );
    let mut args: Vec<OsString> = [
        "--ignore-config",
        "--no-plugin-dirs",
        "--no-update",
        "--no-remote-components",
        "--no-js-runtimes",
        "--js-runtimes",
    ]
    .into_iter()
    .map(Into::into)
    .collect();
    let mut runtime = OsString::from("deno:");
    runtime.push(&deno.tool.executable);
    args.push(runtime);
    args.push("--ffmpeg-location".into());
    args.push(
        ffmpeg
            .tool
            .executable
            .parent()
            .context("FFmpeg has no parent")?
            .as_os_str()
            .to_owned(),
    );
    args.extend(
        [
            "--no-playlist",
            "--no-progress",
            "--no-exec",
            "--no-mark-watched",
            "--color",
            "no_color",
        ]
        .into_iter()
        .map(Into::into),
    );
    let url = match request {
        YtDlpRequest::Metadata { url } => {
            args.extend(
                ["--skip-download", "--dump-single-json"]
                    .into_iter()
                    .map(Into::into),
            );
            url
        }
        YtDlpRequest::Download {
            url,
            output_directory,
        } => {
            ensure!(
                output_directory.is_absolute(),
                "download directory must be absolute"
            );
            args.extend(["--no-overwrites", "--paths"].into_iter().map(Into::into));
            args.push(output_directory.into_os_string());
            args.extend(
                [
                    "--output",
                    "%(id)s.%(ext)s",
                    "--print",
                    "after_move:filepath",
                ]
                .into_iter()
                .map(Into::into),
            );
            url
        }
    };
    let parsed = reqwest::Url::parse(&url).context("invalid media URL")?;
    ensure!(
        ["https", "http"].contains(&parsed.scheme())
            && parsed.host_str().is_some()
            && parsed.username().is_empty()
            && parsed.password().is_none(),
        "only HTTP(S) media URLs without credentials are supported"
    );
    args.push("--".into());
    args.push(url.into());
    Ok(CommandSpec {
        program: yt_dlp.tool.executable.clone(),
        args,
        guards: vec![yt_dlp.clone(), deno.clone(), ffmpeg.clone()],
    })
}

/// Runs a metadata-only check against a caller-provided URL. It neither downloads
/// media nor updates external pip/Scoop installations or EJS dependencies.
pub async fn probe_ytdlp_environment(
    yt_dlp: &ToolSnapshot,
    deno: &ToolSnapshot,
    ffmpeg: &ToolSnapshot,
    url: &str,
    cancel: &CancellationToken,
) -> Result<serde_json::Value> {
    let mut command = build_ytdlp_command(
        yt_dlp,
        deno,
        ffmpeg,
        YtDlpRequest::Metadata {
            url: url.to_owned(),
        },
    )?;
    command.args.insert(0, "--verbose".into());
    // Do not suppress runtime/EJS errors. A 403 or unavailable video is a site
    // failure and is not translated into an automatic rollback.
    command.args.retain(|a| a != "--no-warnings");
    let output = command.run(Duration::from_secs(60), cancel).await?;
    ensure!(
        output.code == Some(0),
        "yt-dlp metadata failed (may be site access or runtime/EJS): {}",
        output.stderr.chars().take(4000).collect::<String>()
    );
    let json: serde_json::Value =
        serde_json::from_str(&output.stdout).context("yt-dlp did not emit JSON")?;
    ensure!(
        json.is_object() && (json["id"].is_string() || json["entries"].is_array()),
        "yt-dlp metadata lacks expected fields"
    );
    let lower = output.stderr.to_lowercase();
    ensure!(
        ![
            "no supported javascript runtime",
            "challenge solving failed",
            "ejs was not found",
            "ejs: unavailable"
        ]
        .iter()
        .any(|s| lower.contains(s)),
        "yt-dlp could not use the required runtime/EJS; update the external installation or use managed tools"
    );
    Ok(json)
}

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
