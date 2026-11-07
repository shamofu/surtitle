// SPDX-License-Identifier: GPL-3.0-or-later
//! GPUI lifetime owner for durable editing sessions. Screens hold EditorKeys;
//! navigation never drops the session or cancels a dispatched persistence write.
use super::session::Backend;
use crate::controller::{
    adapters,
    editing::{Action, Completion, EditFields, EditorView, FlushId},
};
use gpui_kit::{Context, Task};
use std::{
    collections::BTreeMap,
    future::Future,
    pin::Pin,
    sync::atomic::Ordering,
    time::{Duration, Instant},
};
use tokio::sync::oneshot;

#[path = "editors/lifecycle.rs"]
mod lifecycle;
use lifecycle::{BatchId, RegistryState};
pub(crate) use lifecycle::{EditorKey, FlushPurpose};

pub(crate) type FlushFuture = Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'static>>;

pub(crate) struct EditorRegistry {
    backend: Backend,
    state: RegistryState,
    origin: Instant,
    waiters: BTreeMap<BatchId, oneshot::Sender<Result<(), String>>>,
    timer: Option<Task<()>>,
    timer_deadline: Option<u64>,
    deferred_refresh: bool,
}
impl EditorRegistry {
    pub fn new(backend: Backend, _cx: &mut Context<Self>) -> Self {
        let generation = backend.generation.load(Ordering::Acquire);
        Self {
            backend,
            state: RegistryState::new(generation),
            origin: Instant::now(),
            waiters: BTreeMap::new(),
            timer: None,
            timer_deadline: None,
            deferred_refresh: false,
        }
    }
    pub fn ensure(
        &mut self,
        kind: &str,
        entity_id: &str,
        cx: &mut Context<Self>,
    ) -> Result<EditorKey, String> {
        if self.backend.exclusive.load(Ordering::Acquire) {
            return Err("Editors are frozen while the data operation finishes".into());
        }
        self.synchronize_generation();
        let result = self.state.ensure(kind, entity_id, self.now());
        self.pump(cx);
        result
    }
    pub fn view(&self, key: &EditorKey) -> Option<&EditorView> {
        self.state.view(key)
    }
    pub fn key_for(&self, kind: &str, id: &str) -> Option<EditorKey> {
        self.state.key_for(kind, id)
    }
    pub fn frozen(&self) -> bool {
        self.state.frozen() || self.backend.exclusive.load(Ordering::Acquire)
    }
    #[cfg(test)]
    pub fn pending(&self) -> bool {
        self.state.pending()
    }
    pub fn retire(&mut self, key: &EditorKey, cx: &mut Context<Self>) -> Result<(), String> {
        let result = self.state.retire(key);
        self.pump(cx);
        result
    }
    /// False means this key is retired, or an exclusive operation froze editing.
    pub fn change(&mut self, key: &EditorKey, fields: EditFields, cx: &mut Context<Self>) -> bool {
        if self.backend.exclusive.load(Ordering::Acquire) {
            return false;
        }
        self.synchronize_generation();
        let result = self.state.change(key, fields, self.now());
        self.pump(cx);
        result
    }
    pub fn blur(&mut self, key: &EditorKey, cx: &mut Context<Self>) -> Option<FlushId> {
        if self.backend.exclusive.load(Ordering::Acquire) {
            return None;
        }
        self.synchronize_generation();
        let result = self.state.blur(key, self.now());
        self.pump(cx);
        result
    }
    pub fn recover(&mut self, key: &EditorKey, cx: &mut Context<Self>) -> bool {
        if self.backend.exclusive.load(Ordering::Acquire) {
            return false;
        }
        self.synchronize_generation();
        let result = self.state.recover(key, self.now());
        self.pump(cx);
        result
    }
    #[cfg(test)]
    pub fn reset_draft(&mut self, key: &EditorKey, cx: &mut Context<Self>) -> Option<FlushId> {
        if self.backend.exclusive.load(Ordering::Acquire) {
            return None;
        }
        self.synchronize_generation();
        let result = self.state.reset_draft(key, self.now());
        self.pump(cx);
        result
    }
    /// Called only after the corresponding native domain submission succeeded.
    /// Root freezes user input before collecting such callbacks, then starts its
    /// registry flush so this cleanup is included in the close/export/restore.
    pub fn complete_submission(
        &mut self,
        key: &EditorKey,
        cx: &mut Context<Self>,
    ) -> Option<FlushId> {
        self.synchronize_generation();
        let result = self.state.reset_draft(key, self.now());
        self.pump(cx);
        result
    }
    pub fn refresh(&mut self, key: &EditorKey, cx: &mut Context<Self>) -> bool {
        self.synchronize_generation();
        if self.frozen() {
            self.deferred_refresh = true;
            return false;
        }
        let result = self.state.refresh(key, self.now());
        self.pump(cx);
        result
    }
    pub fn refresh_all(&mut self, cx: &mut Context<Self>) {
        self.synchronize_generation();
        if self.frozen() {
            self.deferred_refresh = true;
        } else {
            self.state.refresh_all(self.now());
        }
        self.pump(cx);
    }
    /// Export, close, and restore freeze new edits and submissions immediately.
    /// Their successful futures retain that gate until resume or restore invalidation.
    /// Failure thaws editing after all dispatched operations have been collected.
    pub fn flush_all(&mut self, purpose: FlushPurpose, cx: &mut Context<Self>) -> FlushFuture {
        self.synchronize_generation();
        let batch = match self.state.begin_flush(purpose, self.now()) {
            Ok(batch) => batch,
            Err(error) => {
                self.pump(cx);
                return Box::pin(async move { Err(error) });
            }
        };
        let (sender, receiver) = oneshot::channel();
        self.waiters.insert(batch, sender);
        self.pump(cx);
        Box::pin(async move {
            receiver
                .await
                .map_err(|_| "The editor registry closed before saving completed".to_string())?
        })
    }
    /// Release a completed export/close/restore gate when its consumer finishes or
    /// abandons the operation. An in-progress gate cannot be released early.
    pub fn resume(&mut self, cx: &mut Context<Self>) -> Result<(), String> {
        self.synchronize_generation();
        let result = self.state.resume();
        self.pump(cx);
        result
    }
    /// Call only after the backup replacement succeeded while its Restore gate was
    /// held. All old writes are drained before the shared display generation moves.
    pub fn invalidate_after_restore(&mut self, cx: &mut Context<Self>) -> Result<(), String> {
        self.state.can_restore()?;
        let previous = self.state.generation();
        let next = previous
            .checked_add(1)
            .ok_or_else(|| "Workspace generation overflow".to_string())?;
        if let Err(observed) = self.backend.generation.compare_exchange(
            previous,
            next,
            Ordering::AcqRel,
            Ordering::Acquire,
        ) {
            self.state.synchronize_generation(observed);
            self.pump(cx);
            return Err("The workspace generation changed during restore".into());
        }
        self.state.invalidate_after_restore(next)?;
        self.deferred_refresh = false;
        self.pump(cx);
        Ok(())
    }
    fn now(&self) -> u64 {
        self.origin.elapsed().as_millis().min(u64::MAX as u128) as u64
    }
    fn synchronize_generation(&mut self) {
        self.state
            .synchronize_generation(self.backend.generation.load(Ordering::Acquire));
    }
    fn pump(&mut self, cx: &mut Context<Self>) {
        self.synchronize_generation();
        if self.deferred_refresh && !self.frozen() {
            self.deferred_refresh = false;
            self.state.refresh_all(self.now());
        }
        let work = self.state.work();
        for (batch, result) in work.finished {
            if let Some(sender) = self.waiters.remove(&batch) {
                let _ = sender.send(result);
            }
        }
        for dispatch in work.dispatches {
            let state = self.backend.state.clone();
            let key = dispatch.key;
            let token = dispatch.effect.token;
            let action = dispatch.effect.action.clone();
            // Do not use session::run here: its display-generation filter must
            // never discard the callback that accounts for a persistence write.
            let task = self
                .backend
                .host
                .runtime()
                .spawn(async move { adapters::execute(state, dispatch.effect).await });
            cx.spawn(async move |registry, cx| {
                let completion = task.await.unwrap_or_else(|error| {
                    interrupted(action, format!("Editor operation interrupted: {error}"))
                });
                let _ = registry.update(cx, |registry, cx| {
                    registry.synchronize_generation();
                    registry
                        .state
                        .complete(&key, token, completion, registry.now());
                    registry.pump(cx);
                });
            })
            .detach();
        }
        self.arm_timer(cx);
        cx.notify();
        if self.deferred_refresh && !self.frozen() {
            self.pump(cx);
        }
    }
    fn arm_timer(&mut self, cx: &mut Context<Self>) {
        let deadline = self.state.next_deadline();
        if deadline == self.timer_deadline {
            return;
        }
        // Only the disposable timer is cancelled. Persistence tasks are detached
        // and remain represented in RegistryState until their actual completion.
        self.timer.take();
        self.timer_deadline = deadline;
        let Some(deadline) = deadline else {
            return;
        };
        let delay = Duration::from_millis(deadline.saturating_sub(self.now()));
        self.timer = Some(cx.spawn(async move |registry, cx| {
            cx.background_executor().timer(delay).await;
            let _ = registry.update(cx, |registry, cx| {
                registry.timer_deadline = None;
                registry.synchronize_generation();
                registry.state.tick(registry.now());
                registry.pump(cx);
            });
        }));
    }
}
fn interrupted(action: Action, error: String) -> Completion {
    match action {
        Action::Load => Completion::Loaded(Err(error)),
        Action::ReadState => Completion::State(Err(error)),
        Action::ReadDraft => Completion::DraftRead(Err(error)),
        Action::SaveDraft { .. } => Completion::Draft(Err(error)),
        Action::RemoveDraft { .. } => Completion::Removed(Err(error)),
        Action::ArchiveDraft { .. } => Completion::Archived(Err(error)),
        Action::Commit { .. } => Completion::Committed(Err(error)),
    }
}
