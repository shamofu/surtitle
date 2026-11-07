// SPDX-License-Identifier: GPL-3.0-or-later
mod activity_window;
pub(crate) mod ai;
pub(crate) mod assets;
mod captions;
mod cards;
pub(crate) mod editors;
mod import;
mod in_flight;
mod keyboard;
mod library;
mod media;
mod recovery;
pub(crate) mod session;
mod settings;
mod source_editors;
mod source_form;
mod study;
pub(crate) mod style;
#[cfg(test)]
mod tests;
mod transfer;

use crate::{
    application::AppState,
    runtime::{DesktopEvent, DesktopHost},
};
use editors::{EditorRegistry, FlushPurpose};
use gpui_kit::assets::IconName;
use gpui_kit::component::button::{Button, ButtonCustomVariant, ButtonVariants};
use gpui_kit::component::{ActiveTheme, Icon, Sizable, Theme, ThemeMode, spinner::Spinner};
use gpui_kit::{
    AppContext, Context, Entity, FontWeight, Subscription, Window, div, prelude::*, px,
};
use session::{Backend, Route, Session, UiEvent};
use std::{path::PathBuf, sync::mpsc::Receiver, time::Duration};

pub(crate) struct DesktopView {
    session: Entity<Session>,
    library: Entity<library::LibraryView>,
    editors: Entity<EditorRegistry>,
    sources: Entity<source_editors::SourceEditors>,
    study: Option<Entity<study::StudyView>>,
    cards: Entity<cards::CardsView>,
    review: Entity<cards::CardsView>,
    settings: Entity<settings::SettingsView>,
    ai: Entity<ai::AiView>,
    route: Route,
    close_pending: bool,
    close_ready: bool,
    transfer_pending: bool,
    recovery: Option<(gpui_kit::AnyWindowHandle, Entity<recovery::RecoveryView>)>,
    recovery_subscription: Option<Subscription>,
    activity_dialog: Option<gpui_kit::AnyWindowHandle>,
    activity_window: Option<gpui_kit::WeakEntity<activity_window::ActivityWindow>>,
    activity_focus: gpui_kit::FocusHandle,
    error: Option<String>,
    _root: PathBuf,
    _subscriptions: Vec<Subscription>,
}
impl DesktopView {
    pub fn new(
        root: PathBuf,
        services: AppState,
        host: DesktopHost,
        events: Receiver<DesktopEvent>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        style::init(cx);
        let backend = Backend::new(services, host);
        let editors = cx.new(|cx| EditorRegistry::new(backend.clone(), cx));
        let sources = cx.new(|cx| source_editors::SourceEditors::new(backend.clone(), cx));
        let session = cx.new(|cx| Session::new(backend, cx));
        let library = cx.new(|cx| library::LibraryView::new(session.clone(), window, cx));
        let cards =
            cx.new(|cx| cards::CardsView::new(session.clone(), editors.clone(), false, window, cx));
        let review =
            cx.new(|cx| cards::CardsView::new(session.clone(), editors.clone(), true, window, cx));
        let settings =
            cx.new(|cx| settings::SettingsView::new(session.clone(), editors.clone(), window, cx));
        let ai = cx.new(|cx| ai::AiView::new(session.clone(), editors.clone(), window, cx));
        let subscription =
            cx.subscribe_in(&session, window, |this, _, event: &UiEvent, window, cx| {
                if let UiEvent::Navigate(route) = event {
                    this.navigate(route.clone(), window, cx);
                }
                if matches!(event, UiEvent::Snapshot) {
                    this.appearance(window, cx);
                    cx.notify();
                }
                if let UiEvent::Ai { intent, cues } = event {
                    this.ai.update(cx, |ai, cx| {
                        ai.request_for_cues(intent.clone(), cues.clone(), window, cx)
                    });
                }
                if let UiEvent::PrepareCandidate(request) = event {
                    this.prepare_candidate(request.clone(), cx);
                }
                if let UiEvent::DraftStudy(media_id) = event {
                    this.ai.update(cx, |ai, cx| {
                        ai.open_draft_study(media_id.clone(), window, cx)
                    });
                }
                if let UiEvent::OpenAiJob(job_id) = event {
                    this.ai
                        .update(cx, |ai, cx| ai.open_job(job_id.clone(), window, cx));
                }
                if let UiEvent::ManageMedia(id) = event
                    && let Err(error) = media::open(
                        cx.entity().downgrade(),
                        this.session.clone(),
                        this.editors.clone(),
                        id.clone(),
                        cx,
                    )
                {
                    this.error = Some(error.to_string());
                }
                if let UiEvent::ManageSubtitles {
                    media_id,
                    stream_index,
                } = event
                    && let Err(error) = media::open_embedded(
                        cx.entity().downgrade(),
                        this.session.clone(),
                        this.editors.clone(),
                        media_id.clone(),
                        *stream_index,
                        cx,
                    )
                {
                    this.error = Some(error.to_string());
                }
                if let UiEvent::RebindAi {
                    continuation_id,
                    media_id,
                } = event
                {
                    this.navigate(Route::Study(media_id.clone()), window, cx);
                    if let Some(study) = this.study.as_ref() {
                        study.update(cx, |study, cx| study.rebind_ai(continuation_id.clone(), cx));
                    }
                }
                if let UiEvent::ReboundAi {
                    continuation_id,
                    cues,
                } = event
                {
                    this.ai.update(cx, |ai, cx| {
                        ai.rebind_request(continuation_id.clone(), cues.clone(), window, cx)
                    });
                }
                if let UiEvent::OpenSourceDraft(draft) = event
                    && let Err(error) = source_form::open_saved(
                        this.session.clone(),
                        this.sources.clone(),
                        draft.clone(),
                        cx,
                    )
                {
                    this.error = Some(error.to_string());
                    cx.notify();
                }
                if matches!(event, UiEvent::Transfer) {
                    this.open_transfer(window, cx);
                }
                if matches!(event, UiEvent::Recovery) {
                    this.open_recovery(window, cx);
                }
                if let UiEvent::Changed(change) = event
                    && matches!(
                        change.domain,
                        crate::application::changes::ChangeDomain::Settings
                            | crate::application::changes::ChangeDomain::Cards
                    )
                {
                    this.editors
                        .update(cx, |editors, cx| editors.refresh_all(cx));
                }
            });
        let appearance =
            cx.observe_window_appearance(window, |this, window, cx| this.appearance(window, cx));
        let activation =
            cx.observe_window_activation(window, |this, window, cx| this.appearance(window, cx));
        let mut previous_activity_error = session.read(cx).error.clone();
        let activity_errors = cx.observe(&session, move |_, session, cx| {
            let error = session.read(cx).error.clone();
            if error != previous_activity_error {
                previous_activity_error = error;
                cx.notify();
            }
        });
        let receiver_session = session.downgrade();
        cx.spawn(async move |view, cx| {
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(16))
                    .await;
                let pending: Vec<_> = events.try_iter().collect();
                if view.upgrade().is_none() {
                    break;
                }
                if !pending.is_empty()
                    && receiver_session
                        .update(cx, |session, cx| {
                            for event in pending {
                                session.receive(event, cx);
                            }
                        })
                        .is_err()
                {
                    break;
                }
            }
        })
        .detach();
        Self {
            session,
            library,
            editors,
            sources,
            study: None,
            cards,
            review,
            settings,
            ai,
            route: Route::Library,
            close_pending: false,
            close_ready: false,
            transfer_pending: false,
            recovery: None,
            recovery_subscription: None,
            activity_dialog: None,
            activity_window: None,
            activity_focus: cx.focus_handle(),
            error: None,
            _root: root,
            _subscriptions: vec![subscription, appearance, activation, activity_errors],
        }
    }
    fn navigate(&mut self, route: Route, window: &mut Window, cx: &mut Context<Self>) {
        if self.editors.read(cx).frozen() {
            return;
        }
        if route == Route::Activity {
            self.open_activity(window, cx);
            return;
        }
        if let Some(dialog) = self.activity_dialog.take() {
            if let Some(content) = self.activity_window.take() {
                let _ = content.update(cx, |content, _| content.navigating());
            }
            let _ = dialog.update(cx, |_, window, _| window.remove_window());
        }
        if let Route::Study(media) = &route {
            if self
                .study
                .as_ref()
                .is_none_or(|study| study.read(cx).media_id != *media)
            {
                self.study.take();
                self.study = Some(cx.new(|cx| {
                    study::StudyView::new(
                        media.clone(),
                        self.session.clone(),
                        self.editors.clone(),
                        self.sources.clone(),
                        window,
                        cx,
                    )
                }));
            }
        } else {
            if self.study.is_some() {
                if let Err(error) = crate::commands::playback::cancel_pending_media_loads(
                    &self.session.read(cx).backend.state,
                ) {
                    self.error = Some(error);
                }
                let _ = self.session.read(cx).backend.state.pause_player();
            }
            let _ = self.session.read(cx).backend.state.hide_player_surface();
            self.study.take();
        }
        self.route = route;
        if self.route == Route::Library {
            // Save the coordinated player clock before reading Library's snapshot.
            // Refresh on entry, without putting periodic playback in the change channel.
            if let Err(error) = self.session.read(cx).backend.state.playback_tick(true) {
                self.error = Some(error.to_string());
            }
            self.session.update(cx, |session, cx| session.refresh(cx));
        }
        if self.route == Route::Activity {
            self.ai.update(cx, |view, cx| view.entered(cx));
        }
        if self.route == Route::Review {
            self.review
                .update(cx, |review, cx| review.focus(window, cx));
        }
        cx.notify();
    }
    pub fn prepare_close(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        if self.transfer_pending {
            return false;
        }
        if self.close_ready {
            return true;
        }
        if self.close_pending {
            return false;
        }
        if self.editors.read(cx).frozen() {
            return false;
        }
        self.close_pending = true;
        let flush = self.flush_all(FlushPurpose::Close, cx);
        let handle = window.window_handle();
        cx.spawn(async move |this, cx| {
            let result = flush.await;
            let _ = handle.update(cx, |_, window, cx| {
                let _ = this.update(cx, |this, cx| {
                    this.close_pending = false;
                    match result {
                        Ok(()) => {
                            this.close_ready = true;
                            if let Err(error) = crate::desktop::request_close(window) {
                                this.close_ready = false;
                                this.error = Some(error.to_string());
                                this.resume(cx);
                            }
                        }
                        Err(error) => {
                            this.error = Some(error);
                            this.resume(cx);
                        }
                    }
                    cx.notify();
                });
            });
        })
        .detach();
        false
    }
    fn flush_all(&mut self, purpose: FlushPurpose, cx: &mut Context<Self>) -> editors::FlushFuture {
        if self.editors.read(cx).frozen() {
            return Box::pin(async {
                Err("Another save or data operation is still running".into())
            });
        }
        self.session
            .read(cx)
            .backend
            .exclusive
            .store(true, std::sync::atomic::Ordering::Release);
        self.sources
            .update(cx, |sources, cx| sources.freeze(true, cx));
        self.library
            .update(cx, |library, cx| library.freeze(true, cx));
        let operations = self.session.read(cx).backend.in_flight.clone();
        let (sender, receiver) = tokio::sync::oneshot::channel();
        cx.spawn(async move |this, cx| {
            // A domain save can finish by consuming its input. Freeze new input
            // first, collect that callback, and then flush its resulting draft.
            operations.drained().await;
            let futures = match this.update(cx, |this, cx| {
                let editing = this
                    .editors
                    .update(cx, |editors, cx| editors.flush_all(purpose, cx));
                let sources = this.sources.update(cx, |sources, _| sources.flush_all());
                let library = this.library.update(cx, |library, cx| library.flush(cx));
                let ai = this.ai.update(cx, |ai, cx| ai.flush_all(purpose, cx));
                [editing, sources, library, ai]
            }) {
                Ok(futures) => futures,
                Err(error) => {
                    let _ = sender.send(Err(error.to_string()));
                    return;
                }
            };
            let mut failure = None;
            for future in futures {
                if let Err(error) = future.await {
                    failure.get_or_insert(error);
                }
            }
            operations.drained().await;
            let _ = sender.send(failure.map_or(Ok(()), Err));
        })
        .detach();
        cx.notify();
        Box::pin(async move {
            receiver
                .await
                .map_err(|_| "The application closed before input was saved".to_string())?
        })
    }
    fn resume(&mut self, cx: &mut Context<Self>) {
        self.session
            .read(cx)
            .backend
            .exclusive
            .store(false, std::sync::atomic::Ordering::Release);
        self.sources
            .update(cx, |sources, cx| sources.freeze(false, cx));
        self.library
            .update(cx, |library, cx| library.freeze(false, cx));
        if let Err(error) = self.editors.update(cx, |editors, cx| editors.resume(cx)) {
            self.error = Some(error);
        }
        if let Err(error) = self.ai.update(cx, |ai, cx| ai.resume(cx)) {
            self.error = Some(error);
        }
    }
    fn open_activity(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(dialog) = self.activity_dialog
            && dialog
                .update(cx, |_, window, _| window.activate_window())
                .is_ok()
        {
            return;
        }
        self.ai.update(cx, |ai, cx| ai.entered(cx));
        let content = self.ai.clone();
        let session = self.session.clone();
        let opener = window.window_handle();
        let previous_focus = Some(self.activity_focus.clone());
        let title = self.session.read(cx).text("処理状況", "Activity");
        match gpui_kit::open_window(
            gpui_kit::WindowOptions {
                titlebar: Some(gpui_kit::TitlebarOptions {
                    title: Some(title.into()),
                    ..Default::default()
                }),
                ..crate::desktop::dialog::options(
                    gpui_kit::size(px(840.), px(700.)),
                    Some(gpui_kit::size(px(600.), px(420.))),
                    cx,
                )
            },
            cx,
            move |window, cx| {
                cx.new(|cx| {
                    activity_window::ActivityWindow::new(
                        session,
                        content,
                        opener,
                        previous_focus,
                        window,
                        cx,
                    )
                })
            },
        ) {
            Ok((handle, content)) => {
                self.activity_dialog = Some(handle);
                self.activity_window = Some(content.downgrade());
            }
            Err(error) => self.error = Some(error.to_string()),
        }
    }
    fn appearance(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(snapshot) = self.session.read(cx).snapshot.clone() else {
            return;
        };
        let mode = match snapshot.settings.theme.as_str() {
            "light" => ThemeMode::Light,
            "dark" => ThemeMode::Dark,
            _ => window.appearance().into(),
        };
        if cx.theme().mode != mode {
            Theme::change(mode, Some(window), cx);
        }
        let _ = crate::desktop::set_caption_theme(window, mode == ThemeMode::Dark);
        match snapshot.settings.motion_preference.as_str() {
            "reduce" => cx.set_reduce_motion(true),
            "full" => cx.set_reduce_motion(false),
            _ => {
                if let Some(reduce) = style::system_reduced_motion() {
                    cx.set_reduce_motion(reduce);
                }
            }
        }
    }
    fn open_transfer(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.editors.read(cx).frozen() {
            return;
        }
        let media_id = match &self.route {
            Route::Study(id) => Some(id.clone()),
            _ => None,
        };
        if let Err(error) = transfer::open(
            cx.entity().downgrade(),
            self.session.clone(),
            media_id,
            window.window_handle(),
            cx,
        ) {
            self.error = Some(error.to_string());
            cx.notify();
        }
    }
    fn open_recovery(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.editors.read(cx).frozen() {
            return;
        }
        if let Some((handle, _)) = self.recovery.as_ref()
            && handle
                .update(cx, |_, window, _| window.activate_window())
                .is_ok()
        {
            return;
        }
        match recovery::open(
            self.session.clone(),
            self.editors.clone(),
            self.sources.clone(),
            cx,
        ) {
            Ok((handle, view)) => {
                self.recovery_subscription = Some(cx.subscribe_in(
                    &view,
                    window,
                    |this, view, event: &recovery::RecoveryAction, window, cx| match event {
                        recovery::RecoveryAction::OpenUi { draft, recover } => {
                            this.open_ui_draft(draft.clone(), *recover, window, cx)
                        }
                        recovery::RecoveryAction::OpenAi { id } => {
                            this.navigate(Route::Activity, window, cx);
                            this.ai
                                .update(cx, |ai, cx| ai.open_continuation(id.clone(), window, cx));
                        }
                        recovery::RecoveryAction::Discard(item) => {
                            this.discard_draft(*item.clone(), view.downgrade(), cx)
                        }
                    },
                ));
                self.recovery = Some((handle, view));
            }
            Err(error) => self.error = Some(error.to_string()),
        }
        cx.notify();
    }
    fn open_ui_draft(
        &mut self,
        draft: surtitle_core::workspace::UiDraft,
        recover: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.editors.read(cx).frozen() {
            return;
        }
        match draft.kind.as_str() {
            "settings" => self.navigate(Route::Settings, window, cx),
            "card" => {
                self.navigate(Route::Cards, window, cx);
                self.cards.update(cx, |cards, cx| {
                    cards.open(draft.entity_id.clone(), window, cx)
                });
            }
            "import" => {
                self.navigate(Route::Library, window, cx);
                self.library
                    .update(cx, |library, cx| library.open_import(cx));
            }
            _ => {
                self.navigate(Route::Activity, window, cx);
                self.ai
                    .update(cx, |ai, cx| ai.open_ui_draft(draft.clone(), window, cx));
            }
        }
        if recover && draft.kind == "draft_card" {
            self.ai.update(cx, |ai, cx| ai.recover_ui_draft(&draft, cx));
        } else if recover
            && let Some(key) = self.editors.read(cx).key_for(&draft.kind, &draft.entity_id)
        {
            self.editors
                .update(cx, |editors, cx| editors.recover(&key, cx));
        }
    }
    fn discard_draft(
        &mut self,
        item: recovery::RecoveryItem,
        view: gpui_kit::WeakEntity<recovery::RecoveryView>,
        cx: &mut Context<Self>,
    ) {
        if self.transfer_pending || self.close_pending || self.editors.read(cx).frozen() {
            let _ = view.update(cx, |view, cx| {
                view.finish(Err("Another data operation is still running".into()), cx)
            });
            return;
        }
        let key = if let recovery::RecoveryItem::Ui(draft) = &item {
            self.editors.read(cx).key_for(&draft.kind, &draft.entity_id)
        } else {
            None
        };
        self.transfer_pending = true;
        let flush = self.flush_all(FlushPurpose::Export, cx);
        let backend = self.session.read(cx).backend.clone();
        let deleting = item.clone();
        let task = backend.host.runtime().clone().spawn(async move {
            flush.await?;
            recovery::discard(backend, deleting).await
        });
        cx.spawn(async move |this, cx| {
            let mut result = task.await.unwrap_or_else(|error| Err(error.to_string()));
            let _ = this.update(cx, |this, cx| {
                if result.is_ok() {
                    result = match &item {
                        recovery::RecoveryItem::Ui(draft) => match draft.kind.as_str() {
                            "settings" | "card" | "draft_card" => {
                                key.as_ref().map_or(Ok(()), |key| {
                                    this.editors
                                        .update(cx, |editors, cx| editors.retire(key, cx))
                                })
                            }
                            "import" => this
                                .library
                                .update(cx, |library, cx| library.reload_after_discard(cx)),
                            "transcript_review" => {
                                this.ai.update(cx, |ai, cx| ai.retire_ui_draft(draft, cx))
                            }
                            _ => Ok(()),
                        },
                        recovery::RecoveryItem::Source(draft) => this
                            .sources
                            .update(cx, |sources, cx| sources.retire_draft(&draft.draft.id, cx)),
                        _ => Ok(()),
                    };
                }
                this.transfer_pending = false;
                this.resume(cx);
                this.session.update(cx, |session, cx| session.refresh(cx));
                cx.notify();
            });
            let _ = view.update(cx, |view, cx| view.finish(result, cx));
        })
        .detach();
    }
    fn perform_transfer(
        &mut self,
        request: transfer::Request,
        dialog: gpui_kit::WeakEntity<transfer::TransferDialog>,
        window: gpui_kit::AnyWindowHandle,
        cx: &mut Context<Self>,
    ) -> Result<(), String> {
        if self.transfer_pending || self.close_pending || self.editors.read(cx).frozen() {
            return Err("Another data operation is still running".into());
        }
        self.transfer_pending = true;
        let purpose = match &request {
            transfer::Request::Export { .. } => FlushPurpose::Export,
            transfer::Request::Restore { .. } => FlushPurpose::Restore,
        };
        let flush = self.flush_all(purpose, cx);
        let backend = self.session.read(cx).backend.clone();
        let task = backend.host.runtime().clone().spawn(async move {
            flush.await?;
            match request {
                transfer::Request::Export { format, media_id } => {
                    crate::commands::transfer::export_learning(&backend.state, format, media_id)
                        .await
                        .map(transfer::Outcome::Exported)
                }
                transfer::Request::Restore { token } => {
                    crate::commands::transfer::restore_learning(backend.host, &backend.state, token)
                        .await
                        .map(transfer::Outcome::Restored)
                }
            }
        });
        cx.spawn(async move |this, cx| {
            let mut result = task.await.unwrap_or_else(|error| Err(error.to_string()));
            let followup = window
                .update(cx, |_, window, cx| {
                    this.update(cx, |this, cx| {
                        if matches!(result, Ok(transfer::Outcome::Restored(_))) {
                            Some(this.reset_after_restore(window, cx))
                        } else {
                            None
                        }
                    })
                })
                .ok()
                .and_then(Result::ok)
                .flatten();
            if let Some(followup) = followup {
                let post = match followup {
                    Ok(future) => future.await,
                    Err(error) => Err(error),
                };
                if let Err(error) = post
                    && let Ok(transfer::Outcome::Restored(restored)) = &mut result
                {
                    restored.warnings.push(error);
                }
            }
            let _ = this.update(cx, |this, cx| {
                this.transfer_pending = false;
                this.resume(cx);
                this.session.update(cx, |session, cx| session.refresh(cx));
                cx.notify();
            });
            let _ = dialog.update(cx, |dialog, cx| dialog.finish(result, cx));
        })
        .detach();
        Ok(())
    }
    fn prepare_candidate(&mut self, request: session::CandidateRequest, cx: &mut Context<Self>) {
        if self.transfer_pending || self.close_pending || self.editors.read(cx).frozen() {
            request.finish(Err("Another data operation is still running".into()));
            return;
        }
        self.transfer_pending = true;
        let flush = self.flush_all(FlushPurpose::Export, cx);
        let backend = self.session.read(cx).backend.clone();
        let input = request.clone();
        let task = backend.host.runtime().spawn(async move {
            flush.await?;
            tokio::task::spawn_blocking(move || {
                crate::commands::editor_drafts::prepare_candidate_editor_draft(
                    &backend.state,
                    &input.candidate,
                    input.cues,
                    input.media_signature,
                )
            })
            .await
            .map_err(|error| error.to_string())?
        });
        cx.spawn(async move |this, cx| {
            let result = task.await.unwrap_or_else(|error| Err(error.to_string()));
            if this
                .update(cx, |this, cx| {
                    this.transfer_pending = false;
                    this.resume(cx);
                    request.finish(result);
                    cx.notify();
                })
                .is_err()
            {
                request.finish(Err("The application window closed".into()));
            }
        })
        .detach();
    }
    fn perform_media(
        &mut self,
        id: String,
        action: media::Action,
        view: gpui_kit::WeakEntity<media::MediaView>,
        cx: &mut Context<Self>,
    ) -> Result<(), String> {
        if self.transfer_pending || self.close_pending || self.editors.read(cx).frozen() {
            return Err("Another data operation is still running".into());
        }
        self.transfer_pending = true;
        let flush = self.flush_all(FlushPurpose::Export, cx);
        let backend = self.session.read(cx).backend.clone();
        let media_id = id.clone();
        let applying = action.clone();
        let reload = action == media::Action::Relink
            && matches!(&self.route,Route::Study(current) if current==&id);
        let task = backend.host.runtime().clone().spawn(async move {
            flush.await?;
            media::execute(backend.clone(), media_id.clone(), applying).await?;
            if reload {
                crate::commands::playback::load_media(backend.host, &backend.state, media_id)
                    .await?;
            }
            Ok(())
        });
        cx.spawn(async move |this, cx| {
            let mut result = task.await.unwrap_or_else(|error| Err(error.to_string()));
            let _ = this.update(cx, |this, cx| {
                if result.is_ok() && action == media::Action::Remove {
                    result = this
                        .sources
                        .update(cx, |sources, cx| sources.retire_media(&id, cx));
                    if matches!(&this.route,Route::Study(current) if current==&id) {
                        this.study.take();
                        this.route = Route::Library;
                        let _ = this.session.read(cx).backend.state.hide_player_surface();
                    }
                }
                this.transfer_pending = false;
                this.resume(cx);
                this.session.update(cx, |session, cx| session.refresh(cx));
                cx.notify();
            });
            let _ = view.update(cx, |view, cx| view.finish(action, result, cx));
        })
        .detach();
        Ok(())
    }
    fn reset_after_restore(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Result<editors::FlushFuture, String> {
        self.editors
            .update(cx, |editors, cx| editors.invalidate_after_restore(cx))?;
        self.sources
            .update(cx, |sources, cx| sources.invalidate_after_restore(cx))?;
        self.ai
            .update(cx, |ai, cx| ai.invalidate_after_restore(cx))?;
        self.library
            .update(cx, |library, cx| library.invalidate_after_restore(cx))?;
        self.study.take();
        let _ = self.session.read(cx).backend.state.hide_player_surface();
        self.route = Route::Library;
        self.cards = cx.new(|cx| {
            cards::CardsView::new(
                self.session.clone(),
                self.editors.clone(),
                false,
                window,
                cx,
            )
        });
        self.review = cx.new(|cx| {
            cards::CardsView::new(self.session.clone(), self.editors.clone(), true, window, cx)
        });
        self.session
            .update(cx, |session, cx| session.reset_after_restore(cx));
        Ok(self.library.update(cx, |library, cx| library.flush(cx)))
    }
}
impl Render for DesktopView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let session = self.session.read(cx);
        let due = session.snapshot.as_ref().map_or(0, |snapshot| {
            snapshot
                .cards
                .iter()
                .filter(|card| {
                    !card.suspended
                        && chrono::DateTime::parse_from_rfc3339(&card.due_at)
                            .is_ok_and(|time| time <= chrono::Utc::now())
                })
                .count()
        });
        let ja = session.text("ja", "en") == "ja";
        let activity = activity_window::ActivityStatus::read(session);
        let activity_label = activity.label(session);
        let theme = cx.theme();
        let compact = window.viewport_size().width < px(1100.);
        let icon_navigation = window.viewport_size().width < px(850.);
        div()
            .size_full()
            .flex()
            .flex_col()
            .text_color(cx.theme().foreground)
            .bg(cx.theme().background)
            .when(!window.is_fullscreen(), |root| {
                root.child(
                    style::row()
                        .h(px(56.))
                        .flex_shrink_0()
                        .w_full()
                        .px(px(if compact { 16. } else { 24. }))
                        .gap(px(if compact { 16. } else { 32. }))
                        .border_b_1()
                        .border_color(theme.border)
                        .bg(theme.popover)
                        .child(
                            Button::new("home-brand")
                                .ghost()
                                .h(px(40.))
                                .p_0()
                                .accessibility_label(
                                    session.text("Surtitle ホーム", "Surtitle home"),
                                )
                                .child(style::row().gap(px(8.)).child(style::brand()).when(
                                    !icon_navigation,
                                    |row| {
                                        row.child(
                                            div()
                                                .text_size(px(22.))
                                                .font_weight(FontWeight::SEMIBOLD)
                                                .child("surtitle"),
                                        )
                                    },
                                ))
                                .on_click(cx.listener(|this, _, window, cx| {
                                    this.navigate(Route::Library, window, cx)
                                })),
                        )
                        .child(
                            style::row()
                                .w(px(if icon_navigation {
                                    200.
                                } else if compact {
                                    448.
                                } else {
                                    544.
                                }))
                                .h_full()
                                .gap_0()
                                .children(
                                    [
                                        (
                                            "library",
                                            session.text("ライブラリ", "Library"),
                                            Route::Library,
                                            IconName::LibraryBig,
                                        ),
                                        (
                                            "cards",
                                            session.text("フレーズ帳", "Phrases"),
                                            Route::Cards,
                                            IconName::Layers,
                                        ),
                                        (
                                            "review",
                                            session.text("復習", "Review"),
                                            Route::Review,
                                            IconName::BookOpen,
                                        ),
                                        (
                                            "settings",
                                            session.text("設定", "Settings"),
                                            Route::Settings,
                                            IconName::Settings2,
                                        ),
                                    ]
                                    .into_iter()
                                    .map(
                                        |(id, label, route, icon)| {
                                            let selected = self.route == route;
                                            let fill = if selected {
                                                theme.accent
                                            } else {
                                                theme.transparent
                                            };
                                            let text = if selected {
                                                theme.primary
                                            } else {
                                                theme.muted_foreground
                                            };
                                            Button::new(id)
                                                .custom(
                                                    ButtonCustomVariant::new(cx)
                                                        .color(fill)
                                                        .foreground(text)
                                                        .hover(theme.background)
                                                        .active(theme.accent),
                                                )
                                                .flex_1()
                                                .h_full()
                                                .rounded(px(0.))
                                                .px(px(if icon_navigation { 3. } else { 12. }))
                                                .border_b(px(3.))
                                                .border_color(if selected {
                                                    theme.primary
                                                } else {
                                                    theme.transparent
                                                })
                                                .toggled(selected)
                                                .accessibility_label(if selected {
                                                    format!(
                                                        "{label} — {}",
                                                        session
                                                            .text("現在のページ", "Current page")
                                                    )
                                                } else {
                                                    label.to_owned()
                                                })
                                                .child(
                                                    style::row()
                                                        .gap(px(if icon_navigation {
                                                            2.
                                                        } else {
                                                            8.
                                                        }))
                                                        .text_size(px(14.))
                                                        .font_weight(FontWeight::MEDIUM)
                                                        .child(Icon::new(icon).size(px(18.)))
                                                        .when(!icon_navigation, |row| {
                                                            row.child(label)
                                                        })
                                                        .when(id == "review", |row| {
                                                            row.child(
                                                                div()
                                                                    .rounded(px(8.))
                                                                    .w(px(if icon_navigation {
                                                                        24.
                                                                    } else {
                                                                        28.
                                                                    }))
                                                                    .flex_shrink_0()
                                                                    .text_center()
                                                                    .text_size(px(11.))
                                                                    .font_features(
                                                                        style::tabular_numbers(),
                                                                    )
                                                                    .bg(theme.primary)
                                                                    .text_color(
                                                                        theme.primary_foreground,
                                                                    )
                                                                    .when(due == 0, |badge| {
                                                                        badge.invisible()
                                                                    })
                                                                    .child(if due > 99 {
                                                                        "99+".into()
                                                                    } else {
                                                                        due.to_string()
                                                                    }),
                                                            )
                                                        }),
                                                )
                                                .accessibility_id(format!("nav-{id}"))
                                                .on_click(cx.listener(
                                                    move |this, _, window, cx| {
                                                        this.navigate(route.clone(), window, cx)
                                                    },
                                                ))
                                        },
                                    ),
                                ),
                        )
                        .child(
                            style::row()
                                .flex_1()
                                .justify_end()
                                .gap(px(8.))
                                .child(
                                    style::button("activity")
                                        .ghost()
                                        .track_focus(&self.activity_focus)
                                        .accessibility_label(activity_label.clone())
                                        .tooltip(activity_label)
                                        .child(
                                            style::row()
                                                .gap(px(8.))
                                                .child(
                                                    if activity.running > 0
                                                        && activity.problem.is_none()
                                                    {
                                                        Spinner::new()
                                                            .icon(Icon::new(IconName::RefreshCw))
                                                            .with_size(px(17.))
                                                            .into_any_element()
                                                    } else {
                                                        Icon::new(IconName::Activity)
                                                            .size(px(17.))
                                                            .when(
                                                                activity.problem.is_some(),
                                                                |icon| {
                                                                    icon.text_color(theme.danger)
                                                                },
                                                            )
                                                            .into_any_element()
                                                    },
                                                )
                                                .when(!compact, |row| {
                                                    row.child(session.text("処理状況", "Activity"))
                                                })
                                                .child(
                                                    div()
                                                        .rounded(px(5.))
                                                        .w(px(30.))
                                                        .flex_shrink_0()
                                                        .text_center()
                                                        .text_size(px(12.))
                                                        .font_features(style::tabular_numbers())
                                                        .bg(theme.accent)
                                                        .text_color(theme.primary)
                                                        .when(activity.running == 0, |badge| {
                                                            badge.invisible()
                                                        })
                                                        .child(if activity.running > 99 {
                                                            "99+".into()
                                                        } else {
                                                            activity.running.to_string()
                                                        }),
                                                )
                                                .child(
                                                    div()
                                                        .w(px(8.))
                                                        .flex_shrink_0()
                                                        .text_center()
                                                        .text_color(theme.danger)
                                                        .font_weight(FontWeight::BOLD)
                                                        .when(activity.problem.is_none(), |badge| {
                                                            badge.invisible()
                                                        })
                                                        .child("!"),
                                                ),
                                        )
                                        .accessibility_id("nav-activity")
                                        .on_click(cx.listener(|this, _, window, cx| {
                                            this.open_activity(window, cx)
                                        })),
                                )
                                .child(
                                    style::button("locale-toggle")
                                        .ghost()
                                        .px(px(8.))
                                        .child(style::state_label(
                                            if ja { "EN" } else { "日本語" },
                                            &["EN", "日本語"],
                                        ))
                                        .accessibility_label(if ja {
                                            "Switch to English"
                                        } else {
                                            "日本語に切り替える"
                                        })
                                        .on_click(cx.listener(move |this, _, window, cx| {
                                            this.settings.update(cx, |settings, cx| {
                                                settings.set_locale(
                                                    if ja { "en" } else { "ja" },
                                                    window,
                                                    cx,
                                                )
                                            });
                                        })),
                                )
                                .child(
                                    style::icon_button(
                                        "theme-toggle",
                                        if theme.mode.is_dark() {
                                            IconName::Sun
                                        } else {
                                            IconName::Moon
                                        },
                                        session.text("テーマを切り替える", "Toggle theme"),
                                    )
                                    .on_click(cx.listener(
                                        |this, _, window, cx| {
                                            this.settings.update(cx, |settings, cx| {
                                                settings.toggle_theme(window, cx)
                                            });
                                        },
                                    )),
                                ),
                        ),
                )
            })
            .child(
                style::column()
                    .flex_1()
                    .min_h(px(0.))
                    .min_w(px(0.))
                    .gap_0()
                    .child(match &self.route {
                        Route::Study(_) if self.study.is_some() => {
                            self.study.as_ref().unwrap().clone().into_any_element()
                        }
                        Route::Cards => self.cards.clone().into_any_element(),
                        Route::Review => self.review.clone().into_any_element(),
                        Route::Settings => self.settings.clone().into_any_element(),
                        Route::Activity => self.ai.clone().into_any_element(),
                        _ => self.library.clone().into_any_element(),
                    })
                    .when_some(
                        self.error.clone().or(session.error.clone()),
                        |body, error| {
                            body.child(
                                div()
                                    .p_3()
                                    .border_t_1()
                                    .border_color(cx.theme().danger)
                                    .bg(cx.theme().background)
                                    .text_color(cx.theme().danger)
                                    .child(error),
                            )
                        },
                    ),
            )
    }
}
