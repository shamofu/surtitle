use super::*;
use crate::controller::editing::{EditFields, EditState, SaveResult, Token};
use crate::{application::Services, commands};

fn profile() -> (tempfile::TempDir, AppState) {
    let directory = tempfile::tempdir().unwrap();
    let state = Services::open(directory.path().to_path_buf()).unwrap();
    (directory, state)
}

fn run(state: &AppState, kind: &str, entity_id: &str, action: Action) -> Completion {
    crate::runtime::test_runtime().block_on(execute(
        state.clone(),
        Effect {
            token: Token {
                generation: 1,
                id: 1,
            },
            kind: kind.into(),
            entity_id: entity_id.into(),
            action,
        },
    ))
}

fn load(state: &AppState, kind: &str, id: &str) -> crate::controller::editing::Loaded {
    match run(state, kind, id, Action::Load) {
        Completion::Loaded(result) => result.unwrap(),
        _ => panic!("wrong completion"),
    }
}

fn commit(state: &AppState, fields: EditFields, previous: EditState) -> Result<SaveResult, String> {
    match run(
        state,
        "settings",
        "default",
        Action::Commit { fields, previous },
    ) {
        Completion::Committed(result) => result,
        _ => panic!("wrong completion"),
    }
}

#[test]
fn saves_valid_settings_without_discarding_incomplete_numeric_input() {
    let (_directory, state) = profile();
    let loaded = load(&state, "settings", "default");
    let mut fields = loaded.state.fields.clone();
    fields.insert("theme".into(), "light".into());
    fields.insert("retention".into(), "-".into());
    fields.insert("replayContextMs".into(), "1.5".into());
    fields.insert("dailyBudgetUsd".into(), "".into());
    fields.insert(
        "modelInputs".into(),
        r#"{"vertex:translation":{"maxOutputTokens":"-"}}"#.into(),
    );
    let mut durable = fields.clone();
    durable.insert("baseRevision".into(), loaded.state.revision.clone());
    assert!(matches!(
        run(
            &state,
            "settings",
            "default",
            Action::SaveDraft {
                expected_revision: 0,
                fields: durable,
            }
        ),
        Completion::Draft(Ok(_))
    ));
    let saved = commit(&state, fields, loaded.state).unwrap();
    assert_eq!(saved.applied, ["theme"]);
    let settings = state.settings().unwrap();
    assert_eq!(settings.theme, "light");
    assert_eq!(settings.retention, 0.9);
    assert_eq!(settings.replay_context_ms, 150);
    assert_eq!(settings.daily_budget_usd, 0.0);
    let retained = commands::ui_drafts::get_ui_draft(&state, "settings".into(), "default".into())
        .unwrap()
        .unwrap();
    assert_eq!(retained.fields["retention"], "-");
    assert_eq!(
        retained.fields["modelInputs"],
        r#"{"vertex:translation":{"maxOutputTokens":"-"}}"#
    );
}

#[test]
fn returns_each_committed_revision_before_writing_another_budget_store() {
    let (_directory, state) = profile();
    let loaded = load(&state, "settings", "default");
    let mut fields = loaded.state.fields.clone();
    fields.insert("locale".into(), "en".into());
    fields.insert("dailyBudgetUsd".into(), "2.125".into());
    fields.insert("monthlyBudgetUsd".into(), "-".into());
    fields.insert("openaiDailyBudgetUsd".into(), "3.5".into());
    let normal = commit(&state, fields.clone(), loaded.state).unwrap();
    assert_eq!(normal.applied, ["locale"]);
    assert_eq!(state.settings().unwrap().daily_budget_usd, 0.0);
    assert_eq!(state.settings().unwrap().openai.daily_budget_usd, 0.0);
    let vertex = commit(&state, fields.clone(), normal.state.clone()).unwrap();
    assert_eq!(vertex.applied, ["dailyBudgetUsd"]);
    assert_ne!(vertex.state.revision, normal.state.revision);
    assert_eq!(state.settings().unwrap().daily_budget_usd, 2.125);
    assert_eq!(state.settings().unwrap().monthly_budget_usd, Some(0.0));
    assert_eq!(state.settings().unwrap().openai.daily_budget_usd, 0.0);
    let openai = commit(&state, fields, vertex.state.clone()).unwrap();
    assert_eq!(openai.applied, ["openaiDailyBudgetUsd"]);
    assert_ne!(openai.state.revision, vertex.state.revision);
    assert_eq!(state.settings().unwrap().openai.daily_budget_usd, 3.5);
}

#[test]
fn credential_only_changes_rebase_but_other_writers_do_not() {
    let (_directory, state) = profile();
    let loaded = load(&state, "settings", "default");
    commands::models::remove_openai_api_key(&state).unwrap();
    assert_ne!(
        commands::models::get_settings_state(&state)
            .unwrap()
            .revision,
        loaded.state.revision
    );
    let mut fields = loaded.state.fields.clone();
    fields.insert("theme".into(), "light".into());
    let saved = commit(&state, fields, loaded.state).unwrap();
    assert_eq!(saved.applied, ["theme"]);
    commands::models::update_settings_patch(
        &state,
        saved.state.revision.clone(),
        serde_json::from_value(serde_json::json!({"locale":"en"})).unwrap(),
    )
    .unwrap();
    let mut next = saved.state.fields.clone();
    next.insert("retention".into(), "0.8".into());
    assert!(commit(&state, next, saved.state).is_err());
    assert_eq!(state.settings().unwrap().retention, 0.9);
    assert_eq!(state.settings().unwrap().locale, "en");
}

fn seed_card(directory: &tempfile::TempDir) {
    let store = surtitle_core::Store::open(directory.path().join("learning.sqlite")).unwrap();
    let card: surtitle_core::StudyCard = serde_json::from_value(serde_json::json!({
        "id":"card", "mediaId":"media", "segmentId":"segment", "term":"original", "meaning":"meaning", "example":"example",
        "language":"en", "dueAt":"2026-11-06T00:00:00Z", "createdAt":"2026-11-06T00:00:00Z", "reviewCount":7,
        "audioPath":"preserved.wav", "suspended":true, "translation":"translation"
    })).unwrap();
    store.put_card(&card).unwrap();
}

#[test]
fn card_commit_rejects_empty_term_then_trims_only_term_without_changing_scheduling() {
    let (directory, state) = profile();
    seed_card(&directory);
    let loaded = load(&state, "card", "card");
    let mut fields = loaded.state.fields.clone();
    fields.insert("term".into(), "   ".into());
    fields.insert("meaning".into(), "  new meaning  ".into());
    let empty = match run(
        &state,
        "card",
        "card",
        Action::Commit {
            fields: fields.clone(),
            previous: loaded.state.clone(),
        },
    ) {
        Completion::Committed(result) => result.unwrap(),
        _ => panic!("wrong completion"),
    };
    assert!(empty.applied.is_empty());
    assert_eq!(empty.state, loaded.state);
    fields.insert("term".into(), "  revised  ".into());
    fields.insert("translation".into(), "".into());
    match run(
        &state,
        "card",
        "card",
        Action::Commit {
            fields,
            previous: loaded.state,
        },
    ) {
        Completion::Committed(Ok(saved)) => assert_eq!(saved.state.fields["term"], "revised"),
        response => panic!("{response:?}"),
    }
    let saved = commands::cards::get_card_edit_state(&state, "card".into()).unwrap();
    assert_eq!(saved.card.meaning, "  new meaning  ");
    assert_eq!(saved.card.translation, None);
    assert_eq!(saved.card.review_count, 7);
    assert!(saved.card.suspended);
    assert_eq!(saved.card.audio_path.as_deref(), Some("preserved.wav"));
}

#[test]
fn saved_draft_revisions_guard_deletes_and_archives_never_replace_active_input() {
    let (directory, state) = profile();
    seed_card(&directory);
    let loaded = load(&state, "card", "card");
    let fields = EditFields::from([
        ("term".into(), "  ".into()),
        ("baseRevision".into(), loaded.state.revision),
    ]);
    let saved = match run(
        &state,
        "card",
        "card",
        Action::SaveDraft {
            expected_revision: 0,
            fields: fields.clone(),
        },
    ) {
        Completion::Draft(Ok(draft)) => draft,
        response => panic!("{response:?}"),
    };
    assert!(saved.revision > 0);
    assert!(!saved.stale);
    assert!(matches!(
        run(
            &state,
            "card",
            "card",
            Action::SaveDraft {
                expected_revision: 0,
                fields: fields.clone()
            }
        ),
        Completion::Draft(Err(_))
    ));
    assert!(matches!(
        run(
            &state,
            "card",
            "card",
            Action::RemoveDraft {
                expected_revision: 0
            }
        ),
        Completion::Removed(Err(_))
    ));
    assert!(matches!(
        run(&state, "card", "card", Action::ArchiveDraft { fields }),
        Completion::Archived(Ok(()))
    ));
    assert_eq!(load(&state, "card", "card").draft, Some(saved.clone()));
    assert_eq!(
        commands::ui_drafts::list_ui_drafts(&state).unwrap().len(),
        2
    );
    drop(state);
    let reopened = Services::open(directory.path().to_path_buf()).unwrap();
    assert_eq!(load(&reopened, "card", "card").draft, Some(saved.clone()));
    assert!(matches!(
        run(
            &reopened,
            "card",
            "card",
            Action::RemoveDraft {
                expected_revision: saved.revision
            }
        ),
        Completion::Removed(Ok(()))
    ));
    assert!(load(&reopened, "card", "card").draft.is_none());
    assert_eq!(
        commands::ui_drafts::list_ui_drafts(&reopened)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn bookmark_input_has_source_revision_and_never_creates_a_card_implicitly() {
    let (directory, state) = profile();
    let store = surtitle_core::Store::open(directory.path().join("learning.sqlite")).unwrap();
    let media_path = directory.path().join("fixture.wav");
    std::fs::write(&media_path, b"isolated fixture").unwrap();
    let media: surtitle_core::Media = serde_json::from_value(serde_json::json!({
        "id":"media", "title":"Fixture", "path":media_path, "kind":"audio",
        "durationMs":3000,"learningLanguage":"en","explanationLanguage":"ja",
        "createdAt":"2026-11-06T00:00:00Z","lastPositionMs":0,"segmentCount":0,"cardCount":0,"status":"ready"
    })).unwrap();
    store.put_media(&media).unwrap();
    let selection: surtitle_core::DraftStudySelection = serde_json::from_value(serde_json::json!({
        "id":"selection","mediaId":"media","jobId":null,"version":1,"text":"Source.",
        "startMs":1000,"endMs":2000,"sourceStartMs":0,"sourceEndMs":3000,"cueIds":[],"ordinal":null,
        "origin":"manual","timing":"manual","confirmed":false,"createdAt":"","updatedAt":"",
        "sourceSnapshot":{"fixture":true}
    }))
    .unwrap();
    store.insert_draft_study_selection(&selection).unwrap();
    let initial = load(&state, "draft_card", "selection");
    assert_eq!(initial.state.revision, "1");
    assert_eq!(initial.state.fields["term"], "");
    let mut fields = initial.state.fields.clone();
    fields.insert("term".into(), " new term ".into());
    let mut durable = fields.clone();
    durable.insert("baseRevision".into(), "1".into());
    assert!(matches!(
        run(
            &state,
            "draft_card",
            "selection",
            Action::SaveDraft {
                expected_revision: 0,
                fields: durable
            }
        ),
        Completion::Draft(Ok(_))
    ));
    match run(
        &state,
        "draft_card",
        "selection",
        Action::Commit {
            fields,
            previous: initial.state,
        },
    ) {
        Completion::Committed(Ok(saved)) => assert!(saved.applied.is_empty()),
        response => panic!("{response:?}"),
    }
    assert!(store.list_cards().unwrap().is_empty());
    store
        .update_draft_study_selection(
            "selection",
            1,
            &surtitle_core::DraftStudySelectionEdit {
                text: "Changed source".into(),
                start_ms: 1000,
                end_ms: 2000,
                confirmed: false,
            },
        )
        .unwrap();
    let changed = load(&state, "draft_card", "selection");
    assert_eq!(changed.state.revision, "2");
    let retained = changed.draft.unwrap();
    assert!(retained.stale);
    assert_eq!(retained.fields["term"], " new term ");
    store.remove_draft_study_selection("selection", 2).unwrap();
    assert!(matches!(
        run(&state, "draft_card", "selection", Action::ReadState),
        Completion::State(Err(_))
    ));
    assert!(matches!(
        run(&state, "draft_card", "selection", Action::ReadDraft),
        Completion::DraftRead(Ok(Some(_)))
    ));
}

#[test]
fn location_change_does_not_resubmit_the_price_invalidated_by_the_service() {
    let (_directory, state) = profile();
    let initial = commands::models::get_settings_state(&state).unwrap();
    commands::models::update_settings_patch(
        &state,
        initial.revision,
        serde_json::from_value(serde_json::json!({"aiModels":{"translation":{
            "modelId":"", "maxOutputTokens":4096, "thinkingLevel":null, "thinkingBudget":null,
            "price":{"id":"manual", "source":"manual", "observedAtMs":0,
                "inputMicrousdPerMillion":1000,"outputMicrousdPerMillion":2000}
        }}}))
        .unwrap(),
    )
    .unwrap();
    let mut session = crate::controller::editing::EditingSession::new(
        "settings",
        "default",
        SETTINGS_DRAFT_ONLY.iter().map(|key| (*key).to_string()),
    );
    let pump = |session: &mut crate::controller::editing::EditingSession| {
        for _ in 0..30 {
            let effects = session.take_effects();
            if effects.is_empty() {
                return;
            }
            for effect in effects {
                let token = effect.token;
                let completion =
                    crate::runtime::test_runtime().block_on(execute(state.clone(), effect));
                session.complete(token, completion, 0);
            }
        }
        panic!("editing session did not settle");
    };
    session.load(0);
    pump(&mut session);
    session.change(
        EditFields::from([("vertexLocation".into(), "us-central1".into())]),
        0,
    );
    session.flush(0);
    pump(&mut session);
    assert!(
        session
            .take_flush_results()
            .iter()
            .all(|result| result.success)
    );
    assert!(!session.view().dirty);
    let saved = state.settings().unwrap();
    assert_eq!(saved.vertex_location, "us-central1");
    assert!(
        saved.ai_models["translation"].price.is_none(),
        "changing location must invalidate the old price permanently"
    );
}
