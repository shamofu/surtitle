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
    let committed_changes = state.changes.clone();
    let changed_cards = None;
    let result =
        crate::application::cards::save_card(state.inner().clone(), request, operation_id).await;
    if result.is_ok() {
        committed_changes.publish(
            crate::application::changes::ChangeDomain::Cards,
            changed_cards,
        );
    }
    result
}
#[tauri::command]
pub fn rate_card(state: State<'_, AppState>, card_id: String, rating: String) -> IpcResult<()> {
    let committed_changes = state.changes.clone();
    let changed_cards = Some(card_id.clone());
    let result = crate::application::cards::rate_card(state.inner().clone(), card_id, rating);
    if result.is_ok() {
        committed_changes.publish(
            crate::application::changes::ChangeDomain::Cards,
            changed_cards,
        );
    }
    result
}
#[tauri::command]
pub fn edit_card(state: State<'_, AppState>, request: surtitle_core::EditCard) -> IpcResult<()> {
    let committed_changes = state.changes.clone();
    let changed_cards = None;
    let result = crate::application::cards::edit_card(state.inner().clone(), request);
    if result.is_ok() {
        committed_changes.publish(
            crate::application::changes::ChangeDomain::Cards,
            changed_cards,
        );
    }
    result
}
#[tauri::command]
pub fn get_card_edit_state(
    state: State<'_, AppState>,
    card_id: String,
) -> IpcResult<surtitle_core::store::CardEditState> {
    crate::application::cards::get_card_edit_state(state.inner().clone(), card_id)
}
#[tauri::command]
pub fn save_card_edit(
    state: State<'_, AppState>,
    request: surtitle_core::EditCard,
    expected_revision: String,
) -> IpcResult<surtitle_core::store::CardEditState> {
    let committed_changes = state.changes.clone();
    let changed_cards = None;
    let result = crate::application::cards::save_card_edit(
        state.inner().clone(),
        request,
        expected_revision,
    );
    if result.is_ok() {
        committed_changes.publish(
            crate::application::changes::ChangeDomain::Cards,
            changed_cards,
        );
    }
    result
}
#[tauri::command]
pub fn suspend_card(state: State<'_, AppState>, card_id: String, suspended: bool) -> IpcResult<()> {
    let committed_changes = state.changes.clone();
    let changed_cards = Some(card_id.clone());
    let result = crate::application::cards::suspend_card(state.inner().clone(), card_id, suspended);
    if result.is_ok() {
        committed_changes.publish(
            crate::application::changes::ChangeDomain::Cards,
            changed_cards,
        );
    }
    result
}
#[tauri::command]
pub fn delete_card(state: State<'_, AppState>, card_id: String) -> IpcResult<()> {
    let committed_changes = state.changes.clone();
    let changed_cards = Some(card_id.clone());
    let result = crate::application::cards::delete_card(state.inner().clone(), card_id);
    if result.is_ok() {
        committed_changes.publish(
            crate::application::changes::ChangeDomain::Cards,
            changed_cards,
        );
    }
    result
}
