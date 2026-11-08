// SPDX-License-Identifier: GPL-3.0-or-later
//! Headless lifecycle behind the GPUI entity. Already dispatched operations stay
//! accounted for until completion, including across an external generation change.
use crate::controller::editing::{
    Action, Completion, EditFields, EditingSession, EditorView, Effect, FlushId, Token,
};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct EditorKey {
    kind: String,
    entity_id: String,
    generation: u64,
}
#[cfg(test)]
impl EditorKey {
    pub fn kind(&self) -> &str {
        &self.kind
    }
    pub fn entity_id(&self) -> &str {
        &self.entity_id
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FlushPurpose {
    Save,
    Export,
    Close,
    Restore,
}
pub(super) type BatchId = u64;
pub(super) struct Dispatch {
    pub key: EditorKey,
    pub effect: Effect,
}
pub(super) struct Work {
    pub dispatches: Vec<Dispatch>,
    pub finished: Vec<(BatchId, Result<(), String>)>,
}
struct Batch {
    pending: BTreeMap<EditorKey, FlushId>,
    error: Option<String>,
    gated: bool,
}
struct Gate {
    purpose: FlushPurpose,
    batch: BatchId,
    ready: bool,
}
type Operation = (EditorKey, u64, u64);
pub(super) struct RegistryState {
    generation: u64,
    sessions: BTreeMap<EditorKey, EditingSession>,
    executing: BTreeMap<Operation, Action>,
    batches: BTreeMap<BatchId, Batch>,
    next_batch: u64,
    gate: Option<Gate>,
    retiring: Option<u64>,
    recover_when_ready: BTreeSet<EditorKey>,
}
impl RegistryState {
    pub fn new(generation: u64) -> Self {
        Self {
            generation,
            sessions: BTreeMap::new(),
            executing: BTreeMap::new(),
            batches: BTreeMap::new(),
            next_batch: 0,
            gate: None,
            retiring: None,
            recover_when_ready: BTreeSet::new(),
        }
    }
    pub fn generation(&self) -> u64 {
        self.generation
    }
    pub fn ensure(
        &mut self,
        kind: &str,
        entity_id: &str,
        now_ms: u64,
    ) -> Result<EditorKey, String> {
        if !matches!(kind, "settings" | "card" | "draft_card") || entity_id.trim().is_empty() {
            return Err("Unsupported editor identity".into());
        }
        let key = EditorKey {
            kind: kind.into(),
            entity_id: entity_id.into(),
            generation: self.generation,
        };
        if self.sessions.contains_key(&key) {
            return Ok(key);
        }
        if self.frozen() {
            return Err("Editors are frozen while unfinished input is being saved".into());
        }
        let draft_only = if kind == "settings" {
            crate::controller::adapters::SETTINGS_DRAFT_ONLY
                .iter()
                .map(|key| (*key).to_owned())
                .collect()
        } else {
            vec![]
        };
        let mut session = EditingSession::new(kind, entity_id, draft_only);
        session.load(now_ms);
        self.sessions.insert(key.clone(), session);
        Ok(key)
    }
    pub fn view(&self, key: &EditorKey) -> Option<&EditorView> {
        self.sessions.get(key).map(EditingSession::view)
    }
    pub fn key_for(&self, kind: &str, id: &str) -> Option<EditorKey> {
        self.sessions
            .keys()
            .find(|key| {
                key.kind == kind && key.entity_id == id && key.generation == self.generation
            })
            .cloned()
    }
    pub fn change(&mut self, key: &EditorKey, fields: EditFields, now_ms: u64) -> bool {
        if self.frozen() {
            return false;
        }
        let Some(session) = self.sessions.get_mut(key) else {
            return false;
        };
        session.change(fields, now_ms);
        true
    }
    pub fn blur(&mut self, key: &EditorKey, now_ms: u64) -> Option<FlushId> {
        if self.frozen() {
            return None;
        }
        self.sessions
            .get_mut(key)
            .map(|session| session.blur(now_ms))
    }
    pub fn recover(&mut self, key: &EditorKey, now_ms: u64) -> bool {
        if self.frozen() {
            return false;
        }
        let Some(session) = self.sessions.get_mut(key) else {
            return false;
        };
        if session.view().ready {
            session.recover(now_ms);
        } else {
            self.recover_when_ready.insert(key.clone());
        }
        true
    }
    pub fn reset_draft(&mut self, key: &EditorKey, now_ms: u64) -> Option<FlushId> {
        if self.frozen() {
            return None;
        }
        self.sessions
            .get_mut(key)
            .map(|session| session.reset_draft(now_ms))
    }
    pub fn refresh(&mut self, key: &EditorKey, now_ms: u64) -> bool {
        if self.frozen() {
            return false;
        }
        let Some(session) = self.sessions.get_mut(key) else {
            return false;
        };
        session.refresh(now_ms);
        true
    }
    pub fn refresh_all(&mut self, now_ms: u64) {
        if !self.frozen() {
            for session in self.sessions.values_mut() {
                session.refresh(now_ms);
            }
        }
    }
    pub fn tick(&mut self, now_ms: u64) {
        if !self.frozen() {
            for session in self.sessions.values_mut() {
                session.tick(now_ms);
            }
        }
    }
    pub fn next_deadline(&self) -> Option<u64> {
        if self.frozen() {
            None
        } else {
            self.sessions
                .values()
                .filter_map(EditingSession::next_deadline)
                .min()
        }
    }
    #[cfg(test)]
    pub fn pending(&self) -> bool {
        !self.executing.is_empty() || self.sessions.values().any(EditingSession::pending)
    }
    /// Forget an entity only after its writes drained under an exclusive gate.
    /// Deletion must not leave a session attempting to reload or save that entity.
    pub fn retire(&mut self, key: &EditorKey) -> Result<(), String> {
        if !self.gate.as_ref().is_some_and(|gate| gate.ready)
            || self.executing.keys().any(|(owner, _, _)| owner == key)
            || self
                .batches
                .values()
                .any(|batch| batch.pending.contains_key(key))
        {
            return Err("Save pending edits before deleting this entity".into());
        }
        self.sessions.remove(key);
        self.recover_when_ready.remove(key);
        Ok(())
    }
    pub fn frozen(&self) -> bool {
        self.gate.is_some() || self.retiring.is_some()
    }
    pub fn begin_flush(&mut self, purpose: FlushPurpose, now_ms: u64) -> Result<BatchId, String> {
        if self.frozen() {
            return Err("Another exclusive editor operation is in progress".into());
        }
        self.next_batch += 1;
        let batch = self.next_batch;
        let gated = purpose != FlushPurpose::Save;
        if gated {
            self.gate = Some(Gate {
                purpose,
                batch,
                ready: false,
            });
        }
        let pending = self
            .sessions
            .iter_mut()
            .map(|(key, session)| (key.clone(), session.flush(now_ms)))
            .collect();
        self.batches.insert(
            batch,
            Batch {
                pending,
                error: None,
                gated,
            },
        );
        Ok(batch)
    }
    pub fn resume(&mut self) -> Result<(), String> {
        if self.retiring.is_some() || self.gate.as_ref().is_some_and(|gate| !gate.ready) {
            return Err("Editor operations have not finished".into());
        }
        self.gate = None;
        Ok(())
    }
    pub fn can_restore(&self) -> Result<(), String> {
        if self.retiring.is_none()
            && self.executing.is_empty()
            && self
                .gate
                .as_ref()
                .is_some_and(|gate| gate.purpose == FlushPurpose::Restore && gate.ready)
        {
            Ok(())
        } else {
            Err("Restore requires a successful, fully drained restore flush".into())
        }
    }
    pub fn invalidate_after_restore(&mut self, generation: u64) -> Result<(), String> {
        self.can_restore()?;
        self.recover_when_ready.clear();
        if generation <= self.generation {
            return Err("The restored workspace must have a new generation".into());
        }
        for session in self.sessions.values_mut() {
            session.invalidate("A backup was restored; reopen the editor");
        }
        self.sessions.clear();
        self.generation = generation;
        self.gate = None;
        Ok(())
    }
    /// Defensive handling for a generation changed outside the required restore
    /// gate. Suppress follow-up effects, but never cancel dispatched operations or
    /// report that they drained before their real callbacks have been collected.
    pub fn synchronize_generation(&mut self, generation: u64) {
        if generation == self.generation && self.retiring.is_none() {
            return;
        }
        if self.retiring == Some(generation) {
            return;
        }
        self.retiring = Some(generation);
        self.recover_when_ready.clear();
        for session in self.sessions.values_mut() {
            session.invalidate("The workspace changed; reopen the editor");
        }
        for batch in self.batches.values_mut() {
            batch.error = Some("The workspace changed before editors finished saving".into());
        }
    }
    pub fn complete(&mut self, key: &EditorKey, token: Token, completion: Completion, now_ms: u64) {
        let operation = (key.clone(), token.generation, token.id);
        let Some(action) = self.executing.get(&operation) else {
            return;
        };
        if !completion_matches(action, &completion) {
            return;
        }
        self.executing.remove(&operation);
        if self.retiring.is_none()
            && let Some(session) = self.sessions.get_mut(key)
        {
            session.complete(token, completion, now_ms);
            if session.view().ready && self.recover_when_ready.remove(key) {
                session.recover(now_ms);
            }
        }
    }
    pub fn work(&mut self) -> Work {
        let mut dispatches = vec![];
        let mut results = vec![];
        for (key, session) in &mut self.sessions {
            if self.retiring.is_none() {
                for effect in session.take_effects() {
                    self.executing.insert(
                        (key.clone(), effect.token.generation, effect.token.id),
                        effect.action.clone(),
                    );
                    dispatches.push(Dispatch {
                        key: key.clone(),
                        effect,
                    });
                }
            }
            for result in session.take_flush_results() {
                results.push((key.clone(), result, session.view().error.clone()));
            }
        }
        for (key, result, error) in results {
            for batch in self.batches.values_mut() {
                if batch.pending.get(&key) == Some(&result.id) {
                    batch.pending.remove(&key);
                    if !result.success && batch.error.is_none() {
                        batch.error = Some(
                            error
                                .clone()
                                .unwrap_or_else(|| "Unable to save unfinished input".into()),
                        );
                    }
                }
            }
        }
        if let Some(generation) = self.retiring
            && self.executing.is_empty()
        {
            self.sessions.clear();
            self.generation = generation;
            self.retiring = None;
            self.gate = None;
            for batch in self.batches.values_mut() {
                batch.pending.clear();
            }
        }
        let ready: Vec<_> = self
            .batches
            .iter()
            .filter(|(_, batch)| {
                batch.pending.is_empty() && (!batch.gated || self.executing.is_empty())
            })
            .map(|(id, _)| *id)
            .collect();
        let mut finished = vec![];
        for id in ready {
            let batch = self.batches.remove(&id).unwrap();
            let result = batch.error.map_or(Ok(()), Err);
            if self.gate.as_ref().is_some_and(|gate| gate.batch == id) {
                if result.is_ok() {
                    self.gate.as_mut().unwrap().ready = true;
                } else {
                    self.gate = None;
                }
            }
            finished.push((id, result));
        }
        Work {
            dispatches,
            finished,
        }
    }
}
fn completion_matches(action: &Action, completion: &Completion) -> bool {
    matches!(
        (action, completion),
        (Action::Load, Completion::Loaded(_))
            | (Action::ReadState, Completion::State(_))
            | (Action::ReadDraft, Completion::DraftRead(_))
            | (Action::SaveDraft { .. }, Completion::Draft(_))
            | (Action::RemoveDraft { .. }, Completion::Removed(_))
            | (Action::ArchiveDraft { .. }, Completion::Archived(_))
            | (Action::Commit { .. }, Completion::Committed(_))
    )
}
#[cfg(test)]
#[path = "tests.rs"]
mod tests;
