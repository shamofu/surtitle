// SPDX-License-Identifier: GPL-3.0-or-later
use super::{EditFields, SourceOptions};
use crate::{application::AppState, commands};
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use surtitle_core::{
    EditorDraftVersion, EditorDraftView, SaveCard, SaveEditorDraft, SubtitleSegment,
};
use tokio::sync::{mpsc, oneshot};

pub(crate) enum DraftAction {
    Subtitle(SubtitleSegment),
    Phrase(SaveCard),
    Rebind(Vec<SubtitleSegment>),
}
pub(crate) enum DraftOutcome {
    Saved(Option<String>),
    Rebound,
}
pub(super) enum Request {
    Change { version: u64, fields: EditFields },
    Flush(oneshot::Sender<Result<(), String>>),
    Action(DraftAction, oneshot::Sender<Result<DraftOutcome, String>>),
}
/// Counts queued and executing requests through their actual completion.
pub(super) struct Sender {
    send: mpsc::UnboundedSender<Queued>,
    pending: Arc<AtomicUsize>,
}
pub(super) struct Queued {
    request: Request,
    _pending: Pending,
}
struct Pending(Arc<AtomicUsize>);
impl Drop for Pending {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}
pub(super) fn channel() -> (Sender, mpsc::UnboundedReceiver<Queued>) {
    let (send, received) = mpsc::unbounded_channel();
    (
        Sender {
            send,
            pending: Arc::new(AtomicUsize::new(0)),
        },
        received,
    )
}
impl Sender {
    pub fn send(&self, request: Request) -> Result<(), ()> {
        self.pending.fetch_add(1, Ordering::AcqRel);
        self.send
            .send(Queued {
                request,
                _pending: Pending(self.pending.clone()),
            })
            .map_err(|_| ())
    }
    pub fn drained(&self) -> bool {
        self.pending.load(Ordering::Acquire) == 0
    }
}
pub(super) struct Update {
    pub options: SourceOptions,
    pub fields: EditFields,
    pub version: u64,
    pub ready: bool,
    pub saving: bool,
    pub initial: bool,
    pub draft: Option<EditorDraftView>,
    pub error: Option<String>,
    pub consumed: bool,
}
struct Writer {
    state: AppState,
    options: SourceOptions,
    fields: EditFields,
    saved: Option<EditFields>,
    version: u64,
    id: String,
    draft: Option<EditorDraftView>,
    loaded: bool,
    consumed: bool,
}
impl Writer {
    async fn load(&mut self) -> Result<(), String> {
        let state = self.state.clone();
        let media = self.options.media_id.clone();
        let drafts = tokio::task::spawn_blocking(move || {
            commands::editor_drafts::list_editor_drafts(&state, media)
        })
        .await
        .map_err(|error| error.to_string())??;
        let stored = drafts.into_iter().find(|draft| {
            if let Some(reference) = &self.options.resume {
                draft.draft.id == reference.id
            } else {
                draft.draft.kind == self.options.kind
                    && draft.draft.source_key == self.options.source_key
            }
        });
        if let Some(reference) = &self.options.resume {
            let current = stored
                .as_ref()
                .ok_or("The saved draft was removed; refresh unfinished input")?;
            if current.draft.version != reference.version
                || current.draft.kind != self.options.kind
                || current.draft.source_key != self.options.source_key
            {
                return Err("The saved draft changed; refresh unfinished input".into());
            }
        }
        if let Some(stored) = stored {
            self.id = stored.draft.id.clone();
            self.saved = Some(stored.draft.fields.clone());
            self.options.source_cues = stored.draft.source_cues.clone();
            if self.version == 0 {
                self.fields = stored.draft.fields.clone();
            }
            self.draft = Some(stored);
        }
        self.loaded = true;
        Ok(())
    }
    fn dirty(&self) -> bool {
        !self.consumed && self.saved.as_ref() != Some(&self.fields)
    }
    async fn persist(&mut self, force: bool) -> Result<(), String> {
        if !self.loaded {
            self.load().await?;
        }
        if self.consumed || (!self.dirty() && (!force || self.draft.is_some())) {
            return Ok(());
        }
        let fields = self.fields.clone();
        let state = self.state.clone();
        let request = SaveEditorDraft {
            id: self.id.clone(),
            media_id: self.options.media_id.clone(),
            kind: self.options.kind.clone(),
            source_key: self.options.source_key.clone(),
            expected_version: self.draft.as_ref().map_or(0, |draft| draft.draft.version),
            fields: fields.clone(),
            source_cues: self.options.source_cues.clone(),
        };
        let draft = tokio::task::spawn_blocking(move || {
            commands::editor_drafts::save_editor_draft(&state, request)
        })
        .await
        .map_err(|error| error.to_string())??;
        self.draft = Some(draft);
        self.saved = Some(fields);
        Ok(())
    }
    fn update(&self, saving: bool, initial: bool, error: Option<String>) -> Update {
        Update {
            options: self.options.clone(),
            fields: self.fields.clone(),
            version: self.version,
            ready: self.loaded,
            saving,
            initial,
            draft: self.draft.clone(),
            error,
            consumed: self.consumed,
        }
    }
    async fn action(&mut self, action: DraftAction) -> Result<DraftOutcome, String> {
        self.persist(true).await?;
        let draft = self.draft.as_ref().ok_or("Draft was already saved")?;
        let reference = EditorDraftVersion {
            id: draft.draft.id.clone(),
            version: draft.draft.version,
        };
        let outcome = match action {
            DraftAction::Subtitle(segment) => {
                let committed = segment.clone();
                let state = self.state.clone();
                let warning = tokio::task::spawn_blocking(move || {
                    commands::editor_drafts::commit_subtitle_editor_draft(
                        &state, reference, segment,
                    )
                })
                .await
                .map_err(|error| error.to_string())??;
                self.options.initial = super::subtitle_fields(&committed);
                self.options.source_cues = vec![committed];
                DraftOutcome::Saved(warning)
            }
            DraftAction::Phrase(request) => {
                commands::editor_drafts::save_phrase_editor_draft(
                    &self.state,
                    reference,
                    request,
                    Some(surtitle_core::id()),
                )
                .await?;
                DraftOutcome::Saved(None)
            }
            DraftAction::Rebind(cues) => {
                let state = self.state.clone();
                let source = cues.clone();
                let rebound = tokio::task::spawn_blocking(move || {
                    commands::editor_drafts::rebind_editor_draft(&state, reference, source)
                })
                .await
                .map_err(|error| error.to_string())??;
                self.options.source_cues = cues;
                self.options.source_key = rebound.draft.source_key.clone();
                self.draft = Some(rebound);
                return Ok(DraftOutcome::Rebound);
            }
        };
        self.consumed = true;
        self.draft = None;
        self.saved = Some(self.fields.clone());
        Ok(outcome)
    }
}

pub(super) async fn run(
    state: AppState,
    options: SourceOptions,
    mut requests: mpsc::UnboundedReceiver<Queued>,
    updates: mpsc::UnboundedSender<Update>,
) {
    let saved = if options.kind == "phrase" {
        None
    } else {
        Some(options.initial.clone())
    };
    let mut writer = Writer {
        state,
        fields: options.initial.clone(),
        options,
        saved,
        version: 0,
        id: surtitle_core::id(),
        draft: None,
        loaded: false,
        consumed: false,
    };
    let result = writer.load().await;
    let _ = updates.send(writer.update(writer.dirty(), true, result.err()));
    let mut deadline = writer
        .loaded
        .then(|| tokio::time::Instant::now() + Duration::from_millis(500));
    loop {
        let next = if let Some(at) = deadline {
            tokio::select! {message=requests.recv()=>message,_=tokio::time::sleep_until(at)=>{
                let result=writer.persist(false).await;let _=updates.send(writer.update(false,false,result.err()));deadline=None;continue;
            }}
        } else {
            requests.recv().await
        };
        let Some(queued) = next else {
            break;
        };
        match queued.request {
            Request::Change { version, fields } => {
                if writer.consumed {
                    writer.id = surtitle_core::id();
                    writer.consumed = false;
                    writer.saved = None;
                }
                writer.version = version;
                writer.fields = fields;
                deadline = Some(tokio::time::Instant::now() + Duration::from_millis(500));
            }
            Request::Flush(reply) => {
                deadline = None;
                // A rejected recovery preview contains no new input. Retain its
                // read-only error without making it block app shutdown.
                if !writer.loaded && writer.options.resume.is_some() && writer.version == 0 {
                    let _ = reply.send(Ok(()));
                    continue;
                }
                let result = writer.persist(false).await;
                let _ = updates.send(writer.update(false, false, result.clone().err()));
                let _ = reply.send(result);
            }
            Request::Action(action, reply) => {
                deadline = None;
                let result = writer.action(action).await;
                let _ = updates.send(writer.update(false, false, result.as_ref().err().cloned()));
                let _ = reply.send(result);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, AppState, SourceOptions) {
        let dir = tempfile::tempdir().unwrap();
        let state = crate::application::Services::open_with_runtime(
            dir.path().to_path_buf(),
            tokio::runtime::Handle::current(),
        )
        .unwrap();
        let mut store = surtitle_core::Store::open(dir.path().join("learning.sqlite")).unwrap();
        let media=serde_json::from_value(serde_json::json!({"id":"media","title":"Test","path":dir.path().join("source.mp4"),"kind":"video","durationMs":10000,
            "learningLanguage":"en","explanationLanguage":"ja","createdAt":surtitle_core::now(),"lastPositionMs":0,"segmentCount":1,"cardCount":0,"status":"ready","error":null})).unwrap();
        let cue:SubtitleSegment=serde_json::from_value(serde_json::json!({"id":"cue","mediaId":"media","startMs":100,"endMs":1000,"text":"Original","translation":null,"status":"confirmed"})).unwrap();
        store.put_media(&media).unwrap();
        store
            .set_segments("media", std::slice::from_ref(&cue))
            .unwrap();
        let fields = [
            ("start", "0.100"),
            ("end", "1.000"),
            ("text", "Original"),
            ("translation", ""),
        ]
        .into_iter()
        .map(|(key, value)| (key.into(), value.into()))
        .collect();
        (
            dir,
            state,
            SourceOptions {
                media_id: "media".into(),
                kind: "subtitle".into(),
                source_key: "cue".into(),
                source_cues: vec![cue],
                initial: fields,
                resume: None,
            },
        )
    }
    async fn flush(send: &Sender) -> Result<(), String> {
        let (tx, rx) = oneshot::channel();
        send.send(Request::Flush(tx)).unwrap();
        rx.await.unwrap()
    }
    #[tokio::test]
    async fn saved_subtitle_reopens_with_committed_fields_and_can_save_again() {
        let (_dir, state, options) = fixture();
        let mut committed = options.source_cues[0].clone();
        committed.start_ms = 250;
        committed.text = "Saved subtitle".into();
        committed.translation = Some("保存した訳".into());
        let (send, requests) = channel();
        let (updates, mut received) = mpsc::unbounded_channel();
        let task = tokio::spawn(run(state.clone(), options, requests, updates));
        received.recv().await.unwrap();
        let (tx, rx) = oneshot::channel();
        send.send(Request::Action(
            DraftAction::Subtitle(committed.clone()),
            tx,
        ))
        .unwrap();
        assert!(matches!(rx.await.unwrap().unwrap(), DraftOutcome::Saved(_)));
        let saved = received.recv().await.unwrap();
        assert!(saved.draft.is_none());
        assert_eq!(saved.options.initial["text"], "Saved subtitle");
        assert_eq!(saved.options.initial["translation"], "保存した訳");
        assert_eq!(saved.options.initial["start"], "0:00.250");
        assert_eq!(saved.options.source_cues[0].text, "Saved subtitle");
        drop(send);
        task.await.unwrap();

        let (send, requests) = channel();
        let (updates, mut received) = mpsc::unbounded_channel();
        let task = tokio::spawn(run(state.clone(), saved.options, requests, updates));
        let reopened = received.recv().await.unwrap();
        assert_eq!(reopened.fields["text"], "Saved subtitle");
        let (tx, rx) = oneshot::channel();
        send.send(Request::Action(DraftAction::Subtitle(committed), tx))
            .unwrap();
        assert!(matches!(rx.await.unwrap().unwrap(), DraftOutcome::Saved(_)));
        assert!(
            commands::editor_drafts::list_editor_drafts(&state, "media".into())
                .unwrap()
                .is_empty()
        );
        drop(send);
        task.await.unwrap();
    }
    #[tokio::test]
    async fn immediate_close_flushes_latest_raw_input_even_while_initial_load_is_pending() {
        let (_dir, state, options) = fixture();
        let mut fields = options.initial.clone();
        fields.insert("start".into(), "00:".into());
        fields.insert("text".into(), "Latest unfinished input".into());
        let (send, requests) = channel();
        let (updates, _received) = mpsc::unbounded_channel();
        let task = tokio::spawn(run(state.clone(), options, requests, updates));
        send.send(Request::Change {
            version: 1,
            fields: fields.clone(),
        })
        .unwrap();
        flush(&send).await.unwrap();
        let drafts = commands::editor_drafts::list_editor_drafts(&state, "media".into()).unwrap();
        assert_eq!(drafts.len(), 1);
        assert_eq!(drafts[0].draft.fields, fields);
        drop(send);
        task.await.unwrap();
    }
    #[tokio::test]
    async fn old_save_then_new_input_flush_cannot_restore_the_old_raw_value() {
        let (_dir, state, options) = fixture();
        let mut fields = options.initial.clone();
        let (send, requests) = channel();
        let (updates, _received) = mpsc::unbounded_channel();
        let task = tokio::spawn(run(state.clone(), options, requests, updates));
        fields.insert("text".into(), "First".into());
        send.send(Request::Change {
            version: 1,
            fields: fields.clone(),
        })
        .unwrap();
        let (tx, rx) = oneshot::channel();
        send.send(Request::Flush(tx)).unwrap();
        fields.insert("text".into(), "Second".into());
        send.send(Request::Change {
            version: 2,
            fields: fields.clone(),
        })
        .unwrap();
        rx.await.unwrap().unwrap();
        flush(&send).await.unwrap();
        let drafts = commands::editor_drafts::list_editor_drafts(&state, "media".into()).unwrap();
        assert_eq!(drafts[0].draft.fields, fields);
        assert_eq!(drafts[0].draft.version, 2);
        drop(send);
        task.await.unwrap();
    }
    #[tokio::test]
    async fn stale_source_retains_raw_input_but_refuses_final_commit() {
        let (dir, state, options) = fixture();
        let source = options.source_cues[0].clone();
        let mut fields = options.initial.clone();
        let (send, requests) = channel();
        let (updates, _received) = mpsc::unbounded_channel();
        let task = tokio::spawn(run(state.clone(), options, requests, updates));
        fields.insert("text".into(), "Local edit".into());
        send.send(Request::Change {
            version: 1,
            fields: fields.clone(),
        })
        .unwrap();
        flush(&send).await.unwrap();
        let mut store = surtitle_core::Store::open(dir.path().join("learning.sqlite")).unwrap();
        let mut external = source.clone();
        external.text = "External replacement".into();
        store.set_segments("media", &[external]).unwrap();
        let (tx, rx) = oneshot::channel();
        let mut edited = source;
        edited.text = "Local edit".into();
        send.send(Request::Action(DraftAction::Subtitle(edited), tx))
            .unwrap();
        assert!(rx.await.unwrap().is_err());
        let drafts = commands::editor_drafts::list_editor_drafts(&state, "media".into()).unwrap();
        assert!(drafts[0].stale);
        assert_eq!(drafts[0].draft.fields, fields);
        assert_eq!(
            store.list_segments("media").unwrap()[0].text,
            "External replacement"
        );
        drop(send);
        task.await.unwrap();
    }

    #[tokio::test]
    async fn reopening_requires_the_exact_saved_draft_version_and_identity() {
        let (_dir, state, mut options) = fixture();
        let saved = commands::editor_drafts::save_editor_draft(
            &state,
            SaveEditorDraft {
                id: "saved".into(),
                media_id: options.media_id.clone(),
                kind: options.kind.clone(),
                source_key: options.source_key.clone(),
                expected_version: 0,
                fields: options.initial.clone(),
                source_cues: options.source_cues.clone(),
            },
        )
        .unwrap();
        for reference in [
            EditorDraftVersion {
                id: saved.draft.id.clone(),
                version: 0,
            },
            EditorDraftVersion {
                id: "deleted-draft".into(),
                version: 1,
            },
        ] {
            options.resume = Some(reference);
            let (send, requests) = channel();
            let (updates, mut received) = mpsc::unbounded_channel();
            let task = tokio::spawn(run(state.clone(), options.clone(), requests, updates));
            let loaded = received.recv().await.unwrap();
            assert!(
                !loaded.ready,
                "Never reuse another draft or a newer revision"
            );
            assert!(loaded.error.is_some());
            flush(&send).await.unwrap();
            drop(send);
            task.await.unwrap();
        }
        assert_eq!(
            commands::editor_drafts::list_editor_drafts(&state, "media".into())
                .unwrap()
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn reopening_stale_input_keeps_its_saved_source_and_does_not_rebind() {
        let (dir, state, mut options) = fixture();
        options
            .initial
            .insert("text".into(), " raw unfinished text ".into());
        let saved = commands::editor_drafts::save_editor_draft(
            &state,
            SaveEditorDraft {
                id: "saved".into(),
                media_id: options.media_id.clone(),
                kind: options.kind.clone(),
                source_key: options.source_key.clone(),
                expected_version: 0,
                fields: options.initial.clone(),
                source_cues: options.source_cues.clone(),
            },
        )
        .unwrap();
        let mut store = surtitle_core::Store::open(dir.path().join("learning.sqlite")).unwrap();
        let mut replacement = options.source_cues[0].clone();
        replacement.text = "Current subtitle".into();
        store.set_segments("media", &[replacement.clone()]).unwrap();
        options.source_cues = vec![replacement];
        options.resume = Some(EditorDraftVersion {
            id: saved.draft.id.clone(),
            version: saved.draft.version,
        });
        let (send, requests) = channel();
        let (updates, mut received) = mpsc::unbounded_channel();
        let task = tokio::spawn(run(state.clone(), options, requests, updates));
        let loaded = received.recv().await.unwrap();
        assert!(loaded.ready);
        assert!(loaded.draft.unwrap().stale);
        assert_eq!(loaded.fields["text"], " raw unfinished text ");
        assert_eq!(loaded.options.source_cues[0].text, "Original");
        flush(&send).await.unwrap();
        let drafts = commands::editor_drafts::list_editor_drafts(&state, "media".into()).unwrap();
        assert_eq!(drafts.len(), 1);
        assert_eq!(drafts[0].draft.version, saved.draft.version);
        assert!(drafts[0].stale);
        assert_eq!(
            store.list_segments("media").unwrap()[0].text,
            "Current subtitle"
        );
        drop(send);
        task.await.unwrap();
    }
}
