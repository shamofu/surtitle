//! Tauri IPC adapters; application services own all business logic.
use crate::application::AppState;
use crate::application::ai::AiQuote;
use crate::application::ai::AppSnapshot;
use crate::application::ai::PreparationSummary;
use crate::application::ai::QuoteRequest;
use crate::application::ai::SavedAiResult;
use crate::application::ai::VocabularyCandidate;
use tauri::State;

#[tauri::command]
pub fn get_app_snapshot(state: State<'_, AppState>) -> std::result::Result<AppSnapshot, String> {
    crate::application::ai::snapshot::get_app_snapshot(state.inner().clone())
}

#[tauri::command]
pub async fn import_credential(state: State<'_, AppState>) -> std::result::Result<(), String> {
    crate::application::models::import_credential(state.inner().clone()).await
}

#[tauri::command]
pub async fn create_quote(
    state: State<'_, AppState>,
    request: QuoteRequest,
) -> std::result::Result<AiQuote, String> {
    crate::application::ai::quotes::create_quote(state.inner().clone(), request).await
}

#[tauri::command]
pub async fn approve_quote(
    state: State<'_, AppState>,
    quote_id: String,
    digest: String,
    acknowledge_unpriced: bool,
    acknowledge_unqualified: bool,
) -> std::result::Result<(), String> {
    crate::application::ai::jobs::approve_quote(
        state.inner().clone(),
        quote_id,
        digest,
        acknowledge_unpriced,
        acknowledge_unqualified,
    )
    .await
}

#[tauri::command]
pub fn list_saved_ai_results(
    state: State<'_, AppState>,
    job_id: String,
) -> std::result::Result<Vec<SavedAiResult>, String> {
    crate::application::ai::results::list_saved_ai_results(state.inner().clone(), job_id)
}

#[tauri::command]
pub fn apply_saved_ai_result(
    state: State<'_, AppState>,
    job_id: String,
    ordinal: u32,
) -> std::result::Result<(), String> {
    crate::application::ai::results::apply_saved_ai_result(state.inner().clone(), job_id, ordinal)
}

#[tauri::command]
pub fn create_retry_quote(
    state: State<'_, AppState>,
    job_id: String,
) -> std::result::Result<AiQuote, String> {
    crate::application::ai::quotes::create_retry_quote(state.inner().clone(), job_id)
}

#[tauri::command]
pub async fn reapprove_quote(
    state: State<'_, AppState>,
    quote_id: String,
    digest: String,
    acknowledge_unpriced: bool,
    acknowledge_unqualified: bool,
) -> std::result::Result<(), String> {
    crate::application::ai::jobs::reapprove_quote(
        state.inner().clone(),
        quote_id,
        digest,
        acknowledge_unpriced,
        acknowledge_unqualified,
    )
    .await
}

#[tauri::command]
pub fn pause_ai_job(state: State<'_, AppState>, job_id: String) -> std::result::Result<(), String> {
    crate::application::ai::jobs::pause_ai_job(state.inner().clone(), job_id)
}

#[tauri::command]
pub fn cancel_ai_job(
    state: State<'_, AppState>,
    job_id: String,
) -> std::result::Result<(), String> {
    crate::application::ai::jobs::cancel_ai_job(state.inner().clone(), job_id)
}

#[tauri::command]
pub fn resolve_unknown_attempt(
    state: State<'_, AppState>,
    attempt_id: String,
) -> std::result::Result<(), String> {
    crate::application::ai::jobs::resolve_unknown_attempt(state.inner().clone(), attempt_id)
}

#[tauri::command]
pub fn list_vocabulary_candidates(
    state: State<'_, AppState>,
    media_id: String,
) -> std::result::Result<Vec<VocabularyCandidate>, String> {
    crate::application::ai::results::list_vocabulary_candidates(state.inner().clone(), media_id)
}

#[tauri::command]
pub async fn prepare_transcription(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    media_id: String,
    start_ms: u64,
    end_ms: u64,
) -> std::result::Result<PreparationSummary, String> {
    crate::application::ai::preparation::prepare_transcription(
        app,
        state.inner().clone(),
        media_id,
        start_ms,
        end_ms,
    )
    .await
}

#[tauri::command]
pub fn cancel_preparation(state: State<'_, AppState>) -> std::result::Result<(), String> {
    crate::application::ai::preparation::cancel_preparation(state.inner().clone())
}
