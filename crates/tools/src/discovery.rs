use crate::{ToolKind, ToolSource};
use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    ffi::OsStr,
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveryCandidate {
    pub kind: ToolKind,
    pub selected_path: PathBuf,
    pub resolved_path: Option<PathBuf>,
    pub companion_path: Option<PathBuf>,
    pub problem: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolvedTool {
    pub kind: ToolKind,
    pub source: ToolSource,
    pub selected_path: PathBuf,
    pub executable: PathBuf,
    pub ffprobe: Option<PathBuf>,
}
/// Captures resolved files, so a later Scoop junction update affects the next
/// job rather than silently redirecting the current job.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolSnapshot {
    pub tool: ResolvedTool,
    pub executable_sha256: String,
    pub ffprobe_sha256: Option<String>,
    /// Observed for this exact snapshot at job preparation, never backfilled
    /// into historical immutable audio plans or their approval digests.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub probe: Option<crate::ProbeReport>,
}
impl ToolSnapshot {
    pub fn capture(tool: ResolvedTool) -> Result<Self> {
        let executable_sha256 = sha256_file(&tool.executable)?;
        let ffprobe_sha256 = tool.ffprobe.as_deref().map(sha256_file).transpose()?;
        Ok(Self {
            tool,
            executable_sha256,
            ffprobe_sha256,
            probe: None,
        })
    }
    /// Recheck immediately before each child spawn. An external package manager
    /// can still delete a target after verification; spawn errors remain errors.
    pub fn verify(&self) -> Result<()> {
        ensure!(
            sha256_file(&self.tool.executable)? == self.executable_sha256,
            "{} changed since this job started",
            self.tool.executable.display()
        );
        match (&self.tool.ffprobe, &self.ffprobe_sha256) {
            (Some(path), Some(expected)) => ensure!(
                &sha256_file(path)? == expected,
                "{} changed since this job started",
                path.display()
            ),
            (None, None) => (),
            _ => bail!("invalid ffprobe snapshot"),
        }
        Ok(())
    }
}
pub fn sha256_file(path: &Path) -> Result<String> {
    let mut file = File::open(path).with_context(|| format!("cannot read {}", path.display()))?;
    let mut hash = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hash.update(&buf[..n]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
/// Read-only fixed-name scan: no shell, aliases, PATHEXT, implicit CWD, or execution.
pub fn discover_path(path: &OsStr) -> Vec<DiscoveryCandidate> {
    let mut seen = HashSet::new();
    let mut candidates = Vec::new();
    for dir in std::env::split_paths(path).filter(|p| p.is_absolute()) {
        for kind in [ToolKind::FfmpegPair, ToolKind::YtDlp, ToolKind::Deno] {
            let selected = dir.join(kind.executable());
            let key = if cfg!(windows) {
                selected.to_string_lossy().to_lowercase()
            } else {
                selected.to_string_lossy().into_owned()
            };
            if !selected.is_file() || !seen.insert(key) {
                continue;
            }
            candidates.push(match resolve_external(kind, &selected) {
                Ok(tool) => DiscoveryCandidate {
                    kind,
                    selected_path: selected,
                    resolved_path: Some(tool.executable),
                    companion_path: tool.ffprobe,
                    problem: None,
                },
                Err(error) => DiscoveryCandidate {
                    kind,
                    selected_path: selected,
                    resolved_path: None,
                    companion_path: None,
                    problem: Some(error.to_string()),
                },
            });
        }
    }
    candidates
}
pub fn resolve_external(kind: ToolKind, selected: &Path) -> Result<ResolvedTool> {
    ensure!(selected.is_absolute(), "select an absolute executable path");
    let executable = resolve_executable(selected)?;
    let ffprobe = if kind == ToolKind::FfmpegPair {
        let name = if cfg!(windows) {
            "ffprobe.exe"
        } else {
            "ffprobe"
        };
        let sibling = selected.with_file_name(name);
        let target = if sibling.is_file() {
            sibling
        } else {
            executable.with_file_name(name)
        };
        let probe = resolve_executable(&target)?;
        ensure!(
            executable.parent() == probe.parent(),
            "FFmpeg and ffprobe must come from the same package directory"
        );
        Some(probe)
    } else {
        None
    };
    Ok(ResolvedTool {
        kind,
        source: ToolSource::External,
        selected_path: selected.to_owned(),
        executable,
        ffprobe,
    })
}
fn resolve_executable(selected: &Path) -> Result<PathBuf> {
    if cfg!(windows) {
        ensure!(
            selected
                .extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("exe")),
            "only .exe tools are supported; select the executable instead of a script"
        );
    }
    ensure!(
        selected.is_file(),
        "executable is missing: {}",
        selected.display()
    );
    let shim = selected.with_extension("shim");
    let target = if cfg!(windows) && shim.is_file() {
        ensure!(
            fs::metadata(&shim)?.len() <= 16 * 1024,
            "shim metadata is too large"
        );
        simple_shim_target(&fs::read_to_string(&shim).context("shim metadata must be UTF-8")?)?
    } else {
        selected.to_owned()
    };
    ensure!(
        target.is_absolute() && target.is_file(),
        "shim target is missing or not absolute: {}",
        target.display()
    );
    if cfg!(windows) {
        ensure!(
            target
                .extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("exe")),
            "shim target must be an .exe"
        );
    }
    fs::canonicalize(&target).with_context(|| format!("cannot resolve {}", target.display()))
}
fn simple_shim_target(contents: &str) -> Result<PathBuf> {
    let mut path = None;
    for line in contents
        .trim_start_matches('\u{feff}')
        .lines()
        .map(str::trim)
    {
        if line.is_empty() || ["#", ";", "//"].iter().any(|p| line.starts_with(p)) {
            continue;
        }
        let (key, raw) = line
            .split_once('=')
            .context("unsupported shim metadata; select the underlying executable")?;
        ensure!(
            key.trim().eq_ignore_ascii_case("path"),
            "shim has arguments, environment, cwd or elevation settings; select the underlying executable"
        );
        ensure!(path.is_none(), "shim has duplicate path entries");
        let value = raw.trim();
        let value = if value.starts_with('"') {
            value
                .strip_prefix('"')
                .and_then(|v| v.strip_suffix('"'))
                .context("invalid quoted shim path")?
        } else {
            value
        };
        ensure!(
            !value.is_empty() && !value.contains(['"', '%', '\0']),
            "shim path requires unsupported expansion or quoting"
        );
        path = Some(PathBuf::from(value));
    }
    path.context("shim has no path")
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn snapshots_without_probe_metadata_keep_their_original_serialized_bytes() {
        let original = r#"{"tool":{"kind":"deno","source":"external","selected_path":"deno","executable":"deno","ffprobe":null},"executable_sha256":"recorded-hash","ffprobe_sha256":null}"#;
        let snapshot: ToolSnapshot = serde_json::from_str(original).unwrap();
        assert!(snapshot.probe.is_none());
        assert_eq!(serde_json::to_string(&snapshot).unwrap(), original);
    }
    #[test]
    fn shim_path_only_and_comments() {
        assert_eq!(
            simple_shim_target("\u{feff}# comment\npath = \"C:\\日本 語\\yt-dlp.exe\"\n").unwrap(),
            PathBuf::from("C:\\日本 語\\yt-dlp.exe")
        );
        for bad in [
            "path=x\nargs=--update",
            "path=x\nelevate=true",
            "path=x\nPATH=x",
            "path=x\npath=y",
            "path=%SCOOP%/x",
            "path=\"unterminated",
        ] {
            assert!(simple_shim_target(bad).is_err(), "{bad}");
        }
    }
    #[test]
    fn snapshot_detects_change_and_deletion() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(ToolKind::Deno.executable());
        fs::write(&file, b"first").unwrap();
        let snap = ToolSnapshot::capture(resolve_external(ToolKind::Deno, &file).unwrap()).unwrap();
        snap.verify().unwrap();
        fs::write(&file, b"other").unwrap();
        assert!(snap.verify().is_err());
        fs::remove_file(&file).unwrap();
        assert!(snap.verify().is_err());
    }
    #[test]
    fn discovery_does_not_execute_and_preserves_candidates() {
        let one = tempfile::tempdir().unwrap();
        let two = tempfile::tempdir().unwrap();
        for dir in [one.path(), two.path()] {
            fs::write(dir.join(ToolKind::Deno.executable()), b"not executable").unwrap();
        }
        let path = std::env::join_paths([one.path(), two.path(), one.path()]).unwrap();
        assert_eq!(discover_path(&path).len(), 2);
    }
    #[test]
    fn ffmpeg_needs_companion() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(ToolKind::FfmpegPair.executable());
        fs::write(&file, b"ffmpeg").unwrap();
        assert!(resolve_external(ToolKind::FfmpegPair, &file).is_err());
    }
    #[cfg(windows)]
    #[test]
    fn scoop_shim_resolves_without_execution() {
        let dir = tempfile::tempdir().unwrap();
        let shim = dir.path().join("deno.exe");
        let target = dir.path().join("v1").join("deno.exe");
        fs::create_dir(target.parent().unwrap()).unwrap();
        fs::write(&shim, b"shim").unwrap();
        fs::write(&target, b"target").unwrap();
        fs::write(
            shim.with_extension("shim"),
            format!("path = \"{}\"", target.display()),
        )
        .unwrap();
        assert_eq!(
            resolve_external(ToolKind::Deno, &shim).unwrap().executable,
            fs::canonicalize(target).unwrap()
        );
    }
    #[cfg(windows)]
    #[test]
    fn shim_updates_apply_only_to_next_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let shim = dir.path().join("deno.exe");
        fs::write(&shim, b"shim").unwrap();
        let old = dir.path().join("old.exe");
        let new = dir.path().join("new.exe");
        fs::write(&old, b"old").unwrap();
        fs::write(&new, b"new").unwrap();
        let redirect = |target: &Path| {
            fs::write(
                shim.with_extension("shim"),
                format!("path = \"{}\"", target.display()),
            )
            .unwrap()
        };
        redirect(&old);
        let first =
            ToolSnapshot::capture(resolve_external(ToolKind::Deno, &shim).unwrap()).unwrap();
        redirect(&new);
        let second =
            ToolSnapshot::capture(resolve_external(ToolKind::Deno, &shim).unwrap()).unwrap();
        first.verify().unwrap();
        second.verify().unwrap();
        assert_ne!(first.tool.executable, second.tool.executable);
        fs::remove_file(old).unwrap();
        assert!(first.verify().is_err());
        second.verify().unwrap();
    }
}
