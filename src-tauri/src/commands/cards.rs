use crate::application::AppState;
use tauri::State;
type IpcResult<T> = std::result::Result<T, String>;
use surtitle_core::SaveCard;

#[tauri::command]
pub async fn save_card(
    state: State<'_, AppState>,
    request: SaveCard,
    operation_id: Option<String>,
) -> IpcResult<()> {
    crate::application::cards::save_card(state.inner().clone(), request, operation_id).await
}
#[tauri::command]
pub fn rate_card(state: State<'_, AppState>, card_id: String, rating: String) -> IpcResult<()> {
    crate::application::cards::rate_card(state.inner().clone(), card_id, rating)
}
#[tauri::command]
pub fn edit_card(state: State<'_, AppState>, request: surtitle_core::EditCard) -> IpcResult<()> {
    crate::application::cards::edit_card(state.inner().clone(), request)
}
#[tauri::command]
pub fn suspend_card(state: State<'_, AppState>, card_id: String, suspended: bool) -> IpcResult<()> {
    crate::application::cards::suspend_card(state.inner().clone(), card_id, suspended)
}
#[tauri::command]
pub fn delete_card(state: State<'_, AppState>, card_id: String) -> IpcResult<()> {
    crate::application::cards::delete_card(state.inner().clone(), card_id)
}
