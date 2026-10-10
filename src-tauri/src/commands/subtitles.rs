use crate::application::AppState;
use tauri::State;
type IpcResult<T> = std::result::Result<T, String>;
use surtitle_core::SubtitleSegment;

#[tauri::command]
pub fn list_segments(
    state: State<'_, AppState>,
    media_id: String,
) -> IpcResult<Vec<SubtitleSegment>> {
    crate::application::subtitles::list_segments(state.inner().clone(), media_id)
}
#[tauri::command]
pub async fn import_subtitles(
    state: State<'_, AppState>,
    media_id: String,
    replace_existing: Option<bool>,
) -> IpcResult<bool> {
    crate::application::subtitles::import_subtitles(
        state.inner().clone(),
        media_id,
        replace_existing,
    )
    .await
}
#[tauri::command]
pub fn edit_segment(state: State<'_, AppState>, segment: SubtitleSegment) -> IpcResult<()> {
    crate::application::subtitles::edit_segment(state.inner().clone(), segment)
}
#[tauri::command]
pub fn list_subtitle_versions(
    state: State<'_, AppState>,
    media_id: String,
) -> IpcResult<Vec<surtitle_core::SubtitleVersion>> {
    crate::application::subtitles::list_subtitle_versions(state.inner().clone(), media_id)
}
#[tauri::command]
pub fn restore_subtitle_version(
    state: State<'_, AppState>,
    media_id: String,
    version_id: String,
) -> IpcResult<()> {
    crate::application::subtitles::restore_subtitle_version(
        state.inner().clone(),
        media_id,
        version_id,
    )
}
