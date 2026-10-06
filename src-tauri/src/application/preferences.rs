//! Durable preferences publish to memory only after a successful atomic save.
use super::lock;
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    ops::Deref,
    path::PathBuf,
    sync::{Mutex, MutexGuard},
};
use surtitle_core::AppSettings;
use surtitle_tools::ToolSelections;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Preferences {
    pub settings: AppSettings,
    pub tools: ToolSelections,
    pub credential_id: Option<String>,
    #[serde(default)]
    pub quotes: HashMap<String, QuoteContext>,
    #[serde(default)]
    pub probes: HashMap<String, surtitle_tools::ProbeReport>,
    #[serde(default)]
    pub yt_dlp_stable: bool,
    #[serde(default)]
    pub update_checks: HashMap<String, UpdateCheck>,
    #[serde(default)]
    pub ai_continuations: HashMap<String, super::continuations::AiContinuation>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateCheck {
    pub checked_at_ms: i64,
    pub version: String,
    #[serde(default)]
    pub install_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuoteContext {
    pub media_id: String,
    pub kind: String,
    pub start_ms: u64,
    pub end_ms: u64,
}

pub struct PreferencesStore {
    path: PathBuf,
    value: Mutex<Preferences>,
    settings_update: Mutex<()>,
}
pub struct PreferencesRead<'a>(MutexGuard<'a, Preferences>);
impl Deref for PreferencesRead<'_> {
    type Target = Preferences;
    fn deref(&self) -> &Preferences {
        &self.0
    }
}
impl PreferencesStore {
    pub fn open(path: PathBuf) -> Result<Self> {
        let value = if path.is_file() {
            serde_json::from_reader(std::fs::File::open(&path)?)?
        } else {
            Preferences::default()
        };
        Ok(Self {
            path,
            value: Mutex::new(value),
            settings_update: Mutex::new(()),
        })
    }
    /// Serialize the complete preferences -> ledger -> playback settings transition.
    pub(super) fn settings_transition(&self) -> Result<MutexGuard<'_, ()>> {
        lock(&self.settings_update)
    }
    pub fn read(&self) -> Result<PreferencesRead<'_>> {
        Ok(PreferencesRead(lock(&self.value)?))
    }
    pub fn update<T>(&self, change: impl FnOnce(&mut Preferences) -> Result<T>) -> Result<T> {
        let mut current = lock(&self.value)?;
        let mut next = current.clone();
        let result = change(&mut next)?;
        self.save(&next)?;
        *current = next;
        Ok(result)
    }
    pub fn update_if(&self, change: impl FnOnce(&mut Preferences) -> Result<bool>) -> Result<()> {
        let mut current = lock(&self.value)?;
        let mut next = current.clone();
        if change(&mut next)? {
            self.save(&next)?;
            *current = next;
        }
        Ok(())
    }
    fn save(&self, value: &Preferences) -> Result<()> {
        surtitle_core::store::write_json_atomic(&self.path, value)
    }
    #[cfg(test)]
    pub(super) fn test_value(&self) -> Result<MutexGuard<'_, Preferences>> {
        lock(&self.value)
    }
    #[cfg(test)]
    pub(super) fn save_test_value(&self, value: &Preferences) -> Result<()> {
        self.save(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn failed_save_and_failed_change_publish_nothing() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("preferences.json");
        let store = PreferencesStore::open(path.clone()).unwrap();
        store
            .update(|p| {
                p.settings.locale = "en".into();
                Ok(())
            })
            .unwrap();
        let saved = std::fs::read(&path).unwrap();
        assert!(
            store
                .update::<()>(|p| {
                    p.settings.locale = "ja".into();
                    anyhow::bail!("rejected")
                })
                .is_err()
        );
        assert_eq!(store.read().unwrap().settings.locale, "en");
        assert_eq!(std::fs::read(&path).unwrap(), saved);
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        assert!(
            store
                .update(|p| {
                    p.settings.locale = "ja".into();
                    Ok(())
                })
                .is_err()
        );
        assert_eq!(store.read().unwrap().settings.locale, "en");
    }
    #[test]
    fn patches_keep_other_fields_and_survive_reopen() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("preferences.json");
        let store = PreferencesStore::open(path.clone()).unwrap();
        store
            .update(|p| {
                p.settings.locale = "en".into();
                Ok(())
            })
            .unwrap();
        store
            .update(|p| {
                p.settings.theme = "light".into();
                Ok(())
            })
            .unwrap();
        let reopened = PreferencesStore::open(path).unwrap();
        let value = reopened.read().unwrap();
        assert_eq!(value.settings.locale, "en");
        assert_eq!(value.settings.theme, "light");
    }
}
