//! Production desktop lifecycle. GPUI objects never cross the GUI-thread boundary.
use anyhow::{Context, Result, ensure};
use std::path::{Path, PathBuf};

pub(crate) mod dialog;
mod geometry;
#[cfg(windows)]
mod native;
mod placement;
#[cfg(any(windows, test))]
mod snapping;
#[cfg(windows)]
mod windows;

fn normal_profile(local_data: Option<std::ffi::OsString>) -> Result<PathBuf> {
    let local_data = PathBuf::from(local_data.context("LOCALAPPDATA is unavailable")?);
    ensure!(
        local_data.is_absolute(),
        "LOCALAPPDATA must be an absolute path"
    );
    Ok(local_data.join(crate::startup::identity().identifier))
}

fn resources(executable: &Path, development: Option<&Path>) -> Result<PathBuf> {
    let root = match development {
        Some(workspace) => workspace.join("work/resources"),
        None => executable
            .parent()
            .context("Application directory is unavailable")?
            .to_path_buf(),
    };
    ensure!(
        root.is_absolute(),
        "Application resources require an absolute directory"
    );
    for file in ["mpv-2.dll", "onnxruntime.dll"] {
        ensure!(
            root.join("native").join(file).is_file(),
            "Application resource is missing: {}",
            root.join("native").join(file).display()
        );
    }
    Ok(root)
}

pub fn run() -> Result<()> {
    // Environment mutation is safe here: main calls this before constructing
    // Tokio, GPUI, application services, or any other worker threads.
    unsafe {
        std::env::set_var("GPUI_DISABLE_DIRECT_COMPOSITION", "true");
    }
    #[cfg(windows)]
    {
        windows::run()
    }
    #[cfg(not(windows))]
    {
        anyhow::bail!("Surtitle desktop playback requires Windows 11 x64")
    }
}

/// Match the native title bar to the active GPUI theme.
pub(crate) fn set_caption_theme(window: &gpui_kit::Window, dark: bool) -> Result<()> {
    #[cfg(windows)]
    {
        windows::set_caption_theme(window, dark)
    }
    #[cfg(not(windows))]
    {
        let _ = (window, dark);
        Ok(())
    }
}

/// Reenter the native close hook after durable UI work has finished flushing.
pub(crate) fn request_close(window: &mut gpui_kit::Window) -> Result<()> {
    #[cfg(windows)]
    {
        windows::request_close(window)
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        anyhow::bail!("The desktop close hook requires Windows")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_resolution_requires_an_absolute_local_directory() {
        assert!(normal_profile(None).is_err());
        assert!(normal_profile(Some("relative".into())).is_err());
        let root = tempfile::tempdir().unwrap();
        assert_eq!(
            normal_profile(Some(root.path().as_os_str().to_owned())).unwrap(),
            root.path().join("app.surtitle.desktop")
        );
    }

    #[test]
    fn resource_resolution_uses_the_development_or_installed_layout() {
        let root = tempfile::tempdir().unwrap();
        let development = root.path().join("work/resources/native");
        let installed = root.path().join("installed/native");
        std::fs::create_dir_all(&development).unwrap();
        std::fs::create_dir_all(&installed).unwrap();
        for directory in [&development, &installed] {
            for file in ["mpv-2.dll", "onnxruntime.dll"] {
                std::fs::write(directory.join(file), b"test resource").unwrap();
            }
        }
        let exe = root.path().join("installed/surtitle.exe");
        assert_eq!(
            resources(&exe, Some(root.path())).unwrap(),
            root.path().join("work/resources")
        );
        assert_eq!(
            resources(&exe, None).unwrap(),
            root.path().join("installed")
        );
        std::fs::remove_file(installed.join("onnxruntime.dll")).unwrap();
        assert!(resources(&exe, None).is_err());
    }
}
