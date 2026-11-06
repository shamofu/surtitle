//! Prepared audio identity and bounded integrity checks.
use super::valid_sha;
use crate::{sha256_bytes, AiError, AiProvider, AudioRequestLimits, Result};
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
    pub const MAX_OPENAI_FILE_BYTES: u64 = 25_000_000;
    /// Matches the existing duration-usage accounting limit; not a chunk target.
    pub const MAX_OPENAI_DURATION_MS: u64 = 86_400_000;

    pub fn from_file(path: PathBuf, source_start_ms: u64, duration_ms: u64) -> Result<Self> {
        Self::from_file_for_provider(path, source_start_ms, duration_ms, AiProvider::Vertex)
    }

    pub fn from_file_for_provider(
        path: PathBuf,
        source_start_ms: u64,
        duration_ms: u64,
        provider: AiProvider,
    ) -> Result<Self> {
        Self::from_file_with_limits(
            path,
            source_start_ms,
            duration_ms,
            AudioRequestLimits::for_provider(provider),
        )
    }

    pub fn from_file_with_limits(
        path: PathBuf,
        source_start_ms: u64,
        duration_ms: u64,
        limits: AudioRequestLimits,
    ) -> Result<Self> {
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
        Self::validate_limits(byte_len, source_start_ms, duration_ms, limits)?;
        Ok(Self {
            sha256: hash_file(&path)?,
            path,
            byte_len,
            mime_type,
            source_start_ms,
            duration_ms,
        })
    }

    pub fn validate_for_provider(&self, provider: AiProvider) -> Result<()> {
        self.validate_with_limits(AudioRequestLimits::for_provider(provider))
    }

    pub fn validate_with_limits(&self, limits: AudioRequestLimits) -> Result<()> {
        Self::validate_limits(
            self.byte_len,
            self.source_start_ms,
            self.duration_ms,
            limits,
        )?;
        if !valid_sha(&self.sha256)
            || !["audio/wav", "audio/flac", "audio/mpeg"].contains(&self.mime_type.as_str())
        {
            return Err(AiError::Invalid(
                "Invalid prepared audio identity or format".into(),
            ));
        }
        Ok(())
    }

    fn validate_limits(
        byte_len: u64,
        source_start_ms: u64,
        duration_ms: u64,
        limits: AudioRequestLimits,
    ) -> Result<()> {
        if byte_len == 0
            || byte_len > limits.maximum_bytes
            || duration_ms == 0
            || duration_ms > limits.maximum_duration_ms
            || source_start_ms.checked_add(duration_ms).is_none()
        {
            return Err(AiError::Invalid(
                "Audio attachment exceeds the provider request limits".into(),
            ));
        }
        Ok(())
    }

    /// Verify the immutable prepared input without exposing its contents.
    pub fn verify_integrity(&self) -> Result<()> {
        self.verified_bytes().map(drop)
    }

    pub fn verify_integrity_for_provider(&self, provider: AiProvider) -> Result<()> {
        self.verified_bytes_for_provider(provider).map(drop)
    }

    pub fn verify_integrity_with_limits(&self, limits: AudioRequestLimits) -> Result<()> {
        self.verified_bytes_with_limits(limits).map(drop)
    }

    pub(crate) fn verified_bytes(&self) -> Result<Vec<u8>> {
        self.verified_bytes_for_provider(AiProvider::Vertex)
    }

    pub(crate) fn verified_bytes_for_provider(&self, provider: AiProvider) -> Result<Vec<u8>> {
        self.verified_bytes_with_limits(AudioRequestLimits::for_provider(provider))
    }

    pub(crate) fn verified_bytes_with_limits(&self, limits: AudioRequestLimits) -> Result<Vec<u8>> {
        let mut file = File::open(&self.path)?;
        if self.validate_with_limits(limits).is_err() || file.metadata()?.len() != self.byte_len {
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
