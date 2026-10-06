use super::*;
use surtitle_core::{
    EditorDraftVersion, EditorDraftView, SaveCard, SaveEditorDraft, SubtitleSegment,
};

type IpcResult<T> = std::result::Result<T, String>;

pub fn list_editor_drafts(state: AppState, media_id: String) -> IpcResult<Vec<EditorDraftView>> {
    lock(&state.db)
        .and_then(|db| db.list_editor_drafts(&media_id))
        .map_err(err)
}

pub fn save_editor_draft(state: AppState, request: SaveEditorDraft) -> IpcResult<EditorDraftView> {
    lock(&state.db)
        .and_then(|db| db.save_editor_draft(&request))
        .map_err(err)
}

pub fn delete_editor_draft(state: AppState, reference: EditorDraftVersion) -> IpcResult<()> {
    lock(&state.db)
        .and_then(|db| db.delete_editor_draft(&reference))
        .map_err(err)
}

pub fn rebind_editor_draft(
    state: AppState,
    reference: EditorDraftVersion,
    source_cues: Vec<SubtitleSegment>,
) -> IpcResult<EditorDraftView> {
    lock(&state.db)
        .and_then(|db| db.rebind_editor_draft(&reference, &source_cues))
        .map_err(err)
}

pub fn commit_subtitle_editor_draft(
    state: AppState,
    reference: EditorDraftVersion,
    segment: SubtitleSegment,
) -> IpcResult<Option<String>> {
    (|| {
        let mut playback = state.playback.operation()?;
        lock(&state.db)?.commit_subtitle_editor_draft(&reference, &segment)?;
        // The database commit and draft consumption already succeeded. A player
        // refresh failure must not invite a second final-save attempt.
        Ok(super::playback::refresh_current_subtitles_locked(
            &state,
            &mut playback,
            &segment.media_id,
        )
        .err()
        .map(err))
    })()
    .map_err(err)
}

pub async fn save_phrase_editor_draft(
    state: AppState,
    reference: EditorDraftVersion,
    request: SaveCard,
) -> IpcResult<()> {
    super::cards::save_card_with_editor_draft(state, request, Some(reference)).await
}
