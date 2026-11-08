// SPDX-License-Identifier: GPL-3.0-or-later
//! Retained companion panels. A tab always presents its corresponding content;
//! an intentional edit/review action may open the existing owned dialog.
use super::*;
use crate::application::ai::VocabularyCandidate;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum CompanionTab {
    Transcript,
    Transcription,
    Suggestions,
    Tools,
    Meaning,
}

pub(super) struct BoundCandidate {
    value: VocabularyCandidate,
    cues: Vec<SubtitleSegment>,
    media_signature: String,
}

impl StudyView {
    pub(super) fn tools_panel(&self, cx: &mut Context<Self>) -> gpui_kit::Stateful<gpui_kit::Div> {
        let ja = self.session.read(cx).text("ja", "en") == "ja";
        let t = |ja_text, en_text| if ja { ja_text } else { en_text };
        let frozen = self.sources.read(cx).frozen();
        let jobs = self
            .session
            .read(cx)
            .snapshot
            .as_ref()
            .map(|snapshot| {
                snapshot
                    .jobs
                    .iter()
                    .filter(|job| job.media_id.as_deref() == Some(self.media_id.as_str()))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        column()
            .id("study-tools-panel")
            .flex_1()
            .min_h(px(0.))
            .overflow_y_scroll()
            .p_4()
            .gap_4()
            .child(
                div()
                    .text_size(px(16.))
                    .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                    .child(t("この教材の処理", "Activity for this media")),
            )
            .when(jobs.is_empty(), |body| {
                body.child(muted(t(
                    "実行中の処理はありません。",
                    "No activity for this media.",
                )))
            })
            .children(jobs.into_iter().map(|job| {
                let id = job.id.clone();
                compact_button(format!("study-job-{id}"))
                    .label(format!("{} · {}", job.kind, job.status))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.session
                            .update(cx, |_, cx| cx.emit(UiEvent::OpenAiJob(id.clone())))
                    }))
            }))
            .child(
                div()
                    .pt_4()
                    .border_t_1()
                    .border_color(cx.theme().border)
                    .text_size(px(16.))
                    .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                    .child(t("教材と字幕", "Media and subtitles")),
            )
            .child(
                button("manage-media")
                    .icon(IconName::Settings2)
                    .accessibility_id("study-manage-media")
                    .label(t("教材の管理", "Manage media"))
                    .disabled(frozen)
                    .on_click(cx.listener(|this, _, _, cx| {
                        let id = this.media_id.clone();
                        this.session
                            .update(cx, |session, cx| session.manage_media(id, cx));
                    })),
            )
            .child(
                button("study-export")
                    .icon(IconName::Download)
                    .accessibility_id("study-export")
                    .label(t("字幕を書き出す", "Export subtitles"))
                    .disabled(frozen)
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.session
                            .update(cx, |session, cx| session.request_transfer(cx))
                    })),
            )
            .child(
                button("draft-study")
                    .icon(IconName::FileText)
                    .label(t("受信テキスト・下書き", "Received text and drafts"))
                    .disabled(frozen)
                    .on_click(cx.listener(|this, _, _, cx| {
                        let id = this.media_id.clone();
                        this.session
                            .update(cx, |session, cx| session.request_draft_study(id, cx));
                    })),
            )
    }

    fn current_media_signature(&self, cx: &gpui_kit::App) -> Option<String> {
        let snapshot = self.session.read(cx).snapshot.as_ref()?;
        let media = snapshot
            .media
            .iter()
            .find(|media| media.id == self.media_id)?;
        serde_json::to_string(&(
            &media.path,
            media.audio_stream_index,
            &media.learning_language,
            &media.explanation_language,
        ))
        .ok()
    }
    fn meaning_candidate(&self, cx: &gpui_kit::App) -> Option<usize> {
        if self.meaning_stale(cx) {
            return None;
        }
        let term = self.meaning_term.clone().unwrap_or_else(|| {
            self.meaning_cues
                .iter()
                .map(|cue| cue.text.as_str())
                .collect::<Vec<_>>()
                .join(" ")
        });
        self.candidates.iter().position(|candidate| {
            candidate_matches(
                candidate,
                &self.meaning_cues,
                &term,
                &self.meaning_signature,
            )
        })
    }
    pub(super) fn refresh_meaning_projection(&mut self, cx: &gpui_kit::App) {
        if self.meaning_waiting
            && !self.meaning_stale(cx)
            && (self.meaning_candidate(cx).is_some()
                || self.meaning_cues.iter().any(|saved| {
                    self.segments
                        .iter()
                        .find(|cue| cue.id == saved.id)
                        .is_some_and(|cue| {
                            cue.translation
                                .as_ref()
                                .is_some_and(|text| !text.is_empty())
                        })
                }))
        {
            self.meaning_visible = true;
            self.meaning_waiting = false;
        }
    }
    pub(super) fn open_meaning(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.sources.read(cx).frozen() {
            return;
        }
        let (cues, term) = if let Some((cue, text)) = self.selected_text(window, cx) {
            (vec![cue], Some(text))
        } else {
            let indices = if self.selected.is_empty() {
                self.current_caption(cx).into_iter().collect::<Vec<_>>()
            } else {
                self.selected.iter().copied().collect()
            };
            (
                indices
                    .into_iter()
                    .filter_map(|index| self.segments.get(index).cloned())
                    .collect(),
                None,
            )
        };
        if cues.is_empty() {
            return;
        }
        self.meaning_signature = self.current_media_signature(cx).unwrap_or_default();
        self.meaning_cues = cues;
        self.meaning_term = term;
        let player = &self.session.read(cx).player;
        self.meaning_resume = player.position_ms;
        self.meaning_visible = true;
        self.control("pause", None, cx);
        self.companion_open = true;
        self.companion_tab = CompanionTab::Meaning;
        cx.notify();
    }

    fn meaning_stale(&self, cx: &gpui_kit::App) -> bool {
        if self.current_media_signature(cx).as_deref() != Some(self.meaning_signature.as_str()) {
            return true;
        }
        self.meaning_cues.iter().any(|saved| {
            !self.segments.iter().any(|current| {
                saved.id == current.id
                    && saved.start_ms == current.start_ms
                    && saved.end_ms == current.end_ms
                    && saved.text == current.text
                    && saved.status == current.status
                    && saved.timing_precision == current.timing_precision
            })
        })
    }

    fn meaning_ai(&mut self, kind: super::super::ai::AiKind, cx: &mut Context<Self>) {
        if self.meaning_stale(cx) || self.meaning_cues.is_empty() || self.sources.read(cx).frozen()
        {
            return;
        }
        let cues = self.meaning_cues.clone();
        let intent = super::super::ai::AiIntent {
            media_id: self.media_id.clone(),
            kind,
            start_ms: cues.first().unwrap().start_ms,
            end_ms: cues.last().unwrap().end_ms,
            focus_term: Some(self.meaning_term.clone().unwrap_or_else(|| {
                self.meaning_cues
                    .iter()
                    .map(|cue| cue.text.as_str())
                    .collect::<Vec<_>>()
                    .join(" ")
            })),
        };
        self.meaning_waiting = true;
        self.session
            .update(cx, |_, cx| cx.emit(UiEvent::Ai { intent, cues }));
    }

    pub(super) fn edit_meaning(&mut self, kind: &str, cx: &mut Context<Self>) {
        if self.meaning_stale(cx) || self.sources.read(cx).frozen() {
            return;
        }
        if kind == "phrase"
            && let Some(index) = self.meaning_candidate(cx)
        {
            self.prepare_suggestion(index, cx);
            return;
        }
        if let Err(error) = super::super::source_form::open_with_term(
            self.session.clone(),
            self.sources.clone(),
            kind,
            self.meaning_cues.clone(),
            self.meaning_term.clone(),
            cx,
        ) {
            self.error = Some(error.to_string());
            cx.notify();
        }
    }

    pub(super) fn meaning_panel(
        &self,
        cx: &mut Context<Self>,
    ) -> gpui_kit::Stateful<gpui_kit::Div> {
        let ja = self.session.read(cx).text("ja", "en") == "ja";
        let t = |ja_text, en_text| if ja { ja_text } else { en_text };
        let stale = self.meaning_stale(cx);
        let disabled = self.sources.read(cx).frozen() || stale;
        let playback_disabled = disabled || !self.playback_ready(cx);
        let source = self
            .meaning_cues
            .iter()
            .map(|cue| cue.text.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        let translation = self
            .meaning_cues
            .iter()
            .filter_map(|saved| {
                self.segments
                    .iter()
                    .find(|cue| cue.id == saved.id)
                    .and_then(|cue| cue.translation.as_deref())
            })
            .collect::<Vec<_>>()
            .join(" ");
        let candidate = self
            .meaning_candidate(cx)
            .map(|index| &self.candidates[index].value);
        let meaning = candidate
            .map(|candidate| candidate.meaning.clone())
            .unwrap_or_default();
        let explanation = candidate
            .map(|candidate| candidate.explanation.clone())
            .unwrap_or_default();
        let range = self
            .meaning_cues
            .first()
            .zip(self.meaning_cues.last())
            .map(|(first, last)| (first.start_ms, last.end_ms));
        column().id("study-meaning-panel").flex_1().min_h(px(0.)).overflow_y_scroll().p_5().gap_4()
            .child(compact_button("meaning-back-transcript").ghost().icon(IconName::ArrowLeft).label(t("字幕一覧へ戻る", "Back to transcript"))
                .on_click(cx.listener(|this, _, _, cx| {this.companion_tab = CompanionTab::Transcript; cx.notify();})))
            .when(stale, |body| body.child(div().text_color(cx.theme().warning).child(t("出典の字幕が変わりました。字幕や表現を選び直してください。", "The source subtitles changed. Select the subtitles or phrase again."))))
            .child(div().text_size(px(21.)).line_height(gpui_kit::relative(1.65)).child(gpui_kit::base::SelectableText::new("meaning-source", source)))
            .when_some(self.meaning_term.clone(), |body, term| body.child(div().text_size(px(18.)).pl_3().border_l_2().border_color(cx.theme().primary).text_color(cx.theme().primary).child(term)))
            .child(compact_button("toggle-meaning").ghost().label(if self.meaning_visible {t("意味を閉じる", "Hide meaning")} else {t("意味を見る", "Show meaning")})
                .on_click(cx.listener(|this, _, _, cx| {this.meaning_visible = !this.meaning_visible; cx.notify();})))
            .when(self.meaning_visible, |body| body.child(column().gap_3().text_size(px(15.)).line_height(gpui_kit::relative(1.8))
                .when(!meaning.is_empty(),|body|body.child(div().id("meaning-definition").test_support().role(gpui_kit::Role::Paragraph).aria_label(meaning.clone()).child(meaning)))
                .when(!translation.is_empty(),|body|body.child(div().id("meaning-translation").test_support().role(gpui_kit::Role::Paragraph).aria_label(translation.clone()).child(translation)))
                .when(!explanation.is_empty(),|body|body.child(div().id("meaning-explanation").test_support().role(gpui_kit::Role::Paragraph).aria_label(explanation.clone()).child(explanation)))
                .when(candidate.is_none() && self.meaning_cues.iter().all(|saved|self.segments.iter().find(|cue|cue.id==saved.id).is_none_or(|cue|cue.translation.as_ref().is_none_or(|text|text.is_empty()))), |body|body.child(div().child(t("訳や解説はまだありません。意味を入力して保存するか、AIへの依頼を見積もれます。", "No meaning or explanation yet. Enter a meaning to save, or request an AI estimate."))))))
            .child(row().flex_wrap().gap_2()
                .child(compact_button("meaning-play-range").icon(IconName::Play).label(t("この区間を再生", "Play this passage")).disabled(playback_disabled)
                    .on_click(cx.listener(|this, _, _, cx| this.play_cues(this.meaning_cues.iter().map(|cue| cue.id.clone()).collect(), cx))))
                .when_some(range, |body, (start,end)| body.child(muted(format!("{}.{:03}–{}.{:03}", timestamp(start), start % 1000, timestamp(end), end % 1000))))
                .child(compact_button("meaning-loop-range").icon(IconName::Repeat).label(t("区間リピート", "Repeat passage")).disabled(playback_disabled)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if this.looping.is_some() {this.set_loop(None,cx);} else {
                            this.loop_source = Some(this.meaning_cues.clone());
                            this.set_loop(range,cx);
                        }
                    }))))
            .child(row().flex_wrap().gap_2()
                .child(compact_button("ai-explanation").ghost().icon(IconName::Sparkles).label(t("意味を調べる", "Explain this phrase")).disabled(disabled)
                    .on_click(cx.listener(|this, _, _, cx| this.meaning_ai(super::super::ai::AiKind::Explanation, cx))))
                .child(compact_button("ai-translate").ghost().icon(IconName::Languages).label(t("翻訳する", "Translate")).disabled(disabled)
                    .on_click(cx.listener(|this, _, _, cx| this.meaning_ai(super::super::ai::AiKind::Translation, cx))))
                .child(compact_button("edit-subtitle").ghost().icon(IconName::Pencil).label(t("字幕を編集", "Edit subtitle")).disabled(disabled || self.meaning_cues.len()!=1)
                    .on_click(cx.listener(|this, _, _, cx| this.edit_meaning("subtitle", cx)))))
            .child(button("save-meaning-phrase").primary().icon(IconName::BookmarkPlus).label(t("フレーズを保存", "Save phrase")).mt_4().w_full().disabled(disabled)
                .on_click(cx.listener(|this, _, _, cx| this.edit_meaning("phrase", cx))))
            .child(button("meaning-resume").icon(IconName::Play).label(t("元の位置から再生を再開", "Resume from the original position")).mt_6().w_full().disabled(playback_disabled)
                .on_click(cx.listener(|this, _, _, cx| {
                    this.set_loop(None,cx);
                    this.control("seek",Some(this.meaning_resume as f64),cx);
                    this.control("play",None,cx);
                    this.companion_tab = CompanionTab::Transcript;
                    cx.notify();
                })))
    }

    pub(super) fn refresh_candidates(&mut self, cx: &mut Context<Self>) {
        if self.candidates_loading {
            return;
        }
        self.candidates_loading = true;
        let backend = self.session.read(cx).backend.clone();
        let state = backend.state.clone();
        let media_id = self.media_id.clone();
        run(
            &backend,
            cx,
            async move {
                let before = commands::synchronization::get_change_checkpoint(&state)?;
                let snapshot = commands::ai::get_app_snapshot(&state)?;
                let media = snapshot
                    .media
                    .iter()
                    .find(|media| media.id == media_id)
                    .ok_or_else(|| "The source media is missing".to_string())?;
                let media_signature = serde_json::to_string(&(
                    &media.path,
                    media.audio_stream_index,
                    &media.learning_language,
                    &media.explanation_language,
                ))
                .map_err(|error| error.to_string())?;
                // Capture source before reading candidates, then require one stable
                // checkpoint. Never bind an earlier candidate to replacement cues.
                let source = commands::subtitles::list_segments(&state, media_id.clone())?;
                let candidates = commands::ai::list_vocabulary_candidates(&state, media_id)?;
                if before != commands::synchronization::get_change_checkpoint(&state)? {
                    return Err("Source data changed; refresh suggestions before saving".into());
                }
                candidates
                    .into_iter()
                    .map(|value| {
                        let ids = if value.source_cue_ids.is_empty() {
                            vec![value.segment_id.clone()]
                        } else {
                            value.source_cue_ids.clone()
                        };
                        let cues =
                            ids.iter()
                                .map(|id| {
                                    source.iter().find(|cue| &cue.id == id).cloned().ok_or_else(
                                        || {
                                            "Candidate source is missing; refresh suggestions"
                                                .to_string()
                                        },
                                    )
                                })
                                .collect::<Result<Vec<_>, String>>()?;
                        Ok(BoundCandidate {
                            value,
                            cues,
                            media_signature: media_signature.clone(),
                        })
                    })
                    .collect::<Result<Vec<_>, String>>()
            },
            |this, result, cx| {
                this.candidates_loading = false;
                match result {
                    Ok(candidates) => {
                        this.candidates = candidates;
                        this.candidates_error = None;
                    }
                    Err(error) => {
                        this.candidates.clear();
                        this.candidates_error = Some(error);
                    }
                }
                this.refresh_meaning_projection(cx);
            },
        );
    }

    fn prepare_suggestion(&mut self, index: usize, cx: &mut Context<Self>) {
        if self.candidate_busy || self.sources.read(cx).frozen() {
            return;
        }
        let Some(candidate) = self.candidates.get(index) else {
            return;
        };
        let value = candidate.value.clone();
        let cues = candidate.cues.clone();
        let signature = candidate.media_signature.clone();
        self.candidate_busy = true;
        let receiver = self.session.update(cx, |session, cx| {
            session.prepare_candidate(value, cues, signature, cx)
        });
        // The root gate drains normal run() operations. Await its reply directly
        // so this UI request cannot wait for itself inside that gate.
        cx.spawn(async move |view, cx| {
            let result = receiver
                .await
                .unwrap_or_else(|_| Err("Candidate editor request interrupted".into()));
            let _ = view.update(cx, |this, cx| {
                this.candidate_busy = false;
                match result {
                    Ok(draft) => this
                        .session
                        .update(cx, |session, cx| session.open_source_draft(draft, cx)),
                    Err(error) => this.candidates_error = Some(error),
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub(super) fn companion_tabs(
        &self,
        cx: &mut Context<Self>,
    ) -> gpui_kit::component::tab::TabBar {
        use gpui_kit::component::tab::{Tab, TabBar};
        let ja = self.session.read(cx).text("ja", "en") == "ja";
        let selected = match self.companion_tab {
            CompanionTab::Transcription => 1,
            CompanionTab::Suggestions => 2,
            _ => 0,
        };
        TabBar::new("study-companion-tabs")
            .underline()
            .selected_index(selected)
            .px_4()
            .h(px(44.))
            .text_size(px(13.))
            .children(
                [
                    if ja { "字幕" } else { "Transcript" },
                    if ja {
                        "文字起こし"
                    } else {
                        "Transcription"
                    },
                    if ja { "AI の提案" } else { "AI suggestions" },
                ]
                .into_iter()
                .map(|label| Tab::new().label(label)),
            )
            .on_click(cx.listener(|this, index: &usize, _, cx| {
                this.companion_tab = match index {
                    1 => CompanionTab::Transcription,
                    2 => CompanionTab::Suggestions,
                    _ => CompanionTab::Transcript,
                };
                this.companion_open = true;
                if this.companion_tab == CompanionTab::Suggestions {
                    this.refresh_candidates(cx);
                }
                cx.notify();
            }))
    }

    pub(super) fn transcription_panel(
        &self,
        cx: &mut Context<Self>,
    ) -> gpui_kit::Stateful<gpui_kit::Div> {
        let ja = self.session.read(cx).text("ja", "en") == "ja";
        let t = |ja_text, en_text| if ja { ja_text } else { en_text };
        let jobs = self
            .session
            .read(cx)
            .snapshot
            .as_ref()
            .map(|snapshot| {
                snapshot
                    .jobs
                    .iter()
                    .filter(|job| {
                        job.media_id.as_deref() == Some(self.media_id.as_str())
                            && (job.kind == "transcribe" || job.automatic_transcript)
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        column()
            .id("study-transcription-panel")
            .flex_1()
            .min_h(px(0.))
            .overflow_y_scroll()
            .p_4()
            .gap_4()
            .child(
                div()
                    .text_size(px(16.))
                    .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                    .child(t("文字起こし", "Transcription")),
            )
            .child(muted(t(
                "音声から字幕を作成し、結果と区切りを確認します。",
                "Create subtitles from audio, then review the text and boundaries.",
            )))
            .child(
                button("ai-transcription")
                    .icon(IconName::AudioLines)
                    .label(t("音声から字幕を作成", "Create subtitles from audio"))
                    .disabled(self.sources.read(cx).frozen())
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.request_ai(super::super::ai::AiKind::Transcription, window, cx)
                    })),
            )
            .when(jobs.is_empty(), |body| {
                body.child(muted(t(
                    "この教材の文字起こし履歴はありません。",
                    "No transcription history for this media.",
                )))
            })
            .children(jobs.into_iter().map(|job| {
                let id = job.id.clone();
                let state = match job.status.as_str() {
                    "completed" => t("完了", "Completed"),
                    "running" => t("実行中", "Running"),
                    "queued" => t("待機中", "Queued"),
                    "paused" => t("一時停止", "Paused"),
                    "cancelled" => t("中止", "Cancelled"),
                    "failed" => t("失敗", "Failed"),
                    _ => t("確認が必要", "Needs review"),
                };
                column()
                    .gap_2()
                    .pb_4()
                    .border_b_1()
                    .border_color(cx.theme().border)
                    .child(
                        row()
                            .justify_between()
                            .child(div().text_size(px(14.)).child(state))
                            .child(
                                muted(format!("{:.0}%", job.progress * 100.))
                                    .w(px(40.))
                                    .flex_shrink_0()
                                    .text_right()
                                    .font_features(tabular_numbers()),
                            ),
                    )
                    .child(
                        div()
                            .id(format!("transcript-job-message-{}", id))
                            .h(px(40.))
                            .flex_shrink_0()
                            .overflow_y_scroll()
                            .text_size(px(13.))
                            .line_height(px(20.))
                            .text_color(cx.theme().muted_foreground)
                            .when_some(job.message.clone(), |body, message| {
                                body.child(gpui_kit::base::SelectableText::new(
                                    format!("transcript-job-message-text-{}", id),
                                    message,
                                ))
                            }),
                    )
                    .child(muted(job.created_at.clone()))
                    .child(
                        compact_button(format!("transcript-job-{}", id))
                            .label(t("結果・処理を確認", "Review result and activity"))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.session
                                    .update(cx, |_, cx| cx.emit(UiEvent::OpenAiJob(id.clone())))
                            })),
                    )
            }))
    }

    pub(super) fn suggestions_panel(
        &self,
        cx: &mut Context<Self>,
    ) -> gpui_kit::Stateful<gpui_kit::Div> {
        let ja = self.session.read(cx).text("ja", "en") == "ja";
        let t = |ja_text, en_text| if ja { ja_text } else { en_text };
        column().id("study-suggestions-panel").flex_1().min_h(px(0.)).gap_0()
            .child(row().p_3().gap_2().flex_wrap()
                .child(compact_button("ai-vocabulary").ghost().icon(IconName::Sparkles).label(t("候補を見積もる", "Estimate suggestions"))
                    .disabled(self.sources.read(cx).frozen()).on_click(cx.listener(|this, _, window, cx| this.request_ai(super::super::ai::AiKind::Vocabulary, window, cx))))
                .child(icon_button("refresh-suggestions", IconName::RefreshCw, t("候補を更新", "Refresh suggestions"))
                    .disabled(self.candidates_loading).on_click(cx.listener(|this, _, _, cx| this.refresh_candidates(cx)))))
            .when_some(self.candidates_error.clone(), |body, error| body.child(div().p_3().text_color(cx.theme().danger).child(error)))
            .child(column().id("study-suggestions-scroll").flex_1().min_h(px(0.)).overflow_y_scroll().gap_0()
                .when(self.candidates.is_empty(), |body| body.child(column().p_5().gap_2()
                    .child(div().text_size(px(18.)).child(if self.candidates_loading {t("読み込み中…", "Loading…")} else {t("候補はまだありません", "No suggestions yet")}))
                    .child(muted(t("字幕から学びたい言葉やフレーズの候補を作成できます。", "Estimate vocabulary and phrase suggestions from the subtitles.")))))
                .children(self.candidates.iter().enumerate().map(|(index, candidate)| {
                    let value = &candidate.value;
                    column().p_5().gap_2().border_b_1().border_color(cx.theme().border)
                        .child(div().text_size(px(20.)).font_weight(gpui_kit::FontWeight::MEDIUM).child(value.term.clone()))
                        .child(div().text_size(px(15.)).child(value.meaning.clone()))
                        .child(div().pl_3().my_2().border_l_2().border_color(cx.theme().border)
                            .child(gpui_kit::base::SelectableText::new(format!("suggestion-example-{}", value.id), value.example.clone())))
                        .when(!value.explanation.is_empty(), |body| body.child(muted(value.explanation.clone())))
                        .child(compact_button(format!("save-suggestion-{}", value.id)).icon(IconName::BookmarkPlus).label(t("確認して保存", "Review and save"))
                            .disabled(self.candidate_busy || self.sources.read(cx).frozen())
                            .on_click(cx.listener(move |this, _, _, cx| this.prepare_suggestion(index, cx))))
                })))
    }
}

fn candidate_matches(
    candidate: &BoundCandidate,
    cues: &[SubtitleSegment],
    term: &str,
    signature: &str,
) -> bool {
    let Some(first) = cues.first() else {
        return false;
    };
    candidate.media_signature == signature
        && candidate.value.term == term
        && candidate.value.media_id == first.media_id
        && candidate.value.segment_id == first.id
        && candidate.cues.len() == cues.len()
        && candidate.cues.iter().zip(cues).all(|(actual, expected)| {
            actual.id == expected.id
                && actual.media_id == expected.media_id
                && actual.start_ms == expected.start_ms
                && actual.end_ms == expected.end_ms
                && actual.text == expected.text
                && actual.status == expected.status
                && actual.timing_precision == expected.timing_precision
        })
}

#[cfg(test)]
mod projection_tests {
    use super::*;

    fn fixture() -> (Vec<SubtitleSegment>, BoundCandidate) {
        let cue = SubtitleSegment {
            id: "source".into(),
            media_id: "media".into(),
            start_ms: 100,
            end_ms: 900,
            text: "Keep the source context.".into(),
            translation: None,
            status: "confirmed".into(),
            timing_precision: "cue".into(),
            review_issues: vec![],
        };
        let value = VocabularyCandidate {
            id: "candidate".into(),
            media_id: cue.media_id.clone(),
            segment_id: cue.id.clone(),
            source_cue_ids: vec![cue.id.clone()],
            start_ms: cue.start_ms,
            end_ms: cue.end_ms,
            term: cue.text.clone(),
            meaning: "A saved definition".into(),
            example: cue.text.clone(),
            explanation: "A saved explanation".into(),
            translation: None,
        };
        (
            vec![cue.clone()],
            BoundCandidate {
                value,
                cues: vec![cue],
                media_signature: "original-audio-and-languages".into(),
            },
        )
    }

    #[test]
    fn meaning_result_projects_only_for_the_original_source_and_focus_term() {
        let (mut cues, candidate) = fixture();
        let term = cues[0].text.clone();
        let signature = "original-audio-and-languages";
        assert!(candidate_matches(&candidate, &cues, &term, signature));
        cues[0].translation = Some("A newly applied translation".into());
        assert!(
            candidate_matches(&candidate, &cues, &term, signature),
            "translation completion keeps source identity"
        );
        assert!(!candidate_matches(
            &candidate,
            &cues,
            "Different selected term",
            signature
        ));
        assert!(!candidate_matches(
            &candidate,
            &cues,
            &term,
            "replacement-audio"
        ));
        cues[0].start_ms += 1;
        assert!(!candidate_matches(&candidate, &cues, &term, signature));
    }

    #[test]
    fn same_ids_do_not_rebind_a_candidate_to_replaced_text_or_media() {
        let (mut cues, candidate) = fixture();
        let term = cues[0].text.clone();
        cues[0].text = "Replacement text with the same cue ID".into();
        assert!(!candidate_matches(
            &candidate,
            &cues,
            &term,
            &candidate.media_signature
        ));
        cues[0] = candidate.cues[0].clone();
        cues[0].media_id = "another-media".into();
        assert!(!candidate_matches(
            &candidate,
            &cues,
            &term,
            &candidate.media_signature
        ));
    }
}
