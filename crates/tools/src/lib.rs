//! PATH scanning never executes candidates. Only selected tools are probed.
//! Updates write exclusively inside the manager's private storage.
mod command;
mod discovery;
mod manager;
mod upstream;
pub use command::{
    CommandOutput, CommandSpec, ProbeReport, YtDlpRequest, build_ytdlp_command,
    ffmpeg_extract_audio, probe, probe_and_record, probe_ytdlp_environment,
};
pub use discovery::{
    DiscoveryCandidate, ResolvedTool, ToolSnapshot, discover_path, resolve_external, sha256_file,
};
pub use manager::{InstalledTool, JobLease, ToolManager, UpdateOutcome};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
pub use tokio_util::sync::CancellationToken;
pub use upstream::{DownloadProgress, ReleaseCandidate, Verification, YtDlpChannel};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolKind {
    FfmpegPair,
    YtDlp,
    Deno,
}
impl ToolKind {
    pub fn directory(self) -> &'static str {
        match self {
            Self::FfmpegPair => "ffmpeg",
            Self::YtDlp => "yt-dlp",
            Self::Deno => "deno",
        }
    }
    pub fn executable(self) -> &'static str {
        match (self, cfg!(windows)) {
            (Self::FfmpegPair, true) => "ffmpeg.exe",
            (Self::FfmpegPair, false) => "ffmpeg",
            (Self::YtDlp, true) => "yt-dlp.exe",
            (Self::YtDlp, false) => "yt-dlp",
            (Self::Deno, true) => "deno.exe",
            (Self::Deno, false) => "deno",
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "source", rename_all = "snake_case")]
pub enum ToolSelection {
    Managed,
    External { path: PathBuf },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolSelections {
    pub ffmpeg: ToolSelection,
    pub yt_dlp: ToolSelection,
    pub deno: ToolSelection,
}
impl Default for ToolSelections {
    fn default() -> Self {
        Self {
            ffmpeg: ToolSelection::Managed,
            yt_dlp: ToolSelection::Managed,
            deno: ToolSelection::Managed,
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolSource {
    Managed,
    External,
}
