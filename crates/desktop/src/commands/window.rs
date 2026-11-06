//! Device-local window actions, separate from synchronized learning settings.
pub async fn set_window_size_preset(
    host: crate::runtime::DesktopHost,
    preset: String,
) -> Result<(), String> {
    crate::application::on_main(host.clone(), move || host.set_window_size_preset(&preset))
        .await
        .map_err(|error| error.to_string())
}
