// SPDX-License-Identifier: GPL-3.0-or-later
pub(crate) use super::motion_controls::Button;
use gpui_kit::assets::IconName;
use gpui_kit::component::{ActiveTheme, Theme, ThemeConfig, ThemeMode};
use gpui_kit::component::{Icon, button::ButtonVariants};
use gpui_kit::{
    App, Context, Div, ElementId, FontFallbacks, FontWeight, Global, IntoElement, ParentElement,
    Refineable, Render, SharedString, Stateful, StyleRefinement, Styled, Window, div, font, px,
    relative,
};
use std::rc::Rc;

// Native authority for the original application palette and typography. Theme
// registration keeps light/dark/system switches on the same tokens, including
// the Base projection used by selectable text, inputs and scrollbars.
const UI_FONTS: &[&str] = &["Segoe UI Variable", "Segoe UI", "Yu Gothic UI", "Meiryo"];
const MONO_FONTS: &[&str] = &["Cascadia Code", "Consolas"];

struct Palette {
    background: &'static str,
    surface: &'static str,
    raised: &'static str,
    hover: &'static str,
    border: &'static str,
    text: &'static str,
    muted: &'static str,
    faint: &'static str,
    accent: &'static str,
    accent_text: &'static str,
    accent_soft: &'static str,
    warning: &'static str,
    warning_soft: &'static str,
    danger: &'static str,
    danger_soft: &'static str,
}

const DARK: Palette = Palette {
    background: "#181d26",
    surface: "#222b37",
    raised: "#2c3747",
    hover: "#344258",
    border: "#405064",
    text: "#edf2f7",
    muted: "#b1bdcd",
    faint: "#a5b3c6",
    accent: "#91b4ff",
    accent_text: "#162a4e",
    accent_soft: "#293d60",
    warning: "#f1c584",
    warning_soft: "#4d4233",
    danger: "#ffb1ad",
    danger_soft: "#523b42",
};

const LIGHT: Palette = Palette {
    background: "#f4f6fa",
    surface: "#ffffff",
    raised: "#eaf0f8",
    hover: "#e0e9f5",
    border: "#ced7e3",
    text: "#1d293b",
    muted: "#52637a",
    faint: "#586a83",
    accent: "#315fbd",
    accent_text: "#ffffff",
    accent_soft: "#e7efff",
    warning: "#8a5a16",
    warning_soft: "#fcf0d9",
    danger: "#b14343",
    danger_soft: "#fbe8e8",
};

fn theme_config(mode: ThemeMode, sans: &SharedString, mono: &SharedString) -> Rc<ThemeConfig> {
    let palette = if mode.is_dark() { &DARK } else { &LIGHT };
    let mut config = ThemeConfig::default();
    config.name = if mode.is_dark() {
        "Surtitle Dark"
    } else {
        "Surtitle Light"
    }
    .into();
    config.mode = mode;
    config.font_family = Some(sans.clone());
    config.mono_font_family = Some(mono.clone());
    config.font_size = Some(15.);
    // The original code/keyboard face inherits the 15px body size.
    config.mono_font_size = Some(15.);
    let colors = &mut config.colors;
    macro_rules! set {
        ($color:expr; $($field:ident),+ $(,)?) => {
            $(colors.$field = Some($color.into());)+
        };
    }
    set!(palette.background; background, sidebar, title_bar, status_bar, scrollbar, tab_bar);
    set!(palette.surface; button, accordion, popover, group_box, list, list_even, table, table_even, tab_active);
    set!(palette.raised; secondary, muted, list_head, table_head, table_foot,
        description_list_label, tab, tab_bar_segmented);
    set!(palette.hover; button_hover, button_active, secondary_hover, secondary_active,
        list_hover, table_hover);
    set!(palette.border; border, input, sidebar_border, title_bar_border, status_bar_border,
        table_row_border, window_border, scrollbar_thumb);
    set!(palette.text; foreground, button_foreground, secondary_foreground, accent_foreground,
        sidebar_foreground, sidebar_accent_foreground, popover_foreground, group_box_foreground,
        tab_foreground, tab_active_foreground);
    set!(palette.muted; muted_foreground, table_head_foreground, table_foot_foreground,
        description_list_label_foreground);
    set!(palette.faint; scrollbar_thumb_hover);
    set!(palette.accent; primary, ring, caret, link, link_hover, link_active, sidebar_primary,
        list_active_border, table_active_border, progress_bar, slider_bar);
    set!(palette.accent_text; primary_foreground, sidebar_primary_foreground);
    set!(palette.accent_soft; accent, sidebar_accent, list_active, table_active, selection, drop_target);
    set!(palette.warning; warning, warning_hover, warning_active, button_warning_foreground);
    set!(palette.warning_soft; button_warning, button_warning_hover, button_warning_active);
    set!(palette.danger; danger, danger_hover, danger_active, button_danger_foreground);
    set!(palette.danger_soft; button_danger, button_danger_hover, button_danger_active);
    Rc::new(config)
}

struct InstalledStyle {
    fallbacks: FontFallbacks,
}
impl Global for InstalledStyle {}

/// Install once after Kit initialization, before creating the first window root.
/// Appearance and reduced-motion preferences remain owned by DesktopView.
pub(crate) fn init(cx: &mut App) {
    if cx.has_global::<InstalledStyle>() {
        return;
    }
    let installed = cx.text_system().all_font_names();
    let available = |preferred: &[&str]| {
        preferred
            .iter()
            .filter_map(|name| {
                installed
                    .iter()
                    .find(|actual| actual.eq_ignore_ascii_case(name))
                    .cloned()
            })
            .collect::<Vec<_>>()
    };
    let sans = available(UI_FONTS);
    let mono = available(MONO_FONTS);
    // Keep Kit's installed platform fallback on systems without Windows fonts;
    // passing a CSS comma-separated stack as a GPUI family would not work.
    let sans_family = sans
        .first()
        .map(|name| SharedString::from(name.clone()))
        .unwrap_or_else(|| cx.theme().font_family.clone());
    let mono_family = mono
        .first()
        .map(|name| SharedString::from(name.clone()))
        .unwrap_or_else(|| cx.theme().mono_font_family.clone());
    let light = theme_config(ThemeMode::Light, &sans_family, &mono_family);
    let dark = theme_config(ThemeMode::Dark, &sans_family, &mono_family);
    Theme::update(cx, |theme| {
        theme.light_theme = light;
        theme.dark_theme = dark;
        let current = if theme.mode.is_dark() {
            theme.dark_theme.clone()
        } else {
            theme.light_theme.clone()
        };
        theme.apply_config(&current);
        theme.motion.duration_fast = super::motion::CONTROL_HOVER;
        theme.motion.duration_normal = super::motion::PANEL;
        theme.motion.duration_slow = super::motion::DISCLOSE_ENTER;
        theme.motion.easing_enter = super::motion::entering_easing();
        theme.motion.easing_exit = super::motion::exiting_easing();
        theme.motion.easing_move = super::motion::resizing_easing();
        theme.motion.spring_control =
            gpui_kit::base::motion::Spring::new(super::motion::CONTROL_HOVER);
        theme.motion.spring_move = gpui_kit::base::motion::Spring::new(super::motion::SELECTION)
            .with_damping(0.85)
            .with_epsilon(0.1);
    });
    cx.set_global(InstalledStyle {
        fallbacks: FontFallbacks::from_fonts(sans),
    });
    gpui_kit::base::Root::register_plugin(cx, |_, cx| Typography {
        fallbacks: cx.global::<InstalledStyle>().fallbacks.clone(),
    });
}

struct Typography {
    fallbacks: FontFallbacks,
}
impl Render for Typography {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
    }
}
impl gpui_kit::base::RootPlugin for Typography {
    fn style(&self, surface: &mut Stateful<Div>, _: &mut Window, cx: &mut App) {
        let mut body = font(cx.theme().font_family.clone());
        body.fallbacks = Some(self.fallbacks.clone());
        surface.style().refine(
            &StyleRefinement::default()
                .font(body)
                .text_size(cx.theme().font_size)
                .line_height(relative(1.6)),
        );
    }
}

pub(crate) fn column() -> gpui_kit::Div {
    div().flex().flex_col().gap_3()
}
pub(crate) fn row() -> gpui_kit::Div {
    div().flex().items_center().gap_3()
}
pub(crate) fn title(text: impl Into<gpui_kit::SharedString>) -> gpui_kit::Div {
    div()
        .text_size(px(28.))
        .font_weight(FontWeight::SEMIBOLD)
        .line_height(relative(1.4))
        .child(text.into())
}
pub(crate) fn muted(text: impl Into<gpui_kit::SharedString>) -> gpui_kit::Div {
    div().text_size(px(13.)).opacity(0.75).child(text.into())
}

/// Reserve the widest localized state without changing a control's hit target.
/// The measuring labels never paint or enter the accessibility tree; callers
/// name their Button with the current action through `accessibility_label`.
pub(crate) fn state_label(current: impl Into<SharedString>, alternatives: &[&str]) -> Div {
    let current = current.into();
    div()
        .relative()
        .grid()
        .grid_cols_max_content(1)
        .whitespace_nowrap()
        .children(alternatives.iter().map(|text| {
            div()
                .col_start(1)
                .row_start(1)
                .invisible()
                .child((*text).to_owned())
        }))
        .child(
            div()
                .col_start(1)
                .row_start(1)
                .invisible()
                .child(current.clone()),
        )
        .child(
            div()
                .absolute()
                .inset_0()
                .flex()
                .items_center()
                .justify_center()
                .child(current),
        )
}

/// Keep routine status changes from resizing a form's footer. Unlike labels,
/// these alternatives wrap at the available width, including narrow windows.
pub(crate) fn state_message(current: impl Into<SharedString>, alternatives: &[&str]) -> Div {
    let current = current.into();
    div()
        .relative()
        .grid()
        .grid_cols(1)
        .w_full()
        .min_w_0()
        .whitespace_normal()
        .children(alternatives.iter().map(|text| {
            div()
                .col_start(1)
                .row_start(1)
                .invisible()
                .child((*text).to_owned())
        }))
        .child(
            div()
                .col_start(1)
                .row_start(1)
                .invisible()
                .child(current.clone()),
        )
        .child(div().absolute().inset_0().child(current))
}

pub(crate) fn tabular_numbers() -> gpui_kit::FontFeatures {
    gpui_kit::FontFeatures(std::sync::Arc::new(vec![("tnum".into(), 1)]))
}

pub(crate) fn language_name(code: &str, ja: bool) -> String {
    match (code, ja) {
        ("en", true) => "英語",
        ("en", false) => "English",
        ("ja", true) => "日本語",
        ("ja", false) => "Japanese",
        ("es", true) => "スペイン語",
        ("es", false) => "Spanish",
        ("fr", true) => "フランス語",
        ("fr", false) => "French",
        ("de", true) => "ドイツ語",
        ("de", false) => "German",
        ("ko", true) => "韓国語",
        ("ko", false) => "Korean",
        ("zh", true) => "中国語",
        ("zh", false) => "Chinese",
        _ => code,
    }
    .into()
}

pub(crate) fn brand() -> impl IntoElement {
    static IMAGE: std::sync::OnceLock<std::sync::Arc<gpui_kit::Image>> = std::sync::OnceLock::new();
    let image = IMAGE.get_or_init(|| {
        std::sync::Arc::new(gpui_kit::Image::from_bytes(
            gpui_kit::ImageFormat::Svg,
            include_bytes!("../../../../public/surtitle.svg").to_vec(),
        ))
    });
    gpui_kit::img(image.clone()).size(px(28.))
}

/// The original interface distinguishes ordinary actions from quiet utility
/// controls. Keep Kit's focus/disabled/accessibility behavior on both.
pub(crate) fn button(id: impl Into<ElementId>) -> Button {
    Button::new(id)
        .h(px(40.))
        .px(px(16.))
        .rounded(px(8.))
        .text_size(px(14.))
}

pub(crate) fn compact_button(id: impl Into<ElementId>) -> Button {
    Button::new(id)
        .h(px(36.))
        .px(px(12.))
        .rounded(px(6.))
        .text_size(px(13.))
}

pub(crate) fn icon_button(
    id: impl Into<ElementId>,
    icon: IconName,
    label: impl Into<SharedString>,
) -> Button {
    let label = label.into();
    button(id)
        .ghost()
        .w(px(40.))
        .p_0()
        .rounded(px(6.))
        .icon(Icon::new(icon).size(px(18.)))
        .accessibility_label(label.clone())
        .tooltip(label)
}
/// Read Windows' current animation preference, including switching back from an
/// explicit app override. GPUI's base helper intentionally retains overrides.
pub fn system_reduced_motion() -> Option<bool> {
    #[cfg(all(windows, not(test)))]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            SPI_GETCLIENTAREAANIMATION, SystemParametersInfoW,
        };
        let mut enabled = 0i32;
        let success = unsafe {
            SystemParametersInfoW(
                SPI_GETCLIENTAREAANIMATION,
                0,
                (&mut enabled as *mut i32).cast(),
                0,
            )
        };
        (success != 0).then_some(enabled == 0)
    }
    #[cfg(any(not(windows), test))]
    {
        // Fake-platform tests control App's preference directly. Reading the
        // real desktop here would overwrite it whenever a snapshot arrives.
        None
    }
}
