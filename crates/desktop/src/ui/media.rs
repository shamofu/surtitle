// SPDX-License-Identifier: GPL-3.0-or-later
//! Media paths, stream selection and preserved subtitle editions.
use super::{
    DesktopView,
    editors::EditorRegistry,
    session::{Session, run},
    style::*,
};
use crate::{application::media_tools::MediaStream, commands};
use gpui_kit::component::{ActiveTheme, Disableable, button::ButtonVariants};
use gpui_kit::{AppContext, Context, Entity, WeakEntity, Window, div, prelude::*, px, size};
use surtitle_core::SubtitleVersion;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Action {
    Relink,
    Remove,
    Import,
    Audio(u32),
    Embedded(u32),
    RestoreVersion(String),
}
pub(crate) async fn execute(
    backend: super::session::Backend,
    media: String,
    action: Action,
) -> Result<(), String> {
    match action {
        Action::Relink => commands::library::relink_media(&backend.state, media).await,
        Action::Remove => {
            commands::library::remove_media(backend.host, &backend.state, media).await
        }
        Action::Import => commands::subtitles::import_subtitles(&backend.state, media, Some(true))
            .await
            .map(|_| ()),
        Action::Audio(index) => {
            commands::media_tools::select_audio_stream(
                backend.host,
                &backend.state,
                media,
                index,
                None,
            )
            .await
        }
        Action::Embedded(index) => {
            commands::media_tools::extract_embedded_subtitles(
                &backend.state,
                media,
                index,
                Some(true),
                None,
            )
            .await
        }
        Action::RestoreVersion(id) => {
            commands::subtitles::restore_subtitle_version(&backend.state, media, id)
        }
    }
}
pub(crate) fn open(
    owner: WeakEntity<DesktopView>,
    session: Entity<Session>,
    editors: Entity<EditorRegistry>,
    id: String,
    cx: &mut gpui_kit::App,
) -> anyhow::Result<()> {
    open_source(owner, session, editors, id, None, cx)
}

pub(crate) fn open_embedded(
    owner: WeakEntity<DesktopView>,
    session: Entity<Session>,
    editors: Entity<EditorRegistry>,
    id: String,
    stream_index: u32,
    cx: &mut gpui_kit::App,
) -> anyhow::Result<()> {
    open_source(owner, session, editors, id, Some(stream_index), cx)
}

fn open_source(
    owner: WeakEntity<DesktopView>,
    session: Entity<Session>,
    editors: Entity<EditorRegistry>,
    id: String,
    requested_stream: Option<u32>,
    cx: &mut gpui_kit::App,
) -> anyhow::Result<()> {
    let ja = session.read(cx).text("ja", "en") == "ja";
    let t = move |ja_text: &'static str, en_text: &'static str| if ja { ja_text } else { en_text };
    gpui_kit::open_window(
        gpui_kit::WindowOptions {
            titlebar: Some(gpui_kit::TitlebarOptions {
                title: Some(t("Surtitle · 教材の管理", "Surtitle · Manage media").into()),
                ..Default::default()
            }),
            ..crate::desktop::dialog::options(size(px(780.), px(700.)), None, cx)
        },
        cx,
        move |window, cx| {
            cx.new(|cx| {
                let mut view = MediaView::new(owner, session, editors, id, window, cx);
                view.requested_stream = requested_stream;
                if requested_stream.is_some() {
                    view.inspect(cx);
                }
                view
            })
        },
    )?;
    Ok(())
}
pub(crate) struct MediaView {
    owner: WeakEntity<DesktopView>,
    session: Entity<Session>,
    editors: Entity<EditorRegistry>,
    id: String,
    streams: Vec<MediaStream>,
    streams_loaded: bool,
    requested_stream: Option<u32>,
    versions: Vec<SubtitleVersion>,
    versions_loaded: bool,
    busy: bool,
    removed: bool,
    confirm: Option<Action>,
    error: Option<String>,
    notice: Option<String>,
    generation: u64,
    source_path: Option<String>,
    _subscriptions: Vec<gpui_kit::Subscription>,
}
impl MediaView {
    fn new(
        owner: WeakEntity<DesktopView>,
        session: Entity<Session>,
        editors: Entity<EditorRegistry>,
        id: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let weak = cx.entity().downgrade();
        window.on_window_should_close(cx, move |_, cx| {
            weak.update(cx, |this, cx| !this.busy || this.retired(cx))
                .unwrap_or(true)
        });
        let generation = session
            .read(cx)
            .backend
            .generation
            .load(std::sync::atomic::Ordering::Acquire);
        let source_path = session
            .read(cx)
            .snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.media.iter().find(|media| media.id == id))
            .map(|media| media.path.clone());
        let changed = cx.subscribe(&session, |this, _, event: &super::session::UiEvent, cx| {
            if matches!(event, super::session::UiEvent::Snapshot) {
                let path = this
                    .session
                    .read(cx)
                    .snapshot
                    .as_ref()
                    .and_then(|snapshot| snapshot.media.iter().find(|media| media.id == this.id))
                    .map(|media| media.path.clone());
                if this.retired(cx) || path != this.source_path {
                    this.streams.clear();
                    this.streams_loaded = false;
                    this.confirm = None;
                    this.requested_stream = None;
                    this.source_path = path;
                }
                cx.notify();
            }
        });
        let mut this = Self {
            owner,
            session,
            editors,
            id,
            streams: vec![],
            streams_loaded: false,
            requested_stream: None,
            versions: vec![],
            versions_loaded: false,
            busy: false,
            removed: false,
            confirm: None,
            error: None,
            notice: None,
            generation,
            source_path,
            _subscriptions: vec![changed],
        };
        this.versions(cx);
        this
    }
    fn versions(&mut self, cx: &mut Context<Self>) {
        self.versions_loaded = false;
        let backend = self.session.read(cx).backend.clone();
        let state = backend.state.clone();
        let id = self.id.clone();
        run(
            &backend,
            cx,
            async move { commands::subtitles::list_subtitle_versions(&state, id) },
            |this, result, _| match result {
                Ok(versions) => {
                    this.versions = versions;
                    this.versions_loaded = true;
                }
                Err(error) => this.error = Some(error),
            },
        );
    }
    fn retired(&self, cx: &gpui_kit::App) -> bool {
        self.generation
            != self
                .session
                .read(cx)
                .backend
                .generation
                .load(std::sync::atomic::Ordering::Acquire)
    }
    fn inspect(&mut self, cx: &mut Context<Self>) {
        if self.busy || self.editors.read(cx).frozen() || self.retired(cx) {
            return;
        }
        self.busy = true;
        let backend = self.session.read(cx).backend.clone();
        let state = backend.state.clone();
        let id = self.id.clone();
        run(
            &backend,
            cx,
            async move { commands::media_tools::list_media_streams(&state, id, None).await },
            |this, result, cx| {
                this.busy = false;
                match result {
                    Ok(streams) => {
                        this.streams = streams;
                        this.streams_loaded = true;
                        if let Some(index) = this.requested_stream.take() {
                            if this.streams.iter().any(|stream| {
                                stream.index == index
                                    && stream.kind == "subtitle"
                                    && stream.supported_text
                            }) {
                                this.confirm = Some(Action::Embedded(index));
                            } else {
                                this.error = Some(this.session.read(cx).text(
                                    "選択した字幕を取り込めません。利用できる字幕ソースを選んでください。",
                                    "The selected captions cannot be imported. Choose an available subtitle source.",
                                ).into());
                            }
                        }
                    }
                    Err(error) => this.error = Some(error),
                }
            },
        );
    }
    fn action(&mut self, action: Action, cx: &mut Context<Self>) {
        if self.busy || self.removed || self.editors.read(cx).frozen() || self.retired(cx) {
            return;
        }
        if !matches!(action, Action::Relink | Action::Audio(_))
            && self.confirm.as_ref() != Some(&action)
        {
            self.confirm = Some(action);
            cx.notify();
            return;
        }
        let view = cx.entity().downgrade();
        let id = self.id.clone();
        match self
            .owner
            .update(cx, |root, cx| root.perform_media(id, action, view, cx))
        {
            Ok(Ok(())) => {
                self.busy = true;
                self.error = None;
            }
            Ok(Err(error)) => self.error = Some(error),
            Err(error) => self.error = Some(error.to_string()),
        }
        cx.notify();
    }
    pub fn finish(&mut self, action: Action, result: Result<(), String>, cx: &mut Context<Self>) {
        self.busy = false;
        self.confirm = None;
        if action == Action::Relink {
            self.streams.clear();
            self.streams_loaded = false;
        }
        match result {
            Ok(()) => {
                self.removed = action == Action::Remove;
                self.notice = Some(
                    self.session
                        .read(cx)
                        .text("処理が完了しました", "Finished")
                        .into(),
                );
                if !self.removed {
                    self.versions(cx);
                }
            }
            Err(error) => self.error = Some(error),
        }
        cx.notify();
    }
}
impl Render for MediaView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let ja = self.session.read(cx).text("ja", "en") == "ja";
        let t =
            move |ja_text: &'static str, en_text: &'static str| if ja { ja_text } else { en_text };
        let media = self
            .session
            .read(cx)
            .snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.media.iter().find(|media| media.id == self.id))
            .cloned();
        let disabled =
            self.busy || self.removed || self.editors.read(cx).frozen() || self.retired(cx);
        let media_name = media
            .as_ref()
            .map(|media| media.title.clone())
            .unwrap_or_else(|| t("教材", "Media").into());
        let no_subtitles =
            self.streams_loaded && !self.streams.iter().any(|stream| stream.kind == "subtitle");
        let unsupported_subtitles = self.streams_loaded
            && !no_subtitles
            && !self
                .streams
                .iter()
                .any(|stream| stream.kind == "subtitle" && stream.supported_text);
        column().id("media-management").size_full().overflow_y_scroll().p_5().gap_3().bg(cx.theme().background).text_color(cx.theme().foreground)
        .child(title(media_name.clone()))
        .when_some(media.clone(),|body,media|body.child(muted(media.path)))
        .when(self.retired(cx),|body|body.child(muted(t("データが復元されました。この画面を閉じて開き直してください。", "Data was restored; close and reopen this window."))))
        .child(row().flex_wrap()
            .child(button("media-relink").accessibility_id("media-relink").label(t("ファイルを再指定", "Relink file")).disabled(disabled).on_click(cx.listener(|this,_,_,cx|this.action(Action::Relink,cx))))
            .child(button("media-streams").accessibility_id("media-streams").label(t("音声・字幕トラックを確認", "Inspect tracks")).disabled(disabled).on_click(cx.listener(|this,_,_,cx|this.inspect(cx))))
            .child(button("media-subtitles").accessibility_id("media-subtitles").label(t("字幕ファイルを読み込む", "Import subtitles")).disabled(disabled).on_click(cx.listener(|this,_,_,cx|this.action(Action::Import,cx)))))
        .child(muted(t("字幕ファイルは SRT または WebVTT を選択します。切り替えても、保存したフレーズの文脈・音声・復習履歴は保持します。", "Choose an SRT or WebVTT subtitle file. Saved phrases keep their context, audio and review history when subtitles change.")))
        .when(!self.streams_loaded, |body| body.child(muted(t("トラックを確認すると利用できる音声・字幕を表示します。初回はメディアツールをダウンロードする場合があります。", "Inspect tracks to see available audio and subtitles. Media tools may download on first use."))))
        .when(no_subtitles, |body| body.child(muted(t("埋め込み字幕はありません。字幕ファイルを読み込むか、全編の文字起こしを見積もれます。", "No embedded subtitles were found. Import a subtitle file or estimate full transcription."))))
        .when(unsupported_subtitles, |body| body.child(muted(t("画像などの非対応字幕は学習用に読み込めません。字幕ファイルか全編の文字起こしを利用してください。", "Unsupported captions, including image subtitles, cannot be imported for study. Use a subtitle file or full transcription."))))
        .when(no_subtitles || unsupported_subtitles, |body| body.when_some(media.clone().filter(|media| media.duration_ms > 0), |body, media| body.child(
            button("media-transcribe").accessibility_id("media-transcribe").label(t("全編の文字起こしを見積もる", "Estimate full transcription")).disabled(disabled)
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.session.update(cx, |session, cx| session.request_ai(super::ai::AiIntent {
                        media_id: media.id.clone(), kind: super::ai::AiKind::Transcription,
                        start_ms: 0, end_ms: media.duration_ms, focus_term: None,
                    }, vec![], cx));
                    window.remove_window();
                })))))
        .children(self.streams.iter().map(|stream|{
            let action=if stream.kind=="audio"{Action::Audio(stream.index)}else{Action::Embedded(stream.index)};
            row().child(column().flex_1().gap_1().child(format!("#{} {} · {} · {} {}",stream.index,if stream.kind=="audio" {t("音声", "Audio")} else {t("字幕", "Subtitles")},stream.codec,stream.language.as_deref().unwrap_or(""),stream.title.as_deref().unwrap_or("")))
                .when(stream.kind!="audio"&&!stream.supported_text, |body| body.child(muted(t("画像字幕などの非対応形式のため、学習用に抽出できません。", "This subtitle format, such as image captions, cannot be extracted for study.")))))
                .child(compact_button(("use-track",stream.index as usize)).accessibility_id(format!("use-track-{}", stream.index)).label(if stream.kind=="audio"{t("この音声を使う", "Use audio")}else{t("字幕を抽出", "Extract subtitles")})
                .disabled(disabled||(stream.kind!="audio"&&!stream.supported_text)).on_click(cx.listener(move|this,_,_,cx|this.action(action.clone(),cx))))
        }))
        .child(title(t("保存された字幕の版", "Saved subtitle editions")))
        .when(self.versions_loaded && self.versions.is_empty(), |body| body.child(muted(t("保存した字幕の版はありません。字幕を切り替えると、前の版がここに残ります。", "No saved subtitle editions yet. Switching subtitles keeps the previous edition here."))))
        .children(self.versions.iter().enumerate().map(|(index,version)|{
            let id=version.id.clone();row().child(div().flex_1().child(format!("{} · {} · {} {}",version.created_at,version.label,version.segments.len(),t("行", "rows"))))
            .child(compact_button(("restore-subtitles",index)).accessibility_id(format!("restore-subtitles-{index}")).label(t("この字幕へ切り替える", "Use these subtitles")).disabled(disabled).on_click(cx.listener(move|this,_,_,cx|this.action(Action::RestoreVersion(id.clone()),cx))))
        }))
        .child(div().pt_4().border_t_1().border_color(cx.theme().border).child(button("remove-media").danger().accessibility_id("remove-media").label(t("ライブラリから除外", "Remove from library")).disabled(disabled).on_click(cx.listener(|this,_,_,cx|this.action(Action::Remove,cx)))))
        .when_some(self.confirm.clone(),|body,action|body.child(column().p_4().rounded(px(8.)).border_1().border_color(if action==Action::Remove { cx.theme().danger } else { cx.theme().border })
            .child(div().font_weight(gpui_kit::FontWeight::SEMIBOLD).child(media_name.clone()))
            .child(muted(match &action {
                Action::Embedded(index) => format!("{} #{index}", t("切り替える字幕トラック", "Subtitle track to use")),
                Action::RestoreVersion(id) => self.versions.iter().find(|version| &version.id == id).map(|version| format!("{} · {}", version.created_at, version.label)).unwrap_or_else(|| id.clone()),
                Action::Import => t("SRT / WebVTT の字幕ファイルを選択します。", "Choose an SRT / WebVTT subtitle file.").into(),
                _ => String::new(),
            }))
            .child(div().child(if action==Action::Remove{t("教材と字幕を除外します。元のファイルと保存したフレーズ・音声・復習履歴は残ります。", "Remove media and subtitles; original files, phrases, clips and reviews stay.")}else{t("現在の字幕を置き換えます。前の版は保存されます。", "Replace the current subtitles; the previous edition is retained.")}))
            .child(row().justify_end()
                .child(button("cancel-media-change").accessibility_id("cancel-media-change").label(t("キャンセル", "Cancel")).disabled(disabled).on_click(cx.listener(|this,_,_,cx|{this.confirm=None;cx.notify();})))
                .child(button("confirm-media-change").accessibility_id("confirm-media-change").when(action==Action::Remove, |button|button.danger()).when(action!=Action::Remove, |button|button.primary())
                    .label(if action==Action::Remove {t("ライブラリから除外する", "Remove from library")} else if action==Action::Import {t("字幕ファイルを選ぶ", "Choose subtitle file")} else {t("この字幕へ切り替える", "Use these subtitles")})
                    .disabled(disabled).on_click(cx.listener(move|this,_,_,cx|this.action(action.clone(),cx)))))))
        .when_some(self.error.clone(),|body,error|body.child(div().text_color(cx.theme().danger).child(error)))
        .when_some(self.notice.clone(),|body,notice|body.child(muted(notice)))
        .child(row().justify_end().child(button("close-media").accessibility_id("close-media").label(t("閉じる", "Close")).disabled(self.busy).on_click(|_,window,_|window.remove_window())))
    }
}
