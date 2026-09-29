use super::*;
use anyhow::ensure;
use surtitle_core::SubtitleSegment;
type IpcResult<T> = std::result::Result<T, String>;
use super::playback::refresh_current_subtitles_locked;
pub fn list_segments(state: AppState, media_id: String) -> IpcResult<Vec<SubtitleSegment>> {
    lock(&state.db)
        .and_then(|db| db.list_segments(&media_id))
        .map_err(err)
}
pub async fn import_subtitles(
    state: AppState,
    media_id: String,
    replace_existing: Option<bool>,
) -> IpcResult<()> {
    let previous = lock(&state.db)
        .and_then(|db| db.list_segments(&media_id))
        .map_err(err)?;
    if !previous.is_empty() && !replace_existing.unwrap_or(false) {
        return Err("Confirm replacement of the current subtitles; their previous version will be preserved".into());
    }
    let Some(file) = rfd::AsyncFileDialog::new()
        .add_filter("Subtitles", &["srt", "vtt"])
        .pick_file()
        .await
    else {
        return Ok(());
    };
    (|| {
        ensure!(
            file.path().metadata()?.len() <= 64 * 1024 * 1024,
            "subtitle too large"
        );
        let segments =
            surtitle_core::subtitles::parse(&std::fs::read_to_string(file.path())?, &media_id)?;
        ensure!(!segments.is_empty(), "subtitle file contains no cues");
        let mut playback = state.playback.operation()?;
        {
            let mut db = lock(&state.db)?;
            ensure!(
                serde_json::to_vec(&db.list_segments(&media_id)?)?
                    == serde_json::to_vec(&previous)?,
                "Subtitles changed while selecting the file; nothing was replaced"
            );
            db.replace_subtitles(
                &media_id,
                &segments,
                None,
                replace_existing.unwrap_or(false),
                "Before importing an external subtitle file",
            )?;
        }
        refresh_current_subtitles_locked(&state, &mut playback, &media_id)
    })()
    .map_err(err)
}
pub fn edit_segment(state: AppState, segment: SubtitleSegment) -> IpcResult<()> {
    (|| {
        let mut playback = state.playback.operation()?;
        lock(&state.db)?.edit_segment(&segment)?;
        refresh_current_subtitles_locked(&state, &mut playback, &segment.media_id)
    })()
    .map_err(err)
}
pub fn list_subtitle_versions(
    state: AppState,
    media_id: String,
) -> IpcResult<Vec<surtitle_core::SubtitleVersion>> {
    lock(&state.db)
        .and_then(|db| db.subtitle_versions(&media_id))
        .map_err(err)
}
pub fn restore_subtitle_version(
    state: AppState,
    media_id: String,
    version_id: String,
) -> IpcResult<()> {
    (|| {
        let mut playback = state.playback.operation()?;
        lock(&state.db)?.restore_subtitle_version(&media_id, &version_id)?;
        refresh_current_subtitles_locked(&state, &mut playback, &media_id)
    })()
    .map_err(err)
}
