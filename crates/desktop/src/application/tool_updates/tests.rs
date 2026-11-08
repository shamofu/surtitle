use super::*;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

fn run<T>(future: impl Future<Output = T>) -> T {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(future)
}
fn state() -> (tempfile::TempDir, AppState) {
    let root = tempfile::tempdir().unwrap();
    let state = Services::open(root.path().join("profile")).unwrap();
    (root, state)
}
fn install_fixture(state: &Services, kind: ToolKind) -> std::path::PathBuf {
    let folder = state.tools.manager.root().join(kind.directory());
    std::fs::create_dir_all(&folder).unwrap();
    let path = folder.join("state.json");
    let installed = surtitle_tools::InstalledTool {
        kind,
        version: "old fixture".into(),
        channel: "fixture".into(),
        install_id: "fixture".into(),
        provider: "fixture".into(),
        source_page: "https://example.test/fixture".into(),
        declared_license: "test only".into(),
        verification: surtitle_tools::Verification::HttpsSha256 {
            origin: "https://example.test".into(),
        },
        archive_sha256: "0".repeat(64),
        installed_unix: 0,
        probe: surtitle_tools::ProbeReport {
            kind,
            version: "old fixture".into(),
            companion_version: Some("old fixture".into()),
            capabilities: vec![],
            diagnostics: vec![],
        },
        executable_relative: kind.executable().into(),
        companion_relative: Some(
            if cfg!(windows) {
                "ffprobe.exe"
            } else {
                "ffprobe"
            }
            .into(),
        ),
        files: Default::default(),
    };
    std::fs::write(
        &path,
        serde_json::to_vec(&serde_json::json!({"active":installed,"previous":null})).unwrap(),
    )
    .unwrap();
    path
}

#[test]
fn external_and_uninstalled_tools_never_trigger_metadata_or_installation() {
    run(async {
        let (root, state) = state();
        check_with(&state, true, |_| async {
            panic!("uninstalled tool must not call metadata")
        })
        .await
        .unwrap();
        let external = root.path().join("external-ffmpeg");
        std::fs::write(&external, b"user owned").unwrap();
        install_fixture(&state, ToolKind::FfmpegPair);
        {
            let mut p = state.preferences.test_value().unwrap();
            p.tools.ffmpeg = ToolSelection::External {
                path: external.clone(),
            };
            p.update_checks.insert(
                "ffmpeg".into(),
                UpdateCheck {
                    install_id: "fixture".into(),
                    checked_at_ms: 0,
                    version: "new".into(),
                },
            );
            assert!(latest_version(&p, ToolKind::FfmpegPair, Some("fixture")).is_none());
        }
        check_with(&state, true, |_| async {
            panic!("no metadata call is allowed")
        })
        .await
        .unwrap();
        assert_eq!(std::fs::read(external).unwrap(), b"user owned");
        assert!(!state.root.join("preferences.json").exists());
        assert_eq!(state.tools.manager.active_jobs(), 0);
    });
}

#[test]
fn cache_expires_and_manual_check_bypasses_it_without_replacing_tools() {
    run(async {
        let (_root, state) = state();
        let path = install_fixture(&state, ToolKind::FfmpegPair);
        let original = std::fs::read(&path).unwrap();
        let calls = AtomicUsize::new(0);
        let lookup = |_| {
            calls.fetch_add(1, Ordering::SeqCst);
            async { Ok("unknown-future-version".into()) }
        };
        check_with(&state, false, lookup).await.unwrap();
        check_with(&state, false, lookup).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        check_with(&state, true, lookup).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        for timestamp in [
            chrono::Utc::now().timestamp_millis() - CACHE_AGE_MS,
            i64::MAX,
        ] {
            state
                .preferences
                .test_value()
                .unwrap()
                .update_checks
                .get_mut("ffmpeg")
                .unwrap()
                .checked_at_ms = timestamp;
            check_with(&state, false, lookup).await.unwrap();
        }
        assert_eq!(calls.load(Ordering::SeqCst), 4);
        assert_eq!(std::fs::read(path).unwrap(), original);
        let persisted: Preferences =
            serde_json::from_slice(&std::fs::read(state.root.join("preferences.json")).unwrap())
                .unwrap();
        assert_eq!(
            latest_version(&persisted, ToolKind::FfmpegPair, Some("fixture")).as_deref(),
            Some("unknown-future-version")
        );
    });
}

#[test]
fn stale_inflight_responses_and_shutdown_cannot_update_preferences() {
    run(async {
        let (_root, state) = state();
        install_fixture(&state, ToolKind::FfmpegPair);
        check_with(&state, true, |_| async {
            state.preferences.test_value().unwrap().tools.ffmpeg = ToolSelection::External {
                path: "user-tool".into(),
            };
            Ok("late-external".into())
        })
        .await
        .unwrap();
        assert!(
            state
                .preferences
                .test_value()
                .unwrap()
                .update_checks
                .is_empty()
        );
        state.preferences.test_value().unwrap().tools.ffmpeg = ToolSelection::Managed;
        assert!(
            check_with(&state, true, |_| async {
                state.tools.shutdown.cancel();
                Ok("late-close".into())
            })
            .await
            .is_err()
        );
        assert!(
            state
                .preferences
                .test_value()
                .unwrap()
                .update_checks
                .is_empty()
        );
        assert!(!state.root.join("preferences.json").exists());
        assert!(
            check_with(&state, true, |_| async {
                panic!("closed app must not call metadata")
            })
            .await
            .is_err()
        );
    });
}

#[test]
fn failed_metadata_is_not_cached_and_a_later_check_can_recover() {
    run(async {
        let (_root, state) = state();
        install_fixture(&state, ToolKind::FfmpegPair);
        let error = check_with(&state, true, |_| async {
            anyhow::bail!("fixture unavailable");
        })
        .await
        .unwrap_err();
        assert!(error.to_string().contains("ffmpeg: fixture unavailable"));
        assert!(
            state
                .preferences
                .test_value()
                .unwrap()
                .update_checks
                .is_empty()
        );
        check_with(&state, false, |_| async { Ok("new-ffmpeg".into()) })
            .await
            .unwrap();
        assert_eq!(
            latest_version(
                &state.preferences.test_value().unwrap(),
                ToolKind::FfmpegPair,
                Some("fixture")
            )
            .as_deref(),
            Some("new-ffmpeg")
        );
    });
}

#[test]
fn periodic_checks_repeat_after_failures_and_stop_on_close() {
    run(async {
        let shutdown = CancellationToken::new();
        let calls = Arc::new(AtomicUsize::new(0));
        tokio::time::timeout(
            Duration::from_secs(2),
            periodic(&shutdown, Duration::from_millis(2), || async {
                let count = calls.fetch_add(1, Ordering::SeqCst) + 1;
                if count == 3 {
                    shutdown.cancel();
                }
                anyhow::bail!("a metadata failure does not stop future checks")
            }),
        )
        .await
        .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 3);
        periodic(&shutdown, Duration::from_secs(60), || async {
            panic!("closed")
        })
        .await;
    });
}

#[test]
fn installing_a_new_tool_invalidates_cached_and_inflight_metadata() {
    run(async {
        let (_root, state) = state();
        let path = install_fixture(&state, ToolKind::FfmpegPair);
        let replace_install = |id: &str| {
            let mut data: serde_json::Value =
                serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            data["active"]["install_id"] = id.into();
            data["active"]["version"] = id.into();
            std::fs::write(&path, serde_json::to_vec(&data).unwrap()).unwrap();
        };
        check_with(&state, false, |_| async { Ok("cached-v2".into()) })
            .await
            .unwrap();
        replace_install("installed-v3");
        assert!(
            latest_version(
                &state.preferences.test_value().unwrap(),
                ToolKind::FfmpegPair,
                Some("installed-v3")
            )
            .is_none()
        );
        check_with(&state, false, |_| async {
            replace_install("installed-v4");
            Ok("late-v3".into())
        })
        .await
        .unwrap();
        assert!(
            latest_version(
                &state.preferences.test_value().unwrap(),
                ToolKind::FfmpegPair,
                Some("installed-v4")
            )
            .is_none()
        );
        check_with(&state, false, |_| async { Ok("new-v5".into()) })
            .await
            .unwrap();
        assert_eq!(
            latest_version(
                &state.preferences.test_value().unwrap(),
                ToolKind::FfmpegPair,
                Some("installed-v4")
            )
            .as_deref(),
            Some("new-v5")
        );
    });
}

#[test]
fn overlapping_background_checks_share_one_fresh_result() {
    run(async {
        let (_root, state) = state();
        install_fixture(&state, ToolKind::FfmpegPair);
        let calls = AtomicUsize::new(0);
        let lookup = |_| async {
            calls.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(5)).await;
            Ok("new-ffmpeg".into())
        };
        let (first, second) = tokio::join!(
            check_with(&state, false, lookup),
            check_with(&state, false, lookup)
        );
        first.unwrap();
        second.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    });
}
