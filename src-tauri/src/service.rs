use crate::player::{Player, PlayerState};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
};
use surtitle_core::{AppSettings, Store};
use surtitle_tools::ToolSelections;

pub type AppState = Arc<Services>;
pub struct Services {
    _instance_lock: std::fs::File,
    pub root: PathBuf,
    pub db: Mutex<Store>,
    pub preferences: Mutex<Preferences>,
    /// Serialize native commands, learning replacement, and poll-plus-save.
    /// Acquire this before player, playing, database, or preferences guards.
    pub playback: Mutex<()>,
    pub player: Mutex<Option<Player>>,
    pub player_error: Mutex<Option<String>>,
    pub playing: Mutex<Option<String>>,
    pub restores: Mutex<HashMap<String, RestorePlan>>,
    pub ai: surtitle_ai::AiStore,
    pub tools: surtitle_tools::ToolManager,
    pub tool_candidates: Mutex<Vec<crate::tool_commands::ExternalCandidate>>,
    pub tool_update_check: tokio::sync::Mutex<()>,
    pub tool_update_shutdown: surtitle_tools::CancellationToken,
    pub runtime_dir: Mutex<PathBuf>,
    pub preparation: Mutex<Option<std::sync::Arc<std::sync::atomic::AtomicBool>>>,
    pub transcript_review: Mutex<()>,
    pub downloads: crate::tool_commands::DownloadManager,
}
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Preferences {
    pub settings: AppSettings,
    pub tools: ToolSelections,
    pub credential_id: Option<String>,
    #[serde(default)]
    pub quotes: HashMap<String, QuoteContext>,
    #[serde(default)]
    pub probes: HashMap<String, surtitle_tools::ProbeReport>,
    #[serde(default)]
    pub yt_dlp_stable: bool,
    #[serde(default)]
    pub update_checks: HashMap<String, UpdateCheck>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateCheck {
    pub checked_at_ms: i64,
    pub version: String,
    #[serde(default)]
    pub install_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuoteContext {
    pub media_id: String,
    pub kind: String,
    pub start_ms: u64,
    pub end_ms: u64,
}
pub struct RestorePlan {
    pub snapshot: crate::restore_snapshot::RestoreSnapshot,
    pub archive: surtitle_core::LearningArchive,
}
pub fn lock<T>(value: &Mutex<T>) -> Result<MutexGuard<'_, T>> {
    value
        .lock()
        .map_err(|_| anyhow::anyhow!("operation interrupted; restart Surtitle"))
}
pub fn err(error: anyhow::Error) -> String {
    error.to_string()
}

impl Services {
    pub fn open(root: PathBuf) -> Result<AppState> {
        Self::open_with_tool_path(root, &std::env::var_os("PATH").unwrap_or_default())
    }
    fn open_with_tool_path(root: PathBuf, tool_path: &std::ffi::OsStr) -> Result<AppState> {
        std::fs::create_dir_all(&root)?;
        let instance_lock = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(root.join("instance.lock"))?;
        instance_lock.try_lock().context("Surtitle is already using this data directory. Close the other window before restarting.")?;
        crate::restore_snapshot::remove_abandoned(&root)?;
        for dir in [
            "card-audio",
            "media",
            "backups",
            "prepared",
            "tools",
            "credentials",
        ] {
            std::fs::create_dir_all(root.join(dir))?;
        }
        let pref_path = root.join("preferences.json");
        let preferences = if pref_path.is_file() {
            serde_json::from_reader(std::fs::File::open(pref_path)?)?
        } else {
            Preferences::default()
        };
        let db = Store::open(root.join("learning.sqlite"))?;
        let ai = surtitle_ai::AiStore::open(root.join("charges.sqlite"))?;
        let tools = surtitle_tools::ToolManager::new(root.join("tools"))?;
        let tool_candidates = crate::tool_commands::discover_external_candidates(tool_path);
        let downloads = crate::tool_commands::DownloadManager::open(&root)?;
        ai.recover_interrupted()?;
        Ok(Arc::new(Self {
            _instance_lock: instance_lock,
            root,
            db: Mutex::new(db),
            preferences: Mutex::new(preferences),
            playback: Mutex::new(()),
            player: Mutex::new(None),
            player_error: Mutex::new(None),
            playing: Mutex::new(None),
            restores: Mutex::new(HashMap::new()),
            ai,
            tools,
            tool_candidates: Mutex::new(tool_candidates),
            tool_update_check: tokio::sync::Mutex::new(()),
            tool_update_shutdown: surtitle_tools::CancellationToken::new(),
            runtime_dir: Mutex::new(PathBuf::new()),
            preparation: Mutex::new(None),
            transcript_review: Mutex::new(()),
            downloads,
        }))
    }
    pub fn save_preferences(&self, preferences: &Preferences) -> Result<()> {
        surtitle_core::store::write_json_atomic(&self.root.join("preferences.json"), preferences)
    }
    pub fn settings(&self) -> Result<AppSettings> {
        let p = lock(&self.preferences)?;
        let mut settings = p.settings.clone();
        settings.credential_configured = p.credential_id.is_some();
        Ok(settings)
    }
    pub fn player_state(&self) -> Result<PlayerState> {
        self.playback_tick(false)
    }
    pub fn playback_tick(&self, persist: bool) -> Result<PlayerState> {
        let _playback = lock(&self.playback)?;
        let state = if let Some(player) = lock(&self.player)?.as_mut() {
            player.poll()
        } else {
            PlayerState {
                error: lock(&self.player_error)?.clone(),
                ..Default::default()
            }
        };
        // Keep the sampled state inside the same coordinator as restoration.
        // A detached old file must never overwrite an archive's resume position.
        if persist
            && state.ready
            && let Some(id) = lock(&self.playing)?.as_ref()
        {
            let db = lock(&self.db)?;
            if let Ok(mut media) = db.media(id) {
                media.duration_ms = state.duration_ms;
                media.last_position_ms = state.position_ms;
                if media.audio_stream_index.is_none() {
                    media.audio_stream_index = state
                        .tracks
                        .iter()
                        .find(|track| track.kind == "audio" && track.selected && !track.external)
                        .and_then(|track| track.ff_index);
                }
                db.put_media(&media)?;
            }
        }
        Ok(state)
    }
    pub fn require_player<'a>(
        &self,
        guard: &'a mut MutexGuard<Option<Player>>,
    ) -> Result<&'a mut Player> {
        guard
            .as_mut()
            .context("Native player is unavailable; prepare the bundled runtime")
    }
}

pub fn runtime_hash(name: &str) -> Result<String> {
    let manifest: serde_json::Value =
        serde_json::from_str(include_str!("../../native/runtime-windows-x64.json"))?;
    manifest["components"]
        .as_array()
        .context("invalid runtime manifest")?
        .iter()
        .flat_map(|c| c["runtimeFiles"].as_array().into_iter().flatten())
        .find(|f| f["target"] == name)
        .and_then(|f| f["sha256"].as_str())
        .map(str::to_owned)
        .context("runtime is not in the pinned manifest")
}

pub fn check_local_file(path: &Path) -> Result<PathBuf> {
    ensure!(
        path.is_absolute() && path.is_file(),
        "select an existing absolute file path"
    );
    let path = path.canonicalize()?;
    ensure!(path.metadata()?.len() > 0, "file is empty");
    Ok(path)
}
pub async fn on_main<T: Send + 'static>(
    app: tauri::AppHandle,
    f: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(f());
    })?;
    rx.await.context("GUI thread unavailable")?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn startup_discovers_path_candidates_without_running_or_selecting_them() {
        let root = tempfile::tempdir().unwrap();
        let first = root.path().join("first");
        let second = root.path().join("second");
        for directory in [&first, &second] {
            std::fs::create_dir(directory).unwrap();
            std::fs::write(
                directory.join(surtitle_tools::ToolKind::Deno.executable()),
                b"not an executable",
            )
            .unwrap();
        }
        let path = std::env::join_paths([&first, &second, &first]).unwrap();
        let state = Services::open_with_tool_path(root.path().join("data"), &path).unwrap();
        let candidates = lock(&state.tool_candidates).unwrap();
        assert_eq!(candidates.len(), 2);
        assert!(
            candidates
                .iter()
                .all(|candidate| candidate.selectable && candidate.verification == "unverified")
        );
        assert!(candidates[0].path.starts_with(first.to_str().unwrap()));
        let preferences = lock(&state.preferences).unwrap();
        assert!(matches!(
            preferences.tools.deno,
            surtitle_tools::ToolSelection::Managed
        ));
        assert!(preferences.probes.is_empty());
        assert!(!state.root.join("preferences.json").exists());
    }
    #[test]
    fn another_process_cannot_recover_a_live_workers_ledger() {
        let temp = tempfile::tempdir().unwrap();
        let first = Services::open(temp.path().to_path_buf()).unwrap();
        assert!(Services::open(temp.path().to_path_buf()).is_err());
        drop(first);
        assert!(Services::open(temp.path().to_path_buf()).is_ok());
    }
}
