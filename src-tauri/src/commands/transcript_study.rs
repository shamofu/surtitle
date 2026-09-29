//! Tauri IPC adapters; application services own all business logic.
use crate::application::AppState;
use crate::application::transcript::study::ExportSelection;
use crate::application::transcript::study::PrepareSelection;
use crate::application::transcript::study::SelectionCard;
use crate::application::transcript::study::SelectionQuote;
use crate::application::transcript::study::SelectionVersion;
use crate::application::transcript::study::SelectionView;
use crate::application::transcript::study::UpdateSelection;
use serde_json::Value;
use tauri::State;

#[tauri::command]
pub async fn prepare_draft_selection(
    state: State<'_, AppState>,
    request: PrepareSelection,
) -> std::result::Result<SelectionView, String> {
    crate::application::transcript::study::prepare_draft_selection(state.inner().clone(), request)
        .await
}

#[tauri::command]
pub async fn list_draft_selections(
    state: State<'_, AppState>,
    media_id: String,
) -> std::result::Result<Vec<SelectionView>, String> {
    crate::application::transcript::study::list_draft_selections(state.inner().clone(), media_id)
        .await
}

#[tauri::command]
pub async fn update_draft_selection(
    state: State<'_, AppState>,
    request: UpdateSelection,
) -> std::result::Result<SelectionView, String> {
    crate::application::transcript::study::update_draft_selection(state.inner().clone(), request)
        .await
}

#[tauri::command]
pub fn remove_draft_selection(
    state: State<'_, AppState>,
    request: SelectionVersion,
) -> std::result::Result<(), String> {
    crate::application::transcript::study::remove_draft_selection(state.inner().clone(), request)
}

#[tauri::command]
pub async fn save_draft_selection_card(
    state: State<'_, AppState>,
    request: SelectionCard,
) -> std::result::Result<(), String> {
    crate::application::transcript::study::save_draft_selection_card(state.inner().clone(), request)
        .await
}

#[tauri::command]
pub async fn create_draft_selection_quote(
    state: State<'_, AppState>,
    request: SelectionQuote,
) -> std::result::Result<crate::application::ai::AiQuote, String> {
    crate::application::transcript::study::create_draft_selection_quote(
        state.inner().clone(),
        request,
    )
    .await
}

#[tauri::command]
pub async fn list_draft_selection_candidates(
    state: State<'_, AppState>,
    request: SelectionVersion,
) -> std::result::Result<Vec<Value>, String> {
    crate::application::transcript::study::list_draft_selection_candidates(
        state.inner().clone(),
        request,
    )
    .await
}

#[tauri::command]
pub async fn export_draft_selection(
    state: State<'_, AppState>,
    request: ExportSelection,
) -> std::result::Result<(), String> {
    crate::application::transcript::study::export_draft_selection(state.inner().clone(), request)
        .await
}
