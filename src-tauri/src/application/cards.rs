use super::*;
use surtitle_core::SaveCard;
type IpcResult<T> = std::result::Result<T, String>;
pub async fn save_card(
    state: AppState,
    request: SaveCard,
    operation_id: Option<String>,
) -> IpcResult<()> {
    save_card_with_editor_draft(state, request, None, operation_id).await
}
pub async fn save_card_with_editor_draft(
    state: AppState,
    request: SaveCard,
    draft: Option<surtitle_core::EditorDraftVersion>,
    operation_id: Option<String>,
) -> IpcResult<()> {
    let state = state.clone();
    async {
        crate::application::media_tools::ensure_audio_stream_with_context(
            &state,
            &request.media_id,
            &surtitle_tools::CancellationToken::new(),
            operation_id.as_deref(),
        )
        .await?;
        let source = lock(&state.db)?.card_source_snapshot(&request)?;
        let media = source.media();
        let selected_range = source.range();
        let mut segment = source.cues()[0].clone();
        segment.start_ms = selected_range.start_ms;
        segment.end_ms = selected_range.end_ms;
        let clip_range = surtitle_core::replay_range(
            segment.start_ms,
            segment.end_ms,
            media.duration_ms,
            state.settings()?.replay_context_ms,
        )?;
        // FFmpeg is a first-use dependency. Failure leaves no partially saved card.
        let audio = crate::application::media_tools::extract_card_audio(
            &state,
            media,
            &segment,
            clip_range,
            operation_id.as_deref(),
        )
        .await?;
        audio.commit_with(|path| {
            let db = lock(&state.db)?;
            db.save_card_with_source_snapshot(
                &request,
                &source,
                Some(path.to_string_lossy().into_owned()),
                Some(clip_range),
                draft.as_ref(),
            )?;
            Ok(())
        })
    }
    .await
    .map_err(err)
}
pub fn rate_card(state: AppState, card_id: String, rating: String) -> IpcResult<()> {
    (|| {
        let retention = state.settings()?.retention;
        lock(&state.db)?.rate_card(&card_id, &rating, retention, chrono::Utc::now())?;
        Ok(())
    })()
    .map_err(err)
}
pub fn edit_card(state: AppState, request: surtitle_core::EditCard) -> IpcResult<()> {
    lock(&state.db)
        .and_then(|db| db.edit_card(&request).map(|_| ()))
        .map_err(err)
}
pub fn get_card_edit_state(
    state: AppState,
    card_id: String,
) -> IpcResult<surtitle_core::store::CardEditState> {
    lock(&state.db)
        .and_then(|db| db.card_edit_state(&card_id))
        .map_err(err)
}
pub fn save_card_edit(
    state: AppState,
    request: surtitle_core::EditCard,
    expected_revision: String,
) -> IpcResult<surtitle_core::store::CardEditState> {
    lock(&state.db)
        .and_then(|mut db| db.edit_card_checked(&request, &expected_revision))
        .map_err(err)
}
pub fn suspend_card(state: AppState, card_id: String, suspended: bool) -> IpcResult<()> {
    lock(&state.db)
        .and_then(|db| db.suspend_card(&card_id, suspended))
        .map_err(err)
}
pub fn delete_card(state: AppState, card_id: String) -> IpcResult<()> {
    // Removing a card never mutates another card's preserved clip. Orphan clip
    // reclamation is deliberately separate from deleting learning records.
    lock(&state.db)
        .and_then(|db| db.delete_card(&card_id).map(|_| ()))
        .map_err(err)
}
