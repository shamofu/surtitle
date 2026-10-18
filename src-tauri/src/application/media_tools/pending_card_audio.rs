use anyhow::Result;
use std::path::{Path, PathBuf};

/// Newly extracted audio belongs to the save operation until its database commit succeeds.
pub(crate) struct PendingCardAudio {
    path: PathBuf,
    committed: bool,
}

impl PendingCardAudio {
    pub(super) fn new(path: PathBuf) -> Self {
        Self {
            path,
            committed: false,
        }
    }

    /// The callback must return success only after committing the card and its audio reference.
    pub(crate) fn commit_with<T>(mut self, save: impl FnOnce(&Path) -> Result<T>) -> Result<T> {
        let saved = save(&self.path)?;
        self.committed = true;
        Ok(saved)
    }
}

impl Drop for PendingCardAudio {
    fn drop(&mut self) {
        if !self.committed {
            // Cleanup must not replace the source, database or lock error from the save.
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

#[cfg(test)]
#[path = "pending_card_audio_tests.rs"]
mod tests;
