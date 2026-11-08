// SPDX-License-Identifier: GPL-3.0-or-later
//! Native settings and tool-management forms.
use super::{
    editors::{EditorKey, EditorRegistry},
    session::{self, Route, Session, UiEvent},
    style::*,
};
use crate::{
    application::{
        changes::ChangeDomain, operations::OperationProgress, tool_runtime::ExternalCandidate,
    },
    commands,
    controller::editing::{EditFields, EditorView},
};
use gpui_kit::assets::IconName;
use gpui_kit::base::TestSupportExt;
use gpui_kit::component::{
    ActiveTheme, Disableable, Icon, Selectable,
    button::ButtonVariants,
    input::{Input, InputEditsEvent, InputEvent, InputState},
    menu::{DropdownMenu, PopupMenuItem},
};
use gpui_kit::{
    AnyElement, AppContext, Context, Entity, Subscription, Window, div, prelude::*, px,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    future::Future,
    sync::atomic::Ordering,
};
mod forms;
mod models;
mod render;
mod tools;

struct InputBinding {
    state: Entity<InputState>,
    delivered: String,
}

pub(crate) struct SettingsView {
    session: Entity<Session>,
    editors: Entity<EditorRegistry>,
    key: Option<EditorKey>,
    category: &'static str,
    inputs: BTreeMap<String, InputBinding>,
    monthly_anchor: BTreeMap<String, f64>,
    budget_provider: Option<String>,
    retention_details: bool,
    model_purpose: &'static str,
    pending: BTreeSet<String>,
    error: Option<String>,
    notice: Option<String>,
    catalogue: Vec<surtitle_ai::DiscoveredModel>,
    catalogue_identity: String,
    model_notices: BTreeMap<String, String>,
    candidates: Vec<ExternalCandidate>,
    choose_external: BTreeSet<String>,
    operations: Vec<OperationProgress>,
    operations_dirty: bool,
    generation: u64,
    subscriptions: Vec<Subscription>,
}

impl SettingsView {
    pub fn new(
        session: Entity<Session>,
        editors: Entity<EditorRegistry>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let key = editors
            .update(cx, |registry, cx| {
                registry.ensure("settings", "default", cx)
            })
            .ok();
        let generation = session.read(cx).backend.generation.load(Ordering::Acquire);
        let observed = cx.observe(&editors, |this, _, cx| {
            this.ensure_editor(cx);
            cx.notify();
        });
        let snapshots = cx.subscribe(&session, |this, _, event: &UiEvent, cx| {
            if matches!(event, UiEvent::Snapshot) {
                this.ensure_editor(cx);
                cx.notify();
            }
            if matches!(event,UiEvent::Changed(change) if change.domain==ChangeDomain::Operations) {
                this.load_operations(cx);
            }
        });
        let mut this = Self {
            session,
            editors,
            key,
            category: "learning",
            inputs: BTreeMap::new(),
            monthly_anchor: BTreeMap::new(),
            budget_provider: None,
            retention_details: false,
            model_purpose: "transcription",
            pending: BTreeSet::new(),
            error: None,
            notice: None,
            catalogue: vec![],
            catalogue_identity: String::new(),
            model_notices: BTreeMap::new(),
            candidates: vec![],
            choose_external: BTreeSet::new(),
            operations: vec![],
            operations_dirty: false,
            generation,
            subscriptions: vec![observed, snapshots],
        };
        this.ensure_input("apiKey", "", true, window, cx);
        this.scan_tools(false, cx);
        this.load_operations(cx);
        this
    }
    fn ensure_editor(&mut self, cx: &mut Context<Self>) {
        let generation = self
            .session
            .read(cx)
            .backend
            .generation
            .load(Ordering::Acquire);
        if generation != self.generation {
            self.generation = generation;
            self.pending.clear();
            self.model_notices.clear();
            self.catalogue.clear();
            self.monthly_anchor.clear();
        }
        if self
            .key
            .as_ref()
            .is_none_or(|key| self.editors.read(cx).view(key).is_none())
            && !self.editors.read(cx).frozen()
        {
            self.key = self
                .editors
                .update(cx, |registry, cx| {
                    registry.ensure("settings", "default", cx)
                })
                .ok();
        }
    }
    fn editing(&self, cx: &Context<Self>) -> EditorView {
        self.key
            .as_ref()
            .and_then(|key| self.editors.read(cx).view(key))
            .cloned()
            .unwrap_or_default()
    }
    fn frozen(&self, cx: &Context<Self>) -> bool {
        self.editors.read(cx).frozen() || !self.editing(cx).ready
    }
    fn t(&self, ja: &str, en: &str, cx: &Context<Self>) -> String {
        self.session.read(cx).text(ja, en).into()
    }
    fn fields(&self, cx: &Context<Self>) -> EditFields {
        self.editing(cx).fields
    }
    fn change(&mut self, fields: EditFields, cx: &mut Context<Self>) {
        if self.frozen(cx) {
            return;
        }
        if let Some(key) = &self.key {
            self.editors.update(cx, |registry, cx| {
                registry.change(key, fields, cx);
            });
        }
    }
    fn change_one(&mut self, key: &str, value: &str, cx: &mut Context<Self>) {
        self.change(EditFields::from([(key.into(), value.into())]), cx);
    }
    pub fn set_locale(&mut self, locale: &str, _: &mut Window, cx: &mut Context<Self>) {
        if ["ja", "en"].contains(&locale) {
            self.change_one("locale", locale, cx);
            self.blur(cx);
        }
    }
    pub fn toggle_theme(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        let dark = match self.fields(cx).get("theme").map(String::as_str) {
            Some("dark") => true,
            Some("light") => false,
            _ => cx.theme().mode.is_dark(),
        };
        self.change_one("theme", if dark { "light" } else { "dark" }, cx);
        self.blur(cx);
    }
    fn blur(&mut self, cx: &mut Context<Self>) {
        if let Some(key) = &self.key {
            self.editors.update(cx, |registry, cx| {
                registry.blur(key, cx);
            });
        }
    }
    fn ensure_input(
        &mut self,
        name: &str,
        value: &str,
        secret: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<InputState> {
        if let Some(binding) = self.inputs.get_mut(name) {
            let current = binding.state.read(cx).value().to_string();
            // Immutable edit events can still be queued. Never replace text ahead
            // of the last delivered edit with an older service completion.
            if current == binding.delivered && current != value {
                binding.state.update(cx, |state, cx| {
                    state.set_value(value.to_owned(), window, cx)
                });
                binding.delivered = value.into();
            }
            return binding.state.clone();
        }
        let state = cx.new(|cx| {
            let mut input = InputState::new(window, cx).masked(secret);
            input.set_value(value.to_owned(), window, cx);
            input
        });
        let field = name.to_owned();
        self.subscriptions.push(cx.subscribe(
            &state,
            move |this, _, event: &InputEditsEvent, cx| {
                if let Some((_, text)) = event.edits().last() {
                    let raw = text.to_string();
                    if let Some(binding) = this.inputs.get_mut(&field) {
                        binding.delivered = raw.clone();
                    }
                    this.input_changed(&field, &raw, cx);
                }
            },
        ));
        self.subscriptions
            .push(cx.subscribe(&state, |this, _, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Blur | InputEvent::PressEnter { .. }) {
                    this.blur(cx);
                }
            }));
        self.inputs.insert(
            name.into(),
            InputBinding {
                state: state.clone(),
                delivered: value.into(),
            },
        );
        state
    }
    fn input_changed(&mut self, name: &str, raw: &str, cx: &mut Context<Self>) {
        if name == "apiKey" || name.starts_with("toolPath:") {
            cx.notify();
            return;
        }
        if self.frozen(cx) {
            return;
        }
        let fields = self.fields(cx);
        let patch = if name == "retentionInput" {
            forms::retention_patch(raw)
        } else if name == "vertexLocation" {
            match forms::location_patch(&fields, raw) {
                Ok(patch) => patch,
                Err(error) => {
                    self.error = Some(error);
                    cx.notify();
                    return;
                }
            }
        } else if let Some(rest) = name.strip_prefix("model:") {
            let parts: Vec<_> = rest.split(':').collect();
            if parts.len() != 3 {
                return;
            }
            match forms::model_patch(&fields, parts[0], parts[1], parts[2], raw) {
                Ok(patch) => patch,
                Err(error) => {
                    self.error = Some(error);
                    cx.notify();
                    return;
                }
            }
        } else if let Some((provider, key)) = forms::budget_identity(name) {
            let fallback = self
                .session
                .read(cx)
                .snapshot
                .as_ref()
                .map(|snapshot| {
                    if provider == "openai" {
                        snapshot.settings.openai.monthly_budget_usd
                    } else {
                        snapshot
                            .settings
                            .monthly_budget_usd
                            .unwrap_or(snapshot.settings.daily_budget_usd)
                    }
                })
                .unwrap_or(0.);
            let anchor = *self
                .monthly_anchor
                .entry(provider.into())
                .or_insert(fallback);
            let patch = forms::budget_patch(&fields, provider, key, raw, anchor);
            if key == "monthlyBudgetUsd"
                && let Some(value) = forms::number(raw)
            {
                self.monthly_anchor.insert(provider.into(), value);
            }
            patch
        } else {
            EditFields::from([(name.into(), raw.into())])
        };
        self.change(patch, cx);
    }
    fn input(
        &mut self,
        name: &str,
        label: (String, Option<String>),
        value: String,
        disabled: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let (label, hint) = label;
        let state = self.ensure_input(name, &value, name == "apiKey", window, cx);
        let owner = cx.entity().downgrade();
        let language_key = name.to_owned();
        let picker_label = self.t("言語を選ぶ", "Choose a language", cx);
        column()
            .gap_1()
            .min_w(px(0.))
            .child(
                div()
                    .text_size(px(14.))
                    .font_weight(gpui_kit::FontWeight::MEDIUM)
                    .child(label.clone()),
            )
            .child(
                Input::new(&state)
                    .id(gpui_kit::SharedString::from(format!("settings-{name}")))
                    .accessibility_id(format!("settings-{name}"))
                    .aria_label(label)
                    .disabled(disabled)
                    .h(px(42.))
                    .when(
                        matches!(name, "learningLanguage" | "explanationLanguage"),
                        |input| {
                            input.suffix(
                                compact_button(gpui_kit::SharedString::from(format!(
                                    "language-options-{language_key}"
                                )))
                                .ghost()
                                .icon(IconName::ChevronDown)
                                .accessibility_label(picker_label)
                                .disabled(disabled)
                                .w(px(30.))
                                .p_0()
                                .dropdown_menu(
                                    move |mut menu, _, _| {
                                        for (code, label) in [
                                            ("en", "English"),
                                            ("ja", "日本語"),
                                            ("es", "Español"),
                                            ("fr", "Français"),
                                            ("de", "Deutsch"),
                                            ("ko", "한국어"),
                                            ("zh", "中文"),
                                        ] {
                                            let owner = owner.clone();
                                            let key = language_key.clone();
                                            menu = menu.item(PopupMenuItem::new(label).on_click(
                                                move |_, _, cx| {
                                                    let _ = owner.update(cx, |this, cx| {
                                                        this.input_changed(&key, code, cx)
                                                    });
                                                },
                                            ));
                                        }
                                        menu
                                    },
                                ),
                            )
                        },
                    )
                    .w_full(),
            )
            .when_some(hint, |view, hint| view.child(muted(hint)))
            .into_any_element()
    }
    fn raw_input(
        &mut self,
        name: &str,
        label: String,
        hint: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let value = self.fields(cx).get(name).cloned().unwrap_or_default();
        let disabled = self.frozen(cx);
        let error = self
            .editing(cx)
            .ready
            .then(|| forms::field_error(name, &value))
            .flatten()
            .map(|(ja, en)| self.t(ja, en, cx));
        let error_space = forms::field_error(name, "").map(|(ja, en)| self.t(ja, en, cx));
        column()
            .gap_1()
            .child(self.input(name, (label, hint), value, disabled, window, cx))
            .when_some(error_space, |view, error_space| {
                view.child(
                    state_message(error.unwrap_or_default(), &[error_space.as_str()])
                        .text_size(px(13.))
                        .text_color(cx.theme().danger),
                )
            })
            .into_any_element()
    }
    fn choices(
        &self,
        name: &str,
        label: String,
        choices: Vec<(&'static str, String)>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let current = self.fields(cx).get(name).cloned().unwrap_or_default();
        let disabled = self.frozen(cx)
            || (name == "activeProvider"
                && (self.pending.contains("credential") || self.editing(cx).saving));
        let selected = choices
            .iter()
            .find(|(value, _)| *value == current)
            .map_or_else(|| current.clone(), |(_, label)| label.clone());
        let key = name.to_owned();
        let owner = cx.entity().downgrade();
        let menu = button(gpui_kit::SharedString::from(format!("setting-{name}")))
            .label(selected)
            .icon(IconName::ChevronDown)
            .accessibility_id(format!("setting-{name}"))
            .accessibility_label(label.clone())
            .w_full()
            .justify_between()
            .disabled(disabled)
            .dropdown_menu(move |mut menu, _, _| {
                for (value, label) in &choices {
                    let owner = owner.clone();
                    let key = key.clone();
                    let value = *value;
                    menu = menu.item(
                        PopupMenuItem::new(label.clone())
                            .checked(value == current)
                            .on_click(move |_, window, cx| {
                                let _ = owner.update(cx, |this, cx| {
                                    if this
                                        .fields(cx)
                                        .get(&key)
                                        .is_some_and(|current| current == value)
                                    {
                                        return;
                                    }
                                    if key == "activeProvider"
                                        && let Some(binding) = this.inputs.get_mut("apiKey")
                                    {
                                        binding.state.update(cx, |input, cx| {
                                            input.set_value("", window, cx)
                                        });
                                        binding.delivered.clear();
                                    }
                                    if key == "retentionInput" && value == "custom" {
                                        this.retention_details = true;
                                        cx.notify();
                                    } else {
                                        this.input_changed(&key, value, cx);
                                    }
                                });
                            }),
                    );
                }
                menu
            });
        column()
            .gap_2()
            .min_w(px(0.))
            .when(!label.is_empty(), |body| {
                body.child(
                    div()
                        .text_size(px(14.))
                        .font_weight(gpui_kit::FontWeight::MEDIUM)
                        .child(label),
                )
            })
            .child(menu)
            .into_any_element()
    }
    fn action(
        &mut self,
        name: &str,
        success: String,
        future: impl Future<Output = Result<(), String>> + Send + 'static,
        cx: &mut Context<Self>,
    ) {
        if self.frozen(cx) || self.pending.contains(name) {
            return;
        }
        self.pending.insert(name.into());
        self.error = None;
        self.notice = None;
        let name = name.to_owned();
        let backend = self.session.read(cx).backend.clone();
        session::run(&backend, cx, future, move |this, result, cx| {
            this.pending.remove(&name);
            match result {
                Ok(()) => this.notice = Some(success),
                Err(error) => this.error = Some(error),
            }
            this.session.update(cx, |session, cx| session.refresh(cx));
            if let Some(key) = &this.key {
                this.editors.update(cx, |registry, cx| {
                    registry.refresh(key, cx);
                });
            }
        });
    }
    fn load_operations(&mut self, cx: &mut Context<Self>) {
        if self.pending.contains("operation-read") {
            self.operations_dirty = true;
            return;
        }
        self.operations_dirty = false;
        self.pending.insert("operation-read".into());
        let backend = self.session.read(cx).backend.clone();
        let state = backend.state.clone();
        session::run(
            &backend,
            cx,
            async move { commands::media_tools::list_operation_progress(&state) },
            |this, result, cx| {
                this.pending.remove("operation-read");
                if let Ok(operations) = result {
                    this.operations = operations;
                }
                if this.operations_dirty {
                    this.load_operations(cx);
                }
            },
        );
    }
}
