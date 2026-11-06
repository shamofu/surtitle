use crate::application::AppState;
type IpcResult<T> = std::result::Result<T, String>;
use surtitle_core::SubtitleSegment;

pub fn list_segments(state: &AppState, media_id: String) -> IpcResult<Vec<SubtitleSegment>> {
    crate::application::subtitles::list_segments(state.clone(), media_id)
}
pub async fn import_subtitles(
    state: &AppState,
    media_id: String,
    replace_existing: Option<bool>,
) -> IpcResult<bool> {
    let committed_changes = state.changes.clone();
    let changed_subtitles = Some(media_id.clone());
    let changed_media = Some(media_id.clone());
    let result =
        crate::application::subtitles::import_subtitles(state.clone(), media_id, replace_existing)
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
pub fn list_subtitle_versions(
    state: &AppState,
    media_id: String,
) -> IpcResult<Vec<surtitle_core::SubtitleVersion>> {
    crate::application::subtitles::list_subtitle_versions(state.clone(), media_id)
}
pub fn restore_subtitle_version(
    state: &AppState,
    media_id: String,
    version_id: String,
) -> IpcResult<()> {
    let committed_changes = state.changes.clone();
    let changed_subtitles = Some(media_id.clone());
    let changed_media = Some(media_id.clone());
    let result = crate::application::subtitles::restore_subtitle_version(
        state.clone(),
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
