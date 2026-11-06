// SPDX-License-Identifier: GPL-3.0-or-later
use super::*;
use gpui_kit::test::TestEventExt;

pub(super) fn assert_unavailable_playback_settings(harness: &Harness, cx: &mut TestAppContext) {
    cx.update_window(harness.window, |_, window, app| {
        window.render_frame(app);
        window.click("playback-settings", app);
    })
    .unwrap();
    harness.wait(cx, "owned playback-settings dialog", |_, app| {
        app.windows().len() == 2
    });
    let dialog = cx.read(|app| {
        app.windows()
            .into_iter()
            .find(|window| *window != harness.window)
            .unwrap()
    });
    harness.wait_window(
        cx,
        dialog,
        "disabled sentence pause for unavailable media",
        |window| {
            window
                .try_find("sentence-pause")
                .is_some_and(|button| button.disabled() == Some(true))
        },
    );
    cx.update_window(dialog, |_, window, app| {
        window.click("close-playback-settings", app)
    })
    .unwrap();
    harness.wait(cx, "playback settings closed", |_, app| {
        app.windows().len() == 1
    });
}

fn click_tab(harness: &Harness, label: &str, cx: &mut TestAppContext) {
    cx.update_window(harness.window, |_, window, app| {
        window.render_frame(app);
        let tab = window
            .find_all_by_role(gpui_kit::Role::Tab)
            .into_iter()
            .find(|tab| tab.label() == Some(label))
            .unwrap_or_else(|| panic!("missing real tab {label}"));
        assert!(tab.visible());
        let point = tab.bounds().center();
        window.pointer_down(point, gpui_kit::MouseButton::Left, app);
        window.pointer_up(point, gpui_kit::MouseButton::Left, app);
    })
    .unwrap();
}

#[gpui_kit::test]
fn companion_tabs_present_real_content_and_keep_the_transcript_query(cx: &mut TestAppContext) {
    let harness = Harness::open(cx);
    cx.update_window(harness.window, |_, window, app| {
        window.render_frame(app);
        window.click(("study", 0usize), app);
    })
    .unwrap();
    harness.wait_window(cx, harness.window, "transcript search", |window| {
        window
            .try_find("subtitle-search")
            .is_some_and(|input| input.visible())
    });
    cx.update_window(harness.window, |_, window, app| {
        window.click("subtitle-search", app);
        window.input("safe", app);
    })
    .unwrap();
    harness.wait_window(cx, harness.window, "retained transcript query", |window| {
        window.find("subtitle-search").value() == Some("safe")
    });
    click_tab(&harness, "Transcription", cx);
    harness.wait_window(
        cx,
        harness.window,
        "inline transcription content",
        |window| {
            window
                .try_find("ai-transcription")
                .is_some_and(|button| button.visible())
        },
    );
    assert_eq!(
        cx.read(|app| app.windows().len()),
        1,
        "selecting a tab must not launch a dialog"
    );
    click_tab(&harness, "AI suggestions", cx);
    harness.wait_window(
        cx,
        harness.window,
        "inline vocabulary suggestions",
        |window| {
            window
                .try_find("ai-vocabulary")
                .is_some_and(|button| button.visible())
        },
    );
    assert_eq!(cx.read(|app| app.windows().len()), 1);
    click_tab(&harness, "Transcript", cx);
    harness.wait_window(
        cx,
        harness.window,
        "original transcript query restored",
        |window| {
            window
                .try_find("subtitle-search")
                .is_some_and(|input| input.visible() && input.value() == Some("safe"))
        },
    );
    harness.close(cx);
}

#[gpui_kit::test]
fn meaning_keeps_its_selected_source_and_refuses_a_changed_source(cx: &mut TestAppContext) {
    let harness = Harness::open(cx);
    let first = commands::subtitles::list_segments(&harness.state, "ui-media".into())
        .unwrap()
        .remove(0);
    let second = SubtitleSegment {
        id: "meaning-second".into(),
        start_ms: 1000,
        end_ms: 1900,
        text: "A different passage selected from the transcript.".into(),
        translation: Some("選択した別の文脈。".into()),
        ..first.clone()
    };
    let mut store = Store::open(harness.root.path().join("learning.sqlite")).unwrap();
    let mut media = store.media("ui-media").unwrap();
    media.duration_ms = 2000;
    store.put_media(&media).unwrap();
    store
        .set_segments("ui-media", &[first.clone(), second.clone()])
        .unwrap();
    cx.update_window(harness.window, |_, window, app| {
        window.render_frame(app);
        window.click(("study", 0usize), app);
    })
    .unwrap();
    harness.wait_window(cx, harness.window, "second source row", |window| {
        window
            .try_find("cue-scroll-meaning-second")
            .is_some_and(|row| row.visible())
    });
    // Source text opens Meaning; timestamp playback is a separate control.
    cx.update_window(harness.window, |_, window, app| {
        window.click("cue-scroll-meaning-second", app)
    })
    .unwrap();
    harness.wait_window(
        cx,
        harness.window,
        "meaning companion source actions",
        |window| {
            window
                .try_find("save-meaning-phrase")
                .is_some_and(|button| button.visible())
        },
    );
    assert_eq!(
        cx.read(|app| app.windows().len()),
        1,
        "Meaning belongs in the companion"
    );
    // An applied translation is fresh presentation of the same captured source,
    // not a reason to keep displaying the inspector's earlier cached translation.
    let translated = SubtitleSegment {
        translation: Some("A freshly applied translation for the selected passage.".into()),
        ..second.clone()
    };
    store
        .set_segments("ui-media", &[first.clone(), translated])
        .unwrap();
    harness
        .state
        .changes
        .publish(ChangeDomain::Subtitles, Some("ui-media".into()));
    harness.wait_window(
        cx,
        harness.window,
        "fresh translation in retained meaning",
        |window| {
            window
                .try_find("meaning-translation")
                .is_some_and(|paragraph| {
                    paragraph.label()
                        == Some("A freshly applied translation for the selected passage.")
                })
        },
    );
    cx.update_window(harness.window, |_, window, app| {
        window.click("save-meaning-phrase", app)
    })
    .unwrap();
    harness.wait(cx, "deliberate owned phrase edit", |_, app| {
        app.windows().len() == 2
    });
    let dialog = cx.read(|app| {
        app.windows()
            .into_iter()
            .find(|window| *window != harness.window)
            .unwrap()
    });
    harness.wait_window(
        cx,
        dialog,
        "captured second source in phrase editor",
        |window| {
            window
                .try_find_by_label("Example and original context")
                .is_some_and(|input| input.value() == Some(second.text.as_str()))
        },
    );
    cx.update_window(dialog, |_, window, _| window.remove_window())
        .unwrap();
    harness.wait(cx, "returned to retained meaning", |_, app| {
        app.windows().len() == 1
    });
    let changed = SubtitleSegment {
        text: "Replacement source must not silently rebind the inspector.".into(),
        ..second
    };
    store.set_segments("ui-media", &[first, changed]).unwrap();
    harness
        .state
        .changes
        .publish(ChangeDomain::Subtitles, Some("ui-media".into()));
    harness.wait_window(
        cx,
        harness.window,
        "stale captured source blocks final actions",
        |window| {
            window.find("save-meaning-phrase").disabled() == Some(true)
                && window.find("meaning-play-range").disabled() == Some(true)
                && window.find("ai-explanation").disabled() == Some(true)
        },
    );
    harness.close(cx);
}
