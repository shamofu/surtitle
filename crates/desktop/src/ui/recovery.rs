// SPDX-License-Identifier: GPL-3.0-or-later
//! Readable local unfinished input. Reopening never grants source or AI authority.
use super::{
    editors::EditorRegistry,
    session::{Session, UiEvent, run},
    source_editors::SourceEditors,
    source_form,
    style::*,
};
use gpui_kit::base::{Disableable, Selectable};
use gpui_kit::component::{
    ActiveTheme,
    button::Button,
    input::{Textarea, TextareaState},
};
use gpui_kit::{
    AnyWindowHandle, AppContext, ClipboardItem, Context, Entity, EventEmitter, Subscription,
    Window, div, prelude::*, px, size,
};
use std::sync::atomic::Ordering;
use surtitle_core::workspace::UiDraft;

mod data;
pub(crate) use data::{RecoveryItem, discard};

#[derive(Clone, Debug)]
pub(crate) enum RecoveryAction {
    OpenUi { draft: UiDraft, recover: bool },
    OpenAi { id: String },
    Discard(Box<RecoveryItem>),
}

pub(crate) struct RecoveryView {
    session: Entity<Session>,
    editors: Entity<EditorRegistry>,
    sources: Entity<SourceEditors>,
    rows: Vec<RecoveryItem>,
    selected: Option<String>,
    detail: Entity<TextareaState>,
    confirming: Option<String>,
    loading: bool,
    refresh_again: bool,
    busy: bool,
    generation: u64,
    error: Option<String>,
    notice: Option<String>,
    _subscriptions: Vec<Subscription>,
}
impl EventEmitter<RecoveryAction> for RecoveryView {}

pub(crate) fn open(
    session: Entity<Session>,
    editors: Entity<EditorRegistry>,
    sources: Entity<SourceEditors>,
    cx: &mut gpui_kit::App,
) -> anyhow::Result<(AnyWindowHandle, Entity<RecoveryView>)> {
    anyhow::ensure!(
        !editors.read(cx).frozen() && !sources.read(cx).frozen(),
        "Saving is still in progress"
    );
    let ja = session.read(cx).text("ja", "en") == "ja";
    let t = move |ja_text: &'static str, en_text: &'static str| if ja { ja_text } else { en_text };
    gpui_kit::open_window(
        gpui_kit::WindowOptions {
            titlebar: Some(gpui_kit::TitlebarOptions {
                title: Some(t("Surtitle · 未完了の入力", "Surtitle · Unfinished input").into()),
                ..Default::default()
            }),
            ..crate::desktop::dialog::options(size(px(900.), px(720.)), None, cx)
        },
        cx,
        move |window, cx| cx.new(|cx| RecoveryView::new(session, editors, sources, window, cx)),
    )
}

impl RecoveryView {
    fn new(
        session: Entity<Session>,
        editors: Entity<EditorRegistry>,
        sources: Entity<SourceEditors>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let generation = session.read(cx).backend.generation.load(Ordering::Acquire);
        let detail = cx.new(|cx| TextareaState::new(window, cx));
        let changes = cx.subscribe(&session, |this, _, event: &UiEvent, cx| {
            let generation = this.session.read(cx).backend.generation.load(Ordering::Acquire);
            if generation != this.generation {
                this.generation = generation;
                this.loading = false;
                this.rows.clear();
                this.selected = None;
                this.confirming = None;
                this.refresh(cx);
            } else if matches!(event, UiEvent::Changed(change) if change.domain == crate::application::changes::ChangeDomain::Drafts) {
                this.refresh(cx);
            }
            cx.notify();
        });
        let editing = cx.observe(&editors, |_, _, cx| cx.notify());
        let source_changes = cx.observe(&sources, |this, _, cx| this.refresh(cx));
        let weak = cx.entity().downgrade();
        window.on_window_should_close(cx, move |_, cx| {
            weak.update(cx, |this, _| !this.busy).unwrap_or(true)
        });
        let mut this = Self {
            session,
            editors,
            sources,
            rows: vec![],
            selected: None,
            detail,
            confirming: None,
            loading: false,
            refresh_again: false,
            busy: false,
            generation,
            error: None,
            notice: None,
            _subscriptions: vec![changes, editing, source_changes],
        };
        this.refresh(cx);
        this
    }
    fn frozen(&self, cx: &gpui_kit::App) -> bool {
        self.busy
            || self.editors.read(cx).frozen()
            || self.sources.read(cx).frozen()
            || self.generation
                != self
                    .session
                    .read(cx)
                    .backend
                    .generation
                    .load(Ordering::Acquire)
    }
    pub fn refresh(&mut self, cx: &mut Context<Self>) {
        if self.frozen(cx) {
            return;
        }
        if self.loading {
            self.refresh_again = true;
            return;
        }
        self.loading = true;
        self.refresh_again = false;
        let backend = self.session.read(cx).backend.clone();
        let state = backend.state.clone();
        let runtime = backend.host.runtime().clone();
        run(
            &backend,
            cx,
            async move {
                runtime
                    .spawn_blocking(move || data::load(&state))
                    .await
                    .map_err(|error| error.to_string())?
            },
            |this, result, cx| {
                this.loading = false;
                match result {
                    Ok(rows) => {
                        if this
                            .selected
                            .as_ref()
                            .is_none_or(|id| !rows.iter().any(|row| row.id() == *id))
                        {
                            this.selected = rows.first().map(RecoveryItem::id);
                        }
                        this.rows = rows;
                        this.confirming = None;
                    }
                    Err(error) => this.error = Some(error),
                }
                if this.refresh_again {
                    this.refresh(cx);
                }
            },
        );
        cx.notify();
    }
    /// Root calls this only after collecting the mutation and releasing its gate.
    pub fn finish(&mut self, result: Result<(), String>, cx: &mut Context<Self>) {
        self.busy = false;
        self.confirming = None;
        match result {
            Ok(()) => {
                self.error = None;
                self.notice = Some(
                    self.session
                        .read(cx)
                        .text("下書きを破棄しました", "Draft discarded")
                        .into(),
                );
            }
            Err(error) => self.error = Some(error),
        }
        self.refresh(cx);
    }
    fn reopen(
        &mut self,
        item: RecoveryItem,
        recover: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.frozen(cx) {
            return;
        }
        match item {
            RecoveryItem::Ui(draft) if draft.archive_id.is_none() => {
                cx.emit(RecoveryAction::OpenUi { draft, recover });
                window.remove_window();
            }
            RecoveryItem::Source(draft) => {
                if let Err(error) =
                    source_form::open_saved(self.session.clone(), self.sources.clone(), draft, cx)
                {
                    self.error = Some(error.to_string());
                }
            }
            RecoveryItem::Ai(value) => {
                cx.emit(RecoveryAction::OpenAi { id: value.id });
                window.remove_window();
            }
            _ => {}
        }
        cx.notify();
    }
}
impl Render for RecoveryView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let ja = self.session.read(cx).text("ja", "en") == "ja";
        let t =
            move |ja_text: &'static str, en_text: &'static str| if ja { ja_text } else { en_text };
        let selected = self
            .selected
            .as_ref()
            .and_then(|id| self.rows.iter().find(|row| row.id() == *id))
            .cloned();
        let raw = selected
            .as_ref()
            .map(RecoveryItem::text)
            .unwrap_or_default();
        if self.detail.read(cx).value().as_ref() != raw {
            self.detail
                .update(cx, |input, cx| input.set_value(raw, window, cx));
        }
        let frozen = self.frozen(cx);
        super::keyboard::form_tab_navigation(column()).id("recovery-dialog").size_full().p_5().gap_3().bg(cx.theme().background).text_color(cx.theme().foreground)
            .child(row().justify_between().child(title(t("未完了の入力", "Unfinished input")))
                .child(Button::new("recovery-refresh").accessibility_id("recovery-refresh").label(t("更新", "Refresh")).disabled(frozen || self.loading).on_click(cx.listener(|this,_,_,cx| this.refresh(cx)))))
            .child(muted(t("以前の入力を確認して再開できます。出典が変わった内容や保存済みの記録は自動適用されません。", "Review input before continuing; changed sources and archived text are never applied automatically.")))
            .child(row().items_start().flex_1().min_h(px(0.))
                .child(column().id("recovery-list").w(px(300.)).h_full().overflow_y_scroll().gap_2()
                    .child(state_message(if self.loading {t("読み込み中…", "Loading…")} else {t("未完了の入力はありません", "No unfinished input")}, &[t("読み込み中…", "Loading…"),t("未完了の入力はありません", "No unfinished input")]).text_size(px(13.)).opacity(0.75).when(!self.loading && !self.rows.is_empty(), |status| status.invisible()))
                    .children(self.rows.iter().map(|item| {
                        let id = item.id(); let selected = self.selected.as_deref() == Some(&id);
                        Button::new(id.clone()).label(item.label(ja)).accessibility_id(format!("recovery-item-{id}")).selected(selected)
                            .on_click(cx.listener(move |this,_,_,cx| {this.selected=Some(id.clone());this.confirming=None;this.notice=None;cx.notify();}))
                    })))
                .child(column().flex_1().h_full().gap_2()
                    .child(Textarea::new(&self.detail).accessibility_id("recovery-content").aria_label(t("保存済み入力", "Saved input")).disabled(true).flex_1())
                    .when_some(selected, |body, item| {
                        let copying = item.clone(); let opening = item.clone(); let recovering = item.clone(); let deleting = item.clone();
                        let confirm = self.confirming.as_deref() == Some(&item.id());
                        body.child(muted(item.status(ja)))
                            .child(row().flex_wrap()
                                .child(Button::new("recovery-copy").accessibility_id("recovery-copy").label(t("内容をコピー", "Copy text")).on_click(cx.listener(move|this,_,_,cx|{cx.write_to_clipboard(ClipboardItem::new_string(copying.text()));this.notice=Some(t("コピーしました", "Copied").into());cx.notify();})))
                                .when(item.can_open(), |buttons| buttons.child(Button::new("recovery-open").accessibility_id("recovery-open").label(t("入力を開く", "Open input")).disabled(frozen).on_click(cx.listener(move|this,_,window,cx|this.reopen(opening.clone(),false,window,cx)))))
                                .when(item.can_recover(), |buttons| buttons.child(Button::new("recovery-recover").accessibility_id("recovery-recover").label(t("以前の入力から続ける", "Recover input")).disabled(frozen).on_click(cx.listener(move|this,_,window,cx|this.reopen(recovering.clone(),true,window,cx)))))
                                .when(item.can_discard(), |buttons| buttons.child(Button::new("recovery-discard").accessibility_id("recovery-discard").accessibility_label(if confirm {t("破棄を確定", "Confirm discard")} else {t("下書きを破棄", "Discard draft")}).child(state_label(if confirm {t("破棄を確定", "Confirm discard")} else {t("下書きを破棄", "Discard draft")}, &[t("破棄を確定", "Confirm discard"), t("下書きを破棄", "Discard draft")])).disabled(frozen || self.loading).on_click(cx.listener(move|this,_,_,cx|{
                                    if this.frozen(cx) {return;}
                                    if this.confirming.as_deref() == Some(&deleting.id()) {this.busy=true;cx.emit(RecoveryAction::Discard(Box::new(deleting.clone())));} else {this.confirming=Some(deleting.id());}
                                    cx.notify();
                                }))))
                            )
                            .child(muted(t("この下書きだけを破棄します。保存済みの教材・字幕・フレーズは削除しません。", "Only this draft is discarded; saved learning content stays.")).when(!confirm, |notice| notice.invisible()))
                    })))
            .child(column().id("recovery-status").h(px(42.)).flex_shrink_0().overflow_y_scroll().gap_1()
                .when_some(self.error.clone(), |body,error| body.child(div().text_color(cx.theme().danger).child(error)))
                .when_some(self.notice.clone(), |body,notice| body.child(muted(notice))))
            .child(Button::new("recovery-close").accessibility_id("recovery-close").label(t("閉じる", "Close")).disabled(self.busy).on_click(|_,window,_|window.remove_window()))
    }
}
