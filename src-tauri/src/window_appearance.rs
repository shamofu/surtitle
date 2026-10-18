//! Apply the saved theme before showing the window, including its WebView background.
use tauri::{Theme, WebviewWindow, WindowEvent, window::Color};

fn preference(value: &str) -> Option<Theme> {
    match value {
        "light" => Some(Theme::Light),
        "dark" => Some(Theme::Dark),
        _ => None,
    }
}

fn background(theme: Theme) -> Color {
    // Windows keeps the host window opaque but lets the WebView composite over
    // its video sibling. CSS paints the theme everywhere except the viewport.
    let alpha = if cfg!(target_os = "windows") { 0 } else { 255 };
    match theme {
        Theme::Light => Color(244, 246, 250, alpha),
        _ => Color(24, 29, 38, alpha),
    }
}

pub fn install(window: &WebviewWindow, saved_theme: &str) -> tauri::Result<()> {
    window.set_theme(preference(saved_theme))?;
    window.set_background_color(Some(background(window.theme()?)))?;
    let target = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::ThemeChanged(theme) = event {
            let color = background(*theme);
            let target = target.clone();
            let dispatcher = target.clone();
            let _ = dispatcher.run_on_main_thread(move || {
                if let Err(error) = target.set_background_color(Some(color)) {
                    eprintln!("Could not update window background: {error}");
                }
            });
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_theme_does_not_force_a_native_override() {
        assert_eq!(preference("system"), None);
        assert_eq!(preference("light"), Some(Theme::Light));
        assert_eq!(preference("dark"), Some(Theme::Dark));
    }
}
