use super::{locale_format, localized};
use gpui_kit::base::Disableable;
// SPDX-License-Identifier: GPL-3.0-or-later
use super::{
    model_form::{ModelForm, ModelValues},
    persistence::Persistence,
    policy, quote_content,
};
use crate::ui::style::tabular_numbers;
use crate::{
    application::{
        ai::{AiQuote, QuoteRequest},
        continuations::AiContinuation,
        transcript::TranscriptionPreparation,
    },
    commands,
    ui::{
        session::{Route, Session, UiEvent, run},
        style::{column, row},
    },
};
use gpui_kit::component::{
    ActiveTheme,
    button::{Button, ButtonVariants},
    input::{Input, InputEvent, InputState},
};
use gpui_kit::{AppContext, Context, Entity, Subscription, Window, div, prelude::*, px};
use std::{future::Future, sync::Arc, time::Duration};
use surtitle_core::AiModelPreference;

pub(super) struct RequestDialog {
    session: Entity<Session>,
    store: Persistence,
    generation: u64,
    lease: u64,
    value: AiContinuation,
    start: Entity<InputState>,
    end: Entity<InputState>,
    focus: Entity<InputState>,
    model_form: Entity<ModelForm>,
    quote: Option<Arc<AiQuote>>,
    preparations: Vec<TranscriptionPreparation>,
    revision: u64,
    busy: bool,
    preparing: bool,
    operation_id: Option<String>,
    started: bool,
    error: Option<String>,
    acknowledged: bool,
    unpriced: bool,
    source_invalid: bool,
    _subscriptions: Vec<Subscription>,
}
impl RequestDialog {
    pub fn notify_forms(&self, cx: &mut Context<Self>) {
        self.model_form.update(cx, |_, cx| cx.notify());
        cx.notify();
    }
    fn retired(&self) -> bool {
        self.store.retired(self.generation)
            || self.store.continuation_retired(&self.value.id, self.lease)
    }
    pub fn rebind(
        &mut self,
        cues: Vec<surtitle_core::SubtitleSegment>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.started || self.busy || self.store.frozen() || self.retired() {
            return;
        }
        let Some(media) = self
            .session
            .read(cx)
            .snapshot
            .as_ref()
            .and_then(|snapshot| {
                snapshot
                    .media
                    .iter()
                    .find(|media| media.id == self.value.media_id)
            })
            .cloned()
        else {
            return;
        };
        let (start, end) = match policy::rebind_request_source(&mut self.value, &media, &cues) {
            Ok(bounds) => bounds,
            Err(error) => {
                self.error = Some(error);
                return;
            }
        };
        self.source_invalid = false;
        self.start.update(cx, |input, cx| {
            input.set_value(policy::timestamp(start), window, cx)
        });
        self.end.update(cx, |input, cx| {
            input.set_value(policy::timestamp(end), window, cx)
        });
        self.changed(cx);
    }
    pub fn new(
        session: Entity<Session>,
        store: Persistence,
        mut value: AiContinuation,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let generation = store.generation();
        let lease = store.continuation_epoch(&value.id);
        if let Some(snapshot) = &session.read(cx).snapshot
            && (value.provider, value.ai_configuration_generation)
                != (
                    snapshot.settings.active_provider,
                    snapshot.settings.ai_configuration_generation,
                )
        {
            value.models.clear();
            for raw in value.model_inputs.values_mut() {
                raw.insert("enabled".into(), "false".into());
            }
            value.quote_id = None;
            value.preparation_id = None;
        }
        let start = cx.new(|cx| InputState::new(window, cx).default_value(value.start.clone()));
        let end = cx.new(|cx| InputState::new(window, cx).default_value(value.end.clone()));
        let focus =
            cx.new(|cx| InputState::new(window, cx).default_value(value.focus_term.clone()));
        let mut subscriptions = vec![];
        let purpose = match value.kind.as_str() {
            "transcribe" => "transcription",
            "translate" => "translation",
            _ if !value.focus_term.trim().is_empty() => "explanation",
            _ => "vocabulary",
        };
        let model_form = cx.new(|cx| {
            ModelForm::new(
                session.clone(),
                store.clone(),
                purpose.into(),
                value.models.clone(),
                value.model_inputs.clone(),
                window,
                cx,
            )
        });
        subscriptions.push(
            cx.subscribe(&model_form, |this, _, event: &ModelValues, cx| {
                this.value.models = event.models.clone();
                this.value.model_inputs = event.raw.clone();
                this.changed(cx);
            }),
        );
        for input in [&start, &end, &focus] {
            subscriptions.push(cx.subscribe(input, |this, _, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    this.changed(cx);
                }
            }));
        }
        subscriptions.push(cx.subscribe(&session, |this, _, event: &UiEvent, cx| {
            if matches!(event, UiEvent::Changed(change) if matches!(change.domain, crate::application::changes::ChangeDomain::Subtitles | crate::application::changes::ChangeDomain::Restore) && change.entity_id.as_ref().is_none_or(|id| id == &this.value.media_id)) {
                this.quote = None;
                this.source_invalid = this.value.kind != "transcribe";
                this.revision += 1;
            }
            if matches!(event, UiEvent::Snapshot) {
                let current = this.configuration(cx);
                if current != (this.value.provider, this.value.ai_configuration_generation) {
                    this.quote = None;
                    this.value.models.clear();
                    this.value.preparation_id = None;
                    this.revision += 1;
                }
                cx.notify();
            }
        }));
        cx.spawn(async move |view, cx| {
            loop {
                cx.background_executor().timer(Duration::from_secs(1)).await;
                if view.update(cx, |_, cx| cx.notify()).is_err() {
                    break;
                }
            }
        })
        .detach();
        let mut this = Self {
            session,
            store,
            generation,
            lease,
            value,
            start,
            end,
            focus,
            model_form,
            quote: None,
            preparations: vec![],
            revision: 0,
            busy: false,
            preparing: false,
            operation_id: None,
            started: false,
            error: None,
            acknowledged: false,
            unpriced: false,
            source_invalid: false,
            _subscriptions: subscriptions,
        };
        this.persist(cx);
        this.load_preparations(cx);
        this
    }
    fn configuration(&self, cx: &gpui_kit::App) -> (surtitle_core::AiProvider, u64) {
        self.session
            .read(cx)
            .snapshot
            .as_ref()
            .map(|s| {
                (
                    s.settings.active_provider,
                    s.settings.ai_configuration_generation,
                )
            })
            .unwrap_or_default()
    }
    fn purpose(&self) -> &'static str {
        match self.value.kind.as_str() {
            "transcribe" => "transcription",
            "translate" => "translation",
            _ if !self.value.focus_term.trim().is_empty() => "explanation",
            _ => "vocabulary",
        }
    }
    fn model(&self, cx: &gpui_kit::App) -> Option<AiModelPreference> {
        self.model_form.read(cx).selected(cx).ok()
    }
    fn changed(&mut self, cx: &mut Context<Self>) {
        if self.store.frozen() || self.retired() {
            return;
        }
        self.revision += 1;
        self.quote = None;
        self.value.quote_id = None;
        self.value.preparation_id = None;
        self.acknowledged = false;
        self.unpriced = false;
        self.persist(cx);
        cx.notify();
    }
    fn persist(&mut self, cx: &mut Context<Self>) {
        if self.started || self.retired() {
            return;
        }
        self.value.start = self.start.read(cx).value().to_string();
        self.value.end = self.end.read(cx).value().to_string();
        self.value.focus_term = self.focus.read(cx).value().to_string();
        let (provider, generation) = self.configuration(cx);
        self.value.provider = provider;
        self.value.ai_configuration_generation = generation;
        if let Err(error) = self.store.continuation(self.value.clone(), self.lease) {
            self.error = Some(error);
        }
    }
    fn perform<T: Send + 'static>(
        &mut self,
        cx: &mut Context<Self>,
        future: impl Future<Output = Result<T, String>> + Send + 'static,
        apply: impl FnOnce(&mut Self, T, &mut Context<Self>) + 'static,
    ) {
        if self.busy || (self.store.frozen() || self.retired()) {
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
                this.preparing = false;
                this.operation_id = None;
                match result {
                    Ok(value) => apply(this, value, cx),
                    Err(error) => this.error = Some(error),
                }
            },
        );
    }
    fn load_preparations(&mut self, cx: &mut Context<Self>) {
        let backend = self.session.read(cx).backend.clone();
        let state = backend.state.clone();
        let media = self.value.media_id.clone();
        run(
            &backend,
            cx,
            async move { commands::transcript::list_transcription_preparations(&state, media) },
            |this, result, _| match result {
                Ok(values) => this.preparations = values,
                Err(error) => this.error = Some(error),
            },
        );
    }
    fn range(&self, cx: &gpui_kit::App) -> Result<(u64, u64), String> {
        let media = self
            .session
            .read(cx)
            .snapshot
            .as_ref()
            .and_then(|s| s.media.iter().find(|m| m.id == self.value.media_id))
            .ok_or("The source media is missing")?;
        if self.value.kind != "transcribe"
            && (self.source_invalid
                || self.value.source_media_signature.as_ref()
                    != Some(
                        &serde_json::to_string(&(
                            &media.path,
                            media.audio_stream_index,
                            &media.learning_language,
                            &media.explanation_language,
                        ))
                        .unwrap(),
                    ))
        {
            return Err(
                "The source changed. Keep this input and select the subtitles again from Study"
                    .into(),
            );
        }
        let (start, end) = if self.value.kind == "transcribe" && self.value.whole_media {
            (0, media.duration_ms)
        } else {
            (
                policy::parse_time(self.start.read(cx).value().as_ref())
                    .ok_or("Enter a complete start time")?,
                policy::parse_time(self.end.read(cx).value().as_ref())
                    .ok_or("Enter a complete end time")?,
            )
        };
        if end <= start || media.duration_ms > 0 && end > media.duration_ms {
            return Err("Select a nonempty range inside the source media".into());
        }
        Ok((start, end))
    }
    fn estimate(&mut self, preparation: Option<String>, cx: &mut Context<Self>) {
        let (start, end) = match self.range(cx) {
            Ok(range) => range,
            Err(error) => {
                self.error = Some(error);
                return;
            }
        };
        let selected = match self.model_form.read(cx).selected(cx) {
            Ok(model) => model,
            Err(error) => {
                self.error = Some(error);
                return;
            }
        };
        self.value
            .models
            .insert(self.purpose().into(), selected.clone());
        self.persist(cx);
        let revision = self.revision;
        let value = self.value.clone();
        let model = Some(selected);
        if model
            .as_ref()
            .is_none_or(|m| m.model_id.trim().is_empty() || m.max_output_tokens == 0)
        {
            self.error = Some("Select a model in Settings before estimating".into());
            return;
        }
        let backend = self.session.read(cx).backend.clone();
        let state = backend.state.clone();
        let host = backend.host.clone();
        let operation = uuid::Uuid::new_v4().to_string();
        let is_transcript = value.kind == "transcribe";
        self.preparing = is_transcript && preparation.is_none();
        self.operation_id = self.preparing.then_some(operation.clone());
        self.perform(
            cx,
            async move {
                if is_transcript {
                    let preparation = match preparation {
                        Some(id) => id,
                        None => {
                            commands::ai::prepare_transcription(
                                host,
                                &state,
                                value.media_id.clone(),
                                start,
                                end,
                                Some(value.whole_media),
                                Some(operation),
                                model.clone(),
                            )
                            .await?
                            .id
                        }
                    };
                    let quote = commands::transcript::create_transcription_quote(
                        &state,
                        preparation.clone(),
                        model,
                        Some(value.provider),
                        Some(value.ai_configuration_generation),
                    )
                    .await?;
                    Ok((quote, Some(preparation)))
                } else {
                    let current = commands::subtitles::list_segments(&state, value.media_id.clone())?;
                    if !policy::source_matches(value.source_revision.as_deref(), &value.source_cue_ids, &current) {
                        return Err("The selected subtitles changed. Select the source again before estimating".into());
                    }
                    let quote = commands::ai::create_quote(
                        &state,
                        QuoteRequest {
                            provider: Some(value.provider),
                            ai_configuration_generation: Some(value.ai_configuration_generation),
                            media_id: value.media_id,
                            kind: value.kind,
                            start_ms: start,
                            end_ms: end,
                            focus_term: (!value.focus_term.trim().is_empty())
                                .then(|| value.focus_term.trim().into()),
                            model,
                        },
                    )
                    .await?;
                    Ok((quote, None))
                }
            },
            move |this, (quote, preparation), cx| {
                if this.revision != revision {
                    return;
                }
                this.value.preparation_id = preparation;
                this.value.quote_id = Some(quote.id.clone());
                this.quote = Some(Arc::new(quote));
                this.acknowledged = false;
                this.unpriced = false;
                if !this.store.frozen() {
                    this.persist(cx);
                }
                this.load_preparations(cx);
            },
        );
    }
    fn approve(&mut self, cx: &mut Context<Self>) {
        if let Err(error) = self.range(cx) {
            self.error = Some(error);
            return;
        }
        let Some(quote) = self.quote.clone() else {
            return;
        };
        let (provider, generation) = self.configuration(cx);
        if let Some(error) = policy::approval_error(
            &quote,
            provider,
            generation,
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
        let id = self.value.id.clone();
        let source = self.value.clone();
        let unknown = self.unpriced;
        self.perform(
            cx,
            async move {
                if source.kind != "transcribe" {
                    let current = commands::subtitles::list_segments(&state, source.media_id)?;
                    if !policy::source_matches(
                        source.source_revision.as_deref(),
                        &source.source_cue_ids,
                        &current,
                    ) {
                        return Err(
                            "The selected subtitles changed. Review a new estimate from the source"
                                .into(),
                        );
                    }
                }
                if quote.is_retry {
                    commands::ai::reapprove_quote(
                        &state,
                        quote.id.clone(),
                        quote.digest.clone(),
                        unknown,
                        true,
                        quote.retry_policy.as_ref().map(|p| p.version),
                        Some(quote.ai_configuration_generation),
                    )
                    .await?;
                } else {
                    commands::ai::approve_quote(
                        &state,
                        quote.id.clone(),
                        quote.digest.clone(),
                        unknown,
                        true,
                        quote.retry_policy.as_ref().map(|p| p.version),
                        Some(quote.ai_configuration_generation),
                    )
                    .await?;
                }
                commands::continuations::discard_ai_continuation(&state, id)?;
                Ok(())
            },
            |this, _, cx| {
                this.started = true;
                this.quote = None;
                this.session.update(cx, |session, cx| session.refresh(cx));
            },
        );
    }
    fn cancel_preparation(&mut self, cx: &mut Context<Self>) {
        if self.retired() {
            return;
        }
        let backend = self.session.read(cx).backend.clone();
        let state = backend.state.clone();
        let id = self.operation_id.clone();
        run(
            &backend,
            cx,
            async move { commands::ai::cancel_preparation(&state, id) },
            |this, result, _| this.error = result.err(),
        );
    }
}
impl Render for RequestDialog {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        let frozen = self.started || self.busy || self.store.frozen() || self.retired();
        let purpose = self.purpose();
        self.model_form.update(cx, |form, cx| {
            form.set_purpose(purpose, cx);
            form.set_disabled(frozen, cx);
        });
        let model = self.session.read(cx);
        let (provider, generation) = self.configuration(cx);
        let media = model
            .snapshot
            .as_ref()
            .and_then(|s| s.media.iter().find(|m| m.id == self.value.media_id));
        let name = media
            .map(|m| m.title.clone())
            .unwrap_or_else(|| self.value.media_id.clone());
        let mut content=column().p_6().gap_4().child(div().text_size(px(26.)).child(localized(cx, "AIの見積もり / AI estimate"))).child(name).child(localized(cx, "見積もりは送信しません。入力はこの端末に保存されます。 / An estimate does not send a paid request. Unfinished input is saved on this device."));
        if let Some(media) = media {
            content = content.child(format!(
                "{} · audio track {:?} · {} → {}",
                media.path,
                media.audio_stream_index,
                media.learning_language,
                media.explanation_language
            ));
        }
        if self.retired() {
            content = content.child(localized(cx, "データが復元されました。この入力は保持されています。画面を閉じ、現在の教材から開き直してください。 / Data was restored. Close this retired window and reopen the current source."));
        }
        if self.value.kind != "transcribe" {
            content = content.child(
                Button::new("reselect-ai-source")
                    .label(localized(
                        cx,
                        "入力を残して字幕を選び直す / Keep input and select source subtitles again",
                    ))
                    .disabled(frozen)
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.persist(cx);
                        let media = this.value.media_id.clone();
                        let id = this.value.id.clone();
                        this.session
                            .update(cx, |session, cx| session.request_rebind_ai(id, media, cx));
                        window.remove_window();
                    })),
            );
        }
        if self.started {
            content=content.child(localized(cx, "承認した処理を開始しました。進行状況はActivityで確認できます。 / The approved job has started. Follow its progress in Activity."));
        } else {
            content = content.child(
                row().children(
                    [
                        ("transcribe", localized(cx, "文字起こし / Transcribe")),
                        ("translate", localized(cx, "翻訳 / Translate")),
                        (
                            "vocabulary",
                            localized(cx, "語彙・解説 / Vocabulary and explanation"),
                        ),
                    ]
                    .into_iter()
                    .map(|(kind, label)| {
                        Button::new(kind)
                            .label(label)
                            .disabled(frozen)
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.value.kind = kind.into();
                                this.changed(cx);
                            }))
                    }),
                ),
            );
            if self.value.kind == "transcribe" {
                content = content.child(
                    Button::new("whole-media")
                        .label(if self.value.whole_media {
                            localized(cx, "✓ 全編 / Entire media")
                        } else {
                            localized(cx, "□ 範囲指定 / Selected range")
                        })
                        .disabled(frozen)
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.value.whole_media = !this.value.whole_media;
                            this.changed(cx);
                        })),
                );
            }
            content = content.child(
                row()
                    .child(
                        column().child(localized(cx, "開始 / From")).child(
                            Input::new(&self.start)
                                .aria_label(localized(
                                    cx,
                                    "AIの対象範囲の開始時刻 / AI source range start time",
                                ))
                                .disabled(frozen)
                                .w(px(220.)),
                        ),
                    )
                    .child(
                        column().child(localized(cx, "終了 / To")).child(
                            Input::new(&self.end)
                                .aria_label(localized(
                                    cx,
                                    "AIの対象範囲の終了時刻 / AI source range end time",
                                ))
                                .disabled(frozen)
                                .w(px(220.)),
                        ),
                    ),
            );
            if self.value.kind == "vocabulary" {
                let label = localized(
                    cx,
                    "解説する表現（空欄なら語彙提案） / Phrase to explain; blank finds expressions",
                );
                content = content.child(
                    column()
                        .child(label.clone())
                        .child(Input::new(&self.focus).aria_label(label).disabled(frozen)),
                );
            }
            content = content.child(self.model_form.clone());
            let chosen = self.model(cx);
            content = content
                .child(format!(
                    "{} · configuration generation {} · model {}",
                    provider.as_str(),
                    generation,
                    chosen
                        .as_ref()
                        .map(|m| m.model_id.as_str())
                        .unwrap_or("not configured")
                ))
                .child(
                    Button::new("ai-settings")
                        .label(localized(
                            cx,
                            "入力を残してAI設定へ / Keep input and open Settings",
                        ))
                        .disabled(frozen)
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.persist(cx);
                            this.session
                                .update(cx, |session, cx| session.navigate(Route::Settings, cx));
                            window.remove_window();
                        })),
                );
            content = content.child(
                Button::new("estimate-ai")
                    .primary()
                    .label(if self.preparing {
                        localized(cx, "音声を準備中… / Preparing audio…")
                    } else {
                        localized(cx, "見積もりを作成 / Prepare estimate")
                    })
                    .disabled(frozen)
                    .on_click(cx.listener(|this, _, _, cx| this.estimate(None, cx))),
            );
            if self.preparing {
                content = content.child(
                    div()
                        .id("audio-preparation-progress")
                        .h(px(40.))
                        .flex_shrink_0()
                        .overflow_y_scroll()
                        .font_features(tabular_numbers())
                        .children(model.preparation.as_ref().map(|progress| {
                            format!(
                                "{} · {} / {} ms · {} / {} chunks",
                                progress.phase,
                                progress.processed_ms,
                                progress.total_ms,
                                progress.completed_chunks,
                                progress.total_chunks
                            )
                        })),
                );
                content = content.child(
                    Button::new("cancel-preparation")
                        .label(localized(
                            cx,
                            "音声準備を取り消す / Cancel audio preparation",
                        ))
                        .disabled(self.store.frozen() || self.retired())
                        .on_click(cx.listener(|this, _, _, cx| this.cancel_preparation(cx))),
                );
            }
            if self.value.kind == "transcribe" {
                for (index, preparation) in self.preparations.iter().enumerate() {
                    let id = preparation.id.clone();
                    let compatible = preparation.compatible
                        && preparation.provider == provider
                        && preparation.ai_configuration_generation == generation
                        && self.range(cx).ok() == Some((preparation.start_ms, preparation.end_ms))
                        && self.value.whole_media == preparation.whole_media;
                    content = content.child(
                        row()
                            .child(locale_format!(
                                cx,
                                "保存した音声準備 · {}–{} · {} 区間 · {}",
                                "Prepared audio · {}–{} · {} chunks · {}",
                                policy::timestamp(preparation.start_ms),
                                policy::timestamp(preparation.end_ms),
                                preparation.chunk_count,
                                if compatible {
                                    "compatible"
                                } else {
                                    "settings changed"
                                }
                            ))
                            .child(
                                Button::new(("use-preparation", index))
                                    .label(localized(
                                        cx,
                                        "この準備を見積もる / Estimate this preparation",
                                    ))
                                    .disabled(frozen || !compatible)
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        this.estimate(Some(id.clone()), cx)
                                    })),
                            ),
                    );
                }
            }
        }
        if let Some(quote) = &self.quote {
            let blocked = policy::approval_error(
                quote,
                provider,
                generation,
                chrono::Utc::now().timestamp_millis(),
            );
            content = content.child(quote_content(quote, cx));
            if let Some(reason) = &blocked {
                content = content.child(reason.clone());
            }
            content=content.child(Button::new("ack-scope").label(if self.acknowledged{localized(cx, "✓ 範囲・送信上限・再試行と実験的な出力を確認しました / Scope and limits reviewed")}else{localized(cx, "□ 範囲・料金・再試行・出力の注意を確認 / Review scope, cost, retries and output limitations")}).disabled(frozen).on_click(cx.listener(|this,_,_,cx|{this.acknowledged = !this.acknowledged;cx.notify();})));
            if quote.unpriced || quote.maximum_usd.is_none() {
                content = content.child(
                    Button::new("ack-unpriced")
                        .label(if self.unpriced {
                            localized(cx, "✓ 料金不明のまま承認する / Approve unknown pricing")
                        } else {
                            localized(
                                cx,
                                "□ 金額上限が保証されないことを承知 / Acknowledge unknown pricing",
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
                Button::new("approve-ai-quote")
                    .primary()
                    .label(localized(
                        cx,
                        "表示した見積もりを承認して開始 / Approve this estimate and start",
                    ))
                    .disabled(
                        frozen
                            || blocked.is_some()
                            || !self.acknowledged
                            || ((quote.unpriced || quote.maximum_usd.is_none()) && !self.unpriced),
                    )
                    .on_click(cx.listener(|this, _, _, cx| this.approve(cx))),
            );
        }
        if let Some(error) = self.error.clone().or_else(|| self.store.error()) {
            content = content.child(error);
        }
        content = content.child(
            Button::new("close-ai-request")
                .label(localized(cx, "入力を残して閉じる / Close and keep input"))
                .on_click(|_, window, _| window.remove_window()),
        );
        div()
            .id("ai-request-scroll")
            .size_full()
            .overflow_y_scroll()
            .bg(theme.background)
            .text_color(theme.foreground)
            .child(content)
    }
}
