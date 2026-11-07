use crate::application::AppState;
type IpcResult<T> = std::result::Result<T, String>;
use crate::application::transfer::{RestorePreview, RestoreResult};

pub async fn export_learning(
    state: &AppState,
    format: String,
    media_id: Option<String>,
) -> IpcResult<Vec<String>> {
    crate::application::transfer::export_learning(state.clone(), format, media_id).await
}
pub fn reveal_export_file(path: String) -> IpcResult<()> {
    crate::application::transfer::reveal_export_file(path)
}
pub async fn preview_restore(state: &AppState) -> IpcResult<Option<RestorePreview>> {
    crate::application::transfer::preview_restore(state.clone()).await
}
pub fn discard_restore_preview(state: &AppState, token: String) -> IpcResult<()> {
    crate::application::transfer::discard_restore_preview(state.clone(), token)
}
pub async fn restore_learning(
    app: crate::runtime::DesktopHost,
    state: &AppState,
    token: String,
) -> IpcResult<RestoreResult> {
    crate::application::transfer::restore_learning(app, state.clone(), token).await
}
