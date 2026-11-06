use anyhow::{Context, Result, ensure};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};

const MAX_JSON_BYTES: u64 = 256 * 1024 * 1024;
const MAX_ZIP_BYTES: u64 = 8 * 1024 * 1024 * 1024 + MAX_JSON_BYTES;
const PREFIX: &str = ".preview-";

pub(crate) struct RestoreSnapshot {
    file: tempfile::NamedTempFile,
    pub original_path: PathBuf,
    pub sha256: String,
    limit: u64,
}
impl RestoreSnapshot {
    pub fn capture(root: &Path, source: &Path) -> Result<Self> {
        Self::capture_then(root, source, || {})
    }
    fn capture_then(root: &Path, source: &Path, after_copy: impl FnOnce()) -> Result<Self> {
        let zipped = source
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("zip"));
        let limit = if zipped {
            MAX_ZIP_BYTES
        } else {
            MAX_JSON_BYTES
        };
        ensure!(
            fs::metadata(source)?.is_file(),
            "Backup must be a regular file"
        );
        let mut input = fs::File::open(source)?;
        ensure!(
            input.metadata()?.is_file() && input.metadata()?.len() <= limit,
            "Backup exceeds the preview size limit"
        );
        let directory = directory(root)?;
        let mut file = tempfile::Builder::new()
            .prefix(PREFIX)
            .rand_bytes(16)
            .suffix(if zipped { ".zip" } else { ".json" })
            .tempfile_in(directory)?;
        let copied = std::io::copy(&mut (&mut input).take(limit + 1), file.as_file_mut())?;
        ensure!(copied <= limit, "Backup exceeds the preview size limit");
        file.as_file().sync_all()?;
        let sha256 = hash_regular(file.path(), limit)?;
        after_copy();
        ensure!(
            hash_regular(source, limit)? == sha256,
            "Backup changed while preparing its preview"
        );
        Ok(Self {
            file,
            original_path: source.to_path_buf(),
            sha256,
            limit,
        })
    }
    pub fn path(&self) -> &Path {
        self.file.path()
    }
    pub fn verify_original(&self) -> Result<()> {
        ensure!(
            hash_regular(&self.original_path, self.limit)? == self.sha256,
            "backup changed after preview"
        );
        Ok(())
    }
    pub fn verify_snapshot(&self) -> Result<()> {
        ensure!(
            hash_regular(self.path(), self.limit)? == self.sha256,
            "Owned restore snapshot changed"
        );
        Ok(())
    }
}

fn hash_regular(path: &Path, limit: u64) -> Result<String> {
    let metadata = fs::metadata(path)?;
    ensure!(
        metadata.is_file() && metadata.len() <= limit,
        "Backup must be a regular file within its preview size limit"
    );
    let file = fs::File::open(path)?;
    let metadata = file.metadata()?;
    ensure!(
        metadata.is_file() && metadata.len() <= limit,
        "Backup changed before verification"
    );
    let mut file = file.take(limit + 1);
    let mut buffer = [0; 64 * 1024];
    let mut total = 0u64;
    let mut hash = Sha256::new();
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        total += count as u64;
        ensure!(total <= limit, "Backup grew beyond its preview size limit");
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn directory(root: &Path) -> Result<PathBuf> {
    let directory = root.join("restore-previews");
    fs::create_dir_all(&directory)?;
    ensure!(
        directory.canonicalize()? == root.canonicalize()?.join("restore-previews"),
        "Restore preview directory is outside application data"
    );
    Ok(directory)
}

// Called only after taking the profile's instance lock. A crash cannot run Drop,
// so remove only this module's private generated files before accepting previews.
pub(crate) fn remove_abandoned(root: &Path) -> Result<()> {
    for entry in fs::read_dir(directory(root)?)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let Some(tail) = name.strip_prefix(PREFIX) else {
            continue;
        };
        let Some((random, extension)) = tail.rsplit_once('.') else {
            continue;
        };
        if random.len() == 16
            && random.bytes().all(|c| c.is_ascii_alphanumeric())
            && ["zip", "json"].contains(&extension)
            && entry.file_type()?.is_file()
        {
            fs::remove_file(entry.path())
                .context("Could not remove an abandoned restore preview")?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replacement_during_capture_is_rejected_and_owned_file_is_removed() {
        let temporary = tempfile::tempdir().unwrap();
        let source = temporary.path().join("source.json");
        fs::write(&source, b"first selected bytes").unwrap();
        assert!(
            RestoreSnapshot::capture_then(temporary.path(), &source, || fs::write(
                &source,
                b"replacement source"
            )
            .unwrap())
            .is_err()
        );
        assert_eq!(
            fs::read_dir(directory(temporary.path()).unwrap())
                .unwrap()
                .count(),
            0
        );
        assert_eq!(fs::read(source).unwrap(), b"replacement source");
    }
    #[test]
    fn snapshot_is_independent_and_drop_or_restart_removes_only_owned_files() {
        let temporary = tempfile::tempdir().unwrap();
        let source = temporary.path().join("source.json");
        fs::write(&source, b"selected bytes").unwrap();
        let snapshot = RestoreSnapshot::capture(temporary.path(), &source).unwrap();
        let path = snapshot.path().to_path_buf();
        fs::write(&source, b"later source").unwrap();
        assert!(snapshot.verify_original().is_err());
        assert_eq!(fs::read(snapshot.path()).unwrap(), b"selected bytes");
        drop(snapshot);
        assert!(!path.exists());
        let retained = directory(temporary.path()).unwrap().join("user-notes.json");
        fs::write(&retained, b"untouched").unwrap();
        let abandoned = directory(temporary.path())
            .unwrap()
            .join(".preview-0123456789abcdef.zip");
        fs::write(&abandoned, b"crash leftover").unwrap();
        remove_abandoned(temporary.path()).unwrap();
        assert!(!abandoned.exists());
        assert_eq!(fs::read(retained).unwrap(), b"untouched");
        assert_eq!(fs::read(source).unwrap(), b"later source");
    }
    #[test]
    fn oversized_json_is_rejected_before_copying() {
        let temporary = tempfile::tempdir().unwrap();
        let source = temporary.path().join("large.json");
        fs::File::create(&source)
            .unwrap()
            .set_len(MAX_JSON_BYTES + 1)
            .unwrap();
        assert!(RestoreSnapshot::capture(temporary.path(), &source).is_err());
        assert!(!temporary.path().join("restore-previews").exists());
    }
    #[test]
    fn source_growth_and_nonfiles_are_rejected_during_verification() {
        let temporary = tempfile::tempdir().unwrap();
        let source = temporary.path().join("source.json");
        fs::write(&source, b"within bound").unwrap();
        assert!(hash_regular(&source, 4).is_err());
        assert!(hash_regular(temporary.path(), 100).is_err());
        let snapshot = RestoreSnapshot::capture(temporary.path(), &source).unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&source)
            .unwrap()
            .set_len(MAX_JSON_BYTES + 1)
            .unwrap();
        assert!(snapshot.verify_original().is_err());
        assert_eq!(fs::read(snapshot.path()).unwrap(), b"within bound");
    }
}
