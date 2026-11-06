use crate::application::{AppState, continuations::AiContinuation};
pub fn save_ai_continuation(
    state: &AppState,
    continuation: AiContinuation,
) -> Result<AiContinuation, String> {
    crate::application::continuations::save(state.clone(), continuation)
}
pub fn list_ai_continuations(state: &AppState) -> Result<Vec<AiContinuation>, String> {
    crate::application::continuations::list(state.clone())
}
pub fn discard_ai_continuation(state: &AppState, id: String) -> Result<(), String> {
    crate::application::continuations::discard(state.clone(), id)
}
