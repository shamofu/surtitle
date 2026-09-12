//! Explicit, unpaid upstream contract test. Never part of normal offline CI.
use surtitle_tools::{CancellationToken, ToolKind, ToolManager, ToolSelection, YtDlpChannel};

#[tokio::test]
#[ignore = "downloads current upstream CLI releases; run only in upstream workflow"]
async fn current_cli_releases_install_probe_and_reuse() {
    if !cfg!(windows) {
        return;
    }
    let workspace = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let manager = ToolManager::new(workspace.join("work/upstream-tools")).unwrap();
    let evidence = workspace.join("artifacts/upstream");
    std::fs::create_dir_all(&evidence).unwrap();
    let cancel = CancellationToken::new();
    for kind in [ToolKind::YtDlp, ToolKind::Deno, ToolKind::FfmpegPair] {
        let installed = manager
            .update(kind, YtDlpChannel::Nightly, &cancel)
            .await
            .unwrap();
        let snapshot = manager
            .resolve_selection(kind, &ToolSelection::Managed)
            .unwrap();
        let probe = surtitle_tools::probe(&snapshot, &cancel).await.unwrap();
        std::fs::write(
            evidence.join(format!("{}.json", kind.directory())),
            serde_json::to_vec_pretty(
                &serde_json::json!({"install":installed,"probe":probe,"snapshot":snapshot}),
            )
            .unwrap(),
        )
        .unwrap();
        let reused = manager
            .update(kind, YtDlpChannel::Nightly, &cancel)
            .await
            .unwrap();
        assert!(
            !reused.changed,
            "same resolved release should reuse the verified installation"
        );
    }
}
