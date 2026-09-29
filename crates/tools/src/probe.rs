use crate::{CancellationToken, CommandOutput, CommandSpec, ToolKind, ToolSnapshot};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::{ffi::OsString, path::Path, time::Duration};
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProbeReport {
    pub kind: ToolKind,
    pub version: String,
    pub companion_version: Option<String>,
    pub capabilities: Vec<String>,
    /// Recognition of a runtime or EJS is diagnostic; it does not promise that
    /// an arbitrary remote site will be accessible.
    pub diagnostics: Vec<String>,
}
pub(crate) fn spec(snapshot: &ToolSnapshot, program: &Path, args: &[&str]) -> CommandSpec {
    CommandSpec {
        program: program.to_owned(),
        args: args.iter().map(OsString::from).collect(),
        guards: vec![snapshot.clone()],
    }
}
pub(crate) async fn checked(
    spec: CommandSpec,
    cancel: &CancellationToken,
) -> Result<CommandOutput> {
    let output = spec.run(Duration::from_secs(20), cancel).await?;
    ensure!(
        output.code == Some(0),
        "capability probe failed: {}",
        output.stderr.chars().take(2000).collect::<String>()
    );
    Ok(output)
}
pub async fn probe(snapshot: &ToolSnapshot, cancel: &CancellationToken) -> Result<ProbeReport> {
    let tool = &snapshot.tool;
    let version_args: &[&str] = if tool.kind == ToolKind::FfmpegPair {
        &["-version"]
    } else {
        &["--version"]
    };
    let version_out = checked(spec(snapshot, &tool.executable, version_args), cancel).await?;
    let version = version_out
        .stdout
        .lines()
        .next()
        .filter(|s| !s.trim().is_empty())
        .context("tool returned no version")?
        .to_owned();
    let mut report = ProbeReport {
        kind: tool.kind,
        version,
        companion_version: None,
        capabilities: vec![],
        diagnostics: vec![],
    };
    match tool.kind {
        ToolKind::FfmpegPair => {
            ensure!(
                report.version.starts_with("ffmpeg version "),
                "selected executable is not FFmpeg"
            );
            if version_out.stdout.contains("--enable-nonfree")
                || version_out.stderr.contains("--enable-nonfree")
            {
                ensure!(
                    tool.source == crate::ToolSource::External,
                    "managed nonfree FFmpeg builds are unsupported"
                );
                report.diagnostics.push("External FFmpeg was built with --enable-nonfree; it is user-managed and is not copied or redistributed by Surtitle.".into());
            }
            let ffprobe = tool.ffprobe.as_deref().context("ffprobe is missing")?;
            let companion = checked(spec(snapshot, ffprobe, &["-version"]), cancel).await?;
            let companion_version = companion
                .stdout
                .lines()
                .next()
                .context("ffprobe returned no version")?
                .to_owned();
            ensure!(
                companion_version.starts_with("ffprobe version "),
                "companion executable is not ffprobe"
            );
            report.companion_version = Some(companion_version);
            let encoders = checked(
                spec(snapshot, &tool.executable, &["-hide_banner", "-encoders"]),
                cancel,
            )
            .await?;
            for encoder in ["flac", "pcm_s16le"] {
                ensure!(
                    encoders
                        .stdout
                        .lines()
                        .any(|l| l.split_whitespace().nth(1) == Some(encoder)),
                    "FFmpeg lacks {encoder} encoder"
                );
                report.capabilities.push(encoder.to_owned());
            }
        }
        ToolKind::YtDlp => {
            let help = checked(
                spec(
                    snapshot,
                    &tool.executable,
                    &["--ignore-config", "--no-plugin-dirs", "--help"],
                ),
                cancel,
            )
            .await?;
            for flag in [
                "--dump-single-json",
                "--js-runtimes",
                "--no-remote-components",
                "--ffmpeg-location",
                "--no-playlist",
            ] {
                ensure!(
                    help.stdout.contains(flag),
                    "yt-dlp lacks required option {flag}; update it or select the managed copy"
                );
                report.capabilities.push(flag.to_owned());
            }
        }
        ToolKind::Deno => {
            ensure!(
                report.version.starts_with("deno "),
                "selected executable is not Deno"
            );
            let result = checked(
                spec(
                    snapshot,
                    &tool.executable,
                    &[
                        "eval",
                        "--no-config",
                        "--no-lock",
                        "console.log(JSON.stringify({ok:true,version:Deno.version.deno}))",
                    ],
                ),
                cancel,
            )
            .await?;
            let data: serde_json::Value = serde_json::from_str(result.stdout.trim())
                .context("Deno probe did not return JSON")?;
            ensure!(
                data["ok"] == true && data["version"].is_string(),
                "Deno JavaScript probe failed"
            );
            report.capabilities.push("javascript".into());
        }
    }
    Ok(report)
}

/// Associate fresh version/capability observations with the same executable
/// bytes that subsequent spawns guard. Failed revalidation leaves no claim.
pub async fn probe_and_record(
    snapshot: &mut ToolSnapshot,
    cancel: &CancellationToken,
) -> Result<()> {
    snapshot.probe = None;
    let report = probe(snapshot, cancel).await?;
    snapshot.verify()?;
    snapshot.probe = Some(report);
    Ok(())
}
