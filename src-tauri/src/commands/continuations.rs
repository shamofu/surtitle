use crate::application::{AppState, continuations::AiContinuation};
use tauri::State;
#[tauri::command]
pub fn save_ai_continuation(
    state: State<'_, AppState>,
    continuation: AiContinuation,
) -> Result<AiContinuation, String> {
    crate::application::continuations::save(state.inner().clone(), continuation)
}
#[tauri::command]
pub fn list_ai_continuations(state: State<'_, AppState>) -> Result<Vec<AiContinuation>, String> {
    crate::application::continuations::list(state.inner().clone())
}
#[tauri::command]
pub fn discard_ai_continuation(state: State<'_, AppState>, id: String) -> Result<(), String> {
    crate::application::continuations::discard(state.inner().clone(), id)
}
