use crate::application::AppState;
use tauri::State;
type IpcResult<T> = std::result::Result<T, String>;
use crate::player::Control;
use crate::player::PlayerState;

#[tauri::command]
pub async fn load_media(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    media_id: String,
) -> IpcResult<()> {
    crate::application::playback::load_media(app, state.inner().clone(), media_id).await
}
#[tauri::command]
pub fn get_player_state(state: State<'_, AppState>) -> IpcResult<PlayerState> {
    crate::application::playback::get_player_state(state.inner().clone())
}
#[tauri::command]
pub async fn play_source_range(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    media_id: String,
    source_cue_ids: Vec<String>,
) -> IpcResult<()> {
    crate::application::playback::play_source_range(
        app,
        state.inner().clone(),
        media_id,
        source_cue_ids,
    )
    .await
}
#[tauri::command]
pub async fn player_control(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    request: Control,
) -> IpcResult<()> {
    crate::application::playback::player_control(app, state.inner().clone(), request).await
}
#[tauri::command]
pub async fn play_card_audio(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    card_id: String,
) -> IpcResult<()> {
    crate::application::playback::play_card_audio(app, state.inner().clone(), card_id).await
}
