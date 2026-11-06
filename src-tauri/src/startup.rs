//! Startup can fail before a WebView exists, including in console-free releases.
pub(crate) fn open_services(
    e2e_root: Option<std::ffi::OsString>,
    app_root: impl FnOnce() -> anyhow::Result<std::path::PathBuf>,
) -> anyhow::Result<(std::path::PathBuf, crate::application::AppState)> {
    #[cfg(feature = "e2e-test")]
    let root = {
        let _ = app_root;
        let root = std::path::PathBuf::from(e2e_root.ok_or_else(|| {
            anyhow::anyhow!("E2E startup requires an explicit absolute SURTITLE_E2E_DATA_DIR")
        })?);
        anyhow::ensure!(
            root.is_absolute(),
            "E2E startup requires an explicit absolute SURTITLE_E2E_DATA_DIR"
        );
        root
    };
    #[cfg(not(feature = "e2e-test"))]
    let root = {
        let _ = e2e_root;
        app_root()?
    };
    let services = crate::application::Services::open(root.clone()).map_err(|error| {
        anyhow::anyhow!(
            "Could not open Surtitle data at {}:\n{error:#}",
            root.display()
        )
    })?;
    Ok((root, services))
}

pub fn report_startup_failure(error: impl std::fmt::Display) -> ! {
    // Keep a locked or damaged profile actionable without resetting or deleting
    // the user's data as an error recovery step.
    eprintln!("Could not start Surtitle: {error}");
    rfd::MessageDialog::new()
        .set_title("Surtitle")
        .set_level(rfd::MessageLevel::Error)
        .set_description(format!(
            "Surtitle を起動できませんでした / Surtitle could not start\n\n{error}\n\n\
             別の Surtitle が動作中の場合は、そのウィンドウを閉じて再試行してください。\n\
             データを開けない場合は、上記の場所へのアクセス権と空き容量を確認してください。\n\n\
             Close any other Surtitle window and try again. If the data cannot be opened, \
             check access to the location above and available disk space."
        ))
        .set_buttons(rfd::MessageButtons::Ok)
        .show();
    std::process::exit(1);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(feature = "e2e-test")]
    fn e2e_startup_without_an_absolute_test_root_never_opens_the_normal_profile() {
        let temporary = tempfile::tempdir().unwrap();
        for isolated in [None, Some("".into()), Some("relative-e2e-profile".into())] {
            let normal = temporary.path().join("normal-profile");
            let mut default_requested = false;
            let result = open_services(isolated, || {
                default_requested = true;
                Ok(normal.clone())
            });
            assert!(
                result.is_err(),
                "An E2E build requires an absolute test profile"
            );
            assert!(
                !default_requested,
                "Do not resolve the installed profile for an E2E build"
            );
            assert!(
                !normal.exists(),
                "Rejected startup must not create a normal profile"
            );
        }
    }

    #[test]
    #[cfg(feature = "e2e-test")]
    fn e2e_startup_opens_only_the_explicit_absolute_test_profile() {
        let temporary = tempfile::tempdir().unwrap();
        let isolated = temporary.path().join("isolated-profile");
        let (root, _state) = open_services(Some(isolated.clone().into_os_string()), || {
            panic!("E2E startup must not consult the installed profile")
        })
        .unwrap();
        assert_eq!(root, isolated);
        assert!(isolated.join("learning.sqlite").exists());
        assert!(isolated.join("charges.sqlite").exists());
    }

    #[test]
    #[cfg(not(feature = "e2e-test"))]
    fn ordinary_startup_ignores_the_test_profile_override() {
        let temporary = tempfile::tempdir().unwrap();
        let normal = temporary.path().join("normal-profile");
        let isolated = temporary.path().join("ignored-test-profile");
        let (root, _state) = open_services(Some(isolated.clone().into_os_string()), || {
            Ok(normal.clone())
        })
        .unwrap();
        assert_eq!(root, normal);
        assert!(!isolated.exists());
    }
}
