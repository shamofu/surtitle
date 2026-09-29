//! Isolated validation roots, lifetime ledger locking, and immutable manifests.
use super::files::{absolute, read_document, reject_link, write_json_new};
use super::preparation::settings_digest;
use super::{FORMAT, Result, ai_error};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use surtitle_ai::{AiStore, BudgetLimits, CredentialVault, PreparedJob};

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Marker {
    pub(super) format: String,
    pub(super) schema_version: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Manifest {
    pub(super) schema_version: u32,
    pub(super) job_id: String,
    pub(super) case_id: String,
    pub(super) plan_digest: String,
    pub(super) prepared: PreparedJob,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) max_audio_seconds: Option<u32>,
}

pub(super) struct Context {
    pub(super) root: PathBuf,
    pub(super) store: AiStore,
    pub(super) vault: CredentialVault,
    pub(super) _lock: fs::File,
}

impl Context {
    pub(super) fn open(root: &Path) -> Result<Self> {
        absolute(root)?;
        reject_link(root)?;
        let marker: Marker = read_document(&root.join("validation-root.json"))?;
        if marker.format != FORMAT || marker.schema_version != 2 {
            return Err("This directory is not an isolated validation root".into());
        }
        let root = root
            .canonicalize()
            .map_err(|_| "Validation root is unavailable")?;
        for name in [
            "charges.sqlite",
            "credentials",
            "manifests",
            "inputs",
            "instance.lock",
        ] {
            reject_link(&root.join(name))?;
        }
        let lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(root.join("instance.lock"))
            .map_err(|_| "Cannot open validation instance lock")?;
        lock.try_lock()
            .map_err(|_| "Another validation command is using this data root")?;
        let store = AiStore::open(root.join("charges.sqlite")).map_err(ai_error)?;
        store.validation_totals().map_err(ai_error)?;
        store.recover_interrupted().map_err(ai_error)?;
        let vault = CredentialVault::new(root.join("credentials")).map_err(ai_error)?;
        Ok(Self {
            root,
            store,
            vault,
            _lock: lock,
        })
    }

    pub(super) fn manifest(&self, job_id: &str) -> Result<Manifest> {
        let manifest = read_manifest(&manifest_path(&self.root, job_id)?)?;
        if manifest.job_id != job_id
            || manifest.prepared != self.store.prepared_job(job_id).map_err(ai_error)?
        {
            return Err(
                "The reviewed manifest differs from the immutable ledger preparation".into(),
            );
        }
        Ok(manifest)
    }
}

pub(super) fn initialize(root: &Path, total: u64, limits: BudgetLimits) -> Result<()> {
    absolute(root)?;
    if root.exists() {
        return Err(
            "Initialization requires a new directory; existing totals are never reset".into(),
        );
    }
    fs::create_dir(root).map_err(|_| "Cannot create validation root; its parent must exist")?;
    let lock = fs::OpenOptions::new()
        .write(true)
        .read(true)
        .create_new(true)
        .open(root.join("instance.lock"))
        .map_err(|_| "Cannot create instance lock")?;
    lock.try_lock().map_err(|_| "Cannot lock validation root")?;
    for directory in ["credentials", "manifests", "inputs"] {
        fs::create_dir(root.join(directory)).map_err(|_| "Cannot create validation directory")?;
    }
    let store = AiStore::open(root.join("charges.sqlite")).map_err(ai_error)?;
    store.initialize_validation_total(total).map_err(ai_error)?;
    store.set_budget(limits).map_err(ai_error)?;
    write_json_new(
        &root.join("validation-root.json"),
        &Marker {
            format: FORMAT.into(),
            schema_version: 2,
        },
    )?;
    Ok(())
}

pub(super) fn read_manifest(path: &Path) -> Result<Manifest> {
    let value: Value = read_document(path)?;
    let manifest: Manifest =
        serde_json::from_value(value.clone()).map_err(|_| "Invalid preparation manifest")?;
    if serde_json::to_value(&manifest).map_err(|_| "Invalid manifest")? != value
        || manifest.schema_version != 2
        || manifest.prepared.requests.len() != 1
        || manifest.prepared.digest().map_err(ai_error)? != manifest.plan_digest
        || manifest.prepared.binding.media_id != format!("validation:{}", manifest.case_id)
    {
        return Err("Preparation manifest was changed or is incompatible".into());
    }
    if manifest.prepared.binding.settings_sha256
        != settings_digest(&manifest.prepared.requests[0], manifest.max_audio_seconds)?
    {
        return Err("The explicit audio limit differs from the immutable preparation".into());
    }
    valid_case_id(&manifest.case_id)?;
    manifest.prepared.validate().map_err(ai_error)?;
    Ok(manifest)
}

pub(super) fn valid_case_id(id: &str) -> Result<()> {
    if id.is_empty()
        || id.len() > 100
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
    {
        Err("Case ID must contain 1-100 ASCII letters, digits, hyphens or underscores".into())
    } else {
        Ok(())
    }
}

pub(super) fn manifest_path(root: &Path, id: &str) -> Result<PathBuf> {
    if id.len() != 36 || !id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') {
        return Err("Invalid job ID".into());
    }
    Ok(root.join("manifests").join(format!("{id}.json")))
}
