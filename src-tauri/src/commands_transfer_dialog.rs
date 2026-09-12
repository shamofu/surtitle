use crate::service::AppState;
use anyhow::Result;
use std::path::PathBuf;

pub(super) async fn export_path(state: &AppState, format: &str) -> Result<Option<PathBuf>> {
    #[cfg(feature = "e2e-test")]
    if let Some(path) = fixture_path_from_environment(state, Some(format))? {
        return Ok(Some(path));
    }
    let _ = state;
    Ok(rfd::AsyncFileDialog::new()
        .set_file_name(format!(
            "surtitle-{}.{}",
            chrono::Utc::now().format("%Y%m%d"),
            format
        ))
        .save_file()
        .await
        .map(|file| file.path().to_path_buf()))
}

pub(super) async fn restore_path(state: &AppState) -> Result<Option<PathBuf>> {
    #[cfg(feature = "e2e-test")]
    if let Some(path) = fixture_path_from_environment(state, None)? {
        return Ok(Some(path));
    }
    let _ = state;
    Ok(rfd::AsyncFileDialog::new()
        .add_filter("Surtitle backup", &["json", "zip"])
        .pick_file()
        .await
        .map(|file| file.path().to_path_buf()))
}

#[cfg(feature = "e2e-test")]
fn fixture_path_from_environment(
    state: &AppState,
    format: Option<&str>,
) -> Result<Option<PathBuf>> {
    fixture_path(
        state,
        format,
        std::env::var_os("SURTITLE_E2E_DATA_DIR").as_deref(),
        std::env::var_os("SURTITLE_E2E_TRANSCRIPT_REVIEW").as_deref(),
    )
}

// This compile-time-only boundary chooses one fixed ZIP inside an explicitly
// isolated fixture profile. It never accepts a path from the webview or a marker.
#[cfg(feature = "e2e-test")]
fn fixture_path(
    state: &AppState,
    format: Option<&str>,
    configured_root: Option<&std::ffi::OsStr>,
    preset: Option<&std::ffi::OsStr>,
) -> Result<Option<PathBuf>> {
    use anyhow::{Context, ensure};
    use std::{fs, path::Path};

    let directory = state.root.join("e2e-transfer");
    let marker = directory.join("enabled.fixture");
    let metadata = match fs::symlink_metadata(&marker) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let configured = Path::new(configured_root.context("Transfer fixture needs an isolated root")?);
    let root = state.root.canonicalize()?;
    ensure!(
        configured.is_absolute()
            && configured.canonicalize()? == root
            && preset == Some(std::ffi::OsStr::new("boundary")),
        "Transfer fixture profile does not match"
    );
    ensure!(
        directory.canonicalize()? == root.join("e2e-transfer")
            && metadata.is_file()
            && !metadata.file_type().is_symlink()
            && metadata.len() == b"surtitle.e2e.transfer.v1\r\n".len() as u64
            && fs::read(&marker)? == b"surtitle.e2e.transfer.v1\r\n",
        "Invalid transfer fixture marker"
    );
    for (name, key, expected) in [
        ("fixture.json", "mediaId", "fixture-media"),
        ("e2e-transcript-fixture.json", "preset", "boundary"),
    ] {
        let path = root.join(name);
        let metadata = fs::symlink_metadata(&path)?;
        ensure!(
            metadata.is_file() && !metadata.file_type().is_symlink() && metadata.len() <= 4096,
            "Invalid isolated fixture identity"
        );
        let value: serde_json::Value = serde_json::from_slice(&fs::read(path)?)?;
        ensure!(value[key] == expected, "Isolated fixture identity differs");
    }
    {
        let preferences = crate::service::lock(&state.preferences)?;
        ensure!(
            preferences.credential_id.is_none()
                && !preferences.settings.credential_configured
                && preferences.settings.daily_budget_usd == 0.,
            "Transfer fixture requires a zero-budget profile without credentials"
        );
    }
    ensure!(
        format.is_none_or(|value| value == "zip"),
        "Transfer fixture supports only ZIP"
    );
    let path = directory.join("learning.zip");
    if format.is_some() {
        ensure!(
            fs::symlink_metadata(&path).is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound),
            "Transfer fixture destination already exists or is unavailable"
        );
    } else {
        let metadata = fs::symlink_metadata(&path)?;
        ensure!(
            metadata.is_file()
                && !metadata.file_type().is_symlink()
                && path.canonicalize()?.parent() == Some(root.join("e2e-transfer").as_path()),
            "Transfer fixture backup is outside its owned directory"
        );
    }
    Ok(Some(path))
}

#[cfg(all(test, feature = "e2e-test"))]
mod tests {
    use super::*;
    use crate::service::{Services, lock};

    fn fixture() -> (tempfile::TempDir, AppState) {
        let temporary = tempfile::tempdir().unwrap();
        let state = Services::open(temporary.path().join("data")).unwrap();
        std::fs::create_dir(state.root.join("e2e-transfer")).unwrap();
        std::fs::write(
            state.root.join("e2e-transfer/enabled.fixture"),
            b"surtitle.e2e.transfer.v1\r\n",
        )
        .unwrap();
        std::fs::write(
            state.root.join("fixture.json"),
            br#"{"mediaId":"fixture-media"}"#,
        )
        .unwrap();
        std::fs::write(
            state.root.join("e2e-transcript-fixture.json"),
            br#"{"preset":"boundary","paidRequests":0}"#,
        )
        .unwrap();
        (temporary, state)
    }
    #[test]
    fn fixed_zip_selection_requires_explicit_matching_noncredentialed_fixture() {
        let (_temporary, state) = fixture();
        let selected = |format, root, preset| fixture_path(&state, format, root, preset);
        let root = Some(state.root.as_os_str());
        let preset = Some(std::ffi::OsStr::new("boundary"));
        assert!(selected(Some("zip"), None, preset).is_err());
        assert!(selected(Some("zip"), root, None).is_err());
        assert!(selected(Some("zip"), Some(std::ffi::OsStr::new(".")), preset).is_err());
        assert!(selected(Some("json"), root, preset).is_err());
        assert_eq!(
            selected(Some("zip"), root, preset).unwrap(),
            Some(state.root.join("e2e-transfer/learning.zip"))
        );
        lock(&state.preferences).unwrap().credential_id = Some("synthetic-placeholder".into());
        assert!(selected(Some("zip"), root, preset).is_err());
        lock(&state.preferences).unwrap().credential_id = None;
        lock(&state.preferences).unwrap().settings.daily_budget_usd = 1.;
        assert!(selected(Some("zip"), root, preset).is_err());
        lock(&state.preferences).unwrap().settings.daily_budget_usd = 0.;
        std::fs::write(
            state.root.join("e2e-transfer/learning.zip"),
            b"existing destination",
        )
        .unwrap();
        assert!(selected(Some("zip"), root, preset).is_err());
        assert!(selected(None, root, preset).unwrap().is_some());
        std::fs::remove_file(state.root.join("e2e-transfer/enabled.fixture")).unwrap();
        assert!(selected(None, root, preset).unwrap().is_none());
    }
    #[cfg(unix)]
    #[test]
    fn fixture_rejects_symlinked_zip_and_directory() {
        let (temporary, state) = fixture();
        let root = Some(state.root.as_os_str());
        let preset = Some(std::ffi::OsStr::new("boundary"));
        let outside = temporary.path().join("outside.zip");
        std::fs::write(&outside, b"untouched").unwrap();
        let destination = state.root.join("e2e-transfer/learning.zip");
        std::os::unix::fs::symlink(&outside, &destination).unwrap();
        assert!(fixture_path(&state, None, root, preset).is_err());
        assert!(fixture_path(&state, Some("zip"), root, preset).is_err());
        let directory = state.root.join("e2e-transfer");
        let moved = temporary.path().join("outside-directory");
        std::fs::rename(&directory, &moved).unwrap();
        std::os::unix::fs::symlink(&moved, &directory).unwrap();
        assert!(fixture_path(&state, None, root, preset).is_err());
        assert_eq!(std::fs::read(outside).unwrap(), b"untouched");
    }
}
