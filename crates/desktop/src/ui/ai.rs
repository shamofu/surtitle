// SPDX-License-Identifier: GPL-3.0-or-later
//! Explicit AI estimates, durable unfinished flows, and local result review.
use crate::ui::style::Button;
use gpui_kit::base::{Disableable, TestSupportExt};
mod draft_study;
mod manual;
mod model_form;
mod persistence;
mod policy;
mod request;
mod review;
use super::{
    editors::{EditorRegistry, FlushFuture, FlushPurpose},
    session::{Route, Session, UiEvent, run},
    style::{column, row, state_label, tabular_numbers},
};
use crate::{
    application::{ai::AiQuote, continuations::AiContinuation, operations::OperationProgress},
    commands,
};
use gpui_kit::component::ActiveTheme;
use gpui_kit::{
    AppContext, Context, Entity, IntoElement, Subscription, TitlebarOptions, Window, WindowOptions,
    div, prelude::*, px, size,
};
use persistence::Persistence;
use request::RequestDialog;
use review::ReviewDialog;
use std::collections::BTreeMap;
struct AiSession(Entity<Session>);
impl gpui_kit::Global for AiSession {}
fn japanese(cx: &gpui_kit::App) -> bool {
    cx.try_global::<AiSession>().is_none_or(|session| {
        session
            .0
            .read(cx)
            .snapshot
            .as_ref()
            .is_none_or(|snapshot| snapshot.settings.locale == "ja")
    })
}
pub(super) fn localized(cx: &gpui_kit::App, value: impl AsRef<str>) -> String {
    localized_label(japanese(cx), value.as_ref())
}
macro_rules! locale_format {
    ($cx:expr,$ja:literal,$en:literal $(,$arg:expr)* $(,)?) => {
        if $crate::ui::ai::japanese($cx) { format!($ja $(,$arg)*) } else { format!($en $(,$arg)*) }
    };
}
pub(super) use locale_format;
fn localized_label(japanese: bool, value: &str) -> String {
    if !value
        .chars()
        .any(|c| ('\u{3040}'..='\u{9fff}').contains(&c))
    {
        return value.into();
    }
    let Some((position, _)) = value.match_indices(" / ").find(|(position, _)| {
        value[position + 3..]
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic())
    }) else {
        return value.into();
    };
    let (ja, en) = (&value[..position], &value[position + 3..]);
    if japanese {
        ja.into()
    } else if let Some(prefix) = ["✓ ", "□ "]
        .into_iter()
        .find(|prefix| ja.starts_with(prefix))
    {
        format!("{prefix}{en}")
    } else {
        en.into()
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AiKind {
    Translation,
    Vocabulary,
    Explanation,
    Transcription,
}
impl AiKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Translation => "translate",
            Self::Vocabulary | Self::Explanation => "vocabulary",
            Self::Transcription => "transcribe",
        }
    }
}
#[derive(Clone, Debug)]
pub(crate) struct AiIntent {
    pub media_id: String,
    pub kind: AiKind,
    pub start_ms: u64,
    pub end_ms: u64,
    pub focus_term: Option<String>,
}
pub(crate) struct AiView {
    session: Entity<Session>,
    editors: Entity<EditorRegistry>,
    store: Persistence,
    requests: BTreeMap<String, Entity<RequestDialog>>,
    reviews: BTreeMap<String, Entity<ReviewDialog>>,
    draft_study: BTreeMap<String, Entity<draft_study::DraftStudyDialog>>,
    continuations: Vec<AiContinuation>,
    error: Option<String>,
    discard_confirmation: Option<String>,
    cancelling_operations: std::collections::BTreeSet<String>,
    refreshing: bool,
    refresh_again: bool,
    _continuation_changes: gpui_kit::Task<()>,
    _subscriptions: Vec<Subscription>,
}
impl AiView {
    pub fn rebind_request(
        &mut self,
        id: String,
        cues: Vec<surtitle_core::SubtitleSegment>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.frozen(cx) {
            return;
        }
        if !self.requests.contains_key(&id) {
            let Some(value) = self
                .continuations
                .iter()
                .find(|value| value.id == id)
                .cloned()
            else {
                self.error = Some(
                    "The unfinished AI request is missing; reopen it before selecting its source"
                        .into(),
                );
                return;
            };
            let session = self.session.clone();
            let store = self.store.clone();
            let entity = cx.new(|cx| RequestDialog::new(session, store, value, window, cx));
            self.requests.insert(id.clone(), entity);
        }
        let entity = self.requests[&id].clone();
        entity.update(cx, |view, cx| view.rebind(cues, window, cx));
        if let Err(error) = open_dialog("Surtitle · AI estimate", entity, cx) {
            self.error = Some(error);
        }
    }
    pub fn open_continuation(&mut self, id: String, window: &mut Window, cx: &mut Context<Self>) {
        if self.frozen(cx) {
            return;
        }
        if let Some(value) = self
            .continuations
            .iter()
            .find(|value| value.id == id)
            .cloned()
        {
            self.open_request(value, window, cx);
            return;
        }
        let backend = self.session.read(cx).backend.clone();
        let state = backend.state.clone();
        let handle = window.window_handle();
        let read_epoch = self.store.continuation_read_epoch();
        run(
            &backend,
            cx,
            async move {
                commands::continuations::list_ai_continuations(&state)?
                    .into_iter()
                    .find(|value| value.id == id)
                    .ok_or_else(|| "The unfinished AI request no longer exists".to_string())
            },
            move |this, result, cx| {
                if !this.store.continuation_read_current(read_epoch) {
                    return;
                }
                match result {
                    Ok(value) => {
                        cx.spawn(async move |this, cx| {
                            let _ = handle.update(cx, |_, window, cx| {
                                this.update(cx, |this, cx| {
                                    if this.store.continuation_read_current(read_epoch) {
                                        this.open_request(value, window, cx);
                                    }
                                })
                            });
                        })
                        .detach();
                    }
                    Err(error) => this.error = Some(error),
                }
            },
        );
    }
    pub fn open_ui_draft(
        &mut self,
        draft: surtitle_core::workspace::UiDraft,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.frozen(cx) {
            return;
        }
        let target = draft.fields.get("target").cloned().unwrap_or_default();
        if draft.kind == "transcript_review" && !target.starts_with("selection:") {
            if let Some(job) = draft.fields.get("jobId").cloned() {
                self.open_transcript(job.clone(), window, cx);
                if let Some(view) = self.reviews.get(&job) {
                    view.update(cx, |view, cx| view.open_raw(&draft, cx));
                }
            }
            return;
        }
        let selection = if draft.kind == "draft_card" {
            draft.entity_id.clone()
        } else {
            target.trim_start_matches("selection:").into()
        };
        let media_ids: Vec<_> = self
            .session
            .read(cx)
            .snapshot
            .as_ref()
            .into_iter()
            .flat_map(|s| s.media.iter().map(|m| m.id.clone()))
            .collect();
        let backend = self.session.read(cx).backend.clone();
        let state = backend.state.clone();
        let handle = window.window_handle();
        run(
            &backend,
            cx,
            async move {
                for media in media_ids {
                    let views =
                        commands::transcript_study::list_draft_selections(&state, media.clone())
                            .await?;
                    if views.iter().any(|view| {
                        view.selection.get("id").and_then(|id| id.as_str())
                            == Some(selection.as_str())
                    }) {
                        return Ok(media);
                    }
                }
                Err("The original bookmark is missing. This raw input remains available for copying or discarding".into())
            },
            move |this, result, cx| match result {
                Ok(media) => {
                    cx.spawn(async move |this, cx| {
                        let _ = handle.update(cx, |_, window, cx| {
                            this.update(cx, |this, cx| {
                                if this.frozen(cx) {
                                    return;
                                }
                                let view = this.draft_study_entry(media, window, cx);
                                view.update(cx, |view, cx| view.open_raw(&draft, cx));
                                if let Err(error) =
                                    open_dialog("Surtitle · Recover excerpt input", view, cx)
                                {
                                    this.error = Some(error);
                                }
                            })
                        });
                    })
                    .detach();
                }
                Err(error) => this.error = Some(error),
            },
        );
    }
    pub fn recover_ui_draft(
        &mut self,
        draft: &surtitle_core::workspace::UiDraft,
        cx: &mut Context<Self>,
    ) {
        if draft.kind == "draft_card" {
            self.store.request_card_recovery(draft.entity_id.clone());
            self.notify_forms(cx);
        }
    }
    /// The caller has already CAS-deleted this record under the combined gate.
    pub fn retire_ui_draft(
        &mut self,
        draft: &surtitle_core::workspace::UiDraft,
        cx: &mut Context<Self>,
    ) -> Result<(), String> {
        if draft.kind == "transcript_review" && draft.archive_id.is_none() {
            self.store.retire_raw(&draft.entity_id)?;
            for view in self.reviews.values() {
                view.update(cx, |view, cx| view.retire_raw(&draft.entity_id, cx));
            }
            for view in self.draft_study.values() {
                view.update(cx, |view, cx| view.retire_raw(&draft.entity_id, cx));
            }
        }
        self.notify_forms(cx);
        Ok(())
    }
    pub fn new(
        session: Entity<Session>,
        editors: Entity<EditorRegistry>,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        cx.set_global(AiSession(session.clone()));
        let store = Persistence::new(session.read(cx).backend.clone());
        let snapshot = cx.subscribe(&session, |this, _, event: &UiEvent, cx| {
            if matches!(event, UiEvent::Snapshot | UiEvent::Recovery) {
                this.refresh(cx);
                this.notify_forms(cx);
            }
            cx.notify();
        });
        let observed = cx.observe(&session, |_, _, cx| cx.notify());
        let changes = store.clone();
        let mut read_epoch = changes.continuation_read_epoch();
        // A sleeping observer owns no backend in-flight guard. Only a finite
        // serialized input drain plus native read participates in root gates.
        let continuation_changes = cx.spawn(async move |view, cx| {
            loop {
                read_epoch = changes.continuation_changed(read_epoch).await;
                if view.update(cx, |view, cx| view.refresh(cx)).is_err() {
                    break;
                }
            }
        });
        let mut this = Self {
            session,
            editors,
            store,
            requests: BTreeMap::new(),
            reviews: BTreeMap::new(),
            draft_study: BTreeMap::new(),
            continuations: vec![],
            error: None,
            discard_confirmation: None,
            cancelling_operations: Default::default(),
            refreshing: false,
            refresh_again: false,
            _continuation_changes: continuation_changes,
            _subscriptions: vec![snapshot, observed],
        };
        this.refresh(cx);
        this
    }
    pub fn request(&mut self, intent: AiIntent, window: &mut Window, cx: &mut Context<Self>) {
        self.request_for_cues(intent, vec![], window, cx);
    }
    pub fn request_for_cues(
        &mut self,
        intent: AiIntent,
        source_cues: Vec<surtitle_core::SubtitleSegment>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.frozen(cx) {
            return;
        }
        let Some(media) = self
            .session
            .read(cx)
            .snapshot
            .as_ref()
            .and_then(|s| s.media.iter().find(|m| m.id == intent.media_id))
            .cloned()
        else {
            self.error = Some("The selected media is no longer available".into());
            cx.notify();
            return;
        };
        let settings = &self.session.read(cx).snapshot.as_ref().unwrap().settings;
        let value = AiContinuation {
            provider: settings.active_provider,
            ai_configuration_generation: settings.ai_configuration_generation,
            id: uuid::Uuid::new_v4().to_string(),
            media_id: media.id.clone(),
            kind: intent.kind.as_str().into(),
            start: policy::timestamp(intent.start_ms),
            end: policy::timestamp(if intent.end_ms > intent.start_ms {
                intent.end_ms
            } else {
                media.duration_ms
            }),
            whole_media: intent.start_ms == 0 && intent.end_ms >= media.duration_ms,
            focus_term: intent.focus_term.unwrap_or_default(),
            models: Default::default(),
            model_inputs: Default::default(),
            preparation_id: None,
            quote_id: None,
            source_cue_ids: source_cues.iter().map(|cue| cue.id.clone()).collect(),
            source_revision: (!source_cues.is_empty())
                .then(|| serde_json::to_string(&source_cues).unwrap()),
            source_media_signature: Some(
                serde_json::to_string(&(
                    &media.path,
                    media.audio_stream_index,
                    &media.learning_language,
                    &media.explanation_language,
                ))
                .unwrap(),
            ),
            updated_at_ms: 0,
        };
        self.open_request(value, window, cx);
    }
    fn open_request(&mut self, value: AiContinuation, window: &mut Window, cx: &mut Context<Self>) {
        if self.frozen(cx) {
            return;
        }
        if let Some(binding) = value
            .source_revision
            .as_deref()
            .and_then(|revision| revision.strip_prefix("draft-study:"))
            && let Some((selection, _)) = binding.rsplit_once(':')
        {
            let entity = self.draft_study_entry(value.media_id.clone(), window, cx);
            entity.update(cx, |view, cx| view.open_selection(selection.into(), cx));
            if let Err(error) = open_dialog("Surtitle · Resume excerpt AI settings", entity, cx) {
                self.error = Some(error);
            }
            return;
        }
        let id = value.id.clone();
        let entity = if let Some(existing) = self.requests.get(&id) {
            existing.clone()
        } else {
            let session = self.session.clone();
            let store = self.store.clone();
            let entity = cx.new(|cx| RequestDialog::new(session, store, value, window, cx));
            self.requests.insert(id, entity.clone());
            entity
        };
        if let Err(error) = open_dialog("Surtitle · AI estimate", entity, cx) {
            self.error = Some(error);
            cx.notify();
        }
    }
    pub fn open_job(&mut self, job_id: String, window: &mut Window, cx: &mut Context<Self>) {
        self.open_transcript(job_id, window, cx);
    }
    pub fn open_transcript(&mut self, job_id: String, window: &mut Window, cx: &mut Context<Self>) {
        if self.frozen(cx) {
            return;
        }
        let entity = if let Some(existing) = self.reviews.get(&job_id) {
            existing.clone()
        } else {
            let session = self.session.clone();
            let store = self.store.clone();
            let id = job_id.clone();
            let owner = cx.entity().downgrade();
            let entity = cx.new(|cx| ReviewDialog::new(session, store, owner, id, window, cx));
            self.reviews.insert(job_id, entity.clone());
            entity
        };
        entity.update(cx, |view, cx| view.refresh(cx));
        if let Err(error) = open_dialog("Surtitle · Saved AI results", entity, cx) {
            self.error = Some(error);
            cx.notify();
        }
    }
    pub fn flush_all(&mut self, purpose: FlushPurpose, cx: &mut Context<Self>) -> FlushFuture {
        let result = self.store.flush(purpose);
        self.notify_forms(cx);
        result
    }
    pub fn open_draft_study(
        &mut self,
        media_id: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.frozen(cx) {
            return;
        }
        let entity = self.draft_study_entry(media_id, window, cx);
        if let Err(error) = open_dialog("Surtitle · Study from drafts", entity, cx) {
            self.error = Some(error);
            cx.notify();
        }
    }
    pub fn prepare_draft_study(
        &mut self,
        job_id: String,
        cue_ids: Option<Vec<String>>,
        ordinal: Option<u32>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.frozen(cx) {
            return;
        }
        let media = self
            .session
            .read(cx)
            .snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.jobs.iter().find(|job| job.id == job_id))
            .and_then(|job| job.media_id.clone());
        let Some(media) = media else {
            self.error = Some("The source job or media is missing".into());
            return;
        };
        let entity = self.draft_study_entry(media, window, cx);
        entity.update(cx, |view, cx| {
            view.prepare(
                crate::application::transcript::study::PrepareSelection {
                    job_id,
                    cue_ids,
                    ordinal,
                },
                cx,
            )
        });
        if let Err(error) = open_dialog("Surtitle · Study this excerpt", entity, cx) {
            self.error = Some(error);
            cx.notify();
        }
    }
    fn draft_study_entry(
        &mut self,
        media: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<draft_study::DraftStudyDialog> {
        if let Some(entity) = self.draft_study.get(&media) {
            return entity.clone();
        }
        let session = self.session.clone();
        let editors = self.editors.clone();
        let store = self.store.clone();
        let id = media.clone();
        let entity = cx
            .new(|cx| draft_study::DraftStudyDialog::new(session, editors, store, id, window, cx));
        self.draft_study.insert(media, entity.clone());
        entity
    }
    pub fn frozen(&self, cx: &gpui_kit::App) -> bool {
        self.store.frozen() || self.editors.read(cx).frozen()
    }
    pub fn resume(&mut self, cx: &mut Context<Self>) -> Result<(), String> {
        let result = self.store.resume();
        if result.is_ok() && self.refresh_again {
            self.refresh(cx);
        }
        self.notify_forms(cx);
        result
    }
    pub fn invalidate_after_restore(&mut self, cx: &mut Context<Self>) -> Result<(), String> {
        self.store.restored()?;
        self.requests.clear();
        self.reviews.clear();
        self.draft_study.clear();
        self.continuations.clear();
        self.cancelling_operations.clear();
        self.refreshing = false;
        self.refresh_again = false;
        self.refresh(cx);
        self.notify_forms(cx);
        Ok(())
    }
    fn notify_forms(&self, cx: &mut Context<Self>) {
        for entity in self.requests.values() {
            entity.update(cx, |view, cx| view.notify_forms(cx));
        }
        for entity in self.reviews.values() {
            entity.update(cx, |view, cx| view.notify_forms(cx));
        }
        for entity in self.draft_study.values() {
            entity.update(cx, |view, cx| view.notify_forms(cx));
        }
        cx.notify();
    }
    pub fn entered(&mut self, cx: &mut Context<Self>) {
        self.refresh(cx);
    }
    #[cfg(test)]
    pub(super) fn test_refresh_diagnostics(&self, cx: &gpui_kit::App) -> String {
        format!(
            "continuation_epoch={} generation={} refreshing={} again={} frozen={} pending={} error={:?} save_error={:?} continuation_ids={:?}",
            self.store.continuation_read_epoch(),
            self.store.generation(),
            self.refreshing,
            self.refresh_again,
            self.frozen(cx),
            self.store.pending(),
            self.error,
            self.store.error(),
            self.continuations
                .iter()
                .map(|value| value.id.as_str())
                .collect::<Vec<_>>(),
        )
    }
    fn refresh(&mut self, cx: &mut Context<Self>) {
        if self.frozen(cx) || self.refreshing {
            self.refresh_again = true;
            return;
        }
        self.refreshing = true;
        self.refresh_again = false;
        let backend = self.session.read(cx).backend.clone();
        let state = backend.state.clone();
        let read_epoch = self.store.continuation_read_epoch();
        let saved = self.store.drain_inputs();
        run(
            &backend,
            cx,
            async move {
                saved.await?;
                commands::continuations::list_ai_continuations(&state)
            },
            move |this, result, cx| {
                this.refreshing = false;
                if this.frozen(cx) {
                    this.refresh_again = true;
                    return;
                }
                if !this.store.continuation_read_current(read_epoch) || this.refresh_again {
                    this.refresh(cx);
                    return;
                }
                match result {
                    Ok(values) => {
                        this.continuations = values;
                        this.error = None;
                    }
                    Err(error) => this.error = Some(error),
                }
            },
        );
    }
    fn resolve_unknown(&mut self, id: String, cx: &mut Context<Self>) {
        let Ok(guard) = self.store.operation() else {
            return;
        };
        let backend = self.session.read(cx).backend.clone();
        let state = backend.state.clone();
        run(
            &backend,
            cx,
            async move {
                let _guard = guard;
                commands::ai::resolve_unknown_attempt(&state, id)
            },
            |this, result, cx| {
                this.error = result.err();
                this.session.update(cx, |session, cx| session.refresh(cx));
            },
        );
    }
    fn cancel_operation(&mut self, id: String, cx: &mut Context<Self>) {
        if self.frozen(cx) || self.cancelling_operations.contains(&id) {
            return;
        }
        if !self.session.read(cx).operations.iter().any(|operation| {
            operation.id == id && operation.kind == "preparation" && operation.status == "running"
        }) {
            return;
        }
        self.cancelling_operations.insert(id.clone());
        let backend = self.session.read(cx).backend.clone();
        let state = backend.state.clone();
        let cancelled = id.clone();
        run(
            &backend,
            cx,
            async move { commands::ai::cancel_preparation(&state, Some(id)) },
            move |this, result, cx| {
                this.cancelling_operations.remove(&cancelled);
                this.error = result.err();
                this.session.update(cx, |session, cx| session.refresh(cx));
            },
        );
    }

    fn operation_row(
        &self,
        operation: &OperationProgress,
        compact: bool,
        cx: &Context<Self>,
    ) -> gpui_kit::Stateful<gpui_kit::Div> {
        let theme = cx.theme();
        let frozen = self.frozen(cx);
        let status = localized(
            cx,
            match operation.status.as_str() {
                "running" => "実行中 / Running",
                "completed" => "完了 / Completed",
                "cancelled" => "中止 / Cancelled",
                _ => "失敗 / Failed",
            },
        );
        let phase = localized(
            cx,
            match operation.phase.as_str() {
                "preparing" => "準備中 / Preparing",
                "inspecting" => "確認中 / Inspecting",
                "downloading" => "ダウンロード中 / Downloading",
                "verifying" => "検証中 / Verifying",
                "extracting" => "抽出中 / Extracting",
                "completed" => "完了 / Completed",
                other => other,
            },
        );
        let unit = localized(
            cx,
            match operation.unit.as_deref() {
                Some("bytes") => "バイト / bytes",
                Some("milliseconds") => "ミリ秒 / ms",
                Some("items") => "件 / items",
                Some(other) => other,
                None => "",
            },
        );
        let progress = match (operation.completed, operation.total) {
            (Some(completed), Some(total)) => format!("{completed} / {total} {unit}"),
            (Some(completed), None) => format!("{completed} {unit}"),
            _ => String::new(),
        };
        let summary = format!("{} · {status} · {phase} · {progress}", operation.label);
        let accessible = format!(
            "{summary}{}",
            operation
                .error
                .as_ref()
                .map(|error| format!(" · {error}"))
                .unwrap_or_default()
        );
        let element_id = format!("local-operation-{}", operation.id);
        let mut card = column()
            .id(element_id.clone())
            .role(gpui_kit::accesskit::Role::Group)
            .accessibility_id(element_id)
            .aria_label(accessible)
            .p_3()
            .border_1()
            .border_color(theme.border)
            .when(compact, |card| card.ml_4())
            .child(
                column()
                    .id(format!("operation-details-{}", operation.id))
                    .test_support()
                    .h(px(60.))
                    .flex_shrink_0()
                    .overflow_y_scroll()
                    .gap_1()
                    .font_features(tabular_numbers())
                    .child(
                        div()
                            .flex_shrink_0()
                            .child(gpui_kit::base::SelectableText::new(
                                format!("operation-summary-{}", operation.id),
                                summary,
                            )),
                    )
                    .when_some(operation.error.clone(), |body, error| {
                        body.child(
                            div()
                                .id(format!("operation-error-body-{}", operation.id))
                                .test_support()
                                .flex_shrink_0()
                                .text_color(theme.danger)
                                .child(gpui_kit::base::SelectableText::new(
                                    format!("operation-error-{}", operation.id),
                                    error,
                                )),
                        )
                    }),
            )
            .child(operation.updated_at.clone());
        if !compact {
            let mut actions = row();
            if operation.kind == "preparation" {
                let id = operation.id.clone();
                actions =
                    actions.child(
                        Button::new(format!("cancel-operation-{id}"))
                            .label(localized(cx, "中止 / Cancel"))
                            .disabled(
                                frozen
                                    || operation.status != "running"
                                    || self.cancelling_operations.contains(&id),
                            )
                            .when(operation.status != "running", |button| button.invisible())
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.cancel_operation(id.clone(), cx)
                            })),
                    );
            }
            let destination = if let Some(media) = &operation.media_id {
                Some((
                    Route::Study(media.clone()),
                    localized(cx, "教材を開く / Open media"),
                ))
            } else if ["tool", "tool_check", "models", "tool_scan", "tool_updates"]
                .contains(&operation.kind.as_str())
            {
                Some((Route::Settings, localized(cx, "設定を開く / Open settings")))
            } else if [
                "import_check",
                "import",
                "restore",
                "restore_preview",
                "export",
            ]
            .contains(&operation.kind.as_str())
            {
                Some((
                    Route::Library,
                    localized(cx, "ライブラリを開く / Open library"),
                ))
            } else {
                None
            };
            if let Some((route, label)) = destination {
                actions = actions.child(
                    Button::new(format!("open-operation-{}", operation.id))
                        .label(label)
                        .disabled(frozen)
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.session
                                .update(cx, |session, cx| session.navigate(route.clone(), cx));
                        })),
                );
            }
            card = card.child(actions);
        }
        card
    }
    fn discard_continuation(&mut self, id: String, cx: &mut Context<Self>) {
        if self.frozen(cx) {
            return;
        }
        if self.discard_confirmation.as_ref() != Some(&id) {
            self.discard_confirmation = Some(id);
            cx.notify();
            return;
        }
        let gate = self.store.flush(FlushPurpose::Export);
        let store = self.store.clone();
        let backend = self.session.read(cx).backend.clone();
        let state = backend.state.clone();
        let removed = id.clone();
        run(
            &backend,
            cx,
            async move {
                gate.await?;
                commands::continuations::discard_ai_continuation(&state, id.clone())?;
                store.retire_continuation(&id)?;
                Ok(())
            },
            move |this, result, cx| {
                if result.is_ok() {
                    this.requests.remove(&removed);
                    for view in this.draft_study.values() {
                        view.update(cx, |view, cx| view.retire_continuation(&removed, cx));
                    }
                    this.continuations.retain(|value| value.id != removed);
                    this.discard_confirmation = None;
                }
                this.error = result.err();
                let _ = this.store.resume();
                this.refresh(cx);
                this.notify_forms(cx);
            },
        );
        self.notify_forms(cx);
    }
}
impl Render for AiView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        let model = self.session.read(cx);
        let frozen = self.frozen(cx);
        let mut content = column().p_6().gap_5().child(
            div()
                .text_size(px(20.))
                .child(model.text("この起動中の操作", "Local operations this session")),
        );
        let operation_ids = model
            .operations
            .iter()
            .map(|operation| operation.id.as_str())
            .collect::<std::collections::BTreeSet<_>>();
        for operation in model.operations.iter().filter(|operation| {
            operation
                .parent_id
                .as_deref()
                .is_none_or(|parent| !operation_ids.contains(parent))
        }) {
            let mut card = self.operation_row(operation, false, cx);
            for child in model
                .operations
                .iter()
                .filter(|child| child.parent_id.as_deref() == Some(&operation.id))
            {
                card = card.child(self.operation_row(child, true, cx).test_support());
            }
            content = content.child(card.test_support());
        }
        if model.operations.is_empty() {
            content = content.child(model.text(
                "現在処理中の操作はありません。",
                "No operations are running.",
            ));
        }
        content = content.child(div().text_color(theme.muted_foreground).child(model.text(
            "この起動中の完了・失敗・中止は、直近20件まで表示します。",
            "The latest 20 completed, failed, or cancelled operations from this session are shown.",
        ))).child(div().text_size(px(20.)).child(model.text("AIの処理と保存結果", "AI activity and saved results")))
            .child(div().text_color(theme.muted_foreground).child(localized(cx, "見積もりと音声準備は送信を承認しません。開始ボタンで表示した範囲だけを承認します。 / Estimates and audio preparation do not authorize sending.")));
        if let Some(error) = self.error.as_ref().or(self.store.error().as_ref()) {
            content = content.child(div().child(error.clone()));
        }
        if let Some(notice) = self.store.notice() {
            content = content.child(div().child(notice));
        }
        if let Some(snapshot) = &model.snapshot {
            for (provider, budget) in &snapshot.budgets {
                content = content.child(div().text_size(px(16.)).child(locale_format!(
                    cx,
                    "{} · 使用済み ${:.4} · 予約中 ${:.4} · 1日の上限 ${:.2}{}",
                    "{} · spent ${:.4} · reserved ${:.4} · daily limit ${:.2}{}",
                    provider.as_str(),
                    budget.spent_usd,
                    budget.reserved_usd,
                    budget.limit_usd,
                    if budget.monetary_totals_complete {
                        ""
                    } else {
                        model.text(" · 金額の集計は不完全です", " · monetary totals incomplete")
                    }
                )));
                for attempt in &budget.unknown_attempts {
                    let id = attempt.id.clone();
                    let job = attempt.job_id.clone();
                    content=content.child(column().border_1().border_color(theme.border).p_3().child(locale_format!(cx, "結果不明 · 処理 {} · 要求 {} · 保留 {} · {}", "Unknown outcome · job {} · request {} · held {} · {}",attempt.job_id,attempt.ordinal+1,money(attempt.held_usd,cx),attempt.created_at)).child(localized(cx, "予約は保持されています。利用明細を確認したあと、再試行を選ぶ前に結果不明として確認済みにできます。 / The reservation is retained. Check provider usage before acknowledging this outcome.")).child(row().child(Button::new(format!("unknown-open-{id}")).label(localized(cx, "詳細 / Details")).on_click(cx.listener(move|this,_,window,cx|this.open_job(job.clone(),window,cx)))).child(Button::new(format!("unknown-ack-{id}")).label(localized(cx, "利用明細を確認済み・不明のまま記録 / Usage checked; acknowledge unknown")).disabled(frozen).on_click(cx.listener(move|this,_,_,cx|this.resolve_unknown(id.clone(),cx))))));
                }
            }
            for (index, job) in snapshot.jobs.iter().enumerate() {
                let id = job.id.clone();
                let requests = &job.request_counts;
                let media_title = job
                    .media_id
                    .as_ref()
                    .and_then(|id| snapshot.media.iter().find(|media| &media.id == id))
                    .map(|media| media.title.as_str());
                let purpose = localized(
                    cx,
                    match job.kind.as_str() {
                        "transcribe" => "文字起こし / Transcription",
                        "translate" => "翻訳 / Translation",
                        "vocabulary" => "語彙・解説 / Vocabulary and explanation",
                        other => other,
                    },
                );
                let status = localized(
                    cx,
                    match job.status.as_str() {
                        "queued" => "開始待ち / Queued",
                        "running" => "実行中 / Running",
                        "paused" => "一時停止 / Paused",
                        "completed" => "完了 / Completed",
                        "failed" => "失敗 / Failed",
                        "cancelled" => "中止 / Cancelled",
                        "unknown" => "結果不明 / Unknown outcome",
                        other => other,
                    },
                );
                let card = column()
                    .p_4()
                    .border_1()
                    .border_color(theme.border)
                    .child(
                        row()
                            .justify_between()
                            .child(div().id(format!("job-summary-{id}")).flex_1().min_w_0().h(px(48.)).overflow_y_scroll().text_size(px(18.)).child(format!(
                                "{} · {} · {}",
                                media_title.unwrap_or(model.text(
                                    "元の教材が見つかりません",
                                    "Source media is unavailable"
                                )),
                                purpose,
                                status
                            )))
                            .child(
                                Button::new(("job-open", index))
                                    .label(localized(
                                        cx,
                                        "見積・結果を開く / Open estimate and results",
                                    ))
                                    .disabled(frozen)
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        this.open_job(id.clone(), window, cx)
                                    })),
                            ),
                    )
                    .child(div().text_color(theme.muted_foreground).child(format!(
                        "{} · {}",
                        job.provider.as_str(),
                        job.id
                    )))
                    .child(column().id(format!("job-progress-{}", job.id)).h(px(48.)).flex_shrink_0().overflow_y_scroll().gap_1().font_features(tabular_numbers()).child(div().flex_shrink_0().child(locale_format!(
                        cx,
                        "{:.0}% · {} / {} 成功 · {} 実行中 · {} 拒否 · {} 未処理",
                        "{:.0}% · {} / {} succeeded · {} in flight · {} rejected · {} pending",
                        job.progress * 100.,
                        requests.succeeded,
                        requests.total,
                        requests.in_flight,
                        requests.rejected,
                        requests.pending
                    )))
                    .child(div().flex_shrink_0().child(locale_format!(
                        cx,
                        "{} · 保存結果 {} · 実行結果 {}",
                        "{} · result {} · outcome {}",
                        job.created_at,
                        job.result_state,
                        job.execution_outcome
                            .as_deref()
                            .unwrap_or(model.text("未確定", "pending"))
                    ))));
                let mut details = column()
                    .id(format!("job-details-{}", job.id))
                    .h(px(48.))
                    .flex_shrink_0()
                    .overflow_y_scroll()
                    .gap_1()
                    .font_features(tabular_numbers());
                if let Some(message) = &job.message {
                    details = details.child(div().flex_shrink_0().child(
                        gpui_kit::base::SelectableText::new(
                            format!("job-message-{}", job.id),
                            message.clone(),
                        ),
                    ));
                }
                if let Some(issue) = &job.issue {
                    details = details.child(div().flex_shrink_0().child(locale_format!(
                        cx,
                        "問題: {:?}",
                        "Issue: {:?}",
                        issue
                    )));
                }
                if let Some(retry) = &job.retry {
                    details = details.child(div().flex_shrink_0().child(locale_format!(
                        cx,
                        "再試行 {} / {} · {} · 次回 {}",
                        "Retry {} / {} · {} · next {}",
                        retry.retry_number,
                        retry.max_retries,
                        retry.state,
                        retry.next_retry_at.as_deref().unwrap_or("—")
                    )));
                }
                if let Some(pacing) = &job.pacing {
                    details = details.child(div().flex_shrink_0().child(locale_format!(
                        cx,
                        "次の要求 {} · 間隔 {} ミリ秒 · {}",
                        "Next request {} · interval {} ms · {}",
                        pacing
                            .next_send_at
                            .as_deref()
                            .unwrap_or(model.text("準備完了", "ready")),
                        pacing.interval_ms,
                        if pacing.slowed {
                            model.text("間隔を延長", "slowed")
                        } else {
                            model.text("通常", "normal")
                        }
                    )));
                }
                content = content.child(card.child(details));
            }
        }
        if !self.continuations.is_empty() {
            content = content.child(
                div()
                    .text_size(px(20.))
                    .child(localized(cx, "未完了の操作 / Unfinished requests")),
            );
            for value in self.continuations.clone() {
                let id = value.id.clone();
                let discard_id = id.clone();
                let resume_id = id.clone();
                let confirming = self.discard_confirmation.as_ref() == Some(&id);
                let discard_label = localized(cx, "入力を破棄 / Discard input");
                let confirmation_label = localized(cx, "入力を完全に破棄 / Confirm discard input");
                let current_label = if confirming {
                    &confirmation_label
                } else {
                    &discard_label
                };
                content = content.child(
                    row()
                        .child(format!(
                            "{} · {} · {}–{}",
                            value.kind, value.media_id, value.start, value.end
                        ))
                        .child(
                            Button::new(format!("resume-{id}"))
                                .label(localized(cx, "入力から再開 / Resume input"))
                                .disabled(frozen)
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    this.open_continuation(resume_id.clone(), window, cx)
                                })),
                        )
                        .child(
                            Button::new(format!("discard-{id}"))
                                .accessibility_label(current_label.clone())
                                .child(state_label(
                                    current_label.clone(),
                                    &[&discard_label, &confirmation_label],
                                ))
                                .disabled(frozen)
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.discard_continuation(discard_id.clone(), cx)
                                })),
                        ),
                );
            }
        }
        div()
            .id("ai-activity-scroll")
            .size_full()
            .overflow_y_scroll()
            .bg(theme.background)
            .text_color(theme.foreground)
            .child(content)
    }
}
pub(super) fn money(value: Option<f64>, cx: &gpui_kit::App) -> String {
    value
        .map(|n| format!("${n:.6}"))
        .unwrap_or_else(|| localized(cx, "料金不明 / Price unknown"))
}
pub(super) fn quote_content(quote: &AiQuote, cx: &gpui_kit::App) -> gpui_kit::Div {
    // Kit's accordion is controlled. Keep its disclosure state local to this
    // quote and window rather than adding it to persisted approval state.
    struct QuoteDetails {
        id: gpui_kit::SharedString,
        label: String,
        content: gpui_kit::Div,
    }
    impl IntoElement for QuoteDetails {
        type Element = gpui_kit::ViewElement<Self>;
        fn into_element(self) -> Self::Element {
            gpui_kit::ViewElement::new(self)
        }
    }
    impl gpui_kit::RenderOnce for QuoteDetails {
        fn render(self, window: &mut Window, cx: &mut gpui_kit::App) -> impl IntoElement {
            let state = window.use_keyed_state(
                (gpui_kit::ElementId::from(self.id.clone()), "open"),
                cx,
                |_, _| false,
            );
            let open = *state.read(cx);
            gpui_kit::component::accordion::Accordion::new(self.id)
                .w_full()
                .h_auto()
                .flex_shrink_0()
                .item(|item| item.title(self.label).open(open).child(self.content))
                .on_toggle_click(move |indices, _, cx| {
                    state.update(cx, |open, cx| {
                        *open = indices.contains(&0);
                        cx.notify();
                    });
                })
        }
    }
    let text = |ja: &str, en: &str| {
        if japanese(cx) {
            ja.to_string()
        } else {
            en.to_string()
        }
    };
    let mut content = column()
        .gap_2()
        .child(div().text_color(cx.theme().muted_foreground).child(format!(
            "{} · {}",
            text("この実行の見積もり", "Estimate for this job"),
            quote.provider.as_str()
        )))
        .child(
            div()
                .text_size(px(23.))
                .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                .child(format!(
                    "{} {} · {} {}",
                    text("見積", "Estimate"),
                    money(quote.estimated_usd, cx),
                    text("予約上限", "Maximum reservation"),
                    money(quote.maximum_usd, cx)
                )),
        )
        .child(format!(
            "{}: {}",
            text("対象の教材", "Source media"),
            cx.try_global::<AiSession>()
                .and_then(|session| session.0.read(cx).snapshot.as_ref())
                .and_then(|snapshot| snapshot
                    .media
                    .iter()
                    .find(|media| media.id == quote.media_id))
                .map(|media| media.title.clone())
                .unwrap_or_else(|| format!(
                    "{} · {}",
                    text("元の教材が見つかりません", "Source media is unavailable"),
                    quote.media_id
                ))
        ))
        .when_some(
            quote
                .focus_term
                .clone()
                .filter(|term| !term.trim().is_empty()),
            |body, term| {
                body.child(
                    div()
                        .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                        .child(format!(
                            "{}: {term}",
                            text("解説する表現", "Phrase to explain")
                        )),
                )
            },
        )
        .child(format!(
            "{} {} · {} {} · {} {} · {} {}",
            text("プロバイダー", "Provider"),
            quote.provider.as_str(),
            text("目的", "Purpose"),
            match quote.kind.as_str() {
                "translate" => text("翻訳", "Translation"),
                "transcribe" => text("文字起こし", "Transcription"),
                "vocabulary" => text("語彙・解説", "Vocabulary / explanation"),
                other => other.into(),
            },
            text("モデル", "Model"),
            quote.model,
            text("地域", "Location"),
            quote.location
        ))
        .child(format!(
            "{}: {} — {}",
            text("対象区間", "Selected range"),
            policy::timestamp(quote.start_ms),
            policy::timestamp(quote.end_ms)
        ))
        .child(format!(
            "{}: {}",
            text("反映方針", "Apply policy"),
            match quote.apply_policy {
                surtitle_ai::TranscriptApplyPolicy::Manual => text(
                    "受信した結果を手動で確認して反映",
                    "Review received results before applying"
                ),
                surtitle_ai::TranscriptApplyPolicy::Auto => text(
                    "受信した字幕を自動表示",
                    "Apply received subtitles automatically"
                ),
            }
        ))
        .child(div().text_color(cx.theme().muted_foreground).child(format!(
            "{}: {}",
            text("見積もりの有効期限", "Estimate expires"),
            quote.expires_at
        )));
    let mut details = column()
        .gap_3()
        .child(format!(
            "{} {} · {} {}",
            text("要求数", "Requests"),
            quote.request_count,
            text("再試行を含む最大数", "Maximum including retries"),
            quote.maximum_request_count
        ))
        .child(format!(
            "{} {} / {} {} ms · {} {} / {} / {} · {} {}",
            text("送信音声", "Audio"),
            quote.send_duration_ms,
            text("最大", "Maximum"),
            quote.maximum_send_duration_ms,
            text(
                "出力トークン 要求毎・合計・最大",
                "Output tokens per request / total / maximum"
            ),
            quote.max_output_tokens,
            quote.total_output_tokens,
            quote.maximum_total_output_tokens,
            text("入力トークン", "Input tokens"),
            quote.input_tokens
        ))
        .child(format!(
            "{} {}",
            text("AI設定の世代", "AI configuration generation"),
            quote.ai_configuration_generation
        ))
        .child(format!(
            "{} {} · {} {}",
            text("承認ダイジェスト", "Approval digest"),
            quote.digest,
            text("見積ID", "Quote ID"),
            quote.id
        ))
        .child(format!(
            "{} {}",
            text("料金の出典", "Price source"),
            quote.pricing_source.as_deref().unwrap_or("unknown")
        ));
    if let Some(policy) = &quote.retry_policy {
        details = details.child(format!(
            "{} {} · {} v{} · {}",
            text(
                "HTTP 429時だけ再試行：要求毎の最大回数",
                "HTTP 429 retries only: maximum per request"
            ),
            policy.max_retries,
            text("再試行方針", "Retry policy"),
            policy.version,
            text(
                "結果不明なら送信を停止します。",
                "Unknown outcomes stop sending."
            )
        ));
    }
    for warning in &quote.warnings {
        content = content.child(div().text_color(cx.theme().danger).child(warning.clone()));
    }
    if let Some(reason) = quote.blocked_reason.as_ref().filter(|_| !quote.can_approve) {
        content = content.child(div().text_color(cx.theme().danger).child(reason.clone()));
    }
    if chrono::DateTime::parse_from_rfc3339(&quote.expires_at)
        .is_ok_and(|expiry| expiry <= chrono::Utc::now())
    {
        content = content.child(div().text_color(cx.theme().danger).child(text(
            "見積もりの有効期限が切れました。更新してから承認してください。",
            "This estimate expired. Refresh it before approving.",
        )));
    }
    if quote.unpriced || quote.maximum_usd.is_none() {
        content=content.child(localized(cx,"料金が不明のため金額上限は保証できません。 / The price is unknown; a dollar limit cannot be guaranteed."));
    }
    content.child(QuoteDetails {
        id: format!("quote-details-{}", quote.id).into(),
        label: text("料金・送信の詳細", "Cost and request details"),
        content: details,
    })
}
pub(super) fn open_dialog<V: Render + 'static>(
    title: &str,
    entity: Entity<V>,
    cx: &mut gpui_kit::App,
) -> Result<(), String> {
    let title = if japanese(cx) {
        match title {
            "Surtitle · AI estimate" => "Surtitle · AIの見積",
            "Surtitle · Recover excerpt input" => "Surtitle · 選択範囲の入力を復元",
            "Surtitle · Resume excerpt AI settings" => "Surtitle · 選択範囲のAI設定を再開",
            "Surtitle · Saved AI results" => "Surtitle · AIの保存結果",
            "Surtitle · Study from drafts" => "Surtitle · 下書きから学ぶ",
            "Surtitle · Study this excerpt" => "Surtitle · この範囲から学ぶ",
            other => other,
        }
    } else {
        title
    };
    crate::desktop::dialog::open_window(
        WindowOptions {
            titlebar: Some(TitlebarOptions {
                title: Some(title.to_owned().into()),
                ..Default::default()
            }),
            ..crate::desktop::dialog::options(
                size(px(1000.), px(760.)),
                Some(size(px(720.), px(480.))),
                cx,
            )
        },
        cx,
        move |window, cx| cx.new(|cx| gpui_kit::base::Root::new(entity, window, cx)),
    )
    .map(|_| ())
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod locale_tests {
    use super::*;
    #[test]
    fn language_selection_preserves_units_english_slashes_and_checked_state() {
        assert_eq!(
            localized_label(
                true,
                "入力 USD / 100万トークン / Input USD per million tokens"
            ),
            "入力 USD / 100万トークン"
        );
        assert_eq!(
            localized_label(
                false,
                "出力の要求毎・合計・最大 / Output per request / total / maximum"
            ),
            "Output per request / total / maximum"
        );
        assert_eq!(
            localized_label(false, "✓ 費用を確認済み / Cost reviewed"),
            "✓ Cost reviewed"
        );
        assert_eq!(
            localized_label(true, "✓ 費用を確認済み / Cost reviewed"),
            "✓ 費用を確認済み"
        );
        assert_eq!(
            localized_label(false, "quote-id / digest"),
            "quote-id / digest"
        );
    }
}
