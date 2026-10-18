//! Device-local window actions, separate from synchronized learning settings.
#[tauri::command]
pub async fn set_window_size_preset(
    window: tauri::WebviewWindow,
    preset: String,
) -> Result<(), String> {
    crate::window_fit::apply_preset(window, &preset)
        .await
        .map_err(|error| error.to_string())
}
