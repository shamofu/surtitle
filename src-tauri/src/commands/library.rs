//! Tauri IPC adapters; application services own all business logic.
use crate::application::AppState;
use crate::application::library::{ImportRequest, LocalMediaImportResult, MediaFileValidation};
use tauri::State;
type IpcResult<T> = std::result::Result<T, String>;

#[tauri::command]
pub async fn select_media_files() -> IpcResult<Vec<String>> {
    crate::application::library::select_media_files().await
}

#[tauri::command]
pub async fn validate_media_files(
    state: State<'_, AppState>,
    paths: Vec<String>,
    learning_language: String,
    explanation_language: String,
) -> IpcResult<Vec<MediaFileValidation>> {
    crate::application::library::validate_media_files(
        state.inner().clone(),
        paths,
        learning_language,
        explanation_language,
    )
}

#[tauri::command]
pub async fn import_local_media(
    state: State<'_, AppState>,
    request: ImportRequest,
) -> IpcResult<LocalMediaImportResult> {
    let committed_changes = state.changes.clone();
    let changed_media = None;
    let result = crate::application::library::import_local_media(state.inner().clone(), request);
    if result.is_ok() {
        committed_changes.publish(
            crate::application::changes::ChangeDomain::Media,
            changed_media,
        );
    }
    result
}

#[tauri::command]
pub async fn import_media(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    request: ImportRequest,
) -> IpcResult<()> {
    let committed_changes = state.changes.clone();
    let changed_media = None;
    let result =
        crate::application::library::import_media(app, state.inner().clone(), request).await;
    if result.is_ok() {
        committed_changes.publish(
            crate::application::changes::ChangeDomain::Media,
            changed_media,
        );
    }
    result
}

#[tauri::command]
pub async fn start_url_import(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    request: ImportRequest,
) -> IpcResult<String> {
    crate::application::library::start_url_import(app, state.inner().clone(), request).await
}

#[tauri::command]
pub async fn relink_media(state: State<'_, AppState>, media_id: String) -> IpcResult<()> {
    let committed_changes = state.changes.clone();
    let changed_media = Some(media_id.clone());
    let result = crate::application::library::relink_media(state.inner().clone(), media_id).await;
    if result.is_ok() {
        committed_changes.publish(
            crate::application::changes::ChangeDomain::Media,
            changed_media,
        );
    }
    result
}

#[tauri::command]
pub async fn remove_media(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    media_id: String,
) -> IpcResult<()> {
    let committed_changes = state.changes.clone();
    let changed_media = Some(media_id.clone());
    let changed_cards = None;
    let changed_subtitles = Some(media_id.clone());
    let changed_drafts = Some(media_id.clone());
    let result =
        crate::application::library::remove_media(app, state.inner().clone(), media_id).await;
    if result.is_ok() {
        committed_changes.publish(
            crate::application::changes::ChangeDomain::Media,
            changed_media,
        );
        committed_changes.publish(
            crate::application::changes::ChangeDomain::Cards,
            changed_cards,
        );
        committed_changes.publish(
            crate::application::changes::ChangeDomain::Subtitles,
            changed_subtitles,
        );
        committed_changes.publish(
            crate::application::changes::ChangeDomain::Drafts,
            changed_drafts,
        );
    }
    result
}
