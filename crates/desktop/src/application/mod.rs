pub(crate) mod cards;
pub(crate) mod changes;
pub(crate) mod continuations;
pub(crate) mod editor_drafts;
pub(crate) mod subtitles;
pub(crate) mod transfer;
pub(crate) mod ui_drafts;
// Application services and use cases. IPC adapters live in `crate::commands`.
pub(crate) mod ai;
pub(crate) mod library;
pub(crate) mod media_tools;
pub(crate) mod models;
pub(crate) mod operations;
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
    runtime: tokio::runtime::Handle,
    pub(crate) changes: changes::Changes,
    _instance_lock: std::fs::File,
    root: PathBuf,
    db: Mutex<Store>,
    workspace: Mutex<surtitle_core::workspace::WorkspaceStore>,
    preferences: PreferencesStore,
    playback: PlaybackCoordinator,
    restores: Mutex<HashMap<String, RestorePlan>>,
    ai: surtitle_ai::AiStore,
    tools: ToolRuntime,
    runtime_dir: Mutex<PathBuf>,
    ai_session: AiSession,
    operations: operations::OperationRegistry,
}
#[derive(Default)]
struct AiSession {
    runtime: ai::runtime::RuntimeRegistry,
    dispatch: ai::scheduler::DispatchQueue,
    preparation: Mutex<Option<PreparationCancellation>>,
    transcript_review: Mutex<()>,
}
#[derive(Clone)]
struct PreparationCancellation {
    id: String,
    local: Arc<std::sync::atomic::AtomicBool>,
    network: surtitle_tools::CancellationToken,
}
impl PreparationCancellation {
    fn cancel(&self) {
        self.local.store(true, std::sync::atomic::Ordering::Relaxed);
        self.network.cancel();
    }
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
    #[cfg(test)]
    pub(crate) fn test_operations(&self) -> operations::OperationRegistry {
        self.operations.clone()
    }

    #[cfg(test)]
    pub(crate) fn test_preparation_cancellation(
        &self,
        id: String,
    ) -> (
        Arc<std::sync::atomic::AtomicBool>,
        surtitle_tools::CancellationToken,
    ) {
        let local = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let network = surtitle_tools::CancellationToken::new();
        *self.ai_session.preparation.lock().unwrap() = Some(PreparationCancellation {
            id,
            local: local.clone(),
            network: network.clone(),
        });
        (local, network)
    }

    /// Production callers supply the desktop-owned executor explicitly.
    pub fn open_with_runtime(root: PathBuf, runtime: tokio::runtime::Handle) -> Result<AppState> {
        Self::open_with_tool_path_and_runtime(
            root,
            &std::env::var_os("PATH").unwrap_or_default(),
            runtime,
        )
    }

    #[cfg(test)]
    pub fn open(root: PathBuf) -> Result<AppState> {
        Self::open_with_tool_path(root, &std::env::var_os("PATH").unwrap_or_default())
    }
    #[cfg(test)]
    fn open_with_tool_path(root: PathBuf, tool_path: &std::ffi::OsStr) -> Result<AppState> {
        let runtime = tokio::runtime::Handle::try_current()
            .unwrap_or_else(|_| crate::runtime::test_runtime());
        Self::open_with_tool_path_and_runtime(root, tool_path, runtime)
    }
    fn open_with_tool_path_and_runtime(
        root: PathBuf,
        tool_path: &std::ffi::OsStr,
        runtime: tokio::runtime::Handle,
    ) -> Result<AppState> {
        std::fs::create_dir_all(&root)?;
        let instance_lock = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(root.join("instance.lock"))?;
        instance_lock.try_lock().context("Surtitle is already using this data directory. Close the other window before restarting.")?;
        crate::restore_snapshot::remove_abandoned(&root)?;
        for dir in ["card-audio", "backups", "prepared", "tools", "credentials"] {
            std::fs::create_dir_all(root.join(dir))?;
        }
        let preferences = PreferencesStore::open(root.join("preferences.json"))?;
        models::reconcile_credential_project(&preferences, &root)?;
        let db = Store::open(root.join("learning.sqlite"))?;
        let workspace =
            surtitle_core::workspace::WorkspaceStore::open(root.join("workspace.sqlite"))?;
        let ai = surtitle_ai::AiStore::open(root.join("charges.sqlite"))?;
        let tools = ToolRuntime::open(root.join("tools"), tool_path)?;
        let changes = changes::Changes::default();
        let operations = operations::OperationRegistry::with_changes(changes.clone());
        ai.recover_interrupted()?;
        let state = Arc::new(Self {
            runtime,
            changes,
            _instance_lock: instance_lock,
            root,
            db: Mutex::new(db),
            workspace: Mutex::new(workspace),
            preferences,
            playback: PlaybackCoordinator::default(),
            restores: Mutex::new(HashMap::new()),
            ai,
            tools,

            runtime_dir: Mutex::new(PathBuf::new()),
            ai_session: AiSession::default(),
            operations,
        });
        transcript::automatic::recover(&state)?;
        Ok(state)
    }
    pub fn settings(&self) -> Result<AppSettings> {
        let p = self.preferences.read()?;
        let mut settings = p.settings.clone();
        settings.credential_configured = p.credential_id.is_some();
        settings.openai.credential_configured = p.openai_credential_id.is_some();
        // JSON keeps the wire field; operational spending limits belong to the ledger.
        let budget = self.ai.budget()?;
        settings.daily_budget_usd = budget.daily_microusd as f64 / 1_000_000.;
        settings.monthly_budget_usd = Some(budget.monthly_microusd as f64 / 1_000_000.);
        settings.per_job_budget_usd = Some(budget.per_job_microusd as f64 / 1_000_000.);
        let openai_budget = self.ai.budget_for(surtitle_core::AiProvider::Openai)?;
        settings.openai.daily_budget_usd = openai_budget.daily_microusd as f64 / 1_000_000.;
        settings.openai.monthly_budget_usd = openai_budget.monthly_microusd as f64 / 1_000_000.;
        settings.openai.per_job_budget_usd = openai_budget.per_job_microusd as f64 / 1_000_000.;
        Ok(settings)
    }
    pub fn player_state(&self) -> Result<PlayerState> {
        self.playback_tick(false)
    }
    /// Pause on the GUI thread before a different screen can start card audio.
    pub(crate) fn pause_player(&self) -> Result<()> {
        self.playback.operation()?.control(&crate::player::Control {
            action: "pause".into(),
            value: None,
            start_ms: None,
            end_ms: None,
            bounds: None,
            track_kind: None,
        })
    }
    pub fn playback_tick(&self, persist: bool) -> Result<PlayerState> {
        self.playback.tick(&self.db, persist)
    }
    /// Apply native geometry synchronously during the owning GUI thread's prepaint.
    pub(crate) fn set_player_bounds(&self, bounds: crate::player::Bounds) -> Result<()> {
        self.playback.operation()?.control(&crate::player::Control {
            action: "bounds".into(),
            value: None,
            start_ms: None,
            end_ms: None,
            bounds: Some(bounds),
            track_kind: None,
        })
    }
    /// Hide the native child synchronously before painting a non-player screen.
    pub(crate) fn hide_player_surface(&self) -> Result<()> {
        self.playback.operation()?.control(&crate::player::Control {
            action: "hide".into(),
            value: None,
            start_ms: None,
            end_ms: None,
            bounds: None,
            track_kind: None,
        })
    }
    pub fn initialize_player(
        &self,
        resources: &Path,
        parent: isize,
        on_surface_click: impl Fn() + Send + Sync + 'static,
    ) -> Result<()> {
        *lock(&self.runtime_dir)? = resources.join("native");
        let volume = self.preferences.read()?.playback.volume;
        self.playback
            .install(
                crate::player::Player::new(resources, parent).and_then(|mut player| {
                    player.control(&crate::player::Control {
                        action: "volume".into(),
                        value: Some(volume),
                        start_ms: None,
                        end_ms: None,
                        bounds: None,
                        track_kind: None,
                    })?;
                    player.on_surface_click(on_surface_click)?;
                    Ok(player)
                }),
            )
    }
    pub fn shutdown(&self) {
        self.tools.shutdown.cancel();
        if let Ok(current) = lock(&self.ai_session.preparation)
            && let Some(preparation) = current.as_ref()
        {
            preparation.cancel();
        }
        let _ = self.playback.shutdown();
    }
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
    app: crate::runtime::DesktopHost,
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
    fn main_thread_result_and_dispatch_failures_reach_the_caller() {
        let runtime = crate::runtime::test_runtime();
        let host = crate::runtime::DesktopHost::new(
            runtime.clone(),
            |work| {
                work();
                Ok(())
            },
            |_| Ok(()),
            |_| {},
        );
        assert_eq!(
            runtime.block_on(on_main(host.clone(), || Ok(7))).unwrap(),
            7
        );
        let error = runtime
            .block_on(on_main(host, || -> Result<()> {
                anyhow::bail!("native failure")
            }))
            .unwrap_err();
        assert_eq!(error.to_string(), "native failure");
        let rejected = crate::runtime::DesktopHost::new(
            runtime.clone(),
            |_| anyhow::bail!("dispatcher closed"),
            |_| Ok(()),
            |_| {},
        );
        assert_eq!(
            runtime
                .block_on(on_main(rejected, || Ok(())))
                .unwrap_err()
                .to_string(),
            "dispatcher closed"
        );
    }

    #[test]
    fn disappearing_dispatcher_does_not_hang_an_application_operation() {
        let runtime = crate::runtime::test_runtime();
        let host =
            crate::runtime::DesktopHost::new(runtime.clone(), |_| Ok(()), |_| Ok(()), |_| {});
        assert_eq!(
            runtime
                .block_on(on_main(host, || Ok(())))
                .unwrap_err()
                .to_string(),
            "GUI thread unavailable"
        );
    }

    #[test]
    fn service_shutdown_cancels_active_preparation_and_tools() {
        let root = tempfile::tempdir().unwrap();
        let state = Services::open(root.path().to_path_buf()).unwrap();
        let cancel = PreparationCancellation {
            id: "active-preparation".into(),
            local: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            network: surtitle_tools::CancellationToken::new(),
        };
        *lock(&state.ai_session.preparation).unwrap() = Some(cancel.clone());
        state.shutdown();
        state.shutdown();
        assert!(state.tools.shutdown.is_cancelled());
        assert!(cancel.network.is_cancelled());
        assert!(cancel.local.load(std::sync::atomic::Ordering::Relaxed));
    }
    #[test]
    fn startup_discovers_path_candidates_without_running_or_selecting_them() {
        let root = tempfile::tempdir().unwrap();
        let first = root.path().join("first");
        let second = root.path().join("second");
        for directory in [&first, &second] {
            std::fs::create_dir(directory).unwrap();
            std::fs::write(
                directory.join(surtitle_tools::ToolKind::FfmpegPair.executable()),
                b"not an executable",
            )
            .unwrap();
            std::fs::write(
                directory.join(if cfg!(windows) {
                    "ffprobe.exe"
                } else {
                    "ffprobe"
                }),
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
            preferences.tools.ffmpeg,
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
