//! Typed desktop facades; application services own all business logic.
use crate::application::AppState;
use crate::application::transcript::study::ExportSelection;
use crate::application::transcript::study::PrepareSelection;
use crate::application::transcript::study::SelectionCard;
use crate::application::transcript::study::SelectionQuote;
use crate::application::transcript::study::SelectionVersion;
use crate::application::transcript::study::SelectionView;
use crate::application::transcript::study::UpdateSelection;
use serde_json::Value;

pub async fn prepare_draft_selection(
    state: &AppState,
    request: PrepareSelection,
) -> std::result::Result<SelectionView, String> {
    let committed_changes = state.changes.clone();
    let changed_drafts = None;
    let result =
        crate::application::transcript::study::prepare_draft_selection(state.clone(), request)
            .await;
    if result.is_ok() {
        committed_changes.publish(
            crate::application::changes::ChangeDomain::Drafts,
            changed_drafts,
        );
    }
    result
}

pub async fn list_draft_selections(
    state: &AppState,
    media_id: String,
) -> std::result::Result<Vec<SelectionView>, String> {
    crate::application::transcript::study::list_draft_selections(state.clone(), media_id).await
}

pub async fn update_draft_selection(
    state: &AppState,
    request: UpdateSelection,
) -> std::result::Result<SelectionView, String> {
    let committed_changes = state.changes.clone();
    let changed_drafts = None;
    let result =
        crate::application::transcript::study::update_draft_selection(state.clone(), request).await;
    if result.is_ok() {
        committed_changes.publish(
            crate::application::changes::ChangeDomain::Drafts,
            changed_drafts,
        );
    }
    result
}

pub fn remove_draft_selection(
    state: &AppState,
    request: SelectionVersion,
) -> std::result::Result<(), String> {
    let committed_changes = state.changes.clone();
    let changed_drafts = None;
    let result =
        crate::application::transcript::study::remove_draft_selection(state.clone(), request);
    if result.is_ok() {
        committed_changes.publish(
            crate::application::changes::ChangeDomain::Drafts,
            changed_drafts,
        );
    }
    result
}

pub async fn save_draft_selection_card(
    state: &AppState,
    request: SelectionCard,
    operation_id: Option<String>,
) -> std::result::Result<(), String> {
    let committed_changes = state.changes.clone();
    let changed_cards = None;
    let result = crate::application::transcript::study::save_draft_selection_card(
        state.clone(),
        request,
        operation_id,
    )
    .await;
    if result.is_ok() {
        committed_changes.publish(
            crate::application::changes::ChangeDomain::Cards,
            changed_cards,
        );
    }
    result
}

pub async fn create_draft_selection_quote(
    state: &AppState,
    request: SelectionQuote,
) -> std::result::Result<crate::application::ai::AiQuote, String> {
    crate::application::transcript::study::create_draft_selection_quote(state.clone(), request)
        .await
}

pub async fn list_draft_selection_candidates(
    state: &AppState,
    request: SelectionVersion,
) -> std::result::Result<Vec<Value>, String> {
    crate::application::transcript::study::list_draft_selection_candidates(state.clone(), request)
        .await
}

pub async fn export_draft_selection(
    state: &AppState,
    request: ExportSelection,
) -> std::result::Result<bool, String> {
    crate::application::transcript::study::export_draft_selection(state.clone(), request).await
}
