use crate::application::AppState;
use surtitle_core::workspace::{ArchiveUiDraft, SaveUiDraft, UiDraft};

pub fn list_ui_drafts(state: &AppState) -> Result<Vec<UiDraft>, String> {
    crate::application::ui_drafts::list_ui_drafts(state.clone())
}

pub fn archive_ui_draft(state: &AppState, request: ArchiveUiDraft) -> Result<UiDraft, String> {
    crate::application::ui_drafts::archive_ui_draft(state.clone(), request)
}

pub fn get_ui_draft(
    state: &AppState,
    kind: String,
    entity_id: String,
) -> Result<Option<UiDraft>, String> {
    crate::application::ui_drafts::get_ui_draft(state.clone(), kind, entity_id)
}
pub fn save_ui_draft(state: &AppState, request: SaveUiDraft) -> Result<UiDraft, String> {
    crate::application::ui_drafts::save_ui_draft(state.clone(), request)
}
pub fn delete_ui_draft(
    state: &AppState,
    kind: String,
    entity_id: String,
    expected_revision: u64,
) -> Result<(), String> {
    crate::application::ui_drafts::delete_ui_draft(
        state.clone(),
        kind,
        entity_id,
        expected_revision,
    )
}
