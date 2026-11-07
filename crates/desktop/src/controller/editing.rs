// SPDX-License-Identifier: GPL-3.0-or-later
//! Durable editing state, independent of GPUI, timers, and persistence executors.
//!
//! Keep this session alive across view navigation. Execute each emitted effect once,
//! return its typed completion, and call `tick` at `next_deadline`. Domain adapters
//! validate raw strings and report only fields actually committed in `applied`.
use std::collections::{BTreeMap, BTreeSet};

pub type EditFields = BTreeMap<String, String>;
pub type FlushId = u64;
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct EditState {
    pub fields: EditFields,
    pub revision: String,
}
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct EditorView {
    pub fields: EditFields,
    pub ready: bool,
    pub saving: bool,
    pub dirty: bool,
    pub error: Option<String>,
    pub recovery: Option<EditFields>,
}
/// The input-bearing subset of the existing core workspace UiDraft DTO.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UiDraft {
    pub fields: EditFields,
    pub revision: u64,
    pub stale: bool,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Loaded {
    pub state: EditState,
    pub draft: Option<UiDraft>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SaveResult {
    pub state: EditState,
    pub applied: Vec<String>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Token {
    pub generation: u64,
    pub id: u64,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Action {
    /// Read source and active durable draft; neither may be omitted on reopen.
    Load,
    ReadState,
    ReadDraft,
    SaveDraft {
        expected_revision: u64,
        fields: EditFields,
    },
    RemoveDraft {
        expected_revision: u64,
    },
    ArchiveDraft {
        fields: EditFields,
    },
    Commit {
        fields: EditFields,
        previous: EditState,
    },
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Effect {
    pub token: Token,
    pub kind: String,
    pub entity_id: String,
    pub action: Action,
}
#[derive(Clone, Debug)]
pub enum Completion {
    Loaded(Result<Loaded, String>),
    State(Result<EditState, String>),
    DraftRead(Result<Option<UiDraft>, String>),
    Draft(Result<UiDraft, String>),
    Removed(Result<(), String>),
    Archived(Result<(), String>),
    Committed(Result<SaveResult, String>),
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FlushResult {
    pub id: FlushId,
    pub success: bool,
}

#[derive(Clone)]
struct DraftConflict {
    version: u64,
    incoming: EditFields,
    latest: Option<UiDraft>,
    error: String,
}
#[derive(Clone)]
enum Phase {
    Load {
        version: u64,
    },
    Save {
        version: u64,
    },
    Remove {
        version: u64,
    },
    InspectDraft {
        error: String,
    },
    ArchiveConflict(DraftConflict),
    ReadDraftConflict(DraftConflict),
    ArchiveForeign,
    Commit {
        submitted: EditFields,
        previous: EditState,
        version: u64,
    },
    ReadCommitFailure {
        previous: EditState,
        error: String,
    },
    ArchiveRecovery {
        current: EditState,
        unfinished: EditFields,
        error: String,
    },
    Reset {
        version: u64,
    },
}

pub struct EditingSession {
    kind: String,
    entity_id: String,
    draft_only: BTreeSet<String>,
    view: EditorView,
    baseline: EditState,
    version: u64,
    persisted_version: u64,
    draft_revision: u64,
    foreign_draft: Option<UiDraft>,
    detached_recovery: Option<EditFields>,
    deadline: Option<u64>,
    generation: u64,
    next_id: u64,
    inflight: Option<(Token, Phase)>,
    effects: Vec<Effect>,
    waiters: Vec<FlushId>,
    flush_results: Vec<FlushResult>,
    flushing: bool,
    flush_version: u64,
    commit_stopped: bool,
    debounce_newer: bool,
    blocked: bool,
    refresh_requested: bool,
    reset_requested: bool,
    reset_version: Option<u64>,
    deferred_error: Option<String>,
    invalidated: bool,
}
impl EditingSession {
    pub fn new(
        kind: impl Into<String>,
        entity_id: impl Into<String>,
        draft_only: impl IntoIterator<Item = String>,
    ) -> Self {
        Self {
            kind: kind.into(),
            entity_id: entity_id.into(),
            draft_only: draft_only.into_iter().collect(),
            view: EditorView::default(),
            baseline: EditState::default(),
            version: 0,
            persisted_version: 0,
            draft_revision: 0,
            foreign_draft: None,
            detached_recovery: None,
            deadline: None,
            generation: 0,
            next_id: 0,
            inflight: None,
            effects: vec![],
            waiters: vec![],
            flush_results: vec![],
            flushing: false,
            flush_version: 0,
            commit_stopped: false,
            debounce_newer: false,
            blocked: false,
            refresh_requested: false,
            reset_requested: false,
            reset_version: None,
            deferred_error: None,
            invalidated: false,
        }
    }
    pub fn view(&self) -> &EditorView {
        &self.view
    }
    #[cfg(test)]
    pub fn committed(&self) -> &EditState {
        &self.baseline
    }
    pub fn next_deadline(&self) -> Option<u64> {
        self.deadline
    }
    /// Dirty invalid input can be safely closed once its durable write completed.
    #[cfg(test)]
    pub fn pending(&self) -> bool {
        !self.invalidated
            && (self.persisted_version < self.version
                || self.inflight.is_some()
                || self.deadline.is_some()
                || self.flushing)
    }
    pub fn take_effects(&mut self) -> Vec<Effect> {
        std::mem::take(&mut self.effects)
    }
    pub fn take_flush_results(&mut self) -> Vec<FlushResult> {
        std::mem::take(&mut self.flush_results)
    }
    pub fn load(&mut self, now_ms: u64) {
        if self.invalidated || self.view.ready || self.inflight.is_some() {
            return;
        }
        self.blocked = false;
        self.issue(
            Phase::Load {
                version: self.version,
            },
            Action::Load,
        );
        self.drive(now_ms);
    }
    pub fn refresh(&mut self, now_ms: u64) {
        if self.invalidated {
            return;
        }
        if !self.view.ready {
            self.load(now_ms);
            return;
        }
        self.deadline = None;
        // A failed durable write must retain its only copy in memory.
        if self.blocked && self.persisted_version < self.version {
            return;
        }
        self.refresh_requested = true;
        self.drive(now_ms);
    }
    pub fn change(&mut self, patch: EditFields, now_ms: u64) {
        if !self.view.ready || self.invalidated {
            return;
        }
        let mut fields = self.view.fields.clone();
        fields.extend(patch);
        if fields == self.view.fields {
            return;
        }
        self.version += 1;
        self.view.fields = fields;
        self.update_dirty();
        self.view.error = None;
        self.blocked = false;
        if self.flushing && self.commit_stopped {
            self.debounce_newer = self.view.dirty;
        }
        self.deadline = Some(now_ms.saturating_add(500));
        self.drive(now_ms);
    }
    pub fn tick(&mut self, now_ms: u64) {
        if self.deadline.is_some_and(|deadline| now_ms >= deadline) {
            self.start_flush();
            self.drive(now_ms);
        }
    }
    /// All waiters complete only after input arriving during this flush is durable.
    /// Callers must await a successful result before close, export, or restore.
    pub fn flush(&mut self, now_ms: u64) -> FlushId {
        let id = self.allocate_id();
        self.waiters.push(id);
        if self.invalidated {
            self.finish_flush(false);
            return id;
        }
        self.start_flush();
        if !self.view.ready && self.inflight.is_none() {
            self.load(now_ms);
        }
        self.drive(now_ms);
        id
    }
    pub fn blur(&mut self, now_ms: u64) -> FlushId {
        self.flush(now_ms)
    }
    pub fn recover(&mut self, now_ms: u64) {
        if self.invalidated {
            return;
        }
        if let Some(fields) = self.view.recovery.take() {
            self.detached_recovery = None;
            // Clearing recovery must itself be durable even if its text equals the current input.
            self.version += 1;
            self.blocked = false;
            self.change(fields, now_ms);
            self.drive(now_ms);
        }
    }
    /// Consume a draft only after the explicit domain submission succeeded.
    pub fn reset_draft(&mut self, now_ms: u64) -> FlushId {
        self.reset_requested = true;
        self.flush(now_ms)
    }
    /// A successful restore invalidates the old session permanently. Reopen with a
    /// new session. The host must already have flushed before replacing storage;
    /// ignoring a completion cannot undo a write executed by the host after restore.
    pub fn invalidate(&mut self, reason: impl Into<String>) {
        self.generation += 1;
        self.invalidated = true;
        self.inflight = None;
        self.effects.clear();
        self.deadline = None;
        self.refresh_requested = false;
        self.reset_requested = false;
        self.view.ready = false;
        self.view.error = Some(reason.into());
        self.finish_flush(false);
    }
    /// Unknown, duplicate, stale-generation, and incorrectly typed responses are
    /// ignored. A mismatched response leaves the actual operation outstanding.
    pub fn complete(&mut self, token: Token, completion: Completion, now_ms: u64) {
        if self.invalidated || self.inflight.as_ref().map(|(active, _)| *active) != Some(token) {
            return;
        }
        let (_, phase) = self.inflight.take().unwrap();
        match (phase.clone(), completion) {
            (Phase::Load { version }, Completion::Loaded(result)) => {
                if version == self.version {
                    match result {
                        Ok(loaded) => {
                            if let Err(error) = self.adopt_loaded(loaded, now_ms) {
                                self.fail(error);
                            }
                        }
                        Err(error) => self.fail(error),
                    }
                }
            }
            (Phase::Save { version }, Completion::Draft(result)) => match result {
                Ok(saved) => {
                    self.draft_revision = saved.revision;
                    self.persisted_version = version;
                }
                Err(error) => self.issue(Phase::InspectDraft { error }, Action::ReadDraft),
            },
            (Phase::Remove { version }, Completion::Removed(result)) => match result {
                Ok(()) => {
                    self.draft_revision = 0;
                    self.persisted_version = version;
                }
                Err(error) => self.issue(Phase::InspectDraft { error }, Action::ReadDraft),
            },
            (Phase::InspectDraft { error }, Completion::DraftRead(result)) => match result {
                Ok(latest)
                    if latest.as_ref().map_or(0, |draft| draft.revision) != self.draft_revision =>
                {
                    let conflict = DraftConflict {
                        version: self.version,
                        incoming: self.view.fields.clone(),
                        latest,
                        error,
                    };
                    let fields = self.durable_fields(self.view.fields.clone());
                    self.issue(
                        Phase::ArchiveConflict(conflict),
                        Action::ArchiveDraft { fields },
                    );
                }
                _ => self.fail(error),
            },
            (Phase::ArchiveConflict(conflict), Completion::Archived(result)) => match result {
                Ok(()) => self.issue(Phase::ReadDraftConflict(conflict), Action::ReadState),
                Err(error) => self.fail(error),
            },
            (Phase::ReadDraftConflict(conflict), Completion::State(result)) => {
                if conflict.version != self.version {
                    // The archived input is safe, but newer input still uses the old
                    // CAS token so another collision preserves it independently.
                    self.persisted_version = conflict.version;
                } else {
                    if let Ok(current) = result {
                        self.baseline = current;
                    }
                    self.draft_revision =
                        conflict.latest.as_ref().map_or(0, |draft| draft.revision);
                    self.foreign_draft = conflict.latest;
                    self.detached_recovery = Some(conflict.incoming.clone());
                    self.view.recovery = Some(conflict.incoming);
                    self.view.fields = self.baseline.fields.clone();
                    self.view.dirty = false;
                    self.view.error = Some(conflict.error);
                    self.version += 1;
                    self.persisted_version = self.version;
                }
            }
            (Phase::ArchiveForeign, Completion::Archived(result)) => match result {
                Ok(()) => self.foreign_draft = None,
                Err(error) => self.fail(error),
            },
            (
                Phase::Commit {
                    submitted,
                    previous,
                    version,
                },
                Completion::Committed(result),
            ) => match result {
                Ok(saved) => {
                    // A newer blur/flush requests another attempt at text typed
                    // after this submission, even if the old attempt was a no-op.
                    let force_newer = self.flush_version > version && self.view.fields != submitted;
                    self.baseline = saved.state;
                    for key in &saved.applied {
                        if self.view.fields.get(key) == submitted.get(key) {
                            if let Some(value) = self.baseline.fields.get(key) {
                                self.view.fields.insert(key.clone(), value.clone());
                            } else {
                                self.view.fields.remove(key);
                            }
                        }
                    }
                    self.update_dirty();
                    self.version += 1;
                    self.debounce_newer = !force_newer
                        && self.view.dirty
                        && self.view.fields.iter().any(|(key, value)| {
                            submitted.get(key) != Some(value) && !saved.applied.contains(key)
                        });
                    self.commit_stopped =
                        !force_newer && (saved.applied.is_empty() || self.debounce_newer);
                    if self.debounce_newer && self.deadline.is_none() {
                        self.deadline = Some(now_ms.saturating_add(500));
                    }
                }
                Err(error) => self.issue(
                    Phase::ReadCommitFailure { previous, error },
                    Action::ReadState,
                ),
            },
            (Phase::ReadCommitFailure { previous, error }, Completion::State(result)) => {
                match result {
                    Ok(current) if current.revision != previous.revision => {
                        let unfinished = self.differences(&previous.fields);
                        let overlaps = self.view.recovery.as_ref().is_some_and(|recovery| {
                            unfinished.iter().any(|(key, value)| {
                                recovery.get(key).is_some_and(|old| old != value)
                            })
                        });
                        if overlaps {
                            let mut fields = self.view.recovery.clone().unwrap();
                            fields.insert("baseRevision".into(), previous.revision);
                            self.issue(
                                Phase::ArchiveRecovery {
                                    current,
                                    unfinished,
                                    error,
                                },
                                Action::ArchiveDraft { fields },
                            );
                        } else {
                            self.adopt_source_conflict(current, unfinished, error);
                        }
                    }
                    _ => self.fail(error),
                }
            }
            (
                Phase::ArchiveRecovery {
                    current,
                    mut unfinished,
                    error,
                },
                Completion::Archived(result),
            ) => match result {
                Ok(()) => {
                    // An explicit reversion to the old baseline disappears from
                    // `differences`, but is still the latest raw choice for an
                    // overlapping field. Refresh captured values before merging
                    // newly edited fields.
                    for (key, value) in &mut unfinished {
                        if let Some(latest) = self.view.fields.get(key) {
                            *value = latest.clone();
                        }
                    }
                    unfinished.extend(self.differences(&self.baseline.fields));
                    self.adopt_source_conflict(current, unfinished, error);
                }
                Err(error) => self.fail(error),
            },
            (Phase::Reset { version }, Completion::Removed(result)) => match result {
                Ok(()) => {
                    self.draft_revision = 0;
                    self.finish_reset(version);
                }
                Err(error) => {
                    self.reset_requested = false;
                    self.reset_version = None;
                    self.deferred_error = Some(error.clone());
                    self.issue(Phase::InspectDraft { error }, Action::ReadDraft);
                }
            },
            _ => {
                self.inflight = Some((token, phase));
                return;
            }
        }
        self.drive(now_ms);
    }
    fn allocate_id(&mut self) -> u64 {
        self.next_id += 1;
        self.next_id
    }
    fn issue(&mut self, phase: Phase, action: Action) {
        debug_assert!(self.inflight.is_none());
        let token = Token {
            generation: self.generation,
            id: self.allocate_id(),
        };
        self.inflight = Some((token, phase));
        self.effects.push(Effect {
            token,
            kind: self.kind.clone(),
            entity_id: self.entity_id.clone(),
            action,
        });
    }
    fn update_dirty(&mut self) {
        self.view.dirty = self
            .view
            .fields
            .keys()
            .chain(self.baseline.fields.keys())
            .any(|key| {
                !self.draft_only.contains(key)
                    && self.view.fields.get(key) != self.baseline.fields.get(key)
            });
    }
    fn differences(&self, previous: &EditFields) -> EditFields {
        self.view
            .fields
            .iter()
            .filter(|(key, value)| previous.get(*key) != Some(*value))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect()
    }
    fn durable_fields(&self, mut fields: EditFields) -> EditFields {
        fields.insert("baseRevision".into(), self.baseline.revision.clone());
        if let Some(recovery) = &self.view.recovery {
            fields.insert(
                "recovery".into(),
                serde_json::to_string(recovery).expect("string map is JSON serializable"),
            );
        }
        fields
    }
    fn adopt_loaded(&mut self, loaded: Loaded, now_ms: u64) -> Result<(), String> {
        let mut fields = loaded
            .draft
            .as_ref()
            .map(|draft| draft.fields.clone())
            .unwrap_or_default();
        let base = fields.remove("baseRevision");
        let recovery = fields
            .remove("recovery")
            .map(|json| {
                serde_json::from_str::<EditFields>(&json)
                    .map_err(|error| format!("Invalid recovery input: {error}"))
            })
            .transpose()?;
        let stale = loaded.draft.as_ref().is_some_and(|draft| {
            !fields.is_empty() && (draft.stale || base.as_ref() != Some(&loaded.state.revision))
        });
        self.baseline = loaded.state;
        self.draft_revision = loaded.draft.as_ref().map_or(0, |draft| draft.revision);
        self.view.fields = self.baseline.fields.clone();
        if self.detached_recovery.is_some() {
            self.foreign_draft = loaded.draft;
        } else if !stale {
            self.view.fields.extend(fields.clone());
        }
        self.view.recovery = self.detached_recovery.clone().or_else(|| {
            if stale {
                let mut combined = recovery.unwrap_or_default();
                combined.extend(fields);
                Some(combined)
            } else {
                recovery
            }
        });
        self.view.ready = true;
        self.view.error = None;
        self.persisted_version = self.version;
        self.update_dirty();
        if self.view.dirty {
            self.deadline = Some(now_ms.saturating_add(500));
        }
        Ok(())
    }
    fn adopt_source_conflict(&mut self, current: EditState, unfinished: EditFields, error: String) {
        let mut recovery = self.view.recovery.take().unwrap_or_default();
        recovery.extend(unfinished);
        self.baseline = current;
        self.view.fields = self.baseline.fields.clone();
        self.view.recovery = Some(recovery);
        self.view.dirty = false;
        self.version += 1;
        self.deferred_error = Some(error);
    }
    fn start_flush(&mut self) {
        self.flush_version = self.version;
        self.deadline = None;
        self.flushing = true;
        self.view.saving = true;
        self.view.error = None;
        self.blocked = false;
        self.commit_stopped = false;
        self.debounce_newer = false;
    }
    fn finish_flush(&mut self, success: bool) {
        self.flush_results
            .extend(self.waiters.drain(..).map(|id| FlushResult { id, success }));
        self.flushing = false;
        self.view.saving = false;
        if success && !self.debounce_newer {
            self.deadline = None;
        }
    }
    fn fail(&mut self, error: String) {
        self.view.error = Some(error);
        self.blocked = true;
        self.deferred_error = None;
        self.reset_requested = false;
        self.reset_version = None;
        self.finish_flush(false);
    }
    fn finish_reset(&mut self, version: u64) {
        self.reset_requested = false;
        self.reset_version = None;
        if self.version == version {
            self.version += 1;
            self.persisted_version = self.version;
            self.view.fields = self.baseline.fields.clone();
            self.view.dirty = false;
            self.view.recovery = None;
            self.detached_recovery = None;
            self.view.error = None;
            self.deadline = None;
        } else {
            self.persisted_version = self.persisted_version.min(version);
            self.commit_stopped = true;
            self.debounce_newer = true;
        }
    }
    fn drive(&mut self, _now_ms: u64) {
        if self.invalidated || self.inflight.is_some() {
            return;
        }
        if self.blocked {
            if self.refresh_requested && self.persisted_version >= self.version && self.view.ready {
                self.blocked = false;
            } else {
                return;
            }
        }
        if !self.view.ready {
            return;
        }
        if self.persisted_version < self.version {
            if let Some(foreign) = &self.foreign_draft {
                self.issue(
                    Phase::ArchiveForeign,
                    Action::ArchiveDraft {
                        fields: foreign.fields.clone(),
                    },
                );
                return;
            }
            let changed = self.differences(&self.baseline.fields);
            if changed.is_empty() && self.view.recovery.is_none() {
                if self.draft_revision != 0 {
                    self.issue(
                        Phase::Remove {
                            version: self.version,
                        },
                        Action::RemoveDraft {
                            expected_revision: self.draft_revision,
                        },
                    );
                    return;
                }
                self.persisted_version = self.version;
            } else {
                let fields = self.durable_fields(changed);
                self.issue(
                    Phase::Save {
                        version: self.version,
                    },
                    Action::SaveDraft {
                        expected_revision: self.draft_revision,
                        fields,
                    },
                );
                return;
            }
        }
        if let Some(error) = self.deferred_error.take() {
            self.fail(error);
            // A navigation refresh queued behind the save is still allowed once
            // every raw field has a durable copy, even though that save failed.
            self.drive(_now_ms);
            return;
        }
        // Refresh waits for all writes and commits in the current flush.
        if self.flushing && self.view.dirty && !self.commit_stopped && self.reset_version.is_none()
        {
            let submitted = self.view.fields.clone();
            let previous = self.baseline.clone();
            self.issue(
                Phase::Commit {
                    submitted: submitted.clone(),
                    previous: previous.clone(),
                    version: self.version,
                },
                Action::Commit {
                    fields: submitted,
                    previous,
                },
            );
            return;
        }
        if self.reset_requested {
            let version = *self.reset_version.get_or_insert(self.version);
            if let Some(foreign) = &self.foreign_draft {
                self.issue(
                    Phase::ArchiveForeign,
                    Action::ArchiveDraft {
                        fields: foreign.fields.clone(),
                    },
                );
                return;
            }
            if self.draft_revision != 0 {
                self.issue(
                    Phase::Reset { version },
                    Action::RemoveDraft {
                        expected_revision: self.draft_revision,
                    },
                );
                return;
            }
            self.finish_reset(version);
        }
        if self.flushing {
            self.finish_flush(true);
        }
        if self.refresh_requested {
            self.refresh_requested = false;
            self.issue(
                Phase::Load {
                    version: self.version,
                },
                Action::Load,
            );
        }
    }
}
#[cfg(test)]
#[path = "editing/tests.rs"]
mod tests;
