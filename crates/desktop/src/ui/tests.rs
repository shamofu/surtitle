// SPDX-License-Identifier: GPL-3.0-or-later
//! Actual components and services with GPUI's fake platform. No OS windows/input,
//! native renderer/player, production profile, credential or provider is used.
use super::*;
mod activity;
mod card_dialog;
mod form_stability;
mod keyboard;
mod layout_stability;
mod library_playback;
mod study_accessibility;
mod study_fullscreen;
mod study_layout;
mod study_toggles;
mod study_wheel;
use crate::{
    application::{Services, changes::ChangeDomain},
    commands,
};
use gpui_kit::{
    AnyWindowHandle, App, Bounds, ScrollDelta, TestAppContext, WindowBounds, WindowOptions,
    base::Root,
    point, size,
    test::{TestQueryExt, TestWindowExt},
};
use std::{
    sync::{atomic::Ordering, mpsc},
    time::{Duration, Instant},
};
use surtitle_core::{Media, Store, StudyCard, SubtitleSegment};

struct Harness {
    window: AnyWindowHandle,
    view: Entity<DesktopView>,
    state: AppState,
    host: DesktopHost,
    root: tempfile::TempDir,
}

#[gpui_kit::test]
fn candidate_creation_waits_for_unsaved_source_input_and_preserves_it(cx: &mut TestAppContext) {
    let harness = Harness::open(cx);
    let cues = commands::subtitles::list_segments(&harness.state, "ui-media".into()).unwrap();
    let media = Store::open(harness.root.path().join("learning.sqlite"))
        .unwrap()
        .media("ui-media")
        .unwrap();
    let signature = serde_json::to_string(&(
        &media.path,
        media.audio_stream_index,
        &media.learning_language,
        &media.explanation_language,
    ))
    .unwrap();
    let cue = cues[0].clone();
    let candidate = crate::application::ai::VocabularyCandidate {
        id: "candidate-with-unfinished-source".into(),
        media_id: media.id.clone(),
        segment_id: cue.id.clone(),
        source_cue_ids: vec![cue.id.clone()],
        start_ms: cue.start_ms,
        end_ms: cue.end_ms,
        term: "Candidate must not replace raw input".into(),
        meaning: "Candidate meaning".into(),
        example: cue.text.clone(),
        translation: cue.translation.clone(),
        explanation: String::new(),
    };
    let key = harness.update(cx, |root, _, cx| {
        root.sources
            .update(cx, |sources, cx| {
                sources.ensure(
                    source_editors::SourceOptions {
                        media_id: media.id.clone(),
                        kind: "phrase".into(),
                        source_key: serde_json::to_string(&vec![cue.id.clone()]).unwrap(),
                        source_cues: vec![cue.clone()],
                        initial: [
                            ("term".into(), String::new()),
                            ("meaning".into(), String::new()),
                            ("example".into(), cue.text.clone()),
                            ("explanation".into(), String::new()),
                        ]
                        .into(),
                        resume: None,
                    },
                    cx,
                )
            })
            .unwrap()
    });
    harness.wait(cx, "source input ready", |root, app| {
        root.sources
            .read(app)
            .view(&key)
            .is_some_and(|view| view.ready)
    });
    let database = rusqlite::Connection::open(harness.root.path().join("learning.sqlite")).unwrap();
    database.execute_batch("BEGIN IMMEDIATE").unwrap();
    let mut reply = harness.update(cx, |root, _, cx| {
        let mut fields = root.sources.read(cx).view(&key).unwrap().fields.clone();
        fields.insert("term".into(), "  私の入力は保持する  ".into());
        root.sources
            .update(cx, |sources, cx| assert!(sources.change(&key, fields, cx)));
        root.session.update(cx, |session, cx| {
            session.prepare_candidate(candidate, vec![cue], signature, cx)
        })
    });
    harness.wait(cx, "candidate owns the combined gate", |root, _| {
        root.transfer_pending
    });
    assert!(matches!(
        reply.try_recv(),
        Err(tokio::sync::oneshot::error::TryRecvError::Empty)
    ));
    database.execute_batch("COMMIT").unwrap();
    harness.wait(
        cx,
        "candidate collision completes after raw flush",
        |root, _| !root.transfer_pending,
    );
    let error = reply.try_recv().unwrap().unwrap_err();
    assert!(error.contains("unfinished phrase input"), "{error}");
    let drafts = commands::editor_drafts::list_editor_drafts(&harness.state, media.id).unwrap();
    assert_eq!(drafts.len(), 1);
    assert_eq!(drafts[0].draft.fields["term"], "  私の入力は保持する  ");
    assert!(!cx.read(|app| harness.view.read(app).sources.read(app).frozen()));
    harness.close(cx);
}

impl Harness {
    fn open(cx: &mut TestAppContext) -> Self {
        Self::open_with_dispatch(cx, |task| {
            task();
            Ok(())
        })
    }

    fn open_with_dispatch(
        cx: &mut TestAppContext,
        dispatch: impl Fn(crate::runtime::MainThreadTask) -> anyhow::Result<()> + Send + Sync + 'static,
    ) -> Self {
        // These integration tests intentionally combine the fake GUI executor
        // with real Tokio/SQLite IO; the scheduler's supported parking mode
        // permits worker-thread wakeups without pretending IO is deterministic.
        cx.executor().allow_parking();
        let root = tempfile::tempdir().unwrap();
        seed(root.path());
        let runtime = crate::runtime::test_runtime();
        let state = Services::open_with_runtime(root.path().to_owned(), runtime.clone()).unwrap();
        let mut settings = state.settings().unwrap();
        settings.locale = "en".into();
        commands::models::update_settings(&state, settings).unwrap();
        // An unfinished local flow gives Activity real content without a quote,
        // job, credential, provider request or execution authority.
        commands::continuations::save_ai_continuation(
            &state,
            serde_json::from_value(serde_json::json!({
                "id": "ui-flow", "mediaId": "ui-media", "kind": "translate",
                "start": "00:00", "end": "00:00.900", "wholeMedia": false, "focusTerm": ""
            }))
            .unwrap(),
        )
        .unwrap();
        let (send, events) = mpsc::channel();
        let host = DesktopHost::new(
            runtime,
            dispatch,
            |_| Ok(()),
            move |event| {
                let _ = send.send(event);
            },
        );
        let changes_host = host.clone();
        state
            .changes
            .install(move |change| changes_host.emit(DesktopEvent::DataChanged(change.clone())))
            .unwrap();
        let (window, view) = cx.update(|app| {
            gpui_kit::init(app);
            app.set_reduce_motion(true);
            gpui_kit::open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(Bounds {
                        origin: Default::default(),
                        size: size(px(1600.), px(1000.)),
                    })),
                    ..Default::default()
                },
                app,
                |window, app| {
                    app.new(|cx| {
                        DesktopView::new(
                            root.path().to_owned(),
                            state.clone(),
                            host.clone(),
                            events,
                            window,
                            cx,
                        )
                    })
                },
            )
            .unwrap()
        });
        let this = Self {
            window,
            view,
            state,
            host,
            root,
        };
        this.wait(cx, "initial snapshot and settings editor", |view, app| {
            view.session.read(app).snapshot.is_some()
                && !view.editors.read(app).pending()
                && view
                    .editors
                    .read(app)
                    .key_for("settings", "default")
                    .and_then(|key| view.editors.read(app).view(&key))
                    .is_some_and(|editor| editor.ready)
        });
        let backend = cx.read(|app| this.view.read(app).session.read(app).backend.clone());
        let in_flight = backend.in_flight.clone();
        let ready = backend
            .host
            .runtime()
            .spawn(async move { in_flight.drained().await });
        this.wait(cx, "initial route data callbacks", |_, _| {
            ready.is_finished()
        });
        backend.host.runtime().block_on(ready).unwrap();
        this
    }

    fn wait(
        &self,
        cx: &mut TestAppContext,
        description: &str,
        ready: impl Fn(&DesktopView, &App) -> bool,
    ) {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            // Tokio owns real service IO, while GPUI's scheduler owns callbacks
            // and frame timers. Advance only the fake clock and yield briefly
            // while checking an observable condition rather than sleeping to pass.
            cx.executor().advance_clock(Duration::from_millis(20));
            cx.run_until_parked();
            if cx.read(|app| ready(self.view.read(app), app)) {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "timed out waiting for {description}"
            );
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    fn update<R>(
        &self,
        cx: &mut TestAppContext,
        update: impl FnOnce(&mut DesktopView, &mut Window, &mut Context<DesktopView>) -> R,
    ) -> R {
        cx.update_window(self.window, |_, window, app| {
            self.view.update(app, |view, cx| update(view, window, cx))
        })
        .unwrap()
    }

    fn route(&self, cx: &mut TestAppContext, nav: &'static str) {
        cx.update_window(self.window, |_, window, app| window.click(nav, app))
            .unwrap();
        cx.run_until_parked();
    }

    fn activity_window(&self, cx: &TestAppContext) -> AnyWindowHandle {
        cx.read(|app| self.view.read(app).activity_dialog.unwrap())
    }

    fn drain_callbacks(&self, cx: &mut TestAppContext) {
        let backend = cx.read(|app| self.view.read(app).session.read(app).backend.clone());
        let operations = backend.in_flight.clone();
        let drained = backend
            .host
            .runtime()
            .spawn(async move { operations.drained().await });
        self.wait(cx, "admitted service callbacks", |_, _| {
            drained.is_finished()
        });
        backend.host.runtime().block_on(drained).unwrap();
    }

    fn wait_window(
        &self,
        cx: &mut TestAppContext,
        window: AnyWindowHandle,
        description: &str,
        ready: impl Fn(&Window) -> bool,
    ) {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            cx.executor().advance_clock(Duration::from_millis(20));
            cx.run_until_parked();
            if cx
                .update_window(window, |_, window, app| {
                    window.render_frame(app);
                    ready(window)
                })
                .unwrap()
            {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "timed out waiting for {description}"
            );
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    fn raw_settings(&self, cx: &TestAppContext, field: &str) -> String {
        cx.read(|app| {
            let registry = self.view.read(app).editors.read(app);
            let key = registry.key_for("settings", "default").unwrap();
            registry.view(&key).unwrap().fields[field].clone()
        })
    }

    fn type_language(&self, cx: &mut TestAppContext, raw: &str) {
        cx.update_window(self.window, |_, window, app| {
            window.click("settings-learningLanguage", app);
            window.press("ctrl-a", app);
            window.input(raw, app);
        })
        .unwrap();
        cx.run_until_parked();
    }

    fn replace_card(
        &self,
        cx: &mut TestAppContext,
        change: impl FnOnce(&mut StudyCard),
    ) -> StudyCard {
        let mut card = commands::cards::get_card_edit_state(&self.state, "ui-card".into())
            .unwrap()
            .card;
        change(&mut card);
        Store::open(self.root.path().join("learning.sqlite"))
            .unwrap()
            .put_card(&card)
            .unwrap();
        self.state
            .changes
            .publish(ChangeDomain::Cards, Some(card.id.clone()));
        self.wait(
            cx,
            "changed card snapshot and editor refresh",
            |root, app| {
                !root.editors.read(app).pending()
                    && root
                        .session
                        .read(app)
                        .snapshot
                        .as_ref()
                        .is_some_and(|snapshot| {
                            snapshot.cards.iter().any(|item| {
                                item.id == card.id
                                    && item.due_at == card.due_at
                                    && item.meaning == card.meaning
                            })
                        })
            },
        );
        card
    }

    fn close(self, cx: &mut TestAppContext) {
        let windows = cx.read(|app| app.windows());
        for window in windows {
            cx.update_window(window, |_, window, _| window.remove_window())
                .unwrap();
        }
        cx.run_until_parked();
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        self.host.shutdown();
        self.state.shutdown();
    }
}

fn seed(root: &std::path::Path) {
    let file = root.join("local-fixture.mp4");
    std::fs::write(&file, b"UI model fixture; never decoded").unwrap();
    let mut store = Store::open(root.join("learning.sqlite")).unwrap();
    let media = Media {
        id: "ui-media".into(),
        title: "Local practice".into(),
        path: file.to_string_lossy().into_owned(),
        kind: "video".into(),
        duration_ms: 1000,
        learning_language: "en".into(),
        explanation_language: "ja".into(),
        created_at: surtitle_core::now(),
        last_position_ms: 0,
        audio_stream_index: None,
        subtitle_stream_index: None,
        segment_count: 1,
        card_count: 1,
        status: "ready".into(),
        error: None,
    };
    store.put_media(&media).unwrap();
    let cue = SubtitleSegment {
        timing_precision: "cue".into(),
        id: "ui-cue".into(),
        media_id: media.id.clone(),
        start_ms: 0,
        end_ms: 900,
        text: "Make yourself at home.".into(),
        translation: Some("くつろいでください。".into()),
        status: "confirmed".into(),
        review_issues: vec![],
    };
    store
        .set_segments(&media.id, std::slice::from_ref(&cue))
        .unwrap();
    store.insert_draft_study_selection(&serde_json::from_value(serde_json::json!({
        "id":"ui-selection", "mediaId":media.id, "jobId":null, "version":1,
        "text":cue.text, "startMs":0, "endMs":900, "sourceStartMs":0, "sourceEndMs":1000,
        "cueIds":[cue.id], "ordinal":null, "origin":"manual", "timing":"cue",
        "confirmed":true, "createdAt":"", "updatedAt":"", "sourceSnapshot":{"isolatedFixture":true}
    })).unwrap()).unwrap();
    store
        .put_card(&StudyCard {
            id: "ui-card".into(),
            media_id: media.id,
            segment_id: cue.id.clone(),
            source_cues: vec![cue.clone()],
            term: "at home".into(),
            meaning: "くつろいで".into(),
            example: cue.text,
            language: "en".into(),
            due_at: "2000-01-01T00:00:00Z".into(),
            created_at: surtitle_core::now(),
            review_count: 0,
            audio_path: None,
            audio_clip_range: None,
            audio_stream_index: None,
            suspended: false,
            translation: cue.translation,
            explanation: None,
            source_title: media.title,
            start_ms: 0,
            end_ms: 900,
            memory: None,
            last_review: None,
        })
        .unwrap();
}

#[gpui_kit::test]
fn root_routes_render_actual_components_and_review_reveal(cx: &mut TestAppContext) {
    let harness = Harness::open(cx);
    assert_eq!(
        harness
            .window
            .downcast::<Root>()
            .unwrap()
            .read_with(cx, |root, _| root.view().entity_id())
            .unwrap(),
        harness.view.entity_id()
    );
    for (nav, route, target) in [
        ("library", Route::Library, "open-import"),
        ("cards", Route::Cards, "card-search"),
        ("review", Route::Review, "review-reveal"),
        ("settings", Route::Settings, "settings-learningLanguage"),
    ] {
        harness.route(cx, nav);
        assert_eq!(cx.read(|app| harness.view.read(app).route.clone()), route);
        cx.update_window(harness.window, |_, window, app| {
            window.render_frame(app);
            assert!(
                window.find(target).visible(),
                "{nav} must render its actual component"
            );
            if nav == "review" {
                assert!(window.try_find("good").is_none());
                window.click("review-reveal", app);
                window.render_frame(app);
                assert!(window.find("good").visible());
            }
        })
        .unwrap();
    }
    harness.route(cx, "activity");
    assert_eq!(
        cx.read(|app| harness.view.read(app).route.clone()),
        Route::Settings
    );
    harness.wait_window(
        cx,
        harness.activity_window(cx),
        "Activity opens beside the current page",
        |window| {
            window
                .try_find("resume-ui-flow")
                .is_some_and(|item| item.visible())
        },
    );
    cx.update_window(harness.activity_window(cx), |_, window, app| {
        window.press("escape", app)
    })
    .unwrap();
    harness.wait(
        cx,
        "Activity closes without navigating away",
        |view, app| app.windows().len() == 1 && view.route == Route::Settings,
    );
    let snapshot = commands::ai::get_app_snapshot(&harness.state).unwrap();
    assert_eq!(snapshot.cards[0].review_count, 0);
    assert!(
        snapshot.jobs.is_empty(),
        "rendering saved AI input must never start a job"
    );
    harness.close(cx);
}

#[gpui_kit::test]
fn input_edit_events_keep_newer_typing_after_delayed_autosave_and_navigation(
    cx: &mut TestAppContext,
) {
    let harness = Harness::open(cx);
    harness.route(cx, "settings");
    let lock = rusqlite::Connection::open(harness.root.path().join("workspace.sqlite")).unwrap();
    lock.execute_batch("BEGIN IMMEDIATE").unwrap();
    harness.type_language(cx, "de");
    assert_eq!(
        harness.raw_settings(cx, "learningLanguage"),
        "de",
        "real InputEditsEvent must reach the editor"
    );
    harness.wait(cx, "delayed automatic settings save", |view, app| {
        let registry = view.editors.read(app);
        registry
            .key_for("settings", "default")
            .and_then(|key| registry.view(&key))
            .is_some_and(|editor| editor.saving)
    });
    harness.type_language(cx, "fr");
    assert_eq!(harness.raw_settings(cx, "learningLanguage"), "fr");
    harness.route(cx, "cards");
    lock.execute_batch("ROLLBACK").unwrap();
    harness.wait(
        cx,
        "newer settings reaching durable preferences",
        |view, app| {
            let registry = view.editors.read(app);
            !registry.pending() && harness.state.settings().unwrap().learning_language == "fr"
        },
    );
    harness.route(cx, "settings");
    assert_eq!(harness.raw_settings(cx, "learningLanguage"), "fr");
    cx.update_window(harness.window, |_, window, app| {
        window.render_frame(app);
        assert_eq!(window.find("settings-learningLanguage").value(), Some("fr"));
    })
    .unwrap();
    harness.close(cx);
}

#[gpui_kit::test]
fn export_and_restore_failure_keep_combined_gate_until_all_in_flight_callbacks_drain(
    cx: &mut TestAppContext,
) {
    for purpose in [FlushPurpose::Export, FlushPurpose::Restore] {
        let harness = Harness::open(cx);
        harness.route(cx, "settings");
        let missing = harness.update(cx, |root, _, cx| {
            root.editors
                .update(cx, |editors, cx| editors.ensure("card", "deleted-card", cx))
                .unwrap()
        });
        harness.wait(cx, "deleted-card load failure", |root, app| {
            root.editors
                .read(app)
                .view(&missing)
                .is_some_and(|view| view.error.is_some())
        });
        let backend = cx.read(|app| harness.view.read(app).session.read(app).backend.clone());
        let held = backend.in_flight.begin();
        let flush = harness.update(cx, |root, _, cx| root.flush_all(purpose, cx));
        let task = backend.host.runtime().spawn(flush);
        harness.wait(cx, "failed editor batch collection", |root, app| {
            !root.editors.read(app).pending()
        });
        assert!(
            !task.is_finished(),
            "an editor error must not bypass another in-flight operation"
        );
        assert!(backend.exclusive.load(Ordering::Acquire));
        harness.route(cx, "cards");
        assert_eq!(
            cx.read(|app| harness.view.read(app).route.clone()),
            Route::Settings
        );
        let second = harness.update(cx, |root, _, cx| root.flush_all(purpose, cx));
        assert!(backend.host.runtime().block_on(second).is_err());
        drop(held);
        harness.wait(cx, "combined failed gate after operation drain", |_, _| {
            task.is_finished()
        });
        assert!(backend.host.runtime().block_on(task).unwrap().is_err());
        assert!(
            backend.exclusive.load(Ordering::Acquire),
            "the owning transfer must release the gate explicitly"
        );
        harness.update(cx, |root, _, cx| root.resume(cx));
        assert!(!backend.exclusive.load(Ordering::Acquire));
        assert!(!cx.read(|app| harness.view.read(app).editors.read(app).frozen()));
        harness.close(cx);
    }
}

#[gpui_kit::test]
fn successful_bookmark_card_callback_consumes_its_draft_before_the_combined_gate_finishes(
    cx: &mut TestAppContext,
) {
    let harness = Harness::open(cx);
    let key = harness.update(cx, |root, _, cx| {
        root.editors
            .update(cx, |editors, cx| {
                editors.ensure("draft_card", "ui-selection", cx)
            })
            .unwrap()
    });
    harness.wait(cx, "card editing source", |root, app| {
        root.editors
            .read(app)
            .view(&key)
            .is_some_and(|view| view.ready)
    });
    harness.update(cx, |root, _, cx| {
        assert!(root.editors.update(cx, |editors, cx| {
            editors.change(
                &key,
                [
                    ("term".into(), "newly submitted phrase".into()),
                    ("meaning".into(), "saved by the domain submission".into()),
                ]
                .into(),
                cx,
            )
        }));
    });
    harness.wait(cx, "durable raw card input before submission", |_, _| {
        commands::ui_drafts::get_ui_draft(
            &harness.state,
            "draft_card".into(),
            "ui-selection".into(),
        )
        .unwrap()
        .is_some()
    });
    let fields = cx.read(|app| {
        let registry = harness.view.read(app).editors.read(app);
        registry.view(&key).unwrap().fields.clone()
    });
    let learning = harness.root.path().join("learning.sqlite");
    let completed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let delivered = completed.clone();
    let (submit, submitted) = tokio::sync::oneshot::channel::<()>();
    let callback_key = key.clone();
    harness.update(cx, |root, _, cx| {
        let backend = root.session.read(cx).backend.clone();
        session::run(
            &backend,
            cx,
            async move {
                submitted.await.map_err(|error| error.to_string())?;
                // Exercise the real card transaction without decoding audio or
                // invoking a player. This test targets submission/callback order.
                Store::open(learning)
                    .and_then(|store| {
                        store.save_draft_selection_card(
                            "ui-selection",
                            1,
                            &surtitle_core::DraftStudyCardFields {
                                term: fields["term"].clone(),
                                meaning: fields["meaning"].clone(),
                                example: String::new(),
                                explanation: None,
                                translation: None,
                            },
                            None,
                            None,
                        )
                    })
                    .map_err(|error| error.to_string())
            },
            move |root, result, cx| {
                assert_eq!(
                    result
                        .expect("the actual isolated card creation succeeded")
                        .term,
                    "newly submitted phrase"
                );
                root.editors.update(cx, |editors, cx| {
                    assert!(
                        editors.reset_draft(&callback_key, cx).is_none(),
                        "ordinary input actions stay blocked by the external gate"
                    );
                    assert!(
                        editors.complete_submission(&callback_key, cx).is_some(),
                        "the admitted domain completion must still consume its own input"
                    );
                });
                delivered.store(true, Ordering::Release);
            },
        );
    });
    let backend = cx.read(|app| harness.view.read(app).session.read(app).backend.clone());
    let flush = harness.update(cx, |root, _, cx| root.flush_all(FlushPurpose::Export, cx));
    let gate = backend.host.runtime().spawn(flush);
    assert!(backend.exclusive.load(Ordering::Acquire));
    assert!(!gate.is_finished());

    // Delay the real draft deletion after the admitted domain write finishes.
    // The root must collect both that callback and its persistence cleanup.
    let lock = rusqlite::Connection::open(harness.root.path().join("workspace.sqlite")).unwrap();
    lock.execute_batch("BEGIN IMMEDIATE").unwrap();
    submit.send(()).unwrap();
    harness.wait(
        cx,
        "successful domain completion under the external gate",
        |_, _| completed.load(Ordering::Acquire),
    );
    assert!(
        !gate.is_finished(),
        "completion notification is not completion of durable draft cleanup"
    );
    assert!(backend.exclusive.load(Ordering::Acquire));
    lock.execute_batch("ROLLBACK").unwrap();
    harness.wait(
        cx,
        "domain callback and draft deletion collected",
        |_, _| gate.is_finished(),
    );
    backend.host.runtime().block_on(gate).unwrap().unwrap();
    assert!(
        commands::ui_drafts::get_ui_draft(
            &harness.state,
            "draft_card".into(),
            "ui-selection".into()
        )
        .unwrap()
        .is_none()
    );
    let snapshot = commands::ai::get_app_snapshot(&harness.state).unwrap();
    assert_eq!(snapshot.cards.len(), 2);
    assert!(
        snapshot
            .cards
            .iter()
            .any(|card| card.term == "newly submitted phrase"
                && card.meaning == "saved by the domain submission")
    );
    harness.update(cx, |root, _, cx| root.resume(cx));
    harness.close(cx);
}

#[gpui_kit::test]
fn review_notifies_when_a_future_card_becomes_due_without_another_data_change(
    cx: &mut TestAppContext,
) {
    let harness = Harness::open(cx);
    let due = chrono::Utc::now() + chrono::Duration::milliseconds(350);
    let card = harness.replace_card(cx, |card| card.due_at = due.to_rfc3339());
    harness.route(cx, "review");
    cx.update_window(harness.window, |_, window, app| {
        window.render_frame(app);
        assert!(
            chrono::Utc::now() < due,
            "fixture must reach the waiting state before its due time"
        );
        assert!(window.try_find("review-reveal").is_none());
    })
    .unwrap();

    let notified = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let received = notified.clone();
    let review = cx.read(|app| harness.view.read(app).review.clone());
    let _subscription = cx.update(|app| {
        app.observe(&review, move |_, _| {
            if chrono::Utc::now() >= due {
                received.store(true, Ordering::Release);
            }
        })
    });
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut previous = Instant::now();
    // Do not force frames while waiting: doing so could make a broken due timer
    // look correct. Keep the fake timer clock aligned with real Utc instead.
    while !notified.load(Ordering::Acquire) {
        let current = Instant::now();
        cx.executor()
            .advance_clock(current.duration_since(previous));
        previous = current;
        cx.run_until_parked();
        assert!(
            Instant::now() < deadline,
            "review must invalidate itself when this card becomes due"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
    cx.update_window(harness.window, |_, window, app| {
        window.render_frame(app);
        assert!(window.find("review-reveal").visible());
    })
    .unwrap();
    assert_eq!(
        commands::cards::get_card_edit_state(&harness.state, "ui-card".into())
            .unwrap()
            .card
            .due_at,
        card.due_at
    );
    harness.close(cx);
}

#[gpui_kit::test]
fn long_review_answer_can_scroll_to_a_rating_and_persist_the_review(cx: &mut TestAppContext) {
    let harness = Harness::open(cx);
    let card = harness.replace_card(cx, |card| {
        card.meaning = (0..130)
            .map(|line| format!("Explanation line {line}: the saved answer remains readable.\n"))
            .collect();
        card.explanation = Some("Final saved note: this content must remain reachable.".into());
    });
    harness.route(cx, "review");
    cx.update_window(harness.window, |_, window, app| {
        window.click("review-reveal", app);
        window.render_frame(app);
        let meaning_top = window.find("review-meaning").bounds().origin.y;
        assert!(!window.find("review-explanation").visible());
        // Scroll actual saved answer content, without assuming whether grading
        // is below the answer or held in a fixed footer. No audio is played.
        window.scroll(
            "review-answer-scroll",
            ScrollDelta::Pixels(point(px(0.), px(-100_000.))),
            app,
        );
        assert!(
            window.find("review-explanation").visible(),
            "the final saved note must be reachable after scrolling the long answer"
        );
        assert!(window.find("review-meaning").bounds().origin.y < meaning_top);
        assert!(
            window.find("good").visible(),
            "grading must remain reachable after reading the long answer"
        );
        window.click("good", app);
    })
    .unwrap();
    harness.wait(cx, "actual review transaction", |_, _| {
        commands::cards::get_card_edit_state(&harness.state, "ui-card".into())
            .unwrap()
            .card
            .review_count
            == 1
    });
    let saved = commands::cards::get_card_edit_state(&harness.state, "ui-card".into())
        .unwrap()
        .card;
    assert_eq!(saved.meaning, card.meaning);
    assert!(chrono::DateTime::parse_from_rfc3339(&saved.due_at).unwrap() > chrono::Utc::now());
    harness.close(cx);
}

#[gpui_kit::test]
fn detached_bookmark_opens_safe_actions_without_creating_a_card_editor(cx: &mut TestAppContext) {
    let harness = Harness::open(cx);
    harness.update(cx, |root, window, cx| {
        root.ai.update(cx, |ai, cx| {
            ai.open_draft_study("ui-media".into(), window, cx)
        });
    });
    let backend = cx.read(|app| harness.view.read(app).session.read(app).backend.clone());
    let operations = backend.in_flight.clone();
    let loaded = backend
        .host
        .runtime()
        .spawn(async move { operations.drained().await });
    harness.wait(cx, "local bookmark list callback", |_, _| {
        loaded.is_finished()
    });
    backend.host.runtime().block_on(loaded).unwrap();
    let dialog = cx.read(|app| {
        app.windows()
            .into_iter()
            .find(|window| *window != harness.window)
            .unwrap()
    });
    cx.update_window(dialog, |_, window, app| {
        window.render_frame(app);
        window.click("open-bookmark-ui-selection", app);
        window.render_frame(app);
        assert!(window.find("detached-json").visible());
        assert!(window.find("detached-remove").visible());
        assert!(
            window.try_find("save-bookmark-card").is_none(),
            "an imported bookmark without a job must not open a submission form"
        );
    })
    .unwrap();
    assert!(
        cx.read(|app| harness
            .view
            .read(app)
            .editors
            .read(app)
            .key_for("draft_card", "ui-selection"))
            .is_none()
    );
    let snapshot = commands::ai::get_app_snapshot(&harness.state).unwrap();
    assert!(snapshot.jobs.is_empty());
    assert_eq!(snapshot.cards.len(), 1);
    harness.close(cx);
}

#[gpui_kit::test]
fn study_route_hides_previous_player_until_its_own_load_succeeds(cx: &mut TestAppContext) {
    let queued = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let dispatches = queued.clone();
    let harness = Harness::open_with_dispatch(cx, move |task| {
        dispatches.lock().unwrap().push(task);
        Ok(())
    });
    let previous = crate::player::PlayerState {
        revision: 40,
        media_id: Some("previous-media".into()),
        media_generation: 7,
        ready: true,
        paused: false,
        position_ms: 32_000,
        duration_ms: 90_000,
        video_width: 3840,
        video_height: 2160,
        ..Default::default()
    };
    harness
        .host
        .emit(DesktopEvent::PlayerState(previous.clone()));
    harness.wait(cx, "previous media playback event", |root, app| {
        root.session.read(app).player.revision == previous.revision
    });
    assert_eq!(
        cx.read(|app| harness.view.read(app).route.clone()),
        Route::Library
    );
    cx.update_window(harness.window, |_, window, app| {
        window.render_frame(app);
        window.click(("study", 0usize), app);
    })
    .unwrap();
    harness.wait(cx, "new media load waiting for GUI dispatch", |root, _| {
        root.route == Route::Study("ui-media".into()) && queued.lock().unwrap().len() == 1
    });
    cx.update_window(harness.window, |_, window, app| {
        window.render_frame(app);
        assert_study_playback_unavailable(window);
        assert!(window.try_find("retry-media-load").is_none());
        window.click("play-toggle", app);
        window.press("space", app);
        assert_study_playback_unavailable(window);
    })
    .unwrap();
    study_layout::assert_unavailable_playback_settings(&harness, cx);
    assert_eq!(
        queued.lock().unwrap().len(),
        1,
        "disabled playback must not dispatch controls"
    );
    assert_eq!(
        cx.read(|app| harness
            .view
            .read(app)
            .session
            .read(app)
            .player
            .media_id
            .clone()),
        previous.media_id,
        "the view must hide the retained old sample, not rely on deleting it"
    );

    // Execute the real service load on the fake GUI thread. No native player is
    // installed in this harness, so the service fails without decoding media.
    let load = queued.lock().unwrap().remove(0);
    cx.update(|_| load());
    harness.drain_callbacks(cx);
    cx.update_window(harness.window, |_, window, app| {
        window.render_frame(app);
        assert!(window.find("retry-media-load").visible());
        assert_study_playback_unavailable(window);
    })
    .unwrap();

    study_layout::assert_unavailable_playback_settings(&harness, cx);

    // Even a later ready sample for the selected ID cannot turn a failed load
    // into a success. Both the completed load and player identity are required.
    harness
        .host
        .emit(DesktopEvent::PlayerState(crate::player::PlayerState {
            revision: previous.revision + 1,
            media_id: Some("ui-media".into()),
            ..previous
        }));
    harness.wait(cx, "later player event after failed load", |root, app| {
        root.session.read(app).player.revision == 41
    });
    cx.update_window(harness.window, |_, window, app| {
        window.render_frame(app);
        assert_study_playback_unavailable(window);
    })
    .unwrap();
    harness.close(cx);
}

fn assert_study_playback_unavailable(window: &Window) {
    assert_eq!(window.find("playback-rate-trigger").disabled(), Some(true));
    for id in ["play-toggle", "back-five", "forward-five", "loop-selection"] {
        assert_eq!(window.find(id).disabled(), Some(true), "{id}");
    }
    assert_eq!(window.find("play-toggle").label(), Some("Play"));
    keyboard::assert_accessible_static_text(window, "player-metadata", "0:00 · 0 × 0");
}

#[gpui_kit::test]
fn study_route_search_marked_rows_and_long_text_keep_the_selected_source(cx: &mut TestAppContext) {
    let harness = Harness::open(cx);
    let original = commands::subtitles::list_segments(&harness.state, "ui-media".into())
        .unwrap()
        .remove(0);
    let cues = vec![
        SubtitleSegment {
            text: (0..40)
                .map(|line| {
                    format!("Long caption line {line}: the full source remains available.\n")
                })
                .collect(),
            ..original.clone()
        },
        SubtitleSegment {
            id: "ui-cue-second".into(),
            start_ms: 1000,
            end_ms: 1900,
            text: "A needle in the source text.".into(),
            translation: None,
            ..original.clone()
        },
        SubtitleSegment {
            id: "ui-cue-marked".into(),
            start_ms: 2000,
            end_ms: 2900,
            text: "The marked source must remain selected.".into(),
            translation: Some("Needle appears only in this translation.".into()),
            status: "generated_review".into(),
            ..original
        },
    ];
    let mut store = Store::open(harness.root.path().join("learning.sqlite")).unwrap();
    let mut media = store.media("ui-media").unwrap();
    media.duration_ms = 3000;
    store.put_media(&media).unwrap();
    store.set_segments(&media.id, &cues).unwrap();
    harness
        .state
        .changes
        .publish(ChangeDomain::Subtitles, Some(media.id));
    cx.update_window(harness.window, |_, window, app| {
        window.render_frame(app);
        window.click(("study", 0usize), app);
    })
    .unwrap();
    harness.wait_window(cx, harness.window, "actual Study subtitle rows", |window| {
        window
            .try_find("cue-select-ui-cue-marked")
            .is_some_and(|item| item.visible())
    });
    harness.drain_callbacks(cx);
    cx.update_window(harness.window, |_, window, app| {
        window.render_frame(app);
        let caption = window.find("caption-selection");
        assert!(caption.visible());
        assert!(caption.bounds().size.height <= px(126.));
        let scroll = window.find("cue-scroll-ui-cue");
        let before = window.find("cue-content-ui-cue").bounds();
        assert_eq!(scroll.label(), Some("Subtitle text"));
        assert!(scroll.visible());
        assert!(before.size.height > scroll.bounds().size.height);
        window.scroll(
            "cue-scroll-ui-cue",
            ScrollDelta::Pixels(point(px(0.), px(-120.))),
            app,
        );
        let after = window.find("cue-content-ui-cue").bounds();
        assert!(
            after.origin.y < before.origin.y,
            "long source text must scroll inside its row"
        );
        assert_eq!(window.find("cue-scroll-ui-cue").bounds(), scroll.bounds());
        assert!(
            window.find("cue-select-ui-cue").visible(),
            "row={:?}, scroll={:?}, select={:?}",
            window.find("cue-row-ui-cue"),
            window.find("cue-scroll-ui-cue"),
            window.find("cue-select-ui-cue")
        );

        window.click("subtitle-search", app);
        window.input("  NEEDLE ", app);
        assert_eq!(window.find("subtitle-search").value(), Some("  NEEDLE "));
    })
    .unwrap();
    // Input value changes before its deferred InputEvent reaches Study. Wait
    // for the actual projection rather than reading the same update's frame.
    harness.wait_window(cx, harness.window, "search projection", |window| {
        !study_row_visible(window, "ui-cue")
            && study_row_visible(window, "ui-cue-second")
            && study_row_visible(window, "ui-cue-marked")
    });
    cx.update_window(harness.window, |_, window, app| {
        window.click("marked-subtitles", app);
    })
    .unwrap();
    harness.wait_window(cx, harness.window, "marked search projection", |window| {
        !study_row_visible(window, "ui-cue")
            && !study_row_visible(window, "ui-cue-second")
            && study_row_visible(window, "ui-cue-marked")
    });
    cx.update_window(harness.window, |_, window, app| {
        window.click("cue-select-ui-cue-marked", app);
    })
    .unwrap();
    harness.wait_window(cx, harness.window, "marked source selected", |window| {
        window.find("cue-select-ui-cue-marked").label() == Some("Deselect")
    });
    cx.update_window(harness.window, |_, window, app| {
        window.click("reset-subtitle-filters", app);
    })
    .unwrap();
    harness.wait_window(
        cx,
        harness.window,
        "reset preserves source selection",
        |window| {
            window.find("subtitle-search").value() == Some("")
                && ["ui-cue", "ui-cue-second", "ui-cue-marked"]
                    .into_iter()
                    .all(|id| study_row_visible(window, id))
        },
    );
    cx.update_window(harness.window, |_, window, app| {
        assert_eq!(
            window.find("cue-select-ui-cue-marked").label(),
            Some("Deselect")
        );
        window.click("explore-meaning", app);
    })
    .unwrap();
    harness.wait_window(
        cx,
        harness.window,
        "selected source meaning panel",
        |window| {
            window
                .try_find("edit-subtitle")
                .is_some_and(|button| button.visible())
        },
    );
    cx.update_window(harness.window, |_, window, app| {
        window.click("edit-subtitle", app)
    })
    .unwrap();
    harness.wait(cx, "selected source editor window", |_, app| {
        app.windows().len() == 2
    });
    let dialog = cx.read(|app| {
        app.windows()
            .into_iter()
            .find(|window| *window != harness.window)
            .unwrap()
    });
    harness.wait_window(cx, dialog, "selected source text loaded", |window| {
        window
            .try_find_by_label("Subtitle")
            .is_some_and(|field| field.value() == Some(cues[2].text.as_str()))
    });
    cx.update_window(dialog, |_, window, app| {
        window.render_frame(app);
        assert_eq!(
            window.find_by_label("Subtitle").value(),
            Some(cues[2].text.as_str())
        );
        assert_eq!(
            window.find_by_label("Translation").value(),
            cues[2].translation.as_deref()
        );
    })
    .unwrap();
    assert_eq!(
        serde_json::to_value(
            commands::subtitles::list_segments(&harness.state, "ui-media".into()).unwrap()
        )
        .unwrap(),
        serde_json::to_value(cues).unwrap()
    );
    assert!(
        commands::ai::get_app_snapshot(&harness.state)
            .unwrap()
            .jobs
            .is_empty()
    );
    harness.close(cx);
}

fn study_row_visible(window: &Window, cue: &str) -> bool {
    window
        .try_find(format!("cue-select-{cue}"))
        .is_some_and(|row| row.visible())
}

#[gpui_kit::test]
fn study_export_opens_subtitle_formats_for_the_current_media(cx: &mut TestAppContext) {
    let harness = Harness::open(cx);
    cx.update_window(harness.window, |_, window, app| {
        window.render_frame(app);
        window.click(("study", 0usize), app);
    })
    .unwrap();
    harness.wait(cx, "Study route for subtitle export", |root, _| {
        root.route == Route::Study("ui-media".into())
    });
    cx.update_window(harness.window, |_, window, app| {
        window.render_frame(app);
        window.click("study-tools", app);
    })
    .unwrap();
    harness.wait_window(cx, harness.window, "Study export tools", |window| {
        window
            .try_find("study-export")
            .is_some_and(|button| button.visible())
    });
    cx.update_window(harness.window, |_, window, app| {
        window.click("study-export", app)
    })
    .unwrap();
    harness.wait(cx, "media export dialog", |_, app| app.windows().len() == 2);
    let dialog = cx.read(|app| {
        app.windows()
            .into_iter()
            .find(|window| *window != harness.window)
            .unwrap()
    });
    harness.wait_window(cx, dialog, "media subtitle export formats", |window| {
        window.try_find("srt").is_some() && window.try_find("vtt").is_some()
    });
    cx.update_window(dialog, |_, window, app| {
        window.render_frame(app);
        assert_eq!(window.find("srt").label(), Some("✓ SRT · Subtitles"));
        assert!(window.find("srt").visible());
        assert!(window.find("vtt").visible());
        window.click("vtt", app);
        assert_eq!(window.find("vtt").label(), Some("✓ WebVTT · Subtitles"));
        assert_eq!(window.find("srt").label(), Some("SRT · Subtitles"));
        // Select formats only: exporting would open a real native file dialog.
    })
    .unwrap();
    harness.close(cx);
}

// The existing non-Windows e2e player executes real media-bound commands while
// keeping the fake GPUI test independent of libmpv, OS windows and decoding.
#[cfg(all(not(windows), feature = "e2e-test"))]
#[gpui_kit::test]
fn study_rate_slider_executes_fine_and_fast_rates_for_the_loaded_media(cx: &mut TestAppContext) {
    use gpui_kit::test::TestEventExt;
    let queued = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let delay = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let dispatches = queued.clone();
    let delayed = delay.clone();
    let harness = Harness::open_with_dispatch(cx, move |task| {
        if delayed.load(Ordering::SeqCst) {
            dispatches.lock().unwrap().push(task);
        } else {
            task();
        }
        Ok(())
    });
    harness
        .state
        .initialize_player(harness.root.path(), 0, || {})
        .unwrap();
    cx.update_window(harness.window, |_, window, app| {
        window.render_frame(app);
        window.click(("study", 0usize), app);
    })
    .unwrap();
    harness.drain_callbacks(cx);
    let player = harness.state.player_state().unwrap();
    assert!(player.ready);
    assert_eq!(player.media_id.as_deref(), Some("ui-media"));
    harness.host.emit(DesktopEvent::PlayerState(player));
    harness.wait_window(
        cx,
        harness.window,
        "enabled playback-rate trigger",
        |window| window.find("playback-rate-trigger").disabled() != Some(true),
    );
    cx.update_window(harness.window, |_, window, app| {
        window.click("playback-rate-trigger", app)
    })
    .unwrap();
    harness.wait_window(
        cx,
        harness.window,
        "enabled playback-rate slider",
        |window| {
            window
                .try_find_by_label("Playback rate")
                .is_some_and(|slider| slider.disabled() != Some(true))
        },
    );
    for rate in [0.35, 2.5, 0.25, 3.0] {
        let (bounds, track, position) = cx
            .update_window(harness.window, |_, window, app| {
                window.render_frame(app);
                let slider = window.find_by_label("Playback rate");
                let bounds = slider.bounds();
                let track = window
                    .within(slider.path().last().unwrap().clone())
                    .find("slider-bar-container")
                    .bounds();
                // Keep the endpoint gesture inside the track's exclusive right edge.
                let x = (bounds.left() + bounds.size.width * ((rate - 0.25) / 2.75) as f32)
                    .clamp(bounds.left() + px(0.5), bounds.right() - px(0.5));
                let position = point(x, bounds.center().y);
                window.pointer_move(position, None, app);
                window.pointer_down(position, gpui_kit::MouseButton::Left, app);
                window.pointer_up(position, gpui_kit::MouseButton::Left, app);
                (bounds, track, position)
            })
            .unwrap();
        cx.run_until_parked();
        harness.drain_callbacks(cx);
        let applied = harness.state.player_state().unwrap();
        let expectation = format!(
            "rate {rate} applied to loaded media (actual {}, media {:?}, slider {bounds:?}, track {track:?}, click {position:?})",
            applied.rate, applied.media_id
        );
        harness.wait(cx, &expectation, |_, _| {
            let player = harness.state.player_state().unwrap();
            player.media_id.as_deref() == Some("ui-media") && (player.rate - rate).abs() < 0.0001
        });
        harness.drain_callbacks(cx);
    }
    // A pending rate from the old load must not reach a same-ID replacement.
    delay.store(true, Ordering::SeqCst);
    cx.update_window(harness.window, |_, window, app| {
        let bounds = window.find_by_label("Playback rate").bounds();
        let position = point(
            bounds.left() + bounds.size.width * ((0.35 - 0.25) / 2.75),
            bounds.center().y,
        );
        window.pointer_down(position, gpui_kit::MouseButton::Left, app);
        window.pointer_up(position, gpui_kit::MouseButton::Left, app);
    })
    .unwrap();
    harness.wait(cx, "delayed rate dispatch", |_, _| {
        queued.lock().unwrap().len() == 1
    });
    let replacement =
        commands::playback::load_media(harness.host.clone(), &harness.state, "ui-media".into());
    let old_rate = queued.lock().unwrap().remove(0);
    cx.update(|_| old_rate());
    harness.drain_callbacks(cx);
    assert_eq!(harness.state.player_state().unwrap().rate, 3.0);
    drop(replacement);
    harness.close(cx);
}
