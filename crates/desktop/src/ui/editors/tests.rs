use super::*;
use crate::controller::editing::{Action, EditState, Loaded, SaveResult, UiDraft};
fn fields(value: &str) -> EditFields {
    [("term".into(), value.into())].into()
}
fn state(value: &str) -> EditState {
    EditState {
        fields: fields(value),
        revision: "r1".into(),
    }
}
fn load(registry: &mut RegistryState, key: &EditorKey) {
    let work = registry.work();
    assert_eq!(work.dispatches.len(), 1);
    let dispatch = work.dispatches.into_iter().next().unwrap();
    registry.complete(
        key,
        dispatch.effect.token,
        Completion::Loaded(Ok(Loaded {
            state: state("source"),
            draft: None,
        })),
        0,
    );
}
fn created() -> (RegistryState, EditorKey) {
    let mut r = RegistryState::new(0);
    let key = r.ensure("card", "one", 0).unwrap();
    load(&mut r, &key);
    (r, key)
}
fn effect(r: &mut RegistryState) -> Dispatch {
    let work = r.work();
    assert_eq!(work.dispatches.len(), 1);
    work.dispatches.into_iter().next().unwrap()
}
#[test]
fn reacquiring_after_navigation_keeps_the_same_session_and_raw_input() {
    let (mut r, key) = created();
    assert!(r.change(&key, fields("00:"), 0));
    let same = r.ensure("card", "one", 1).unwrap();
    assert_eq!(key, same);
    assert_eq!(r.view(&same).unwrap().fields["term"], "00:");
    assert_eq!(r.work().dispatches.len(), 1);
    assert!(r.work().dispatches.is_empty(), "effects execute once");
}
#[test]
fn restore_gate_freezes_mutations_and_waits_for_the_real_write_completion() {
    let (mut r, key) = created();
    r.change(&key, fields(""), 0);
    let write = effect(&mut r);
    let batch = r.begin_flush(FlushPurpose::Restore, 0).unwrap();
    assert!(r.frozen());
    assert!(!r.change(&key, fields("lost"), 1));
    assert!(r.blur(&key, 1).is_none());
    assert!(r.ensure("card", "new", 1).is_err());
    assert!(r.work().finished.is_empty());
    assert!(r.can_restore().is_err());
    r.complete(
        &key,
        write.effect.token,
        Completion::Draft(Ok(UiDraft {
            fields: fields(""),
            revision: 1,
            stale: false,
        })),
        1,
    );
    let commit = effect(&mut r);
    assert!(matches!(commit.effect.action, Action::Commit { .. }));
    assert!(r.work().finished.is_empty());
    r.complete(
        &key,
        commit.effect.token,
        Completion::Committed(Ok(SaveResult {
            state: state("source"),
            applied: vec![],
        })),
        1,
    );
    let write = effect(&mut r);
    assert!(r.work().finished.is_empty());
    r.complete(
        &key,
        write.effect.token,
        Completion::Draft(Ok(UiDraft {
            fields: fields(""),
            revision: 2,
            stale: false,
        })),
        1,
    );
    assert_eq!(r.work().finished, vec![(batch, Ok(()))]);
    assert!(r.frozen());
    assert!(r.can_restore().is_ok());
}
#[test]
fn failed_gate_unfreezes_and_keeps_unpersisted_input_available() {
    let (mut r, key) = created();
    r.change(&key, fields("raw"), 0);
    let write = effect(&mut r);
    let batch = r.begin_flush(FlushPurpose::Close, 0).unwrap();
    r.complete(
        &key,
        write.effect.token,
        Completion::Draft(Err("disk full".into())),
        0,
    );
    let read = effect(&mut r);
    r.complete(&key, read.effect.token, Completion::DraftRead(Ok(None)), 0);
    let work = r.work();
    assert_eq!(work.finished.len(), 1);
    assert_eq!(work.finished[0].0, batch);
    assert!(work.finished[0].1.is_err());
    assert!(!r.frozen());
    assert!(r.pending());
    assert_eq!(r.view(&key).unwrap().fields["term"], "raw");
    assert!(r.change(&key, fields("retry"), 1));
}
#[test]
fn restore_requires_its_own_successful_gate_and_rejects_old_view_handles() {
    let (mut r, key) = created();
    assert!(r.invalidate_after_restore(1).is_err());
    let batch = r.begin_flush(FlushPurpose::Restore, 0).unwrap();
    assert_eq!(r.work().finished, vec![(batch, Ok(()))]);
    r.invalidate_after_restore(1).unwrap();
    assert!(!r.frozen());
    assert!(r.view(&key).is_none());
    assert!(!r.change(&key, fields("old event"), 1));
    let new = r.ensure("card", "one", 1).unwrap();
    assert_ne!(new, key);
    assert_eq!(r.generation(), 1);
}
#[test]
fn unexpected_generation_changes_keep_executing_writes_accounted_until_completion() {
    let (mut r, key) = created();
    r.change(&key, fields("raw"), 0);
    let write = effect(&mut r);
    let batch = r.begin_flush(FlushPurpose::Restore, 0).unwrap();
    r.synchronize_generation(1);
    assert!(r.frozen());
    assert!(r.ensure("card", "new", 1).is_err());
    assert!(r.work().finished.is_empty());
    r.complete(
        &key,
        write.effect.token,
        Completion::Draft(Ok(UiDraft {
            fields: fields("raw"),
            revision: 1,
            stale: false,
        })),
        1,
    );
    let work = r.work();
    assert!(
        work.dispatches.is_empty(),
        "old-generation completion must not issue another write"
    );
    assert_eq!(work.finished.len(), 1);
    assert_eq!(work.finished[0].0, batch);
    assert!(work.finished[0].1.is_err());
    assert_eq!(r.generation(), 1);
    assert!(!r.frozen());
    assert!(r.view(&key).is_none());
}
#[test]
fn restoring_one_record_waits_for_other_sessions_already_executing() {
    let (mut r, first) = created();
    let second = r.ensure("card", "two", 0).unwrap();
    load(&mut r, &second);
    r.change(&first, fields("one"), 0);
    r.change(&second, fields("two"), 0);
    let work = r.work();
    assert_eq!(work.dispatches.len(), 2);
    let batch = r.begin_flush(FlushPurpose::Restore, 0).unwrap();
    r.synchronize_generation(1);
    let mut iter = work.dispatches.into_iter();
    let one = iter.next().unwrap();
    let two = iter.next().unwrap();
    r.complete(
        &one.key,
        one.effect.token,
        Completion::Draft(Err("stale failure".into())),
        1,
    );
    assert!(r.work().finished.is_empty());
    assert!(r.frozen());
    r.complete(
        &two.key,
        two.effect.token,
        Completion::Draft(Err("stale failure".into())),
        1,
    );
    assert_eq!(r.work().finished.len(), 1);
    assert!(!r.frozen());
    assert!(r.work().finished.is_empty());
    let _ = batch;
}
#[test]
fn export_gate_is_held_until_the_consumer_releases_it() {
    let (mut r, key) = created();
    let batch = r.begin_flush(FlushPurpose::Export, 0).unwrap();
    assert_eq!(r.work().finished, vec![(batch, Ok(()))]);
    assert!(r.frozen());
    assert!(!r.change(&key, fields("too late"), 0));
    assert!(r.begin_flush(FlushPurpose::Close, 0).is_err());
    r.resume().unwrap();
    assert!(!r.frozen());
    assert!(r.change(&key, fields("after export"), 1));
}

#[test]
fn registry_clock_commits_at_the_latest_input_deadline_and_not_before() {
    let (mut r, key) = created();
    r.change(&key, fields("updated"), 100);
    let write = effect(&mut r);
    r.complete(
        &key,
        write.effect.token,
        Completion::Draft(Ok(UiDraft {
            fields: fields("updated"),
            revision: 1,
            stale: false,
        })),
        100,
    );
    assert_eq!(r.next_deadline(), Some(600));
    r.tick(599);
    assert!(r.work().dispatches.is_empty());
    r.tick(600);
    let commit = effect(&mut r);
    assert!(matches!(commit.effect.action, Action::Commit { .. }));
    r.complete(
        &key,
        commit.effect.token,
        Completion::Committed(Ok(SaveResult {
            state: state("updated"),
            applied: vec!["term".into()],
        })),
        600,
    );
    let remove = effect(&mut r);
    r.complete(&key, remove.effect.token, Completion::Removed(Ok(())), 600);
    assert!(r.work().dispatches.is_empty());
    assert!(!r.pending());
}

#[test]
fn settings_raw_only_fields_stay_durable_without_domain_commits() {
    let mut r = RegistryState::new(0);
    let key = r.ensure("settings", "default", 0).unwrap();
    assert_eq!(key.kind(), "settings");
    assert_eq!(key.entity_id(), "default");
    load(&mut r, &key);
    r.change(
        &key,
        [
            ("modelInputs".into(), "{incomplete".into()),
            ("retentionInput".into(), "80.".into()),
        ]
        .into(),
        0,
    );
    assert!(!r.view(&key).unwrap().dirty);
    let write = effect(&mut r);
    let saved_fields = match write.effect.action {
        Action::SaveDraft { fields, .. } => fields,
        _ => panic!("raw input must be durably saved"),
    };
    assert_eq!(saved_fields["modelInputs"], "{incomplete");
    assert_eq!(saved_fields["retentionInput"], "80.");
    let batch = r.begin_flush(FlushPurpose::Save, 0).unwrap();
    assert!(!r.frozen());
    r.complete(
        &key,
        write.effect.token,
        Completion::Draft(Ok(UiDraft {
            fields: saved_fields,
            revision: 1,
            stale: false,
        })),
        0,
    );
    let work = r.work();
    assert!(work.dispatches.is_empty());
    assert_eq!(work.finished, vec![(batch, Ok(()))]);
    assert!(!r.pending());
}

#[test]
fn failed_exclusive_flush_stays_frozen_until_the_other_sessions_real_callback_arrives() {
    let (mut r, first) = created();
    let second = r.ensure("card", "two", 0).unwrap();
    load(&mut r, &second);
    r.change(&first, fields("first raw"), 0);
    r.change(&second, fields(""), 0);
    let mut writes = r.work().dispatches.into_iter();
    let first_write = writes.next().unwrap();
    let second_write = writes.next().unwrap();
    let batch = r.begin_flush(FlushPurpose::Close, 0).unwrap();
    r.complete(
        &first,
        first_write.effect.token,
        Completion::Draft(Err("disk full".into())),
        0,
    );
    let read = effect(&mut r);
    r.complete(
        &first,
        read.effect.token,
        Completion::DraftRead(Ok(None)),
        0,
    );
    assert!(r.work().finished.is_empty());
    assert!(r.frozen());
    assert!(r.resume().is_err());
    r.complete(
        &second,
        second_write.effect.token,
        Completion::Draft(Err("second disk full".into())),
        0,
    );
    let read = effect(&mut r);
    r.complete(
        &second,
        read.effect.token,
        Completion::DraftRead(Ok(None)),
        0,
    );
    let work = r.work();
    assert_eq!(work.finished.len(), 1);
    assert_eq!(work.finished[0].0, batch);
    assert!(work.finished[0].1.is_err());
    assert!(!r.frozen());
    assert_eq!(r.view(&first).unwrap().fields["term"], "first raw");
    assert_eq!(r.view(&second).unwrap().fields["term"], "");
}

#[test]
fn deleted_entity_can_retire_only_after_an_exclusive_flush_and_is_not_loaded_again() {
    let (mut r, key) = created();
    assert!(r.retire(&key).is_err());
    let batch = r.begin_flush(FlushPurpose::Export, 0).unwrap();
    assert!(r.retire(&key).is_err());
    assert_eq!(r.work().finished, vec![(batch, Ok(()))]);
    r.retire(&key).unwrap();
    r.resume().unwrap();
    r.refresh_all(1);
    assert!(r.work().dispatches.is_empty());
    assert!(r.view(&key).is_none());
    assert!(!r.change(&key, fields("late input"), 2));
    let batch = r.begin_flush(FlushPurpose::Close, 3).unwrap();
    assert_eq!(r.work().finished, vec![(batch, Ok(()))]);
}

#[test]
fn recovery_requested_while_loading_is_applied_when_the_saved_input_arrives() {
    let mut r = RegistryState::new(0);
    let key = r.ensure("card", "one", 0).unwrap();
    let load = effect(&mut r);
    assert!(r.recover(&key, 1));
    r.complete(
        &key,
        load.effect.token,
        Completion::Loaded(Ok(Loaded {
            state: state("current"),
            draft: Some(UiDraft {
                fields: fields("unfinished"),
                revision: 3,
                stale: true,
            }),
        })),
        2,
    );
    assert_eq!(r.view(&key).unwrap().fields["term"], "unfinished");
    assert!(r.view(&key).unwrap().recovery.is_none());
}
