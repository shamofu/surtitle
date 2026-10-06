use crate::application::AppState;
use surtitle_core::{
    EditorDraftVersion, EditorDraftView, SaveCard, SaveEditorDraft, SubtitleSegment,
};
use tauri::State;
type IpcResult<T> = std::result::Result<T, String>;

#[tauri::command]
pub fn list_editor_drafts(
    state: State<'_, AppState>,
    media_id: String,
) -> IpcResult<Vec<EditorDraftView>> {
    crate::application::editor_drafts::list_editor_drafts(state.inner().clone(), media_id)
}
#[tauri::command]
pub fn save_editor_draft(
    state: State<'_, AppState>,
    request: SaveEditorDraft,
) -> IpcResult<EditorDraftView> {
    crate::application::editor_drafts::save_editor_draft(state.inner().clone(), request)
}
#[tauri::command]
pub fn delete_editor_draft(
    state: State<'_, AppState>,
    reference: EditorDraftVersion,
) -> IpcResult<()> {
    crate::application::editor_drafts::delete_editor_draft(state.inner().clone(), reference)
}
#[tauri::command]
pub fn rebind_editor_draft(
    state: State<'_, AppState>,
    reference: EditorDraftVersion,
    source_cues: Vec<SubtitleSegment>,
) -> IpcResult<EditorDraftView> {
    crate::application::editor_drafts::rebind_editor_draft(
        state.inner().clone(),
        reference,
        source_cues,
    )
}
#[tauri::command]
pub fn commit_subtitle_editor_draft(
    state: State<'_, AppState>,
    reference: EditorDraftVersion,
    segment: SubtitleSegment,
) -> IpcResult<Option<String>> {
    crate::application::editor_drafts::commit_subtitle_editor_draft(
        state.inner().clone(),
        reference,
        segment,
    )
}
#[tauri::command]
pub async fn save_phrase_editor_draft(
    state: State<'_, AppState>,
    reference: EditorDraftVersion,
    request: SaveCard,
) -> IpcResult<()> {
    crate::application::editor_drafts::save_phrase_editor_draft(
        state.inner().clone(),
        reference,
        request,
    )
    .await
}
