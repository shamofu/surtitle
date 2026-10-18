//! Prepared audio identity and bounded integrity checks.
use crate::{sha256_bytes, AiError, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs::File, io::Read, path::PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AudioAttachment {
    pub path: PathBuf,
    pub sha256: String,
    pub byte_len: u64,
    pub mime_type: String,
    pub source_start_ms: u64,
    pub duration_ms: u64,
}

impl AudioAttachment {
    pub fn from_file(path: PathBuf, source_start_ms: u64, duration_ms: u64) -> Result<Self> {
        let path = path.canonicalize()?;
        let ext = path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let mime_type = match ext.as_str() {
            "wav" => "audio/wav",
            "flac" => "audio/flac",
            "mp3" => "audio/mpeg",
            _ => {
                return Err(AiError::Invalid(
                    "Use a prepared WAV, FLAC, or MP3 attachment".into(),
                ));
            }
        }
        .to_owned();
        let byte_len = path.metadata()?.len();
        if byte_len == 0
            || byte_len > 12 * 1024 * 1024
            || duration_ms == 0
            || duration_ms > 240_000
            || source_start_ms.checked_add(duration_ms).is_none()
        {
            return Err(AiError::Invalid(
                "Audio attachment exceeds the bounded request limits".into(),
            ));
        }
        Ok(Self {
            sha256: hash_file(&path)?,
            path,
            byte_len,
            mime_type,
            source_start_ms,
            duration_ms,
        })
    }

    /// Verify the immutable prepared input without exposing its contents.
    pub fn verify_integrity(&self) -> Result<()> {
        self.verified_bytes().map(drop)
    }

    pub(crate) fn verified_bytes(&self) -> Result<Vec<u8>> {
        let mut file = File::open(&self.path)?;
        if file.metadata()?.len() != self.byte_len || self.byte_len > 12 * 1024 * 1024 {
            return Err(AiError::PreparationChanged);
        }
        let mut bytes = Vec::with_capacity(self.byte_len as usize);
        file.by_ref()
            .take(self.byte_len + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 != self.byte_len || sha256_bytes(&bytes) != self.sha256 {
            return Err(AiError::PreparationChanged);
        }
        Ok(bytes)
    }
}

pub fn hash_file(path: &std::path::Path) -> Result<String> {
    let mut file = File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = [0_u8; 65_536];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(format!("{:x}", h.finalize()))
}
