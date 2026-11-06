use crate::application::AppState;
type IpcResult<T> = std::result::Result<T, String>;
use crate::player::Control;
use crate::player::PlayerState;

pub fn load_media(
    app: crate::runtime::DesktopHost,
    state: &AppState,
    media_id: String,
) -> impl std::future::Future<Output = IpcResult<()>> + Send + 'static {
    let committed_changes = state.changes.clone();
    let changed_media = Some(media_id.clone());
    let load = crate::application::playback::load_media(app, state.clone(), media_id);
    async move {
        let result = load.await;
        if result.is_ok() {
            committed_changes.publish(
                crate::application::changes::ChangeDomain::Media,
                changed_media,
            );
        }
        result
    }
}
pub fn cancel_pending_media_loads(state: &AppState) -> IpcResult<()> {
    crate::application::playback::cancel_pending_media_loads(state)
}
pub fn player_control_for_media(
    app: crate::runtime::DesktopHost,
    state: &AppState,
    media_id: String,
    request: Control,
) -> impl std::future::Future<Output = IpcResult<()>> + Send + 'static {
    crate::application::playback::player_control_for_media(app, state.clone(), media_id, request)
}
pub fn get_player_state(state: &AppState) -> IpcResult<PlayerState> {
    crate::application::playback::get_player_state(state.clone())
}
pub fn play_source_range(
    app: crate::runtime::DesktopHost,
    state: &AppState,
    media_id: String,
    source_cue_ids: Vec<String>,
) -> impl std::future::Future<Output = IpcResult<()>> + Send + 'static {
    crate::application::playback::play_source_range(app, state.clone(), media_id, source_cue_ids)
}
pub async fn player_control(
    app: crate::runtime::DesktopHost,
    state: &AppState,
    request: Control,
) -> IpcResult<()> {
    crate::application::playback::player_control(app, state.clone(), request).await
}
pub async fn play_card_audio(
    app: crate::runtime::DesktopHost,
    state: &AppState,
    card_id: String,
) -> IpcResult<()> {
    crate::application::playback::play_card_audio(app, state.clone(), card_id).await
}
