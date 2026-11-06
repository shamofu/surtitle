use super::*;
fn fields(term: &str) -> EditFields {
    [("term".into(), term.into())].into()
}
fn source(term: &str, revision: &str) -> EditState {
    EditState {
        fields: fields(term),
        revision: revision.into(),
    }
}
fn one(editor: &mut EditingSession) -> Effect {
    let effects = editor.take_effects();
    assert_eq!(
        effects.len(),
        1,
        "one serialized persistence operation must be issued"
    );
    effects.into_iter().next().unwrap()
}
struct World {
    state: EditState,
    draft: Option<UiDraft>,
    archives: Vec<EditFields>,
    fail_archive: bool,
    fail_commit: bool,
}
impl World {
    fn new() -> Self {
        Self {
            state: source("original", "r1"),
            draft: None,
            archives: vec![],
            fail_archive: false,
            fail_commit: false,
        }
    }
    fn reply(&mut self, action: Action) -> Completion {
        match action {
            Action::Load => Completion::Loaded(Ok(Loaded {
                state: self.state.clone(),
                draft: self.draft.clone(),
            })),
            Action::ReadState => Completion::State(Ok(self.state.clone())),
            Action::ReadDraft => Completion::DraftRead(Ok(self.draft.clone())),
            Action::SaveDraft {
                expected_revision,
                fields,
            } => {
                if expected_revision != self.draft.as_ref().map_or(0, |d| d.revision) {
                    return Completion::Draft(Err("draft conflict".into()));
                }
                let d = UiDraft {
                    fields,
                    revision: expected_revision + 1,
                    stale: false,
                };
                self.draft = Some(d.clone());
                Completion::Draft(Ok(d))
            }
            Action::RemoveDraft { expected_revision } => {
                if expected_revision != self.draft.as_ref().map_or(0, |d| d.revision) {
                    return Completion::Removed(Err("draft conflict".into()));
                }
                self.draft = None;
                Completion::Removed(Ok(()))
            }
            Action::ArchiveDraft { fields } => {
                if self.fail_archive {
                    Completion::Archived(Err("disk full".into()))
                } else {
                    self.archives.push(fields);
                    Completion::Archived(Ok(()))
                }
            }
            Action::Commit { fields, previous } => {
                if self.fail_commit {
                    return Completion::Committed(Err("disk full".into()));
                }
                if previous.revision != self.state.revision {
                    return Completion::Committed(Err("source conflict".into()));
                }
                let applied: Vec<_> = fields
                    .iter()
                    .filter(|(k, v)| {
                        !v.trim().is_empty()
                            && (k.as_str() != "retention" || v.parse::<f64>().is_ok())
                            && self.state.fields.get(*k) != Some(*v)
                            && k.as_str() != "retentionInput"
                    })
                    .map(|(k, _)| k.clone())
                    .collect();
                for key in &applied {
                    self.state
                        .fields
                        .insert(key.clone(), fields[key].trim().into());
                }
                if !applied.is_empty() {
                    self.state.revision.push('+');
                }
                Completion::Committed(Ok(SaveResult {
                    state: self.state.clone(),
                    applied,
                }))
            }
        }
    }
    fn step(&mut self, editor: &mut EditingSession) {
        let effect = one(editor);
        let reply = self.reply(effect.action);
        editor.complete(effect.token, reply, 0);
    }
    fn drain(&mut self, editor: &mut EditingSession) {
        for _ in 0..100 {
            let effects = editor.take_effects();
            if effects.is_empty() {
                return;
            }
            for effect in effects {
                let reply = self.reply(effect.action);
                editor.complete(effect.token, reply, 0);
            }
        }
        panic!("controller did not reach quiescence");
    }
    fn editor(&mut self) -> EditingSession {
        let mut e = EditingSession::new("card", "one", []);
        e.load(0);
        self.drain(&mut e);
        e
    }
}
fn flushed(editor: &mut EditingSession, id: FlushId, success: bool) {
    assert!(
        editor
            .take_flush_results()
            .contains(&FlushResult { id, success })
    );
}
fn has_raw(e: &EditingSession, term: &str) {
    assert!(
        e.view().fields.get("term").is_some_and(|v| v == term)
            || e.view()
                .recovery
                .as_ref()
                .and_then(|f| f.get("term"))
                .is_some_and(|v| v == term),
        "raw input lost: {:?}",
        e.view()
    );
}
#[test]
fn load_exposes_committed_source_before_editing() {
    let mut w = World::new();
    let e = w.editor();
    assert_eq!(e.view().fields, fields("original"));
    assert!(e.view().ready);
    assert!(!e.view().dirty);
    assert_eq!(e.committed(), &w.state);
}
#[test]
fn input_is_durable_immediately_but_domain_commit_waits_for_500ms_or_blur() {
    let mut w = World::new();
    let mut e = w.editor();
    e.change(fields("first"), 100);
    w.drain(&mut e);
    assert_eq!(w.draft.as_ref().unwrap().fields["term"], "first");
    assert_eq!(w.state.fields["term"], "original");
    e.tick(599);
    w.drain(&mut e);
    assert_eq!(w.state.fields["term"], "original");
    e.tick(600);
    w.drain(&mut e);
    assert_eq!(w.state.fields["term"], "first");
    assert!(w.draft.is_none());
    assert!(!e.pending());
    e.change(fields("second"), 1000);
    let id = e.blur(1001);
    w.drain(&mut e);
    flushed(&mut e, id, true);
    assert_eq!(w.state.fields["term"], "second");
}
#[test]
fn incomplete_input_survives_flush_and_reopening_without_becoming_committed() {
    let mut w = World::new();
    let mut e = w.editor();
    e.change(fields(""), 0);
    let id = e.flush(0);
    w.drain(&mut e);
    flushed(&mut e, id, true);
    assert_eq!(e.view().fields["term"], "");
    assert!(e.view().dirty);
    assert!(!e.pending());
    assert_eq!(w.state.fields["term"], "original");
    let reopened = w.editor();
    assert_eq!(reopened.view().fields["term"], "");
    assert!(reopened.view().dirty);
}
#[test]
fn serialized_draft_writes_include_newer_input_before_flush_completes() {
    let mut w = World::new();
    let mut e = w.editor();
    e.change(fields("first"), 0);
    let old = one(&mut e);
    let id = e.flush(0);
    e.change(fields("00:"), 1);
    assert!(e.take_effects().is_empty());
    let reply = w.reply(old.action);
    e.complete(old.token, reply, 1);
    w.drain(&mut e);
    flushed(&mut e, id, true);
    assert_eq!(w.state.fields["term"], "00:");
    assert_eq!(e.view().fields["term"], "00:");
    assert!(!e.pending());
}
#[test]
fn late_commit_canonicalizes_only_fields_that_were_not_edited_again() {
    let mut w = World::new();
    let mut e = w.editor();
    e.change(fields(" first "), 0);
    w.step(&mut e);
    let id = e.flush(0);
    let commit = one(&mut e);
    let captured = w.reply(commit.action);
    e.change(fields("00:"), 1);
    e.complete(commit.token, captured, 1);
    has_raw(&e, "00:");
    w.drain(&mut e);
    flushed(&mut e, id, true);
    assert_eq!(w.state.fields["term"], "00:");
    assert_eq!(e.view().fields["term"], "00:");
}
#[test]
fn failed_durable_write_blocks_close_and_preserves_only_in_memory_copy() {
    let mut w = World::new();
    let mut e = w.editor();
    e.change(fields("00:"), 0);
    let write = one(&mut e);
    let id = e.flush(0);
    e.complete(write.token, Completion::Draft(Err("disk full".into())), 0);
    w.drain(&mut e);
    flushed(&mut e, id, false);
    assert!(e.pending());
    has_raw(&e, "00:");
    e.refresh(1);
    w.drain(&mut e);
    has_raw(&e, "00:");
    let retry = e.flush(2);
    w.drain(&mut e);
    flushed(&mut e, retry, true);
    assert_eq!(w.state.fields["term"], "00:");
}
#[test]
fn ordinary_commit_failure_keeps_retryable_raw_fields() {
    let mut w = World::new();
    let mut e = w.editor();
    w.fail_commit = true;
    e.change(fields("00:"), 0);
    let id = e.flush(0);
    w.drain(&mut e);
    flushed(&mut e, id, false);
    assert_eq!(e.view().fields["term"], "00:");
    assert!(e.view().recovery.is_none());
    assert_eq!(w.draft.as_ref().unwrap().fields["term"], "00:");
    w.fail_commit = false;
    let id = e.flush(1);
    w.drain(&mut e);
    flushed(&mut e, id, true);
    assert_eq!(w.state.fields["term"], "00:");
}
#[test]
fn source_conflict_requires_explicit_recovery_and_preserves_newer_typing() {
    let mut w = World::new();
    let mut e = w.editor();
    e.change(fields("first"), 0);
    w.step(&mut e);
    let id = e.flush(0);
    let commit = one(&mut e);
    w.state = source("restored", "r2");
    e.change(fields("00:"), 1);
    e.complete(
        commit.token,
        Completion::Committed(Err("conflict".into())),
        1,
    );
    w.drain(&mut e);
    flushed(&mut e, id, false);
    assert_eq!(e.view().fields["term"], "restored");
    assert_eq!(e.view().recovery.as_ref().unwrap()["term"], "00:");
    assert_eq!(w.state.fields["term"], "restored");
    e.recover(2);
    let id = e.flush(2);
    w.drain(&mut e);
    flushed(&mut e, id, true);
    assert_eq!(w.state.fields["term"], "00:");
}
#[test]
fn competing_draft_is_not_overwritten_and_both_writers_can_be_recovered() {
    let mut w = World::new();
    let mut first = w.editor();
    let mut second = w.editor();
    first.change(fields(""), 0);
    first.flush(0);
    w.drain(&mut first);
    second.change(fields("local"), 0);
    let id = second.flush(0);
    w.drain(&mut second);
    flushed(&mut second, id, true);
    assert_eq!(w.draft.as_ref().unwrap().fields["term"], "");
    assert_eq!(second.view().recovery.as_ref().unwrap()["term"], "local");
    assert_eq!(w.archives[0]["term"], "local");
    assert!(!second.pending());
    second.refresh(1);
    w.drain(&mut second);
    assert_eq!(second.view().recovery.as_ref().unwrap()["term"], "local");
    second.recover(2);
    second.flush(2);
    w.drain(&mut second);
    assert_eq!(w.state.fields["term"], "local");
    assert_eq!(w.archives[1]["term"], "");
}
#[test]
fn archive_failure_blocks_close_without_erasing_local_or_foreign_input() {
    let mut w = World::new();
    let mut e = w.editor();
    w.draft = Some(UiDraft {
        revision: 1,
        fields: fields("external"),
        stale: false,
    });
    w.fail_archive = true;
    e.change(fields("00:"), 0);
    let id = e.flush(0);
    w.drain(&mut e);
    flushed(&mut e, id, false);
    assert_eq!(e.view().fields["term"], "00:");
    assert_eq!(w.draft.as_ref().unwrap().fields["term"], "external");
    assert!(e.pending());
    assert!(w.archives.is_empty());
}
#[test]
fn typing_during_conflict_archival_is_archived_again_before_safe_close() {
    let mut w = World::new();
    let mut e = w.editor();
    w.draft = Some(UiDraft {
        revision: 1,
        fields: fields("external"),
        stale: false,
    });
    e.change(fields("local first"), 0);
    let id = e.flush(0);
    w.step(&mut e);
    w.step(&mut e);
    let archive = one(&mut e);
    assert!(matches!(&archive.action, Action::ArchiveDraft { .. }));
    e.change(fields("local newer"), 1);
    let reply = w.reply(archive.action);
    e.complete(archive.token, reply, 1);
    w.drain(&mut e);
    flushed(&mut e, id, true);
    assert_eq!(e.view().recovery.as_ref().unwrap()["term"], "local newer");
    assert_eq!(
        w.archives
            .iter()
            .map(|f| f["term"].as_str())
            .collect::<Vec<_>>(),
        vec!["local first", "local newer"]
    );
    assert_eq!(w.draft.as_ref().unwrap().fields["term"], "external");
}
#[test]
fn stale_refresh_completion_cannot_replace_newer_input_or_adopt_its_draft_token() {
    for finish_first in [true, false] {
        let mut w = World::new();
        let mut e = w.editor();
        w.state = source("external", "r2");
        e.refresh(0);
        let read = one(&mut e);
        let captured = w.reply(read.action);
        if finish_first {
            e.complete(read.token, captured.clone(), 0);
        }
        e.change(fields("00:"), 1);
        if !finish_first {
            e.complete(read.token, captured, 2);
        }
        has_raw(&e, "00:");
        e.flush(3);
        w.drain(&mut e);
        has_raw(&e, "00:");
        if e.view().recovery.is_some() {
            e.recover(4);
        }
        e.flush(4);
        w.drain(&mut e);
        assert_eq!(w.state.fields["term"], "00:");
    }
}
#[test]
fn restore_invalidates_late_success_and_error_without_consuming_imported_draft() {
    for success in [true, false] {
        let mut w = World::new();
        let mut e = w.editor();
        e.change(fields("00:"), 0);
        let old = one(&mut e);
        let id = e.flush(0);
        let reply = if success {
            w.reply(old.action)
        } else {
            Completion::Draft(Err("disk full".into()))
        };
        e.invalidate("backup was restored");
        w.draft = Some(UiDraft {
            revision: 10,
            fields: fields("imported"),
            stale: false,
        });
        e.complete(old.token, reply, 1);
        flushed(&mut e, id, false);
        has_raw(&e, "00:");
        assert!(!e.pending());
        assert!(e.view().error.as_ref().unwrap().contains("restored"));
        assert!(e.take_effects().is_empty());
        let reopened = w.editor();
        assert_eq!(
            reopened.view().recovery.as_ref().unwrap()["term"],
            "imported"
        );
        assert_eq!(w.draft.as_ref().unwrap().revision, 10);
    }
}
#[test]
fn input_typed_while_consuming_a_submitted_draft_belongs_to_the_next_draft() {
    let mut w = World::new();
    let mut e = w.editor();
    e.change(fields(""), 0);
    e.flush(0);
    w.drain(&mut e);
    let id = e.reset_draft(1);
    let remove = loop {
        let effect = one(&mut e);
        if matches!(&effect.action, Action::RemoveDraft { .. }) {
            break effect;
        }
        let reply = w.reply(effect.action);
        e.complete(effect.token, reply, 1);
    };
    e.change(fields(" "), 2);
    let reply = w.reply(remove.action);
    e.complete(remove.token, reply, 2);
    w.drain(&mut e);
    flushed(&mut e, id, true);
    assert_eq!(e.view().fields["term"], " ");
    assert_eq!(w.draft.as_ref().unwrap().fields["term"], " ");
}
#[test]
fn draft_only_fields_survive_valid_partial_commits() {
    let mut w = World::new();
    w.state.fields.insert("retention".into(), "0.8".into());
    let mut e = EditingSession::new("settings", "default", ["retentionInput".into()]);
    e.load(0);
    w.drain(&mut e);
    e.change(
        [
            ("term".into(), "updated".into()),
            ("retention".into(), "00:".into()),
            ("retentionInput".into(), "80.".into()),
        ]
        .into(),
        0,
    );
    let id = e.flush(0);
    w.drain(&mut e);
    flushed(&mut e, id, true);
    assert_eq!(w.state.fields["term"], "updated");
    assert_eq!(w.state.fields["retention"], "0.8");
    assert_eq!(e.view().fields["retention"], "00:");
    assert_eq!(w.draft.as_ref().unwrap().fields["retentionInput"], "80.");
    assert!(e.view().dirty);
}
#[test]
fn duplicate_completion_is_ignored_after_newer_operation_started() {
    let mut w = World::new();
    let mut e = w.editor();
    e.change(fields("first"), 0);
    let old = one(&mut e);
    let response = w.reply(old.action);
    e.complete(old.token, response.clone(), 0);
    e.change(fields("second"), 1);
    e.complete(old.token, response, 1);
    e.flush(1);
    w.drain(&mut e);
    assert_eq!(w.state.fields["term"], "second");
    assert!(e.view().error.is_none());
}

#[test]
fn new_field_typed_during_a_commit_keeps_its_own_debounce() {
    let mut w = World::new();
    w.state
        .fields
        .insert("meaning".into(), "original meaning".into());
    let mut e = w.editor();
    e.change(fields("first"), 0);
    w.step(&mut e);
    let id = e.flush(0);
    let commit = one(&mut e);
    let response = w.reply(commit.action);
    e.change([("meaning".into(), "new meaning".into())].into(), 100);
    e.complete(commit.token, response, 100);
    w.drain(&mut e);
    flushed(&mut e, id, true);
    assert_eq!(w.state.fields["meaning"], "original meaning");
    assert_eq!(w.draft.as_ref().unwrap().fields["meaning"], "new meaning");
    assert!(e.pending());
    e.tick(599);
    w.drain(&mut e);
    assert_eq!(w.state.fields["meaning"], "original meaning");
    e.tick(600);
    w.drain(&mut e);
    assert_eq!(w.state.fields["meaning"], "new meaning");
    assert!(!e.pending());
}

fn legal_orders() -> Vec<Vec<u8>> {
    fn permute(prefix: Vec<u8>, remaining: Vec<u8>, result: &mut Vec<Vec<u8>>) {
        if remaining.is_empty() {
            result.push(prefix);
            return;
        }
        for &next in &remaining {
            // 0=external revision, 1=refresh, 2=new input, 3=old completion.
            if (next == 1 || next == 3) && !prefix.contains(&0) {
                continue;
            }
            let mut p = prefix.clone();
            p.push(next);
            permute(
                p,
                remaining.iter().copied().filter(|n| *n != next).collect(),
                result,
            );
        }
    }
    let mut result = vec![];
    permute(vec![], vec![0, 1, 2, 3], &mut result);
    result
}
#[test]
fn all_legal_old_commit_external_refresh_and_new_input_orders_preserve_raw_input() {
    let orders = legal_orders();
    assert_eq!(orders.len(), 8);
    for outcome in 0..3 {
        for order in &orders {
            let mut w = World::new();
            let mut e = w.editor();
            e.change(fields("first"), 0);
            w.step(&mut e);
            let id = e.flush(0);
            let commit = one(&mut e);
            let response = if outcome == 0 {
                Completion::Committed(Ok(SaveResult {
                    state: source("first", "captured-old-revision"),
                    applied: vec!["term".into()],
                }))
            } else {
                Completion::Committed(Err(if outcome == 1 {
                    "source conflict"
                } else {
                    "disk full"
                }
                .into()))
            };
            let mut raw = "first";
            let mut restored = false;
            let mut finished = false;
            for action in order {
                match action {
                    0 => {
                        w.state = source("restored", "r2");
                        restored = true;
                    }
                    1 => e.refresh(0),
                    2 => {
                        raw = "00:";
                        e.change(fields(raw), 0);
                    }
                    3 => {
                        e.complete(commit.token, response.clone(), 0);
                        finished = true;
                    }
                    _ => unreachable!(),
                }
                w.drain(&mut e);
                if raw == "00:" || outcome != 0 || !finished {
                    has_raw(&e, raw);
                }
                if restored {
                    assert_eq!(
                        w.state.fields["term"], "restored",
                        "external state overwritten before explicit recovery: {order:?}"
                    );
                }
            }
            assert!(e.take_flush_results().iter().any(|r| r.id == id));
            has_raw(&e, "00:");
            if e.view().fields.get("term").map(String::as_str) != Some("00:") {
                e.recover(1);
            }
            let retry = e.flush(1);
            w.drain(&mut e);
            flushed(&mut e, retry, true);
            assert_eq!(
                w.state.fields["term"], "00:",
                "outcome {outcome}, order {order:?}"
            );
            if let Some(recovery) = &e.view().recovery {
                assert_eq!(
                    w.draft.as_ref().unwrap().fields["recovery"],
                    serde_json::to_string(recovery).unwrap()
                );
            }
        }
    }
}
#[test]
fn initialization_failure_can_be_retried_by_close_flush() {
    let mut w = World::new();
    let mut e = EditingSession::new("card", "one", []);
    e.load(0);
    let load = one(&mut e);
    e.complete(
        load.token,
        Completion::Loaded(Err("disk unavailable".into())),
        0,
    );
    assert!(!e.view().ready);
    assert!(e.view().error.is_some());
    let id = e.flush(1);
    w.drain(&mut e);
    flushed(&mut e, id, true);
    assert!(e.view().ready);
    assert_eq!(e.view().fields["term"], "original");
}
#[test]
fn third_writer_during_recovery_handoff_is_preserved_instead_of_overwritten() {
    let mut w = World::new();
    let mut e = w.editor();
    w.draft = Some(UiDraft {
        revision: 1,
        fields: fields("external one"),
        stale: false,
    });
    e.change(fields("local"), 0);
    e.flush(0);
    w.drain(&mut e);
    assert_eq!(e.view().recovery.as_ref().unwrap()["term"], "local");
    w.draft = Some(UiDraft {
        revision: 2,
        fields: fields("external two"),
        stale: false,
    });
    e.recover(1);
    e.flush(1);
    w.drain(&mut e);
    assert_eq!(w.draft.as_ref().unwrap().fields["term"], "external two");
    assert_eq!(e.view().recovery.as_ref().unwrap()["term"], "local");
    assert_eq!(
        w.archives
            .iter()
            .map(|f| f["term"].as_str())
            .collect::<Vec<_>>(),
        vec!["local", "external one", "local"]
    );
}
#[test]
fn repeated_source_conflicts_archive_previous_raw_recovery_before_replacement() {
    let mut w = World::new();
    let mut e = w.editor();
    e.change(fields("older raw"), 0);
    w.state = source("external one", "r2");
    e.flush(0);
    w.drain(&mut e);
    assert_eq!(e.view().recovery.as_ref().unwrap()["term"], "older raw");
    e.change(fields("newer raw"), 1);
    w.state = source("external two", "r3");
    let id = e.flush(1);
    w.drain(&mut e);
    flushed(&mut e, id, false);
    assert_eq!(w.archives[0]["term"], "older raw");
    assert_eq!(e.view().recovery.as_ref().unwrap()["term"], "newer raw");
    assert_eq!(e.view().fields["term"], "external two");
    assert_eq!(w.state.fields["term"], "external two");
}

#[test]
fn navigation_refresh_after_a_conflict_reads_current_content_without_replaying_recovery() {
    let mut w = World::new();
    let mut e = w.editor();
    e.change(fields("raw recovery"), 0);
    w.state = source("external one", "r2");
    e.flush(0);
    w.drain(&mut e);
    w.state = source("external two", "r3");
    e.refresh(1);
    w.drain(&mut e);
    assert_eq!(e.view().fields["term"], "external two");
    assert_eq!(e.view().recovery.as_ref().unwrap()["term"], "raw recovery");
    assert_eq!(w.state.fields["term"], "external two");
}
#[test]
fn queued_navigation_refresh_runs_after_failed_commit_once_input_is_durable() {
    let mut w = World::new();
    let mut e = w.editor();
    e.change(fields("raw recovery"), 0);
    w.step(&mut e);
    let id = e.flush(0);
    let commit = one(&mut e);
    e.refresh(1);
    w.state = source("external", "r2");
    e.complete(
        commit.token,
        Completion::Committed(Err("old error".into())),
        1,
    );
    w.drain(&mut e);
    flushed(&mut e, id, false);
    assert_eq!(e.view().fields["term"], "external");
    assert_eq!(e.view().recovery.as_ref().unwrap()["term"], "raw recovery");
    assert!(
        e.view().error.is_none(),
        "successful refresh clears the preceding save error"
    );
}
#[test]
fn input_typed_during_foreign_archival_is_kept_as_the_next_submitted_draft() {
    let mut w = World::new();
    let mut e = w.editor();
    w.draft = Some(UiDraft {
        revision: 1,
        fields: fields("foreign"),
        stale: false,
    });
    e.change(fields("submitted"), 0);
    e.flush(0);
    w.drain(&mut e);
    let id = e.reset_draft(1);
    let archive = one(&mut e);
    assert!(matches!(&archive.action, Action::ArchiveDraft { .. }));
    e.change(fields("next draft"), 2);
    let reply = w.reply(archive.action);
    e.complete(archive.token, reply, 2);
    w.drain(&mut e);
    flushed(&mut e, id, true);
    assert_eq!(e.view().fields["term"], "next draft");
    assert_eq!(w.draft.as_ref().unwrap().fields["term"], "next draft");
    assert_eq!(w.state.fields["term"], "original");
}
#[test]
fn failed_draft_consumption_reports_failure_even_when_raw_input_can_be_archived_safely() {
    let mut w = World::new();
    let mut e = w.editor();
    e.change(fields(""), 0);
    e.flush(0);
    w.drain(&mut e);
    let id = e.reset_draft(1);
    let remove = loop {
        let effect = one(&mut e);
        if matches!(&effect.action, Action::RemoveDraft { .. }) {
            break effect;
        }
        let reply = w.reply(effect.action);
        e.complete(effect.token, reply, 1);
    };
    w.draft = Some(UiDraft {
        revision: 100,
        fields: fields("competing"),
        stale: false,
    });
    let reply = w.reply(remove.action);
    e.complete(remove.token, reply, 1);
    w.drain(&mut e);
    flushed(&mut e, id, false);
    assert_eq!(w.draft.as_ref().unwrap().fields["term"], "competing");
    has_raw(&e, "");
}
#[test]
fn incorrectly_typed_and_old_error_completions_do_not_mutate_current_input() {
    let mut w = World::new();
    let mut e = w.editor();
    e.change(fields("first"), 0);
    let old = one(&mut e);
    e.complete(
        old.token,
        Completion::Loaded(Err("wrong response type".into())),
        0,
    );
    assert!(e.pending());
    assert!(e.view().error.is_none());
    e.flush(0);
    e.complete(old.token, Completion::Removed(Ok(())), 0);
    assert!(
        e.take_effects().is_empty(),
        "domain writes must wait for the actual durable-input completion"
    );
    let reply = w.reply(old.action);
    e.complete(old.token, reply, 0);
    e.change(fields("newer"), 1);
    e.complete(old.token, Completion::Draft(Err("stale error".into())), 1);
    e.flush(1);
    w.drain(&mut e);
    assert_eq!(w.state.fields["term"], "newer");
    assert!(e.view().error.is_none());
}

#[test]
fn reverting_an_overlapping_field_during_recovery_archival_keeps_the_latest_raw_value() {
    let mut w = World::new();
    let mut e = w.editor();
    e.change(fields("older recovery"), 0);
    w.state = source("external one", "r2");
    e.flush(0);
    w.drain(&mut e);
    e.change(fields("newer raw"), 1);
    w.state = source("external two", "r3");
    let id = e.flush(1);
    let archive = loop {
        let effect = one(&mut e);
        if matches!(&effect.action, Action::ArchiveDraft { .. }) {
            break effect;
        }
        let reply = w.reply(effect.action);
        e.complete(effect.token, reply, 1);
    };
    e.change(fields("external one"), 2);
    let reply = w.reply(archive.action);
    e.complete(archive.token, reply, 2);
    w.drain(&mut e);
    flushed(&mut e, id, false);
    assert_eq!(e.view().fields["term"], "external two");
    assert_eq!(e.view().recovery.as_ref().unwrap()["term"], "external one");
    assert_eq!(w.archives[0]["term"], "older recovery");
    let recovery: EditFields =
        serde_json::from_str(&w.draft.as_ref().unwrap().fields["recovery"]).unwrap();
    assert_eq!(recovery["term"], "external one");
    e.recover(3);
    e.flush(3);
    w.drain(&mut e);
    assert_eq!(w.state.fields["term"], "external one");
}

#[test]
fn correcting_invalid_input_during_its_noop_commit_preserves_the_new_input_deadline() {
    let mut w = World::new();
    let mut e = w.editor();
    e.change(fields(""), 0);
    w.step(&mut e);
    let id = e.flush(0);
    let commit = one(&mut e);
    let reply = w.reply(commit.action);
    e.change(fields("corrected"), 100);
    e.complete(commit.token, reply, 200);
    w.drain(&mut e);
    flushed(&mut e, id, true);
    assert_eq!(w.state.fields["term"], "original");
    assert_eq!(w.draft.as_ref().unwrap().fields["term"], "corrected");
    assert_eq!(e.next_deadline(), Some(600));
    assert!(e.pending());
    e.tick(599);
    w.drain(&mut e);
    assert_eq!(w.state.fields["term"], "original");
    e.tick(600);
    w.drain(&mut e);
    assert_eq!(w.state.fields["term"], "corrected");
    assert!(!e.pending());
}

#[test]
fn explicit_second_blur_during_an_old_partial_commit_flushes_the_latest_fields() {
    for noop in [false, true] {
        let mut w = World::new();
        w.state
            .fields
            .insert("meaning".into(), "original meaning".into());
        let mut e = w.editor();
        e.change(fields(if noop { "" } else { "first" }), 0);
        w.step(&mut e);
        let first = e.flush(0);
        let commit = one(&mut e);
        let reply = w.reply(commit.action);
        if noop {
            e.change(fields("corrected"), 100);
        } else {
            e.change([("meaning".into(), "new meaning".into())].into(), 100);
        }
        let second = e.blur(101);
        e.complete(commit.token, reply, 200);
        w.drain(&mut e);
        let results = e.take_flush_results();
        assert!(results.contains(&FlushResult {
            id: first,
            success: true
        }));
        assert!(results.contains(&FlushResult {
            id: second,
            success: true
        }));
        if noop {
            assert_eq!(w.state.fields["term"], "corrected");
        } else {
            assert_eq!(w.state.fields["meaning"], "new meaning");
        }
        assert!(w.draft.is_none());
        assert!(!e.pending());
    }
}

#[test]
fn a_late_partial_commit_response_does_not_restart_a_newer_fields_debounce() {
    let mut w = World::new();
    w.state
        .fields
        .insert("meaning".into(), "original meaning".into());
    let mut e = w.editor();
    e.change(fields("first"), 0);
    w.step(&mut e);
    e.flush(0);
    let commit = one(&mut e);
    let reply = w.reply(commit.action);
    e.change([("meaning".into(), "new meaning".into())].into(), 100);
    e.complete(commit.token, reply, 400);
    w.drain(&mut e);
    assert_eq!(e.next_deadline(), Some(600));
    e.tick(600);
    w.drain(&mut e);
    assert_eq!(w.state.fields["meaning"], "new meaning");
}

#[test]
fn an_earlier_second_flush_does_not_bypass_the_debounce_of_input_typed_after_it() {
    let mut w = World::new();
    w.state
        .fields
        .insert("meaning".into(), "original meaning".into());
    let mut e = w.editor();
    e.change(fields("first"), 0);
    w.step(&mut e);
    e.flush(0);
    let commit = one(&mut e);
    let reply = w.reply(commit.action);
    e.blur(50);
    e.change([("meaning".into(), "new meaning".into())].into(), 100);
    e.complete(commit.token, reply, 200);
    w.drain(&mut e);
    assert_eq!(w.state.fields["meaning"], "original meaning");
    assert_eq!(w.draft.as_ref().unwrap().fields["meaning"], "new meaning");
    assert_eq!(e.next_deadline(), Some(600));
    e.tick(600);
    w.drain(&mut e);
    assert_eq!(w.state.fields["meaning"], "new meaning");
}
