use super::*;
use anyhow::bail;
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
        let (media, source_cues, selected_range) = {
            let db = lock(&state.db)?;
            (
                db.media(&request.media_id)?,
                db.card_source_cues(&request)?,
                db.card_source_range(&request)?,
            )
        };
        let mut segment = source_cues[0].clone();
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
            &media,
            &segment,
            clip_range,
            operation_id.as_deref(),
        )
        .await?;
        let db = lock(&state.db)?;
        let current = db.card_source_cues(&request);
        let current_media = db.media(&media.id)?;
        let unchanged = current.is_ok_and(|cues| {
            serde_json::to_value(&cues).ok() == serde_json::to_value(&source_cues).ok()
        }) && current_media.path == media.path
            && current_media.audio_stream_index == media.audio_stream_index;
        if !unchanged {
            let _ = std::fs::remove_file(audio);
            bail!("The subtitle or media changed while preparing card audio. Save it again.");
        }
        let audio_path = Some(audio.to_string_lossy().into_owned());
        let saved = if let Some(reference) = &draft {
            db.save_card_from_editor_draft(reference, &request, audio_path, Some(clip_range))
        } else {
            db.save_card_with_audio_range(&request, audio_path, Some(clip_range))
        };
        if saved.is_err() {
            let _ = std::fs::remove_file(&audio);
        }
        saved?;
        Ok(())
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
