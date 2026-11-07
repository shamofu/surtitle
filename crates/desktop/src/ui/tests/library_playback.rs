// SPDX-License-Identifier: GPL-3.0-or-later
use super::*;

fn open_study(harness: &Harness, cx: &mut TestAppContext) {
    cx.update_window(harness.window, |_, window, app| {
        window.click(("study", 0usize), app)
    })
    .unwrap();
    harness.drain_callbacks(cx);
}

fn wait_for_library_playback(
    harness: &Harness,
    cx: &mut TestAppContext,
    duration_ms: u64,
    position_ms: u64,
) {
    harness.wait(cx, "persisted playback in Library snapshot", |root, app| {
        root.route == Route::Library
            && root
                .session
                .read(app)
                .snapshot
                .as_ref()
                .is_some_and(|snapshot| {
                    snapshot.media.iter().any(|media| {
                        media.id == "ui-media"
                            && media.duration_ms == duration_ms
                            && media.last_position_ms == position_ms
                    })
                })
    });
    harness.wait_window(cx, harness.window, "visible resume action", |window| {
        window
            .try_find("resume-ui-media")
            .is_some_and(|button| button.visible())
    });
}

#[gpui_kit::test]
fn library_navigation_refreshes_persisted_playback_without_using_unrelated_player_events(
    cx: &mut TestAppContext,
) {
    let harness = Harness::open(cx);
    open_study(&harness, cx);
    // Persist through the real store, just as a successful playback tick does.
    // No native Windows player is installed by this fake-platform harness.
    let store = Store::open(harness.root.path().join("learning.sqlite")).unwrap();
    let mut media = store.media("ui-media").unwrap();
    media.duration_ms = 8000;
    media.last_position_ms = 6500;
    store.put_media(&media).unwrap();
    let checkpoint = commands::synchronization::get_change_checkpoint(&harness.state).unwrap();
    // Playback events need not belong to the row being displayed. They must not
    // overwrite persisted metadata or turn every sample into a full DB refresh.
    harness
        .host
        .emit(DesktopEvent::PlayerState(crate::player::PlayerState {
            revision: 50,
            media_id: Some("previous-media".into()),
            ready: true,
            duration_ms: 120_000,
            position_ms: 90_000,
            ..Default::default()
        }));
    harness.wait(cx, "unrelated sampled player", |root, app| {
        root.session.read(app).player.revision == 50
    });
    harness.drain_callbacks(cx);
    assert_eq!(
        cx.read(|app| harness
            .view
            .read(app)
            .session
            .read(app)
            .snapshot
            .as_ref()
            .unwrap()
            .media[0]
            .duration_ms),
        1000
    );
    harness.route(cx, "library");
    wait_for_library_playback(&harness, cx, 8000, 6500);
    assert_eq!(
        commands::synchronization::get_change_checkpoint(&harness.state).unwrap(),
        checkpoint
    );
    let saved = store.media("ui-media").unwrap();
    assert_eq!((saved.duration_ms, saved.last_position_ms), (8000, 6500));
    cx.update_window(harness.window, |_, window, app| {
        window.click("resume-ui-media", app)
    })
    .unwrap();
    harness.wait(cx, "resume opens the saved media", |root, _| {
        root.route == Route::Study("ui-media".into())
    });
    harness.close(cx);
}

#[cfg(all(not(windows), feature = "e2e-test"))]
#[gpui_kit::test]
fn library_navigation_persists_the_latest_player_clock_before_refresh_and_resume(
    cx: &mut TestAppContext,
) {
    let harness = Harness::open(cx);
    harness
        .state
        .initialize_player(harness.root.path(), 0, || {})
        .unwrap();
    open_study(&harness, cx);
    harness.host.emit(DesktopEvent::PlayerState(
        harness.state.player_state().unwrap(),
    ));
    harness.wait_window(cx, harness.window, "ready seek action", |window| {
        window.find("forward-five").disabled() != Some(true)
    });
    cx.update_window(harness.window, |_, window, app| {
        window.click("forward-five", app)
    })
    .unwrap();
    harness.drain_callbacks(cx);
    let player = harness.state.player_state().unwrap();
    assert_eq!(player.position_ms, 5000);
    let store = Store::open(harness.root.path().join("learning.sqlite")).unwrap();
    assert_eq!(store.media("ui-media").unwrap().last_position_ms, 0);
    let checkpoint = commands::synchronization::get_change_checkpoint(&harness.state).unwrap();
    // There is no periodic native tick in this harness. Navigation must save the
    // final sampled clock before its asynchronous Library snapshot can read it.
    harness.route(cx, "library");
    wait_for_library_playback(&harness, cx, player.duration_ms, 5000);
    let saved = store.media("ui-media").unwrap();
    assert_eq!(
        (saved.duration_ms, saved.last_position_ms),
        (player.duration_ms, 5000)
    );
    assert_eq!(
        commands::synchronization::get_change_checkpoint(&harness.state).unwrap(),
        checkpoint
    );
    cx.update_window(harness.window, |_, window, app| {
        window.click("resume-ui-media", app)
    })
    .unwrap();
    harness.drain_callbacks(cx);
    assert_eq!(harness.state.player_state().unwrap().position_ms, 5000);
    harness.close(cx);
}
