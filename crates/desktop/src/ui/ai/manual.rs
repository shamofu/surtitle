// SPDX-License-Identifier: GPL-3.0-or-later
//! Raw manual review is stored separately from immutable provider evidence.
use super::{locale_format, localized};
use super::{
    persistence::{Persistence, RawInput},
    policy::{self, RawRow},
    review::ReviewDialog,
};
use crate::{
    commands,
    ui::{
        session::{Session, run},
        style::{column, row},
    },
};
use gpui_kit::base::Disableable;
use gpui_kit::component::{
    ActiveTheme,
    button::{Button, ButtonVariants},
    input::{Input, InputEvent, InputState, Textarea, TextareaState},
};
use gpui_kit::{AppContext, Context, Entity, Subscription, WeakEntity, Window, prelude::*, px};
use std::collections::BTreeMap;
use surtitle_ai::{BoundaryChoice, ManualTranscriptContent};
use surtitle_core::workspace::UiDraft;
#[derive(Clone)]
pub(super) struct Binding {
    pub job: String,
    pub digest: String,
    pub target: String,
    pub version: u64,
    pub start: u64,
    pub end: u64,
}
impl Binding {
    pub fn id(&self) -> String {
        surtitle_core::workspace::transcript_review_draft_id(
            &self.job,
            &self.digest,
            &self.target,
            self.version,
        )
    }
}
struct RowInputs {
    start: Entity<InputState>,
    end: Entity<InputState>,
    text: Entity<TextareaState>,
}
pub(super) struct ManualForm {
    session: Entity<Session>,
    store: Persistence,
    generation: u64,
    lease: u64,
    parent: WeakEntity<ReviewDialog>,
    binding: Binding,
    inputs: Vec<RowInputs>,
    subscriptions: Vec<Subscription>,
    pending_rows: Option<Vec<RawRow>>,
    pending_copy: Option<(Vec<RawRow>, bool)>,
    silence: bool,
    expected: u64,
    force: bool,
    loading: bool,
    busy: bool,
    error: Option<String>,
    recovery: Vec<UiDraft>,
}
impl ManualForm {
    pub fn new(
        session: Entity<Session>,
        store: Persistence,
        parent: WeakEntity<ReviewDialog>,
        binding: Binding,
        initial: Vec<RawRow>,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let generation = store.generation();
        let lease = store.raw_epoch(&binding.id());
        let backend = session.read(cx).backend.clone();
        let state = backend.state.clone();
        let id = binding.id();
        let job = binding.job.clone();
        let target = binding.target.clone();
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
                    Ok((active, older)) => {
                        this.recovery = older;
                        if let Some(active) = active {
                            this.expected = active.revision;
                            if !active.stale && active.archive_id.is_none() {
                                match decode_rows(&active.fields) {
                                    Ok(rows) => {
                                        this.pending_rows = Some(rows);
                                        this.silence = active
                                            .fields
                                            .get("confirmedNoSpeech")
                                            .is_some_and(|v| v == "true");
                                    }
                                    Err(error) => this.error = Some(error),
                                }
                            } else {
                                this.force = true;
                                if !this.recovery.iter().any(|d| {
                                    d.entity_id == active.entity_id && d.revision == active.revision
                                }) {
                                    this.recovery.push(active);
                                }
                            }
                        }
                    }
                    Err(error) => this.error = Some(error),
                }
            },
        );
        Self {
            session,
            store,
            generation,
            lease,
            parent,
            binding,
            inputs: vec![],
            subscriptions: vec![],
            pending_rows: Some(initial),
            pending_copy: None,
            silence: false,
            expected: 0,
            force: false,
            loading: true,
            busy: false,
            error: None,
            recovery: vec![],
        }
    }
    fn values(&self, cx: &gpui_kit::App) -> Vec<RawRow> {
        self.inputs
            .iter()
            .map(|r| RawRow {
                start: r.start.read(cx).value().to_string(),
                end: r.end.read(cx).value().to_string(),
                text: r.text.read(cx).value().to_string(),
            })
            .collect()
    }
    pub fn copy_rows(&mut self, rows: Vec<RawRow>, replace: bool, cx: &mut Context<Self>) {
        self.pending_copy = Some((rows, replace));
        cx.notify();
    }
    fn set_rows(&mut self, values: Vec<RawRow>, window: &mut Window, cx: &mut Context<Self>) {
        self.inputs.clear();
        self.subscriptions.clear();
        for value in values {
            let start = cx.new(|cx| InputState::new(window, cx).default_value(value.start));
            let end = cx.new(|cx| InputState::new(window, cx).default_value(value.end));
            let text = cx.new(|cx| TextareaState::new(window, cx).default_value(value.text));
            for input in [&start, &end] {
                self.subscriptions
                    .push(cx.subscribe(input, |this, _, event: &InputEvent, cx| {
                        if matches!(event, InputEvent::Change) {
                            this.silence = false;
                            this.persist(cx);
                            cx.notify();
                        }
                    }));
            }
            self.subscriptions
                .push(cx.subscribe(&text, |this, _, event: &InputEvent, cx| {
                    if matches!(event, InputEvent::Change) {
                        this.silence = false;
                        this.persist(cx);
                        cx.notify();
                    }
                }));
            self.inputs.push(RowInputs { start, end, text });
        }
    }
    fn persist(&mut self, cx: &mut Context<Self>) {
        if self.loading
            || self.busy
            || (self.store.frozen()
                || self.store.retired(self.generation)
                || self.store.raw_retired(&self.binding.id(), self.lease))
        {
            return;
        }
        let fields = [
            ("jobId".into(), self.binding.job.clone()),
            ("draftDigest".into(), self.binding.digest.clone()),
            ("target".into(), self.binding.target.clone()),
            ("rangeVersion".into(), self.binding.version.to_string()),
            (
                "rows".into(),
                serde_json::to_string(&self.values(cx)).unwrap(),
            ),
            ("confirmedNoSpeech".into(), self.silence.to_string()),
        ]
        .into();
        let input = RawInput {
            id: self.binding.id(),
            expected_revision: self.expected,
            fields,
            force: self.force,
            lease: self.lease,
        };
        match self.store.raw(input) {
            Ok(()) => {
                self.force = false;
                self.error = None;
            }
            Err(error) => self.error = Some(error),
        }
    }
    fn submit(&mut self, cx: &mut Context<Self>) {
        if self.busy
            || self.loading
            || (self.store.frozen()
                || self.store.retired(self.generation)
                || self.store.raw_retired(&self.binding.id(), self.lease))
        {
            return;
        }
        let content = match policy::manual(
            &self.values(cx),
            self.binding.start,
            self.binding.end,
            self.silence,
        ) {
            Ok(content) => content,
            Err(error) => {
                self.error = Some(error);
                return;
            }
        };
        self.persist(cx);
        let guard = match self.store.operation() {
            Ok(guard) => guard,
            Err(error) => {
                self.error = Some(error);
                return;
            }
        };
        let drain = self.store.drain_inputs();
        let backend = self.session.read(cx).backend.clone();
        let state = backend.state.clone();
        let binding = self.binding.clone();
        self.busy = true;
        run(
            &backend,
            cx,
            async move {
                let _guard = guard;
                drain.await?;
                if let Some(ordinal) = binding.target.strip_prefix("range:") {
                    commands::transcript::save_manual_transcript_range(
                        &state,
                        binding.job,
                        binding.digest,
                        ordinal.parse::<u32>().map_err(|e| e.to_string())?,
                        binding.version,
                        content,
                    )
                    .await
                } else {
                    let segments = match content {
                        ManualTranscriptContent::Subtitles { segments } => segments,
                        ManualTranscriptContent::ConfirmedNoSpeech => vec![],
                    };
                    commands::transcript::resolve_transcript_boundary(
                        &state,
                        binding.job,
                        binding.digest,
                        binding.target.trim_start_matches("boundary:").into(),
                        BoundaryChoice::Manual { segments },
                    )
                    .await
                }
            },
            |this, result, cx| {
                this.busy = false;
                match result {
                    Ok(review) => {
                        let _ = this
                            .parent
                            .update(cx, |parent, cx| parent.adopt(review, cx));
                        this.error = Some(localized(
                            cx,
                            "手動修正を保存しました。全体のレビューで採用してください。 / Saved a manual revision. Adopt it from the full review when ready.",
                        ));
                    }
                    Err(error) => this.error = Some(error),
                }
            },
        );
    }
}
fn decode_rows(fields: &BTreeMap<String, String>) -> Result<Vec<RawRow>, String> {
    let rows: Vec<RawRow> =
        serde_json::from_str(fields.get("rows").ok_or("Raw subtitle rows are missing")?)
            .map_err(|error| error.to_string())?;
    if rows.len() > 200 {
        return Err("Too many raw subtitle rows".into());
    }
    Ok(rows)
}
impl Render for ManualForm {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if let Some(values) = self.pending_rows.take() {
            self.set_rows(values, window, cx);
        }
        if !self.loading
            && let Some((mut rows, replace)) = self.pending_copy.take()
        {
            if !replace {
                let mut previous = self.values(cx);
                previous.append(&mut rows);
                rows = previous;
            }
            self.set_rows(rows, window, cx);
            self.silence = false;
            self.force = true;
            self.persist(cx);
        }
        let theme = cx.theme().clone();
        let disabled = self.busy
            || self.loading
            || (self.store.frozen()
                || self.store.retired(self.generation)
                || self.store.raw_retired(&self.binding.id(), self.lease));
        let mut content=column().p_4().border_1().border_color(theme.border).child(format!("{} · {} — {} · source revision {}",self.binding.target,policy::timestamp(self.binding.start),policy::timestamp(self.binding.end),self.binding.version)).child(localized(cx, "手動編集は字幕区間として保存され、AI応答や単語時刻にはなりません。未確定の費用予約も変更しません。 / Manual edits remain local subtitle ranges; they do not become provider evidence or settle unknown costs."));
        for (index, inputs) in self.inputs.iter().enumerate() {
            content = content.child(
                column()
                    .gap_2()
                    .child(
                        row()
                            .child(
                                Input::new(&inputs.start)
                                    .aria_label(locale_format!(
                                        cx,
                                        "手動字幕 {}行目の開始時刻",
                                        "Manual subtitle row {} start time",
                                        index + 1
                                    ))
                                    .disabled(disabled)
                                    .w(px(180.)),
                            )
                            .child(
                                Input::new(&inputs.end)
                                    .aria_label(locale_format!(
                                        cx,
                                        "手動字幕 {}行目の終了時刻",
                                        "Manual subtitle row {} end time",
                                        index + 1
                                    ))
                                    .disabled(disabled)
                                    .w(px(180.)),
                            )
                            .child(
                                Button::new(("remove-manual-row", index))
                                    .label(localized(cx, "行を削除 / Remove row"))
                                    .disabled(disabled)
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        let mut values = this.values(cx);
                                        if index < values.len() {
                                            values.remove(index);
                                            this.set_rows(values, window, cx);
                                            this.silence = false;
                                            this.persist(cx);
                                            cx.notify();
                                        }
                                    })),
                            ),
                    )
                    .child(
                        Textarea::new(&inputs.text)
                            .aria_label(locale_format!(
                                cx,
                                "手動字幕 {}行目の本文",
                                "Manual subtitle row {} text",
                                index + 1
                            ))
                            .disabled(disabled)
                            .h(px(86.)),
                    ),
            );
        }
        content = content.child(
            row()
                .child(
                    Button::new("add-manual-row")
                        .label(localized(cx, "字幕行を追加 / Add subtitle"))
                        .disabled(disabled || self.inputs.len() >= 200)
                        .on_click(cx.listener(|this, _, window, cx| {
                            let mut values = this.values(cx);
                            values.push(RawRow {
                                start: policy::timestamp(this.binding.start),
                                end: policy::timestamp(this.binding.end),
                                text: String::new(),
                            });
                            this.set_rows(values, window, cx);
                            this.silence = false;
                            this.persist(cx);
                            cx.notify();
                        })),
                )
                .child(
                    Button::new("confirm-no-speech")
                        .label(if self.silence {
                            localized(cx, "✓ 発話なしを明示確認 / No speech confirmed")
                        } else {
                            localized(cx, "□ 原音を確認し、この区間は発話なし / Confirm no speech in this range")
                        })
                        .disabled(disabled || !self.inputs.is_empty())
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.silence = !this.silence;
                            this.persist(cx);
                            cx.notify();
                        })),
                ),
        );
        content = content.child(
            Button::new("save-manual-range")
                .primary()
                .label(localized(cx, "手動修正を保存 / Save manual correction"))
                .disabled(disabled)
                .on_click(cx.listener(|this, _, _, cx| this.submit(cx))),
        );
        for (index, draft) in self.recovery.iter().enumerate() {
            let fields = draft.fields.clone();
            content = content.child(
                row()
                    .child(locale_format!(
                        cx,
                        "保存した別の入力 · {} · {} · {}",
                        "Other saved input · {} · {} · {}",
                        draft.updated_at,
                        if draft.stale {
                            "detached"
                        } else {
                            "previous review"
                        },
                        draft
                            .fields
                            .get("draftDigest")
                            .map(String::as_str)
                            .unwrap_or("unknown")
                    ))
                    .child(
                        Button::new(("recover-manual-input", index))
                            .label(localized(
                                cx,
                                "本文・時刻を確認用にコピー / Copy raw input for review",
                            ))
                            .disabled(disabled)
                            .on_click(cx.listener(move |this, _, window, cx| {
                                match decode_rows(&fields) {
                                    Ok(values) => {
                                        this.set_rows(values, window, cx);
                                        this.silence = false;
                                        this.force = true;
                                        this.persist(cx);
                                        cx.notify();
                                    }
                                    Err(error) => this.error = Some(error),
                                }
                            })),
                    ),
            );
        }
        if let Some(error) = self.error.clone().or_else(|| self.store.error()) {
            content = content.child(error);
        }
        content
    }
}
