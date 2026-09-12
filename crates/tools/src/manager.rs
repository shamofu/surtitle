use crate::{
    CancellationToken, ProbeReport, ResolvedTool, ToolKind, ToolSelection, ToolSelections,
    ToolSnapshot, ToolSource, YtDlpChannel, probe, resolve_external, sha256_file,
    upstream::{self, DownloadProgress, ReleaseCandidate, Verification},
};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstalledTool {
    pub kind: ToolKind,
    pub version: String,
    pub channel: String,
    pub install_id: String,
    pub provider: String,
    pub source_page: String,
    pub declared_license: String,
    pub verification: Verification,
    pub archive_sha256: String,
    pub installed_unix: u64,
    pub probe: ProbeReport,
    pub executable_relative: PathBuf,
    pub companion_relative: Option<PathBuf>,
    /// Hashes of executables, separate from the archive transport checksum.
    pub files: BTreeMap<PathBuf, String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateOutcome {
    pub changed: bool,
    pub installed: InstalledTool,
}
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct ManagedState {
    active: Option<InstalledTool>,
    previous: Option<InstalledTool>,
}
struct Inner {
    root: PathBuf,
    client: reqwest::Client,
    updates: tokio::sync::Mutex<()>,
    jobs: AtomicUsize,
}
#[derive(Clone)]
pub struct ToolManager {
    inner: Arc<Inner>,
}

/// Holds a shared storage lease until dropped. Old managed versions remain
/// available across an update/rollback, and cleanup cannot remove them.
pub struct JobLease {
    pub tools: Vec<ToolSnapshot>,
    _storage_lock: File,
    inner: Arc<Inner>,
}
impl JobLease {
    pub fn get(&self, kind: ToolKind) -> Result<&ToolSnapshot> {
        self.tools
            .iter()
            .find(|s| s.tool.kind == kind)
            .context("job did not lease this tool")
    }
    pub fn verify(&self) -> Result<()> {
        for tool in &self.tools {
            tool.verify()?;
        }
        Ok(())
    }
}
impl Drop for JobLease {
    fn drop(&mut self) {
        self.inner.jobs.fetch_sub(1, Ordering::SeqCst);
    }
}

impl ToolManager {
    /// `root` must be the app's own data directory, never a PATH installation.
    pub fn new(root: impl AsRef<Path>) -> Result<Self> {
        fs::create_dir_all(root.as_ref()).context("cannot create managed tool storage")?;
        let root = fs::canonicalize(root.as_ref())?;
        Ok(Self {
            inner: Arc::new(Inner {
                root,
                client: upstream::client()?,
                updates: tokio::sync::Mutex::new(()),
                jobs: AtomicUsize::new(0),
            }),
        })
    }
    pub fn root(&self) -> &Path {
        &self.inner.root
    }
    pub fn active_jobs(&self) -> usize {
        self.inner.jobs.load(Ordering::SeqCst)
    }
    pub fn installed(&self, kind: ToolKind) -> Result<Option<InstalledTool>> {
        Ok(self.read_state(kind)?.active)
    }
    /// Metadata-only availability hint; rollback itself rechecks file hashes.
    pub fn can_rollback(&self, kind: ToolKind) -> bool {
        let path = self.root().join(kind.directory()).join("state.json");
        if !path.is_file()
            || self.contained_existing(&path).is_err()
            || fs::metadata(&path).map_or(true, |m| m.len() > 1024 * 1024)
        {
            return false;
        }
        fs::read(path)
            .ok()
            .and_then(|data| serde_json::from_slice::<ManagedState>(&data).ok())
            .is_some_and(|state| state.previous.is_some_and(|tool| tool.kind == kind))
    }
    pub fn resolve_selection(
        &self,
        kind: ToolKind,
        selection: &ToolSelection,
    ) -> Result<ToolSnapshot> {
        match selection {
            ToolSelection::External { path } => {
                ToolSnapshot::capture(resolve_external(kind, path)?)
            }
            ToolSelection::Managed => self.snapshot(
                &self
                    .read_state(kind)?
                    .active
                    .context("managed tool is not installed; prepare this feature first")?,
            ),
        }
    }
    pub fn begin_job(&self, selections: &ToolSelections) -> Result<JobLease> {
        self.lease_tools(&[
            (ToolKind::FfmpegPair, selections.ffmpeg.clone()),
            (ToolKind::YtDlp, selections.yt_dlp.clone()),
            (ToolKind::Deno, selections.deno.clone()),
        ])
    }
    /// Local-media jobs can lease FFmpeg alone without requiring URL tools.
    pub fn lease_tools(&self, selections: &[(ToolKind, ToolSelection)]) -> Result<JobLease> {
        let lock = self.open_lock("leases.lock")?;
        lock.lock_shared()?;
        let mut kinds = HashSet::new();
        let mut tools = Vec::new();
        for (kind, selection) in selections {
            ensure!(kinds.insert(*kind), "duplicate tool in job lease");
            tools.push(self.resolve_selection(*kind, selection)?);
        }
        self.inner.jobs.fetch_add(1, Ordering::SeqCst);
        Ok(JobLease {
            tools,
            _storage_lock: lock,
            inner: self.inner.clone(),
        })
    }
    pub async fn check_latest(
        &self,
        kind: ToolKind,
        channel: YtDlpChannel,
        cancel: &CancellationToken,
    ) -> Result<ReleaseCandidate> {
        upstream::latest(&self.inner.client, kind, channel, cancel).await
    }
    /// Always resolves the current upstream channel. No app catalog or fixed
    /// yt-dlp/Deno version pair is consulted. Writes only managed storage.
    pub async fn update(
        &self,
        kind: ToolKind,
        channel: YtDlpChannel,
        cancel: &CancellationToken,
    ) -> Result<UpdateOutcome> {
        self.update_with_progress(kind, channel, cancel, None).await
    }
    pub async fn update_with_progress(
        &self,
        kind: ToolKind,
        channel: YtDlpChannel,
        cancel: &CancellationToken,
        progress: Option<&tokio::sync::mpsc::UnboundedSender<DownloadProgress>>,
    ) -> Result<UpdateOutcome> {
        let _serial = tokio::select! { _ = cancel.cancelled() => anyhow::bail!("operation cancelled"), lock = self.inner.updates.lock() => lock };
        let candidate = self.check_latest(kind, channel, cancel).await?;
        if let Some(active) = self.installed(kind)?
            && active.version == candidate.version
            && active.channel == candidate.channel
            && self.snapshot(&active).is_ok()
        {
            return Ok(UpdateOutcome {
                changed: false,
                installed: active,
            });
        }
        let staging_parent = self.managed_dir("staging")?;
        let staging = tempfile::Builder::new()
            .prefix("incoming-")
            .tempdir_in(staging_parent)?;
        let archive = staging.path().join("download.package");
        let receipt =
            upstream::download(&self.inner.client, &candidate, &archive, cancel, progress).await?;
        ensure!(!cancel.is_cancelled(), "operation cancelled");
        let payload = staging.path().join("payload");
        fs::create_dir(&payload)?;
        let (executable_relative, companion_relative) = unpack(&archive, &payload, kind)?;
        ensure!(!cancel.is_cancelled(), "operation cancelled");
        let mut tool = resolve_external(kind, &payload.join(&executable_relative))?;
        tool.source = ToolSource::Managed;
        let snapshot = ToolSnapshot::capture(tool)?;
        let report = probe(&snapshot, cancel).await.context(
            "downloaded tool failed its capability probe; previous version remains active",
        )?;
        let mut files = BTreeMap::new();
        files.insert(
            executable_relative.clone(),
            snapshot.executable_sha256.clone(),
        );
        if let (Some(path), Some(hash)) = (&companion_relative, &snapshot.ffprobe_sha256) {
            files.insert(path.clone(), hash.clone());
        }
        let installed = InstalledTool {
            kind,
            version: candidate.version,
            channel: candidate.channel,
            install_id: receipt.sha256.clone(),
            provider: candidate.provider,
            source_page: candidate.source_page,
            declared_license: candidate.declared_license,
            verification: receipt.verification,
            archive_sha256: receipt.sha256,
            installed_unix: SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs(),
            probe: report,
            executable_relative,
            companion_relative,
            files,
        };
        // The package's own notices remain in payload; this receipt distinguishes
        // direct third-party downloads from files built or redistributed by us.
        atomic_json(&payload.join("surtitle-receipt.json"), &installed)?;
        let _lock = self.write_lock()?;
        ensure!(!cancel.is_cancelled(), "operation cancelled");
        let versions = self.managed_dir(&format!("{}/versions", kind.directory()))?;
        let final_dir = versions.join(&installed.install_id);
        if final_dir.exists() {
            self.snapshot(&installed)?;
        } else {
            fs::rename(&payload, &final_dir).context("cannot install staged tool")?;
        }
        let installed = self.activate(installed)?;
        Ok(UpdateOutcome {
            changed: true,
            installed,
        })
    }
    /// Switch only the managed pointer. Already-running jobs keep their leased
    /// executable paths. External selections are neither inspected nor changed.
    pub fn rollback(&self, kind: ToolKind) -> Result<InstalledTool> {
        let _lock = self.write_lock()?;
        let mut state = self.read_state(kind)?;
        let previous = state
            .previous
            .take()
            .context("no previous managed version is available")?;
        self.snapshot(&previous)?;
        state.previous = state.active.take();
        state.active = Some(previous.clone());
        self.write_state(kind, &state)?;
        Ok(previous)
    }
    /// Explicit cleanup keeps active + previous. Refuses while any process has a
    /// managed-storage lease; checks canonical containment before every removal.
    pub fn prune_unused(&self, kind: ToolKind) -> Result<usize> {
        let _write = self.write_lock()?;
        let leases = self.open_lock("leases.lock")?;
        leases
            .try_lock()
            .context("tools are in use; try cleanup after jobs finish")?;
        let state = self.read_state(kind)?;
        let keep: HashSet<_> = [state.active, state.previous]
            .into_iter()
            .flatten()
            .map(|i| i.install_id)
            .collect();
        let versions = self.managed_dir(&format!("{}/versions", kind.directory()))?;
        let mut removed = 0;
        for entry in fs::read_dir(&versions)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if keep.contains(&name) || !is_hash(&name) {
                continue;
            }
            let target = self.contained_existing(&entry.path())?;
            ensure!(
                target.parent() == Some(versions.as_path()),
                "cleanup target is outside its version directory"
            );
            fs::remove_dir_all(target)?;
            removed += 1;
        }
        Ok(removed)
    }
    fn activate(&self, installed: InstalledTool) -> Result<InstalledTool> {
        self.snapshot(&installed)?;
        let mut state = self.read_state(installed.kind)?;
        if state
            .active
            .as_ref()
            .is_none_or(|s| s.install_id != installed.install_id)
        {
            state.previous = state.active.take();
        }
        state.active = Some(installed.clone());
        self.write_state(installed.kind, &state)?;
        Ok(installed)
    }
    fn snapshot(&self, installed: &InstalledTool) -> Result<ToolSnapshot> {
        ensure!(
            is_hash(&installed.install_id),
            "invalid managed installation ID"
        );
        let base = self.contained_existing(
            &self
                .root()
                .join(installed.kind.directory())
                .join("versions")
                .join(&installed.install_id),
        )?;
        let resolve = |relative: &Path| -> Result<PathBuf> {
            safe_relative(relative)?;
            let path = self.contained_existing(&base.join(relative))?;
            ensure!(path.starts_with(&base), "managed file escapes installation");
            let expected = installed
                .files
                .get(relative)
                .context("managed file hash is missing")?;
            ensure!(
                &sha256_file(&path)? == expected,
                "managed executable has changed; reinstall or roll back"
            );
            Ok(path)
        };
        let executable = resolve(&installed.executable_relative)?;
        let ffprobe = installed
            .companion_relative
            .as_deref()
            .map(resolve)
            .transpose()?;
        ensure!(
            (installed.kind == ToolKind::FfmpegPair) == ffprobe.is_some(),
            "invalid managed FFmpeg companion"
        );
        Ok(ToolSnapshot {
            executable_sha256: installed.files[&installed.executable_relative].clone(),
            ffprobe_sha256: installed
                .companion_relative
                .as_ref()
                .map(|p| installed.files[p].clone()),
            probe: None,
            tool: ResolvedTool {
                kind: installed.kind,
                source: ToolSource::Managed,
                selected_path: executable.clone(),
                executable,
                ffprobe,
            },
        })
    }
    fn managed_dir(&self, relative: &str) -> Result<PathBuf> {
        let relative = Path::new(relative);
        safe_relative(relative)?;
        // Check every existing prefix before create_dir_all to avoid following a
        // replaced directory junction into an external tool installation.
        let mut path = self.root().to_owned();
        for component in relative.components() {
            path.push(component);
            if path.exists() {
                self.contained_existing(&path)?;
            } else {
                fs::create_dir(&path)?;
            }
        }
        self.contained_existing(&path)
    }
    fn contained_existing(&self, path: &Path) -> Result<PathBuf> {
        let resolved = fs::canonicalize(path)?;
        ensure!(
            resolved.starts_with(self.root()) && resolved != self.root(),
            "managed path escapes application storage"
        );
        Ok(resolved)
    }
    fn open_lock(&self, name: &str) -> Result<File> {
        let path = self.root().join(name);
        if path.exists() {
            self.contained_existing(&path)?;
        }
        Ok(OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)?)
    }
    fn write_lock(&self) -> Result<File> {
        let file = self.open_lock("write.lock")?;
        file.lock()?;
        Ok(file)
    }
    fn state_path(&self, kind: ToolKind) -> Result<PathBuf> {
        Ok(self.managed_dir(kind.directory())?.join("state.json"))
    }
    fn read_state(&self, kind: ToolKind) -> Result<ManagedState> {
        let path = self.state_path(kind)?;
        if !path.exists() {
            return Ok(ManagedState::default());
        }
        self.contained_existing(&path)?;
        ensure!(
            fs::metadata(&path)?.len() <= 1024 * 1024,
            "managed state exceeds size limit"
        );
        let state: ManagedState =
            serde_json::from_slice(&fs::read(path)?).context("managed tool state is corrupt")?;
        ensure!(
            [&state.active, &state.previous]
                .into_iter()
                .flatten()
                .all(|tool| tool.kind == kind),
            "managed state has incorrect tool kind"
        );
        Ok(state)
    }
    fn write_state(&self, kind: ToolKind, state: &ManagedState) -> Result<()> {
        atomic_json(&self.state_path(kind)?, state)
    }
}
fn atomic_json(path: &Path, data: &impl Serialize) -> Result<()> {
    let mut temporary =
        tempfile::NamedTempFile::new_in(path.parent().context("JSON file needs parent")?)?;
    serde_json::to_writer_pretty(&mut temporary, data)?;
    temporary.write_all(b"\n")?;
    temporary.as_file().sync_all()?;
    temporary
        .persist(path)
        .map_err(|e| e.error)
        .context("cannot atomically replace managed state")?;
    Ok(())
}
fn is_hash(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|c| c.is_ascii_hexdigit())
}
fn safe_relative(path: &Path) -> Result<()> {
    ensure!(
        !path.as_os_str().is_empty()
            && path.components().all(|c| matches!(c, Component::Normal(_))),
        "unsafe package-relative path"
    );
    ensure!(
        !path.to_string_lossy().contains([':', '\0']),
        "unsafe package path"
    );
    Ok(())
}
fn unpack(archive: &Path, output: &Path, kind: ToolKind) -> Result<(PathBuf, Option<PathBuf>)> {
    if kind == ToolKind::YtDlp {
        let relative = PathBuf::from(kind.executable());
        fs::copy(archive, output.join(&relative))?;
        return Ok((relative, None));
    }
    let mut zip = zip::ZipArchive::new(File::open(archive)?).context("invalid tool ZIP package")?;
    ensure!(zip.len() <= 5000, "too many package entries");
    let mut total = 0u64;
    let mut executable = None;
    let mut companion = None;
    let mut seen = HashSet::new();
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index)?;
        ensure!(
            !entry.name().contains(['\\', ':']),
            "unsafe ZIP member path"
        );
        let relative = entry.enclosed_name().context("ZIP entry escapes package")?;
        safe_relative(&relative)?;
        ensure!(
            entry
                .unix_mode()
                .is_none_or(|mode| mode & 0o170000 != 0o120000),
            "ZIP symbolic links are unsupported"
        );
        let key = relative.to_string_lossy().to_lowercase();
        ensure!(seen.insert(key), "duplicate ZIP member");
        total = total
            .checked_add(entry.size())
            .context("ZIP size overflow")?;
        ensure!(
            total <= 1024 * 1024 * 1024,
            "uncompressed package exceeds 1 GiB"
        );
        let destination = output.join(&relative);
        if entry.is_dir() {
            fs::create_dir_all(destination)?;
            continue;
        }
        fs::create_dir_all(destination.parent().context("ZIP member has no parent")?)?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&destination)?;
        let copied = std::io::copy(&mut entry.by_ref().take(512 * 1024 * 1024 + 1), &mut file)?;
        ensure!(
            copied <= 512 * 1024 * 1024 && copied == entry.size(),
            "invalid ZIP member size"
        );
        file.sync_all()?;
        let name = relative.file_name().and_then(|s| s.to_str()).unwrap_or("");
        if name.eq_ignore_ascii_case(kind.executable()) {
            ensure!(executable.is_none(), "multiple tool executables in package");
            executable = Some(relative.clone());
        }
        if kind == ToolKind::FfmpegPair
            && name.eq_ignore_ascii_case(if cfg!(windows) {
                "ffprobe.exe"
            } else {
                "ffprobe"
            })
        {
            ensure!(companion.is_none(), "multiple ffprobe executables");
            companion = Some(relative);
        }
    }
    let executable = executable.context("package lacks the expected executable")?;
    if kind == ToolKind::FfmpegPair {
        ensure!(
            companion
                .as_ref()
                .is_some_and(|p| p.parent() == executable.parent()),
            "FFmpeg package lacks matching ffprobe"
        );
    }
    Ok((executable, companion))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::Digest;
    #[test]
    fn external_selection_is_never_managed_update_target() {
        let storage = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let file = outside.path().join(ToolKind::Deno.executable());
        fs::write(&file, b"external").unwrap();
        let manager = ToolManager::new(storage.path()).unwrap();
        let lease = manager
            .lease_tools(&[(
                ToolKind::Deno,
                ToolSelection::External { path: file.clone() },
            )])
            .unwrap();
        assert_eq!(
            lease.get(ToolKind::Deno).unwrap().tool.source,
            ToolSource::External
        );
        assert_eq!(manager.active_jobs(), 1);
        assert!(manager.rollback(ToolKind::Deno).is_err());
        assert_eq!(fs::read(&file).unwrap(), b"external");
        assert!(manager.prune_unused(ToolKind::Deno).is_err());
        drop(lease);
        assert_eq!(manager.active_jobs(), 0);
        manager.prune_unused(ToolKind::Deno).unwrap();
        assert_eq!(fs::read(file).unwrap(), b"external");
    }
    #[test]
    fn relative_paths_reject_traversal_and_drive_paths() {
        for value in [
            "../outside",
            "a/../../x",
            "/absolute",
            "C:/outside",
            "x:stream",
            "",
        ] {
            assert!(safe_relative(Path::new(value)).is_err(), "{value}");
        }
    }
    #[test]
    fn corrupted_managed_state_does_not_fallback_to_path() {
        let storage = tempfile::tempdir().unwrap();
        let manager = ToolManager::new(storage.path()).unwrap();
        fs::write(manager.state_path(ToolKind::Deno).unwrap(), b"{broken}").unwrap();
        assert!(
            manager
                .resolve_selection(ToolKind::Deno, &ToolSelection::Managed)
                .is_err()
        );
    }
    #[test]
    fn unzip_rejects_escape_before_writing_outside() {
        use zip::write::SimpleFileOptions;
        let storage = tempfile::tempdir().unwrap();
        let archive = storage.path().join("evil.zip");
        let output = storage.path().join("payload");
        fs::create_dir(&output).unwrap();
        let mut zip = zip::ZipWriter::new(File::create(&archive).unwrap());
        zip.start_file("../escape", SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"evil").unwrap();
        zip.finish().unwrap();
        assert!(unpack(&archive, &output, ToolKind::Deno).is_err());
        assert!(!storage.path().join("escape").exists());
    }
    fn seed(manager: &ToolManager, byte: u8) -> InstalledTool {
        let id = format!("{:x}", sha2::Sha256::digest([byte]));
        let base = manager.managed_dir(&format!("deno/versions/{id}")).unwrap();
        let relative = PathBuf::from(ToolKind::Deno.executable());
        fs::write(base.join(&relative), [byte]).unwrap();
        InstalledTool {
            kind: ToolKind::Deno,
            version: format!("test-{byte}"),
            channel: "test".into(),
            install_id: id.clone(),
            provider: "test fixture".into(),
            source_page: "test".into(),
            declared_license: "test".into(),
            verification: Verification::HttpsSha256 {
                origin: "test".into(),
            },
            archive_sha256: id.clone(),
            installed_unix: 0,
            probe: ProbeReport {
                kind: ToolKind::Deno,
                version: "fixture".into(),
                companion_version: None,
                capabilities: vec![],
                diagnostics: vec![],
            },
            executable_relative: relative.clone(),
            companion_relative: None,
            files: BTreeMap::from([(relative, id)]),
        }
    }
    #[test]
    fn activation_rollback_and_leases_keep_old_files() {
        let storage = tempfile::tempdir().unwrap();
        let manager = ToolManager::new(storage.path()).unwrap();
        let first = seed(&manager, 1);
        manager.activate(first.clone()).unwrap();
        let lease = manager
            .lease_tools(&[(ToolKind::Deno, ToolSelection::Managed)])
            .unwrap();
        let old_path = lease.get(ToolKind::Deno).unwrap().tool.executable.clone();
        let second = seed(&manager, 2);
        manager.activate(second.clone()).unwrap();
        lease.verify().unwrap();
        assert_eq!(
            manager.installed(ToolKind::Deno).unwrap().unwrap().version,
            second.version
        );
        assert_eq!(
            manager.rollback(ToolKind::Deno).unwrap().version,
            first.version
        );
        lease.verify().unwrap();
        seed(&manager, 3);
        assert!(manager.prune_unused(ToolKind::Deno).is_err());
        drop(lease);
        assert_eq!(manager.prune_unused(ToolKind::Deno).unwrap(), 1);
        assert!(old_path.is_file());
    }
    #[test]
    fn invalid_activation_preserves_active_version() {
        let storage = tempfile::tempdir().unwrap();
        let manager = ToolManager::new(storage.path()).unwrap();
        let first = seed(&manager, 1);
        manager.activate(first.clone()).unwrap();
        let mut broken = seed(&manager, 2);
        broken
            .files
            .insert(broken.executable_relative.clone(), "0".repeat(64));
        assert!(manager.activate(broken).is_err());
        assert_eq!(
            manager.installed(ToolKind::Deno).unwrap().unwrap().version,
            first.version
        );
    }
    #[tokio::test]
    #[ignore = "explicit live-upstream integration: downloads and executes official Windows tools in temporary app-owned storage"]
    async fn live_rolling_update() {
        let kind = match std::env::var("SURTITLE_TEST_UPDATE").as_deref() {
            Ok("ffmpeg") => ToolKind::FfmpegPair,
            Ok("deno") => ToolKind::Deno,
            Ok("yt-dlp") => ToolKind::YtDlp,
            _ => panic!("set SURTITLE_TEST_UPDATE=ffmpeg|deno|yt-dlp"),
        };
        let storage = tempfile::tempdir().unwrap();
        let manager = ToolManager::new(storage.path()).unwrap();
        let cancel = CancellationToken::new();
        let result = manager
            .update(kind, YtDlpChannel::Nightly, &cancel)
            .await
            .unwrap();
        assert!(result.changed);
        let snapshot = manager
            .resolve_selection(kind, &ToolSelection::Managed)
            .unwrap();
        probe(&snapshot, &cancel).await.unwrap();
        assert!(
            !manager
                .update(kind, YtDlpChannel::Nightly, &cancel)
                .await
                .unwrap()
                .changed
        );
    }
}
