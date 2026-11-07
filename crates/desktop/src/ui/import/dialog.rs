use super::{ImportWorkspace, Status, languages};
use crate::ui::{
    session::{Route, Session, UiEvent},
    style::*,
};
use gpui_kit::base::{Disableable, StyledExt, TestSupportExt};
use gpui_kit::component::{
    ActiveTheme,
    button::{Button, ButtonVariants},
    input::{Input, InputEditsEvent, InputState},
};
use gpui_kit::{
    AppContext, Context, Entity, ExternalPaths, Subscription, Window, div, prelude::*, px,
};
use std::collections::BTreeMap;

struct InputBinding {
    state: Entity<InputState>,
    delivered: String,
}
impl InputBinding {
    fn sync(&mut self, value: &str, window: &mut Window, cx: &mut Context<ImportDialog>) {
        let current = self.state.read(cx).value().to_string();
        // A service completion must not replace input whose immutable edit event
        // is still queued for delivery to the durable workspace.
        if current == self.delivered && current != value {
            self.state.update(cx, |input, cx| {
                input.set_value(value.to_owned(), window, cx)
            });
            self.delivered = value.into();
        }
    }
}

pub(crate) struct ImportDialog {
    session: Entity<Session>,
    workspace: Entity<ImportWorkspace>,
    learning: InputBinding,
    explanation: InputBinding,
    titles: BTreeMap<u64, InputBinding>,
    subscriptions: Vec<Subscription>,
}
impl ImportDialog {
    pub(super) fn new(
        session: Entity<Session>,
        workspace: Entity<ImportWorkspace>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let learning = cx.new(|cx| {
            InputState::new(window, cx).placeholder("言語名またはコード / Language or code")
        });
        let explanation = cx.new(|cx| {
            InputState::new(window, cx).placeholder("言語名またはコード / Language or code")
        });
        let mut subscriptions = vec![];
        subscriptions.push(
            cx.subscribe(&learning, |this, _, event: &InputEditsEvent, cx| {
                if let Some((_, text)) = event.edits().last() {
                    let raw = text.to_string();
                    this.learning.delivered = raw.clone();
                    if this.workspace.read(cx).view().learning != raw {
                        this.workspace
                            .update(cx, |workspace, cx| workspace.languages(Some(raw), None, cx));
                    }
                }
            }),
        );
        subscriptions.push(
            cx.subscribe(&explanation, |this, _, event: &InputEditsEvent, cx| {
                if let Some((_, text)) = event.edits().last() {
                    let raw = text.to_string();
                    this.explanation.delivered = raw.clone();
                    if this.workspace.read(cx).view().explanation != raw {
                        this.workspace
                            .update(cx, |workspace, cx| workspace.languages(None, Some(raw), cx));
                    }
                }
            }),
        );
        subscriptions.push(cx.observe_in(&workspace, window, |this, _, window, cx| {
            this.sync(window, cx);
            cx.notify();
        }));
        subscriptions.push(cx.subscribe(&session, |_, _, _: &UiEvent, cx| cx.notify()));
        let mut this = Self {
            session,
            workspace,
            learning: InputBinding {
                state: learning,
                delivered: String::new(),
            },
            explanation: InputBinding {
                state: explanation,
                delivered: String::new(),
            },
            titles: BTreeMap::new(),
            subscriptions,
        };
        this.sync(window, cx);
        this
    }
    fn sync(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let view = self.workspace.read(cx).view();
        self.learning.sync(&view.learning, window, cx);
        self.explanation.sync(&view.explanation, window, cx);
        self.titles
            .retain(|id, _| view.rows.iter().any(|row| row.id == *id));
        for row in view.rows {
            if !self.titles.contains_key(&row.id) {
                let input = cx.new(|cx| {
                    InputState::new(window, cx).placeholder("タイトル（省略可） / Optional title")
                });
                let id = row.id;
                self.subscriptions.push(cx.subscribe(
                    &input,
                    move |this, _, event: &InputEditsEvent, cx| {
                        if let Some((_, text)) = event.edits().last() {
                            let raw = text.to_string();
                            if let Some(binding) = this.titles.get_mut(&id) {
                                binding.delivered = raw.clone();
                            }
                            if this
                                .workspace
                                .read(cx)
                                .view()
                                .rows
                                .iter()
                                .any(|row| row.id == id && row.title != raw)
                            {
                                this.workspace
                                    .update(cx, |workspace, cx| workspace.title(id, raw, cx));
                            }
                        }
                    },
                ));
                self.titles.insert(
                    id,
                    InputBinding {
                        state: input,
                        delivered: String::new(),
                    },
                );
            }
            self.titles
                .get_mut(&row.id)
                .unwrap()
                .sync(&row.title, window, cx);
        }
    }
}
impl Render for ImportDialog {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let view = self.workspace.read(cx).view();
        let session = self.session.read(cx);
        let ja = session.text("ja", "en") == "ja";
        let t = move |j: &'static str, e: &'static str| if ja { j } else { e };
        let disabled = view.frozen;
        let busy = view.busy;
        let failed = view
            .rows
            .iter()
            .filter(|row| matches!(row.status, Status::Failed | Status::Invalid))
            .map(|row| row.id)
            .collect::<Vec<_>>();
        let completed = view
            .rows
            .iter()
            .filter(|row| {
                matches!(
                    row.status,
                    Status::Imported | Status::Existing | Status::Invalid | Status::Failed
                )
            })
            .count();
        column().id("import-dialog").size_full().p_5().bg(cx.theme().background).text_color(cx.theme().foreground)
            .on_drop(cx.listener(|this,paths:&ExternalPaths,_,cx|{this.workspace.update(cx,|workspace,cx|workspace.add(paths.paths().iter().map(|path|path.to_string_lossy().into_owned()).collect(),true,cx));}))
            .child(title(t("作品を追加","Add video or audio")))
            .child(muted(t("取り込みだけでは AI を実行しません。画面を閉じても取り込みと入力の保存は続きます。","Importing does not run AI. Work and autosave continue when this dialog closes.")))
            .child(row().items_start()
                .children([("learning",t("学習する言語","Learning language"),self.learning.state.clone(),view.learning.clone()),("explanation",t("説明・翻訳の言語","Explanation language"),self.explanation.state.clone(),view.explanation.clone())].into_iter().map(|(kind,label,input,raw)|{
                    column().flex_1().min_w_0().gap_1().child(muted(label))
                        .child(Input::new(&input).accessibility_id(format!("import-{kind}-language")).aria_label(label).disabled(disabled))
                        .child(div().id(gpui_kit::SharedString::from(format!("import-{kind}-suggestions"))).h(px(64.)).w_full().overflow_y_scroll()
                          .child(row().flex_wrap().gap_1().children(languages::matches(&raw).into_iter().map(|(code,japanese,english)|{
                            Button::new(gpui_kit::SharedString::from(format!("import-language-{kind}-{code}"))).label(format!("{} · {code}",if ja{japanese}else{english})).accessibility_id(format!("import-{kind}-{code}")).disabled(disabled)
                                .on_click(cx.listener(move|this,_,_,cx|{this.workspace.update(cx,|workspace,cx|workspace.languages((kind=="learning").then(||code.into()),(kind=="explanation").then(||code.into()),cx));}))
                        }))))
                })))
            .child(row().flex_wrap()
                .child(Button::new("import-pick").primary().label(t("動画・音声を選んで追加","Choose and add files")).accessibility_id("import-pick").disabled(disabled||view.picking||!view.ready)
                    .on_click(cx.listener(|this,_,_,cx|{this.workspace.update(cx,|workspace,cx|workspace.pick(true,cx));})))
                .child(Button::new("import-review-files").label(t("タイトルを確認して追加","Review titles first")).accessibility_id("import-review-files").disabled(disabled||view.picking||!view.ready)
                    .on_click(cx.listener(|this,_,_,cx|{this.workspace.update(cx,|workspace,cx|workspace.pick(false,cx));})))
                .child(Button::new("import-clear").label(t("一覧をクリア","Clear list")).accessibility_id("import-clear").disabled(disabled||busy)
                    .on_click(cx.listener(|this,_,_,cx|{this.workspace.update(cx,|workspace,cx|workspace.clear(cx));}))))
            .child(muted(t("MP4 · MKV · WEBM · MOV · AVI · MP3 · WAV · FLAC — ファイルをここへドロップできます。","MP4 · MKV · WEBM · MOV · AVI · MP3 · WAV · FLAC — Drop files anywhere in this dialog.")))
            .child(column().id("import-rows").flex_1().min_h(px(0.)).overflow_y_scroll().gap_2()
                .when(view.rows.is_empty(),|body|body.child(muted(t("追加するローカルファイルを選択してください。","Choose local files to add."))))
                .children(view.rows.iter().map(|item|{
                    let id=item.id;let status=match item.status {Status::Checking|Status::Validating=>t("ファイルを確認中…","Checking file…"),Status::Ready=>t("タイトルを確認し、下のボタンで追加","Review title, then add below"),Status::Queued|Status::Importing=>t("追加中…","Adding…"),Status::Imported=>t("追加しました","Added"),Status::Existing=>t("追加済み（既存の作品を維持）","Already in library · original preserved"),Status::Invalid=>t("読み込めないファイルです","This file cannot be imported"),Status::Failed=>t("追加できませんでした","Import failed")};
                    let media=item.media_id.clone();let title_input=self.titles.get(&id).map(|binding|binding.state.clone());
                    column().id(("import-row",id as usize)).test_support().flex_shrink_0().p_3().gap_1().bg(cx.theme().background).border_1().border_color(cx.theme().border)
                        .child(row().justify_between().child(div().font_semibold().child(file_name(&item.input_path)))
                            .child(Button::new(("remove-import",id as usize)).label(t("一覧から外す","Remove from list")).accessibility_id(format!("import-remove-{id}")).disabled(disabled||busy)
                                .on_click(cx.listener(move|this,_,_,cx|{this.workspace.update(cx,|workspace,cx|workspace.remove(id,cx));}))))
                        .child(muted(item.input_path.clone()))
                        .when_some(title_input,|body,input|body.child(Input::new(&input).accessibility_id(format!("import-title-{id}")).aria_label(t("作品のタイトル","Media title")).disabled(disabled||!item.editable())))
                        .child(column().id(("import-row-status",id as usize)).h(px(48.)).overflow_y_scroll().gap_1()
                            .child(muted(format!("{status}{}",item.reason.as_ref().map(|reason|format!(" · {}",reason_text(reason,ja))).unwrap_or_default())))
                            .when_some(item.error.clone(),|body,error|body.child(div().text_color(cx.theme().danger).child(error))))
                        .child(div().h(px(30.)).children(media.map(|media|Button::new(("open-import",id as usize)).label(t("開く","Open")).accessibility_id(format!("import-open-{id}")).disabled(disabled)
                            .on_click(cx.listener(move|this,_,window,cx|{this.session.update(cx,|session,cx|session.navigate(Route::Study(media.clone()),cx));window.remove_window();})))))
                })))
            .child(muted(if busy{format!("{}  {completed} / {}",t("ファイルを追加中","Adding files"),view.rows.len())}else{format!("{} / {}",completed,view.rows.len())}))
            .child(div().id("import-error").h(px(36.)).flex_shrink_0().overflow_y_scroll()
                .children(view.error.clone().map(|error|div().text_color(cx.theme().danger).child(error))))
            .child(row().justify_between()
                .child(Button::new("close-import").label(t("閉じる","Close")).accessibility_id("import-close").on_click(|_,window,_|window.remove_window()))
                .child(row()
                    .child(Button::new("retry-import").label(t("保存・失敗したファイルを再試行","Retry saving or failed files")).accessibility_id("import-retry").disabled(!view.retryable)
                        .on_click(cx.listener(move|this,_,_,cx|{this.workspace.update(cx,|workspace,cx|workspace.retry(Some(failed.clone()),true,cx));})))
                    .child(Button::new("submit-import").primary().label(t("確認したファイルを追加","Add reviewed files")).accessibility_id("import-submit").disabled(disabled||!view.rows.iter().any(|row|row.status==Status::Ready))
                        .on_click(cx.listener(|this,_,_,cx|{this.workspace.update(cx,|workspace,cx|workspace.submit(cx));})))))
    }
}
fn file_name(path: &str) -> String {
    path.rsplit(['\\', '/'])
        .find(|part| !part.is_empty())
        .unwrap_or(path)
        .to_owned()
}
fn reason_text(reason: &str, ja: bool) -> &str {
    match (reason, ja) {
        ("invalidPath", true) => "絶対パスのファイルを選択してください",
        ("missing", true) => "ファイルが見つかりません",
        ("directory", true) => "フォルダーではなくファイルを選択してください",
        ("empty", true) => "ファイルが空です",
        ("unsupported", true) => "対応していない形式です",
        ("unreadable", true) => "ファイルを読み取れません",
        ("invalidPath", false) => "Choose an absolute path to a file",
        ("missing", false) => "The file no longer exists",
        ("directory", false) => "Choose files rather than a folder",
        ("empty", false) => "The file is empty",
        ("unsupported", false) => "This file type is not supported",
        ("unreadable", false) => "The file could not be read",
        _ => reason,
    }
}
