//! Tauri IPC adapters; application services own all business logic.
use crate::application::AppState;
use tauri::State;

#[tauri::command]
pub async fn check_tool_updates(state: State<'_, AppState>) -> std::result::Result<(), String> {
    let committed_changes = state.changes.clone();
    let changed_tools = None;
    let result = crate::application::tool_updates::check_tool_updates(state.inner().clone()).await;
    if result.is_ok() {
        committed_changes.publish(
            crate::application::changes::ChangeDomain::Tools,
            changed_tools,
        );
    }
    result
}
