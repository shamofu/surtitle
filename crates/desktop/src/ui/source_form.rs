// SPDX-License-Identifier: GPL-3.0-or-later
use super::{
    session::{Session, run},
    source_editors::{DraftAction, DraftOutcome, SourceEditors, SourceKey, SourceOptions},
    style::*,
};
use gpui_kit::base::Disableable;
use gpui_kit::component::{
    ActiveTheme,
    button::ButtonVariants,
    input::{InputEditsEvent, InputEvent, Textarea, TextareaState},
};
use gpui_kit::{AppContext, Context, Entity, Subscription, Window, div, prelude::*, px, size};
use std::collections::BTreeMap;
use surtitle_core::{SaveCard, SubtitleSegment};

pub(crate) fn open_with_term(
    session: Entity<Session>,
    editors: Entity<SourceEditors>,
    kind: &str,
    cues: Vec<SubtitleSegment>,
    term: Option<String>,
    cx: &mut gpui_kit::App,
) -> anyhow::Result<()> {
    let ja = session.read(cx).text("ja", "en") == "ja";
    let t = move |ja_text: &'static str, en_text: &'static str| if ja { ja_text } else { en_text };
    anyhow::ensure!(!cues.is_empty(), "Select subtitles first");
    anyhow::ensure!(
        cues.len() <= 64,
        t(
            "一度に選べる字幕は64行までです",
            "Select at most 64 subtitles"
        )
    );
    anyhow::ensure!(
        kind != "subtitle" || cues.len() == 1,
        "Select one subtitle to edit"
    );
    let first = &cues[0];
    let initial = if kind == "subtitle" {
        super::source_editors::subtitle_fields(first)
    } else {
        let mut fields: BTreeMap<String, String> = [
            ("term".into(), term.unwrap_or_default()),
            ("meaning".into(), String::new()),
            (
                "example".into(),
                cues.iter()
                    .map(|cue| cue.text.as_str())
                    .collect::<Vec<_>>()
                    .join(" "),
            ),
            ("explanation".into(), String::new()),
        ]
        .into();
        if cues
            .iter()
            .any(|cue| cue.timing_precision == "source_block")
        {
            fields.insert("audioStart".into(), precise(first.start_ms));
            fields.insert(
                "audioEnd".into(),
                precise(
                    cues.last()
                        .unwrap()
                        .end_ms
                        .min(first.start_ms.saturating_add(180_000)),
                ),
            );
        }
        fields
    };
    let options = SourceOptions {
        media_id: first.media_id.clone(),
        kind: kind.into(),
        source_key: serde_json::to_string(&cues.iter().map(|cue| &cue.id).collect::<Vec<_>>())?,
        source_cues: cues,
        initial,
        resume: None,
    };
    let key = editors
        .update(cx, |editors, cx| editors.ensure(options, cx))
        .map_err(anyhow::Error::msg)?;
    open_key(session, editors, key, kind, cx)
}

pub(crate) fn open_saved(
    session: Entity<Session>,
    editors: Entity<SourceEditors>,
    draft: surtitle_core::EditorDraftView,
    cx: &mut gpui_kit::App,
) -> anyhow::Result<()> {
    let saved = draft.draft;
    let kind = saved.kind.clone();
    let options = SourceOptions {
        media_id: saved.media_id,
        kind: saved.kind,
        source_key: saved.source_key,
        source_cues: saved.source_cues,
        initial: saved.fields,
        resume: Some(surtitle_core::EditorDraftVersion {
            id: saved.id,
            version: saved.version,
        }),
    };
    let key = editors
        .update(cx, |editors, cx| editors.ensure(options, cx))
        .map_err(anyhow::Error::msg)?;
    open_key(session, editors, key, &kind, cx)
}

fn open_key(
    session: Entity<Session>,
    editors: Entity<SourceEditors>,
    key: SourceKey,
    kind: &str,
    cx: &mut gpui_kit::App,
) -> anyhow::Result<()> {
    let ja = session.read(cx).text("ja", "en") == "ja";
    let t = move |ja_text: &'static str, en_text: &'static str| if ja { ja_text } else { en_text };
    gpui_kit::open_window(
        gpui_kit::WindowOptions {
            titlebar: Some(gpui_kit::TitlebarOptions {
                title: Some(
                    if kind == "subtitle" {
                        t("字幕を編集", "Edit subtitle")
                    } else {
                        t("フレーズを保存", "Save phrase")
                    }
                    .into(),
                ),
                ..Default::default()
            }),
            ..crate::desktop::dialog::options(size(px(640.), px(680.)), None, cx)
        },
        cx,
        move |window, cx| cx.new(|cx| SourceForm::new(session, editors, key, window, cx)),
    )?;
    Ok(())
}

struct SourceForm {
    session: Entity<Session>,
    editors: Entity<SourceEditors>,
    key: SourceKey,
    inputs: BTreeMap<String, Entity<TextareaState>>,
    delivered: BTreeMap<String, String>,
    busy: bool,
    done: bool,
    error: Option<String>,
    _subscriptions: Vec<Subscription>,
    rebind_preview: Option<Vec<SubtitleSegment>>,
}
impl SourceForm {
    fn new(
        session: Entity<Session>,
        editors: Entity<SourceEditors>,
        key: SourceKey,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let fields = editors
            .read(cx)
            .view(&key)
            .map(|view| view.fields.clone())
            .unwrap_or_default();
        let mut inputs = BTreeMap::new();
        let delivered = fields.clone();
        let mut subscriptions = vec![];
        for (name, value) in fields {
            let input = cx.new(|cx| TextareaState::new(window, cx).default_value(value));
            let field = name.clone();
            subscriptions.push(cx.subscribe(
                &input,
                move |this, _, event: &InputEditsEvent, cx| {
                    let Some((_, text)) = event.edits().last() else {
                        return;
                    };
                    let value = text.to_string();
                    this.delivered.insert(field.clone(), value.clone());
                    if this.busy || this.done {
                        return;
                    }
                    if let Some(view) = this.editors.read(cx).view(&this.key) {
                        if view.fields.get(&field) == Some(&value) {
                            return;
                        }
                        let mut fields = view.fields.clone();
                        fields.insert(field.clone(), value);
                        this.editors
                            .update(cx, |editors, cx| editors.change(&this.key, fields, cx));
                    }
                },
            ));
            subscriptions.push(cx.subscribe(&input, |this, _, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Blur) {
                    let _future = this
                        .editors
                        .update(cx, |editors, _| editors.flush(&this.key));
                }
            }));
            inputs.insert(name, input);
        }
        subscriptions.push(cx.observe_in(&editors, window, |this, _, window, cx| {
            if let Some(view) = this.editors.read(cx).view(&this.key) {
                let fields = view.fields.clone();
                for (name, value) in fields {
                    if let Some(input) = this.inputs.get(&name) {
                        let current = input.read(cx).value().to_string();
                        if this.delivered.get(&name) == Some(&current) && current != value {
                            input
                                .update(cx, |input, cx| input.set_value(value.clone(), window, cx));
                            this.delivered.insert(name, value);
                        }
                    }
                }
            }
            cx.notify();
        }));
        let weak = cx.entity().downgrade();
        window.on_window_should_close(cx, move |_, cx| {
            weak.update(cx, |this, _| !this.busy).unwrap_or(true)
        });
        let release_editors = editors.clone();
        let release_key = key.clone();
        cx.on_release(move |_, cx| {
            let _future = release_editors.update(cx, |editors, _| editors.flush(&release_key));
        })
        .detach();
        Self {
            session,
            editors,
            key,
            inputs,
            delivered,
            busy: false,
            done: false,
            error: None,
            rebind_preview: None,
            _subscriptions: subscriptions,
        }
    }
    fn use_alternative(
        &mut self,
        alternative: &surtitle_core::SubtitleReviewAlternative,
        cx: &mut Context<Self>,
    ) {
        if self.busy || self.done || self.editors.read(cx).frozen() {
            return;
        }
        let Some(view) = self.editors.read(cx).view(&self.key) else {
            return;
        };
        if !view.ready || view.draft.as_ref().is_some_and(|draft| draft.stale) {
            return;
        }
        let mut fields = view.fields.clone();
        fields.insert("text".into(), alternative.text.clone());
        fields.insert("start".into(), precise(alternative.start_ms));
        fields.insert("end".into(), precise(alternative.end_ms));
        self.editors
            .update(cx, |editors, cx| editors.change(&self.key, fields, cx));
    }
    fn retranscribe(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy || self.done || self.editors.read(cx).frozen() {
            return;
        }
        let Some(options) = self.editors.read(cx).options(&self.key).cloned() else {
            return;
        };
        let cues = options.source_cues;
        let Some(first) = cues.first() else {
            return;
        };
        let intent = super::ai::AiIntent {
            media_id: options.media_id,
            kind: super::ai::AiKind::Transcription,
            start_ms: first.start_ms,
            end_ms: cues.last().unwrap().end_ms,
            focus_term: None,
        };
        let backend = self.session.read(cx).backend.clone();
        let flush = self
            .editors
            .update(cx, |editors, _| editors.flush(&self.key));
        let handle = window.window_handle();
        self.busy = true;
        run(&backend, cx, flush, move |this, result, cx| {
            this.busy = false;
            match result {
                Ok(()) => {
                    let _ = handle.update(cx, |_, window, _| window.remove_window());
                    this.session
                        .update(cx, |session, cx| session.request_ai(intent, cues, cx));
                }
                Err(error) => this.error = Some(error),
            }
        });
    }
    fn submission(&self, cx: &gpui_kit::App) -> Result<DraftAction, String> {
        let ja = self.session.read(cx).text("ja", "en") == "ja";
        let t =
            move |ja_text: &'static str, en_text: &'static str| if ja { ja_text } else { en_text };
        let registry = self.editors.read(cx);
        let view = registry.view(&self.key).ok_or("Reopen the editor")?;
        if view.draft.as_ref().is_some_and(|draft| draft.stale) {
            return Err(t(
                "出典が変わっています。現在の字幕を確認して関連付け直してください。",
                "Source changed; review and rebind first.",
            )
            .into());
        }
        let options = registry.options(&self.key).ok_or("Reopen the editor")?;
        let source = view
            .draft
            .as_ref()
            .map(|draft| &draft.draft.source_cues)
            .unwrap_or(&options.source_cues);
        let fields = &view.fields;
        let get = |key: &str| fields.get(key).cloned().unwrap_or_default();
        let first = source.first().ok_or("Subtitle source is missing")?;
        if options.kind == "subtitle" {
            let start_ms = parse_time(&get("start"))
                .ok_or(t("開始時刻を確認してください", "Check start time"))?;
            let end_ms =
                parse_time(&get("end")).ok_or(t("終了時刻を確認してください", "Check end time"))?;
            if end_ms <= start_ms {
                return Err(t("終了は開始より後にしてください", "End must follow start").into());
            }
            let mut cue = first.clone();
            cue.start_ms = start_ms;
            cue.end_ms = end_ms;
            cue.text = get("text").trim().into();
            if cue.text.is_empty() {
                return Err(t("字幕を入力してください", "Enter subtitle text").into());
            }
            cue.translation = nonempty(get("translation"));
            cue.status = "confirmed".into();
            cue.review_issues.clear();
            Ok(DraftAction::Subtitle(cue))
        } else {
            let term = get("term").trim().to_owned();
            if term.is_empty() {
                return Err(t("フレーズを入力してください", "Enter a phrase").into());
            }
            let source_range = if fields.contains_key("audioStart") {
                let start_ms = parse_time(&get("audioStart"))
                    .ok_or(t("音声の開始時刻を確認してください", "Check audio start"))?;
                let end_ms = parse_time(&get("audioEnd"))
                    .ok_or(t("音声の終了時刻を確認してください", "Check audio end"))?;
                Some(surtitle_core::AudioClipRange { start_ms, end_ms })
            } else {
                None
            };
            Ok(DraftAction::Phrase(SaveCard {
                media_id: options.media_id.clone(),
                segment_id: first.id.clone(),
                source_cue_ids: source.iter().map(|cue| cue.id.clone()).collect(),
                source_range,
                term,
                meaning: get("meaning"),
                example: get("example"),
                explanation: nonempty(get("explanation")),
                // The store derives a complete translation from every bound cue.
                translation: None,
            }))
        }
    }
    fn save(&mut self, cx: &mut Context<Self>) {
        if self.busy || self.editors.read(cx).frozen() {
            return;
        }
        let action = match self.submission(cx) {
            Ok(action) => action,
            Err(error) => {
                self.error = Some(error);
                cx.notify();
                return;
            }
        };
        self.dispatch(action, cx);
    }
    fn dispatch(&mut self, action: DraftAction, cx: &mut Context<Self>) {
        self.busy = true;
        let backend = self.session.read(cx).backend.clone();
        let task = self
            .editors
            .update(cx, |editors, _| editors.action(&self.key, action));
        run(&backend, cx, task, |this, result, cx| {
            this.busy = false;
            match result {
                Ok(DraftOutcome::Saved(warning)) => {
                    this.done = true;
                    this.error = warning;
                    this.session.update(cx, |session, cx| session.refresh(cx));
                }
                Ok(DraftOutcome::Rebound) => {
                    this.error = None;
                    this.rebind_preview = None;
                }
                Err(error) => this.error = Some(error),
            }
        });
    }
    fn rebind(&mut self, cx: &mut Context<Self>) {
        let ja = self.session.read(cx).text("ja", "en") == "ja";
        let t =
            move |ja_text: &'static str, en_text: &'static str| if ja { ja_text } else { en_text };
        if self.busy || self.editors.read(cx).frozen() {
            return;
        }
        let Some(options) = self.editors.read(cx).options(&self.key).cloned() else {
            return;
        };
        self.busy = true;
        let backend = self.session.read(cx).backend.clone();
        let state = backend.state.clone();
        run(
            &backend,
            cx,
            async move {
                let all = crate::commands::subtitles::list_segments(&state, options.media_id)?;
                options
                    .source_cues
                    .iter()
                    .map(|source| {
                        all.iter()
                            .find(|cue| cue.id == source.id)
                            .cloned()
                            .ok_or_else(|| {
                                t(
                                    "元の字幕が見つかりません。字幕を選び直してください",
                                    "Select the new subtitle source",
                                )
                                .to_owned()
                            })
                    })
                    .collect::<Result<Vec<_>, _>>()
            },
            |this, result, _| {
                this.busy = false;
                match result {
                    Ok(cues) => this.rebind_preview = Some(cues),
                    Err(error) => this.error = Some(error),
                }
            },
        );
    }
}
impl Render for SourceForm {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let ja = self.session.read(cx).text("ja", "en") == "ja";
        let t =
            move |ja_text: &'static str, en_text: &'static str| if ja { ja_text } else { en_text };
        let view = self.editors.read(cx).view(&self.key);
        let ready = view.is_some_and(|view| view.ready);
        let stale = view.is_some_and(|view| view.draft.as_ref().is_some_and(|draft| draft.stale));
        let disabled = self.busy || self.done || !ready || self.editors.read(cx).frozen();
        let error = self
            .error
            .clone()
            .or_else(|| view.and_then(|view| view.error.clone()));
        let source = view
            .and_then(|view| {
                view.draft
                    .as_ref()
                    .map(|view| view.draft.source_cues.clone())
            })
            .or_else(|| {
                self.editors
                    .read(cx)
                    .options(&self.key)
                    .map(|options| options.source_cues.clone())
            })
            .unwrap_or_default();
        let is_subtitle = self
            .editors
            .read(cx)
            .options(&self.key)
            .is_some_and(|options| options.kind == "subtitle");
        let field = |name: &str, label: &'static str, height: f32| {
            column()
                .gap_1()
                .flex_shrink_0()
                .min_w_0()
                .child(div().text_size(px(14.)).child(label))
                .children(self.inputs.get(name).map(|input| {
                    Textarea::new(input)
                        .accessibility_id(format!("source-{name}"))
                        .aria_label(label)
                        .disabled(disabled)
                        .h(px(height))
                }))
        };
        super::keyboard::form_tab_navigation(column())
            .id("source-editor")
            .size_full()
            .gap_0()
            .bg(cx.theme().background)
            .text_color(cx.theme().foreground)
            .child(column().flex_shrink_0().px_5().py_4().gap_1()
                .border_b_1().border_color(cx.theme().border)
                .child(div().text_size(px(20.)).font_weight(gpui_kit::FontWeight::SEMIBOLD)
                    .child(if is_subtitle { t("字幕を編集", "Edit subtitle") } else { t("フレーズを保存", "Save phrase") }))
                .child(muted(if is_subtitle {
                    t("原音と照らして字幕と翻訳を確認します。", "Check the subtitle and translation against the source audio.")
                } else {
                    t("音声と元の文脈を残して、覚えておきたい表現を復習します。", "Keep audio and original context with a phrase worth remembering.")
                })))
            .child(column().id("source-editor-scroll").flex_1().min_h_0().overflow_y_scroll().p_5().gap_4()
            .when(is_subtitle, |body| body.child(column().gap_2().p_3().rounded(px(8.)).border_1().border_color(cx.theme().border)
                .child(muted(t("元の字幕・出典", "Original subtitle and source")))
                .children(source.iter().map(|cue|div().child(format!("{}–{}  {}", precise(cue.start_ms), precise(cue.end_ms), cue.text))))
                .when(source.iter().any(|cue|cue.timing_precision=="source_block"), |body|body.child(muted(t("この時刻は取得元の音声範囲です。本文の修正だけでは正確な字幕時刻には変わりません。", "These times identify the source audio range; editing text does not establish precise subtitle timing."))))))
            .when(is_subtitle, |body|body
                .children(source.iter().flat_map(|cue|cue.review_issues.iter()).enumerate().map(|(issue_index, issue)| {
                    column().p_3().border_1().border_color(cx.theme().border)
                        .child(muted(format!("{}–{} · {}", precise(issue.start_ms), precise(issue.end_ms), match issue.kind.as_str() { "boundary_conflict" => t("境界で候補が一致していません", "Conflicting boundary alternatives"), "forced_chunk_boundary" => t("休止のない位置で分割しました。欠落・重複を原音で確認してください", "Split without a pause; check missing or repeated words"), _ => t("生成結果を確認してください", "Check the generated result") })))
                        .children(issue.alternatives.iter().enumerate().map(|(index, alternative)| {
                            let alternative = alternative.clone();
                            column().child(div().child(format!("{}–{}  {}", precise(alternative.start_ms), precise(alternative.end_ms), alternative.text)))
                                .child(compact_button(format!("source-alternative-{issue_index}-{index}")).ghost().accessibility_id(format!("source-alternative-{issue_index}-{index}")).label(t("この候補を使う", "Use this alternative")).disabled(disabled||stale).on_click(cx.listener(move |this,_,_,cx|this.use_alternative(&alternative,cx))))
                        }))
                }))
                .child(compact_button("source-retranscribe").ghost().accessibility_id("source-retranscribe").label(t("この区間を再文字起こし", "Transcribe this range again")).disabled(disabled||stale).on_click(cx.listener(|this,_,window,cx|this.retranscribe(window,cx)))))
            .when(is_subtitle, |body| body
                .child(row().items_start().flex_shrink_0()
                    .child(field("start", t("開始", "From"), 40.).flex_1())
                    .child(field("end", t("終了", "To"), 40.).flex_1()))
                .child(field("text", t("字幕", "Subtitle"), 112.))
                .child(field("translation", t("翻訳", "Translation"), 88.)))
            .when(!is_subtitle, |body| body
                .child(field("term", t("語彙・フレーズ", "Word or phrase"), 40.))
                .child(field("meaning", t("意味", "Meaning"), 72.))
                .child(field("example", t("例文・元の文脈", "Example and original context"), 96.))
                .child(field("explanation", t("解説・メモ（任意）", "Explanation or notes (optional)"), 72.))
                .child(column().gap_2().p_3().rounded(px(8.)).border_1().border_color(cx.theme().border)
                    .child(muted(t("復習に残す音声と出典", "Audio and source for review")))
                    .children(source.iter().map(|cue| div().child(format!("{}–{}  {}", precise(cue.start_ms), precise(cue.end_ms), cue.text))))
                    .when(self.inputs.contains_key("audioStart"), |body| body
                        .child(muted(t("発話の正確な時刻は未確定です。取得元の範囲内で、保存する音声を選んでください（3分以内）。", "Exact speech timing is unavailable. Select up to 3 minutes within the source audio range to save.")))
                        .child(row().items_start().flex_shrink_0()
                            .child(field("audioStart", t("音声の開始", "Audio from"), 40.).flex_1())
                            .child(field("audioEnd", t("音声の終了", "Audio to"), 40.).flex_1())))))
            .when(stale, |body| {
                body.child(
                    div().child(t("出典が変わっています。関連付け前に現在の字幕を確認してください。", "The source changed. Review the current subtitles before rebinding.")),
                )
            })
            .when(!self.done, |body| {
                body.child(
                    compact_button("inspect-source").ghost().accessibility_id("inspect-source")
                        .label(t("現在の出典を確認", "Review current source"))
                        .disabled(disabled)
                        .on_click(cx.listener(|this, _, _, cx| this.rebind(cx))),
                )
            })
            .when_some(self.rebind_preview.clone(), |body, cues| {
                body.child(
                    column()
                        .p_3()
                        .border_1()
                        .border_color(cx.theme().border)
                        .children(cues.iter().map(|cue| {
                            div().child(format!(
                                "{}–{}  {}",
                                precise(cue.start_ms),
                                precise(cue.end_ms),
                                cue.text
                            ))
                        }))
                        .child(
                            compact_button("rebind-source").accessibility_id("rebind-source")
                                .label(t("この出典に関連付ける", "Use this source"))
                                .disabled(disabled)
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.dispatch(DraftAction::Rebind(cues.clone()), cx)
                                })),
                        ),
                )
            })
            .when_some(error, |body, error| {
                body.child(div().text_color(cx.theme().danger).child(error))
            }))
            .child(
                column().flex_shrink_0().px_5().py_4().gap_3().border_t_1().border_color(cx.theme().border)
                    .child(muted(if self.done {
                        t("保存しました", "Saved")
                    } else if !ready {
                        t("下書きを読み込み中…", "Loading draft…")
                    } else if view.is_some_and(|view| view.saving) {
                        t("下書きを保存中…", "Saving draft…")
                    } else {
                        t("入力は自動保存されます。あとで続けることもできます。", "Your input is saved automatically. You can continue later.")
                    }))
                    .child(row().justify_end()
                    .child(
                        button("close-source").accessibility_id("close-source")
                            .label(if self.done { t("閉じる", "Close") } else { t("あとで続ける", "Continue later") })
                            .disabled(self.busy)
                            .on_click(|_, window, _| window.remove_window()),
                    )
                    .child(
                        button("save-source").accessibility_id("save-source")
                            .primary()
                            .label(if is_subtitle { t("内容を確認して保存", "Confirm and save") } else { t("フレーズを保存", "Save phrase") })
                            .disabled(disabled || stale)
                            .on_click(cx.listener(|this, _, _, cx| this.save(cx))),
                    )),
            )
    }
}
fn nonempty(value: String) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_owned())
}
fn precise(ms: u64) -> String {
    format!("{}.{:03}", super::library::timestamp(ms), ms % 1000)
}
fn parse_time(raw: &str) -> Option<u64> {
    let raw = raw.trim();
    let (whole, fraction) = raw.split_once('.').unwrap_or((raw, ""));
    if raw.ends_with('.')
        || fraction.len() > 3
        || !fraction.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    let parts: Vec<_> = whole.split(':').collect();
    if !(1..=3).contains(&parts.len()) {
        return None;
    }
    let mut seconds = 0u64;
    for (index, part) in parts.iter().enumerate() {
        if part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        let value = part.parse::<u64>().ok()?;
        if index > 0 && (part.len() > 2 || value >= 60) {
            return None;
        }
        seconds = seconds.checked_mul(60)?.checked_add(value)?;
    }
    let milliseconds = if fraction.is_empty() {
        0
    } else {
        fraction.parse::<u64>().ok()? * 10u64.pow(3 - fraction.len() as u32)
    };
    seconds.checked_mul(1000)?.checked_add(milliseconds)
}
