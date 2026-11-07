// SPDX-License-Identifier: GPL-3.0-or-later
//! Study a received excerpt without adopting the whole transcript or changing receipts.
use super::{locale_format, localized};
use super::{
    model_form::{ModelForm, ModelValues},
    persistence::{Persistence, RawInput},
    policy, quote_content,
};
use crate::{
    application::{
        ai::AiQuote,
        transcript::{
            TranscriptReview,
            study::{
                ExportSelection, PrepareSelection, SelectionCard, SelectionQuote, SelectionVersion,
                SelectionView, UpdateSelection,
            },
        },
    },
    commands,
    ui::{
        editors::{EditorKey, EditorRegistry, FlushPurpose},
        session::{Session, run},
        style::{column, row},
    },
};
use gpui_kit::base::Disableable;
use gpui_kit::component::{
    ActiveTheme,
    button::{Button, ButtonVariants},
    input::{Input, InputEditsEvent, InputEvent, InputState, Textarea, TextareaState},
};
use gpui_kit::{
    AppContext, Context, Entity, Subscription, WeakEntity, Window, div, prelude::*, px,
};
use serde::Deserialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    future::Future,
    sync::Arc,
    time::Duration,
};
use surtitle_core::{DraftStudySelection, workspace::UiDraft};
#[derive(Clone)]
struct Bookmark {
    data: DraftStudySelection,
    stale: bool,
    reasons: Vec<String>,
    can_confirm: bool,
}
impl Bookmark {
    fn from(view: SelectionView) -> Result<Self, String> {
        Ok(Self {
            data: serde_json::from_value(view.selection).map_err(|e| e.to_string())?,
            stale: view.stale,
            reasons: view.blocking_reasons,
            can_confirm: view.can_confirm,
        })
    }
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Candidate {
    term: String,
    meaning: String,
    #[serde(default)]
    explanation: Option<String>,
    #[serde(default)]
    translation: Option<String>,
}
pub(super) struct DraftStudyDialog {
    session: Entity<Session>,
    editors: Entity<EditorRegistry>,
    store: Persistence,
    generation: u64,
    media: String,
    job: Option<String>,
    review: Option<Arc<TranscriptReview>>,
    bookmarks: Vec<Bookmark>,
    selected_cues: BTreeSet<String>,
    page: usize,
    forms: BTreeMap<String, Entity<SelectionEditor>>,
    selected: Option<String>,
    detached: Option<Bookmark>,
    pending: Option<(Bookmark, String)>,
    pending_prepare: Option<PrepareSelection>,
    requested_bookmark: Option<String>,
    busy: bool,
    error: Option<String>,
    _subscriptions: Vec<Subscription>,
}
impl DraftStudyDialog {
    pub fn retire_continuation(&mut self, id: &str, cx: &mut Context<Self>) {
        self.forms
            .retain(|_, form| form.read(cx).model_continuation.id != id);
        if self
            .selected
            .as_ref()
            .is_some_and(|key| !self.forms.contains_key(key))
        {
            self.selected = None;
        }
        self.notify_forms(cx);
    }
    pub fn open_selection(&mut self, id: String, cx: &mut Context<Self>) {
        self.requested_bookmark = Some(id);
        self.fulfill_bookmark(cx);
    }
    pub fn open_raw(&mut self, draft: &UiDraft, cx: &mut Context<Self>) {
        self.requested_bookmark = if draft.kind == "draft_card" {
            Some(draft.entity_id.clone())
        } else {
            draft
                .fields
                .get("target")
                .and_then(|target| target.strip_prefix("selection:"))
                .map(str::to_owned)
        };
        self.fulfill_bookmark(cx);
    }
    fn fulfill_bookmark(&mut self, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        if let Some(id) = self.requested_bookmark.clone()
            && let Some(bookmark) = self
                .bookmarks
                .iter()
                .find(|bookmark| bookmark.data.id == id)
                .cloned()
        {
            self.requested_bookmark = None;
            self.select(bookmark, cx);
        }
    }
    pub fn retire_raw(&mut self, id: &str, cx: &mut Context<Self>) {
        let removed: Vec<_> = self
            .forms
            .iter()
            .filter(|(_, form)| form.read(cx).raw_id == id)
            .map(|(key, _)| key.clone())
            .collect();
        for key in removed {
            self.forms.remove(&key);
            if self.selected.as_ref() == Some(&key) {
                self.selected = None;
            }
        }
        self.notify_forms(cx);
    }
    pub fn new(
        session: Entity<Session>,
        editors: Entity<EditorRegistry>,
        store: Persistence,
        media: String,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let generation = store.generation();
        let job = session
            .read(cx)
            .snapshot
            .as_ref()
            .and_then(|s| {
                s.jobs.iter().find(|j| {
                    j.media_id.as_deref() == Some(&media)
                        && j.kind == "transcribe"
                        && j.has_transcript_result
                })
            })
            .map(|j| j.id.clone());
        let observed = cx.observe(&session, |_, _, cx| cx.notify());
        let mut this = Self {
            session,
            editors,
            store,
            generation,
            media,
            job,
            review: None,
            bookmarks: vec![],
            selected_cues: BTreeSet::new(),
            page: 0,
            forms: BTreeMap::new(),
            selected: None,
            detached: None,
            pending: None,
            pending_prepare: None,
            requested_bookmark: None,
            busy: false,
            error: None,
            _subscriptions: vec![observed],
        };
        this.refresh(cx);
        this
    }
    fn frozen(&self, cx: &gpui_kit::App) -> bool {
        self.busy
            || self.store.frozen()
            || self.store.retired(self.generation)
            || self.editors.read(cx).frozen()
    }
    fn perform<T: Send + 'static>(
        &mut self,
        cx: &mut Context<Self>,
        future: impl Future<Output = Result<T, String>> + Send + 'static,
        done: impl FnOnce(&mut Self, T, &mut Context<Self>) + 'static,
    ) {
        if self.frozen(cx) {
            return;
        }
        let guard = match self.store.operation() {
            Ok(g) => g,
            Err(e) => {
                self.error = Some(e);
                return;
            }
        };
        let drain = self.store.drain_inputs();
        self.busy = true;
        let backend = self.session.read(cx).backend.clone();
        run(
            &backend,
            cx,
            async move {
                let _guard = guard;
                drain.await?;
                future.await
            },
            move |this, result, cx| {
                this.busy = false;
                match result {
                    Ok(value) => {
                        this.error = None;
                        done(this, value, cx);
                    }
                    Err(error) => this.error = Some(error),
                }
                if let Some(request) = this.pending_prepare.take() {
                    this.prepare(request, cx);
                }
                this.fulfill_bookmark(cx);
            },
        );
    }
    pub fn refresh(&mut self, cx: &mut Context<Self>) {
        let backend = self.session.read(cx).backend.clone();
        let state = backend.state.clone();
        let media = self.media.clone();
        let job = self.job.clone();
        self.perform(
            cx,
            async move {
                let bookmarks = commands::transcript_study::list_draft_selections(&state, media)
                    .await?
                    .into_iter()
                    .map(Bookmark::from)
                    .collect::<Result<Vec<_>, _>>()?;
                let review = match job {
                    Some(job) => {
                        Some(commands::transcript::get_transcript_review(&state, job).await?)
                    }
                    None => None,
                };
                Ok((bookmarks, review))
            },
            |this, (bookmarks, review), _| {
                this.bookmarks = bookmarks;
                this.review = review.map(Arc::new);
            },
        );
    }
    pub fn prepare(&mut self, request: PrepareSelection, cx: &mut Context<Self>) {
        if self.busy {
            self.pending_prepare = Some(request);
            return;
        }
        let backend = self.session.read(cx).backend.clone();
        let state = backend.state.clone();
        let job = request.job_id.clone();
        self.perform(
            cx,
            async move {
                let selected = Bookmark::from(
                    commands::transcript_study::prepare_draft_selection(&state, request).await?,
                )?;
                let review =
                    commands::transcript::get_transcript_review(&state, job.clone()).await?;
                Ok((selected, review, job))
            },
            |this, (bookmark, review, job), cx| {
                this.job = Some(job);
                this.review = Some(Arc::new(review));
                this.adopt(bookmark, cx);
            },
        );
    }
    pub fn notify_forms(&self, cx: &mut Context<Self>) {
        for form in self.forms.values() {
            form.update(cx, |form, cx| {
                form.model_form.update(cx, |_, cx| cx.notify());
                cx.notify();
            });
        }
        cx.notify();
    }
    fn adopt(&mut self, bookmark: Bookmark, cx: &mut Context<Self>) {
        self.detached = None;
        if let Some(existing) = self
            .bookmarks
            .iter_mut()
            .find(|b| b.data.id == bookmark.data.id)
        {
            *existing = bookmark.clone();
        } else {
            self.bookmarks.push(bookmark.clone());
        }
        if let Some(review) = &self.review {
            self.pending = Some((bookmark, review.draft.digest.clone()));
        }
        self.session.update(cx, |session, cx| session.refresh(cx));
        cx.notify();
    }
    fn select(&mut self, bookmark: Bookmark, cx: &mut Context<Self>) {
        self.detached = None;
        if let Some(job) = bookmark.data.job_id.clone() {
            let backend = self.session.read(cx).backend.clone();
            let state = backend.state.clone();
            self.perform(
                cx,
                async move {
                    Ok((
                        bookmark,
                        commands::transcript::get_transcript_review(&state, job).await?,
                    ))
                },
                |this, (bookmark, review), _| {
                    let digest = review.draft.digest.clone();
                    this.review = Some(Arc::new(review));
                    this.pending = Some((bookmark, digest));
                },
            );
        } else {
            self.selected = None;
            self.detached = Some(bookmark);
            self.error = None;
            cx.notify();
        }
    }
    fn detached_action(&mut self, remove: bool, cx: &mut Context<Self>) {
        let Some(bookmark) = self.detached.clone() else {
            return;
        };
        if bookmark.data.job_id.is_some() {
            return;
        }
        let backend = self.session.read(cx).backend.clone();
        let state = backend.state.clone();
        self.perform(
            cx,
            async move {
                if remove {
                    commands::transcript_study::remove_draft_selection(
                        &state,
                        SelectionVersion {
                            id: bookmark.data.id,
                            version: bookmark.data.version,
                        },
                    )?;
                    Ok(true)
                } else {
                    commands::transcript_study::export_draft_selection(
                        &state,
                        ExportSelection {
                            id: bookmark.data.id,
                            version: bookmark.data.version,
                            format: "json".into(),
                        },
                    )
                    .await
                }
            },
            move |this, changed, cx| {
                if remove && changed {
                    this.detached = None;
                    this.refresh(cx);
                }
            },
        );
    }
}
impl Render for DraftStudyDialog {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if let Some((bookmark, digest)) = self.pending.take() {
            let id = format!("{}:{}", bookmark.data.id, bookmark.data.version);
            if !self.forms.contains_key(&id) {
                let session = self.session.clone();
                let editors = self.editors.clone();
                let store = self.store.clone();
                let parent = cx.entity().downgrade();
                let form = cx.new(|cx| {
                    SelectionEditor::new(
                        session,
                        editors,
                        store,
                        parent,
                        SelectionSource { bookmark, digest },
                        window,
                        cx,
                    )
                });
                self.forms.insert(id.clone(), form);
            }
            self.selected = Some(id);
        }
        let theme = cx.theme().clone();
        let frozen = self.frozen(cx);
        let session = self.session.read(cx);
        let mut content=column().p_6().gap_4().child(div().text_size(px(25.)).child(localized(cx, "下書きの一部から学ぶ / Study a received excerpt"))).child(localized(cx, "本文と音声区間を自分で確認します。字幕全体を採用せずにブックマーク・カード・音声を保存できます。 / Review the text and replay interval; this does not adopt the whole transcript or settle a provider receipt.")).child(Button::new("refresh-draft-study").label(localized(cx, "再読込 / Refresh")).disabled(frozen).on_click(cx.listener(|this,_,_,cx|this.refresh(cx))));
        if self.store.retired(self.generation) {
            content=content.child(localized(cx, "データが復元されました。現在の教材から開き直してください。 / Reopen this retired window from the current source."));
        }
        if let Some(snapshot) = &session.snapshot {
            for (index, job) in snapshot
                .jobs
                .iter()
                .filter(|j| j.media_id.as_deref() == Some(&self.media) && j.kind == "transcribe")
                .enumerate()
            {
                let id = job.id.clone();
                content = content.child(
                    Button::new(("draft-study-job", index))
                        .label(format!(
                            "{} · {} · {:.0}% · {}",
                            job.created_at,
                            job.status,
                            job.progress * 100.,
                            job.result_state
                        ))
                        .disabled(frozen)
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.job = Some(id.clone());
                            this.selected_cues.clear();
                            this.page = 0;
                            this.refresh(cx);
                        })),
                );
            }
        }
        if let Some(review) = self.review.clone() {
            let start = self.page * 30;
            content = content.child(
                row()
                    .child(
                        Button::new("draft-cues-prev")
                            .label(localized(cx, "前の字幕 / Previous cues"))
                            .disabled(frozen || self.page == 0)
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.page = this.page.saturating_sub(1);
                                cx.notify();
                            })),
                    )
                    .child(
                        Button::new("draft-cues-next")
                            .label(localized(cx, "次の字幕 / Next cues"))
                            .disabled(frozen || start + 30 >= review.draft.segments.len())
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.page += 1;
                                cx.notify();
                            })),
                    ),
            );
            for cue in review.draft.segments.iter().skip(start).take(30) {
                let id = cue.id.clone();
                let selected = self.selected_cues.contains(&id);
                content = content.child(
                    Button::new(format!("draft-cue-{id}"))
                        .label(format!(
                            "{} {}–{} · {} · {}",
                            if selected { "✓" } else { "□" },
                            policy::timestamp(cue.start_ms),
                            policy::timestamp(cue.end_ms),
                            cue.timing_precision,
                            cue.text
                        ))
                        .disabled(frozen)
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if !this.selected_cues.remove(&id) && this.selected_cues.len() < 50 {
                                this.selected_cues.insert(id.clone());
                            }
                            cx.notify();
                        })),
                );
            }
            let job = review.job_id.clone();
            content = content.child(
                Button::new("prepare-selected-draft-cues")
                    .primary()
                    .label(localized(
                        cx,
                        "選んだ連続字幕をブックマーク / Bookmark selected contiguous cues",
                    ))
                    .disabled(frozen || self.selected_cues.is_empty())
                    .on_click(cx.listener(move |this, _, _, cx| {
                        let ids = this
                            .review
                            .as_ref()
                            .map(|r| {
                                r.draft
                                    .segments
                                    .iter()
                                    .filter(|c| this.selected_cues.contains(&c.id))
                                    .map(|c| c.id.clone())
                                    .collect::<Vec<_>>()
                            })
                            .unwrap_or_default();
                        this.prepare(
                            PrepareSelection {
                                job_id: job.clone(),
                                cue_ids: Some(ids),
                                ordinal: None,
                            },
                            cx,
                        );
                    })),
            );
            for chunk in &review.draft.chunks {
                let ordinal = chunk.ordinal;
                let job = review.job_id.clone();
                content = content.child(
                    Button::new(("bookmark-source-block", ordinal as usize))
                        .label(locale_format!(
                            cx,
                            "区間 {} の保存本文 {}–{} · {:?}",
                            "Source block {} · {}–{} · {:?}",
                            ordinal + 1,
                            policy::timestamp(chunk.request_start_ms),
                            policy::timestamp(chunk.request_end_ms),
                            chunk.source
                        ))
                        .disabled(frozen)
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.prepare(
                                PrepareSelection {
                                    job_id: job.clone(),
                                    cue_ids: None,
                                    ordinal: Some(ordinal),
                                },
                                cx,
                            )
                        })),
                );
            }
        }
        content = content.child(
            div()
                .text_size(px(21.))
                .child(localized(cx, "保存したブックマーク / Saved bookmarks")),
        );
        for bookmark in self.bookmarks.clone() {
            let id = bookmark.data.id.clone();
            content =
                content.child(
                    column()
                        .border_1()
                        .border_color(theme.border)
                        .p_3()
                        .child(format!(
                            "{}–{} · {} · {} · {}",
                            policy::timestamp(bookmark.data.start_ms),
                            policy::timestamp(bookmark.data.end_ms),
                            bookmark.data.origin,
                            bookmark.data.timing,
                            if bookmark.stale {
                                "source changed"
                            } else if bookmark.data.confirmed {
                                "confirmed"
                            } else {
                                "review needed"
                            }
                        ))
                        .child(bookmark.data.text.clone())
                        .child(
                            Button::new(format!("open-bookmark-{id}"))
                                .label(localized(cx, "本文・区間を確認 / Review text and interval"))
                                .disabled(frozen)
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.select(bookmark.clone(), cx)
                                })),
                        ),
                );
        }
        if let Some(selected) = &self.selected
            && let Some(form) = self.forms.get(selected)
        {
            content = content.child(form.clone());
        }
        if let Some(bookmark) = &self.detached {
            content = content.child(column().border_1().border_color(theme.border).p_4()
                .child(localized(cx, "復元されたブックマーク / Restored bookmark · original job unavailable"))
                .child(bookmark.data.text.clone())
                .child(format!("{}–{} · source {}–{} · {} · {}",policy::timestamp(bookmark.data.start_ms),policy::timestamp(bookmark.data.end_ms),policy::timestamp(bookmark.data.source_start_ms),policy::timestamp(bookmark.data.source_end_ms),bookmark.data.origin,bookmark.data.timing))
                .child(localized(cx, "保存した本文と出典をJSONで書き出せます。学習用の確認には受信済みの本文から新しく範囲を選んでください。 / Export this preserved text and provenance as JSON. Select a new received source before confirming it for study."))
                .child(row().child(Button::new("detached-json").label(localized(cx, "JSONを書き出す / Export JSON")).disabled(frozen).on_click(cx.listener(|this,_,_,cx|this.detached_action(false,cx))))
                .child(Button::new("detached-remove").label(localized(cx, "ブックマークを削除 / Remove bookmark")).disabled(frozen).on_click(cx.listener(|this,_,_,cx|this.detached_action(true,cx))))));
        }
        if let Some(error) = self.error.clone().or_else(|| self.store.error()) {
            content = content.child(error);
        }
        content = content.child(
            Button::new("close-draft-study")
                .label(localized(cx, "入力を残して閉じる / Close and keep input"))
                .on_click(|_, window, _| window.remove_window()),
        );
        super::super::keyboard::form_tab_navigation(div())
            .id("draft-study-scroll")
            .size_full()
            .overflow_y_scroll()
            .bg(theme.background)
            .text_color(theme.foreground)
            .child(content)
    }
}

struct SelectionEditor {
    session: Entity<Session>,
    editors: Entity<EditorRegistry>,
    store: Persistence,
    parent: WeakEntity<DraftStudyDialog>,
    generation: u64,
    lease: u64,
    bookmark: Bookmark,
    digest: String,
    start: Entity<InputState>,
    end: Entity<InputState>,
    text: Entity<TextareaState>,
    card_key: Option<EditorKey>,
    card_fields: BTreeMap<&'static str, Entity<TextareaState>>,
    model_form: Entity<ModelForm>,
    model_continuation: crate::application::continuations::AiContinuation,
    model_lease: u64,
    models_loading: bool,
    pending_models: Option<ModelValues>,
    delivered: BTreeMap<&'static str, String>,
    raw_id: String,
    expected: u64,
    force: bool,
    loading: bool,
    pending_raw: Option<policy::RawRow>,
    recovery: Vec<UiDraft>,
    quote: Option<Arc<AiQuote>>,
    candidates: Vec<Candidate>,
    acknowledged: bool,
    unpriced: bool,
    busy: bool,
    error: Option<String>,
    _subscriptions: Vec<Subscription>,
}
struct SelectionSource {
    bookmark: Bookmark,
    digest: String,
}
impl SelectionEditor {
    fn new(
        session: Entity<Session>,
        editors: Entity<EditorRegistry>,
        store: Persistence,
        parent: WeakEntity<DraftStudyDialog>,
        source: SelectionSource,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let SelectionSource { bookmark, digest } = source;
        let generation = store.generation();
        let start = cx.new(|cx| {
            InputState::new(window, cx).default_value(policy::timestamp(bookmark.data.start_ms))
        });
        let end = cx.new(|cx| {
            InputState::new(window, cx).default_value(policy::timestamp(bookmark.data.end_ms))
        });
        let text =
            cx.new(|cx| TextareaState::new(window, cx).default_value(bookmark.data.text.clone()));
        let mut subscriptions = vec![];
        let (provider, configuration) = session
            .read(cx)
            .snapshot
            .as_ref()
            .map(|s| {
                (
                    s.settings.active_provider,
                    s.settings.ai_configuration_generation,
                )
            })
            .unwrap_or_default();
        let model_continuation = crate::application::continuations::AiContinuation {
            provider,
            ai_configuration_generation: configuration,
            id: format!(
                "draft-models-{}-{}",
                bookmark.data.id, bookmark.data.version
            ),
            media_id: bookmark.data.media_id.clone(),
            kind: "vocabulary".into(),
            start: policy::timestamp(bookmark.data.start_ms),
            end: policy::timestamp(bookmark.data.end_ms),
            whole_media: false,
            focus_term: String::new(),
            models: Default::default(),
            model_inputs: Default::default(),
            preparation_id: None,
            quote_id: None,
            source_cue_ids: bookmark.data.cue_ids.clone(),
            source_revision: Some(format!(
                "draft-study:{}:{}",
                bookmark.data.id, bookmark.data.version
            )),
            source_media_signature: None,
            updated_at_ms: 0,
        };
        let model_lease = store.continuation_epoch(&model_continuation.id);
        let model_form = cx.new(|cx| {
            ModelForm::new(
                session.clone(),
                store.clone(),
                "vocabulary".into(),
                Default::default(),
                Default::default(),
                window,
                cx,
            )
        });
        subscriptions.push(
            cx.subscribe(&model_form, |this, _, value: &ModelValues, cx| {
                this.quote = None;
                this.model_continuation.models = value.models.clone();
                this.model_continuation.model_inputs = value.raw.clone();
                this.persist_models(cx);
            }),
        );
        let backend_models = session.read(cx).backend.clone();
        let state_models = backend_models.state.clone();
        let model_id = model_continuation.id.clone();
        let legacy_model_id = format!("draft-models-{}", bookmark.data.id);
        let model_binding = model_continuation.source_revision.clone();
        let read_epoch = store.continuation_read_epoch();
        run(
            &backend_models,
            cx,
            async move {
                Ok(
                    commands::continuations::list_ai_continuations(&state_models)?
                        .into_iter()
                        .find(|value| {
                            value.id == model_id
                                || (value.id == legacy_model_id
                                    && value.source_revision == model_binding)
                        }),
                )
            },
            move |this, result, _| {
                this.models_loading = false;
                if !this.store.continuation_read_current(read_epoch) {
                    return;
                }
                match result {
                    Ok(Some(mut value)) => {
                        this.model_lease = this.store.continuation_epoch(&value.id);
                        this.model_continuation.id = value.id.clone();
                        if (value.provider, value.ai_configuration_generation)
                            != (
                                this.model_continuation.provider,
                                this.model_continuation.ai_configuration_generation,
                            )
                        {
                            value.models.clear();
                            for raw in value.model_inputs.values_mut() {
                                raw.insert("enabled".into(), "false".into());
                            }
                        }
                        this.model_continuation.models = value.models.clone();
                        this.model_continuation.model_inputs = value.model_inputs.clone();
                        this.pending_models = Some(ModelValues {
                            models: value.models,
                            raw: value.model_inputs,
                        });
                    }
                    Ok(None) => {}
                    Err(error) => this.error = Some(error),
                }
            },
        );
        for input in [&start, &end] {
            subscriptions.push(cx.subscribe(input, |this, _, _: &InputEditsEvent, cx| {
                this.quote = None;
                this.persist(cx);
                cx.notify();
            }));
        }
        subscriptions.push(cx.subscribe(&text, |this, _, _: &InputEditsEvent, cx| {
            this.quote = None;
            this.persist(cx);
            cx.notify();
        }));
        let key = editors
            .update(cx, |registry, cx| {
                registry.ensure("draft_card", &bookmark.data.id, cx)
            })
            .ok();
        if let Some(key) = &key {
            editors.update(cx, |registry, cx| registry.refresh(key, cx));
        }
        let mut card_fields = BTreeMap::new();
        for name in ["term", "meaning", "translation", "explanation"] {
            let input = cx.new(|cx| TextareaState::new(window, cx));
            subscriptions.push(cx.subscribe(
                &input,
                move |this, _, event: &InputEditsEvent, cx| {
                    if let Some((_, text)) = event.edits().last() {
                        let value = text.to_string();
                        this.delivered.insert(name, value.clone());
                        this.quote = None;
                        if let Some(key) = this.card_key.clone() {
                            this.editors.update(cx, |registry, cx| {
                                registry.change(&key, [(name.into(), value)].into(), cx)
                            });
                        }
                    }
                },
            ));
            subscriptions.push(cx.subscribe(&input, |this, _, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Blur)
                    && let Some(key) = this.card_key.clone()
                {
                    this.editors
                        .update(cx, |registry, cx| registry.blur(&key, cx));
                }
            }));
            card_fields.insert(name, input);
        }
        subscriptions.push(cx.observe_in(&editors, window, |this, _, window, cx| {
            this.sync_card(window, cx);
            cx.notify();
        }));
        let target = format!("selection:{}", bookmark.data.id);
        let job = bookmark.data.job_id.clone().unwrap_or_default();
        let raw_id = surtitle_core::workspace::transcript_review_draft_id(
            &job,
            &digest,
            &target,
            bookmark.data.version,
        );
        let lease = store.raw_epoch(&raw_id);
        let backend = session.read(cx).backend.clone();
        let state = backend.state.clone();
        let id = raw_id.clone();
        run(
            &backend,
            cx,
            async move {
                let active = commands::ui_drafts::get_ui_draft(
                    &state,
                    "transcript_review".into(),
                    id.clone(),
                )?;
                let older = commands::ui_drafts::list_ui_drafts(&state)?
                    .into_iter()
                    .filter(|d| {
                        d.kind == "transcript_review"
                            && d.fields.get("jobId") == Some(&job)
                            && d.fields.get("target") == Some(&target)
                            && (d.entity_id != id || d.stale || d.archive_id.is_some())
                    })
                    .collect::<Vec<_>>();
                Ok((active, older))
            },
            |this, result, _| {
                this.loading = false;
                match result {
                    Ok((active, recovery)) => {
                        this.recovery = recovery;
                        if let Some(active) = active {
                            this.expected = active.revision;
                            if active.stale {
                                this.force = true;
                                this.recovery.push(active);
                            } else {
                                this.pending_raw = decode_row(&active.fields).ok();
                            }
                        }
                    }
                    Err(error) => this.error = Some(error),
                }
            },
        );
        let mut this = Self {
            session,
            editors,
            store,
            parent,
            generation,
            lease,
            bookmark,
            digest,
            start,
            end,
            text,
            card_key: key,
            card_fields,
            model_form,
            model_continuation,
            model_lease,
            models_loading: true,
            pending_models: None,
            delivered: BTreeMap::new(),
            raw_id,
            expected: 0,
            force: false,
            loading: true,
            pending_raw: None,
            recovery: vec![],
            quote: None,
            candidates: vec![],
            acknowledged: false,
            unpriced: false,
            busy: false,
            error: None,
            _subscriptions: subscriptions,
        };
        this.sync_card(window, cx);
        this.load_candidates(cx);
        this
    }
    fn frozen(&self, cx: &gpui_kit::App) -> bool {
        self.busy
            || self.loading
            || self.models_loading
            || self.store.frozen()
            || self.store.retired(self.generation)
            || self.store.raw_retired(&self.raw_id, self.lease)
            || self
                .store
                .continuation_retired(&self.model_continuation.id, self.model_lease)
            || self.editors.read(cx).frozen()
    }
    fn values(&self, cx: &gpui_kit::App) -> policy::RawRow {
        policy::RawRow {
            start: self.start.read(cx).value().to_string(),
            end: self.end.read(cx).value().to_string(),
            text: self.text.read(cx).value().to_string(),
        }
    }
    fn persist_models(&mut self, cx: &mut Context<Self>) {
        if self.models_loading
            || self.store.frozen()
            || self.store.retired(self.generation)
            || self
                .store
                .continuation_retired(&self.model_continuation.id, self.model_lease)
        {
            return;
        }
        if let Some(snapshot) = &self.session.read(cx).snapshot {
            self.model_continuation.provider = snapshot.settings.active_provider;
            self.model_continuation.ai_configuration_generation =
                snapshot.settings.ai_configuration_generation;
        }
        self.model_continuation.focus_term = self.card_fields["term"].read(cx).value().to_string();
        if let Err(error) = self
            .store
            .continuation(self.model_continuation.clone(), self.model_lease)
        {
            self.error = Some(error);
        }
    }
    fn dirty(&self, cx: &gpui_kit::App) -> bool {
        let raw = self.values(cx);
        raw.text != self.bookmark.data.text
            || policy::parse_time(&raw.start) != Some(self.bookmark.data.start_ms)
            || policy::parse_time(&raw.end) != Some(self.bookmark.data.end_ms)
    }
    fn confirmed(&self, cx: &gpui_kit::App) -> bool {
        self.bookmark.data.confirmed && !self.bookmark.stale && !self.dirty(cx)
    }
    fn persist(&mut self, cx: &mut Context<Self>) {
        if self.frozen(cx) {
            return;
        }
        let fields = [
            (
                "jobId".into(),
                self.bookmark.data.job_id.clone().unwrap_or_default(),
            ),
            ("draftDigest".into(), self.digest.clone()),
            (
                "target".into(),
                format!("selection:{}", self.bookmark.data.id),
            ),
            (
                "rangeVersion".into(),
                self.bookmark.data.version.to_string(),
            ),
            (
                "rows".into(),
                serde_json::to_string(&vec![self.values(cx)]).unwrap(),
            ),
            ("confirmedNoSpeech".into(), "false".into()),
        ]
        .into();
        match self.store.raw(RawInput {
            id: self.raw_id.clone(),
            expected_revision: self.expected,
            fields,
            force: self.force,
            lease: self.lease,
        }) {
            Ok(()) => self.force = false,
            Err(error) => self.error = Some(error),
        }
    }
    fn sync_card(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(key) = self.card_key.clone()
            && self.store.take_card_recovery(&self.bookmark.data.id)
        {
            self.editors
                .update(cx, |registry, cx| registry.recover(&key, cx));
        }
        let Some(view) = self
            .card_key
            .as_ref()
            .and_then(|key| self.editors.read(cx).view(key))
        else {
            return;
        };
        let fields = view.fields.clone();
        for (name, input) in &self.card_fields {
            let value = fields.get(*name).cloned().unwrap_or_default();
            let current = input.read(cx).value().to_string();
            if current == self.delivered.get(name).cloned().unwrap_or_default() && current != value
            {
                input.update(cx, |input, cx| input.set_value(value.clone(), window, cx));
                self.delivered.insert(name, value);
            }
        }
    }
    fn perform<T: Send + 'static>(
        &mut self,
        cx: &mut Context<Self>,
        future: impl Future<Output = Result<T, String>> + Send + 'static,
        done: impl FnOnce(&mut Self, T, &mut Context<Self>) + 'static,
    ) {
        if self.frozen(cx) {
            return;
        }
        let guard = match self.store.operation() {
            Ok(g) => g,
            Err(e) => {
                self.error = Some(e);
                return;
            }
        };
        let drain = self.store.drain_inputs();
        self.busy = true;
        let backend = self.session.read(cx).backend.clone();
        run(
            &backend,
            cx,
            async move {
                let _guard = guard;
                drain.await?;
                future.await
            },
            move |this, result, cx| {
                this.busy = false;
                match result {
                    Ok(value) => {
                        this.error = None;
                        done(this, value, cx);
                    }
                    Err(error) => this.error = Some(error),
                }
            },
        );
    }
    fn save(&mut self, confirm: bool, cx: &mut Context<Self>) {
        let raw = self.values(cx);
        let (Some(start), Some(end)) =
            (policy::parse_time(&raw.start), policy::parse_time(&raw.end))
        else {
            self.error = Some("Enter complete excerpt timestamps".into());
            return;
        };
        if start < self.bookmark.data.source_start_ms
            || end > self.bookmark.data.source_end_ms
            || start >= end
            || raw.text.len() > 16000
            || (confirm && (!self.bookmark.can_confirm || raw.text.trim().is_empty()))
        {
            self.error =
                Some("Review text and an interval inside the original source bounds".into());
            return;
        }
        self.persist(cx);
        let backend = self.session.read(cx).backend.clone();
        let state = backend.state.clone();
        let request = UpdateSelection {
            id: self.bookmark.data.id.clone(),
            version: self.bookmark.data.version,
            text: raw.text,
            start_ms: start,
            end_ms: end,
            confirm,
        };
        self.perform(
            cx,
            async move {
                Bookmark::from(
                    commands::transcript_study::update_draft_selection(&state, request).await?,
                )
            },
            |this, bookmark, cx| {
                let _ = this
                    .parent
                    .update(cx, |parent, cx| parent.adopt(bookmark, cx));
            },
        );
    }
    fn load_candidates(&mut self, cx: &mut Context<Self>) {
        if !self.bookmark.data.confirmed || self.bookmark.stale {
            return;
        }
        let backend = self.session.read(cx).backend.clone();
        let state = backend.state.clone();
        let request = SelectionVersion {
            id: self.bookmark.data.id.clone(),
            version: self.bookmark.data.version,
        };
        run(
            &backend,
            cx,
            async move {
                commands::transcript_study::list_draft_selection_candidates(&state, request)
                    .await?
                    .into_iter()
                    .map(|value| {
                        serde_json::from_value::<Candidate>(value)
                            .map_err(|error| error.to_string())
                    })
                    .collect::<Result<Vec<_>, _>>()
            },
            |this, result, _| match result {
                Ok(values) => this.candidates = values,
                Err(error) => this.error = Some(error),
            },
        );
    }
    fn save_card(&mut self, cx: &mut Context<Self>) {
        if !self.confirmed(cx) {
            return;
        }
        let Some(key) = self.card_key.clone() else {
            return;
        };
        let Some(view) = self.editors.read(cx).view(&key) else {
            return;
        };
        if !view.ready {
            return;
        }
        let f = &view.fields;
        let term = f.get("term").cloned().unwrap_or_default();
        let meaning = f.get("meaning").cloned().unwrap_or_default();
        if term.trim().is_empty() || meaning.trim().is_empty() {
            self.error = Some("Enter both a phrase and its meaning".into());
            return;
        }
        let request = SelectionCard {
            selection_id: self.bookmark.data.id.clone(),
            version: self.bookmark.data.version,
            term: term.trim().into(),
            meaning: meaning.trim().into(),
            explanation: f
                .get("explanation")
                .filter(|s| !s.trim().is_empty())
                .cloned(),
            translation: f
                .get("translation")
                .filter(|s| !s.trim().is_empty())
                .cloned(),
        };
        let flush = self.editors.update(cx, |registry, cx| {
            registry.flush_all(FlushPurpose::Save, cx)
        });
        let backend = self.session.read(cx).backend.clone();
        let state = backend.state.clone();
        let operation = Some(format!("local:{}", uuid::Uuid::new_v4()));
        self.perform(
            cx,
            async move {
                flush.await?;
                commands::transcript_study::save_draft_selection_card(&state, request, operation)
                    .await
            },
            move |this, _, cx| {
                this.editors
                    .update(cx, |registry, cx| registry.complete_submission(&key, cx));
                this.error = Some(localized(
                    cx,
                    "カードと選択範囲の音声を保存しました。 / Saved the card and excerpt audio.",
                ));
                this.session.update(cx, |session, cx| session.refresh(cx));
            },
        );
    }
    fn estimate(&mut self, cx: &mut Context<Self>) {
        if !self.confirmed(cx) {
            return;
        }
        let term = self.card_fields["term"].read(cx).value().to_string();
        let Some(snapshot) = &self.session.read(cx).snapshot else {
            return;
        };
        let provider = snapshot.settings.active_provider;
        let generation = snapshot.settings.ai_configuration_generation;
        let purpose = if term.trim().is_empty() {
            "vocabulary"
        } else {
            "explanation"
        };
        let model = match self.model_form.read(cx).selected(cx) {
            Ok(model) => model,
            Err(error) => {
                self.error = Some(error);
                return;
            }
        };
        self.model_continuation
            .models
            .insert(purpose.into(), model.clone());
        self.persist_models(cx);
        let request = SelectionQuote {
            provider: Some(provider),
            ai_configuration_generation: Some(generation),
            selection_id: self.bookmark.data.id.clone(),
            version: self.bookmark.data.version,
            focus_term: (!term.trim().is_empty()).then(|| term.trim().into()),
            model,
        };
        let backend = self.session.read(cx).backend.clone();
        let state = backend.state.clone();
        self.perform(
            cx,
            async move {
                commands::transcript_study::create_draft_selection_quote(&state, request).await
            },
            |this, quote, cx| {
                this.model_continuation.quote_id = Some(quote.id.clone());
                this.persist_models(cx);
                this.quote = Some(Arc::new(quote));
                this.acknowledged = false;
                this.unpriced = false;
            },
        );
    }
    fn approve(&mut self, cx: &mut Context<Self>) {
        if !self.confirmed(cx) {
            return;
        }
        let Some(quote) = self.quote.clone() else {
            return;
        };
        let Some(snapshot) = &self.session.read(cx).snapshot else {
            return;
        };
        if let Some(error) = policy::approval_error(
            &quote,
            snapshot.settings.active_provider,
            snapshot.settings.ai_configuration_generation,
            chrono::Utc::now().timestamp_millis(),
        ) {
            self.error = Some(error);
            return;
        }
        if !self.acknowledged || ((quote.unpriced || quote.maximum_usd.is_none()) && !self.unpriced)
        {
            return;
        }
        let backend = self.session.read(cx).backend.clone();
        let state = backend.state.clone();
        let unpriced = self.unpriced;
        self.perform(
            cx,
            async move {
                commands::ai::approve_quote(
                    &state,
                    quote.id.clone(),
                    quote.digest.clone(),
                    unpriced,
                    true,
                    quote.retry_policy.as_ref().map(|p| p.version),
                    Some(quote.ai_configuration_generation),
                )
                .await
            },
            |this, _, cx| {
                this.quote = None;
                this.session.update(cx, |session, cx| session.refresh(cx));
                this.load_candidates(cx);
            },
        );
    }
    fn export(&mut self, format: &str, cx: &mut Context<Self>) {
        let request = ExportSelection {
            id: self.bookmark.data.id.clone(),
            version: self.bookmark.data.version,
            format: format.into(),
        };
        let backend = self.session.read(cx).backend.clone();
        let state = backend.state.clone();
        self.perform(cx,async move{commands::transcript_study::export_draft_selection(&state,request).await},|this,exported,cx|if exported{this.error=Some(localized(cx, "選択範囲だけを書き出しました。字幕全体の採用を示すものではありません。 / Exported this excerpt only, without adopting the whole transcript."));});
    }
    fn remove(&mut self, cx: &mut Context<Self>) {
        let request = SelectionVersion {
            id: self.bookmark.data.id.clone(),
            version: self.bookmark.data.version,
        };
        let backend = self.session.read(cx).backend.clone();
        let state = backend.state.clone();
        self.perform(
            cx,
            async move { commands::transcript_study::remove_draft_selection(&state, request) },
            |this, _, cx| {
                let _ = this.parent.update(cx, |parent, cx| {
                    parent.selected = None;
                    parent.refresh(cx);
                });
            },
        );
    }
    fn play(&mut self, cx: &mut Context<Self>) {
        let raw = self.values(cx);
        let (Some(start), Some(end)) =
            (policy::parse_time(&raw.start), policy::parse_time(&raw.end))
        else {
            return;
        };
        let backend = self.session.read(cx).backend.clone();
        let state = backend.state.clone();
        let host = backend.host.clone();
        let media = self.bookmark.data.media_id.clone();
        self.perform(
            cx,
            async move {
                commands::playback::load_media(host.clone(), &state, media).await?;
                let deadline = std::time::Instant::now() + Duration::from_secs(15);
                loop {
                    let player = commands::playback::get_player_state(&state)?;
                    if let Some(error) = player.error {
                        return Err(error);
                    }
                    if player.ready {
                        break;
                    }
                    if std::time::Instant::now() >= deadline {
                        return Err("The player did not become ready".into());
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
                commands::playback::player_control(
                    host,
                    &state,
                    crate::player::Control {
                        action: "seek".into(),
                        value: None,
                        start_ms: Some(start),
                        end_ms: Some(end),
                        bounds: None,
                        track_kind: None,
                    },
                )
                .await
            },
            |_, _, _| {},
        );
    }
}
fn decode_row(fields: &BTreeMap<String, String>) -> Result<policy::RawRow, String> {
    let mut rows: Vec<policy::RawRow> =
        serde_json::from_str(fields.get("rows").ok_or("Raw excerpt input missing")?)
            .map_err(|e| e.to_string())?;
    if rows.len() != 1 {
        return Err("An excerpt has one text interval".into());
    }
    Ok(rows.remove(0))
}
impl Render for SelectionEditor {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if let Some(values) = self.pending_models.take() {
            self.model_form
                .update(cx, |form, cx| form.restore(values.models, values.raw, cx));
        }
        if let Some(raw) = self.pending_raw.take() {
            self.start
                .update(cx, |input, cx| input.set_value(raw.start, window, cx));
            self.end
                .update(cx, |input, cx| input.set_value(raw.end, window, cx));
            self.text
                .update(cx, |input, cx| input.set_value(raw.text, window, cx));
        }
        let theme = cx.theme().clone();
        let frozen = self.frozen(cx);
        let confirmed = self.confirmed(cx);
        let purpose = if self.card_fields["term"].read(cx).value().trim().is_empty() {
            "vocabulary"
        } else {
            "explanation"
        };
        self.model_form.update(cx, |form, cx| {
            form.set_purpose(purpose, cx);
            form.set_disabled(frozen || self.models_loading, cx);
        });
        let model_form = self.model_form.clone();
        let mut content = column()
            .p_4()
            .border_1()
            .border_color(theme.border)
            .child(
                div()
                    .text_size(px(22.))
                    .child(localized(cx, "この表現を確認 / Check this excerpt")),
            )
            .child(format!(
                "Origin {} · timing {} · job {} · source {}–{} · version {} · confirmed {}",
                self.bookmark.data.origin,
                self.bookmark.data.timing,
                self.bookmark.data.job_id.as_deref().unwrap_or("detached"),
                policy::timestamp(self.bookmark.data.source_start_ms),
                policy::timestamp(self.bookmark.data.source_end_ms),
                self.bookmark.data.version,
                confirmed
            ))
            .child(format!(
                "Source cue IDs {} · review digest {}",
                self.bookmark.data.cue_ids.join(", "),
                self.digest
            ));
        for reason in &self.bookmark.reasons {
            content = content.child(reason.clone());
        }
        content=content.child(row().child(Input::new(&self.start).aria_label(localized(cx, "ブックマークの再生開始時刻 / Bookmark replay start time")).disabled(frozen||self.bookmark.stale).w(px(200.))).child(Input::new(&self.end).aria_label(localized(cx, "ブックマークの再生終了時刻 / Bookmark replay end time")).disabled(frozen||self.bookmark.stale).w(px(200.))).child(Button::new("play-bookmark").label(localized(cx, "原音 / Play original audio")).disabled(frozen).on_click(cx.listener(|this,_,_,cx|this.play(cx))))).child(Textarea::new(&self.text).aria_label(localized(cx, "ブックマークの本文 / Bookmark excerpt text")).disabled(frozen||self.bookmark.stale).h(px(135.))).child(row().child(Button::new("save-bookmark").label(localized(cx, "未確認のまま保存 / Save unconfirmed bookmark")).disabled(frozen||self.bookmark.stale).on_click(cx.listener(|this,_,_,cx|this.save(false,cx)))).child(Button::new("confirm-bookmark").primary().label(localized(cx, "本文と再生区間を学習用に確認 / Confirm text and replay interval for learning")).disabled(frozen||!self.bookmark.can_confirm||self.bookmark.stale).on_click(cx.listener(|this,_,_,cx|this.save(true,cx)))));
        for (index, draft) in self.recovery.iter().enumerate() {
            let fields = draft.fields.clone();
            content = content.child(
                Button::new(("recover-bookmark-input", index))
                    .label(locale_format!(
                        cx,
                        "前の入力を現在の確認欄へコピー · {}",
                        "Recover earlier raw input · {}",
                        draft.updated_at
                    ))
                    .disabled(frozen)
                    .on_click(
                        cx.listener(move |this, _, window, cx| match decode_row(&fields) {
                            Ok(raw) => {
                                this.start
                                    .update(cx, |input, cx| input.set_value(raw.start, window, cx));
                                this.end
                                    .update(cx, |input, cx| input.set_value(raw.end, window, cx));
                                this.text
                                    .update(cx, |input, cx| input.set_value(raw.text, window, cx));
                                this.force = true;
                                this.persist(cx);
                                cx.notify();
                            }
                            Err(error) => this.error = Some(error),
                        }),
                    ),
            );
        }
        content = content.child(div().text_size(px(19.)).child(localized(
            cx,
            "フレーズ・意味・音声を保存 / Phrase, meaning and audio",
        )));
        let ready = self
            .card_key
            .as_ref()
            .and_then(|key| self.editors.read(cx).view(key))
            .is_some_and(|view| view.ready);
        for (name, input) in &self.card_fields {
            let label = match *name {
                "term" => localized(
                    cx,
                    "覚える・解説する表現（空欄なら語彙提案） / Phrase to learn or explain",
                ),
                "meaning" => localized(cx, "意味 / Meaning"),
                "translation" => localized(cx, "訳 / Translation"),
                _ => localized(cx, "解説・メモ / Explanation or notes"),
            };
            content = content.child(
                column().child(label.clone()).child(
                    Textarea::new(input)
                        .aria_label(locale_format!(
                            cx,
                            "ブックマークのカード · {}",
                            "Bookmark card · {}",
                            label
                        ))
                        .disabled(frozen || !ready)
                        .h(px(if *name == "term" { 56. } else { 86. })),
                ),
            );
        }
        if let Some(view) = self
            .card_key
            .as_ref()
            .and_then(|key| self.editors.read(cx).view(key))
        {
            if let Some(recovery) = &view.recovery {
                content = content
                    .child(locale_format!(
                        cx,
                        "選択区間が変わった入力: {}",
                        "Input from an earlier selection: {}",
                        recovery.values().cloned().collect::<Vec<_>>().join("\n")
                    ))
                    .child(
                        Button::new("recover-bookmark-card")
                            .label(localized(
                                cx,
                                "前のカード入力から続ける / Continue previous card input",
                            ))
                            .disabled(frozen)
                            .on_click(cx.listener(|this, _, _, cx| {
                                if let Some(key) = this.card_key.clone() {
                                    this.editors
                                        .update(cx, |registry, cx| registry.recover(&key, cx));
                                }
                            })),
                    );
            }
            if let Some(error) = &view.error {
                content = content.child(error.clone());
            }
        }
        content=content.child(model_form).child(row().child(Button::new("save-bookmark-card").primary().label(localized(cx, "カードと選択範囲の音声を保存 / Save card and excerpt audio")).disabled(frozen||!confirmed||!ready).on_click(cx.listener(|this,_,_,cx|this.save_card(cx)))).child(Button::new("estimate-bookmark-ai").label(localized(cx, "この確認済み本文の語彙・解説を見積もる / Estimate vocabulary or explanation for confirmed text")).disabled(frozen||!confirmed).on_click(cx.listener(|this,_,_,cx|this.estimate(cx)))).child(Button::new("refresh-bookmark-candidates").label(localized(cx, "保存済み提案を再読込 / Refresh received suggestions")).disabled(frozen||!confirmed).on_click(cx.listener(|this,_,_,cx|this.load_candidates(cx)))));
        for (index, candidate) in self.candidates.iter().cloned().enumerate() {
            content = content.child(
                column()
                    .child(format!("{} · {}", candidate.term, candidate.meaning))
                    .child(candidate.explanation.clone().unwrap_or_default())
                    .child(
                        Button::new(("use-bookmark-candidate", index))
                            .label(localized(
                                cx,
                                "提案をカード編集欄へコピー / Copy suggestion into card fields",
                            ))
                            .disabled(frozen || !confirmed)
                            .on_click(cx.listener(move |this, _, _, cx| {
                                if let Some(key) = this.card_key.clone() {
                                    this.editors.update(cx, |registry, cx| {
                                        registry.change(
                                            &key,
                                            [
                                                ("term".into(), candidate.term.clone()),
                                                ("meaning".into(), candidate.meaning.clone()),
                                                (
                                                    "translation".into(),
                                                    candidate
                                                        .translation
                                                        .clone()
                                                        .unwrap_or_default(),
                                                ),
                                                (
                                                    "explanation".into(),
                                                    candidate
                                                        .explanation
                                                        .clone()
                                                        .unwrap_or_default(),
                                                ),
                                            ]
                                            .into(),
                                            cx,
                                        )
                                    });
                                }
                            })),
                    ),
            );
        }
        if let Some(quote) = &self.quote {
            let settings = self.session.read(cx).snapshot.as_ref().map(|s| &s.settings);
            let block = settings.and_then(|s| {
                policy::approval_error(
                    quote,
                    s.active_provider,
                    s.ai_configuration_generation,
                    chrono::Utc::now().timestamp_millis(),
                )
            });
            content = content.child(quote_content(quote, cx));
            if let Some(reason) = &block {
                content = content.child(reason.clone());
            }
            content = content.child(
                Button::new("bookmark-ack-quote")
                    .label(if self.acknowledged {
                        localized(
                            cx,
                            "✓ 範囲・費用・上限・再試行を確認 / Scope and limits reviewed",
                        )
                    } else {
                        localized(
                            cx,
                            "□ 範囲・費用・上限・再試行を確認 / Review scope and limits",
                        )
                    })
                    .disabled(frozen)
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.acknowledged = !this.acknowledged;
                        cx.notify();
                    })),
            );
            if quote.unpriced || quote.maximum_usd.is_none() {
                content = content.child(
                    Button::new("bookmark-ack-unpriced")
                        .label(if self.unpriced {
                            localized(cx, "✓ 料金不明を承知 / Unknown price acknowledged")
                        } else {
                            localized(
                                cx,
                                "□ 料金不明・上限保証なしを承知 / Acknowledge unknown price",
                            )
                        })
                        .disabled(frozen)
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.unpriced = !this.unpriced;
                            cx.notify();
                        })),
                );
            }
            content = content.child(
                Button::new("bookmark-approve-ai")
                    .primary()
                    .label(localized(
                        cx,
                        "表示した見積もりを承認して開始 / Approve displayed estimate and start",
                    ))
                    .disabled(
                        frozen
                            || !confirmed
                            || block.is_some()
                            || !self.acknowledged
                            || ((quote.unpriced || quote.maximum_usd.is_none()) && !self.unpriced),
                    )
                    .on_click(cx.listener(|this, _, _, cx| this.approve(cx))),
            );
        }
        let mut exports = row();
        for format in ["json", "srt", "vtt"] {
            exports = exports.child(
                Button::new(format!("export-bookmark-{format}"))
                    .label(locale_format!(
                        cx,
                        "選択範囲だけを書出し {format}",
                        "Export excerpt {format}"
                    ))
                    .disabled(frozen || self.dirty(cx) || (format != "json" && !confirmed))
                    .on_click(cx.listener(move |this, _, _, cx| this.export(format, cx))),
            );
        }
        content = content.child(exports).child(
            Button::new("remove-bookmark")
                .label(localized(
                    cx,
                    "このブックマークを削除 / Remove this bookmark",
                ))
                .disabled(frozen)
                .on_click(cx.listener(|this, _, _, cx| this.remove(cx))),
        );
        if let Some(error) = self.error.clone().or_else(|| self.store.error()) {
            content = content.child(error);
        }
        content
    }
}
