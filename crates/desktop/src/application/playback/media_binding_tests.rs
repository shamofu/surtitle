use super::*;

#[test]
fn sampled_player_state_preserves_and_clears_coordinator_media_authority() {
    let coordinator = PlaybackCoordinator::default();
    let mut operation = coordinator.operation().unwrap();
    operation.attach("media-a".into());
    assert_eq!(operation.poll().media_id.as_deref(), Some("media-a"));
    operation.attach("media-b".into());
    assert_eq!(operation.poll().media_id.as_deref(), Some("media-b"));
    operation.detach();
    assert_eq!(operation.poll().media_id, None);
}

fn control(action: &str) -> Control {
    Control {
        action: action.into(),
        value: None,
        start_ms: None,
        end_ms: None,
        bounds: None,
        track_kind: None,
    }
}

#[test]
fn reversed_load_dispatch_and_navigation_cancellation_keep_the_latest_source() {
    let coordinator = PlaybackCoordinator::default();
    let first = coordinator.operation().unwrap().reserve_load().unwrap();
    let latest = coordinator.operation().unwrap().reserve_load().unwrap();
    let mut loaded = vec![];
    let mut operation = coordinator.operation().unwrap();
    operation
        .apply_load(latest, |operation| {
            loaded.push("b");
            operation.attach("b".into());
            Ok(())
        })
        .unwrap();
    assert!(
        operation
            .apply_load(first, |_| {
                loaded.push("a");
                Ok(())
            })
            .is_err()
    );
    assert_eq!(loaded, ["b"]);
    let sampled = operation.poll();
    assert_eq!(sampled.media_id.as_deref(), Some("b"));
    assert_eq!(sampled.media_generation, latest);
    let cancelled = operation.reserve_load().unwrap();
    operation.reserve_load().unwrap();
    assert!(
        operation
            .apply_load::<()>(cancelled, |_| panic!("cancelled navigation reached loader"))
            .is_err()
    );
}

#[test]
fn queued_controls_cannot_reach_a_different_or_reloaded_same_media() {
    let coordinator = PlaybackCoordinator::default();
    let mut operation = coordinator.operation().unwrap();
    operation.attach("a".into());
    let old = operation
        .reserve_control("a".into(), &control("rate"))
        .unwrap();
    operation.attach("b".into());
    assert!(
        operation
            .apply_control::<()>(&old, |_| panic!("wrong media control reached player"))
            .is_err()
    );
    operation.attach("a".into());
    let reload = operation.reserve_load().unwrap();
    assert!(
        operation
            .apply_control::<()>(&old, |_| panic!("control reached pending load"))
            .is_err()
    );
    operation
        .apply_load(reload, |operation| {
            operation.attach("a".into());
            Ok(())
        })
        .unwrap();
    assert!(
        operation
            .apply_control::<()>(&old, |_| panic!(
                "stale same-ID control reached replacement"
            ))
            .is_err()
    );
    let rate = operation
        .reserve_control("a".into(), &control("rate"))
        .unwrap();
    let volume = operation
        .reserve_control("a".into(), &control("volume"))
        .unwrap();
    let mut controls = vec![];
    operation
        .apply_control(&volume, |_| {
            controls.push("volume");
            Ok(())
        })
        .unwrap();
    operation
        .apply_control(&rate, |_| {
            controls.push("rate");
            Ok(())
        })
        .unwrap();
    assert_eq!(controls, ["volume", "rate"]);
}

#[test]
fn newer_loop_cancel_seek_and_source_replay_reject_delayed_loop_starts() {
    for replacement in ["source-loop", "loop", "seek", "source-seek"] {
        let coordinator = PlaybackCoordinator::default();
        let mut operation = coordinator.operation().unwrap();
        operation.attach("a".into());
        let old_start = operation
            .reserve_control("a".into(), &control("source-loop"))
            .unwrap();
        let newer = operation
            .reserve_control("a".into(), &control(replacement))
            .unwrap();
        let mut native_loop = true;
        operation
            .apply_control(&newer, |_| {
                native_loop = false;
                Ok(())
            })
            .unwrap();
        assert!(
            operation
                .apply_control(&old_start, |_| {
                    native_loop = true;
                    Ok(())
                })
                .is_err()
        );
        assert!(
            !native_loop,
            "{replacement} allowed the old loop to restart"
        );
    }
}

#[test]
fn commands_reserve_load_order_before_their_futures_are_polled() {
    let directory = tempfile::tempdir().unwrap();
    let state = crate::application::Services::open(directory.path().to_path_buf()).unwrap();
    let runtime = crate::runtime::test_runtime();
    let host = crate::runtime::DesktopHost::new(
        runtime.clone(),
        |work| {
            work();
            Ok(())
        },
        |_| Ok(()),
        |_| {},
    );
    let first = crate::commands::playback::load_media(host.clone(), &state, "first".into());
    let latest = crate::commands::playback::load_media(host.clone(), &state, "latest".into());
    // The newer future has not run at all. Its UI-thread reservation must still
    // prevent the older future from looking up/loading a source when polled now.
    assert!(runtime.block_on(first).unwrap_err().contains("superseded"));
    crate::commands::playback::cancel_pending_media_loads(&state).unwrap();
    assert!(runtime.block_on(latest).unwrap_err().contains("superseded"));
}

#[test]
fn media_bound_dispatch_cannot_change_window_after_source_changes() {
    let directory = tempfile::tempdir().unwrap();
    let state = crate::application::Services::open(directory.path().to_path_buf()).unwrap();
    let runtime = crate::runtime::test_runtime();
    let changed = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let window = changed.clone();
    let host = crate::runtime::DesktopHost::new(
        runtime.clone(),
        |work| {
            work();
            Ok(())
        },
        move |_| {
            window.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        },
        |_| {},
    );
    state.playback.operation().unwrap().attach("first".into());
    let pending = crate::commands::playback::player_control_for_media(
        host.clone(),
        &state,
        "first".into(),
        control("fullscreen"),
    );
    state.playback.operation().unwrap().attach("second".into());
    assert!(
        runtime
            .block_on(pending)
            .unwrap_err()
            .contains("source changed")
    );
    assert_eq!(changed.load(std::sync::atomic::Ordering::SeqCst), 0);
    runtime
        .block_on(crate::commands::playback::player_control(
            host,
            &state,
            control("fullscreen"),
        ))
        .unwrap();
    assert_eq!(changed.load(std::sync::atomic::Ordering::SeqCst), 1);
}
