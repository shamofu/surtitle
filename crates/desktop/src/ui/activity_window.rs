// SPDX-License-Identifier: GPL-3.0-or-later
//! Presentation and focus lifetime for the retained Activity view.
use super::{ai::AiView, session::Session, style};
use gpui_kit::assets::IconName;
use gpui_kit::base::Disableable;
use gpui_kit::component::ActiveTheme;
use gpui_kit::{
    AnyWindowHandle, Context, Entity, FocusHandle, KeyDownEvent, Subscription, Window, div,
    prelude::*, px,
};

pub(super) struct ActivityStatus {
    pub running: usize,
    pub problem: Option<String>,
}

impl ActivityStatus {
    pub fn read(session: &Session) -> Self {
        let jobs = session.snapshot.as_ref().map(|snapshot| &snapshot.jobs);
        // Preparation/tool operations can belong to another local operation or
        // to a persisted AI job. Count the root once, as the original Activity
        // adapter did, rather than counting every child as separate work.
        let parents: std::collections::BTreeSet<_> = session
            .operations
            .iter()
            .map(|operation| operation.id.as_str())
            .chain(jobs.into_iter().flatten().map(|job| job.id.as_str()))
            .collect();
        let local = session
            .operations
            .iter()
            .filter(|operation| {
                operation.status == "running"
                    && operation
                        .parent_id
                        .as_deref()
                        .is_none_or(|id| !parents.contains(id))
            })
            .count();
        let ai = jobs
            .into_iter()
            .flatten()
            .filter(|job| job.status == "running")
            .count();
        Self {
            running: local + ai,
            problem: session.error.clone(),
        }
    }

    pub fn label(&self, session: &Session) -> String {
        let mut label = session.text("処理状況を開く", "Open activity").to_owned();
        if self.running > 0 {
            label.push_str(&if session.text("ja", "en") == "ja" {
                format!("。{} 件の処理を実行中。", self.running)
            } else {
                format!(". {} operations running.", self.running)
            });
        }
        if self.problem.is_some() {
            label.push_str(session.text(
                " 更新できませんでした。詳細と再試行を開きます。",
                " Could not refresh. Open details and retry.",
            ));
        }
        label
    }
}

pub(super) struct ActivityWindow {
    session: Entity<Session>,
    content: Entity<AiView>,
    focus: FocusHandle,
    close_focus: FocusHandle,
    restore_focus: bool,
    _subscription: Subscription,
}

impl ActivityWindow {
    pub fn new(
        session: Entity<Session>,
        content: Entity<AiView>,
        opener: AnyWindowHandle,
        previous_focus: Option<FocusHandle>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let close_focus = cx.focus_handle();
        close_focus.focus(window, cx);
        // The window owns this wrapper; DesktopView owns only a weak reference.
        // Release covers X/Alt-F4 as well as our Close/Escape actions. A route
        // link suppresses restoration so its destination keeps its own focus.
        cx.on_release(move |this, cx| {
            if this.restore_focus {
                cx.defer(move |cx| {
                    let _ = opener.update(cx, |_, window, cx| {
                        window.activate_window();
                        if let Some(focus) = previous_focus {
                            focus.focus(window, cx);
                        }
                    });
                });
            }
        })
        .detach();
        let mut presentation = (
            session.read(cx).text("ja", "en").to_owned(),
            session.read(cx).error.clone(),
        );
        let subscription = cx.observe(&session, move |_, session, cx| {
            let next = (
                session.read(cx).text("ja", "en").to_owned(),
                session.read(cx).error.clone(),
            );
            if presentation != next {
                presentation = next;
                cx.notify();
            }
        });
        Self {
            session,
            content,
            focus: cx.focus_handle(),
            close_focus,
            restore_focus: true,
            _subscription: subscription,
        }
    }

    pub fn navigating(&mut self) {
        self.restore_focus = false;
    }
}

impl Render for ActivityWindow {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let session = self.session.read(cx);
        style::column()
            .id("activity-window")
            .size_full()
            .min_h(px(0.))
            .gap_0()
            .bg(cx.theme().background)
            .text_color(cx.theme().foreground)
            .track_focus(&self.focus)
            .on_key_down(cx.listener(|_, event: &KeyDownEvent, window, cx| {
                if event.keystroke.key == "escape"
                    && !event.prefer_character_input
                    && event.keystroke.modifiers == Default::default()
                {
                    cx.stop_propagation();
                    window.remove_window();
                }
            }))
            .child(
                style::row()
                    .flex_shrink_0()
                    .justify_between()
                    .px_6()
                    .py_3()
                    .border_b_1()
                    .border_color(cx.theme().border)
                    .child(
                        div()
                            .text_size(px(24.))
                            .child(session.text("処理状況", "Activity")),
                    )
                    .child(
                        style::icon_button(
                            "close-activity",
                            IconName::X,
                            session.text("閉じる", "Close"),
                        )
                        .accessibility_id("activity-close")
                        .track_focus(&self.close_focus)
                        .on_click(|_, window, _| window.remove_window()),
                    ),
            )
            .when_some(session.error.clone(), |body, error| {
                body.child(
                    style::column()
                        .flex_shrink_0()
                        .px_6()
                        .py_3()
                        .gap_2()
                        .child(div().text_color(cx.theme().danger).child(session.text(
                            "データを更新できませんでした",
                            "Could not refresh your data",
                        )))
                        .child(style::muted(session.text(
                            "読み込み済みの内容で学習を続けられます。",
                            "You can keep learning with the content already loaded.",
                        )))
                        .child(div().text_color(cx.theme().danger).child(error))
                        .child(
                            style::compact_button("retry-activity-refresh")
                                .label(session.text("再試行", "Retry"))
                                .accessibility_id("activity-refresh-retry")
                                .disabled(
                                    session
                                        .backend
                                        .exclusive
                                        .load(std::sync::atomic::Ordering::Acquire),
                                )
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.session.update(cx, |session, cx| {
                                        if !session
                                            .backend
                                            .exclusive
                                            .load(std::sync::atomic::Ordering::Acquire)
                                        {
                                            session.refresh(cx);
                                        }
                                    });
                                })),
                        ),
                )
            })
            .child(div().flex_1().min_h(px(0.)).child(self.content.clone()))
    }
}
