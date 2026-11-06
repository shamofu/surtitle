//! Small reconnect checkpoint; unchanged playback does not require a data snapshot.
use crate::application::{AppState, changes::ChangeCheckpoint, err};

pub fn get_change_checkpoint(state: &AppState) -> Result<ChangeCheckpoint, String> {
    state.changes.checkpoint().map_err(err)
}
