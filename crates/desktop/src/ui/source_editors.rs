// SPDX-License-Identifier: GPL-3.0-or-later
//! Retains source-bound raw input across dialogs and serializes its CAS writes.
use super::{editors::FlushFuture, session::Backend};
use crate::controller::editing::EditFields;
use gpui_kit::Context;
use std::{
    collections::BTreeMap,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
use surtitle_core::{EditorDraftVersion, EditorDraftView, SubtitleSegment};
use tokio::sync::{mpsc, oneshot};
mod worker;
pub(crate) use worker::{DraftAction, DraftOutcome};

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct SourceKey {
    generation: u64,
    id: String,
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;

    fn phrase_options() -> SourceOptions {
        SourceOptions {
            media_id: "media".into(),
            kind: "phrase".into(),
            source_key: "cue".into(),
            source_cues: vec![],
            initial: [
                ("term".into(), String::new()),
                ("meaning".into(), String::new()),
                ("example".into(), "Current source".into()),
            ]
            .into(),
            resume: None,
        }
    }

    #[test]
    fn consumed_phrase_reopens_blank_only_after_all_requests_complete() {
        let incoming = phrase_options();
        let mut saved = incoming.clone();
        saved.initial.insert("term".into(), "Previous card".into());
        saved
            .initial
            .insert("meaning".into(), "Previous meaning".into());
        let (send, mut requests) = worker::channel();
        let entry = Entry {
            options: saved.clone(),
            view: SourceView {
                fields: saved.initial,
                ready: true,
                saving: false,
                consumed: true,
                error: None,
                draft: None,
            },
            input_version: 1,
            send,
        };
        let (reply, _received) = oneshot::channel();
        entry.send.send(worker::Request::Flush(reply)).unwrap();
        assert!(
            entry.reopen_options(&incoming).is_none(),
            "queued work must stay alive"
        );
        let executing = requests.try_recv().unwrap();
        assert!(
            entry.reopen_options(&incoming).is_none(),
            "dequeued work must finish too"
        );
        drop(executing);
        let reopened = entry.reopen_options(&incoming).unwrap();
        assert_eq!(reopened.initial["term"], "");
        assert_eq!(reopened.initial["meaning"], "");
        assert_eq!(reopened.initial["example"], "Current source");
    }

    #[test]
    fn consumed_subtitle_uses_committed_options_without_reusing_a_recovery_reference() {
        let mut incoming = phrase_options();
        incoming.kind = "subtitle".into();
        incoming.initial = [("text".into(), "Before commit".into())].into();
        let mut saved = incoming.clone();
        saved
            .initial
            .insert("text".into(), "Committed subtitle".into());
        saved.resume = Some(EditorDraftVersion {
            id: "consumed".into(),
            version: 3,
        });
        let (send, _requests) = worker::channel();
        let mut entry = Entry {
            options: saved.clone(),
            view: SourceView {
                fields: saved.initial,
                ready: true,
                saving: true,
                consumed: true,
                error: None,
                draft: None,
            },
            input_version: 1,
            send,
        };
        assert!(entry.reopen_options(&incoming).is_none());
        entry.view.saving = false;
        let reopened = entry.reopen_options(&incoming).unwrap();
        assert_eq!(reopened.initial["text"], "Committed subtitle");
        assert!(reopened.resume.is_none());
        incoming.resume = Some(EditorDraftVersion {
            id: "consumed".into(),
            version: 3,
        });
        assert!(
            entry.reopen_options(&incoming).is_none(),
            "a deleted recovery item must never reopen as a new draft"
        );
    }
}
#[derive(Clone)]
pub(crate) struct SourceOptions {
    pub media_id: String,
    pub kind: String,
    pub source_key: String,
    pub source_cues: Vec<SubtitleSegment>,
    pub initial: EditFields,
    pub resume: Option<EditorDraftVersion>,
}
pub(super) fn subtitle_fields(cue: &SubtitleSegment) -> EditFields {
    let precise = |ms| format!("{}.{:03}", super::library::timestamp(ms), ms % 1000);
    [
        ("start".into(), precise(cue.start_ms)),
        ("end".into(), precise(cue.end_ms)),
        ("text".into(), cue.text.clone()),
        (
            "translation".into(),
            cue.translation.clone().unwrap_or_default(),
        ),
    ]
    .into()
}
#[derive(Clone)]
pub(crate) struct SourceView {
    pub fields: EditFields,
    pub ready: bool,
    pub saving: bool,
    pub error: Option<String>,
    pub draft: Option<EditorDraftView>,
    consumed: bool,
}
struct Entry {
    options: SourceOptions,
    view: SourceView,
    input_version: u64,
    send: worker::Sender,
}
impl Entry {
    fn reopen_options(&self, incoming: &SourceOptions) -> Option<SourceOptions> {
        if incoming.resume.is_some()
            || !self.view.consumed
            || self.view.saving
            || !self.send.drained()
        {
            return None;
        }
        let mut options = if incoming.kind == "subtitle" {
            self.options.clone()
        } else {
            incoming.clone()
        };
        options.resume = None;
        Some(options)
    }
}
pub(crate) struct SourceEditors {
    backend: Backend,
    generation: u64,
    entries: BTreeMap<SourceKey, Entry>,
    frozen: bool,
    drained: Arc<AtomicBool>,
}
impl SourceEditors {
    pub fn new(backend: Backend, _: &mut Context<Self>) -> Self {
        let generation = backend.generation.load(Ordering::Acquire);
        Self {
            backend,
            generation,
            entries: BTreeMap::new(),
            frozen: false,
            drained: Arc::new(AtomicBool::new(false)),
        }
    }
    pub fn ensure(
        &mut self,
        mut options: SourceOptions,
        cx: &mut Context<Self>,
    ) -> Result<SourceKey, String> {
        if self.frozen() {
            return Err("Editing is temporarily paused".into());
        }
        if let Some((existing, entry)) = self.entries.iter().find(|(_, entry)| {
            if let Some(reference) = &options.resume {
                entry
                    .view
                    .draft
                    .as_ref()
                    .is_some_and(|draft| draft.draft.id == reference.id)
                    || entry
                        .options
                        .resume
                        .as_ref()
                        .is_some_and(|saved| saved.id == reference.id)
            } else {
                entry.options.media_id == options.media_id
                    && entry.options.kind == options.kind
                    && entry.options.source_key == options.source_key
            }
        }) {
            let existing = existing.clone();
            if let Some(reopened) = entry.reopen_options(&options) {
                options = reopened;
                self.entries.remove(&existing);
            } else if entry.options.resume.is_some()
                && !entry.view.ready
                && entry.input_version == 0
                && entry.view.error.is_some()
                && entry.send.drained()
            {
                // A rejected preview never accepted edits or started a write.
                // A refreshed list may now point at the current saved revision.
                self.entries.remove(&existing);
            } else if entry.view.consumed {
                return Err("The previous edit is still finishing; reopen it in a moment".into());
            } else if let Some(reference) = &options.resume
                && (entry.view.saving
                    || !entry
                        .view
                        .draft
                        .as_ref()
                        .is_some_and(|draft| draft.draft.version == reference.version))
            {
                return Err(
                    "The draft has newer input; wait for it to save and refresh the list".into(),
                );
            } else {
                return Ok(existing);
            }
        }
        // Each incarnation has a distinct key: a late callback from an old
        // dialog or worker must never mutate its replacement.
        let key = SourceKey {
            generation: self.generation,
            id: surtitle_core::id(),
        };
        let (send, requests) = worker::channel();
        let (updates, mut received) = mpsc::unbounded_channel();
        let view = SourceView {
            fields: options.initial.clone(),
            ready: false,
            saving: true,
            error: None,
            draft: None,
            consumed: false,
        };
        self.entries.insert(
            key.clone(),
            Entry {
                options: options.clone(),
                view,
                input_version: 0,
                send,
            },
        );
        let state = self.backend.state.clone();
        self.backend
            .host
            .runtime()
            .spawn(worker::run(state, options, requests, updates));
        let target = key.clone();
        cx.spawn(async move |this, cx| {
            while let Some(update) = received.recv().await {
                if this
                    .update(cx, |this, cx| {
                        if let Some(entry) = this.entries.get_mut(&target) {
                            if entry.input_version == 0 && update.initial {
                                entry.view.fields = update.fields;
                            }
                            entry.view.ready = update.ready;
                            entry.view.saving =
                                update.saving || entry.input_version > update.version;
                            entry.view.error = update.error;
                            entry.view.draft = update.draft;
                            entry.view.consumed =
                                update.consumed && entry.input_version <= update.version;
                            entry.options = update.options;
                            cx.notify();
                        }
                    })
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
        Ok(key)
    }
    pub fn view(&self, key: &SourceKey) -> Option<&SourceView> {
        self.entries.get(key).map(|entry| &entry.view)
    }
    pub fn options(&self, key: &SourceKey) -> Option<&SourceOptions> {
        self.entries.get(key).map(|entry| &entry.options)
    }
    pub fn frozen(&self) -> bool {
        self.frozen || self.backend.exclusive.load(Ordering::Acquire)
    }
    pub fn freeze(&mut self, value: bool, cx: &mut Context<Self>) {
        self.frozen = value;
        self.drained.store(false, Ordering::Release);
        cx.notify();
    }
    pub fn change(&mut self, key: &SourceKey, fields: EditFields, cx: &mut Context<Self>) -> bool {
        if self.frozen() || key.generation != self.generation {
            return false;
        }
        let Some(entry) = self.entries.get_mut(key) else {
            return false;
        };
        entry.input_version += 1;
        entry.view.fields = fields.clone();
        entry.view.saving = true;
        entry.view.consumed = false;
        entry.view.error = None;
        if entry
            .send
            .send(worker::Request::Change {
                version: entry.input_version,
                fields,
            })
            .is_err()
        {
            entry.view.error = Some("Draft writer stopped".into());
            return false;
        }
        cx.notify();
        true
    }
    pub fn flush(&mut self, key: &SourceKey) -> FlushFuture {
        let Some(entry) = self.entries.get(key) else {
            return Box::pin(async { Err("Reopen this editor after restoring data".into()) });
        };
        let (tx, rx) = oneshot::channel();
        let sent = entry.send.send(worker::Request::Flush(tx)).is_ok();
        Box::pin(async move {
            if !sent {
                return Err("Draft writer stopped".into());
            }
            rx.await.map_err(|_| "Draft writer stopped".to_owned())?
        })
    }
    pub fn flush_all(&mut self) -> FlushFuture {
        let keys: Vec<_> = self.entries.keys().cloned().collect();
        let futures: Vec<_> = keys.iter().map(|key| self.flush(key)).collect();
        let drained = self.drained.clone();
        let exclusive = self.frozen;
        Box::pin(async move {
            let mut failure = None;
            for future in futures {
                if let Err(error) = future.await {
                    failure.get_or_insert(error);
                }
            }
            if failure.is_none() && exclusive {
                drained.store(true, Ordering::Release);
            }
            failure.map_or(Ok(()), Err)
        })
    }
    pub fn action(
        &mut self,
        key: &SourceKey,
        action: DraftAction,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<DraftOutcome, String>> + Send>>
    {
        if self.frozen() || key.generation != self.generation {
            return Box::pin(async { Err("Editing is temporarily paused".into()) });
        }
        let Some(entry) = self.entries.get(key) else {
            return Box::pin(async { Err("Reopen this editor".into()) });
        };
        let (tx, rx) = oneshot::channel();
        let sent = entry.send.send(worker::Request::Action(action, tx)).is_ok();
        Box::pin(async move {
            if !sent {
                return Err("Draft writer stopped".into());
            }
            rx.await.map_err(|_| "Draft writer stopped".to_owned())?
        })
    }
    /// The caller must first freeze and await flush_all; no writer can outlive restore.
    pub fn retire_draft(&mut self, id: &str, cx: &mut Context<Self>) -> Result<(), String> {
        if !self.frozen || !self.drained.load(Ordering::Acquire) {
            return Err("Flush and freeze source drafts before discarding".into());
        }
        self.entries.retain(|_, entry| {
            !entry
                .view
                .draft
                .as_ref()
                .is_some_and(|draft| draft.draft.id == id)
                && !entry
                    .options
                    .resume
                    .as_ref()
                    .is_some_and(|reference| reference.id == id)
        });
        cx.notify();
        Ok(())
    }
    /// Retire source writers only after the gated media removal committed.
    pub fn retire_media(&mut self, media_id: &str, cx: &mut Context<Self>) -> Result<(), String> {
        if !self.frozen || !self.drained.load(Ordering::Acquire) {
            return Err("Flush and freeze source drafts before removing media".into());
        }
        self.entries
            .retain(|_, entry| entry.options.media_id != media_id);
        cx.notify();
        Ok(())
    }
    /// The caller must first freeze and await flush_all; no writer can outlive restore.
    pub fn invalidate_after_restore(&mut self, cx: &mut Context<Self>) -> Result<(), String> {
        if !self.frozen || !self.drained.load(Ordering::Acquire) {
            return Err("Flush and freeze source drafts before restoring".into());
        }
        self.entries.clear();
        self.generation = self.backend.generation.load(Ordering::Acquire);
        self.frozen = false;
        cx.notify();
        Ok(())
    }
}
