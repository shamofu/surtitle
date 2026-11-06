// SPDX-License-Identifier: GPL-3.0-or-later
use super::{
    editors::{EditorKey, EditorRegistry, FlushPurpose},
    session::{Route, Session, UiEvent, run},
    style::*,
};
use crate::commands;
use gpui_kit::assets::IconName;
use gpui_kit::base::{Disableable, TestSupportExt};
use gpui_kit::component::{
    ActiveTheme, Icon,
    button::ButtonVariants,
    input::{Input, InputEditsEvent, InputEvent, InputState, Textarea, TextareaState},
    menu::{DropdownMenu, PopupMenuItem},
};
use gpui_kit::{AppContext, Context, Entity, Subscription, Window, div, prelude::*, px, relative};
use std::collections::BTreeMap;
use surtitle_core::StudyCard;

pub(crate) struct CardsView {
    session: Entity<Session>,
    editors: Entity<EditorRegistry>,
    search: Entity<InputState>,
    search_ja: bool,
    review: bool,
    revealed: bool,
    forms: BTreeMap<String, Entity<CardForm>>,
    form_windows: BTreeMap<String, gpui_kit::AnyWindowHandle>,
    busy: bool,
    reviewed: BTreeMap<String, String>,
    error: Option<String>,
    focus: gpui_kit::FocusHandle,
    prompt_focus: gpui_kit::FocusHandle,
    answer_focus: gpui_kit::FocusHandle,
    rating_focus: [gpui_kit::FocusHandle; 4],
    focus_after_rating: Option<gpui_kit::FocusHandle>,
    review_current: Option<String>,
    language: Option<String>,
    due_timer: Option<gpui_kit::Task<()>>,
    next_due: Option<String>,
    expanded: Option<String>,
    list: gpui_kit::ListState,
    list_key: String,
    list_filter: String,
    _subscriptions: Vec<Subscription>,
}
impl CardsView {
    pub fn new(
        session: Entity<Session>,
        editors: Entity<EditorRegistry>,
        review: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let ja = session.read(cx).text("ja", "en") == "ja";
        let t =
            move |ja_text: &'static str, en_text: &'static str| if ja { ja_text } else { en_text };
        let search = cx.new(|cx| {
            InputState::new(window, cx).placeholder(t("フレーズを検索", "Search phrases"))
        });
        let input = cx.subscribe(&search, |_, _, _: &InputEvent, cx| cx.notify());
        let changes = cx.subscribe(&session, |_, _, event: &UiEvent, cx| {
            if matches!(event, UiEvent::Snapshot) {
                cx.notify();
            }
        });
        let editing = cx.observe(&editors, |_, _, cx| cx.notify());
        Self {
            session,
            editors,
            search,
            search_ja: ja,
            review,
            revealed: false,
            forms: BTreeMap::new(),
            form_windows: BTreeMap::new(),
            busy: false,
            reviewed: BTreeMap::new(),
            error: None,
            focus: cx.focus_handle(),
            prompt_focus: cx.focus_handle(),
            answer_focus: cx.focus_handle(),
            rating_focus: std::array::from_fn(|_| cx.focus_handle()),
            focus_after_rating: None,
            review_current: None,
            language: None,
            due_timer: None,
            next_due: None,
            expanded: None,
            list: gpui_kit::ListState::new(0, gpui_kit::ListAlignment::Top, px(600.)),
            list_key: String::new(),
            list_filter: String::new(),
            _subscriptions: vec![input, changes, editing],
        }
    }
    pub fn focus(&self, window: &mut Window, cx: &mut gpui_kit::App) {
        if self.review {
            &self.prompt_focus
        } else {
            &self.focus
        }
        .focus(window, cx);
    }
    fn reveal(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.revealed = true;
        self.answer_focus.focus(window, cx);
        cx.notify();
    }
    fn arm_due_timer(&mut self, cx: &mut Context<Self>) {
        if !self.review {
            return;
        }
        let now = chrono::Utc::now();
        let next = self
            .session
            .read(cx)
            .snapshot
            .as_ref()
            .into_iter()
            .flat_map(|snapshot| &snapshot.cards)
            .filter(|card| !card.suspended)
            .filter_map(|card| {
                chrono::DateTime::parse_from_rfc3339(&card.due_at)
                    .ok()
                    .filter(|due| *due > now)
                    .map(|due| (due, card.due_at.clone()))
            })
            .min_by_key(|(due, _)| *due);
        if next.as_ref().map(|(_, raw)| raw) == self.next_due.as_ref() {
            return;
        }
        self.due_timer.take();
        self.next_due = next.as_ref().map(|(_, raw)| raw.clone());
        if let Some((due, _)) = next {
            let delay = due
                .signed_duration_since(now)
                .to_std()
                .unwrap_or_default()
                .min(std::time::Duration::from_secs(60));
            self.due_timer = Some(cx.spawn(async move |this, cx| {
                cx.background_executor().timer(delay).await;
                let _ = this.update(cx, |this, cx| {
                    this.due_timer = None;
                    this.next_due = None;
                    cx.notify();
                });
            }));
        }
    }
    pub fn open(&mut self, card: String, window: &mut Window, cx: &mut Context<Self>) {
        let ja = self.session.read(cx).text("ja", "en") == "ja";
        let t =
            move |ja_text: &'static str, en_text: &'static str| if ja { ja_text } else { en_text };
        if self.editors.read(cx).frozen() {
            return;
        }
        if !self
            .session
            .read(cx)
            .snapshot
            .as_ref()
            .is_some_and(|snapshot| snapshot.cards.iter().any(|item| item.id == card))
        {
            self.error = Some(
                t(
                    "このフレーズは見つかりません。未完了の入力から内容をコピーできます。",
                    "Phrase not found; copy its unfinished input from recovery.",
                )
                .into(),
            );
            cx.notify();
            return;
        }
        if let Some(handle) = self.form_windows.get(&card)
            && handle
                .update(cx, |_, window, _| window.activate_window())
                .is_ok()
        {
            return;
        }
        let entity = self.form_for(card.clone(), window, cx);
        let size = gpui_kit::size(px(660.), px(720.));
        match gpui_kit::open_window(
            gpui_kit::WindowOptions {
                titlebar: Some(gpui_kit::TitlebarOptions {
                    title: Some(t("フレーズを編集", "Edit phrase").into()),
                    ..Default::default()
                }),
                ..crate::desktop::dialog::options(size, None, cx)
            },
            cx,
            move |window, cx| {
                let closing = entity.downgrade();
                window.on_window_should_close(cx, move |_, cx| {
                    closing
                        .update(cx, |form, cx| {
                            if form.busy || form.editors.read(cx).frozen() {
                                return false;
                            }
                            if let Some(key) = &form.key {
                                form.editors.update(cx, |editors, cx| {
                                    editors.blur(key, cx);
                                });
                            }
                            true
                        })
                        .unwrap_or(true)
                });
                entity
            },
        ) {
            Ok((handle, _)) => {
                self.form_windows.insert(card, handle);
            }
            Err(error) => self.error = Some(error.to_string()),
        }
        cx.notify();
    }
    fn audio(&mut self, id: String, cx: &mut Context<Self>) {
        if self.editors.read(cx).frozen() {
            return;
        }
        let backend = self.session.read(cx).backend.clone();
        let state = backend.state.clone();
        let host = backend.host.clone();
        run(
            &backend,
            cx,
            async move { commands::playback::play_card_audio(host, &state, id).await },
            |this, result, _| this.error = result.err(),
        );
    }
    fn form_for(
        &mut self,
        id: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<CardForm> {
        if let Some(form) = self.forms.get(&id) {
            return form.clone();
        }
        let form = cx.new(|cx| {
            CardForm::new(
                id.clone(),
                self.session.clone(),
                self.editors.clone(),
                window,
                cx,
            )
        });
        self._subscriptions
            .push(cx.observe(&form, |this, form, cx| {
                if let Some(error) = form.read(cx).error.clone() {
                    this.error = Some(error);
                }
                cx.notify();
            }));
        self.forms.insert(id, form.clone());
        form
    }
    fn card_action(
        &mut self,
        id: String,
        delete: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.editors.read(cx).frozen() {
            return;
        }
        let form = self.form_for(id, window, cx);
        form.update(cx, |form, cx| {
            if delete {
                form.delete(cx)
            } else {
                form.suspend(cx)
            }
        });
    }
    fn rate(&mut self, id: String, rating: &str, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy || self.editors.read(cx).frozen() {
            return;
        }
        self.busy = true;
        // Mouse activation can leave focus on navigation. Only the review's
        // own question, answer, or rating control may hand focus to the next card.
        let return_focus = [&self.focus, &self.prompt_focus, &self.answer_focus]
            .into_iter()
            .chain(self.rating_focus.iter())
            .find(|focus| focus.is_focused(window))
            .cloned();
        let rating = rating.to_owned();
        let backend = self.session.read(cx).backend.clone();
        let state = backend.state.clone();
        let reviewed_id = id.clone();
        let previous_due = self
            .session
            .read(cx)
            .snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.cards.iter().find(|card| card.id == id))
            .map(|card| card.due_at.clone())
            .unwrap_or_default();
        run(
            &backend,
            cx,
            async move { commands::cards::rate_card(&state, id, rating) },
            move |this, result, cx| {
                this.busy = false;
                match result {
                    Ok(()) => {
                        this.reviewed.insert(reviewed_id, previous_due);
                        this.revealed = false;
                        this.focus_after_rating = return_focus;
                        this.session.update(cx, |session, cx| session.refresh(cx));
                    }
                    Err(error) => this.error = Some(error),
                }
            },
        );
    }
}
impl Render for CardsView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let ja = self.session.read(cx).text("ja", "en") == "ja";
        let t =
            move |ja_text: &'static str, en_text: &'static str| if ja { ja_text } else { en_text };
        if self.search_ja != ja {
            self.search_ja = ja;
            self.search.update(cx, |input, cx| {
                input.set_placeholder(
                    t(
                        "表現・訳・解説を検索",
                        "Search phrases, translations, notes",
                    ),
                    window,
                    cx,
                )
            });
        }
        self.arm_due_timer(cx);
        let snapshot = self.session.read(cx).snapshot.clone();
        let query = self.search.read(cx).value().trim().to_lowercase();
        let now = chrono::Utc::now();
        let due = move |card: &StudyCard| {
            !card.suspended
                && chrono::DateTime::parse_from_rfc3339(&card.due_at).is_ok_and(|date| date <= now)
        };
        let cards: Vec<StudyCard> = snapshot
            .as_ref()
            .into_iter()
            .flat_map(|s| &s.cards)
            .filter(|card| {
                if self.review {
                    return due(card) && self.reviewed.get(&card.id) != Some(&card.due_at);
                }
                self.language
                    .as_ref()
                    .is_none_or(|language| language == &card.language)
                    && (query.is_empty()
                        || [
                            &card.term,
                            &card.meaning,
                            &card.example,
                            card.translation.as_deref().unwrap_or(""),
                            card.explanation.as_deref().unwrap_or(""),
                            &card.source_title,
                        ]
                        .iter()
                        .any(|text| text.to_lowercase().contains(&query)))
            })
            .cloned()
            .collect();
        let disabled = self.busy || self.editors.read(cx).frozen();
        let theme = cx.theme().clone();
        let gutter = 24.;
        if self.review {
            if let Some(previous_focus) = self.focus_after_rating.take()
                && previous_focus.is_focused(window)
            {
                self.prompt_focus.focus(window, cx);
            }
            let current = cards.first().cloned();
            self.review_current = current.as_ref().map(|card| card.id.clone());
            let total = self.reviewed.len() + cards.len();
            let back = self.session.clone();
            let mut page = column()
                .track_focus(&self.focus)
                .key_context("SurtitleReview")
                .on_key_down(
                    cx.listener(|this, event: &gpui_kit::KeyDownEvent, window, cx| {
                        if event.is_held
                            || !super::keyboard::page_shortcut(
                                event,
                                &[&this.focus, &this.prompt_focus, &this.answer_focus],
                                window,
                            )
                            || this.busy
                            || this.editors.read(cx).frozen()
                        {
                            return;
                        }
                        let Some(id) = this.review_current.clone() else {
                            return;
                        };
                        match event.keystroke.key.as_str() {
                            "space" => this.reveal(window, cx),
                            "1" if this.revealed => this.rate(id, "again", window, cx),
                            "2" if this.revealed => this.rate(id, "hard", window, cx),
                            "3" if this.revealed => this.rate(id, "good", window, cx),
                            "4" if this.revealed => this.rate(id, "easy", window, cx),
                            _ => return,
                        }
                        cx.stop_propagation();
                    }),
                )
                .id("review-scroll")
                .role(gpui_kit::accesskit::Role::Group)
                .aria_label(t("復習", "Review"))
                .size_full()
                .min_h(px(0.))
                .overflow_y_scroll()
                .px(px(gutter))
                .py_4()
                .gap_4()
                .child(
                    row()
                        .justify_between()
                        .gap_4()
                        .child(
                            div().flex_1().child(
                                button("review-back")
                                    .ghost()
                                    .icon(IconName::ArrowLeft)
                                    .label(t("作品に戻る", "Back to watching"))
                                    .on_click(move |_, _, cx| {
                                        back.update(cx, |s, cx| s.navigate(Route::Library, cx))
                                    }),
                            ),
                        )
                        .child(
                            column()
                                .gap_1()
                                .items_center()
                                .child(
                                    div()
                                        .text_size(px(28.))
                                        .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                                        .child(t("復習", "Review")),
                                )
                                .child(muted(t(
                                    "音声と文脈を手がかりに思い出す",
                                    "Recall with audio and context",
                                ))),
                        )
                        .child(
                            div()
                                .flex_1()
                                .text_right()
                                .text_size(px(13.))
                                .text_color(theme.muted_foreground)
                                .child(if ja {
                                    format!("{} / {total} 件", self.reviewed.len())
                                } else {
                                    format!("{} of {total} reviewed", self.reviewed.len())
                                }),
                        ),
                )
                .child(
                    div()
                        .h(px(4.))
                        .w_full()
                        .rounded(px(3.))
                        .bg(theme.secondary)
                        .child(
                            div()
                                .h_full()
                                .w(relative(if total == 0 {
                                    0.
                                } else {
                                    self.reviewed.len() as f32 / total as f32
                                }))
                                .bg(theme.primary),
                        ),
                );
            if let Some(card) = current {
                let source = self.session.clone();
                let media_id = card.media_id.clone();
                let media = snapshot
                    .as_ref()
                    .and_then(|s| s.media.iter().find(|m| m.id == media_id));
                let source_available = media.is_some();
                let source_title =
                    media.map_or_else(|| card.source_title.clone(), |m| m.title.clone());
                let audio_id = card.id.clone();
                let short = window.viewport_size().height < px(760.);
                let mut prompt = column()
                    .gap_3()
                    .px_6()
                    .py(px(if short { 10. } else { 20. }))
                    .child(
                        div()
                            .id("review-prompt")
                            .test_support()
                            .track_focus(&self.prompt_focus)
                            .role(gpui_kit::accesskit::Role::Heading)
                            .aria_level(2)
                            .aria_label(card.term.clone())
                            .when(
                                !self.revealed && !self.prompt_focus.is_focused(window),
                                |prompt| prompt.aria_active_descendant(),
                            )
                            .text_size(px(if short { 26. } else { 34. }))
                            .line_height(relative(1.4))
                            .font_weight(gpui_kit::FontWeight::MEDIUM)
                            .whitespace_normal()
                            .child(card.term.clone()),
                    )
                    .child(
                        div()
                            .text_size(px(if short { 16. } else { 18. }))
                            .line_height(relative(1.8))
                            .whitespace_normal()
                            .child(card.example.clone()),
                    );
                if card.audio_path.is_some() {
                    prompt = prompt.child(
                        div().child(
                            button("review-audio")
                                .ghost()
                                .icon(IconName::AudioLines)
                                .accessibility_id("review-audio")
                                .label(t("文脈を聴く", "Listen in context"))
                                .disabled(disabled)
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.audio(audio_id.clone(), cx)
                                })),
                        ),
                    );
                }
                let answer = if self.revealed {
                    column()
                        .gap_2()
                        .px_6()
                        .py_5()
                        .min_h(px(88.))
                        .bg(theme.secondary)
                        .border_t_1()
                        .border_color(theme.border)
                        .child(
                            div()
                                .text_size(px(12.))
                                .text_color(theme.muted_foreground)
                                .child(t("意味", "Meaning")),
                        )
                        .child(
                            div()
                                .id("review-meaning")
                                .test_support()
                                .track_focus(&self.answer_focus)
                                .role(gpui_kit::accesskit::Role::Label)
                                .aria_value(card.meaning.clone())
                                .text_size(px(18.))
                                .line_height(relative(1.8))
                                .child(card.meaning.clone())
                                .test_support(),
                        )
                        .when_some(card.translation.clone(), |body, text| {
                            body.child(
                                column()
                                    .gap_1()
                                    .mt_2()
                                    .child(muted(t("例文の訳", "Example translation")))
                                    .child(
                                        div()
                                            .id("review-translation")
                                            .role(gpui_kit::accesskit::Role::Label)
                                            .aria_value(text.clone())
                                            .text_size(px(15.))
                                            .line_height(relative(1.8))
                                            .child(text)
                                            .test_support(),
                                    ),
                            )
                        })
                        .when_some(card.explanation.clone(), |body, text| {
                            body.child(
                                column()
                                    .gap_1()
                                    .mt_4()
                                    .pt_4()
                                    .border_t_1()
                                    .border_color(theme.border)
                                    .child(muted(t("解説・メモ", "Explanation and notes")))
                                    .child(
                                        div()
                                            .id("review-explanation")
                                            .role(gpui_kit::accesskit::Role::Label)
                                            .aria_value(text.clone())
                                            .text_size(px(15.))
                                            .line_height(relative(1.8))
                                            .child(text)
                                            .test_support(),
                                    ),
                            )
                        })
                } else {
                    column()
                        .min_h(px(88.))
                        .px_6()
                        .py_5()
                        .items_center()
                        .justify_center()
                        .border_t_1()
                        .border_color(theme.border)
                        .child(
                            button("review-reveal")
                                .primary()
                                .icon(IconName::Eye)
                                .accessibility_id("review-reveal")
                                .label(t("意味を確認する   Space", "Reveal meaning   Space"))
                                .disabled(disabled)
                                .on_click(
                                    cx.listener(|this, _, window, cx| this.reveal(window, cx)),
                                ),
                        )
                };
                let footer = row()
                    .px_6()
                    .py_4()
                    .gap_2()
                    .border_t_1()
                    .border_color(theme.border)
                    .child(
                        button("review-source")
                            .ghost()
                            .icon(IconName::BookOpen)
                            .accessibility_id("review-source")
                            .label(source_title)
                            .disabled(disabled || !source_available)
                            .on_click(move |_, _, cx| {
                                source.update(cx, |s, cx| {
                                    s.navigate(Route::Study(media_id.clone()), cx)
                                })
                            }),
                    )
                    .child(div().flex_1())
                    .child(muted(if ja {
                        format!("{} 回の復習", card.review_count)
                    } else {
                        format!("{} reviews", card.review_count)
                    }));
                page = page.child(
                    column()
                        .flex_1()
                        .min_h(px(360.))
                        .gap_0()
                        .rounded(px(12.))
                        .border_1()
                        .border_color(theme.border)
                        .bg(theme.popover)
                        .overflow_hidden()
                        .child(
                            row()
                                .justify_between()
                                .px_6()
                                .pt_4()
                                .child(phrase_badge(language_name(&card.language, ja), false, cx))
                                .child(
                                    div()
                                        .text_size(px(12.))
                                        .text_color(theme.muted_foreground)
                                        .child(t(
                                            "この表現の意味を思い出す",
                                            "Recall the meaning of this phrase",
                                        )),
                                ),
                        )
                        .child(prompt)
                        .child(
                            answer
                                .flex_1()
                                .id("review-answer-scroll")
                                .min_h(px(64.))
                                .overflow_y_scroll()
                                .test_support(),
                        )
                        .child(footer),
                );
                let id = card.id.clone();
                page = page.child(column().min_h(px(140.)).gap_3().items_center()
                    .child(div().text_size(px(15.)).child(if self.revealed {t("どれくらい思い出せましたか？", "How well did you remember?")} else {t("まずは自分の言葉で意味を思い浮かべて。", "Take a moment to recall the meaning in your own words.")}))
                    .when(self.revealed, |body| body.child(row().w_full().items_stretch().gap(px(10.)).children([
                        ("again",t("もう一度","Again"),t("思い出せなかった","Could not recall")),
                        ("hard",t("難しい","Hard"),t("少し迷った","Took some effort")),
                        ("good",t("覚えていた","Good"),t("思い出せた","Recalled it")),
                        ("easy",t("簡単","Easy"),t("すぐにわかった","Knew it instantly")),
                    ].into_iter().enumerate().map(|(index,(rating,label,detail))| {
                        let id=id.clone();
                        button(rating).track_focus(&self.rating_focus[index]).accessibility_id(format!("review-rate-{rating}")).accessibility_label(format!("{} {label} — {detail}",index+1)).flex_1().h(px(if short {80.} else {94.})).disabled(disabled)
                            .child(column().gap_1().items_center().child(div().text_size(px(12.)).text_color(theme.muted_foreground).child((index+1).to_string())).child(div().text_size(px(15.)).font_weight(gpui_kit::FontWeight::MEDIUM).child(label)).child(muted(detail)))
                            .on_click(cx.listener(move|this,_,window,cx|this.rate(id.clone(),rating,window,cx)))
                    }))))
                    .child(div().text_size(px(12.)).text_color(theme.muted_foreground).child(t("思い出しやすさに合わせて、次の復習時刻が調整されます。", "Your next review is scheduled from how well you recalled this phrase."))));
            } else {
                let library = self.session.clone();
                let phrases = self.session.clone();
                let heading = if self.reviewed.is_empty() {
                    t(
                        "いま復習する表現はありません",
                        "No phrases are due right now",
                    )
                } else {
                    t("今回の復習が終わりました", "Review complete")
                };
                page = page.child(
                    column()
                        .py_9()
                        .gap_4()
                        .child(
                            Icon::new(IconName::Check)
                                .text_color(theme.primary)
                                .size(px(28.)),
                        )
                        .child(
                            div()
                                .id("review-complete")
                                .test_support()
                                .track_focus(&self.prompt_focus)
                                .role(gpui_kit::accesskit::Role::Heading)
                                .aria_level(2)
                                .aria_label(heading)
                                .when(!self.prompt_focus.is_focused(window), |heading| {
                                    heading.aria_active_descendant()
                                })
                                .text_size(px(24.))
                                .font_weight(gpui_kit::FontWeight::MEDIUM)
                                .child(heading),
                        )
                        .child(muted(t(
                            "作品の続きを観るか、フレーズ帳で保存した表現を確認できます。",
                            "Continue watching or browse the phrases you have saved.",
                        )))
                        .child(
                            row()
                                .child(
                                    button("review-library")
                                        .primary()
                                        .label(t("作品に戻る", "Back to watching"))
                                        .on_click(move |_, _, cx| {
                                            library
                                                .update(cx, |s, cx| s.navigate(Route::Library, cx))
                                        }),
                                )
                                .child(
                                    button("review-phrases")
                                        .label(t("フレーズ帳を開く", "Open phrases"))
                                        .on_click(move |_, _, cx| {
                                            phrases.update(cx, |s, cx| s.navigate(Route::Cards, cx))
                                        }),
                                ),
                        ),
                );
            }
            return page
                .when_some(self.error.clone(), |body, error| {
                    body.child(div().text_color(theme.danger).child(error))
                })
                .into_any_element();
        }
        let languages: std::collections::BTreeSet<_> = snapshot
            .as_ref()
            .into_iter()
            .flat_map(|s| &s.cards)
            .map(|c| c.language.clone())
            .collect();
        let count = cards.len();
        let total = snapshot.as_ref().map_or(0, |s| s.cards.len());
        let due_count = snapshot
            .as_ref()
            .map_or(0, |s| s.cards.iter().filter(|c| due(c)).count());
        let mut key = format!(
            "{:?}:{query}:{:?}:{:?}",
            self.language,
            self.expanded,
            window.viewport_size().width
        );
        for card in &cards {
            key.push_str(&format!(
                "{}:{}:{}:{}:{}:{:?}:{:?}",
                card.id,
                card.term,
                card.meaning,
                card.example,
                card.due_at,
                card.translation,
                card.explanation
            ));
        }
        if key != self.list_key {
            let filter = format!("{:?}:{query}", self.language);
            if filter != self.list_filter {
                self.list.reset(cards.len());
                self.list_filter = filter;
            } else {
                self.list.splice(0..self.list.item_count(), cards.len());
            }
            self.list_key = key;
        }
        let view = cx.entity().downgrade();
        let model = self.session.clone();
        let selected_language = self.language.clone();
        let language_view = cx.entity().downgrade();
        let filter = button("card-language")
            .label(self.language.as_ref().map_or_else(
                || t("すべての言語", "All languages").to_owned(),
                |code| language_name(code, ja),
            ))
            .icon(IconName::ChevronDown)
            .accessibility_id("card-language")
            .dropdown_menu(move |mut menu, _, _| {
                let view = language_view.clone();
                menu = menu.item(
                    PopupMenuItem::new(t("すべての言語", "All languages"))
                        .checked(selected_language.is_none())
                        .on_click(move |_, _, cx| {
                            let _ = view.update(cx, |this, cx| {
                                this.language = None;
                                cx.notify();
                            });
                        }),
                );
                for language in &languages {
                    let view = language_view.clone();
                    let code = language.clone();
                    menu = menu.item(
                        PopupMenuItem::new(language_name(language, ja))
                            .checked(selected_language.as_ref() == Some(language))
                            .on_click(move |_, _, cx| {
                                let _ = view.update(cx, |this, cx| {
                                    this.language = Some(code.clone());
                                    cx.notify();
                                });
                            }),
                    );
                }
                menu
            });
        let export = self.session.clone();
        let review = self.session.clone();
        let expanded = self.expanded.clone();
        let mut page=column().size_full().min_h(px(0.)).px(px(gutter)).py_6().gap_6()
            .child(row().justify_between().gap_6().flex_wrap()
                .child(column().gap_2().child(title(t("フレーズ帳","Phrases"))).child(div().text_size(px(15.)).text_color(theme.muted_foreground).child(t("作品で出会った表現を、音声と文脈から振り返る。","Return to the phrases you saved, with their original audio and context."))))
                .child(row().gap_2().child(button("cards-export").icon(IconName::ArrowDownToLine).label(t("書き出す","Export")).disabled(disabled).on_click(move|_,_,cx|export.update(cx,|s,cx|s.request_transfer(cx))))
                    .child(button("cards-review").primary().icon(IconName::BookOpen).label(if due_count>0{format!("{}  {due_count}",t("復習する","Start review"))}else{t("復習する","Start review").into()}).on_click(move|_,_,cx|review.update(cx,|s,cx|s.navigate(Route::Review,cx))))))
            .child(row().justify_between().gap_4().flex_wrap()
                .child(row().gap_2().child(div().text_size(px(17.)).font_weight(gpui_kit::FontWeight::SEMIBOLD).child(t("保存した表現","Saved phrases"))).child(phrase_badge(count.to_string(),false,cx)))
                .child(row().gap_3().child(filter).child(Input::new(&self.search).id("card-search").accessibility_id("card-search").aria_label(t("フレーズを検索","Search phrases")).prefix(Icon::new(IconName::Search)).w(px(310.))))) ;
        if cards.is_empty() {
            let library = self.session.clone();
            page = page.child(
                column()
                    .flex_1()
                    .justify_center()
                    .items_center()
                    .gap_4()
                    .child(
                        Icon::new(IconName::Layers)
                            .size(px(33.))
                            .text_color(theme.muted_foreground),
                    )
                    .child(
                        div()
                            .text_size(px(22.))
                            .font_weight(gpui_kit::FontWeight::MEDIUM)
                            .child(if total > 0 {
                                t("一致するフレーズはありません", "No matching phrases")
                            } else {
                                t("保存したフレーズはまだありません", "No saved phrases yet")
                            }),
                    )
                    .child(muted(if total > 0 {
                        t(
                            "検索語や言語の絞り込みを変えてください。",
                            "Try another search or language filter.",
                        )
                    } else {
                        t(
                            "作品を観ながら気になる表現を保存すると、ここで原音を聴き直せます。",
                            "Save a phrase while watching, then listen to its original audio here.",
                        )
                    }))
                    .when(total > 0, |body| {
                        body.child(
                            button("cards-reset")
                                .primary()
                                .label(t("絞り込みをリセット", "Reset filters"))
                                .on_click(cx.listener(|this, _, window, cx| {
                                    this.language = None;
                                    this.search.update(cx, |s, cx| s.set_value("", window, cx));
                                    cx.notify();
                                })),
                        )
                    })
                    .when(total == 0, |body| {
                        body.child(
                            button("cards-library")
                                .primary()
                                .label(t("作品を選ぶ", "Choose something to watch"))
                                .on_click(move |_, _, cx| {
                                    library.update(cx, |s, cx| s.navigate(Route::Library, cx))
                                }),
                        )
                    }),
            );
        } else {
            page = page.child(
                gpui_kit::list(self.list.clone(), move |index, _, cx| {
                    let card = &cards[index];
                    let is_expanded = expanded.as_ref() == Some(&card.id);
                    let id = card.id.clone();
                    let edit_view = view.clone();
                    let edit_id = id.clone();
                    let audio_view = view.clone();
                    let audio_id = id.clone();
                    let detail_view = view.clone();
                    let detail_id = id.clone();
                    let actions_view = view.clone();
                    let actions_id = id.clone();
                    let suspended = card.suspended;
                    let more = button(("card-options", index))
                        .ghost()
                        .icon(IconName::Ellipsis)
                        .w(px(40.))
                        .p_0()
                        .accessibility_id(format!("card-options-{}", card.id))
                        .accessibility_label(format!("{} — {}", card.term, t("操作", "Actions")))
                        .disabled(disabled)
                        .dropdown_menu(move |menu, _, _| {
                            let suspend_view = actions_view.clone();
                            let suspend_id = actions_id.clone();
                            let delete_view = actions_view.clone();
                            let delete_id = actions_id.clone();
                            menu.item(
                                PopupMenuItem::new(if suspended {
                                    t("復習を再開", "Resume reviews")
                                } else {
                                    t("復習を停止", "Suspend reviews")
                                })
                                .on_click(move |_, window, cx| {
                                    let _ = suspend_view.update(cx, |this, cx| {
                                        this.card_action(suspend_id.clone(), false, window, cx)
                                    });
                                }),
                            )
                            .item(
                                PopupMenuItem::new(t("削除", "Delete")).on_click(
                                    move |_, window, cx| {
                                        let _ = delete_view.update(cx, |this, cx| {
                                            this.card_action(delete_id.clone(), true, window, cx)
                                        });
                                    },
                                ),
                            )
                        });
                    let source = model.clone();
                    let media_id = card.media_id.clone();
                    let media = snapshot
                        .as_ref()
                        .and_then(|s| s.media.iter().find(|m| m.id == media_id));
                    let title =
                        media.map_or_else(|| card.source_title.clone(), |m| m.title.clone());
                    let available = media.is_some();
                    let is_due = due(card);
                    let mut article = column()
                        .id(gpui_kit::SharedString::from(format!("phrase-{}", card.id)))
                        .w_full()
                        .min_w(px(0.))
                        .py_6()
                        .gap_2()
                        .border_b_1()
                        .border_color(cx.theme().border)
                        .child(
                            row()
                                .items_start()
                                .justify_between()
                                .gap_6()
                                .child(
                                    div()
                                        .flex_1()
                                        .min_w(px(0.))
                                        .text_size(px(28.))
                                        .line_height(relative(1.4))
                                        .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                                        .whitespace_normal()
                                        .child(card.term.clone()),
                                )
                                .child(
                                    row()
                                        .gap_2()
                                        .child(
                                            button(("edit-card", index))
                                                .ghost()
                                                .label(t("編集", "Edit"))
                                                .accessibility_id(format!("edit-card-{}", card.id))
                                                .disabled(disabled)
                                                .on_click(move |_, window, cx| {
                                                    let _ = edit_view.update(cx, |this, cx| {
                                                        this.open(edit_id.clone(), window, cx)
                                                    });
                                                }),
                                        )
                                        .child(
                                            button(("card-audio", index))
                                                .ghost()
                                                .icon(IconName::Volume2)
                                                .label(t("原音を聴く", "Listen"))
                                                .accessibility_id(format!("card-audio-{}", card.id))
                                                .disabled(disabled || card.audio_path.is_none())
                                                .on_click(move |_, _, cx| {
                                                    let _ = audio_view.update(cx, |this, cx| {
                                                        this.audio(audio_id.clone(), cx)
                                                    });
                                                }),
                                        )
                                        .child(more),
                                ),
                        )
                        .child(
                            div()
                                .text_size(px(15.))
                                .line_height(relative(1.75))
                                .whitespace_normal()
                                .child(card.meaning.clone()),
                        )
                        .child(
                            div()
                                .my_2()
                                .pl_4()
                                .border_l_2()
                                .border_color(cx.theme().border)
                                .text_size(px(16.))
                                .line_height(relative(1.8))
                                .text_color(cx.theme().muted_foreground)
                                .whitespace_normal()
                                .child(card.example.clone()),
                        )
                        .child(
                            column().gap_1().when(
                                !is_expanded
                                    && !query.is_empty()
                                    && ![&card.term, &card.meaning, &card.example]
                                        .iter()
                                        .any(|text| text.to_lowercase().contains(&query)),
                                |matches| {
                                    matches.children(
                                        [
                                            (
                                                t("翻訳に一致：", "Translation match: "),
                                                card.translation.as_ref(),
                                            ),
                                            (
                                                t("解説・メモに一致：", "Notes match: "),
                                                card.explanation.as_ref(),
                                            ),
                                        ]
                                        .into_iter()
                                        .filter_map(
                                            |(label, text)| {
                                                text.filter(|text| {
                                                    text.to_lowercase().contains(&query)
                                                })
                                                .map(|text| {
                                                    div()
                                                        .text_size(px(13.))
                                                        .line_height(relative(1.7))
                                                        .child(format!("{label}{text}"))
                                                })
                                            },
                                        ),
                                    )
                                },
                            ),
                        )
                        .child(
                            div().child(
                                button(("card-details", index))
                                    .ghost()
                                    .icon(if is_expanded {
                                        IconName::ChevronUp
                                    } else {
                                        IconName::ChevronDown
                                    })
                                    .text_color(cx.theme().primary)
                                    .label(t("訳・解説", "Translation and notes"))
                                    .accessibility_id(format!("card-details-{}", card.id))
                                    .on_click(move |_, _, cx| {
                                        let _ = detail_view.update(cx, |this, cx| {
                                            this.expanded =
                                                if this.expanded.as_ref() == Some(&detail_id) {
                                                    None
                                                } else {
                                                    Some(detail_id.clone())
                                                };
                                            cx.notify();
                                        });
                                    }),
                            ),
                        );
                    if is_expanded {
                        let mut details = column()
                            .p_5()
                            .gap_4()
                            .rounded(px(12.))
                            .border_1()
                            .border_color(cx.theme().border)
                            .bg(cx.theme().popover);
                        for (label, text) in [
                            (t("翻訳", "Translation"), card.translation.as_ref()),
                            (
                                t("解説・メモ", "Explanation or notes"),
                                card.explanation.as_ref(),
                            ),
                        ] {
                            if let Some(text) = text.filter(|text| !text.trim().is_empty()) {
                                details = details.child(
                                    column().gap_2().child(muted(label)).child(
                                        div()
                                            .text_size(px(15.))
                                            .line_height(relative(1.8))
                                            .whitespace_normal()
                                            .child(text.clone()),
                                    ),
                                );
                            }
                        }
                        if card
                            .translation
                            .as_ref()
                            .is_none_or(|t| t.trim().is_empty())
                            && card
                                .explanation
                                .as_ref()
                                .is_none_or(|t| t.trim().is_empty())
                        {
                            details = details.child(muted(t(
                                "訳・解説はまだありません。「編集」から追加できます。",
                                "No translation or notes yet. Add them with Edit.",
                            )));
                        }
                        article = article.child(details);
                    }
                    article
                        .child(
                            row()
                                .justify_between()
                                .flex_wrap()
                                .mt_2()
                                .gap_4()
                                .child(
                                    button(("card-source", index))
                                        .ghost()
                                        .icon(IconName::BookOpen)
                                        .label(title)
                                        .accessibility_id(format!("card-source-{}", card.id))
                                        .disabled(disabled || !available)
                                        .on_click(move |_, _, cx| {
                                            source.update(cx, |s, cx| {
                                                s.navigate(Route::Study(media_id.clone()), cx)
                                            })
                                        }),
                                )
                                .child(
                                    row()
                                        .gap_2()
                                        .child(muted(language_name(&card.language, ja)))
                                        .child(phrase_badge(
                                            if card.suspended {
                                                t("復習を停止中", "Reviews suspended")
                                            } else if is_due {
                                                t("復習の時間", "Ready to review")
                                            } else {
                                                t("次回の復習待ち", "Review scheduled")
                                            },
                                            is_due,
                                            cx,
                                        )),
                                ),
                        )
                        .into_any_element()
                })
                .w_full()
                .min_w(px(0.))
                .flex_1()
                .min_h(px(0.))
                .border_t_1()
                .border_color(theme.border),
            );
        }
        page.when_some(self.error.clone(), |body, error| {
            body.child(div().text_color(theme.danger).child(error))
        })
        .into_any_element()
    }
}

fn phrase_badge(
    text: impl Into<gpui_kit::SharedString>,
    accent: bool,
    cx: &gpui_kit::App,
) -> gpui_kit::Div {
    div()
        .px_2()
        .py_1()
        .rounded(px(4.))
        .text_size(px(12.))
        .line_height(relative(1.4))
        .bg(if accent {
            cx.theme().accent
        } else {
            cx.theme().secondary
        })
        .text_color(if accent {
            cx.theme().primary
        } else {
            cx.theme().muted_foreground
        })
        .child(text.into())
}

struct CardForm {
    card_id: String,
    session: Entity<Session>,
    editors: Entity<EditorRegistry>,
    key: Option<EditorKey>,
    fields: BTreeMap<&'static str, Entity<TextareaState>>,
    delivered: BTreeMap<&'static str, String>,
    error: Option<String>,
    busy: bool,
    generation: u64,
    deleted: bool,
    _subscriptions: Vec<Subscription>,
}
impl CardForm {
    fn new(
        card_id: String,
        session: Entity<Session>,
        editors: Entity<EditorRegistry>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let result = editors.update(cx, |registry, cx| registry.ensure("card", &card_id, cx));
        let (key, error) = match result {
            Ok(key) => (Some(key), None),
            Err(error) => (None, Some(error)),
        };
        let mut fields = BTreeMap::new();
        let mut subscriptions = vec![];
        for name in ["term", "meaning", "example", "translation", "explanation"] {
            let input = cx.new(|cx| TextareaState::new(window, cx));
            subscriptions.push(cx.subscribe(
                &input,
                move |this, _, event: &InputEditsEvent, cx| {
                    if let Some((_, text)) = event.edits().last() {
                        let raw = text.to_string();
                        this.delivered.insert(name, raw.clone());
                        if let Some(key) = this.key.clone() {
                            this.editors.update(cx, |registry, cx| {
                                registry.change(&key, [(name.to_owned(), raw)].into(), cx)
                            });
                        }
                    }
                },
            ));
            subscriptions.push(
                cx.subscribe(&input, move |this, _, event: &InputEvent, cx| {
                    let Some(key) = this.key.clone() else {
                        return;
                    };
                    if let InputEvent::Blur = event {
                        this.editors
                            .update(cx, |registry, cx| registry.blur(&key, cx));
                    }
                }),
            );
            fields.insert(name, input);
        }
        subscriptions.push(cx.observe(&editors, |_, _, cx| cx.notify()));
        let generation = session
            .read(cx)
            .backend
            .generation
            .load(std::sync::atomic::Ordering::Acquire);
        let mut this = Self {
            card_id,
            session,
            editors,
            key,
            fields,
            delivered: BTreeMap::new(),
            error,
            busy: false,
            generation,
            deleted: false,
            _subscriptions: subscriptions,
        };
        this.sync(window, cx);
        this
    }
    fn sync(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let generation = self
            .session
            .read(cx)
            .backend
            .generation
            .load(std::sync::atomic::Ordering::Acquire);
        if self.generation != generation {
            self.generation = generation;
            self.deleted = false;
            self.key = None;
            self.error = None;
        }
        if !self.editors.read(cx).frozen()
            && !self.deleted
            && self
                .key
                .as_ref()
                .is_none_or(|key| self.editors.read(cx).view(key).is_none())
            && self
                .session
                .read(cx)
                .snapshot
                .as_ref()
                .is_some_and(|snapshot| snapshot.cards.iter().any(|card| card.id == self.card_id))
        {
            self.key = self
                .editors
                .update(cx, |editors, cx| editors.ensure("card", &self.card_id, cx))
                .ok();
        }
        let Some(view) = self
            .key
            .as_ref()
            .and_then(|key| self.editors.read(cx).view(key))
        else {
            return;
        };
        let fields = view.fields.clone();
        for (name, input) in &self.fields {
            let value = fields.get(*name).cloned().unwrap_or_default();
            let current = input.read(cx).value().to_string();
            if current == self.delivered.get(name).cloned().unwrap_or_default() && current != value
            {
                input.update(cx, |input, cx| input.set_value(value.clone(), window, cx));
                self.delivered.insert(name, value);
            }
        }
    }
    fn close(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy || self.editors.read(cx).frozen() {
            return;
        }
        if let Some(key) = &self.key {
            self.editors.update(cx, |editors, cx| {
                editors.blur(key, cx);
            });
        }
        window.remove_window();
    }
    fn suspend(&mut self, cx: &mut Context<Self>) {
        if self.busy || self.editors.read(cx).frozen() {
            return;
        }
        let backend = self.session.read(cx).backend.clone();
        let state = backend.state.clone();
        let id = self.card_id.clone();
        let suspended = self
            .session
            .read(cx)
            .snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.cards.iter().find(|card| card.id == id))
            .is_some_and(|card| card.suspended);
        run(
            &backend,
            cx,
            async move { commands::cards::suspend_card(&state, id, !suspended) },
            |this, result, _| this.error = result.err(),
        );
    }
    fn delete(&mut self, cx: &mut Context<Self>) {
        let ja = self.session.read(cx).text("ja", "en") == "ja";
        let t =
            move |ja_text: &'static str, en_text: &'static str| if ja { ja_text } else { en_text };
        if self.busy || self.editors.read(cx).frozen() {
            return;
        }
        self.busy = true;
        let backend = self.session.read(cx).backend.clone();
        let state = backend.state.clone();
        let id = self.card_id.clone();
        let flush = self.editors.update(cx, |editors, cx| {
            editors.flush_all(FlushPurpose::Export, cx)
        });
        run(
            &backend,
            cx,
            async move {
                flush.await?;
                let confirmed = rfd::AsyncMessageDialog::new()
                    .set_title("Surtitle")
                    .set_description(t(
                        "このフレーズと復習記録を削除しますか？",
                        "Delete this phrase and its review history?",
                    ))
                    .set_buttons(rfd::MessageButtons::YesNo)
                    .show()
                    .await;
                if confirmed == rfd::MessageDialogResult::Yes {
                    commands::cards::delete_card(&state, id)?;
                    Ok(true)
                } else {
                    Ok(false)
                }
            },
            |this, result, cx| {
                this.busy = false;
                match result {
                    Ok(true) => {
                        this.deleted = true;
                        if let Some(key) = this.key.as_ref()
                            && let Err(error) = this
                                .editors
                                .update(cx, |editors, cx| editors.retire(key, cx))
                        {
                            this.error = Some(error);
                        }
                        this.key = None;
                        this.error =
                            Some(this.session.read(cx).text("削除しました", "Deleted").into());
                        this.session.update(cx, |session, cx| session.refresh(cx));
                    }
                    Ok(false) => {}
                    Err(error) => this.error = Some(error),
                }
                if let Err(error) = this.editors.update(cx, |editors, cx| editors.resume(cx)) {
                    this.error = Some(error);
                }
            },
        );
    }
}
impl Render for CardForm {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.sync(window, cx);
        let ja = self.session.read(cx).text("ja", "en") == "ja";
        let t =
            move |ja_text: &'static str, en_text: &'static str| if ja { ja_text } else { en_text };
        let disabled = self.busy
            || self.editors.read(cx).frozen()
            || self.key.as_ref().is_none_or(|key| {
                self.editors
                    .read(cx)
                    .view(key)
                    .is_none_or(|view| !view.ready)
            });
        let saving = self
            .key
            .as_ref()
            .and_then(|key| self.editors.read(cx).view(key))
            .is_some_and(|view| view.saving);
        let error = self.error.clone().or_else(|| {
            self.key
                .as_ref()
                .and_then(|key| self.editors.read(cx).view(key))
                .and_then(|view| view.error.clone())
        });
        let close_disabled = self.busy || self.editors.read(cx).frozen();
        super::keyboard::form_tab_navigation(column())
            .id("card-form")
            .size_full()
            .gap_0()
            .bg(cx.theme().popover)
            .child(
                row()
                    .px_6()
                    .py_5()
                    .justify_between()
                    .border_b_1()
                    .border_color(cx.theme().border)
                    .child(
                        column()
                            .gap_1()
                            .child(
                                div()
                                    .text_size(px(20.))
                                    .font_weight(gpui_kit::FontWeight::MEDIUM)
                                    .child(t("フレーズを編集", "Edit phrase")),
                            )
                            .child(muted(if saving {
                                t("保存中…", "Saving…")
                            } else {
                                t("変更は自動保存されます。", "Changes save automatically.")
                            })),
                    )
                    .child(
                        icon_button("close-card", IconName::X, t("閉じる", "Close"))
                            .disabled(close_disabled)
                            .on_click(cx.listener(|this, _, window, cx| this.close(window, cx))),
                    ),
            )
            .child(
                column()
                    .id("card-form-fields")
                    .flex_1()
                    .min_h(px(0.))
                    .overflow_y_scroll()
                    .p_6()
                    .gap_5()
                    .children(
                        [
                            ("term", t("フレーズ", "Phrase")),
                            ("meaning", t("意味", "Meaning")),
                            ("example", t("例文", "Example")),
                            ("translation", t("例文の訳", "Example translation")),
                            ("explanation", t("解説・メモ", "Explanation and notes")),
                        ]
                        .into_iter()
                        .map(|(name, label)| {
                            column()
                                .gap_2()
                                .child(
                                    div()
                                        .text_size(px(14.))
                                        .font_weight(gpui_kit::FontWeight::MEDIUM)
                                        .child(label),
                                )
                                .child(
                                    Textarea::new(&self.fields[name])
                                        .accessibility_id(format!("card-{name}"))
                                        .aria_label(label)
                                        .disabled(disabled)
                                        .h(px(if name == "term" { 52. } else { 86. })),
                                )
                        }),
                    )
                    .when_some(error, |body, error| {
                        body.child(div().text_color(cx.theme().danger).child(error))
                    }),
            )
            .child(
                row()
                    .px_6()
                    .py_4()
                    .gap_2()
                    .border_t_1()
                    .border_color(cx.theme().border)
                    .child(
                        button("suspend-card")
                            .ghost()
                            .accessibility_id("suspend-card")
                            .label(t("復習の休止・再開", "Suspend or resume"))
                            .disabled(disabled)
                            .on_click(cx.listener(|this, _, _, cx| this.suspend(cx))),
                    )
                    .child(
                        button("delete-card")
                            .ghost()
                            .text_color(cx.theme().danger)
                            .accessibility_id("delete-card")
                            .label(t("削除", "Delete"))
                            .disabled(disabled)
                            .on_click(cx.listener(|this, _, _, cx| this.delete(cx))),
                    )
                    .child(div().flex_1())
                    .child(
                        button("card-close-footer")
                            .label(t("閉じる", "Close"))
                            .disabled(close_disabled)
                            .on_click(cx.listener(|this, _, window, cx| this.close(window, cx))),
                    ),
            )
    }
}
