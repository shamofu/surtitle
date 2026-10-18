//! PATH scanning never executes candidates. Only selected tools are probed.
//! Updates write exclusively inside the manager's private storage.
mod command;
mod discovery;
mod manager;
mod media;
mod probe;
mod upstream;
pub use command::{CommandOutput, CommandSpec};
pub use discovery::{
    DiscoveryCandidate, ResolvedTool, ToolSnapshot, discover_path, resolve_external, sha256_file,
};
pub use manager::{InstalledTool, JobLease, ToolManager, UpdateOutcome};
pub use media::ffmpeg_extract_audio;
pub use probe::{ProbeReport, probe, probe_and_record};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
pub use tokio_util::sync::CancellationToken;
pub use upstream::{DownloadProgress, ReleaseCandidate, ToolUpdateProgress, Verification};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolKind {
    FfmpegPair,
}
impl ToolKind {
    pub fn directory(self) -> &'static str {
        match self {
            Self::FfmpegPair => "ffmpeg",
        }
    }
    pub fn executable(self) -> &'static str {
        match (self, cfg!(windows)) {
            (Self::FfmpegPair, true) => "ffmpeg.exe",
            (Self::FfmpegPair, false) => "ffmpeg",
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
}
impl Default for ToolSelections {
    fn default() -> Self {
        Self {
            ffmpeg: ToolSelection::Managed,
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolSource {
    Managed,
    External,
}
