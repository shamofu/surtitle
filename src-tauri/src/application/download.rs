pub(crate) mod transfer;
use super::{AppState, err};
use crate::{application::library::ImportRequest, application::lock};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use surtitle_tools::CancellationToken;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadJobSnapshot {
    pub id: String,
    pub request: ImportRequest,
    pub status: String,
    pub phase: String,
    /// Actual currently stored bytes. For merged video/audio this is not a
    /// network-byte counter, so the UI must not label it bandwidth or ETA.
    pub stored_bytes: u64,
    pub total_bytes: Option<u64>,
    /// True only for exact transport lengths, never yt-dlp estimates/staging sizes.
    #[serde(default)]
    pub total_bytes_exact: bool,
    pub media_id: Option<String>,
    pub error: Option<String>,
    pub updated_at: String,
    /// New tool-backed jobs bind their immutable version/path/hash receipt.
    /// Missing historical metadata is retained as absent rather than invented.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_receipt_id: Option<String>,
}
pub struct DownloadJob {
    pub cancel: CancellationToken,
    snapshot: Mutex<DownloadJobSnapshot>,
}
impl DownloadJob {
    pub fn id(&self) -> Result<String> {
        Ok(lock(&self.snapshot)?.id.clone())
    }
    pub fn progress(&self, phase: &str, stored_bytes: u64, total_bytes: Option<u64>) -> Result<()> {
        self.progress_with_total_exact(phase, stored_bytes, total_bytes, false)
    }
    pub fn progress_with_total_exact(
        &self,
        phase: &str,
        stored_bytes: u64,
        total_bytes: Option<u64>,
        exact: bool,
    ) -> Result<()> {
        let mut snapshot = lock(&self.snapshot)?;
        snapshot.phase = phase.into();
        snapshot.stored_bytes = stored_bytes;
        snapshot.total_bytes = total_bytes;
        snapshot.total_bytes_exact = exact && total_bytes.is_some_and(|total| total > 0);
        snapshot.updated_at = surtitle_core::now();
        Ok(())
    }
}
pub struct DownloadManager {
    path: PathBuf,
    jobs: Mutex<HashMap<String, Arc<DownloadJob>>>,
    persistence: Mutex<()>,
}
impl DownloadManager {
    pub fn open(root: &Path) -> Result<Self> {
        let path = root.join("download-jobs.json");
        let mut saved: Vec<DownloadJobSnapshot> = if path.exists() {
            ensure!(
                path.metadata()?.len() <= 16 * 1024 * 1024,
                "download job history is too large"
            );
            serde_json::from_reader(std::fs::File::open(&path)?)?
        } else {
            vec![]
        };
        ensure!(saved.len() <= 1000, "too many download jobs");
        for snapshot in &mut saved {
            if matches!(snapshot.status.as_str(), "running" | "queued") {
                snapshot.status = "interrupted".into();
                snapshot.error = Some(
                    "The app closed before this download completed. Retry starts a new download."
                        .into(),
                );
            }
        }
        let media = root.join("media");
        std::fs::create_dir_all(&media)?;
        // Only abandoned app-created staging directories are reclaimed. Original
        // media and successful imports are never selected by this cleanup.
        for entry in std::fs::read_dir(&media)? {
            let entry = entry?;
            if entry
                .file_name()
                .to_string_lossy()
                .starts_with(".download-")
                && entry.file_type()?.is_dir()
                && !entry.path().symlink_metadata()?.file_type().is_symlink()
            {
                let target = entry.path().canonicalize()?;
                ensure!(
                    target.parent() == Some(media.canonicalize()?.as_path()),
                    "download staging escapes media directory"
                );
                std::fs::remove_dir_all(target)?;
            }
        }
        let jobs = saved
            .into_iter()
            .map(|s| {
                (
                    s.id.clone(),
                    Arc::new(DownloadJob {
                        snapshot: Mutex::new(s),
                        cancel: CancellationToken::new(),
                    }),
                )
            })
            .collect();
        let manager = Self {
            path,
            jobs: Mutex::new(jobs),
            persistence: Mutex::new(()),
        };
        manager.persist()?;
        Ok(manager)
    }
    pub fn list(&self) -> Result<Vec<DownloadJobSnapshot>> {
        let mut snapshots = lock(&self.jobs)?
            .values()
            .map(|job| Ok(lock(&job.snapshot)?.clone()))
            .collect::<Result<Vec<_>>>()?;
        snapshots.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(snapshots)
    }
    pub fn start(&self, request: ImportRequest) -> Result<(String, Arc<DownloadJob>)> {
        let id = surtitle_core::id();
        let job = Arc::new(DownloadJob {
            cancel: CancellationToken::new(),
            snapshot: Mutex::new(DownloadJobSnapshot {
                id: id.clone(),
                request,
                status: "running".into(),
                phase: "preparing".into(),
                stored_bytes: 0,
                total_bytes: None,
                total_bytes_exact: false,
                media_id: None,
                error: None,
                updated_at: surtitle_core::now(),
                tool_receipt_id: None,
            }),
        });
        {
            let mut jobs = lock(&self.jobs)?;
            ensure!(
                jobs.values()
                    .filter(|j| lock(&j.snapshot).is_ok_and(|s| s.status == "running"))
                    .count()
                    < 2,
                "At most two downloads can run at once"
            );
            if jobs.len() >= 1000 {
                let oldest = jobs
                    .iter()
                    .filter_map(|(id, j)| {
                        lock(&j.snapshot)
                            .ok()
                            .filter(|s| s.status != "running")
                            .map(|s| (id.clone(), s.updated_at.clone()))
                    })
                    .min_by(|a, b| a.1.cmp(&b.1))
                    .map(|(id, _)| id)
                    .context("download history is full")?;
                jobs.remove(&oldest);
            }
            jobs.insert(id.clone(), job.clone());
        }
        self.persist()?;
        Ok((id, job))
    }
    pub fn cancel(&self, id: &str) -> Result<()> {
        let job = lock(&self.jobs)?
            .get(id)
            .cloned()
            .context("download job not found")?;
        if lock(&job.snapshot)?.status == "running" {
            job.cancel.cancel();
        }
        Ok(())
    }
    pub fn bind_tool_receipt(&self, job: &DownloadJob, receipt_id: &str) -> Result<()> {
        ensure!(
            uuid::Uuid::parse_str(receipt_id).is_ok(),
            "Invalid tool receipt ID"
        );
        let id = lock(&job.snapshot)?.id.clone();
        let owned = lock(&self.jobs)?
            .get(&id)
            .cloned()
            .context("Download job not found")?;
        ensure!(
            std::ptr::eq(owned.as_ref(), job),
            "Tool receipt belongs to a different download"
        );
        {
            let mut snapshot = lock(&job.snapshot)?;
            ensure!(
                snapshot.status == "running" && snapshot.tool_receipt_id.is_none(),
                "Download already has a tool receipt or has ended"
            );
            snapshot.tool_receipt_id = Some(receipt_id.to_owned());
        }
        // Persist before extraction/download, so a crash retains the association.
        self.persist()
    }
    pub fn finish(&self, id: &str, result: Result<String>) -> Result<()> {
        let job = lock(&self.jobs)?
            .get(id)
            .cloned()
            .context("download job not found")?;
        {
            let mut snapshot = lock(&job.snapshot)?;
            match result {
                Ok(media_id) => {
                    snapshot.status = "completed".into();
                    snapshot.phase = "completed".into();
                    snapshot.media_id = Some(media_id);
                }
                Err(error) => {
                    snapshot.status = if job.cancel.is_cancelled() {
                        "cancelled"
                    } else {
                        "failed"
                    }
                    .into();
                    snapshot.error = Some(error.to_string());
                }
            }
            snapshot.updated_at = surtitle_core::now();
        }
        self.persist()
    }
    fn persist(&self) -> Result<()> {
        let _guard = lock(&self.persistence)?;
        surtitle_core::store::write_json_atomic(&self.path, &self.list()?)
    }
}

pub const MAX_DOWNLOAD_BYTES: u64 = 100 * 1024 * 1024 * 1024;
pub const DISK_RESERVE: u64 = 256 * 1024 * 1024;
pub fn check_capacity(free_bytes: u64, incoming_bytes: u64, stored_bytes: u64) -> Result<()> {
    ensure!(
        stored_bytes
            .checked_add(incoming_bytes)
            .is_some_and(|n| n <= MAX_DOWNLOAD_BYTES),
        "Download exceeds the 100 GiB storage limit"
    );
    ensure!(
        free_bytes >= incoming_bytes.saturating_add(DISK_RESERVE),
        "Not enough free disk space for this download"
    );
    Ok(())
}
pub fn stored_bytes(path: &Path) -> Result<u64> {
    let mut total = 0u64;
    for entry in std::fs::read_dir(path)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        ensure!(!kind.is_symlink(), "unexpected link in download staging");
        if kind.is_file() {
            total = total
                .checked_add(entry.metadata()?.len())
                .context("download size overflow")?;
        } else if kind.is_dir() {
            total = total
                .checked_add(stored_bytes(&entry.path())?)
                .context("download size overflow")?;
        }
    }
    Ok(total)
}

pub fn list_download_jobs(
    state: AppState,
) -> std::result::Result<Vec<DownloadJobSnapshot>, String> {
    state.downloads.list().map_err(err)
}
pub fn cancel_download(state: AppState, job_id: String) -> std::result::Result<(), String> {
    state.downloads.cancel(&job_id).map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_lengths_are_explicit_and_old_or_estimated_downloads_remain_indeterminate() {
        let root = tempfile::tempdir().unwrap();
        let manager = DownloadManager::open(root.path()).unwrap();
        let (_, job) = manager
            .start(ImportRequest {
                kind: "url".into(),
                path_or_url: "https://example.invalid/file.mp4".into(),
                title: None,
                learning_language: "en".into(),
                explanation_language: "ja".into(),
            })
            .unwrap();
        job.progress("downloading", 120, Some(100)).unwrap();
        assert!(!manager.list().unwrap()[0].total_bytes_exact);
        job.progress_with_total_exact("downloading", 50, Some(100), true)
            .unwrap();
        let snapshot = manager.list().unwrap().remove(0);
        assert!(snapshot.total_bytes_exact);
        let mut historical = serde_json::to_value(&snapshot).unwrap();
        historical
            .as_object_mut()
            .unwrap()
            .remove("totalBytesExact");
        assert!(
            !serde_json::from_value::<DownloadJobSnapshot>(historical)
                .unwrap()
                .total_bytes_exact
        );
        job.progress_with_total_exact("downloading", 50, None, true)
            .unwrap();
        assert!(!manager.list().unwrap()[0].total_bytes_exact);
        job.progress("importing", 50, Some(100)).unwrap();
        assert!(!manager.list().unwrap()[0].total_bytes_exact);
    }
    #[test]
    fn receipt_binding_persists_before_download_and_survives_interruption_without_backfill() {
        let root = tempfile::tempdir().unwrap();
        let manager = DownloadManager::open(root.path()).unwrap();
        let request = ImportRequest {
            kind: "url".into(),
            path_or_url: "https://www.youtube.com/watch?v=fixture".into(),
            title: None,
            learning_language: "en".into(),
            explanation_language: "ja".into(),
        };
        let (id, job) = manager.start(request.clone()).unwrap();
        let (direct_id, _) = manager
            .start(ImportRequest {
                path_or_url: "https://example.invalid/audio.wav".into(),
                ..request
            })
            .unwrap();
        let receipt_id = surtitle_core::id();
        manager.bind_tool_receipt(&job, &receipt_id).unwrap();
        assert!(
            manager
                .bind_tool_receipt(&job, &surtitle_core::id())
                .is_err()
        );
        let disk: serde_json::Value =
            serde_json::from_slice(&std::fs::read(root.path().join("download-jobs.json")).unwrap())
                .unwrap();
        assert_eq!(
            disk.as_array()
                .unwrap()
                .iter()
                .find(|row| row["id"] == id)
                .unwrap()["toolReceiptId"],
            receipt_id
        );
        assert!(
            disk.as_array()
                .unwrap()
                .iter()
                .find(|row| row["id"] == direct_id)
                .unwrap()
                .get("toolReceiptId")
                .is_none()
        );
        drop(manager);
        let reopened = DownloadManager::open(root.path()).unwrap();
        let rows = reopened.list().unwrap();
        let row = rows.iter().find(|row| row.id == id).unwrap();
        assert_eq!(row.status, "interrupted");
        assert_eq!(row.tool_receipt_id.as_deref(), Some(receipt_id.as_str()));
        assert!(
            rows.iter()
                .find(|row| row.id == direct_id)
                .unwrap()
                .tool_receipt_id
                .is_none()
        );
        assert!(reopened.bind_tool_receipt(&job, &receipt_id).is_err());
    }
    #[test]
    fn disk_and_size_limits_fail_before_writing() {
        assert!(check_capacity(DISK_RESERVE + 10, 10, 0).is_ok());
        assert!(check_capacity(DISK_RESERVE, 1, 0).is_err());
        assert!(check_capacity(u64::MAX, 1, MAX_DOWNLOAD_BYTES).is_err());
        assert!(check_capacity(u64::MAX, u64::MAX, 1).is_err());
    }
    #[test]
    fn interrupted_downloads_are_not_automatically_restarted_and_only_staging_is_cleaned() {
        let root = tempfile::tempdir().unwrap();
        let manager = DownloadManager::open(root.path()).unwrap();
        let request = ImportRequest {
            kind: "url".into(),
            path_or_url: "https://example.com/a.mp4".into(),
            title: None,
            learning_language: "en".into(),
            explanation_language: "ja".into(),
        };
        let (id, _) = manager.start(request).unwrap();
        let staging = root.path().join("media/.download-abandoned");
        std::fs::create_dir(&staging).unwrap();
        std::fs::write(staging.join("video.part"), b"partial").unwrap();
        let original = root.path().join("media/original.mp4");
        std::fs::write(&original, b"original").unwrap();
        drop(manager);
        let manager = DownloadManager::open(root.path()).unwrap();
        assert_eq!(
            manager
                .list()
                .unwrap()
                .iter()
                .find(|s| s.id == id)
                .unwrap()
                .status,
            "interrupted"
        );
        assert!(!staging.exists());
        assert!(original.exists());
    }
}
