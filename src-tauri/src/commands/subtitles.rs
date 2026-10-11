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
    let committed_changes = state.changes.clone();
    let changed_subtitles = Some(media_id.clone());
    let changed_media = Some(media_id.clone());
    let result = crate::application::subtitles::import_subtitles(
        state.inner().clone(),
        media_id,
        replace_existing,
    )
    .await;
    if matches!(&result, Ok(true)) {
        committed_changes.publish(
            crate::application::changes::ChangeDomain::Subtitles,
            changed_subtitles,
        );
        committed_changes.publish(
            crate::application::changes::ChangeDomain::Media,
            changed_media,
        );
    }
    result
}
#[tauri::command]
pub fn edit_segment(state: State<'_, AppState>, segment: SubtitleSegment) -> IpcResult<()> {
    let committed_changes = state.changes.clone();
    let changed_subtitles = None;
    let changed_media = None;
    let result = crate::application::subtitles::edit_segment(state.inner().clone(), segment);
    if result.is_ok() {
        committed_changes.publish(
            crate::application::changes::ChangeDomain::Subtitles,
            changed_subtitles,
        );
        committed_changes.publish(
            crate::application::changes::ChangeDomain::Media,
            changed_media,
        );
    }
    result
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
    let committed_changes = state.changes.clone();
    let changed_subtitles = Some(media_id.clone());
    let changed_media = Some(media_id.clone());
    let result = crate::application::subtitles::restore_subtitle_version(
        state.inner().clone(),
        media_id,
        version_id,
    );
    if result.is_ok() {
        committed_changes.publish(
            crate::application::changes::ChangeDomain::Subtitles,
            changed_subtitles,
        );
        committed_changes.publish(
            crate::application::changes::ChangeDomain::Media,
            changed_media,
        );
    }
    result
}
