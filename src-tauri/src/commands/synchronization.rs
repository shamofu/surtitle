//! Small reconnect checkpoint; unchanged playback does not require a data snapshot.
use crate::application::{AppState, changes::ChangeCheckpoint, err};
use tauri::State;

#[tauri::command]
pub fn get_change_checkpoint(state: State<'_, AppState>) -> Result<ChangeCheckpoint, String> {
    state.changes.checkpoint().map_err(err)
}
#[tauri::command]
pub fn get_snapshot_patch(
    state: State<'_, AppState>,
    domains: Vec<crate::application::changes::ChangeDomain>,
) -> Result<crate::application::ai::snapshot::SnapshotPatch, String> {
    crate::application::ai::snapshot::get_snapshot_patch(state.inner().clone(), domains)
}
