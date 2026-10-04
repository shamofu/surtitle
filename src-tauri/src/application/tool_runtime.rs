//! App-owned tool selection discovery and update lifecycle state.
use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, sync::Mutex};
use surtitle_tools::*;

pub(super) struct ToolRuntime {
    pub(super) manager: ToolManager,
    pub(super) candidates: Mutex<Vec<ExternalCandidate>>,
    pub(super) update_check: tokio::sync::Mutex<()>,
    pub(super) shutdown: CancellationToken,
}
impl ToolRuntime {
    pub(super) fn open(root: PathBuf, path: &std::ffi::OsStr) -> Result<Self> {
        Ok(Self {
            manager: ToolManager::new(root)?,
            candidates: Mutex::new(discover_external_candidates(path)),
            update_check: tokio::sync::Mutex::new(()),
            shutdown: CancellationToken::new(),
        })
    }
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalCandidate {
    pub tool_id: String,
    pub path: String,
    version: Option<String>,
    pub selectable: bool,
    pub verification: &'static str,
    reason: Option<String>,
}
pub fn discover_external_candidates(path: &std::ffi::OsStr) -> Vec<ExternalCandidate> {
    discover_path(path)
        .into_iter()
        .map(|c| ExternalCandidate {
            tool_id: c.kind.directory().into(),
            path: c.selected_path.to_string_lossy().into_owned(),
            version: None,
            selectable: c.problem.is_none(),
            verification: "unverified",
            reason: c.problem,
        })
        .collect()
}

use super::{AppState, Preferences, Services, err, lock};
pub fn kind(id: &str) -> Result<ToolKind> {
    match id {
        "ffmpeg" => Ok(ToolKind::FfmpegPair),
        "yt-dlp" => Ok(ToolKind::YtDlp),
        "deno" => Ok(ToolKind::Deno),
        _ => bail!("unsupported tool"),
    }
}

pub(crate) fn selection(p: &Preferences, k: ToolKind) -> ToolSelection {
    match k {
        ToolKind::FfmpegPair => p.tools.ffmpeg.clone(),
        ToolKind::YtDlp => p.tools.yt_dlp.clone(),
        ToolKind::Deno => p.tools.deno.clone(),
    }
}
fn set_selection(p: &mut Preferences, k: ToolKind, value: ToolSelection) {
    match k {
        ToolKind::FfmpegPair => p.tools.ffmpeg = value,
        ToolKind::YtDlp => p.tools.yt_dlp = value,
        ToolKind::Deno => p.tools.deno = value,
    }
}
pub(crate) fn channel(p: &Preferences) -> YtDlpChannel {
    if p.settings.yt_dlp_channel == "nightly" {
        YtDlpChannel::Nightly
    } else {
        YtDlpChannel::Stable
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    id: String,
    name: String,
    provider: String,
    status: String,
    version: Option<String>,
    path: Option<String>,
    error: Option<String>,
    can_rollback: bool,
    latest_version: Option<String>,
    update_available: bool,
}
pub fn statuses(state: &Services) -> Result<Vec<ToolStatus>> {
    let p = state.preferences.read()?;
    let mut result = Vec::new();
    for (k, name) in [
        (ToolKind::FfmpegPair, "FFmpeg / ffprobe"),
        (ToolKind::YtDlp, "yt-dlp"),
        (ToolKind::Deno, "Deno"),
    ] {
        let id = k.directory();
        let mut install_id = None;
        let (provider, status, version, path, error, can_rollback) = match selection(&p, k) {
            ToolSelection::Managed => match state.tools.manager.installed(k) {
                Ok(Some(i)) => {
                    install_id = Some(i.install_id.clone());
                    (
                        "managed",
                        "ready",
                        Some(i.version.clone()),
                        Some(
                            state
                                .tools
                                .manager
                                .root()
                                .join(id)
                                .join("versions")
                                .join(i.install_id)
                                .join(i.executable_relative)
                                .to_string_lossy()
                                .into_owned(),
                        ),
                        None,
                        state.tools.manager.can_rollback(k),
                    )
                }
                Ok(None) => ("managed", "missing", None, None, None, false),
                Err(e) => ("managed", "error", None, None, Some(e.to_string()), false),
            },
            ToolSelection::External { path } => {
                let exists = path.is_file();
                (
                    "external",
                    if exists { "ready" } else { "missing" },
                    p.probes.get(id).map(|r| r.version.clone()),
                    Some(path.to_string_lossy().into_owned()),
                    if exists {
                        None
                    } else {
                        Some("選択したツールが見つかりません。再選択してください。".into())
                    },
                    false,
                )
            }
        };
        let latest_version =
            crate::application::tool_updates::latest_version(&p, k, install_id.as_deref());
        let update_available = provider == "managed"
            && version.is_some()
            && latest_version
                .as_ref()
                .zip(version.as_ref())
                .is_some_and(|(a, b)| a != b);
        result.push(ToolStatus {
            id: id.into(),
            name: name.into(),
            provider: provider.into(),
            status: status.into(),
            version,
            path,
            error,
            can_rollback,
            latest_version,
            update_available,
        });
    }
    result.push(ToolStatus {
        id: "vad".into(),
        name: "Silero VAD".into(),
        provider: "managed".into(),
        status: if state
            .root
            .join("models")
            .join(surtitle_ai::SILERO_MODEL_FILENAME)
            .is_file()
        {
            "ready"
        } else {
            "missing"
        }
        .into(),
        version: Some(surtitle_ai::SILERO_MODEL_VERSION.into()),
        path: None,
        error: None,
        can_rollback: false,
        latest_version: None,
        update_available: false,
    });
    Ok(result)
}

pub fn scan_external_tools(
    state: AppState,
    rescan: Option<bool>,
) -> std::result::Result<Vec<ExternalCandidate>, String> {
    (|| {
        if rescan.unwrap_or(true) {
            let candidates =
                discover_external_candidates(&std::env::var_os("PATH").unwrap_or_default());
            *lock(&state.tools.candidates)? = candidates;
        }
        Ok(lock(&state.tools.candidates)?.clone())
    })()
    .map_err(err)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRequest {
    tool_id: String,
    provider: String,
    path: Option<String>,
}
pub async fn set_tool_provider(
    state: AppState,
    request: ProviderRequest,
) -> std::result::Result<(), String> {
    async {
        let k = kind(&request.tool_id)?;
        let value = match request.provider.as_str() {
            "managed" => ToolSelection::Managed,
            "external" => ToolSelection::External {
                path: PathBuf::from(request.path.context("select a tool path")?),
            },
            _ => bail!("invalid provider"),
        };
        let report = if matches!(value, ToolSelection::External { .. }) {
            let snapshot = state.tools.manager.resolve_selection(k, &value)?;
            Some(probe(&snapshot, &CancellationToken::new()).await?)
        } else {
            None
        };
        state.preferences.update(|p| {
            set_selection(p, k, value);
            if let Some(report) = report {
                p.probes.insert(k.directory().into(), report);
            }
            Ok(())
        })
    }
    .await
    .map_err(err)
}
async fn update(state: &Services, id: &str) -> Result<()> {
    if id == "vad" {
        surtitle_ai::install_silero_model(&state.root.join("models")).await?;
        return Ok(());
    }
    let k = kind(id)?;
    let c = {
        let p = state.preferences.read()?;
        ensure!(
            matches!(selection(&p, k), ToolSelection::Managed),
            "外部ツールは利用者のパッケージマネージャーで更新してください / External tools are user managed"
        );
        channel(&p)
    };
    state
        .tools
        .manager
        .update(k, c, &CancellationToken::new())
        .await?;
    Ok(())
}
pub async fn install_tool(state: AppState, tool_id: String) -> std::result::Result<(), String> {
    update(&state, &tool_id).await.map_err(err)
}
pub async fn update_tool(state: AppState, tool_id: String) -> std::result::Result<(), String> {
    update(&state, &tool_id).await.map_err(err)
}
pub fn rollback_tool(state: AppState, tool_id: String) -> std::result::Result<(), String> {
    (|| {
        let k = kind(&tool_id)?;
        ensure!(
            matches!(
                selection(&*state.preferences.read()?, k),
                ToolSelection::Managed
            ),
            "external tools cannot be rolled back by Surtitle"
        );
        state.tools.manager.rollback(k)?;
        Ok(())
    })()
    .map_err(err)
}
