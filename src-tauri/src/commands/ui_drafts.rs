use crate::application::AppState;
use surtitle_core::workspace::{ArchiveUiDraft, SaveUiDraft, UiDraft};
use tauri::State;

#[tauri::command]
pub fn list_ui_drafts(state: State<'_, AppState>) -> Result<Vec<UiDraft>, String> {
    crate::application::ui_drafts::list_ui_drafts(state.inner().clone())
}

#[tauri::command]
pub fn archive_ui_draft(
    state: State<'_, AppState>,
    request: ArchiveUiDraft,
) -> Result<UiDraft, String> {
    crate::application::ui_drafts::archive_ui_draft(state.inner().clone(), request)
}

#[tauri::command]
pub fn get_ui_draft(
    state: State<'_, AppState>,
    kind: String,
    entity_id: String,
) -> Result<Option<UiDraft>, String> {
    crate::application::ui_drafts::get_ui_draft(state.inner().clone(), kind, entity_id)
}
#[tauri::command]
pub fn save_ui_draft(state: State<'_, AppState>, request: SaveUiDraft) -> Result<UiDraft, String> {
    crate::application::ui_drafts::save_ui_draft(state.inner().clone(), request)
}
#[tauri::command]
pub fn delete_ui_draft(
    state: State<'_, AppState>,
    kind: String,
    entity_id: String,
    expected_revision: u64,
) -> Result<(), String> {
    crate::application::ui_drafts::delete_ui_draft(
        state.inner().clone(),
        kind,
        entity_id,
        expected_revision,
    )
}
