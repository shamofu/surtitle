//! Tauri IPC adapters; application services own all business logic.
use crate::application::AppState;
use tauri::State;

#[tauri::command]
pub async fn check_tool_updates(state: State<'_, AppState>) -> std::result::Result<(), String> {
    crate::application::tool_updates::check_tool_updates(state.inner().clone()).await
}
