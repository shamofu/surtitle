use super::*;
use anyhow::ensure;
use serde::{Deserialize, Serialize};
use std::path::Path;
use surtitle_core::Media;
use tauri::Emitter;

type IpcResult<T> = std::result::Result<T, String>;
mod local;
pub use local::{
    LocalMediaImportResult, MediaFileValidation, import_local_media, validate_media_files,
};

const MEDIA_EXTENSIONS: &[&str] = &[
    "mp4", "mkv", "webm", "mov", "avi", "m4v", "mp3", "wav", "flac", "m4a", "ogg", "opus",
];
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRequest {
    pub kind: String,
    pub path_or_url: String,
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
pub async fn import_media(
    app: tauri::AppHandle,
    state: AppState,
    request: ImportRequest,
) -> IpcResult<()> {
    if request.kind == "url" {
        start_url_import(app, state, request).await?;
        return Ok(());
    }
    import_local_media(state, request).map(|_| ())
}
pub async fn start_url_import(
    app: tauri::AppHandle,
    state: AppState,
    request: ImportRequest,
) -> IpcResult<String> {
    let state = state.clone();
    (|| {
        ensure!(
            request.kind == "url"
                && request.path_or_url.len() <= 8192
                && !request.learning_language.trim().is_empty()
                && !request.explanation_language.trim().is_empty()
                && request.learning_language.len() <= 100
                && request.explanation_language.len() <= 100,
            "URL import requires a URL and learning and explanation languages"
        );
        let url = reqwest::Url::parse(&request.path_or_url)?;
        ensure!(
            ["http", "https"].contains(&url.scheme())
                && url.host_str().is_some()
                && url.username().is_empty()
                && url.password().is_none(),
            "Enter a public HTTP(S) media URL without credentials"
        );
        let (job_id, job) = state.downloads.start(request.clone())?;
        let id = job_id.clone();
        tauri::async_runtime::spawn(async move {
            let result = async {
                let (path, title) = crate::application::download::transfer::download_url(
                    &state,
                    &request.path_or_url,
                    &job,
                )
                .await?;
                let title = request
                    .title
                    .filter(|title| !title.trim().is_empty())
                    .unwrap_or(title);
                let media = imported_media(
                    &path,
                    Some(request.path_or_url),
                    Some(title),
                    &request.learning_language,
                    &request.explanation_language,
                );
                lock(&state.db)?.put_media(&media)?;
                Ok(media.id)
            }
            .await;
            let _ = state.downloads.finish(&id, result);
            let _ = app.emit("app-changed", ());
        });
        Ok(job_id)
    })()
    .map_err(err)
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
    source_url: Option<String>,
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
        source_url,
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
