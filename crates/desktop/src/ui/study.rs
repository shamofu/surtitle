// SPDX-License-Identifier: GPL-3.0-or-later
use super::keyboard::Slider;
use super::source_editors::SourceEditors;
use super::{
    captions::{CaptionIndex, marked, transcript_rows},
    library::timestamp,
    session::{Session, UiEvent, run},
    style::*,
};
use crate::{application::changes::ChangeDomain, commands, player::Bounds};
use gpui_kit::Focusable;
use gpui_kit::assets::IconName;
use gpui_kit::base::{Disableable, TestSupportExt};
use gpui_kit::component::{
    ActiveTheme,
    button::{Button, ButtonVariants},
    input::{Input, InputEvent, InputState},
    menu::{DropdownMenu, PopupMenuItem},
    slider::{SliderEvent, SliderState, SliderValue},
};
use gpui_kit::{
    AppContext, Context, Entity, Subscription, Window, canvas, div, prelude::*, px, rgb,
    uniform_list,
};
use std::{collections::BTreeSet, sync::Arc};
use surtitle_core::SubtitleSegment;

mod controls;
mod panels;
use controls::{PendingControl, WheelSteps};
use panels::{BoundCandidate, CompanionTab};

pub(crate) struct StudyView {
    pub media_id: String,
    session: Entity<Session>,
    sources: Entity<SourceEditors>,
    editors: Entity<super::editors::EditorRegistry>,
    segments: Arc<Vec<SubtitleSegment>>,
    captions: CaptionIndex,
    selected: BTreeSet<usize>,
    show_translation: bool,
    loading: bool,
    reload: bool,
    error: Option<String>,
    seek: Entity<SliderState>,
    seek_target: Option<u64>,
    seek_control: PendingControl,
    volume: Entity<SliderState>,
    volume_control: PendingControl,
    video_wheel: WheelSteps,
    volume_wheel: WheelSteps,
    rate: Entity<SliderState>,
    focus: gpui_kit::FocusHandle,
    looping: Option<(u64, u64)>,
    selection_source: Option<String>,
    follow: bool,
    last_caption: Option<usize>,
    list_scroll: gpui_kit::UniformListScrollHandle,
    rebind_request: Option<String>,
    search: Entity<InputState>,
    marked_only: bool,
    visible: Arc<Vec<usize>>,
    load_succeeded: bool,
    load_error: Option<String>,
    has_marked: bool,
    loop_source: Option<Vec<SubtitleSegment>>,
    loop_revision: u64,
    empty_issues: Vec<surtitle_core::TranscriptIssueRecord>,
    companion_open: bool,
    companion_tab: CompanionTab,
    candidates: Vec<BoundCandidate>,
    candidates_loading: bool,
    candidates_error: Option<String>,
    candidate_busy: bool,
    rate_footprint: Arc<std::sync::Mutex<Option<crate::player::SurfaceRect>>>,
    rate_open: bool,
    settings_open: bool,
    meaning_cues: Vec<SubtitleSegment>,
    meaning_term: Option<String>,
    meaning_resume: u64,
    meaning_visible: bool,
    meaning_signature: String,
    meaning_waiting: bool,
    _subscriptions: Vec<Subscription>,
}

impl StudyView {
    pub fn new(
        media_id: String,
        session: Entity<Session>,
        editors: Entity<super::editors::EditorRegistry>,
        sources: Entity<SourceEditors>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let focus = cx.focus_handle();
        focus.focus(window, cx);
        let search_placeholder = session.read(cx).text("字幕を検索", "Search subtitles");
        let search = cx.new(|cx| InputState::new(window, cx).placeholder(search_placeholder));
        let search_events = cx.subscribe(&search, |this, _, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                this.follow = false;
                this.filter(cx);
            }
        });
        let seek = cx.new(|_| SliderState::new().min(0.).max(10000.).step(1.));
        let volume = cx.new(|_| {
            SliderState::new()
                .min(0.)
                .max(100.)
                .step(1.)
                .default_value(80.)
        });
        let rate = cx.new(|_| {
            SliderState::new()
                .min(0.25)
                .max(3.)
                .step(0.05)
                .default_value(1.)
        });
        let seek_events = cx.subscribe(&seek, |this, _, event: &SliderEvent, cx| {
            if let SliderEvent::Change(SliderValue::Single(fraction)) = event {
                let duration = this.session.read(cx).player.duration_ms;
                if duration > 0 {
                    let position = (duration as f64 * f64::from(*fraction) / 10000.) as u64;
                    this.seek_target = Some(position);
                    this.control("seek", Some(position as f64), cx);
                }
            }
        });
        let volume_events = cx.subscribe(&volume, |this, _, event: &SliderEvent, cx| {
            if let SliderEvent::Change(SliderValue::Single(value)) = event {
                this.control("volume", Some(f64::from(*value)), cx);
            }
        });
        let rate_events = cx.subscribe(&rate, |this, _, event: &SliderEvent, cx| {
            if let SliderEvent::Change(SliderValue::Single(value)) = event {
                // Slider values are f32; send exact 0.05 increments to playback.
                this.control("rate", Some((f64::from(*value) * 20.).round() / 20.), cx);
                cx.notify();
            }
        });
        let changes =
            cx.subscribe_in(
                &session,
                window,
                |this, _, event: &UiEvent, window, cx| match event {
                    UiEvent::Changed(change)
                        if matches!(
                            change.domain,
                            ChangeDomain::Subtitles | ChangeDomain::Restore
                        ) && change
                            .entity_id
                            .as_ref()
                            .is_none_or(|id| id == &this.media_id) =>
                    {
                        this.refresh(cx);
                        this.refresh_candidates(cx);
                    }
                    UiEvent::Playback => {
                        if !this.load_succeeded
                            || this.session.read(cx).player.media_id.as_deref()
                                != Some(this.media_id.as_str())
                        {
                            cx.notify();
                            return;
                        }
                        let state = &this.session.read(cx).player;
                        let position = state.position_ms;
                        let duration = state.duration_ms;
                        let volume = this.volume_control.target.unwrap_or(state.volume);
                        let rate = state.rate;
                        if this
                            .seek_target
                            .is_some_and(|target| position.abs_diff(target) < 300)
                            || state.error.is_some()
                        {
                            this.seek_target = None;
                        }
                        if this.seek_target.is_none() && duration > 0 {
                            this.seek.update(cx, |slider, cx| {
                                slider.set_value(
                                    (position as f64 / duration as f64 * 10000.) as f32,
                                    window,
                                    cx,
                                )
                            });
                        }
                        this.volume
                            .update(cx, |slider, cx| slider.set_value(volume as f32, window, cx));
                        this.rate
                            .update(cx, |slider, cx| slider.set_value(rate as f32, window, cx));
                        let current = this.current_caption(cx);
                        if this.follow
                            && current != this.last_caption
                            && let Some(index) =
                                current.and_then(|index| this.visible.binary_search(&index).ok())
                        {
                            this.list_scroll
                                .scroll_to_item(index, gpui_kit::ScrollStrategy::Center);
                        }
                        this.last_caption = current;
                        cx.notify();
                    }
                    UiEvent::SurfaceClick => {
                        // The native video child does not pass through GPUI's
                        // pointer focus dispatch. Leave any caption input before
                        // returning playback shortcuts to the study surface.
                        this.focus.focus(window, cx);
                        this.control("toggle-pause", None, cx);
                    }
                    UiEvent::Snapshot => {
                        let placeholder =
                            this.session.read(cx).text("字幕を検索", "Search subtitles");
                        this.search.update(cx, |search, cx| {
                            search.set_placeholder(placeholder, window, cx)
                        });
                        cx.notify();
                    }
                    UiEvent::Changed(change) if change.domain == ChangeDomain::Review => {
                        this.refresh_candidates(cx);
                    }
                    _ => {}
                },
            );
        let services = session.read(cx).backend.state.clone();
        cx.on_release(move |_, _| {
            let _ = services.hide_player_surface();
        })
        .detach();
        let mut this = Self {
            media_id,
            session,
            sources,
            editors,
            segments: Arc::new(vec![]),
            captions: CaptionIndex::new(&[]),
            selected: BTreeSet::new(),
            show_translation: false,
            loading: false,
            reload: false,
            error: None,
            seek,
            seek_target: None,
            seek_control: Default::default(),
            volume,
            volume_control: Default::default(),
            video_wheel: Default::default(),
            volume_wheel: Default::default(),
            rate,
            focus,
            looping: None,
            selection_source: None,
            follow: true,
            last_caption: None,
            list_scroll: gpui_kit::UniformListScrollHandle::new(),
            rebind_request: None,
            search,
            marked_only: false,
            visible: Arc::new(vec![]),
            load_succeeded: false,
            load_error: None,
            has_marked: false,
            loop_source: None,
            loop_revision: 0,
            empty_issues: vec![],
            companion_open: true,
            companion_tab: CompanionTab::Transcript,
            candidates: vec![],
            candidates_loading: false,
            candidates_error: None,
            candidate_busy: false,
            rate_footprint: Default::default(),
            rate_open: false,
            settings_open: false,
            meaning_cues: vec![],
            meaning_term: None,
            meaning_resume: 0,
            meaning_visible: true,
            meaning_signature: String::new(),
            meaning_waiting: false,
            _subscriptions: vec![
                seek_events,
                volume_events,
                rate_events,
                changes,
                search_events,
            ],
        };
        this.load_media(cx);
        this.refresh(cx);
        this.refresh_candidates(cx);
        this
    }
    fn load_media(&mut self, cx: &mut Context<Self>) {
        self.seek_control.reset();
        self.volume_control.reset();
        self.seek_target = None;
        self.load_succeeded = false;
        self.load_error = None;
        let backend = self.session.read(cx).backend.clone();
        let state = backend.state.clone();
        let host = backend.host.clone();
        let media = self.media_id.clone();
        let task = commands::playback::load_media(host, &state, media);
        run(&backend, cx, task, |this, result, _| {
            this.load_succeeded = result.is_ok();
            this.load_error = result.err();
        });
    }
    fn refresh(&mut self, cx: &mut Context<Self>) {
        if self.loading {
            self.reload = true;
            return;
        }
        self.loading = true;
        self.reload = false;
        let backend = self.session.read(cx).backend.clone();
        let state = backend.state.clone();
        let media = self.media_id.clone();
        run(
            &backend,
            cx,
            async move {
                let segments = commands::subtitles::list_segments(&state, media.clone())?;
                let issues = commands::ai::list_transcript_issues(&state, media)?;
                Ok((segments, issues))
            },
            |this, result, cx| {
                this.loading = false;
                match result {
                    Ok((segments, issues)) => {
                        this.empty_issues = issues
                            .into_iter()
                            .filter(|issue| {
                                issue.active
                                    && !segments.iter().any(|cue| {
                                        cue.start_ms < issue.end_ms && cue.end_ms > issue.start_ms
                                    })
                            })
                            .collect();
                        if this.loop_source.as_ref().is_some_and(|source| {
                            source.iter().any(|old| {
                                !segments.iter().any(|new| {
                                    old.id == new.id
                                        && old.start_ms == new.start_ms
                                        && old.end_ms == new.end_ms
                                        && old.text == new.text
                                        && old.status == new.status
                                        && old.timing_precision == new.timing_precision
                                })
                            })
                        }) {
                            this.set_loop(None, cx);
                        }
                        let selected_ids: BTreeSet<_> = this
                            .selected
                            .iter()
                            .filter_map(|index| this.segments.get(*index))
                            .map(|cue| cue.id.clone())
                            .collect();
                        this.selected = segments
                            .iter()
                            .enumerate()
                            .filter(|(_, cue)| selected_ids.contains(&cue.id))
                            .map(|(index, _)| index)
                            .collect();
                        this.captions = CaptionIndex::new(&segments);
                        this.has_marked = segments.iter().any(marked);
                        this.segments = Arc::new(segments);
                        this.refresh_meaning_projection(cx);
                        this.filter(cx);
                        this.error = None;
                    }
                    Err(error) => this.error = Some(error),
                }
                if this.reload {
                    this.refresh(cx);
                }
            },
        );
    }
    fn playback_ready(&self, cx: &gpui_kit::App) -> bool {
        let player = &self.session.read(cx).player;
        self.load_succeeded
            && player.ready
            && player.media_id.as_deref() == Some(self.media_id.as_str())
    }
    fn filter(&mut self, cx: &mut Context<Self>) {
        self.visible = Arc::new(transcript_rows(
            &self.segments,
            self.search.read(cx).value().as_ref(),
            self.marked_only,
        ));
        cx.notify();
    }
    fn follow_playback(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(index) = self.current_caption(cx) {
            if self.visible.binary_search(&index).is_err() {
                self.marked_only = false;
                self.search
                    .update(cx, |search, cx| search.set_value("", window, cx));
                self.filter(cx);
            }
            if let Ok(row) = self.visible.binary_search(&index) {
                self.list_scroll
                    .scroll_to_item(row, gpui_kit::ScrollStrategy::Center);
            }
        }
        self.follow = true;
        cx.notify();
    }
    fn control(&mut self, action: &str, value: Option<f64>, cx: &mut Context<Self>) {
        if self.sources.read(cx).frozen() || (action != "fullscreen" && !self.playback_ready(cx)) {
            return;
        }
        let value = if action == "seek" {
            value.map(|value| value.clamp(0., self.session.read(cx).player.duration_ms as f64))
        } else {
            value
        };
        let backend = self.session.read(cx).backend.clone();
        let state = backend.state.clone();
        let host = backend.host.clone();
        let media = self.media_id.clone();
        let request = crate::player::Control {
            action: action.into(),
            value,
            start_ms: None,
            end_ms: None,
            bounds: None,
            track_kind: None,
        };
        if request.action == "fullscreen" {
            run(
                &backend,
                cx,
                async move { commands::playback::player_control(host, &state, request).await },
                |this, result, _| this.error = result.err(),
            );
            return;
        }
        let task = commands::playback::player_control_for_media(host, &state, media, request);
        let clears_loop = action == "seek";
        if clears_loop {
            self.loop_revision += 1;
            self.loop_source = None;
            self.looping = None;
        }
        if let Some(value) = value {
            if action == "seek" {
                self.seek_target = Some(value as u64);
                self.seek_control.enqueue(value, Box::pin(task));
                self.start_pending_control("seek", cx);
                cx.notify();
                return;
            }
            if action == "volume" {
                self.volume_control.enqueue(value, Box::pin(task));
                self.start_pending_control("volume", cx);
                cx.notify();
                return;
            }
        }
        run(&backend, cx, task, move |this, result, _| {
            if result.is_ok() && clears_loop {
                this.looping = None;
                this.loop_source = None;
            }
            this.error = result.err()
        });
    }
    fn loop_selection(&mut self, cx: &mut Context<Self>) {
        if self.sources.read(cx).frozen() || !self.playback_ready(cx) {
            return;
        }
        let range = if self.looping.is_some() {
            None
        } else {
            let current = self
                .captions
                .at(self.session.read(cx).player.position_ms)
                .active;
            let selected: Vec<_> = if self.selected.is_empty() {
                current.into_iter().collect()
            } else {
                self.selected.iter().copied().collect()
            };
            let cues: Vec<_> = selected
                .into_iter()
                .filter_map(|index| self.segments.get(index))
                .filter(|cue| cue.end_ms > cue.start_ms)
                .collect();
            let Some(start) = cues.iter().map(|cue| cue.start_ms).min() else {
                self.error = Some("繰り返す字幕を選んでください / Select subtitles to loop".into());
                cx.notify();
                return;
            };
            self.loop_source = Some(cues.iter().map(|cue| (*cue).clone()).collect());
            Some((start, cues.iter().map(|cue| cue.end_ms).max().unwrap()))
        };
        self.set_loop(range, cx);
    }
    fn set_loop(&mut self, range: Option<(u64, u64)>, cx: &mut Context<Self>) {
        self.loop_revision += 1;
        let revision = self.loop_revision;
        if range.is_none() {
            self.loop_source = None;
            self.looping = None;
        }
        let request = crate::player::Control {
            action: "source-loop".into(),
            value: None,
            start_ms: range.map(|range| range.0),
            end_ms: range.map(|range| range.1),
            bounds: None,
            track_kind: None,
        };
        let backend = self.session.read(cx).backend.clone();
        let state = backend.state.clone();
        let host = backend.host.clone();
        let media = self.media_id.clone();
        let task = commands::playback::player_control_for_media(host, &state, media, request);
        self.queue_position_control(
            task,
            move |this, result, _| {
                if this.loop_revision != revision {
                    return;
                }
                match result {
                    Ok(()) => this.looping = range,
                    Err(error) => {
                        this.loop_source = None;
                        this.error = Some(error);
                    }
                }
            },
            cx,
        );
    }
    fn play_cues(&mut self, ids: Vec<String>, cx: &mut Context<Self>) {
        if self.sources.read(cx).frozen() || !self.playback_ready(cx) {
            return;
        }
        let backend = self.session.read(cx).backend.clone();
        self.loop_revision += 1;
        self.loop_source = None;
        self.looping = None;
        let state = backend.state.clone();
        let host = backend.host.clone();
        let media = self.media_id.clone();
        let task = commands::playback::play_source_range(host, &state, media, ids);
        self.queue_position_control(
            task,
            |this, result, _| {
                if result.is_ok() {
                    this.looping = None;
                    this.loop_source = None;
                }
                this.error = result.err();
            },
            cx,
        );
    }
    fn import_subtitles(&mut self, cx: &mut Context<Self>) {
        if self.sources.read(cx).frozen() {
            return;
        }
        let backend = self.session.read(cx).backend.clone();
        let state = backend.state.clone();
        let media = self.media_id.clone();
        // Native use case rejects replacement until the user has explicitly confirmed it.
        run(
            &backend,
            cx,
            async move { commands::subtitles::import_subtitles(&state, media, Some(false)).await },
            |this, result, cx| match result {
                Ok(true) => this.refresh(cx),
                Ok(false) => {}
                Err(error) => this.error = Some(error),
            },
        );
    }
    fn listen_issue(&mut self, start: u64, end: u64, cx: &mut Context<Self>) {
        if self.sources.read(cx).frozen() || !self.playback_ready(cx) {
            return;
        }
        self.loop_revision += 1;
        self.loop_source = None;
        self.looping = None;
        let backend = self.session.read(cx).backend.clone();
        let request = crate::player::Control {
            action: "source-seek".into(),
            value: None,
            start_ms: Some(start),
            end_ms: Some(end),
            bounds: None,
            track_kind: None,
        };
        let task = commands::playback::player_control_for_media(
            backend.host.clone(),
            &backend.state,
            self.media_id.clone(),
            request,
        );
        self.queue_position_control(task, |this, result, _| this.error = result.err(), cx);
    }
    fn selected_text(
        &self,
        window: &mut Window,
        cx: &mut gpui_kit::App,
    ) -> Option<(SubtitleSegment, String)> {
        let text = gpui_kit::base::TextSelection::selected_text(window, cx)
            .trim()
            .to_owned();
        if text.is_empty() {
            return None;
        }
        self.selection_source
            .as_ref()
            .and_then(|id| {
                self.segments
                    .iter()
                    .find(|cue| &cue.id == id && cue.text.contains(&text))
            })
            .map(|cue| (cue.clone(), text))
    }
    fn select_text_source(&mut self, id: Option<String>, cx: &mut Context<Self>) {
        self.selection_source = id;
        self.follow = false;
        self.control("pause", None, cx);
    }
    fn edit_source(&mut self, kind: &str, window: &mut Window, cx: &mut Context<Self>) {
        if self.sources.read(cx).frozen() {
            return;
        }
        let current = self.current_caption(cx);
        let selected: Vec<_> = if self.selected.is_empty() {
            current.into_iter().collect()
        } else {
            self.selected.iter().copied().collect()
        };
        let mut cues: Vec<_> = selected
            .into_iter()
            .filter_map(|index| self.segments.get(index).cloned())
            .collect();
        let term = if let Some((cue, text)) = self.selected_text(window, cx) {
            cues = vec![cue];
            Some(text)
        } else {
            None
        };
        if let Err(error) = super::source_form::open_with_term(
            self.session.clone(),
            self.sources.clone(),
            kind,
            cues,
            term,
            cx,
        ) {
            self.error = Some(error.to_string());
            cx.notify();
        }
    }
    fn current_caption(&self, cx: &gpui_kit::App) -> Option<usize> {
        let session = self.session.read(cx);
        let frame = self.captions.at(session.player.position_ms);
        frame.active.or(
            if session
                .snapshot
                .as_ref()
                .is_some_and(|snapshot| snapshot.settings.caption_gap_mode == "preview")
            {
                frame.next
            } else {
                frame.previous
            },
        )
    }
    pub fn rebind_ai(&mut self, id: String, cx: &mut Context<Self>) {
        self.rebind_request = Some(id);
        self.selected.clear();
        cx.notify();
    }
    fn confirm_ai_source(&mut self, cx: &mut Context<Self>) {
        if self.sources.read(cx).frozen() {
            return;
        }
        let Some(id) = self.rebind_request.clone() else {
            return;
        };
        let cues: Vec<_> = self
            .selected
            .iter()
            .filter_map(|index| self.segments.get(*index).cloned())
            .collect();
        if cues.is_empty() {
            return;
        }
        self.session
            .update(cx, |session, cx| session.confirm_ai_source(id, cues, cx));
    }
    fn request_ai(&mut self, kind: super::ai::AiKind, window: &mut Window, cx: &mut Context<Self>) {
        if self.sources.read(cx).frozen() {
            return;
        }
        let mut selected: Vec<_> = self
            .selected
            .iter()
            .filter_map(|index| self.segments.get(*index).cloned())
            .collect();
        let focus_term = if let Some((cue, text)) = self.selected_text(window, cx) {
            selected = vec![cue];
            Some(text)
        } else {
            None
        };
        let start_ms = selected.iter().map(|cue| cue.start_ms).min().unwrap_or(0);
        let end_ms = selected
            .iter()
            .map(|cue| cue.end_ms)
            .max()
            .unwrap_or_else(|| {
                self.session
                    .read(cx)
                    .snapshot
                    .as_ref()
                    .and_then(|snapshot| {
                        snapshot
                            .media
                            .iter()
                            .find(|media| media.id == self.media_id)
                    })
                    .map(|media| media.duration_ms)
                    .unwrap_or(0)
            });
        let intent = super::ai::AiIntent {
            media_id: self.media_id.clone(),
            kind,
            start_ms,
            end_ms,
            focus_term,
        };
        self.session
            .update(cx, |session, cx| session.request_ai(intent, selected, cx));
    }
}

impl Render for StudyView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let subtitle_panel = self.companion_open && !window.is_fullscreen();
        if (!subtitle_panel || self.companion_tab != CompanionTab::Transcript)
            && self.search.read(cx).focus_handle(cx).is_focused(window)
        {
            // Pointer buttons retain prior focus. Do not strand it on a search
            // editor removed by fullscreen, closing, or changing the companion.
            self.focus.focus(window, cx);
        }
        let session = self.session.read(cx);
        let japanese = session.text("ja", "en") == "ja";
        let t = move |ja: &'static str, en: &'static str| if japanese { ja } else { en };
        let title_text = session
            .snapshot
            .as_ref()
            .and_then(|snapshot| {
                snapshot
                    .media
                    .iter()
                    .find(|media| media.id == self.media_id)
            })
            .map(|media| media.title.clone())
            .unwrap_or_else(|| session.text("読み込み中", "Loading").to_owned());
        let player = if self.load_succeeded
            && session.player.media_id.as_deref() == Some(self.media_id.as_str())
        {
            session.player.clone()
        } else {
            crate::player::PlayerState::default()
        };
        let playback_disabled = !self.playback_ready(cx) || self.sources.read(cx).frozen();
        let backend = session.backend.clone();
        let frame = self.captions.at(player.position_ms);
        let preview = session
            .snapshot
            .as_ref()
            .is_some_and(|snapshot| snapshot.settings.caption_gap_mode == "preview");
        let current = frame
            .active
            .or(if preview { frame.next } else { frame.previous });
        let caption = current.and_then(|index| self.segments.get(index)).cloned();
        let caption_source = caption.as_ref().map(|cue| cue.id.clone());
        let surface_services = backend.state.clone();
        let popup_footprint = self.rate_footprint.clone();
        let show_surface = self.playback_ready(cx);
        let video = div()
            .id("player-viewport")
            .test_support()
            .role(gpui_kit::accesskit::Role::Group)
            .accessibility_id("player-viewport")
            .aria_label(t("映像", "Video"))
            .w_full()
            .flex_1()
            .min_h(px(100.))
            .on_scroll(cx.listener(|this, event, _, cx| this.scroll_video(event, cx)))
            .child(
                canvas(
                    move |rect, window, _| {
                        if !show_surface {
                            let _ = surface_services.hide_player_surface();
                            return;
                        }
                        let _ = surface_services.set_player_bounds(Bounds {
                            x: f32::from(rect.origin.x) as f64,
                            y: f32::from(rect.origin.y) as f64,
                            width: f32::from(rect.size.width) as f64,
                            height: f32::from(rect.size.height) as f64,
                            scale_factor: window.scale_factor() as f64,
                            clip: None,
                            occlusions: popup_footprint
                                .lock()
                                .unwrap()
                                .clone()
                                .into_iter()
                                .map(|rect| crate::player::SurfaceOcclusion {
                                    rect,
                                    border_radius: 12.,
                                })
                                .collect(),
                            input_blocked: false,
                        });
                    },
                    |_, _, _, _| {},
                )
                .size_full(),
            );
        let caption_text = caption
            .as_ref()
            .map(|cue| cue.text.clone())
            .unwrap_or_else(|| {
                session
                    .text(
                        "字幕を追加すると、ここに表示します。",
                        "Add subtitles to display them here.",
                    )
                    .to_owned()
            });
        let translation = caption
            .as_ref()
            .and_then(|cue| cue.translation.clone())
            .unwrap_or_default();
        let selected = self.selected.clone();
        let show_translations = self.show_translation;
        let segments = self.segments.clone();
        let visible = self.visible.clone();
        let view = cx.entity().downgrade();

        let transport = self.transport(&player, playback_disabled, window.is_fullscreen(), cx);
        let rows = uniform_list("subtitle-list", visible.len(), move |range, _, cx| {
            range
                .map(|visible_row| {
                    let index = visible[visible_row];
                    let cue = &segments[index];
                    let select_view = view.clone();
                    let play_view = view.clone();
                    let meaning_view = view.clone();
                    let inspect_view = view.clone();
                    let save_view = view.clone();
                    let selection_view = view.clone();
                    let id = cue.id.clone();
                    let selection_id = id.clone();
                    row()
                        .id(format!("cue-row-{}", cue.id))
                        .test_support()
                        .role(gpui_kit::Role::Group)
                        .w_full()
                        .min_w(px(0.))
                        .h(px(132.))
                        .items_start()
                        .gap_3()
                        .px_3()
                        .py_4()
                        .border_b_1()
                        .border_color(cx.theme().border)
                        .bg(if current == Some(index) || selected.contains(&index) {
                            cx.theme().accent
                        } else {
                            cx.theme().popover
                        })
                        .child(
                            column()
                                .w(px(44.))
                                .flex_shrink_0()
                                .gap_1()
                                .items_center()
                                .child(
                                    icon_button(
                                        format!("cue-play-{}", cue.id),
                                        if current == Some(index) {
                                            IconName::AudioLines
                                        } else {
                                            IconName::Play
                                        },
                                        t("再生", "Play"),
                                    )
                                    .accessibility_id(format!("cue-play-{}", cue.id))
                                    .w(px(32.))
                                    .h(px(28.))
                                    .disabled(playback_disabled)
                                    .on_click(
                                        move |_, _, cx| {
                                            let _ = play_view.update(cx, |this, cx| {
                                                this.play_cues(vec![id.clone()], cx)
                                            });
                                        },
                                    ),
                                )
                                .child(
                                    div()
                                        .text_size(px(12.))
                                        .text_color(cx.theme().muted_foreground)
                                        .child(timestamp(cue.start_ms)),
                                ),
                        )
                        .child(
                            column()
                                .flex_1()
                                .min_w(px(0.))
                                .h(px(100.))
                                .gap_1()
                                .child(
                                    div()
                                        .id(format!("cue-scroll-{}", cue.id))
                                        .test_support()
                                        .role(gpui_kit::accesskit::Role::Group)
                                        .accessibility_id(format!("cue-scroll-{}", cue.id))
                                        .aria_label(t("字幕本文", "Subtitle text"))
                                        .flex_1()
                                        .min_h(px(0.))
                                        .overflow_y_scroll()
                                        .on_click(move |_, window, cx| {
                                            let _ = inspect_view.update(cx, |this, cx| {
                                                this.selected.clear();
                                                this.selected.insert(index);
                                                this.open_meaning(window, cx);
                                            });
                                        })
                                        .on_mouse_down(
                                            gpui_kit::MouseButton::Left,
                                            move |_, _, cx| {
                                                let _ = selection_view.update(cx, |this, cx| {
                                                    this.select_text_source(
                                                        Some(selection_id.clone()),
                                                        cx,
                                                    )
                                                });
                                            },
                                        )
                                        .child(
                                            column()
                                                .id(format!("cue-content-{}", cue.id))
                                                .test_support()
                                                .gap_2()
                                                .child(
                                                    div()
                                                        .id(format!("cue-accessible-text-{}", cue.id))
                                                        .test_support()
                                                        .role(gpui_kit::accesskit::Role::Label)
                                                        .accessibility_id(format!(
                                                            "cue-accessible-text-{}",
                                                            cue.id
                                                        ))
                                                        .aria_value(cue.text.clone())
                                                        .text_size(px(16.))
                                                        .line_height(gpui_kit::relative(1.7))
                                                        .child(
                                                            gpui_kit::base::SelectableText::new(
                                                                format!("cue-text-{}", cue.id),
                                                                cue.text.clone(),
                                                            ),
                                                        ),
                                                )
                                                .when(show_translations, |body| {
                                                    body.when_some(
                                                        cue.translation.clone(),
                                                        |body, translation| {
                                                            body.child(
                                                                div()
                                                                    .id(format!(
                                                                        "cue-translation-{}",
                                                                        cue.id
                                                                    ))
                                                                    .test_support()
                                                                    .role(
                                                                        gpui_kit::accesskit::Role::Label,
                                                                    )
                                                                    .accessibility_id(format!(
                                                                        "cue-translation-{}",
                                                                        cue.id
                                                                    ))
                                                                    .aria_value(translation.clone())
                                                                    .text_size(px(14.))
                                                                    .line_height(
                                                                        gpui_kit::relative(1.7),
                                                                    )
                                                                    .child(translation),
                                                            )
                                                        },
                                                    )
                                                }),
                                        ),
                                )
                                .child(
                                    row()
                                        .justify_end()
                                        .gap_1()
                                        .when(marked(cue), |body| {
                                            body.child(
                                                div()
                                                    .text_size(px(11.))
                                                    .text_color(cx.theme().warning)
                                                    .child(t("要確認", "Review")),
                                            )
                                        })
                                        .child(
                                            icon_button(
                                                format!("cue-select-{}", cue.id),
                                                if selected.contains(&index) {
                                                    IconName::SquareCheck
                                                } else {
                                                    IconName::Square
                                                },
                                                if selected.contains(&index) {
                                                    t("選択解除", "Deselect")
                                                } else {
                                                    t("選択", "Select")
                                                },
                                            )
                                            .accessibility_id(format!("cue-select-{}", cue.id))
                                            .w(px(28.))
                                            .h(px(28.))
                                            .on_click(
                                                move |_, _, cx| {
                                                    let _ = select_view.update(cx, |this, cx| {
                                                        if !this.selected.remove(&index) {
                                                            this.selected.insert(index);
                                                        }
                                                        cx.notify();
                                                    });
                                                },
                                            ),
                                        )
                                        .child(
                                            icon_button(
                                                format!("cue-save-{}", cue.id),
                                                IconName::BookmarkPlus,
                                                t("フレーズを確認・保存", "Review and save phrase"),
                                            )
                                            .w(px(28.))
                                            .h(px(28.))
                                            .disabled(playback_disabled)
                                            .on_click(
                                                move |_, window, cx| {
                                                    let _ = save_view.update(cx, |this, cx| {
                                                        this.selected.clear();
                                                        this.selected.insert(index);
                                                        this.open_meaning(window, cx);
                                                        this.edit_meaning("phrase", cx);
                                                    });
                                                },
                                            ),
                                        )
                                        .child(
                                            icon_button(
                                                format!("cue-more-{}", cue.id),
                                                IconName::Ellipsis,
                                                t("字幕の操作", "Subtitle actions"),
                                            )
                                            .w(px(28.))
                                            .h(px(28.))
                                            .dropdown_menu(move |menu, _, _| {
                                                let edit_view = meaning_view.clone();
                                                let replay_view = meaning_view.clone();
                                                let inspect_view = meaning_view.clone();
                                                menu.item(
                                                    PopupMenuItem::new(t(
                                                        "字幕を編集",
                                                        "Edit subtitle",
                                                    ))
                                                    .on_click(move |_, window, cx| {
                                                        let _ = edit_view.update(cx, |this, cx| {
                                                            this.selected.clear();
                                                            this.selected.insert(index);
                                                            this.edit_source(
                                                                "subtitle", window, cx,
                                                            );
                                                        });
                                                    }),
                                                )
                                                .item(
                                                    PopupMenuItem::new(t(
                                                        "この字幕をもう一度",
                                                        "Replay this subtitle",
                                                    ))
                                                    .on_click(move |_, _, cx| {
                                                        let _ =
                                                            replay_view.update(cx, |this, cx| {
                                                                if let Some(cue) =
                                                                    this.segments.get(index)
                                                                {
                                                                    this.play_cues(
                                                                        vec![cue.id.clone()],
                                                                        cx,
                                                                    );
                                                                }
                                                            });
                                                    }),
                                                )
                                                .item(
                                                    PopupMenuItem::new(t(
                                                        "意味とフレーズ",
                                                        "Meaning and phrases",
                                                    ))
                                                    .on_click(move |_, window, cx| {
                                                        let _ =
                                                            inspect_view.update(cx, |this, cx| {
                                                                this.selected.clear();
                                                                this.selected.insert(index);
                                                                this.open_meaning(window, cx);
                                                            });
                                                    }),
                                                )
                                            }),
                                        ),
                                ),
                        )
                })
                .collect::<Vec<_>>()
        })
        // A transcript wraps within its companion; the UniformList default
        // measures the widest row and would push actions beyond the window.
        .with_horizontal_sizing_behavior(gpui_kit::ListHorizontalSizingBehavior::FitList)
        .track_scroll(&self.list_scroll)
        .w_full()
        .flex_1()
        .min_h(px(0.));
        let transcript = column()
            .flex_1()
            .min_h(px(0.))
            .gap_0()
            .child(
                div().p_3().child(
                    Input::new(&self.search)
                        .id("subtitle-search")
                        .prefix(gpui_kit::component::Icon::new(IconName::Search).size(px(16.))),
                ),
            )
            .child(
                row()
                    .px_3()
                    .pb_2()
                    .gap_1()
                    .flex_wrap()
                    .child(
                        compact_button("import-subtitles")
                            .ghost()
                            .icon(IconName::Captions)
                            .label(t("字幕を追加・切り替え", "Add or switch subtitles"))
                            .on_click(cx.listener(|this, _, _, cx| this.import_subtitles(cx))),
                    )
                    .child(
                        compact_button("transcript-translation")
                            .ghost()
                            .toggled(self.show_translation)
                            .icon(IconName::Languages)
                            .accessibility_label(if self.show_translation {
                                t("訳を隠す", "Hide translations")
                            } else {
                                t("訳を表示", "Show translations")
                            })
                            .child(state_label(
                                if self.show_translation {
                                    t("訳を隠す", "Hide translations")
                                } else {
                                    t("訳を表示", "Show translations")
                                },
                                &[
                                    t("訳を隠す", "Hide translations"),
                                    t("訳を表示", "Show translations"),
                                ],
                            ))
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.show_translation = !this.show_translation;
                                cx.notify();
                            })),
                    ),
            )
            .child(
                compact_button("marked-subtitles")
                    .ghost()
                    .role(gpui_kit::accesskit::Role::CheckBox)
                    .toggled(self.marked_only)
                    .icon(if self.marked_only {
                        IconName::SquareCheck
                    } else {
                        IconName::Square
                    })
                    .label(t("注意のある箇所だけ表示", "Show marked passages only"))
                    .text_size(px(12.))
                    .mx_2()
                    .disabled(!self.marked_only && !self.has_marked)
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.marked_only = !this.marked_only;
                        this.follow = false;
                        this.filter(cx);
                    })),
            )
            .child(
                compact_button("reset-subtitle-filters")
                    .ghost()
                    .label(t("絞り込みをリセット", "Reset filters"))
                    .disabled(!self.marked_only && self.search.read(cx).value().is_empty())
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.marked_only = false;
                        this.search
                            .update(cx, |search, cx| search.set_value("", window, cx));
                        this.filter(cx);
                    })),
            )
            .when(!self.empty_issues.is_empty(), |body| {
                body.child(
                    column()
                        .id("empty-transcript-issues")
                        .max_h(px(140.))
                        .overflow_y_scroll()
                        .p_3()
                        .gap_1()
                        .child(muted(t(
                            "字幕がない要確認区間",
                            "Passages without subtitles to check",
                        )))
                        .children(self.empty_issues.iter().enumerate().map(|(index, issue)| {
                            let (start, end) = (issue.start_ms, issue.end_ms);
                            column()
                                .gap_1()
                                .child(
                                    compact_button(("listen-empty-issue", index))
                                        .ghost()
                                        .icon(IconName::Play)
                                        .label(format!("{}–{}", timestamp(start), timestamp(end)))
                                        .disabled(playback_disabled)
                                        .on_click(cx.listener(move |this, _, _, cx| {
                                            this.listen_issue(start, end, cx)
                                        })),
                                )
                                .children(issue.alternatives.iter().map(|alternative| {
                                    muted(format!(
                                        "{}–{} {}",
                                        timestamp(alternative.start_ms),
                                        timestamp(alternative.end_ms),
                                        alternative.text
                                    ))
                                }))
                        })),
                )
            })
            .child(rows)
            .child(
                row()
                    .px_3()
                    .py_2()
                    .justify_between()
                    .gap_2()
                    .border_t_1()
                    .border_color(cx.theme().border)
                    .child(
                        div()
                            .text_size(px(12.))
                            .text_color(cx.theme().muted_foreground)
                            .child(t(
                                "本文で確認、時刻から再生",
                                "Inspect text, play from timestamp",
                            )),
                    )
                    .child(
                        compact_button("follow-subtitles")
                            .ghost()
                            .icon(IconName::Crosshair)
                            .text_color(if self.follow {
                                cx.theme().primary
                            } else {
                                cx.theme().muted_foreground
                            })
                            .accessibility_label(if self.follow {
                                t("自動追従中", "Following playback")
                            } else {
                                t("再生位置に戻る", "Follow playback")
                            })
                            .child(state_label(
                                if self.follow {
                                    t("自動追従中", "Following playback")
                                } else {
                                    t("再生位置に戻る", "Follow playback")
                                },
                                &[
                                    t("自動追従中", "Following playback"),
                                    t("再生位置に戻る", "Follow playback"),
                                ],
                            ))
                            .text_size(px(12.))
                            .on_click(
                                cx.listener(|this, _, window, cx| this.follow_playback(window, cx)),
                            ),
                    ),
            );
        let panel_heading = match self.companion_tab {
            CompanionTab::Meaning => t("意味とフレーズ", "Meaning and phrases"),
            CompanionTab::Tools => t("処理・管理", "Activity & tools"),
            _ => t("字幕", "Transcript"),
        };
        let companion_width = if f32::from(window.viewport_size().width) >= 1400. {
            360.
        } else {
            320.
        };
        let companion = column()
            .id("subtitle-panel")
            .w(px(companion_width))
            .flex_shrink_0()
            .min_h(px(0.))
            .gap_0()
            .rounded(px(12.))
            .border_1()
            .border_color(cx.theme().border)
            .bg(cx.theme().popover)
            .overflow_hidden()
            .child(
                row()
                    .px_4()
                    .py_3()
                    .justify_between()
                    .gap_2()
                    .border_b_1()
                    .border_color(cx.theme().border)
                    .child(
                        div()
                            .text_size(px(16.))
                            .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                            .child(panel_heading),
                    )
                    .child(
                        icon_button("close-study-companion", IconName::X, t("閉じる", "Close"))
                            .w(px(32.))
                            .h(px(32.))
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.companion_open = false;
                                cx.notify();
                            })),
                    ),
            )
            .when(
                !matches!(
                    self.companion_tab,
                    CompanionTab::Meaning | CompanionTab::Tools
                ),
                |body| body.child(self.companion_tabs(cx)),
            )
            .when(self.companion_tab == CompanionTab::Transcript, |body| {
                body.child(transcript)
            })
            .when(self.companion_tab == CompanionTab::Transcription, |body| {
                body.child(self.transcription_panel(cx))
            })
            .when(self.companion_tab == CompanionTab::Suggestions, |body| {
                body.child(self.suggestions_panel(cx))
            })
            .when(self.companion_tab == CompanionTab::Meaning, |body| {
                body.child(self.meaning_panel(cx))
            })
            .when(self.companion_tab == CompanionTab::Tools, |body| {
                body.child(self.tools_panel(cx))
            });
        let content = row()
            .flex_1()
            .min_h(px(0.))
            .items_stretch()
            .gap_4()
            .child(
                column()
                    .flex_1()
                    .min_w(px(0.))
                    .min_h(px(0.))
                    .gap_0()
                    .child(
                        column()
                            .flex_1()
                            .min_h(px(180.))
                            .gap_0()
                            .rounded(px(8.))
                            .overflow_hidden()
                            .bg(rgb(0x000000))
                            .child(video)
                            .child(transport),
                    )
                    .child(
                        column()
                            .h(px(180.))
                            .flex_shrink_0()
                            .pt_4()
                            .gap_2()
                            .child(
                                div()
                                    .id("caption-selection")
                                    .test_support()
                                    .role(gpui_kit::accesskit::Role::Group)
                                    .accessibility_id("caption-selection")
                                    .aria_label(t("現在の字幕", "Current subtitle"))
                                    .flex_1()
                                    .min_h(px(0.))
                                    .overflow_y_scroll()
                                    .px_1()
                                    .on_mouse_down(
                                        gpui_kit::MouseButton::Left,
                                        cx.listener(move |this, _, _, cx| {
                                            this.select_text_source(caption_source.clone(), cx)
                                        }),
                                    )
                                    .text_size(px(28.))
                                    .line_height(gpui_kit::relative(1.4))
                                    .child(
                                        div()
                                            .id("caption-accessible-text")
                                            .test_support()
                                            .role(gpui_kit::accesskit::Role::Label)
                                            .accessibility_id("caption-accessible-text")
                                            .aria_value(caption_text.clone())
                                            .child(gpui_kit::base::SelectableText::new(
                                                "caption-text",
                                                caption_text,
                                            )),
                                    ),
                            )
                            .when(self.show_translation, |body| {
                                body.child(
                                    div()
                                        .id("caption-translation-text")
                                        .test_support()
                                        .role(gpui_kit::accesskit::Role::Label)
                                        .accessibility_id("caption-translation-text")
                                        .aria_value(translation.clone())
                                        .flex_1()
                                        .min_h(px(0.))
                                        .overflow_y_scroll()
                                        .px_1()
                                        .pt_2()
                                        .border_t_1()
                                        .border_color(cx.theme().border)
                                        .text_size(px(15.))
                                        .line_height(gpui_kit::relative(1.7))
                                        .child(translation),
                                )
                            })
                            .child(
                                row()
                                    .justify_between()
                                    .items_end()
                                    .gap_2()
                                    .flex_wrap()
                                    .child(
                                        row()
                                            .gap_1()
                                            .child(
                                                compact_button("caption-translation")
                                                    .ghost()
                                                    .toggled(self.show_translation)
                                                    .icon(IconName::Languages)
                                                    .accessibility_label(if self.show_translation {
                                                        t("訳を隠す", "Hide translation")
                                                    } else {
                                                        t("訳を表示", "Show translation")
                                                    })
                                                    .child(state_label(
                                                        if self.show_translation {
                                                            t("訳を隠す", "Hide translation")
                                                        } else {
                                                            t("訳を表示", "Show translation")
                                                        },
                                                        &[
                                                            t("訳を隠す", "Hide translation"),
                                                            t("訳を表示", "Show translation"),
                                                        ],
                                                    ))
                                                    .on_click(cx.listener(|this, _, _, cx| {
                                                        this.show_translation =
                                                            !this.show_translation;
                                                        cx.notify();
                                                    })),
                                            )
                                            .child(
                                                button("explore-meaning")
                                                    .label(t("意味を調べる", "Explore meaning"))
                                                    .disabled(
                                                        caption.is_none()
                                                            || self.sources.read(cx).frozen(),
                                                    )
                                                    .on_click(cx.listener(
                                                        |this, _, window, cx| {
                                                            this.open_meaning(window, cx)
                                                        },
                                                    )),
                                            )
                                            .child(
                                                compact_button("save-phrase")
                                                    .ghost()
                                                    .icon(IconName::BookmarkPlus)
                                                    .label(t("保存", "Save"))
                                                    .disabled(
                                                        caption.is_none()
                                                            || self.sources.read(cx).frozen(),
                                                    )
                                                    .on_click(cx.listener(
                                                        |this, _, window, cx| {
                                                            this.edit_source("phrase", window, cx)
                                                        },
                                                    )),
                                            ),
                                    )
                                    .child(
                                        row()
                                            .gap_1()
                                            .pl_2()
                                            .border_l_1()
                                            .border_color(cx.theme().border)
                                            .child(
                                                column()
                                                    .gap_0()
                                                    .items_center()
                                                    .child(muted(
                                                        frame
                                                            .previous
                                                            .and_then(|index| {
                                                                self.segments.get(index)
                                                            })
                                                            .map(|cue| timestamp(cue.start_ms))
                                                            .unwrap_or_else(|| "—".into()),
                                                    ))
                                                    .child(
                                                        compact_button("previous-cue")
                                                            .ghost()
                                                            .icon(IconName::ChevronLeft)
                                                            .label(t("前の字幕", "Previous"))
                                                            .disabled(
                                                                playback_disabled
                                                                    || frame.previous.is_none(),
                                                            )
                                                            .on_click(cx.listener(
                                                                move |this, _, _, cx| {
                                                                    if let Some(cue) = frame
                                                                        .previous
                                                                        .and_then(|index| {
                                                                            this.segments.get(index)
                                                                        })
                                                                    {
                                                                        this.play_cues(
                                                                            vec![cue.id.clone()],
                                                                            cx,
                                                                        );
                                                                    }
                                                                },
                                                            )),
                                                    ),
                                            )
                                            .child(
                                                button("replay-cue")
                                                    .icon(IconName::RotateCcw)
                                                    .label(t(
                                                        "この字幕をもう一度",
                                                        "Replay subtitle",
                                                    ))
                                                    .disabled(
                                                        playback_disabled || current.is_none(),
                                                    )
                                                    .on_click(cx.listener(
                                                        move |this, _, _, cx| {
                                                            if let Some(cue) =
                                                                current.and_then(|index| {
                                                                    this.segments.get(index)
                                                                })
                                                            {
                                                                this.play_cues(
                                                                    vec![cue.id.clone()],
                                                                    cx,
                                                                );
                                                            }
                                                        },
                                                    )),
                                            )
                                            .child(
                                                column()
                                                    .gap_0()
                                                    .items_center()
                                                    .child(muted(
                                                        frame
                                                            .next
                                                            .and_then(|index| {
                                                                self.segments.get(index)
                                                            })
                                                            .map(|cue| timestamp(cue.start_ms))
                                                            .unwrap_or_else(|| "—".into()),
                                                    ))
                                                    .child(
                                                        compact_button("next-cue")
                                                            .ghost()
                                                            .icon(IconName::ChevronRight)
                                                            .label(t("次の字幕", "Next"))
                                                            .disabled(
                                                                playback_disabled
                                                                    || frame.next.is_none(),
                                                            )
                                                            .on_click(cx.listener(
                                                                move |this, _, _, cx| {
                                                                    if let Some(cue) = frame
                                                                        .next
                                                                        .and_then(|index| {
                                                                            this.segments.get(index)
                                                                        })
                                                                    {
                                                                        this.play_cues(
                                                                            vec![cue.id.clone()],
                                                                            cx,
                                                                        );
                                                                    }
                                                                },
                                                            )),
                                                    ),
                                            ),
                                    ),
                            ),
                    ),
            )
            .when(subtitle_panel, |body| body.child(companion));
        column().key_context("SurtitleStudy").track_focus(&self.focus)
            .on_key_down(
                cx.listener(|this, event: &gpui_kit::KeyDownEvent, window, cx| {
                    // Fullscreen belongs to the Study window, including when a
                    // transport control holds focus. Keep editor/IME Escape
                    // and the rate popover's first dismissal with their owners.
                    if event.keystroke.key == "escape"
                        && event.keystroke.modifiers == Default::default()
                        && !event.prefer_character_input
                        && window.is_fullscreen()
                        && !this.rate_open
                        && !this.search.read(cx).focus_handle(cx).is_focused(window)
                    {
                        this.control("fullscreen", Some(0.), cx);
                        cx.stop_propagation();
                        return;
                    }
                    if !super::keyboard::page_shortcut(event, &[&this.focus], window) {
                        return;
                    }
                    let position = this.session.read(cx).player.position_ms;
                    match event.keystroke.key.as_str() {
                        "space" => {
                            if !event.is_held {
                                this.control("toggle-pause", None, cx);
                            }
                        }
                        "left" => {
                            this.control("seek", Some(position.saturating_sub(5000) as f64), cx)
                        }
                        "right" => {
                            this.control("seek", Some(position.saturating_add(5000) as f64), cx)
                        }
                        _ => return,
                    }
                    cx.stop_propagation();
                }),
            )
            .size_full().px_6().pt_3().pb_4().gap_4().bg(cx.theme().background)
            .when(self.rebind_request.is_some(),|body|body.child(row().p_3().flex_wrap()
                .child(div().flex_1().child(t("AI依頼の新しい出典を選んでください。モデル設定と入力は保持されています。","Select new source subtitles for the saved AI request.")))
                .child(button("confirm-ai-source").primary().label(t("選択した字幕を使う","Use selected subtitles")).disabled(self.selected.is_empty()||self.sources.read(cx).frozen()).on_click(cx.listener(|this,_,_,cx|this.confirm_ai_source(cx))))
                .child(button("cancel-ai-rebind").label(t("選び直しを終了","Cancel reselection")).on_click(cx.listener(|this,_,_,cx|{this.rebind_request=None;cx.notify();})))))
            .child(row().h(px(48.)).flex_shrink_0().gap_4()
                .child(icon_button("study-back",IconName::ArrowLeft,t("ライブラリへ","Back to library"))
                    .on_click(cx.listener(|this,_,_,cx|this.session.update(cx,|session,cx|session.navigate(super::session::Route::Library,cx)))))
                .child(column().flex_1().min_w(px(0.)).gap_0()
                    .child(div().text_size(px(20.)).font_weight(gpui_kit::FontWeight::SEMIBOLD).truncate().child(title_text))
                    .child(div().id("player-metadata").test_support().role(gpui_kit::accesskit::Role::Label).accessibility_id("player-metadata")
                        .aria_value(format!("{} · {} × {}",timestamp(player.duration_ms),player.video_width,player.video_height))
                        .child(div().text_size(px(13.)).text_color(cx.theme().muted_foreground).child(format!("{} / {}",language_name(self.session.read(cx).snapshot.as_ref().and_then(|s|s.media.iter().find(|m|m.id==self.media_id)).map(|m|m.learning_language.as_str()).unwrap_or("en"),japanese),timestamp(player.duration_ms))))))
                .child(button("toggle-transcript").icon(IconName::Captions).label(t("字幕一覧","Transcript"))
                    .bg(if subtitle_panel&&self.companion_tab==CompanionTab::Transcript{cx.theme().accent}else{cx.theme().popover})
                    .on_click(cx.listener(|this,_,_,cx|{this.companion_open = !(this.companion_open&&this.companion_tab==CompanionTab::Transcript);this.companion_tab=CompanionTab::Transcript;cx.notify();})))
                .child(button("study-tools").label(t("処理・管理","Activity & tools")).icon(IconName::ChevronDown)
                    .on_click(cx.listener(|this,_,_,cx|{this.companion_open = !(this.companion_open&&this.companion_tab==CompanionTab::Tools);this.companion_tab=CompanionTab::Tools;cx.notify();}))))
            .child(content)
            .when_some(self.load_error.clone(),|body,error|body.child(row().p_3().flex_wrap().child(div().flex_1().child(error)).child(button("retry-media-load").label(t("読み込みを再試行","Retry loading")).disabled(self.sources.read(cx).frozen()).on_click(cx.listener(|this,_,_,cx|this.load_media(cx))))))
            .when_some(self.error.clone().or(player.error),|body,error|body.child(div().p_3().bg(cx.theme().button_danger).text_color(cx.theme().button_danger_foreground).child(error)))
    }
}
