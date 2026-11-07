// SPDX-License-Identifier: GPL-3.0-or-later
//! One local writer owns unfinished AI forms. FIFO barriers drain writes before
//! close/export/restore. This queue never sends an AI request or settles a receipt.
use super::super::{
    editors::{FlushFuture, FlushPurpose},
    session::Backend,
};
use crate::{application::continuations::AiContinuation, commands};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, AtomicUsize, Ordering},
    },
};
use surtitle_core::workspace::{ArchiveUiDraft, SaveUiDraft};
use tokio::sync::{Notify, mpsc, oneshot};
#[derive(Clone)]
pub(super) struct Persistence {
    shared: Arc<Shared>,
    sender: mpsc::UnboundedSender<Message>,
    backend: Backend,
}
struct Shared {
    generation: AtomicU64,
    queued: AtomicUsize,
    active: AtomicUsize,
    notify: Notify,
    gate: Mutex<Option<(FlushPurpose, bool)>>,
    errors: Mutex<BTreeMap<String, String>>,
    notice: Mutex<Option<String>>,
    raw_epochs: Mutex<BTreeMap<String, u64>>,
    continuation_epochs: Mutex<BTreeMap<String, u64>>,
    continuation_reads: AtomicU64,
    card_recovery: Mutex<BTreeSet<String>>,
}
#[derive(Clone)]
pub(super) struct RawInput {
    pub id: String,
    pub expected_revision: u64,
    pub fields: BTreeMap<String, String>,
    pub force: bool,
    pub lease: u64,
}
enum Message {
    Continuation(Box<AiContinuation>, u64),
    Raw(RawInput, u64),
    Flush(oneshot::Sender<Result<(), String>>, u64),
    Reset(u64),
    RetireRaw(String),
    RetireContinuation(String),
}
pub(super) struct Operation {
    shared: Arc<Shared>,
}
impl Drop for Operation {
    fn drop(&mut self) {
        self.shared.active.fetch_sub(1, Ordering::AcqRel);
        self.shared.notify.notify_waiters();
    }
}
fn locked<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}
impl Persistence {
    pub fn continuation_read_epoch(&self) -> u64 {
        self.shared.continuation_reads.load(Ordering::Acquire)
    }
    pub fn continuation_read_current(&self, epoch: u64) -> bool {
        self.continuation_read_epoch() == epoch
    }
    pub async fn continuation_changed(&self, previous: u64) -> u64 {
        loop {
            // Register before reading: a completed save between this check and
            // await must not lose its notification.
            let changed = self.shared.notify.notified();
            let current = self.continuation_read_epoch();
            if current != previous {
                return current;
            }
            changed.await;
        }
    }
    pub fn continuation_epoch(&self, id: &str) -> u64 {
        *locked(&self.shared.continuation_epochs)
            .get(id)
            .unwrap_or(&0)
    }
    pub fn continuation_retired(&self, id: &str, lease: u64) -> bool {
        self.continuation_epoch(id) != lease
    }
    pub fn retire_continuation(&self, id: &str) -> Result<(), String> {
        if !locked(&self.shared.gate)
            .as_ref()
            .is_some_and(|(_, ready)| *ready)
            || self.pending()
        {
            return Err("Discard requires a successful, fully drained AI input gate".into());
        }
        *locked(&self.shared.continuation_epochs)
            .entry(id.into())
            .or_default() += 1;
        self.shared
            .continuation_reads
            .fetch_add(1, Ordering::AcqRel);
        self.sender
            .send(Message::RetireContinuation(id.into()))
            .map_err(|_| "AI input writer stopped".into())
    }
    pub fn raw_epoch(&self, id: &str) -> u64 {
        *locked(&self.shared.raw_epochs).get(id).unwrap_or(&0)
    }
    pub fn raw_retired(&self, id: &str, lease: u64) -> bool {
        self.raw_epoch(id) != lease
    }
    pub fn request_card_recovery(&self, id: String) {
        locked(&self.shared.card_recovery).insert(id);
    }
    pub fn take_card_recovery(&self, id: &str) -> bool {
        locked(&self.shared.card_recovery).remove(id)
    }
    pub fn retire_raw(&self, id: &str) -> Result<(), String> {
        if !locked(&self.shared.gate)
            .as_ref()
            .is_some_and(|(_, ready)| *ready)
            || self.shared.active.load(Ordering::Acquire) != 0
            || self.shared.queued.load(Ordering::Acquire) != 0
        {
            return Err("Discard requires a successful, fully drained AI input gate".into());
        }
        let mut epochs = locked(&self.shared.raw_epochs);
        let epoch = epochs.entry(id.into()).or_default();
        *epoch += 1;
        self.sender
            .send(Message::RetireRaw(id.into()))
            .map_err(|_| "AI input writer stopped".to_string())
    }
    pub fn generation(&self) -> u64 {
        self.shared.generation.load(Ordering::Acquire)
    }
    pub fn retired(&self, generation: u64) -> bool {
        generation != self.backend.generation.load(Ordering::Acquire)
    }
    pub fn new(backend: Backend) -> Self {
        let generation = backend.generation.load(Ordering::Acquire);
        let shared = Arc::new(Shared {
            generation: AtomicU64::new(generation),
            queued: AtomicUsize::new(0),
            active: AtomicUsize::new(0),
            notify: Notify::new(),
            gate: Mutex::new(None),
            errors: Mutex::new(BTreeMap::new()),
            notice: Mutex::new(None),
            raw_epochs: Mutex::new(BTreeMap::new()),
            continuation_epochs: Mutex::new(BTreeMap::new()),
            continuation_reads: AtomicU64::new(0),
            card_recovery: Mutex::new(BTreeSet::new()),
        });
        let (sender, mut receiver) = mpsc::unbounded_channel();
        let worker = shared.clone();
        let services = backend.state.clone();
        let current = backend.generation.clone();
        backend.host.runtime().spawn(async move {
            let mut versions: BTreeMap<String, u64> = BTreeMap::new();
            let mut raw: BTreeMap<String, RawInput> = BTreeMap::new();
            let mut continuations: BTreeMap<String, AiContinuation> = BTreeMap::new();
            while let Some(message) = receiver.recv().await {
                match message {
                    Message::Continuation(value, generation) => {
                        let value = *value;
                        let id = format!("continuation:{}", value.id);
                        let result = if current.load(Ordering::Acquire) != generation {
                            Err("Workspace changed; reopen the AI request".into())
                        } else {
                            commands::continuations::save_ai_continuation(&services, value.clone())
                                .map(|_| ())
                        };
                        if result.is_ok() {
                            continuations.remove(&value.id);
                        } else {
                            continuations.insert(value.id.clone(), value);
                        }
                        record(&worker, &id, result);
                        worker.queued.fetch_sub(1, Ordering::AcqRel);
                    }
                    Message::Raw(value, generation) => {
                        let id = value.id.clone();
                        let result = if current.load(Ordering::Acquire) != generation {
                            Err("Workspace changed; reopen transcript review".into())
                        } else {
                            write_raw(&services, &worker, &mut versions, &value)
                        };
                        if result.is_ok() {
                            raw.remove(&id);
                        } else {
                            raw.insert(id.clone(), value);
                        }
                        record(&worker, &id, result);
                        worker.queued.fetch_sub(1, Ordering::AcqRel);
                    }
                    Message::Flush(reply, generation) => {
                        if current.load(Ordering::Acquire) != generation {
                            let _ = reply.send(Err(
                                "Workspace changed before unfinished AI input was saved".into(),
                            ));
                            continue;
                        }
                        for (id, value) in continuations.clone() {
                            let result =
                                commands::continuations::save_ai_continuation(&services, value)
                                    .map(|_| ());
                            if result.is_ok() {
                                continuations.remove(&id);
                            }
                            record(&worker, &format!("continuation:{id}"), result);
                        }
                        for (id, value) in raw.clone() {
                            let result = write_raw(&services, &worker, &mut versions, &value);
                            if result.is_ok() {
                                raw.remove(&id);
                            }
                            record(&worker, &id, result);
                        }
                        let result = locked(&worker.errors)
                            .values()
                            .next()
                            .cloned()
                            .map_or(Ok(()), Err);
                        let _ = reply.send(result);
                    }
                    Message::Reset(generation) => {
                        versions.clear();
                        raw.clear();
                        continuations.clear();
                        locked(&worker.errors).clear();
                        *locked(&worker.notice) = None;
                        worker.generation.store(generation, Ordering::Release);
                    }
                    Message::RetireRaw(id) => {
                        versions.remove(&id);
                        raw.remove(&id);
                        locked(&worker.errors).remove(&id);
                    }
                    Message::RetireContinuation(id) => {
                        continuations.remove(&id);
                        locked(&worker.errors).remove(&format!("continuation:{id}"));
                    }
                }
                worker.notify.notify_waiters();
            }
        });
        Self {
            shared,
            sender,
            backend,
        }
    }
    pub fn frozen(&self) -> bool {
        locked(&self.shared.gate).is_some()
            || self.backend.exclusive.load(Ordering::Acquire)
            || self.shared.generation.load(Ordering::Acquire)
                != self.backend.generation.load(Ordering::Acquire)
    }
    pub fn pending(&self) -> bool {
        self.shared.queued.load(Ordering::Acquire) > 0
            || self.shared.active.load(Ordering::Acquire) > 0
            || !locked(&self.shared.errors).is_empty()
    }
    pub fn error(&self) -> Option<String> {
        locked(&self.shared.errors).values().next().cloned()
    }
    pub fn notice(&self) -> Option<String> {
        locked(&self.shared.notice).clone()
    }
    pub fn operation(&self) -> Result<Operation, String> {
        let gate = locked(&self.shared.gate);
        if gate.is_some() || self.frozen_generation() {
            return Err("AI forms are frozen while saving or restoring".into());
        }
        self.shared.active.fetch_add(1, Ordering::AcqRel);
        drop(gate);
        Ok(Operation {
            shared: self.shared.clone(),
        })
    }
    fn frozen_generation(&self) -> bool {
        self.shared.generation.load(Ordering::Acquire)
            != self.backend.generation.load(Ordering::Acquire)
            || self.backend.exclusive.load(Ordering::Acquire)
    }
    pub fn continuation(&self, value: AiContinuation, lease: u64) -> Result<(), String> {
        let gate = locked(&self.shared.gate);
        if gate.is_some() || self.frozen_generation() {
            return Err("AI request is frozen".into());
        }
        if self.continuation_retired(&value.id, lease) {
            return Err("This AI input was discarded; open a new request".into());
        }
        self.shared.queued.fetch_add(1, Ordering::AcqRel);
        if self
            .sender
            .send(Message::Continuation(
                Box::new(value),
                self.shared.generation.load(Ordering::Acquire),
            ))
            .is_err()
        {
            self.shared.queued.fetch_sub(1, Ordering::AcqRel);
            return Err("AI input writer stopped".into());
        }
        // Accepted raw input invalidates already captured list/open results,
        // even while its serialized durable write is still pending.
        self.shared
            .continuation_reads
            .fetch_add(1, Ordering::AcqRel);
        self.shared.notify.notify_waiters();
        Ok(())
    }
    pub fn raw(&self, value: RawInput) -> Result<(), String> {
        let gate = locked(&self.shared.gate);
        if gate.is_some() || self.frozen_generation() {
            return Err("Transcript editor is frozen".into());
        }
        if self.raw_retired(&value.id, value.lease) {
            return Err("This unfinished input was discarded; reopen the editor".into());
        }
        self.shared.queued.fetch_add(1, Ordering::AcqRel);
        if self
            .sender
            .send(Message::Raw(
                value,
                self.shared.generation.load(Ordering::Acquire),
            ))
            .is_err()
        {
            self.shared.queued.fetch_sub(1, Ordering::AcqRel);
            return Err("Transcript input writer stopped".into());
        }
        Ok(())
    }
    pub fn flush(&self, purpose: FlushPurpose) -> FlushFuture {
        {
            let mut gate = locked(&self.shared.gate);
            if gate.is_some()
                || self.shared.generation.load(Ordering::Acquire)
                    != self.backend.generation.load(Ordering::Acquire)
            {
                return Box::pin(async { Err("Another AI save or restore is in progress".into()) });
            }
            if purpose != FlushPurpose::Save {
                *gate = Some((purpose, false));
            }
        }
        let this = self.clone();
        Box::pin(async move {
            loop {
                let changed = this.shared.notify.notified();
                if this.shared.active.load(Ordering::Acquire) == 0 {
                    break;
                }
                changed.await;
            }
            let (reply, wait) = oneshot::channel();
            let result = if this
                .sender
                .send(Message::Flush(
                    reply,
                    this.shared.generation.load(Ordering::Acquire),
                ))
                .is_err()
            {
                Err("AI input writer stopped".into())
            } else {
                wait.await
                    .unwrap_or_else(|_| Err("AI input writer stopped".into()))
            };
            if purpose != FlushPurpose::Save {
                let mut gate = locked(&this.shared.gate);
                if result.is_ok() {
                    *gate = Some((purpose, true));
                } else {
                    *gate = None;
                }
            }
            result
        })
    }
    /// Drain local input before a tracked domain operation. Unlike flush, this
    /// does not wait for that operation's own guard or acquire an exclusive gate.
    pub fn drain_inputs(&self) -> FlushFuture {
        let (reply, wait) = oneshot::channel();
        let sent = self
            .sender
            .send(Message::Flush(
                reply,
                self.shared.generation.load(Ordering::Acquire),
            ))
            .is_ok();
        Box::pin(async move {
            if !sent {
                return Err("AI input writer stopped".into());
            }
            wait.await
                .unwrap_or_else(|_| Err("AI input writer stopped".into()))
        })
    }
    pub fn resume(&self) -> Result<(), String> {
        let mut gate = locked(&self.shared.gate);
        if gate.as_ref().is_some_and(|(_, ready)| !*ready) {
            return Err("AI operations are still saving".into());
        }
        *gate = None;
        Ok(())
    }
    pub fn restored(&self) -> Result<(), String> {
        let mut gate = locked(&self.shared.gate);
        if *gate != Some((FlushPurpose::Restore, true))
            || self.shared.active.load(Ordering::Acquire) != 0
            || self.shared.queued.load(Ordering::Acquire) != 0
        {
            return Err("Restore requires a successful AI flush gate".into());
        }
        let generation = self.backend.generation.load(Ordering::Acquire);
        if generation == self.shared.generation.load(Ordering::Acquire) {
            return Err("Invalidate the editor registry generation before AI forms".into());
        }
        self.sender
            .send(Message::Reset(generation))
            .map_err(|_| "AI input writer stopped".to_string())?;
        self.shared.generation.store(generation, Ordering::Release);
        *gate = None;
        Ok(())
    }
}
fn record(shared: &Shared, id: &str, result: Result<(), String>) {
    let mut errors = locked(&shared.errors);
    if let Err(error) = result {
        errors.insert(id.into(), error);
    } else {
        errors.remove(id);
    }
}
fn write_raw(
    state: &crate::application::AppState,
    shared: &Shared,
    versions: &mut BTreeMap<String, u64>,
    value: &RawInput,
) -> Result<(), String> {
    let expected = *versions
        .entry(value.id.clone())
        .or_insert(value.expected_revision);
    let mut expected = expected;
    if value.force
        && let Some(foreign) =
            commands::ui_drafts::get_ui_draft(state, "transcript_review".into(), value.id.clone())?
    {
        commands::ui_drafts::archive_ui_draft(
            state,
            ArchiveUiDraft {
                kind: "transcript_review".into(),
                entity_id: value.id.clone(),
                fields: foreign.fields,
            },
        )?;
        expected = foreign.revision;
    }
    match commands::ui_drafts::save_ui_draft(
        state,
        SaveUiDraft {
            kind: "transcript_review".into(),
            entity_id: value.id.clone(),
            expected_revision: expected,
            fields: value.fields.clone(),
        },
    ) {
        Ok(saved) => {
            versions.insert(value.id.clone(), saved.revision);
            Ok(())
        }
        Err(error) => {
            let latest = commands::ui_drafts::get_ui_draft(
                state,
                "transcript_review".into(),
                value.id.clone(),
            )?;
            if latest.as_ref().map_or(0, |draft| draft.revision) != expected {
                commands::ui_drafts::archive_ui_draft(
                    state,
                    ArchiveUiDraft {
                        kind: "transcript_review".into(),
                        entity_id: value.id.clone(),
                        fields: value.fields.clone(),
                    },
                )?;
                *locked(&shared.notice)=Some("Another writer changed this raw draft. Your input was archived; recover it explicitly before replacing the active draft".into());
                Ok(())
            } else {
                Err(error)
            }
        }
    }
}

#[cfg(test)]
#[path = "persistence_tests.rs"]
mod tests;
