// SPDX-License-Identifier: GPL-3.0-or-later
//! In-process UI model. Services run on Tokio; results return to GPUI's executor.
use crate::{
    application::{
        AppState,
        ai::AppSnapshot,
        changes::{ChangeCheckpoint, DataChange},
    },
    commands,
    player::PlayerState,
    runtime::{DesktopEvent, DesktopHost},
};
use gpui_kit::{Context, EventEmitter};
use std::{
    future::Future,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};

#[derive(Clone)]
pub(crate) struct Backend {
    pub state: AppState,
    pub host: DesktopHost,
    pub generation: Arc<AtomicU64>,
    pub in_flight: super::in_flight::InFlight,
    pub exclusive: Arc<AtomicBool>,
}

impl Backend {
    pub fn new(state: AppState, host: DesktopHost) -> Self {
        Self {
            state,
            host,
            generation: Arc::new(AtomicU64::new(0)),
            in_flight: Default::default(),
            exclusive: Arc::new(AtomicBool::new(false)),
        }
    }
}

/// The async operation is polled on Tokio, never on GPUI's non-Tokio executor.
/// Invalidating a generation suppresses stale presentation, not the operation.
pub(crate) fn run<V: 'static, T: Send + 'static>(
    backend: &Backend,
    cx: &mut Context<V>,
    future: impl Future<Output = Result<T, String>> + Send + 'static,
    apply: impl FnOnce(&mut V, Result<T, String>, &mut Context<V>) + 'static,
) {
    let generation = backend.generation.clone();
    let started = generation.load(Ordering::Acquire);
    let operation = backend.in_flight.begin();
    let task = backend.host.runtime().spawn(future);
    cx.spawn(async move |view, cx| {
        let _operation = operation;
        let result = task
            .await
            .unwrap_or_else(|error| Err(format!("Operation interrupted: {error}")));
        if generation.load(Ordering::Acquire) == started {
            let _ = view.update(cx, |view, cx| {
                apply(view, result, cx);
                cx.notify();
            });
        }
    })
    .detach();
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Route {
    Library,
    Study(String),
    Cards,
    Review,
    Settings,
    Activity,
}

#[derive(Debug, Clone)]
pub(crate) enum UiEvent {
    PrepareCandidate(CandidateRequest),
    Changed(DataChange),
    Snapshot,
    Playback,
    Navigate(Route),
    SurfaceClick,
    Transfer,
    Recovery,
    DraftStudy(String),
    OpenAiJob(String),
    ManageMedia(String),
    ManageSubtitles {
        media_id: String,
        stream_index: u32,
    },
    OpenSourceDraft(surtitle_core::EditorDraftView),
    RebindAi {
        continuation_id: String,
        media_id: String,
    },
    ReboundAi {
        continuation_id: String,
        cues: Vec<surtitle_core::SubtitleSegment>,
    },
    Ai {
        intent: super::ai::AiIntent,
        cues: Vec<surtitle_core::SubtitleSegment>,
    },
}

#[derive(Debug, Clone)]
pub(crate) struct CandidateRequest {
    pub candidate: crate::application::ai::VocabularyCandidate,
    pub cues: Vec<surtitle_core::SubtitleSegment>,
    pub media_signature: String,
    reply: Arc<std::sync::Mutex<Option<CandidateReply>>>,
}
type CandidateReply = tokio::sync::oneshot::Sender<Result<surtitle_core::EditorDraftView, String>>;
impl CandidateRequest {
    pub fn finish(&self, result: Result<surtitle_core::EditorDraftView, String>) {
        if let Ok(mut reply) = self.reply.lock()
            && let Some(reply) = reply.take()
        {
            let _ = reply.send(result);
        }
    }
}

pub(crate) struct Session {
    pub backend: Backend,
    pub snapshot: Option<Arc<AppSnapshot>>,
    pub player: PlayerState,
    pub error: Option<String>,
    pub preparation: Option<surtitle_ai::PreparationProgress>,
    pub ai_runtime: Option<crate::application::ai::runtime::RuntimeSnapshot>,
    pub operations: Vec<crate::application::operations::OperationProgress>,
    checkpoint: Option<ChangeCheckpoint>,
    last_event: Option<(String, u64)>,
    refreshing: bool,
    dirty: bool,
}

impl EventEmitter<UiEvent> for Session {}

impl Session {
    pub fn new(backend: Backend, cx: &mut Context<Self>) -> Self {
        let mut this = Self {
            backend,
            snapshot: None,
            player: PlayerState::default(),
            error: None,
            preparation: None,
            ai_runtime: None,
            operations: vec![],
            checkpoint: None,
            last_event: None,
            refreshing: false,
            dirty: false,
        };
        this.refresh(cx);
        this
    }
    pub fn text<'a>(&self, ja: &'a str, en: &'a str) -> &'a str {
        if self
            .snapshot
            .as_ref()
            .is_none_or(|snapshot| snapshot.settings.locale == "ja")
        {
            ja
        } else {
            en
        }
    }
    pub fn prepare_candidate(
        &mut self,
        candidate: crate::application::ai::VocabularyCandidate,
        cues: Vec<surtitle_core::SubtitleSegment>,
        media_signature: String,
        cx: &mut Context<Self>,
    ) -> tokio::sync::oneshot::Receiver<Result<surtitle_core::EditorDraftView, String>> {
        let (reply, receiver) = tokio::sync::oneshot::channel();
        cx.emit(UiEvent::PrepareCandidate(CandidateRequest {
            candidate,
            cues,
            media_signature,
            reply: Arc::new(std::sync::Mutex::new(Some(reply))),
        }));
        receiver
    }
    pub fn navigate(&mut self, route: Route, cx: &mut Context<Self>) {
        cx.emit(UiEvent::Navigate(route));
    }
    pub fn request_transfer(&mut self, cx: &mut Context<Self>) {
        cx.emit(UiEvent::Transfer);
    }
    pub fn request_recovery(&mut self, cx: &mut Context<Self>) {
        cx.emit(UiEvent::Recovery);
    }
    pub fn request_draft_study(&mut self, id: String, cx: &mut Context<Self>) {
        cx.emit(UiEvent::DraftStudy(id));
    }
    pub fn manage_media(&mut self, id: String, cx: &mut Context<Self>) {
        cx.emit(UiEvent::ManageMedia(id));
    }
    pub fn open_source_draft(
        &mut self,
        draft: surtitle_core::EditorDraftView,
        cx: &mut Context<Self>,
    ) {
        cx.emit(UiEvent::OpenSourceDraft(draft));
    }
    pub fn request_rebind_ai(
        &mut self,
        continuation_id: String,
        media_id: String,
        cx: &mut Context<Self>,
    ) {
        cx.emit(UiEvent::RebindAi {
            continuation_id,
            media_id,
        });
    }
    pub fn confirm_ai_source(
        &mut self,
        continuation_id: String,
        cues: Vec<surtitle_core::SubtitleSegment>,
        cx: &mut Context<Self>,
    ) {
        cx.emit(UiEvent::ReboundAi {
            continuation_id,
            cues,
        });
    }
    pub fn request_ai(
        &mut self,
        intent: super::ai::AiIntent,
        cues: Vec<surtitle_core::SubtitleSegment>,
        cx: &mut Context<Self>,
    ) {
        cx.emit(UiEvent::Ai { intent, cues });
    }
    pub fn reset_after_restore(&mut self, cx: &mut Context<Self>) {
        // run() retires an old generation's callback, including its refreshing
        // flag reset. Start the new generation without inheriting that flag.
        self.refreshing = false;
        self.dirty = false;
        self.snapshot = None;
        self.checkpoint = None;
        self.last_event = None;
        self.error = None;
        self.preparation = None;
        self.ai_runtime = None;
        self.operations.clear();
        self.player = PlayerState::default();
        self.refresh(cx);
        cx.notify();
    }
    pub fn receive(&mut self, event: DesktopEvent, cx: &mut Context<Self>) {
        match event {
            DesktopEvent::DataChanged(change) => {
                if self.last_event.as_ref().is_some_and(|(epoch, revision)| {
                    *epoch == change.epoch && *revision >= change.revision
                }) {
                    return;
                }
                self.last_event = Some((change.epoch.clone(), change.revision));
                cx.emit(UiEvent::Changed(change));
                self.refresh(cx);
            }
            DesktopEvent::PlayerState(player) => {
                if player.revision < self.player.revision {
                    return;
                }
                self.player = player;
                cx.emit(UiEvent::Playback);
            }
            DesktopEvent::PlayerSurfaceClick => cx.emit(UiEvent::SurfaceClick),
            DesktopEvent::PreparationProgress(progress) => self.preparation = Some(progress),
            DesktopEvent::AiRuntime(snapshot) => self.ai_runtime = Some(snapshot),
        }
        cx.notify();
    }
    pub fn refresh(&mut self, cx: &mut Context<Self>) {
        if self.refreshing {
            self.dirty = true;
            return;
        }
        self.refreshing = true;
        self.dirty = false;
        let state = self.backend.state.clone();
        let runtime = self.backend.host.runtime().clone();
        run(
            &self.backend,
            cx,
            async move {
                runtime
                    .spawn_blocking(move || {
                        let before = commands::synchronization::get_change_checkpoint(&state)?;
                        let snapshot = commands::ai::get_app_snapshot(&state)?;
                        let operations = commands::media_tools::list_operation_progress(&state)?;
                        let after = commands::synchronization::get_change_checkpoint(&state)?;
                        Ok((before, snapshot, operations, after))
                    })
                    .await
                    .map_err(|error| error.to_string())?
            },
            |this, result, cx| {
                this.refreshing = false;
                match result {
                    Ok((before, snapshot, operations, after)) => {
                        // A snapshot spanning a committed mutation must be retried.
                        if before == after && !this.dirty {
                            this.snapshot = Some(Arc::new(snapshot));
                            this.operations = operations;
                            this.checkpoint = Some(after);
                            this.error = None;
                            cx.emit(UiEvent::Snapshot);
                        } else {
                            this.dirty = true;
                        }
                    }
                    Err(error) => this.error = Some(error),
                }
                if this.dirty {
                    this.refresh(cx);
                }
            },
        );
    }
}
