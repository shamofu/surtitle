use crate::application::AppState;
use tauri::State;
type IpcResult<T> = std::result::Result<T, String>;
use crate::application::transfer::RestorePreview;

#[tauri::command]
pub async fn export_learning(
    state: State<'_, AppState>,
    format: String,
    media_id: Option<String>,
) -> IpcResult<Vec<String>> {
    crate::application::transfer::export_learning(state.inner().clone(), format, media_id).await
}
#[tauri::command]
pub fn reveal_export_file(path: String) -> IpcResult<()> {
    crate::application::transfer::reveal_export_file(path)
}
#[tauri::command]
pub async fn preview_restore(state: State<'_, AppState>) -> IpcResult<Option<RestorePreview>> {
    crate::application::transfer::preview_restore(state.inner().clone()).await
}
#[tauri::command]
pub fn discard_restore_preview(state: State<'_, AppState>, token: String) -> IpcResult<()> {
    crate::application::transfer::discard_restore_preview(state.inner().clone(), token)
}
#[tauri::command]
pub async fn restore_learning(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    token: String,
) -> IpcResult<()> {
    crate::application::transfer::restore_learning(app, state.inner().clone(), token).await
}
