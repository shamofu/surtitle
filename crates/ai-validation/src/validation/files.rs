//! Bounded local documents and create-only durable outputs.
use super::{MAX_DOCUMENT_BYTES, Result};
use serde::Serialize;
use std::fs;
use std::io::{Read, Write};
use std::path::Path;

pub(super) fn absolute(path: &Path) -> Result<()> {
    if path.is_absolute() {
        Ok(())
    } else {
        Err("Use an explicit absolute path".into())
    }
}

pub(super) fn reject_link(path: &Path) -> Result<()> {
    if fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
        Err("Validation files must not be symbolic links".into())
    } else {
        Ok(())
    }
}

pub(super) fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>> {
    reject_link(path)?;
    let mut file = fs::File::open(path).map_err(|_| "Cannot read the requested local file")?;
    if file
        .metadata()
        .map_err(|_| "Cannot inspect local file")?
        .len()
        > limit
    {
        return Err("Local input exceeds size limit".into());
    }
    let mut bytes = vec![];
    Read::by_ref(&mut file)
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read local file")?;
    if bytes.len() as u64 > limit {
        return Err("Local input exceeds size limit".into());
    }
    Ok(bytes)
}

pub(super) fn read_document<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T> {
    serde_json::from_slice(&read_bounded(path, MAX_DOCUMENT_BYTES)?)
        .map_err(|_| "Invalid local JSON document".into())
}

pub(super) fn write_new(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|_| "Output already exists or cannot be created")?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "Cannot persist output".to_owned())
}

pub(super) fn write_json_new(path: &Path, value: &impl Serialize) -> Result<()> {
    write_new(
        path,
        &serde_json::to_vec_pretty(value).map_err(|_| "Cannot encode JSON output")?,
    )
}
