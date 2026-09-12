use crate::{CancellationToken, ToolKind, ToolSnapshot};
use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
};

#[derive(Debug, Clone)]
pub struct CommandSpec {
    pub program: PathBuf,
    /// Each entry is one literal argument. Never join these into shell text.
    pub args: Vec<OsString>,
    pub guards: Vec<ToolSnapshot>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandOutput {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}
impl CommandSpec {
    pub async fn run(
        &self,
        timeout: Duration,
        cancel: &CancellationToken,
    ) -> Result<CommandOutput> {
        for guard in &self.guards {
            guard.verify()?;
        }
        ensure!(
            self.program.is_absolute(),
            "command executable must be absolute"
        );
        ensure!(!cancel.is_cancelled(), "operation cancelled");
        let mut command = Command::new(&self.program);
        command
            .args(&self.args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        #[cfg(unix)]
        command.process_group(0);
        let mut child = command
            .spawn()
            .with_context(|| format!("cannot start {}", self.program.display()))?;
        #[cfg(windows)]
        let _job = WindowsJob::attach(child.id().context("child has no process ID")?)?;
        #[cfg(unix)]
        let _group = UnixProcessGroup(child.id().context("child has no process ID")? as i32);
        let stdout = child.stdout.take().context("child stdout not captured")?;
        let stderr = child.stderr.take().context("child stderr not captured")?;
        let work = async {
            let (stdout, stderr, status) =
                tokio::try_join!(read_bounded(stdout), read_bounded(stderr), async {
                    Ok::<_, anyhow::Error>(child.wait().await?)
                })?;
            Ok(CommandOutput {
                code: status.code(),
                stdout,
                stderr,
            })
        };
        tokio::select! {
            biased;
            _ = cancel.cancelled() => bail!("operation cancelled"),
            result = tokio::time::timeout(timeout, work) => result.context("tool execution timed out")?,
        }
    }
}
async fn read_bounded(reader: impl AsyncRead + Unpin) -> Result<String> {
    const MAX: u64 = 16 * 1024 * 1024;
    let mut data = Vec::new();
    reader.take(MAX + 1).read_to_end(&mut data).await?;
    ensure!(data.len() as u64 <= MAX, "tool output exceeded limit");
    Ok(String::from_utf8_lossy(&data).into_owned())
}

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
fn spec(snapshot: &ToolSnapshot, program: &Path, args: &[&str]) -> CommandSpec {
    CommandSpec {
        program: program.to_owned(),
        args: args.iter().map(OsString::from).collect(),
        guards: vec![snapshot.clone()],
    }
}
async fn checked(spec: CommandSpec, cancel: &CancellationToken) -> Result<CommandOutput> {
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

#[cfg(windows)]
struct WindowsJob(windows_sys::Win32::Foundation::HANDLE);
#[cfg(unix)]
struct UnixProcessGroup(i32);
#[cfg(unix)]
impl Drop for UnixProcessGroup {
    fn drop(&mut self) {
        unsafe {
            libc::kill(-self.0, libc::SIGKILL);
        }
    }
}
#[cfg(windows)]
unsafe impl Send for WindowsJob {}
#[cfg(windows)]
impl WindowsJob {
    fn attach(pid: u32) -> Result<Self> {
        use windows_sys::Win32::{
            Foundation::{CloseHandle, HANDLE},
            System::{JobObjects::*, Threading::*},
        };
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            ensure!(!handle.is_null(), "cannot create Windows process job");
            let job = Self(handle);
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            ensure!(
                SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    &limits as *const _ as *const _,
                    std::mem::size_of_val(&limits) as u32
                ) != 0,
                "cannot set process job limits"
            );
            let process: HANDLE = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            ensure!(
                !process.is_null(),
                "cannot open child process for job assignment"
            );
            let assigned = AssignProcessToJobObject(handle, process);
            CloseHandle(process);
            ensure!(assigned != 0, "cannot assign child process to Windows job");
            Ok(job)
        }
    }
}
#[cfg(windows)]
impl Drop for WindowsJob {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn compiled_deno_fixture(directory: &Path, version: &str) -> PathBuf {
        std::fs::create_dir_all(directory).unwrap();
        let source = directory.join("fixture.rs");
        std::fs::write(&source, format!(r#"fn main() {{
            if std::env::args().nth(1).as_deref() == Some("--version") {{ println!("deno {version}"); }}
            else {{ println!("{{{{\"ok\":true,\"version\":\"{version}\"}}}}"); }}
        }}"#)).unwrap();
        let executable = directory.join(ToolKind::Deno.executable());
        let result = std::process::Command::new("rustc")
            .args(["--edition=2024", "--crate-name", "surtitle_tool_fixture"])
            .arg(&source)
            .arg("-o")
            .arg(&executable)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        executable
    }
    #[tokio::test]
    async fn new_probes_follow_selected_updates_and_keep_original_job_evidence() {
        let root = tempfile::tempdir().unwrap();
        let old = compiled_deno_fixture(&root.path().join("old"), "90.0.1");
        let new = compiled_deno_fixture(&root.path().join("new"), "90.0.2");
        let selected = root.path().join(ToolKind::Deno.executable());
        let redirect = |target: &Path| {
            #[cfg(windows)]
            {
                std::fs::write(&selected, b"unexecuted Scoop shim").unwrap();
                std::fs::write(
                    selected.with_extension("shim"),
                    format!("path = \"{}\"", target.display()),
                )
                .unwrap();
            }
            #[cfg(unix)]
            {
                if selected.symlink_metadata().is_ok() {
                    std::fs::remove_file(&selected).unwrap();
                }
                std::os::unix::fs::symlink(target, &selected).unwrap();
            }
        };
        let manager = crate::ToolManager::new(root.path().join("managed")).unwrap();
        let selection = crate::ToolSelection::External {
            path: selected.clone(),
        };
        let cancel = CancellationToken::new();
        redirect(&old);
        let mut first = manager
            .lease_tools(&[(ToolKind::Deno, selection.clone())])
            .unwrap();
        probe_and_record(&mut first.tools[0], &cancel)
            .await
            .unwrap();
        let original = serde_json::to_vec(&first.tools).unwrap();
        assert_eq!(
            first.tools[0].probe.as_ref().unwrap().version,
            "deno 90.0.1"
        );
        redirect(&new);
        let mut second = manager.lease_tools(&[(ToolKind::Deno, selection)]).unwrap();
        assert!(second.tools[0].probe.is_none());
        probe_and_record(&mut second.tools[0], &cancel)
            .await
            .unwrap();
        assert_eq!(
            second.tools[0].probe.as_ref().unwrap().version,
            "deno 90.0.2"
        );
        assert_eq!(
            second.tools[0].tool.selected_path,
            first.tools[0].tool.selected_path
        );
        assert_ne!(
            second.tools[0].tool.executable,
            first.tools[0].tool.executable
        );
        assert_ne!(
            second.tools[0].executable_sha256,
            first.tools[0].executable_sha256
        );
        first.tools[0].verify().unwrap();
        assert_eq!(serde_json::to_vec(&first.tools).unwrap(), original);
        std::fs::remove_file(&new).unwrap();
        assert!(
            probe_and_record(&mut second.tools[0], &cancel)
                .await
                .is_err()
        );
        assert!(second.tools[0].probe.is_none());
        assert!(old.is_file());
    }
    fn fake(kind: ToolKind) -> ToolSnapshot {
        ToolSnapshot {
            tool: crate::ResolvedTool {
                kind,
                source: crate::ToolSource::External,
                selected_path: PathBuf::from("unused"),
                executable: std::env::temp_dir()
                    .join("日本 語 & test")
                    .join(kind.executable()),
                ffprobe: (kind == ToolKind::FfmpegPair)
                    .then(|| std::env::temp_dir().join("ffprobe.exe")),
            },
            executable_sha256: "hash".into(),
            ffprobe_sha256: None,
            probe: None,
        }
    }
    #[test]
    fn literal_url_and_mixed_tools() {
        let yt = fake(ToolKind::YtDlp);
        let mut deno = fake(ToolKind::Deno);
        deno.tool.source = crate::ToolSource::Managed;
        let url = "https://www.youtube.com/watch?v=test&list=abc";
        let cmd = build_ytdlp_command(
            &yt,
            &deno,
            &fake(ToolKind::FfmpegPair),
            YtDlpRequest::Metadata { url: url.into() },
        )
        .unwrap();
        assert_eq!(cmd.args.last().unwrap(), url);
        assert_eq!(cmd.args[cmd.args.len() - 2], "--");
        assert!(
            cmd.args
                .iter()
                .any(|a| a.to_string_lossy().starts_with("deno:"))
        );
        assert!(!cmd.args.iter().any(|a| a == "-U"));
    }
    #[test]
    fn local_urls_and_credentials_rejected() {
        for url in [
            "file:///C:/secret",
            "https://user:pass@example.org/",
            "--exec=bad",
        ] {
            assert!(
                build_ytdlp_command(
                    &fake(ToolKind::YtDlp),
                    &fake(ToolKind::Deno),
                    &fake(ToolKind::FfmpegPair),
                    YtDlpRequest::Metadata { url: url.into() }
                )
                .is_err()
            );
        }
    }
    #[test]
    fn audio_interval_validation() {
        let temp = std::env::temp_dir();
        assert!(
            ffmpeg_extract_audio(
                &fake(ToolKind::FfmpegPair),
                &temp.join("in.mp4"),
                2,
                f64::NAN,
                1.0,
                &temp.join("out.wav")
            )
            .is_err()
        );
        let cmd = ffmpeg_extract_audio(
            &fake(ToolKind::FfmpegPair),
            &temp.join("日本 語 & in.mp4"),
            3,
            1.5,
            10.0,
            &temp.join("out.flac"),
        )
        .unwrap();
        assert!(cmd.args.contains(&"-n".into()));
        assert!(cmd.args.contains(&"16000".into()));
        assert!(cmd.args.contains(&"0:3".into()));
    }
    #[tokio::test]
    #[ignore = "explicit local integration: set SURTITLE_TEST_FFMPEG, SURTITLE_TEST_YTDLP, SURTITLE_TEST_DENO to selected executable paths"]
    async fn installed_tools_probe_and_extract() {
        let resolve = |kind, key| {
            let path = PathBuf::from(std::env::var_os(key).expect("integration tool path missing"));
            ToolSnapshot::capture(crate::resolve_external(kind, &path).unwrap()).unwrap()
        };
        let ffmpeg = resolve(ToolKind::FfmpegPair, "SURTITLE_TEST_FFMPEG");
        let yt = resolve(ToolKind::YtDlp, "SURTITLE_TEST_YTDLP");
        let deno = resolve(ToolKind::Deno, "SURTITLE_TEST_DENO");
        let cancel = CancellationToken::new();
        for tool in [&ffmpeg, &yt, &deno] {
            probe(tool, &cancel).await.unwrap();
        }
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("日本 語 & input.wav");
        let output = temp.path().join("span.wav");
        let mut generate = spec(
            &ffmpeg,
            &ffmpeg.tool.executable,
            &[
                "-nostdin",
                "-v",
                "error",
                "-n",
                "-f",
                "lavfi",
                "-i",
                "anullsrc=r=48000:cl=stereo",
                "-t",
                "2",
            ],
        );
        generate.args.push(source.as_os_str().to_owned());
        assert_eq!(
            generate
                .run(Duration::from_secs(20), &cancel)
                .await
                .unwrap()
                .code,
            Some(0)
        );
        let extract = ffmpeg_extract_audio(&ffmpeg, &source, 0, 0.5, 1.0, &output).unwrap();
        assert_eq!(
            extract
                .run(Duration::from_secs(20), &cancel)
                .await
                .unwrap()
                .code,
            Some(0)
        );
        let mut inspect = spec(
            &ffmpeg,
            ffmpeg.tool.ffprobe.as_deref().unwrap(),
            &["-v", "error", "-show_streams", "-of", "json"],
        );
        inspect.args.push(output.into_os_string());
        let json: serde_json::Value = serde_json::from_str(
            &inspect
                .run(Duration::from_secs(20), &cancel)
                .await
                .unwrap()
                .stdout,
        )
        .unwrap();
        assert_eq!(json["streams"][0]["sample_rate"], "16000");
        assert_eq!(json["streams"][0]["channels"], 1);
    }
    #[tokio::test]
    #[ignore = "explicit local FFmpeg regression; set SURTITLE_TEST_FFMPEG"]
    async fn multitrack_extraction_preserves_selected_stream() {
        let ffmpeg = ToolSnapshot::capture(
            crate::resolve_external(
                ToolKind::FfmpegPair,
                &PathBuf::from(
                    std::env::var_os("SURTITLE_TEST_FFMPEG").expect("explicit FFmpeg path"),
                ),
            )
            .unwrap(),
        )
        .unwrap();
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("日本語 & multi.mkv");
        let cancel = CancellationToken::new();
        let mut generate = spec(
            &ffmpeg,
            &ffmpeg.tool.executable,
            &[
                "-nostdin",
                "-v",
                "error",
                "-n",
                "-f",
                "lavfi",
                "-i",
                "color=c=black:s=16x16:r=1",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=16000",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=880:sample_rate=16000",
                "-t",
                "1",
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
            ],
        );
        generate.args.push(source.clone().into_os_string());
        assert_eq!(
            generate
                .run(Duration::from_secs(30), &cancel)
                .await
                .unwrap()
                .code,
            Some(0)
        );
        let mut crossings = Vec::new();
        for index in [1, 2] {
            let output = temp.path().join(format!("stream-{index}.wav"));
            assert_eq!(
                ffmpeg_extract_audio(&ffmpeg, &source, index, 0.2, 0.5, &output)
                    .unwrap()
                    .run(Duration::from_secs(30), &cancel)
                    .await
                    .unwrap()
                    .code,
                Some(0)
            );
            let bytes = std::fs::read(output).unwrap();
            let data = bytes.windows(4).position(|w| w == b"data").unwrap() + 8;
            let samples = bytes[data..]
                .as_chunks::<2>()
                .0
                .iter()
                .map(|b| i16::from_le_bytes([b[0], b[1]]))
                .collect::<Vec<_>>();
            assert!((7900..8100).contains(&samples.len()));
            crossings.push(samples.windows(2).filter(|p| p[0] < 0 && p[1] >= 0).count());
        }
        assert!(
            (215..225).contains(&crossings[0]),
            "first audio was not 440 Hz: {crossings:?}"
        );
        assert!(
            (435..445).contains(&crossings[1]),
            "selected second audio was not 880 Hz: {crossings:?}"
        );
    }
}
