use super::*;
use anyhow::ensure;
use serde::{Deserialize, Serialize};
use std::path::Path;
use surtitle_core::Media;

type IpcResult<T> = std::result::Result<T, String>;
mod local;
pub use local::{
    LocalMediaImportResult, MediaFileValidation, import_local_media, validate_media_files,
};

const MEDIA_EXTENSIONS: &[&str] = &[
    "mp4", "mkv", "webm", "mov", "avi", "m4v", "mp3", "wav", "flac", "m4a", "ogg", "opus",
];
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportRequest {
    pub path: String,
    pub title: Option<String>,
    pub learning_language: String,
    pub explanation_language: String,
}

pub async fn select_media_files() -> IpcResult<Vec<String>> {
    Ok(rfd::AsyncFileDialog::new()
        .add_filter("Video / audio", MEDIA_EXTENSIONS)
        .pick_files()
        .await
        .unwrap_or_default()
        .iter()
        .map(|p| p.path().to_string_lossy().into_owned())
        .collect())
}
pub async fn relink_media(state: AppState, media_id: String) -> IpcResult<()> {
    let Some(file) = rfd::AsyncFileDialog::new().pick_file().await else {
        return Ok(());
    };
    (|| {
        let db = lock(&state.db)?;
        let mut media = db.media(&media_id)?;
        media.path = check_local_file(file.path())?
            .to_string_lossy()
            .into_owned();
        media.audio_stream_index = None;
        media.subtitle_stream_index = None;
        media.status = "ready".into();
        media.error = None;
        db.put_media(&media)
    })()
    .map_err(err)
}
pub async fn remove_media(
    app: tauri::AppHandle,
    state: AppState,
    media_id: String,
) -> IpcResult<()> {
    let state = state.clone();
    on_main(app, move || {
        let mut playback = state.playback.operation()?;
        playback.detach_if_current(&media_id)?;
        lock(&state.db)?.remove_media(&media_id)
    })
    .await
    .map_err(err)
}

fn imported_media(
    path: &Path,
    title: Option<String>,
    learning_language: &str,
    explanation_language: &str,
) -> Media {
    let audio = path.extension().is_some_and(|extension| {
        ["mp3", "wav", "flac", "m4a", "ogg", "opus"]
            .iter()
            .any(|kind| extension.eq_ignore_ascii_case(kind))
    });
    Media {
        id: surtitle_core::id(),
        title: title
            .filter(|title| !title.trim().is_empty())
            .unwrap_or_else(|| {
                path.file_stem()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned()
            }),
        path: path.to_string_lossy().into_owned(),
        kind: if audio { "audio" } else { "video" }.into(),
        learning_language: learning_language.into(),
        explanation_language: explanation_language.into(),
        duration_ms: 0,
        created_at: surtitle_core::now(),
        last_position_ms: 0,
        audio_stream_index: None,
        subtitle_stream_index: None,
        segment_count: 0,
        card_count: 0,
        status: "ready".into(),
        error: None,
    }
}
