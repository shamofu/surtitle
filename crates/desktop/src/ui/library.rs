// SPDX-License-Identifier: GPL-3.0-or-later
use super::{
    editors::FlushFuture,
    import::{self, ImportWorkspace},
    session::{Route, Session, UiEvent},
    style::*,
};
use gpui_kit::Focusable;
use gpui_kit::assets::IconName;
use gpui_kit::base::{Disableable, Selectable};
use gpui_kit::component::{
    ActiveTheme, Icon,
    button::ButtonVariants,
    input::{Input, InputEvent, InputState},
};
use gpui_kit::{
    AnyWindowHandle, AppContext, Context, Entity, ExternalPaths, FontWeight, SharedString,
    Subscription, Window, div, prelude::*, px, relative, uniform_list,
};

pub(crate) struct LibraryView {
    session: Entity<Session>,
    search: Entity<InputState>,
    kind: &'static str,
    imports: Entity<ImportWorkspace>,
    import_dialog: Option<AnyWindowHandle>,
    error: Option<String>,
    row_motion: super::list_motion::ListMotion,
    row_filter: Option<String>,
    row_scroll: gpui_kit::UniformListScrollHandle,
    row_ids: Vec<String>,
    _subscriptions: Vec<Subscription>,
}
impl LibraryView {
    pub fn new(session: Entity<Session>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let backend = session.read(cx).backend.clone();
        let imports = cx.new(|cx| ImportWorkspace::new(backend, cx));
        let search_placeholder = session.read(cx).text("タイトルで検索", "Search titles");
        let search = cx.new(|cx| InputState::new(window, cx).placeholder(search_placeholder));
        let changed = cx.subscribe(&search, |_, _, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                cx.notify();
            }
        });
        let snapshot = cx.subscribe_in(&session, window, |this, _, event: &UiEvent, window, cx| {
            if matches!(event, UiEvent::Snapshot) {
                let placeholder = this
                    .session
                    .read(cx)
                    .text("タイトルで検索", "Search titles");
                this.search.update(cx, |search, cx| {
                    search.set_placeholder(placeholder, window, cx)
                });
                cx.notify();
            }
        });
        let import_changes = cx.observe(&imports, |_, _, cx| cx.notify());
        Self {
            session,
            search,
            kind: "all",
            imports,
            import_dialog: None,
            error: None,
            row_motion: Default::default(),
            row_filter: None,
            row_scroll: gpui_kit::UniformListScrollHandle::new(),
            row_ids: Vec::new(),
            _subscriptions: vec![changed, snapshot, import_changes],
        }
    }
    pub fn flush(&mut self, cx: &mut Context<Self>) -> FlushFuture {
        self.imports.read(cx).flush()
    }
    pub fn freeze(&mut self, frozen: bool, cx: &mut Context<Self>) {
        self.imports
            .update(cx, |imports, cx| imports.freeze(frozen, cx));
    }
    pub fn invalidate_after_restore(&mut self, cx: &mut Context<Self>) -> Result<(), String> {
        self.imports
            .update(cx, |imports, cx| imports.invalidate_after_restore(cx))
    }
    pub fn reload_after_discard(&mut self, cx: &mut Context<Self>) -> Result<(), String> {
        self.imports
            .update(cx, |imports, cx| imports.reload_after_discard(cx))
    }
    pub fn open_import(&mut self, cx: &mut Context<Self>) {
        if self.imports.read(cx).view().frozen {
            return;
        }
        if let Some(handle) = self.import_dialog
            && handle
                .update(cx, |_, window, cx| {
                    crate::desktop::dialog::activate(window, cx)
                })
                .is_ok()
        {
            return;
        }
        match import::open(self.session.clone(), self.imports.clone(), cx) {
            Ok(handle) => {
                self.import_dialog = Some(handle);
                self.error = None;
            }
            Err(error) => self.error = Some(error.to_string()),
        }
        cx.notify();
    }
    fn reset_filters(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.kind = "all";
        self.search
            .update(cx, |search, cx| search.set_value("", window, cx));
        self.search.read(cx).focus_handle(cx).focus(window, cx);
        cx.notify();
    }
}
impl Render for LibraryView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let session = self.session.read(cx);
        let ja = session.text("ja", "en") == "ja";
        let t = move |j: &'static str, e: &'static str| if ja { j } else { e };
        let search = self.search.read(cx).value().to_string().to_lowercase();
        let filtering = !search.is_empty() || self.kind != "all";
        self.row_motion.viewport(
            window.viewport_size(),
            self.row_scroll.0.borrow().base_handle.offset(),
        );
        let row_filter = format!("{}:{search}", self.kind);
        let row_filter_changed = self
            .row_filter
            .as_ref()
            .is_some_and(|previous| previous != &row_filter);
        self.row_filter = Some(row_filter);
        let row_motion = self.row_motion.clone();
        let rows: Vec<_> = session
            .snapshot
            .as_ref()
            .into_iter()
            .flat_map(|snapshot| &snapshot.media)
            .filter(|media| {
                (self.kind == "all" || media.kind == self.kind)
                    && media.title.to_lowercase().contains(&search)
            })
            .cloned()
            .collect();
        let row_ids: Vec<_> = rows.iter().map(|media| media.id.clone()).collect();
        if row_filter_changed {
            let top = self
                .row_scroll
                .0
                .borrow()
                .base_handle
                .logical_scroll_top()
                .0;
            if let Some(index) = super::list_motion::retained_anchor(&self.row_ids, top, &row_ids) {
                let scroll = self.row_scroll.0.borrow();
                if let Some(item) = scroll.last_item_size {
                    let offset = scroll.base_handle.offset();
                    let within = offset.y + item.item.height * top as f32;
                    scroll.base_handle.set_offset(gpui_kit::point(
                        offset.x,
                        within - item.item.height * index as f32,
                    ));
                }
            }
            self.row_motion.viewport(
                window.viewport_size(),
                self.row_scroll.0.borrow().base_handle.offset(),
            );
            self.row_motion.filter_changed();
        }
        self.row_ids = row_ids;
        let continuing = session
            .snapshot
            .as_ref()
            .map(|snapshot| {
                snapshot
                    .media
                    .iter()
                    .filter(|media| {
                        media.status == "ready"
                            && media.last_position_ms > 0
                            && (media.duration_ms == 0
                                || media.last_position_ms < media.duration_ms)
                    })
                    .take(3)
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let total = rows.len();
        let overall = session
            .snapshot
            .as_ref()
            .map_or(0, |snapshot| snapshot.media.len());
        let loading = session.snapshot.is_none() && session.error.is_none();
        let failed = session.error.clone();
        let has_snapshot = session.snapshot.is_some();
        let model = self.session.clone();
        let theme = cx.theme();
        let background = theme.background;
        let foreground = theme.foreground;
        let border = theme.border;
        let surface = theme.popover;
        let subdued = theme.muted_foreground;
        let accent = theme.primary;
        let accent_soft = theme.accent;
        let hover = theme.list_hover;
        let imports = self.imports.read(cx).view();
        let wide = window.viewport_size().width >= px(1100.);
        let spacious = window.viewport_size().width >= px(1600.);
        let table_height = (46. + total as f32 * 104.)
            .min(f32::from(window.viewport_size().height) * 0.8)
            .max(150.);
        let row_tone = gpui_kit::component::button::ButtonCustomVariant::new(cx)
            .color(surface)
            .foreground(foreground)
            .hover(hover)
            .active(accent_soft);
        self.row_motion.begin_layout();
        column().id("library-view").size_full().min_h(px(0.)).overflow_y_scroll()
            .px(px(24.)).pt(px(if spacious { 40. } else { 32. })).pb(px(32.))
            .gap(px(24.)).bg(background).text_color(foreground)
            .border_2().border_color(theme.transparent)
            .drag_over::<ExternalPaths>(|style, _, _, cx| style.border_2().border_color(cx.theme().primary))
            .on_drop(cx.listener(|this, paths: &ExternalPaths, _, cx| {
                if this.imports.read(cx).view().frozen { return; }
                this.imports.update(cx, |imports, cx| imports.add(
                    paths.paths().iter().map(|path| path.to_string_lossy().into_owned()).collect(), true, cx));
                this.open_import(cx);
            }))
            .child(row().flex_shrink_0().justify_between().gap(px(24.)).child(
                column().flex_1().min_w(px(0.)).gap(px(8.)).child(title(t("ライブラリ", "Library")))
                    .child(div().text_size(px(15.)).text_color(subdued).child(t(
                        "好きな作品を観ながら、気になる言葉を確かめる。",
                        "Watch something you enjoy. Take a closer look at the words that catch your attention.")))
            ).child(button("open-import").primary().icon(IconName::Plus)
                .label(t("動画・音声を追加する", "Add video or audio"))
                .accessibility_id("library-add-media").disabled(imports.frozen)
                .on_click(cx.listener(|this, _, _, cx| this.open_import(cx)))))
            .child(row().flex_shrink_0().justify_between().child(row().gap(px(8.)).text_color(subdued).text_size(px(13.))
                .child(Icon::new(IconName::Upload).size(px(15.))).child(t(
                    "動画・音声ファイルをここへドロップして追加できます。",
                    "Drop video or audio files here to add them.")))
                .child(button("library-transfer").ghost().icon(IconName::ArrowDownToLine)
                    .label(t("データ管理", "Your data")).accessibility_id("library-your-data")
                    .disabled(imports.frozen).on_click(cx.listener(|this, _, _, cx| {
                        this.session.update(cx, |session, cx| session.request_transfer(cx))
                    }))))
            .child(muted(t(
                "ファイルを追加中です。追加画面を閉じても処理は続きます。",
                "Files are being added. Work continues when the import dialog closes."))
                .when(!imports.busy, |notice| notice.invisible()))
            .when(!continuing.is_empty(), |body| body.child(
                column().flex_shrink_0().gap(px(16.)).child(div().text_size(px(17.)).font_weight(FontWeight::SEMIBOLD)
                    .child(t("視聴途中", "Continue watching")))
                    .child(column().gap_0().border_1().border_l(px(3.)).border_color(border)
                        .border_color(border).rounded(px(8.)).overflow_hidden()
                        .children(continuing.into_iter().map(|media| {
                            let id = media.id.clone();
                            Button::new(SharedString::from(format!("resume-{id}"))).custom(row_tone).surface_colors(surface, hover, accent_soft)
                                .w_full().h(px(104.)).px(px(24.)).rounded(px(0.))
                                .border_l(px(3.)).border_color(accent)
                                .accessibility_id(format!("library-resume-{id}"))
                                .accessibility_label(format!("{} — {}", media.title, t("続きを再生", "Continue")))
                                .child(row().w_full().gap(px(16.))
                                    .child(div().size(px(44.)).flex_shrink_0().rounded(px(22.)).bg(accent_soft)
                                        .text_color(accent).flex().items_center().justify_center()
                                        .child(Icon::new(IconName::Play).size(px(19.))))
                                    .child(column().flex_1().min_w(px(0.)).gap(px(4.))
                                        .child(div().text_size(px(20.)).font_weight(FontWeight::SEMIBOLD)
                                            .truncate().child(media.title))
                                        .child(row().gap(px(16.)).text_size(px(13.)).text_color(subdued)
                                            .child(language_name(&media.learning_language, ja))
                                            .child(if ja { format!("{} から再開", timestamp(media.last_position_ms)) }
                                                else { format!("Resume at {}", timestamp(media.last_position_ms)) })))
                                    .child(div().text_size(px(13.)).text_color(accent).child(
                                        if media.kind == "audio" { t("続きを聴く", "Continue listening") }
                                        else { t("続きを観る", "Continue watching") })))
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.session.update(cx, |session, cx| session.navigate(Route::Study(id.clone()), cx))
                                }))
                        }))
                    )
            ))
            .child(row().flex_shrink_0().justify_between().child(row().gap(px(12.))
                .child(div().text_size(px(17.)).font_weight(FontWeight::SEMIBOLD).child(t("教材一覧", "Your materials")))
                .child(div().px(px(12.)).py(px(3.)).rounded(px(4.)).bg(theme.secondary)
                    .text_size(px(12.)).text_color(subdued).child(overall.to_string())))
                .child(row().gap(px(24.))
                    .child(row().gap_0().children([
                        ("all", t("すべて", "All")), ("video", t("動画", "Video")), ("audio", t("音声", "Audio"))
                    ].into_iter().map(|(kind,label)| button(kind).ghost().px(px(12.)).rounded(px(6.))
                        .selected(self.kind == kind).label(label).accessibility_id(format!("library-filter-{kind}"))
                        .on_click(cx.listener(move |this,_,_,cx| { this.kind = kind; cx.notify(); })))))
                    .child(Input::new(&self.search).h(px(42.)).w(px(238.)).rounded(px(6.))
                        .prefix(Icon::new(IconName::Search).size(px(17.)))
                        .when(!search.is_empty(), |input| input.suffix(
                            icon_button("clear-library-search", IconName::X, t("検索をクリア", "Clear search"))
                                .size(px(24.)).accessibility_id("library-clear-search")
                                .on_click(cx.listener(|this, _, window, cx| {
                                    this.search.update(cx, |search,cx| search.set_value("",window,cx));
                                    this.search.read(cx).focus_handle(cx).focus(window,cx);
                                }))))
                        .accessibility_id("library-search").aria_label(t("ライブラリを検索", "Search your library")))))
            .when_some(self.error.clone(), |body,error| body.child(div().text_color(cx.theme().danger).child(error)))
            .when(has_snapshot && failed.is_some(), |body| body.child(row().flex_shrink_0()
                .child(muted(t("更新できませんでした。読み込み済みの教材は利用できます。", "Refresh failed. Your loaded materials are still available.")))
                .child(compact_button("retry-library-refresh").label(t("再試行", "Retry"))
                    .on_click(cx.listener(|this,_,_,cx| this.session.update(cx,|session,cx|session.refresh(cx)))))))
            .child(if loading {
                column().p_6().child(muted(t("教材を読み込み中…", "Loading materials…"))).into_any_element()
            } else if let Some(error) = failed.filter(|_| !has_snapshot) {
                column().p_6().child(muted(error)).child(button("retry-library").label(t("再試行", "Retry"))
                    .accessibility_id("library-retry").on_click(cx.listener(|this,_,_,cx| {
                        this.session.update(cx, |session,cx| session.refresh(cx))
                    }))).into_any_element()
            } else if rows.is_empty() {
                column().p_6().items_center().gap(px(16.)).child(title(if filtering {
                    t("教材が見つかりません", "No matching materials")
                } else { t("最初の教材を追加する", "Add your first material") }))
                    .child(muted(if filtering {
                        t("タイトルや種類の条件を変えて検索してください。", "Try another title or content type.")
                    } else {
                        t("ローカルファイルを追加すると、字幕とフレーズを一緒に管理できます。",
                          "Keep subtitles and saved phrases beside your local media.")
                    }))
                    .child(button("library-empty-action").primary().label(if filtering {
                        t("条件をリセット", "Reset filters")
                    } else { t("動画・音声を追加する", "Add video or audio") })
                        .accessibility_id("library-empty-action").disabled(imports.frozen)
                        .on_click(cx.listener(move |this,_,window,cx| {
                            if filtering { this.reset_filters(window,cx); } else { this.open_import(cx); }
                        }))).into_any_element()
            } else {
                column().gap_0().flex_shrink_0().h(px(table_height))
                    .border_1().border_color(border).rounded(px(8.)).overflow_hidden()
                    .child(row().h(px(46.)).flex_shrink_0().px(px(22.)).gap(px(20.))
                        .text_size(px(12.)).text_color(subdued)
                        .child(div().flex_1().child(t("タイトル", "Title")))
                        .when(wide, |row| row.child(div().w(px(100.)).child(t("学習言語", "Learning language"))))
                        .child(div().w(px(105.)).child(t("字幕", "Subtitles")))
                        .when(wide, |row| row.child(div().w(px(105.)).child(t("フレーズ", "Phrases"))))
                        .child(div().w(px(150.)).child(t("再生位置 / 長さ", "Position / duration"))))
                    .child(uniform_list("library-media", rows.len(), move |range,window,cx| range.map(|index| {
                        let media = &rows[index];
                        let id = media.id.clone();
                        let model = model.clone();
                        let status = match media.status.as_str() {
                            "missing" => t("ファイルが見つかりません", "File not found"),
                            "error" => t("読み込みエラー", "Import error"),
                            "importing" => t("読み込み中", "Importing"),
                            _ => t("ローカルファイル", "Local file"),
                        };
                        row_motion.row(id.clone(), Button::new(("study",index)).motion_identity(format!("study-{id}")).custom(row_tone).surface_colors(surface, hover, accent_soft)
                            .accessibility_id(format!("study-{id}")).accessibility_label(media.title.clone())
                            .w_full().h(px(104.)).px(px(22.)).rounded(px(0.)).border_t_1().border_color(border)
                            .child(row().w_full().gap(px(20.)).text_size(px(13.)).text_color(subdued)
                                .child(row().flex_1().min_w(px(0.)).gap(px(16.))
                                    .child(div().w(px(28.)).flex_shrink_0().child(Icon::new(
                                        if media.kind == "audio" { IconName::Headphones } else { IconName::FileVideoCamera }
                                    ).size(px(21.))))
                                    .child(column().flex_1().min_w(px(0.)).gap(px(5.))
                                        .child(div().truncate().text_size(px(17.)).font_weight(FontWeight::SEMIBOLD)
                                            .text_color(foreground).child(media.title.clone()))
                                        .child(row().gap(px(12.)).text_size(px(12.))
                                            .child(if media.kind == "audio" { t("音声","Audio") } else { t("動画","Video") })
                                            .child(status))
                                        .when(!wide, |column| column.child(row().gap(px(12.)).text_size(px(12.))
                                            .child(language_name(&media.learning_language,ja))
                                            .child(if ja {format!("保存したフレーズ {} 件", media.card_count)} else {format!("{} saved phrases", media.card_count)})))))
                                .when(wide, |row| row.child(div().w(px(100.)).child(language_name(&media.learning_language,ja))))
                                .child(div().w(px(105.)).child(if media.segment_count == 0 {
                                    t("字幕なし", "No subtitles").into()
                                } else if ja { format!("{} 行", media.segment_count) }
                                else { format!("{} lines", media.segment_count) }))
                                .when(wide, |row| row.child(div().w(px(105.)).child(if ja {
                                    format!("{} 件", media.card_count)
                                } else { format!("{} saved", media.card_count) })))
                                .child(column().w(px(150.)).gap(px(10.))
                                    .child(row().gap(px(4.)).text_size(px(14.)).font_features(tabular_numbers())
                                        .child(div().text_color(foreground).child(timestamp(media.last_position_ms)))
                                        .child(format!("/ {}", if media.duration_ms > 0 { timestamp(media.duration_ms) } else { "—".into() })))
                                    .when(media.duration_ms > 0, |col| col.child(div().id(SharedString::from(format!("library-progress-{}",media.id)))
                                        .role(gpui_kit::accesskit::Role::ProgressIndicator)
                                        .aria_label(t("再生位置", "Playback position"))
                                        .aria_numeric_value(media.last_position_ms.min(media.duration_ms) as f64)
                                        .aria_min_numeric_value(0.).aria_max_numeric_value(media.duration_ms as f64)
                                        .w_full().h(px(3.)).bg(border).rounded(px(2.))
                                        .child(div().h_full().bg(accent).w(relative(
                                            super::motion_controls::progress(format!("library-progress-{}-{}", media.id, media.duration_ms), (media.last_position_ms as f32 / media.duration_ms as f32).clamp(0.,1.), window, cx)
                                        )))))))
                            .on_click(move |_,_,cx| model.update(cx, |session,cx| session.navigate(Route::Study(id.clone()),cx))))
                    }).collect::<Vec<_>>()).track_scroll(&self.row_scroll).with_horizontal_sizing_behavior(gpui_kit::ListHorizontalSizingBehavior::FitList).w_full().flex_1().min_h(px(0.)))
                    .into_any_element()
            })
    }
}
pub(crate) fn timestamp(ms: u64) -> String {
    let seconds = ms / 1000;
    if seconds >= 3600 {
        format!(
            "{}:{:02}:{:02}",
            seconds / 3600,
            (seconds / 60) % 60,
            seconds % 60
        )
    } else {
        format!("{}:{:02}", seconds / 60, seconds % 60)
    }
}
