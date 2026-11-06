//! Typed desktop facades; application services own all business logic.
use crate::application::AppState;
use crate::application::transcript::TranscriptReview;
use crate::application::transcript::TranscriptionPreparation;
use surtitle_ai::BoundaryChoice;
use surtitle_ai::ManualTranscriptContent;
use surtitle_ai::TranscriptRangeSelection;
use surtitle_ai::TranscriptResultReview;

pub fn list_transcription_preparations(
    state: &AppState,
    media_id: String,
) -> std::result::Result<Vec<TranscriptionPreparation>, String> {
    crate::application::transcript::preparation::list_transcription_preparations(
        state.clone(),
        media_id,
    )
}

pub async fn create_transcription_quote(
    state: &AppState,
    preparation_id: String,
    model: Option<surtitle_core::AiModelPreference>,
    provider: Option<surtitle_core::AiProvider>,
    ai_configuration_generation: Option<u64>,
) -> std::result::Result<crate::application::ai::AiQuote, String> {
    crate::application::transcript::preparation::create_transcription_quote(
        state.clone(),
        preparation_id,
        model,
        provider,
        ai_configuration_generation,
    )
    .await
}

pub async fn save_manual_transcript_range(
    state: &AppState,
    job_id: String,
    draft_digest: String,
    ordinal: u32,
    expected_range_version: u64,
    content: ManualTranscriptContent,
) -> std::result::Result<TranscriptReview, String> {
    let committed_changes = state.changes.clone();
    let changed_review = Some(job_id.clone());
    let changed_drafts = None;
    let result = crate::application::transcript::ranges::save_manual_transcript_range(
        state.clone(),
        job_id,
        draft_digest,
        ordinal,
        expected_range_version,
        content,
    )
    .await;
    if result.is_ok() {
        committed_changes.publish(
            crate::application::changes::ChangeDomain::Review,
            changed_review,
        );
        committed_changes.publish(
            crate::application::changes::ChangeDomain::Drafts,
            changed_drafts,
        );
    }
    result
}

pub async fn select_transcript_range_source(
    state: &AppState,
    job_id: String,
    draft_digest: String,
    ordinal: u32,
    expected_range_version: u64,
    source: TranscriptRangeSelection,
) -> std::result::Result<TranscriptReview, String> {
    let committed_changes = state.changes.clone();
    let changed_review = Some(job_id.clone());
    let changed_drafts = None;
    let result = crate::application::transcript::ranges::select_transcript_range_source(
        state.clone(),
        job_id,
        draft_digest,
        ordinal,
        expected_range_version,
        source,
    )
    .await;
    if result.is_ok() {
        committed_changes.publish(
            crate::application::changes::ChangeDomain::Review,
            changed_review,
        );
        committed_changes.publish(
            crate::application::changes::ChangeDomain::Drafts,
            changed_drafts,
        );
    }
    result
}

pub async fn get_transcript_review(
    state: &AppState,
    job_id: String,
) -> std::result::Result<TranscriptReview, String> {
    crate::application::transcript::review::get_transcript_review(state.clone(), job_id).await
}

pub async fn get_transcript_result_detail(
    state: &AppState,
    job_id: String,
    ordinal: u32,
) -> std::result::Result<TranscriptResultReview, String> {
    crate::application::transcript::review::get_transcript_result_detail(
        state.clone(),
        job_id,
        ordinal,
    )
    .await
}

pub async fn reparse_transcript_evidence(
    state: &AppState,
    job_id: String,
    ordinal: u32,
    evidence_sha256: String,
) -> std::result::Result<TranscriptReview, String> {
    let committed_changes = state.changes.clone();
    let changed_review = Some(job_id.clone());
    let changed_drafts = None;
    let result = crate::application::transcript::review::reparse_transcript_evidence(
        state.clone(),
        job_id,
        ordinal,
        evidence_sha256,
    )
    .await;
    if result.is_ok() {
        committed_changes.publish(
            crate::application::changes::ChangeDomain::Review,
            changed_review,
        );
        committed_changes.publish(
            crate::application::changes::ChangeDomain::Drafts,
            changed_drafts,
        );
    }
    result
}

pub async fn select_transcript_reparse(
    state: &AppState,
    job_id: String,
    ordinal: u32,
    candidate_id: String,
    draft_digest: String,
) -> std::result::Result<TranscriptReview, String> {
    let committed_changes = state.changes.clone();
    let changed_review = Some(job_id.clone());
    let changed_drafts = None;
    let result = crate::application::transcript::review::select_transcript_reparse(
        state.clone(),
        job_id,
        ordinal,
        candidate_id,
        draft_digest,
    )
    .await;
    if result.is_ok() {
        committed_changes.publish(
            crate::application::changes::ChangeDomain::Review,
            changed_review,
        );
        committed_changes.publish(
            crate::application::changes::ChangeDomain::Drafts,
            changed_drafts,
        );
    }
    result
}

pub async fn resolve_transcript_boundary(
    state: &AppState,
    job_id: String,
    draft_digest: String,
    boundary_id: String,
    choice: BoundaryChoice,
) -> std::result::Result<TranscriptReview, String> {
    let committed_changes = state.changes.clone();
    let changed_review = Some(job_id.clone());
    let changed_drafts = None;
    let result = crate::application::transcript::review::resolve_transcript_boundary(
        state.clone(),
        job_id,
        draft_digest,
        boundary_id,
        choice,
    )
    .await;
    if result.is_ok() {
        committed_changes.publish(
            crate::application::changes::ChangeDomain::Review,
            changed_review,
        );
        committed_changes.publish(
            crate::application::changes::ChangeDomain::Drafts,
            changed_drafts,
        );
    }
    result
}

pub async fn acknowledge_transcript_warning(
    state: &AppState,
    job_id: String,
    draft_digest: String,
    warning_id: String,
) -> std::result::Result<TranscriptReview, String> {
    let committed_changes = state.changes.clone();
    let changed_review = Some(job_id.clone());
    let changed_drafts = None;
    let result = crate::application::transcript::review::acknowledge_transcript_warning(
        state.clone(),
        job_id,
        draft_digest,
        warning_id,
    )
    .await;
    if result.is_ok() {
        committed_changes.publish(
            crate::application::changes::ChangeDomain::Review,
            changed_review,
        );
        committed_changes.publish(
            crate::application::changes::ChangeDomain::Drafts,
            changed_drafts,
        );
    }
    result
}

pub async fn apply_transcript_review(
    state: &AppState,
    job_id: String,
    draft_digest: String,
) -> std::result::Result<TranscriptReview, String> {
    let committed_changes = state.changes.clone();
    let changed_jobs = Some(job_id.clone());
    let changed_budget = None;
    let changed_subtitles = None;
    let changed_media = None;
    let changed_review = Some(job_id.clone());
    let changed_drafts = None;
    let result = crate::application::transcript::review::apply_transcript_review(
        state.clone(),
        job_id,
        draft_digest,
    )
    .await;
    if result.is_ok() {
        committed_changes.publish(
            crate::application::changes::ChangeDomain::Jobs,
            changed_jobs,
        );
        committed_changes.publish(
            crate::application::changes::ChangeDomain::Budget,
            changed_budget,
        );
        committed_changes.publish(
            crate::application::changes::ChangeDomain::Subtitles,
            changed_subtitles,
        );
        committed_changes.publish(
            crate::application::changes::ChangeDomain::Media,
            changed_media,
        );
        committed_changes.publish(
            crate::application::changes::ChangeDomain::Review,
            changed_review,
        );
        committed_changes.publish(
            crate::application::changes::ChangeDomain::Drafts,
            changed_drafts,
        );
    }
    result
}

pub async fn prepare_boundary_repair(
    app: crate::runtime::DesktopHost,
    state: &AppState,
    job_id: String,
    draft_digest: String,
    boundary_id: String,
) -> std::result::Result<crate::application::ai::AiQuote, String> {
    crate::application::transcript::repair::prepare_boundary_repair(
        app,
        state.clone(),
        job_id,
        draft_digest,
        boundary_id,
    )
    .await
}
