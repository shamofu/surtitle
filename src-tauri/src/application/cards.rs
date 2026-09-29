use super::*;
use anyhow::{Context, bail};
use surtitle_core::SaveCard;
type IpcResult<T> = std::result::Result<T, String>;
pub async fn save_card(state: AppState, request: SaveCard) -> IpcResult<()> {
    let state = state.clone();
    async {
        crate::application::media_tools::ensure_audio_stream(&state, &request.media_id).await?;
        let (media, source_cues) = {
            let db = lock(&state.db)?;
            (db.media(&request.media_id)?, db.card_source_cues(&request)?)
        };
        let mut segment = source_cues[0].clone();
        segment.end_ms = source_cues
            .iter()
            .map(|cue| cue.end_ms)
            .max()
            .context("missing card source")?;
        let clip_range = surtitle_core::replay_range(
            segment.start_ms,
            segment.end_ms,
            media.duration_ms,
            state.settings()?.replay_context_ms,
        )?;
        // FFmpeg is a first-use dependency. Failure leaves no partially saved card.
        let audio = crate::application::media_tools::extract_card_audio(
            &state, &media, &segment, clip_range,
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
        let saved = db.save_card_with_audio_range(
            &request,
            Some(audio.to_string_lossy().into_owned()),
            Some(clip_range),
        );
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
