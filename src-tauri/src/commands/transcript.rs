//! Tauri IPC adapters; application services own all business logic.
use crate::application::AppState;
use crate::application::transcript::TranscriptReview;
use crate::application::transcript::TranscriptionPreparation;
use surtitle_ai::BoundaryChoice;
use surtitle_ai::ManualTranscriptContent;
use surtitle_ai::TranscriptRangeSelection;
use surtitle_ai::TranscriptResultReview;
use tauri::State;

#[tauri::command]
pub fn list_transcription_preparations(
    state: State<'_, AppState>,
    media_id: String,
) -> std::result::Result<Vec<TranscriptionPreparation>, String> {
    crate::application::transcript::preparation::list_transcription_preparations(
        state.inner().clone(),
        media_id,
    )
}

#[tauri::command]
pub async fn create_transcription_quote(
    state: State<'_, AppState>,
    preparation_id: String,
    model: Option<surtitle_core::AiModelPreference>,
) -> std::result::Result<crate::application::ai::AiQuote, String> {
    crate::application::transcript::preparation::create_transcription_quote(
        state.inner().clone(),
        preparation_id,
        model,
    )
    .await
}

#[tauri::command]
pub async fn save_manual_transcript_range(
    state: State<'_, AppState>,
    job_id: String,
    draft_digest: String,
    ordinal: u32,
    expected_range_version: u64,
    content: ManualTranscriptContent,
) -> std::result::Result<TranscriptReview, String> {
    crate::application::transcript::ranges::save_manual_transcript_range(
        state.inner().clone(),
        job_id,
        draft_digest,
        ordinal,
        expected_range_version,
        content,
    )
    .await
}

#[tauri::command]
pub async fn select_transcript_range_source(
    state: State<'_, AppState>,
    job_id: String,
    draft_digest: String,
    ordinal: u32,
    expected_range_version: u64,
    source: TranscriptRangeSelection,
) -> std::result::Result<TranscriptReview, String> {
    crate::application::transcript::ranges::select_transcript_range_source(
        state.inner().clone(),
        job_id,
        draft_digest,
        ordinal,
        expected_range_version,
        source,
    )
    .await
}

#[tauri::command]
pub async fn get_transcript_review(
    state: State<'_, AppState>,
    job_id: String,
) -> std::result::Result<TranscriptReview, String> {
    crate::application::transcript::review::get_transcript_review(state.inner().clone(), job_id)
        .await
}

#[tauri::command]
pub async fn get_transcript_result_detail(
    state: State<'_, AppState>,
    job_id: String,
    ordinal: u32,
) -> std::result::Result<TranscriptResultReview, String> {
    crate::application::transcript::review::get_transcript_result_detail(
        state.inner().clone(),
        job_id,
        ordinal,
    )
    .await
}

#[tauri::command]
pub async fn reparse_transcript_evidence(
    state: State<'_, AppState>,
    job_id: String,
    ordinal: u32,
    evidence_sha256: String,
) -> std::result::Result<TranscriptReview, String> {
    crate::application::transcript::review::reparse_transcript_evidence(
        state.inner().clone(),
        job_id,
        ordinal,
        evidence_sha256,
    )
    .await
}

#[tauri::command]
pub async fn select_transcript_reparse(
    state: State<'_, AppState>,
    job_id: String,
    ordinal: u32,
    candidate_id: String,
    draft_digest: String,
) -> std::result::Result<TranscriptReview, String> {
    crate::application::transcript::review::select_transcript_reparse(
        state.inner().clone(),
        job_id,
        ordinal,
        candidate_id,
        draft_digest,
    )
    .await
}

#[tauri::command]
pub async fn resolve_transcript_boundary(
    state: State<'_, AppState>,
    job_id: String,
    draft_digest: String,
    boundary_id: String,
    choice: BoundaryChoice,
) -> std::result::Result<TranscriptReview, String> {
    crate::application::transcript::review::resolve_transcript_boundary(
        state.inner().clone(),
        job_id,
        draft_digest,
        boundary_id,
        choice,
    )
    .await
}

#[tauri::command]
pub async fn acknowledge_transcript_warning(
    state: State<'_, AppState>,
    job_id: String,
    draft_digest: String,
    warning_id: String,
) -> std::result::Result<TranscriptReview, String> {
    crate::application::transcript::review::acknowledge_transcript_warning(
        state.inner().clone(),
        job_id,
        draft_digest,
        warning_id,
    )
    .await
}

#[tauri::command]
pub async fn apply_transcript_review(
    state: State<'_, AppState>,
    job_id: String,
    draft_digest: String,
) -> std::result::Result<TranscriptReview, String> {
    crate::application::transcript::review::apply_transcript_review(
        state.inner().clone(),
        job_id,
        draft_digest,
    )
    .await
}

#[tauri::command]
pub async fn prepare_boundary_repair(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    job_id: String,
    draft_digest: String,
    boundary_id: String,
) -> std::result::Result<crate::application::ai::AiQuote, String> {
    crate::application::transcript::repair::prepare_boundary_repair(
        app,
        state.inner().clone(),
        job_id,
        draft_digest,
        boundary_id,
    )
    .await
}
