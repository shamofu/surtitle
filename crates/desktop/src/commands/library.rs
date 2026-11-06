//! Typed desktop facades; application services own all business logic.
use crate::application::AppState;
use crate::application::library::{ImportRequest, LocalMediaImportResult};
type IpcResult<T> = std::result::Result<T, String>;

pub async fn select_media_files() -> IpcResult<Vec<String>> {
    crate::application::library::select_media_files().await
}

pub async fn import_local_media(
    state: &AppState,
    request: ImportRequest,
) -> IpcResult<LocalMediaImportResult> {
    let committed_changes = state.changes.clone();
    let changed_media = None;
    let result = crate::application::library::import_local_media(state.clone(), request);
    if result.is_ok() {
        committed_changes.publish(
            crate::application::changes::ChangeDomain::Media,
            changed_media,
        );
    }
    result
}

pub async fn relink_media(state: &AppState, media_id: String) -> IpcResult<()> {
    let committed_changes = state.changes.clone();
    let changed_media = Some(media_id.clone());
    let result = crate::application::library::relink_media(state.clone(), media_id).await;
    if result.is_ok() {
        committed_changes.publish(
            crate::application::changes::ChangeDomain::Media,
            changed_media,
        );
    }
    result
}

pub async fn remove_media(
    app: crate::runtime::DesktopHost,
    state: &AppState,
    media_id: String,
) -> IpcResult<()> {
    let committed_changes = state.changes.clone();
    let changed_media = Some(media_id.clone());
    let changed_cards = None;
    let changed_subtitles = Some(media_id.clone());
    let changed_drafts = Some(media_id.clone());
    let result = crate::application::library::remove_media(app, state.clone(), media_id).await;
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
