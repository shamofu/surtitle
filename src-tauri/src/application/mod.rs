pub(crate) mod cards;
pub(crate) mod continuations;
pub(crate) mod editor_drafts;
pub(crate) mod subtitles;
pub(crate) mod transfer;
// Application services and use cases. IPC adapters live in `crate::commands`.
pub(crate) mod ai;
pub(crate) mod download;
pub(crate) mod library;
pub(crate) mod media_tools;
pub(crate) mod models;
pub(crate) mod tool_updates;
pub(crate) mod transcript;
use crate::player::PlayerState;
pub(crate) mod playback;
use playback::PlaybackCoordinator;
pub(crate) mod tool_runtime;
use anyhow::{Context, Result, ensure};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
};
use surtitle_core::{AppSettings, Store};
use tool_runtime::ToolRuntime;
mod preferences;
pub(crate) use preferences::{Preferences, PreferencesStore, QuoteContext, UpdateCheck};

pub type AppState = Arc<Services>;
pub struct Services {
    _instance_lock: std::fs::File,
    root: PathBuf,
    db: Mutex<Store>,
    preferences: PreferencesStore,
    playback: PlaybackCoordinator,
    restores: Mutex<HashMap<String, RestorePlan>>,
    ai: surtitle_ai::AiStore,
    tools: ToolRuntime,
    runtime_dir: Mutex<PathBuf>,
    ai_session: AiSession,
    downloads: download::DownloadManager,
}
#[derive(Default)]
struct AiSession {
    preparation: Mutex<Option<Arc<std::sync::atomic::AtomicBool>>>,
    transcript_review: Mutex<()>,
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
        let preferences = PreferencesStore::open(root.join("preferences.json"))?;
        models::reconcile_credential_project(&preferences, &root)?;
        let db = Store::open(root.join("learning.sqlite"))?;
        let ai = surtitle_ai::AiStore::open(root.join("charges.sqlite"))?;
        let tools = ToolRuntime::open(root.join("tools"), tool_path)?;
        let downloads = download::DownloadManager::open(&root)?;
        ai.recover_interrupted()?;
        let state = Arc::new(Self {
            _instance_lock: instance_lock,
            root,
            db: Mutex::new(db),
            preferences,
            playback: PlaybackCoordinator::default(),
            restores: Mutex::new(HashMap::new()),
            ai,
            tools,

            runtime_dir: Mutex::new(PathBuf::new()),
            ai_session: AiSession::default(),
            downloads,
        });
        transcript::automatic::recover(&state)?;
        Ok(state)
    }
    pub fn settings(&self) -> Result<AppSettings> {
        let p = self.preferences.read()?;
        let mut settings = p.settings.clone();
        settings.credential_configured = p.credential_id.is_some();
        // JSON keeps the wire field; operational spending limits belong to the ledger.
        let budget = self.ai.budget()?;
        settings.daily_budget_usd = budget.daily_microusd as f64 / 1_000_000.;
        settings.monthly_budget_usd = Some(budget.monthly_microusd as f64 / 1_000_000.);
        settings.per_job_budget_usd = Some(budget.per_job_microusd as f64 / 1_000_000.);
        Ok(settings)
    }
    pub fn player_state(&self) -> Result<PlayerState> {
        self.playback_tick(false)
    }
    pub fn playback_tick(&self, persist: bool) -> Result<PlayerState> {
        self.playback.tick(&self.db, persist)
    }
    pub fn initialize_player(&self, resources: &Path, parent: isize) -> Result<()> {
        *lock(&self.runtime_dir)? = resources.join("native");
        self.playback
            .install(crate::player::Player::new(resources, parent))
    }
    pub fn shutdown(&self) {
        self.tools.shutdown.cancel();
        let _ = self.playback.shutdown();
    }
}

pub fn runtime_hash(name: &str) -> Result<String> {
    let manifest: serde_json::Value =
        serde_json::from_str(include_str!("../../../native/runtime-windows-x64.json"))?;
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
        let candidates = lock(&state.tools.candidates).unwrap();
        assert_eq!(candidates.len(), 2);
        assert!(
            candidates
                .iter()
                .all(|candidate| candidate.selectable && candidate.verification == "unverified")
        );
        assert!(candidates[0].path.starts_with(first.to_str().unwrap()));
        let preferences = state.preferences.test_value().unwrap();
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
