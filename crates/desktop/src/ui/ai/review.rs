use super::{locale_format, localized};
use gpui_kit::base::Disableable;
// SPDX-License-Identifier: GPL-3.0-or-later
use super::{
    AiIntent, AiKind, AiView,
    manual::{Binding, ManualForm},
    persistence::Persistence,
    policy, quote_content,
};
use crate::{
    application::{
        ai::{AiQuote, SavedAiResult, VocabularyCandidate},
        transcript::TranscriptReview,
    },
    commands,
    ui::{
        session::{Session, UiEvent, run},
        style::{column, row},
    },
};
use gpui_kit::component::{
    ActiveTheme,
    button::{Button, ButtonVariants},
    input::{Textarea, TextareaState},
};
use gpui_kit::{
    AppContext, Context, Entity, Subscription, WeakEntity, Window, div, prelude::*, px,
    uniform_list,
};
use std::{collections::BTreeMap, future::Future, sync::Arc, time::Duration};
use surtitle_ai::{BoundaryChoice, TranscriptRangeSelection, TranscriptResultReview};
struct Loaded {
    quote: AiQuote,
    saved: Vec<SavedAiResult>,
    candidates: Vec<BoundCandidate>,
    review: Option<TranscriptReview>,
    review_error: Option<String>,
    runtime: Option<crate::application::ai::runtime::RuntimeSnapshot>,
}
struct BoundCandidate {
    value: Arc<VocabularyCandidate>,
    cues: Vec<surtitle_core::SubtitleSegment>,
    media_signature: String,
}
impl std::ops::Deref for BoundCandidate {
    type Target = VocabularyCandidate;
    fn deref(&self) -> &Self::Target {
        &self.value
    }
}
pub(super) struct ReviewDialog {
    session: Entity<Session>,
    store: Persistence,
    generation: u64,
    owner: WeakEntity<AiView>,
    job: String,
    quote: Option<Arc<AiQuote>>,
    saved: Vec<SavedAiResult>,
    candidates: Vec<BoundCandidate>,
    review: Option<Arc<TranscriptReview>>,
    runtime: Option<crate::application::ai::runtime::RuntimeSnapshot>,
    details: BTreeMap<u32, TranscriptResultReview>,
    evidence: Option<Entity<TextareaState>>,
    pending_evidence: Option<String>,
    forms: BTreeMap<String, Entity<ManualForm>>,
    selected: Option<String>,
    recovery_target: Option<String>,
    busy: bool,
    loading: bool,
    error: Option<String>,
    acknowledged: bool,
    unpriced: bool,
    _subscriptions: Vec<Subscription>,
}
impl ReviewDialog {
    pub fn open_raw(&mut self, draft: &surtitle_core::workspace::UiDraft, cx: &mut Context<Self>) {
        self.recovery_target = draft.fields.get("target").cloned();
        cx.notify();
    }
    pub fn retire_raw(&mut self, id: &str, cx: &mut Context<Self>) {
        self.forms.remove(id);
        if self.selected.as_deref() == Some(id) {
            self.selected = None;
        }
        self.notify_forms(cx);
    }
    pub fn notify_forms(&self, cx: &mut Context<Self>) {
        for form in self.forms.values() {
            form.update(cx, |_, cx| cx.notify());
        }
        cx.notify();
    }
    pub fn new(
        session: Entity<Session>,
        store: Persistence,
        owner: WeakEntity<AiView>,
        job: String,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let generation = store.generation();
        let observed = cx.observe(&session, |_, _, cx| cx.notify());
        let changed=cx.subscribe(&session,|this,_,event:&UiEvent,cx|if matches!(event,UiEvent::Changed(change) if change.domain==crate::application::changes::ChangeDomain::Review && change.entity_id.as_deref()==Some(this.job.as_str())){this.refresh(cx);});
        cx.spawn(async move |view, cx| {
            loop {
                cx.background_executor().timer(Duration::from_secs(1)).await;
                if view.update(cx, |_, cx| cx.notify()).is_err() {
                    break;
                }
            }
        })
        .detach();
        Self {
            session,
            store,
            generation,
            owner,
            job,
            quote: None,
            saved: vec![],
            candidates: vec![],
            review: None,
            runtime: None,
            details: BTreeMap::new(),
            evidence: None,
            pending_evidence: None,
            forms: BTreeMap::new(),
            selected: None,
            recovery_target: None,
            busy: false,
            loading: false,
            error: None,
            acknowledged: false,
            unpriced: false,
            _subscriptions: vec![observed, changed],
        }
    }
    pub fn refresh(&mut self, cx: &mut Context<Self>) {
        if self.loading || self.busy || self.store.retired(self.generation) {
            return;
        }
        self.loading = true;
        let backend = self.session.read(cx).backend.clone();
        let state = backend.state.clone();
        let job = self.job.clone();
        run(
            &backend,
            cx,
            async move {
                let quote = commands::ai::review_ai_job(&state, job.clone())?;
                let saved = commands::ai::list_saved_ai_results(&state, job.clone())?;
                let before = commands::synchronization::get_change_checkpoint(&state)?;
                let snapshot = commands::ai::get_app_snapshot(&state)?;
                let media = snapshot
                    .media
                    .iter()
                    .find(|media| media.id == quote.media_id)
                    .ok_or_else(|| "The source media is missing".to_string())?;
                let media_signature = serde_json::to_string(&(
                    &media.path,
                    media.audio_stream_index,
                    &media.learning_language,
                    &media.explanation_language,
                ))
                .map_err(|error| error.to_string())?;
                let source = commands::subtitles::list_segments(&state, quote.media_id.clone())?;
                let candidates =
                    commands::ai::list_vocabulary_candidates(&state, quote.media_id.clone())?;
                if before != commands::synchronization::get_change_checkpoint(&state)? {
                    return Err(
                        "Source data changed while reading candidates; refresh before saving"
                            .into(),
                    );
                }
                let candidates = candidates
                    .into_iter()
                    .map(|candidate| {
                        let ids = if candidate.source_cue_ids.is_empty() {
                            vec![candidate.segment_id.clone()]
                        } else {
                            candidate.source_cue_ids.clone()
                        };
                        let cues =
                            ids.iter()
                                .map(|id| {
                                    source.iter().find(|cue| &cue.id == id).cloned().ok_or_else(
                                        || {
                                            "Candidate source is missing; refresh results"
                                                .to_string()
                                        },
                                    )
                                })
                                .collect::<Result<Vec<_>, _>>()?;
                        Ok(BoundCandidate {
                            value: Arc::new(candidate),
                            cues,
                            media_signature: media_signature.clone(),
                        })
                    })
                    .collect::<Result<Vec<_>, String>>()?;
                let runtime = commands::ai::get_ai_runtime(&state, job.clone())?;
                let (review, review_error) = if quote.kind == "transcribe" {
                    match commands::transcript::get_transcript_review(&state, job).await {
                        Ok(review) => (Some(review), None),
                        Err(error) => (None, Some(error)),
                    }
                } else {
                    (None, None)
                };
                Ok(Loaded {
                    quote,
                    saved,
                    candidates,
                    review,
                    review_error,
                    runtime,
                })
            },
            |this, result, _| {
                this.loading = false;
                match result {
                    Ok(loaded) => {
                        this.quote = Some(Arc::new(loaded.quote));
                        this.saved = loaded.saved;
                        this.candidates = loaded.candidates;
                        this.review = loaded.review.map(Arc::new);
                        this.runtime = loaded.runtime;
                        this.error = loaded.review_error;
                        this.acknowledged = false;
                        this.unpriced = false;
                    }
                    Err(error) => this.error = Some(error),
                }
            },
        );
    }
    pub fn adopt(&mut self, review: TranscriptReview, cx: &mut Context<Self>) {
        self.review = Some(Arc::new(review));
        self.session.update(cx, |session, cx| session.refresh(cx));
        cx.notify();
    }
    fn perform<T: Send + 'static>(
        &mut self,
        cx: &mut Context<Self>,
        future: impl Future<Output = Result<T, String>> + Send + 'static,
        apply: impl FnOnce(&mut Self, T, &mut Context<Self>) + 'static,
    ) {
        if self.busy || (self.store.frozen() || self.store.retired(self.generation)) {
            return;
        }
        let guard = match self.store.operation() {
            Ok(guard) => guard,
            Err(error) => {
                self.error = Some(error);
                return;
            }
        };
        let drain = self.store.drain_inputs();
        self.busy = true;
        self.error = None;
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
                    Ok(value) => apply(this, value, cx),
                    Err(error) => this.error = Some(error),
                }
                this.session.update(cx, |session, cx| session.refresh(cx));
            },
        );
    }
    fn job_action(&mut self, action: &str, cx: &mut Context<Self>) {
        let backend = self.session.read(cx).backend.clone();
        let state = backend.state.clone();
        let job = self.job.clone();
        match action {
            "pause" => self.perform(
                cx,
                async move { commands::ai::pause_ai_job(&state, job) },
                |this, _, cx| this.refresh(cx),
            ),
            "cancel" => self.perform(
                cx,
                async move { commands::ai::cancel_ai_job(&state, job) },
                |this, _, cx| this.refresh(cx),
            ),
            "retry-local" => self.perform(
                cx,
                async move { commands::ai::retry_ai_application(&state, job) },
                |this, _, cx| this.refresh(cx),
            ),
            "retry-quote" => self.perform(
                cx,
                async move { commands::ai::create_retry_quote(&state, job) },
                |this, quote, _| {
                    this.quote = Some(Arc::new(quote));
                    this.acknowledged = false;
                    this.unpriced = false;
                },
            ),
            _ => {}
        }
    }
    fn approve(&mut self, cx: &mut Context<Self>) {
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
                if quote.is_retry {
                    commands::ai::reapprove_quote(
                        &state,
                        quote.id.clone(),
                        quote.digest.clone(),
                        unpriced,
                        true,
                        quote.retry_policy.as_ref().map(|p| p.version),
                        Some(quote.ai_configuration_generation),
                    )
                    .await
                } else {
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
                }
            },
            |this, _, cx| this.refresh(cx),
        );
    }
    fn apply_saved(&mut self, ordinal: u32, cx: &mut Context<Self>) {
        let backend = self.session.read(cx).backend.clone();
        let state = backend.state.clone();
        let job = self.job.clone();
        self.perform(
            cx,
            async move { commands::ai::apply_saved_ai_result(&state, job, ordinal) },
            |this, _, cx| this.refresh(cx),
        );
    }
    fn save_candidate(&mut self, index: usize, cx: &mut Context<Self>) {
        if self.busy || self.store.frozen() || self.store.retired(self.generation) {
            return;
        }
        let Some(c) = self.candidates.get(index) else {
            return;
        };
        let candidate = c.value.as_ref().clone();
        let cues = c.cues.clone();
        let signature = c.media_signature.clone();
        let receiver = self.session.update(cx, |session, cx| {
            session.prepare_candidate(candidate, cues, signature, cx)
        });
        self.busy = true;
        self.error = None;
        let generation = self.generation;
        // Root owns the combined source-writer gate; counting this receiver as
        // an in-flight domain operation would make that gate await itself.
        cx.spawn(async move |view, cx| {
            let result = receiver
                .await
                .unwrap_or_else(|_| Err("Candidate preparation stopped".into()));
            let _ = view.update(cx, |this, cx| {
                this.busy = false;
                if this.store.retired(generation) {
                    return;
                }
                match result {
                    Ok(draft) => this
                        .session
                        .update(cx, |session, cx| session.open_source_draft(draft, cx)),
                    Err(error) => this.error = Some(error),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    fn update_review(&mut self, action: ReviewAction, cx: &mut Context<Self>) {
        let Some(review) = self.review.clone() else {
            return;
        };
        let backend = self.session.read(cx).backend.clone();
        let state = backend.state.clone();
        let host = backend.host.clone();
        let job = self.job.clone();
        let digest = review.draft.digest.clone();
        match action {
            ReviewAction::Apply => {
                self.perform(
                    cx,
                    async move {
                        commands::transcript::apply_transcript_review(&state, job, digest).await
                    },
                    |this, value, cx| this.adopt(value, cx),
                )
            }
            ReviewAction::Warning(id) => self.perform(
                cx,
                async move {
                    commands::transcript::acknowledge_transcript_warning(&state, job, digest, id)
                        .await
                },
                |this, value, cx| this.adopt(value, cx),
            ),
            ReviewAction::Boundary(id, choice) => self.perform(
                cx,
                async move {
                    commands::transcript::resolve_transcript_boundary(
                        &state, job, digest, id, choice,
                    )
                    .await
                },
                |this, value, cx| this.adopt(value, cx),
            ),
            ReviewAction::Select(ordinal, version, source) => self.perform(
                cx,
                async move {
                    commands::transcript::select_transcript_range_source(
                        &state, job, digest, ordinal, version, source,
                    )
                    .await
                },
                |this, value, cx| this.adopt(value, cx),
            ),
            ReviewAction::Reparse(ordinal, evidence) => self.perform(
                cx,
                async move {
                    commands::transcript::reparse_transcript_evidence(
                        &state, job, ordinal, evidence,
                    )
                    .await
                },
                move |this, value, cx| {
                    this.adopt(value, cx);
                    this.details.remove(&ordinal);
                },
            ),
            ReviewAction::Candidate(ordinal, candidate) => self.perform(
                cx,
                async move {
                    commands::transcript::select_transcript_reparse(
                        &state, job, ordinal, candidate, digest,
                    )
                    .await
                },
                |this, value, cx| this.adopt(value, cx),
            ),
            ReviewAction::Repair(boundary) => self.perform(
                cx,
                async move {
                    commands::transcript::prepare_boundary_repair(
                        host, &state, job, digest, boundary,
                    )
                    .await
                },
                |this, quote, _| {
                    this.quote = Some(Arc::new(quote));
                    this.acknowledged = false;
                    this.unpriced = false;
                },
            ),
        }
    }
    fn detail(&mut self, ordinal: u32, cx: &mut Context<Self>) {
        let backend = self.session.read(cx).backend.clone();
        let state = backend.state.clone();
        let job = self.job.clone();
        self.perform(
            cx,
            async move {
                commands::transcript::get_transcript_result_detail(&state, job, ordinal).await
            },
            move |this, detail, _| {
                this.pending_evidence = Some(
                    detail
                        .evidence
                        .as_ref()
                        .map(|e| serde_json::to_string_pretty(&e.response).unwrap_or_default())
                        .unwrap_or_else(|| "No saved provider response".into()),
                );
                this.details.insert(ordinal, detail);
            },
        );
    }
    fn open_form(
        &mut self,
        binding: Binding,
        segments: Vec<surtitle_ai::ReviewText>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let id = binding.id();
        if !self.forms.contains_key(&id) {
            let session = self.session.clone();
            let store = self.store.clone();
            let parent = cx.entity().downgrade();
            let entity = cx.new(|cx| {
                ManualForm::new(
                    session,
                    store,
                    parent,
                    binding,
                    policy::rows(&segments),
                    window,
                    cx,
                )
            });
            self.forms.insert(id.clone(), entity);
        }
        self.selected = Some(id);
        cx.notify();
    }
    fn copy_into_form(
        &mut self,
        binding: Binding,
        rows: Vec<policy::RawRow>,
        replace: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let id = binding.id();
        self.open_form(binding, vec![], window, cx);
        if let Some(form) = self.forms.get(&id) {
            form.update(cx, |form, cx| form.copy_rows(rows, replace, cx));
        }
    }
    fn play(&mut self, media: String, start: u64, end: u64, cx: &mut Context<Self>) {
        let backend = self.session.read(cx).backend.clone();
        let state = backend.state.clone();
        let host = backend.host.clone();
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
enum ReviewAction {
    Apply,
    Warning(String),
    Boundary(String, BoundaryChoice),
    Select(u32, u64, TranscriptRangeSelection),
    Reparse(u32, String),
    Candidate(u32, String),
    Repair(String),
}
impl Render for ReviewDialog {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if let Some(review) = self.review.clone()
            && let Some(target) = self.recovery_target.take()
        {
            if let Some(ordinal) = target
                .strip_prefix("range:")
                .and_then(|ordinal| ordinal.parse::<u32>().ok())
            {
                if let Some(chunk) = review
                    .draft
                    .chunks
                    .iter()
                    .find(|chunk| chunk.ordinal == ordinal)
                {
                    self.open_form(
                        Binding {
                            job: self.job.clone(),
                            digest: review.draft.digest.clone(),
                            target: target.clone(),
                            version: chunk.range_version,
                            start: chunk.request_start_ms,
                            end: chunk.request_end_ms,
                        },
                        chunk.segments.clone(),
                        window,
                        cx,
                    );
                }
            } else if let Some(id) = target.strip_prefix("boundary:")
                && let Some(boundary) = review
                    .draft
                    .conflicts
                    .iter()
                    .find(|boundary| boundary.id == id)
            {
                self.open_form(
                    Binding {
                        job: self.job.clone(),
                        digest: review.draft.digest.clone(),
                        target: target.clone(),
                        version: 0,
                        start: boundary.start_ms,
                        end: boundary.end_ms,
                    },
                    boundary.left_alternative.clone(),
                    window,
                    cx,
                );
            }
        }
        if let Some(text) = self.pending_evidence.take() {
            self.evidence = Some(cx.new(|cx| TextareaState::new(window, cx).default_value(text)));
        }
        let theme = cx.theme().clone();
        let disabled = self.busy || (self.store.frozen() || self.store.retired(self.generation));
        let session = self.session.read(cx);
        let job = session
            .snapshot
            .as_ref()
            .and_then(|s| s.jobs.iter().find(|j| j.id == self.job));
        let mut content = column()
            .p_6()
            .gap_4()
            .child(div().text_size(px(25.)).child(localized(
                cx,
                "AIの保存結果と送信記録 / Saved results and execution history",
            )))
            .child(self.job.clone())
            .when_some(
                job.and_then(|job| job.media_id.as_ref()).and_then(|id| {
                    session
                        .snapshot
                        .as_ref()?
                        .media
                        .iter()
                        .find(|media| &media.id == id)
                }),
                |body, media| {
                    body.child(
                        div()
                            .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                            .child(media.title.clone()),
                    )
                },
            )
            .child(
                row()
                    .child(
                        Button::new("refresh-ai-job")
                            .label(localized(cx, "再読込 / Refresh"))
                            .disabled(disabled || self.loading)
                            .on_click(cx.listener(|this, _, _, cx| this.refresh(cx))),
                    )
                    .child(
                        Button::new("retry-local-ai")
                            .label(localized(
                                cx,
                                "保存結果の反映を再試行 / Retry local application",
                            ))
                            .disabled(
                                disabled
                                    || !job.is_some_and(|job| {
                                        job.issue
                                            .as_ref()
                                            .is_some_and(|issue| issue.next_action == "retry_local")
                                    }),
                            )
                            .on_click(
                                cx.listener(|this, _, _, cx| this.job_action("retry-local", cx)),
                            ),
                    ),
            );
        if let Some(job) = job {
            content = content.child(format!(
                "{} · {} · result {} · {:.0}%",
                job.provider.as_str(),
                job.status,
                job.result_state,
                job.progress * 100.
            ));
            if job.status == "running" {
                content = content.child(
                    Button::new("pause-ai-job")
                        .label(localized(
                            cx,
                            "次の要求前に一時停止 / Pause before next request",
                        ))
                        .disabled(disabled)
                        .on_click(cx.listener(|this, _, _, cx| this.job_action("pause", cx))),
                );
            }
            if ["queued", "paused", "running"].contains(&job.status.as_str()) {
                content = content.child(
                    Button::new("cancel-ai-job")
                        .label(localized(cx, "中止 / Cancel"))
                        .disabled(disabled)
                        .on_click(cx.listener(|this, _, _, cx| this.job_action("cancel", cx))),
                );
            }
            if ["paused", "failed", "unknown"].contains(&job.status.as_str())
                && job.request_counts.succeeded < job.request_counts.total
            {
                content = content.child(
                    Button::new("retry-ai-estimate")
                        .label(localized(
                            cx,
                            "未完了分を再見積もり / Estimate unfinished work",
                        ))
                        .disabled(disabled)
                        .on_click(cx.listener(|this, _, _, cx| this.job_action("retry-quote", cx))),
                );
            }
            for (index, range) in job
                .transcription_ranges
                .iter()
                .filter(|r| r.state == "failed")
                .enumerate()
            {
                let owner = self.owner.clone();
                let media = job.media_id.clone().unwrap_or_default();
                let start = range.start_ms;
                let end = range.end_ms;
                content = content.child(
                    Button::new(("failed-range-retry", index))
                        .label(locale_format!(
                            cx,
                            "失敗した区間を新しく見積もる {}–{}",
                            "Estimate failed range {}–{}",
                            policy::timestamp(start),
                            policy::timestamp(end)
                        ))
                        .disabled(disabled)
                        .on_click(move |_, window, cx| {
                            let _ = owner.update(cx, |owner, cx| {
                                owner.request(
                                    AiIntent {
                                        media_id: media.clone(),
                                        kind: AiKind::Transcription,
                                        start_ms: start,
                                        end_ms: end,
                                        focus_term: None,
                                    },
                                    window,
                                    cx,
                                )
                            });
                        }),
                );
            }
        }
        if let Some(quote) = self.quote.clone() {
            content = content.child(quote_content(&quote, cx));
            let settings = session.snapshot.as_ref().map(|s| &s.settings);
            let blocked = settings
                .and_then(|s| {
                    policy::approval_error(
                        &quote,
                        s.active_provider,
                        s.ai_configuration_generation,
                        chrono::Utc::now().timestamp_millis(),
                    )
                })
                .or_else(|| settings.is_none().then(|| "Settings are loading".into()));
            if let Some(reason) = &blocked {
                content = content.child(reason.clone());
            }
            content=content.child(Button::new("review-ai-approval").label(if self.acknowledged{localized(cx, "✓ 範囲・費用・再試行・出力の注意を確認 / Scope and limits reviewed")}else{localized(cx, "□ 表示した範囲・費用・再試行・出力の注意を確認 / Review this scope and limits")}).disabled(disabled).on_click(cx.listener(|this,_,_,cx|{this.acknowledged = !this.acknowledged;cx.notify();})));
            if quote.unpriced || quote.maximum_usd.is_none() {
                content = content.child(
                    Button::new("review-unpriced-approval")
                        .label(if self.unpriced {
                            localized(cx, "✓ 料金不明を承知 / Unknown price acknowledged")
                        } else {
                            localized(
                                cx,
                                "□ 金額上限が保証されないことを承知 / Acknowledge unknown price",
                            )
                        })
                        .disabled(disabled)
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.unpriced = !this.unpriced;
                            cx.notify();
                        })),
                );
            }
            content = content.child(
                Button::new("approve-reviewed-quote")
                    .primary()
                    .label(if quote.is_retry {
                        localized(
                            cx,
                            "この新しい見積もりを承認して再開 / Approve new estimate and resume",
                        )
                    } else {
                        localized(
                            cx,
                            "この見積もりを承認して開始 / Approve this estimate and start",
                        )
                    })
                    .disabled(
                        disabled
                            || blocked.is_some()
                            || !self.acknowledged
                            || ((quote.unpriced || quote.maximum_usd.is_none()) && !self.unpriced),
                    )
                    .on_click(cx.listener(|this, _, _, cx| this.approve(cx))),
            );
        }
        for (index, result) in self.saved.iter().enumerate() {
            let ordinal = result.ordinal;
            let mut section =
                column()
                    .border_1()
                    .border_color(theme.border)
                    .p_3()
                    .child(locale_format!(
                        cx,
                        "保存済み翻訳 #{} · {}",
                        "Saved translation #{} · {}",
                        ordinal + 1,
                        if result.applied {
                            "applied"
                        } else {
                            "not applied"
                        }
                    ));
            for text in &result.translations {
                section = section.child(format!(
                    "{}—{}\n{}\n{}",
                    policy::timestamp(text.start_ms),
                    policy::timestamp(text.end_ms),
                    text.source,
                    text.translation
                ));
            }
            if let Some(reason) = &result.blocked_reason {
                section = section.child(reason.clone());
            }
            content = content.child(
                section.child(
                    Button::new(("apply-saved-translation", index))
                        .label(localized(
                            cx,
                            "保存した翻訳を適用（追加送信なし） / Apply saved translation locally",
                        ))
                        .disabled(disabled || !result.can_apply)
                        .on_click(cx.listener(move |this, _, _, cx| this.apply_saved(ordinal, cx))),
                ),
            );
        }
        if let Some(quote) = &self.quote {
            for (index, candidate) in self
                .candidates
                .iter()
                .enumerate()
                .filter(|(_, c)| c.start_ms < quote.end_ms && c.end_ms > quote.start_ms)
            {
                content = content.child(
                    column()
                        .p_3()
                        .border_1()
                        .border_color(theme.border)
                        .child(div().text_size(px(18.)).child(candidate.term.clone()))
                        .child(candidate.meaning.clone())
                        .child(candidate.example.clone())
                        .child(candidate.explanation.clone())
                        .child(candidate.translation.clone().unwrap_or_default())
                        .child(format!(
                            "Source cues: {} · {}–{}",
                            candidate.source_cue_ids.join(", "),
                            policy::timestamp(candidate.start_ms),
                            policy::timestamp(candidate.end_ms)
                        ))
                        .child(
                            Button::new(("save-ai-vocabulary", index))
                                .label(localized(
                                    cx,
                                    "内容を確認してフレーズ保存 / Save reviewed phrase",
                                ))
                                .disabled(disabled)
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.save_candidate(index, cx)
                                })),
                        ),
                );
            }
        }
        if let Some(review) = self.review.clone() {
            let draft = &review.draft;
            content=content.child(div().text_size(px(23.)).child(localized(cx, "文字起こしの確認 / Transcript review"))).child(localized(cx, "確認・編集・採用はローカル処理です。保存したAI応答と費用予約を保持します。 / Review and adoption are local; saved responses and cost reservations are retained.")).child(format!("{}–{} · {} subtitles · {} pending ranges · draft {}",policy::timestamp(draft.start_ms),policy::timestamp(draft.end_ms),draft.segments.len(),draft.pending_ranges.len(),draft.digest));
            if let Some(reason) = &review.blocked_reason {
                content = content.child(reason.clone());
            }
            content = content.child(
                Button::new("adopt-transcript-review")
                    .primary()
                    .label(if review.applied {
                        localized(cx, "採用済み / Adopted")
                    } else {
                        localized(cx, "確認した字幕を採用 / Adopt reviewed subtitles")
                    })
                    .disabled(disabled || !review.can_apply || review.applied)
                    .on_click(
                        cx.listener(|this, _, _, cx| this.update_review(ReviewAction::Apply, cx)),
                    ),
            );
            for warning in &draft.warnings {
                let id = warning.id.clone();
                let media = review.media_id.clone();
                let start = warning.start_ms;
                let end = warning.end_ms;
                content = content.child(
                    row()
                        .child(format!(
                            "{} · {}–{} · {}",
                            warning.kind,
                            policy::timestamp(start),
                            policy::timestamp(end),
                            if warning.acknowledged {
                                "acknowledged"
                            } else {
                                "listen and review"
                            }
                        ))
                        .child(
                            Button::new(format!("warning-audio-{id}"))
                                .label(localized(cx, "原音 / Original audio"))
                                .disabled(disabled)
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.play(media.clone(), start, end, cx)
                                })),
                        )
                        .child(
                            Button::new(format!("ack-warning-{id}"))
                                .label(localized(cx, "確認済みにする / Acknowledge"))
                                .disabled(disabled || warning.acknowledged || review.applied)
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.update_review(ReviewAction::Warning(id.clone()), cx)
                                })),
                        ),
                );
            }
            for chunk in &draft.chunks {
                let ordinal = chunk.ordinal;
                let version = chunk.range_version;
                let binding = Binding {
                    job: self.job.clone(),
                    digest: draft.digest.clone(),
                    target: format!("range:{ordinal}"),
                    version,
                    start: chunk.request_start_ms,
                    end: chunk.request_end_ms,
                };
                let original = chunk.original_segments.clone();
                let segments = chunk.segments.clone();
                let media = review.media_id.clone();
                let start = chunk.request_start_ms;
                let end = chunk.request_end_ms;
                let mut section = column()
                    .p_3()
                    .border_1()
                    .border_color(theme.border)
                    .child(locale_format!(
                        cx,
                        "区間 {} · {:?} · {} · {}–{} · 版 {}",
                        "Range {} · {:?} · {} · {}–{} · version {}",
                        ordinal + 1,
                        chunk.source,
                        chunk.status,
                        policy::timestamp(start),
                        policy::timestamp(end),
                        version
                    ))
                    .child(
                        row()
                            .child(
                                Button::new(("range-audio", ordinal as usize))
                                    .label(localized(cx, "原音を再生 / Play audio"))
                                    .disabled(disabled)
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        this.play(media.clone(), start, end, cx)
                                    })),
                            )
                            .child(
                                Button::new(("manual-range", ordinal as usize))
                                    .label(localized(cx, "手動で修正 / Correct manually"))
                                    .disabled(
                                        disabled
                                            || review.applied
                                            || review.manual_editing_blocked_reason.is_some(),
                                    )
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        this.open_form(
                                            binding.clone(),
                                            segments.clone(),
                                            window,
                                            cx,
                                        )
                                    })),
                            )
                            .child(
                                Button::new(("original-range", ordinal as usize))
                                    .label(localized(cx, "元の結果を選択 / Select original result"))
                                    .disabled(disabled || review.applied)
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        this.update_review(
                                            ReviewAction::Select(
                                                ordinal,
                                                version,
                                                TranscriptRangeSelection::Original,
                                            ),
                                            cx,
                                        )
                                    })),
                            ),
                    );
                for cue in &original {
                    section = section.child(locale_format!(
                        cx,
                        "元の字幕 {}–{} · {}",
                        "Original {}–{} · {}",
                        policy::timestamp(cue.start_ms),
                        policy::timestamp(cue.end_ms),
                        cue.text
                    ));
                }
                if let Some(edit) = review
                    .range_edits
                    .iter()
                    .find(|edit| edit.ordinal == ordinal)
                {
                    for revision in [
                        edit.latest_revision.as_ref(),
                        edit.selected_revision.as_ref(),
                    ]
                    .into_iter()
                    .flatten()
                    {
                        let id = revision.id.clone();
                        section = section.child(
                            Button::new(format!("select-manual-{}-{}", ordinal, id))
                                .label(locale_format!(
                                    cx,
                                    "保存した手動修正を選択 · {}",
                                    "Select manual revision · {}",
                                    revision.created_at
                                ))
                                .disabled(disabled || review.applied)
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.update_review(
                                        ReviewAction::Select(
                                            ordinal,
                                            version,
                                            TranscriptRangeSelection::Manual {
                                                revision_id: id.clone(),
                                            },
                                        ),
                                        cx,
                                    )
                                })),
                        );
                    }
                }
                if let Some(result) = review.results.iter().find(|r| r.ordinal == ordinal) {
                    section=section.child(locale_format!(cx, "受信結果 {:?} · 理由 {:?} · 試行 {}", "Provider result {:?} · reason {:?} · attempt {}",result.state,result.reason,result.attempt_state.as_deref().unwrap_or("none"))).child(Button::new(("result-evidence",ordinal as usize)).label(localized(cx, "応答・解析証拠を開く / Inspect saved response and parser evidence")).disabled(disabled).on_click(cx.listener(move|this,_,_,cx|this.detail(ordinal,cx))));
                }
                content = content.child(section);
            }
            for conflict in &draft.conflicts {
                let id = conflict.id.clone();
                let binding = Binding {
                    job: self.job.clone(),
                    digest: draft.digest.clone(),
                    target: format!("boundary:{id}"),
                    version: 0,
                    start: conflict.start_ms,
                    end: conflict.end_ms,
                };
                let left = conflict.left_alternative.clone();
                let mut section =
                    column()
                        .p_3()
                        .border_1()
                        .border_color(theme.border)
                        .child(locale_format!(
                            cx,
                            "境界 {} · {}–{} · {:?}",
                            "Boundary {} · {}–{} · {:?}",
                            policy::timestamp(conflict.at_ms),
                            policy::timestamp(conflict.start_ms),
                            policy::timestamp(conflict.end_ms),
                            conflict.resolution
                        ));
                for (label, segments) in [
                    ("Earlier result", &conflict.left_alternative),
                    ("Later result", &conflict.right_alternative),
                ] {
                    section = section.child(label);
                    for cue in segments {
                        section = section.child(format!(
                            "{}–{} · {}",
                            policy::timestamp(cue.start_ms),
                            policy::timestamp(cue.end_ms),
                            cue.text
                        ));
                    }
                }
                let mut actions = row();
                for (kind, label) in [
                    (0, localized(cx, "前の結果 / Earlier")),
                    (1, localized(cx, "次の結果 / Later")),
                    (2, localized(cx, "両方 / Keep both")),
                ] {
                    let id = id.clone();
                    actions = actions.child(
                        Button::new(format!("resolve-{id}-{kind}"))
                            .label(label)
                            .disabled(disabled || review.applied)
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.update_review(
                                    ReviewAction::Boundary(
                                        id.clone(),
                                        match kind {
                                            0 => BoundaryChoice::Left,
                                            1 => BoundaryChoice::Right,
                                            _ => BoundaryChoice::KeepBoth,
                                        },
                                    ),
                                    cx,
                                )
                            })),
                    );
                }
                let repair = id.clone();
                section=section.child(actions).child(Button::new(format!("manual-boundary-{id}")).label(localized(cx, "手動で境界を整える / Edit boundary manually")).disabled(disabled||review.applied).on_click(cx.listener(move|this,_,window,cx|this.open_form(binding.clone(),left.clone(),window,cx)))).child(Button::new(format!("repair-boundary-{id}")).label(localized(cx, "30秒以内の音声修復を見積もる（送信は別承認） / Prepare repair estimate; separate approval required")).disabled(disabled||review.applied).on_click(cx.listener(move|this,_,_,cx|this.update_review(ReviewAction::Repair(repair.clone()),cx))));
                content = content.child(section);
            }
            for repair in &review.repair_alternatives {
                let Some(conflict) = draft.conflicts.iter().find(|c| c.id == repair.boundary_id)
                else {
                    continue;
                };
                let binding = Binding {
                    job: self.job.clone(),
                    digest: draft.digest.clone(),
                    target: format!("boundary:{}", repair.boundary_id),
                    version: 0,
                    start: conflict.start_ms,
                    end: conflict.end_ms,
                };
                let segments: Vec<surtitle_ai::ReviewText> = repair
                    .draft
                    .segments
                    .iter()
                    .map(|s| surtitle_ai::ReviewText {
                        start_ms: s.start_ms,
                        end_ms: s.end_ms,
                        text: s.text.clone(),
                        timing_precision: "cue".into(),
                        word_anchors: vec![],
                    })
                    .collect();
                content=content.child(Button::new(format!("copy-repair-{}",repair.job_id)).label(localized(cx, "受信した修復候補を手動確認用にコピー / Copy received repair into manual review")).disabled(disabled||!repair.draft.can_adopt).on_click(cx.listener(move|this,_,window,cx|this.copy_into_form(binding.clone(),policy::rows(&segments),true,window,cx))));
            }
            content = content.child(div().text_size(px(20.)).child(localized(
                cx,
                "全体のプレビュー / Complete subtitle preview",
            )));
            let preview = review.clone();
            let owner = self.owner.clone();
            content = content.child(
                uniform_list(
                    "received-transcript-preview",
                    draft.segments.len(),
                    move |range, _, cx| {
                        range
                            .map(|index| {
                                let cue = &preview.draft.segments[index];
                                let job = preview.job_id.clone();
                                let cue_id = cue.id.clone();
                                let owner = owner.clone();
                                row()
                                    .h(px(88.))
                                    .child(
                                        column()
                                            .flex_1()
                                            .child(format!(
                                                "{}–{} · {} · {}",
                                                policy::timestamp(cue.start_ms),
                                                policy::timestamp(cue.end_ms),
                                                cue.status,
                                                cue.timing_precision
                                            ))
                                            .child(cue.text.clone()),
                                    )
                                    .child(
                                        Button::new(("study-received-cue", index))
                                            .label(localized(
                                                cx,
                                                "この一節から学ぶ / Study this excerpt",
                                            ))
                                            .disabled(disabled)
                                            .on_click(move |_, window, cx| {
                                                let _ = owner.update(cx, |owner, cx| {
                                                    owner.prepare_draft_study(
                                                        job.clone(),
                                                        Some(vec![cue_id.clone()]),
                                                        None,
                                                        window,
                                                        cx,
                                                    )
                                                });
                                            }),
                                    )
                            })
                            .collect::<Vec<_>>()
                    },
                )
                .h(px(360.)),
            );
        }
        for (ordinal, detail) in &self.details {
            let mut section =
                column()
                    .p_3()
                    .border_1()
                    .border_color(theme.border)
                    .child(locale_format!(
                        cx,
                        "保存応答の詳細 #{} · {:?} · {:?}",
                        "Saved evidence #{} · {:?} · {:?}",
                        ordinal + 1,
                        detail.state,
                        detail.reason
                    ));
            if let Some(evidence) = &detail.evidence {
                if let (Some(text), Some(review)) = (
                    policy::original_transcript_text(&evidence.response),
                    self.review.as_ref(),
                ) && let Some(chunk) = review
                    .draft
                    .chunks
                    .iter()
                    .find(|chunk| chunk.ordinal == *ordinal)
                {
                    let binding = Binding {
                        job: self.job.clone(),
                        digest: review.draft.digest.clone(),
                        target: format!("range:{ordinal}"),
                        version: chunk.range_version,
                        start: chunk.request_start_ms,
                        end: chunk.request_end_ms,
                    };
                    section = section.child(Button::new(("copy-provider-text",*ordinal as usize)).label(localized(cx, "本文だけを手動欄へコピー（時刻は自分で確認） / Copy transcript text; review timing manually")).disabled(disabled || review.applied).on_click(cx.listener(move |this,_,window,cx|this.copy_into_form(binding.clone(),vec![policy::RawRow{start:String::new(),end:String::new(),text:text.clone()}],false,window,cx))));
                }
                section = section.child(format!(
                    "Model {} · parser {} · complete {} · evidence {} · request {} · task {}",
                    evidence.model_id,
                    evidence.parser_revision,
                    evidence.complete,
                    detail.evidence_sha256.as_deref().unwrap_or("unknown"),
                    evidence.request_sha256,
                    evidence.task_sha256
                ));
                if let Some(hash) = &detail.evidence_sha256 {
                    let ordinal = *ordinal;
                    let hash = hash.clone();
                    section=section.child(Button::new(("reparse-evidence",ordinal as usize)).label(localized(cx, "保存応答をローカルで再解析（追加送信なし） / Reparse saved response locally")).disabled(disabled||!evidence.complete).on_click(cx.listener(move|this,_,_,cx|this.update_review(ReviewAction::Reparse(ordinal,hash.clone()),cx))));
                }
            }
            for candidate in &detail.reparses {
                let ordinal = *ordinal;
                let id = candidate.id.clone();
                section = section
                    .child(format!(
                        "Parser {} · {:?} · {:?} · selected {}",
                        candidate.parser_revision,
                        candidate.state,
                        candidate.reason,
                        candidate.selected
                    ))
                    .child(
                        Button::new(format!("select-reparse-{id}"))
                            .label(localized(
                                cx,
                                "この解析候補を選択 / Select this parser candidate",
                            ))
                            .disabled(disabled || candidate.selected || candidate.output.is_none())
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.update_review(ReviewAction::Candidate(ordinal, id.clone()), cx)
                            })),
                    );
            }
            content = content.child(section);
        }
        if let Some(evidence) = &self.evidence {
            let label = localized(
                cx,
                "保存したプロバイダー応答（技術的な証拠） / Saved provider response (technical evidence)",
            );
            content = content.child(label.clone()).child(
                Textarea::new(evidence)
                    .aria_label(label)
                    .readonly(true)
                    .h(px(280.)),
            );
        }
        if let Some(id) = &self.selected
            && let Some(form) = self.forms.get(id)
        {
            content = content.child(form.clone());
        }
        let runtime = session
            .ai_runtime
            .as_ref()
            .filter(|runtime| runtime.job_id == self.job)
            .or(self.runtime.as_ref());
        if let Some(runtime) = runtime {
            content = content
                .child(div().text_size(px(20.)).child(localized(
                    cx,
                    "実行中の受信内容・履歴 / Runtime preview and history",
                )))
                .child(format!(
                    "Approval {} · revision {}",
                    runtime.approval_id, runtime.revision
                ));
            if let Some(preview) = &runtime.preview {
                let (label, notice) = match preview.state.as_str() {
                    "validated" => (
                        "受信した内容 / Received content",
                        "応答の形式を確認しました。字幕やカードへの反映状況は処理結果を確認してください。 / Response format checked. See the job result for application status.",
                    ),
                    "rejected" => (
                        "利用できなかった応答 / Unusable response",
                        "このプレビューは保存・適用できません。 / This preview cannot be saved or applied.",
                    ),
                    _ => (
                        "生成中・未確定 / Generating · provisional",
                        "このプレビューは保存・適用できません。 / This preview cannot be saved or applied.",
                    ),
                };
                content = content.child(
                    column()
                        .p_3()
                        .gap_2()
                        .border_1()
                        .border_color(theme.border)
                        .child(
                            div()
                                .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                                .child(localized(cx, label)),
                        )
                        .child(
                            div()
                                .text_color(theme.muted_foreground)
                                .child(localized(cx, notice)),
                        )
                        .when(preview.truncated, |body| {
                            body.child(localized(
                                cx,
                                "プレビューは途中までの表示です。 / This preview is truncated.",
                            ))
                        })
                        .child(preview.text.clone())
                        .child(div().text_color(theme.muted_foreground).child(format!(
                            "{} · {} {} · {}",
                            preview.attempt_id,
                            localized(cx, "要求 / Request"),
                            preview.ordinal + 1,
                            preview.state
                        ))),
                );
            }
            for event in &runtime.events {
                content = content.child(format!(
                    "{} · {} · request {:?} · attempt {} · HTTP {:?} · {}",
                    event.timestamp,
                    event.phase,
                    event.ordinal,
                    event.attempt_id.as_deref().unwrap_or("none"),
                    event.http_status,
                    event.reason.as_deref().unwrap_or("")
                ));
            }
        }
        if let Some(error) = self.error.clone().or_else(|| self.store.error()) {
            content = content.child(error);
        }
        content = content.child(
            Button::new("close-ai-review")
                .label(localized(cx, "入力を残して閉じる / Close and keep input"))
                .on_click(|_, window, _| window.remove_window()),
        );
        super::super::keyboard::form_tab_navigation(div())
            .id("ai-review-scroll")
            .size_full()
            .overflow_y_scroll()
            .bg(theme.background)
            .text_color(theme.foreground)
            .child(content)
    }
}
