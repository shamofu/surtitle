// SPDX-License-Identifier: GPL-3.0-or-later
use super::*;
use gpui_kit::test::TestEventExt;

fn settings_window(harness: &Harness, width: f32, cx: &mut TestAppContext) -> AnyWindowHandle {
    cx.update(|app| {
        let root = harness.view.read(app);
        let session = root.session.clone();
        let editors = root.editors.clone();
        gpui_kit::open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds {
                    origin: Default::default(),
                    size: size(px(width), px(1000.)),
                })),
                ..Default::default()
            },
            app,
            |window, app| app.new(|cx| settings::SettingsView::new(session, editors, window, cx)),
        )
        .unwrap()
        .0
    })
}

fn bounds(cx: &mut TestAppContext, window: AnyWindowHandle, id: &str) -> Bounds<gpui_kit::Pixels> {
    cx.update_window(window, |_, window, app| {
        window.render_frame(app);
        window.find(id.to_owned()).bounds()
    })
    .unwrap()
}

fn locale(harness: &Harness, value: &str, cx: &mut TestAppContext) {
    let mut settings = harness.state.settings().unwrap();
    settings.locale = value.into();
    commands::models::update_settings(&harness.state, settings).unwrap();
    harness.update(cx, |root, _, cx| {
        root.session.update(cx, |session, cx| session.refresh(cx))
    });
    harness.wait(cx, "test interface language", |root, app| {
        root.session.read(app).text("ja", "en") == value
    });
}

#[gpui_kit::test]
fn settings_validation_does_not_move_later_fields(cx: &mut TestAppContext) {
    let harness = Harness::open(cx);
    for language in ["en", "ja"] {
        locale(&harness, language, cx);
        for width in [720., 1280.] {
            let window = settings_window(&harness, width, cx);
            let before = bounds(cx, window, "setting-proficiency");
            cx.update_window(window, |_, window, app| {
                window.click("settings-learningLanguage", app);
                window.press("ctrl-a", app);
                window.press("backspace", app);
            })
            .unwrap();
            harness.wait_window(cx, window, "empty language input", |window| {
                window.find("settings-learningLanguage").value() == Some("")
            });
            assert_eq!(
                before,
                bounds(cx, window, "setting-proficiency"),
                "validation moved later controls: {language}, {width}"
            );
            cx.update_window(window, |_, window, app| window.input("en", app))
                .unwrap();
            harness.wait_window(cx, window, "valid language restored", |window| {
                window.find("settings-learningLanguage").value() == Some("en")
            });
            assert_eq!(before, bounds(cx, window, "setting-proficiency"));
            cx.update_window(window, |_, window, _| window.remove_window())
                .unwrap();
        }
    }
    harness.close(cx);
}

#[gpui_kit::test]
fn import_language_search_keeps_file_controls_in_place(cx: &mut TestAppContext) {
    let harness = Harness::open(cx);
    for language in ["en", "ja"] {
        locale(&harness, language, cx);
        for width in [480., 1000.] {
            let dialog = harness.update(cx, |root, _, cx| {
                let backend = root.session.read(cx).backend.clone();
                let workspace = cx.new(|cx| import::ImportWorkspace::new(backend, cx));
                import::open(root.session.clone(), workspace, cx).unwrap()
            });
            cx.simulate_window_resize(dialog, size(px(width), px(780.)));
            harness.wait_window(cx, dialog, "import ready", |window| {
                window.find("import-pick").disabled() != Some(true)
            });
            let before = bounds(cx, dialog, "import-pick");
            for text in ["", "language-with-no-match", "a", "en"] {
                cx.update_window(dialog, |_, window, app| {
                    let label = if language == "ja" {
                        "学習する言語"
                    } else {
                        "Learning language"
                    };
                    let position = window.find_by_label(label).bounds().center();
                    window.pointer_down(position, gpui_kit::MouseButton::Left, app);
                    window.pointer_up(position, gpui_kit::MouseButton::Left, app);
                    window.press("ctrl-a", app);
                    window.press("backspace", app);
                    if !text.is_empty() {
                        window.input(text, app);
                    }
                })
                .unwrap();
                harness.wait_window(cx, dialog, "language search updated", |window| {
                    window
                        .find_by_label(if language == "ja" {
                            "学習する言語"
                        } else {
                            "Learning language"
                        })
                        .value()
                        == Some(text)
                });
                assert_eq!(
                    before,
                    bounds(cx, dialog, "import-pick"),
                    "suggestions moved file picker: {language}, {text}"
                );
            }
            cx.update_window(dialog, |_, window, _| window.remove_window())
                .unwrap();
        }
    }
    harness.close(cx);
}

#[gpui_kit::test]
fn source_save_completion_keeps_action_bounds(cx: &mut TestAppContext) {
    let harness = Harness::open(cx);
    for language in ["en", "ja"] {
        locale(&harness, language, cx);
        for width in [420., 850.] {
            let cues =
                commands::subtitles::list_segments(&harness.state, "ui-media".into()).unwrap();
            harness.update(cx, |root, _, cx| {
                source_form::open_with_term(
                    root.session.clone(),
                    root.sources.clone(),
                    "subtitle",
                    vec![cues[0].clone()],
                    None,
                    cx,
                )
                .unwrap();
            });
            let dialog = cx.read(|app| {
                app.windows()
                    .into_iter()
                    .find(|window| *window != harness.window)
                    .unwrap()
            });
            cx.simulate_window_resize(dialog, size(px(width), px(780.)));
            harness.wait_window(cx, dialog, "source ready", |window| {
                window.find("save-source").disabled() != Some(true)
            });
            let before_close = bounds(cx, dialog, "close-source");
            let before_save = bounds(cx, dialog, "save-source");
            let before_viewport = bounds(cx, dialog, "source-editor-scroll");
            cx.update_window(dialog, |_, window, app| window.click("save-source", app))
                .unwrap();
            harness.wait_window(cx, dialog, "source saved", |window| {
                window.find("close-source").label()
                    == Some(if language == "ja" {
                        "閉じる"
                    } else {
                        "Close"
                    })
            });
            assert_eq!(
                before_close,
                bounds(cx, dialog, "close-source"),
                "save completion moved close: {language}, {width}"
            );
            assert_eq!(before_save, bounds(cx, dialog, "save-source"));
            assert_eq!(
                before_viewport,
                bounds(cx, dialog, "source-editor-scroll"),
                "save status resized editor viewport: {language}, {width}"
            );
            cx.update_window(dialog, |_, window, _| window.remove_window())
                .unwrap();
        }
    }
    harness.close(cx);
}

#[gpui_kit::test]
fn settings_autosave_and_freeze_preserve_the_form_viewport(cx: &mut TestAppContext) {
    let harness = Harness::open(cx);
    for language in ["en", "ja"] {
        locale(&harness, language, cx);
        for width in [480., 1280.] {
            let window = settings_window(&harness, width, cx);
            let before = bounds(cx, window, "settings-scroll");
            let backend = cx.read(|app| harness.view.read(app).session.read(app).backend.clone());
            backend.exclusive.store(true, Ordering::Release);
            assert_eq!(
                before,
                bounds(cx, window, "settings-scroll"),
                "freeze resized form viewport: {language}, {width}"
            );
            backend.exclusive.store(false, Ordering::Release);
            // Autosave persists the raw draft in workspace.sqlite before the
            // preferences.json commit; learning.sqlite does not block this save.
            let database =
                rusqlite::Connection::open(harness.root.path().join("workspace.sqlite")).unwrap();
            database.execute_batch("BEGIN IMMEDIATE").unwrap();
            cx.update_window(window, |_, window, app| {
                window.click("settings-learningLanguage", app);
                window.press("ctrl-a", app);
                window.input("fr", app);
                window.click("settings-explanationLanguage", app);
            })
            .unwrap();
            harness.wait(cx, "settings save in flight", |root, app| {
                let registry = root.editors.read(app);
                registry
                    .key_for("settings", "default")
                    .and_then(|key| registry.view(&key))
                    .is_some_and(|view| {
                        view.saving
                            && view
                                .fields
                                .get("learningLanguage")
                                .is_some_and(|raw| raw == "fr")
                    })
            });
            assert_eq!(harness.state.settings().unwrap().learning_language, "en");
            assert_eq!(
                before,
                bounds(cx, window, "settings-scroll"),
                "saving resized form viewport: {language}, {width}"
            );
            database.execute_batch("COMMIT").unwrap();
            harness.wait(cx, "settings save finished", |root, app| {
                !root.editors.read(app).pending()
            });
            cx.read(|app| {
                let registry = harness.view.read(app).editors.read(app);
                let key = registry.key_for("settings", "default").unwrap();
                let view = registry.view(&key).unwrap();
                assert!(
                    !view.saving && !view.dirty && view.error.is_none(),
                    "autosave did not finish cleanly: {language}, {width}: {view:?}"
                );
                assert_eq!(view.fields["learningLanguage"], "fr");
            });
            let saved: crate::application::Preferences = serde_json::from_reader(
                std::fs::File::open(harness.root.path().join("preferences.json")).unwrap(),
            )
            .unwrap();
            assert_eq!(saved.settings.learning_language, "fr");
            assert_eq!(before, bounds(cx, window, "settings-scroll"));
            cx.update_window(window, |_, window, _| window.remove_window())
                .unwrap();
            // Give each repetition a real change to save.
            let mut settings = harness.state.settings().unwrap();
            settings.learning_language = "en".into();
            commands::models::update_settings(&harness.state, settings).unwrap();
            harness.update(cx, |root, _, cx| {
                let key = root
                    .editors
                    .read(cx)
                    .key_for("settings", "default")
                    .unwrap();
                root.editors.update(cx, |registry, cx| {
                    registry.refresh(&key, cx);
                });
            });
            harness.wait(cx, "settings reset", |root, app| {
                !root.editors.read(app).pending()
            });
        }
    }
    harness.close(cx);
}

#[gpui_kit::test]
fn completed_imports_preserve_row_bounds(cx: &mut TestAppContext) {
    let harness = Harness::open(cx);
    for language in ["en", "ja"] {
        locale(&harness, language, cx);
        for width in [480., 1000.] {
            let (dialog, workspace) = harness.update(cx, |root, _, cx| {
                let backend = root.session.read(cx).backend.clone();
                let workspace = cx.new(|cx| import::ImportWorkspace::new(backend, cx));
                let dialog = import::open(root.session.clone(), workspace.clone(), cx).unwrap();
                (dialog, workspace)
            });
            cx.simulate_window_resize(dialog, size(px(width), px(1000.)));
            harness.wait(cx, "import workspace ready", |_, app| {
                workspace.read(app).view().ready
            });
            let paths: Vec<_> = ["one", "two"]
                .iter()
                .map(|name| {
                    let path = harness
                        .root
                        .path()
                        .join(format!("{language}-{width}-{name}.mp4"));
                    std::fs::write(&path, b"import fixture; never decoded").unwrap();
                    path.to_string_lossy().into_owned()
                })
                .collect();
            cx.update(|app| {
                workspace.update(app, |workspace, cx| {
                    workspace.clear(cx);
                    workspace.add(paths, false, cx);
                })
            });
            harness.wait(cx, "reviewable files", |_, app| {
                let view = workspace.read(app).view();
                view.rows.len() == 2
                    && view
                        .rows
                        .iter()
                        .all(|row| row.status == import::Status::Ready)
            });
            let row_ids: Vec<_> = cx.read(|app| {
                workspace
                    .read(app)
                    .view()
                    .rows
                    .iter()
                    .map(|row| row.id)
                    .collect()
            });
            let measure = |cx: &mut TestAppContext| {
                cx.update_window(dialog, |_, window, app| {
                    window.render_frame(app);
                    row_ids
                        .iter()
                        .map(|id| window.find(("import-row", *id as usize)).bounds())
                        .collect::<Vec<_>>()
                })
                .unwrap()
            };
            let before = measure(cx);
            cx.update(|app| workspace.update(app, |workspace, cx| workspace.submit(cx)));
            harness.wait(cx, "imported files", |_, app| {
                workspace
                    .read(app)
                    .view()
                    .rows
                    .iter()
                    .all(|row| row.status == import::Status::Imported)
            });
            assert_eq!(
                before,
                measure(cx),
                "completed rows moved: {language}, {width}"
            );
            cx.update_window(dialog, |_, window, _| window.remove_window())
                .unwrap();
        }
    }
    harness.close(cx);
}
