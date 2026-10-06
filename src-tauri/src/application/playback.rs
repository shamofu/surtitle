//! Playback operations hold one session lock across native changes and DB writes.
//! Acquire the operation before database or preferences guards; never await inside it.
use super::lock;
use crate::player::{Player, PlayerState};
use anyhow::{Context, Result};
use std::sync::{Mutex, MutexGuard};
use surtitle_core::Store;

#[derive(Default)]
pub(super) struct PlaybackCoordinator {
    session: Mutex<PlaybackSession>,
}
#[derive(Default)]
struct PlaybackSession {
    player: Option<Player>,
    media_id: Option<String>,
    error: Option<String>,
}
/// The guard is opaque: correlated session state changes only through operations.
pub(super) struct PlaybackOperation<'a> {
    session: MutexGuard<'a, PlaybackSession>,
}
impl PlaybackCoordinator {
    pub(super) fn operation(&self) -> Result<PlaybackOperation<'_>> {
        Ok(PlaybackOperation {
            session: lock(&self.session)?,
        })
    }
    pub(super) fn install(&self, player: Result<Player>) -> Result<()> {
        let mut session = lock(&self.session)?;
        session.media_id = None;
        match player {
            Ok(player) => {
                session.player = Some(player);
                session.error = None;
            }
            Err(error) => {
                session.player = None;
                session.error = Some(error.to_string());
            }
        }
        Ok(())
    }
    pub(super) fn shutdown(&self) -> Result<()> {
        let mut session = lock(&self.session)?;
        session.media_id = None;
        session.player.take();
        Ok(())
    }
    pub(super) fn tick(&self, database: &Mutex<Store>, persist: bool) -> Result<PlayerState> {
        let mut operation = self.operation()?;
        let state = operation.poll();
        // The sampled state and DB write share the restore coordinator's lifetime.
        if persist
            && state.ready
            && let Some(id) = operation.current_media()
        {
            let db = lock(database)?;
            if let Ok(mut media) = db.media(&id) {
                media.duration_ms = state.duration_ms;
                media.last_position_ms = state.position_ms;
                if media.audio_stream_index.is_none() {
                    media.audio_stream_index = state
                        .tracks
                        .iter()
                        .find(|track| track.kind == "audio" && track.selected && !track.external)
                        .and_then(|track| track.ff_index);
                }
                db.put_media(&media)?;
            }
        }
        Ok(state)
    }
}
impl PlaybackOperation<'_> {
    pub(super) fn current_media(&self) -> Option<String> {
        self.session.media_id.clone()
    }
    pub(super) fn attach(&mut self, media_id: String) {
        self.session.media_id = Some(media_id);
    }
    pub(super) fn detach(&mut self) -> Option<String> {
        self.session.media_id.take()
    }
    fn player(&mut self) -> Result<&mut Player> {
        let error =
            self.session.error.clone().unwrap_or_else(|| {
                "Native player is unavailable; prepare the bundled runtime".into()
            });
        self.session.player.as_mut().context(error)
    }
    fn optional_player(&mut self) -> Option<&mut Player> {
        self.session.player.as_mut()
    }
    pub(super) fn set_error(&mut self, message: String) {
        self.session.error = Some(message);
    }
    pub(super) fn control(&mut self, request: &Control) -> Result<()> {
        self.player()?.control(request)
    }
    pub(super) fn select_audio_stream(&mut self, index: u32) -> Result<()> {
        self.player()?.select_audio_stream(index)
    }
    pub(super) fn selected_audio_stream(&mut self) -> Option<u32> {
        self.optional_player()
            .map(Player::poll)
            .and_then(|state| {
                state
                    .tracks
                    .into_iter()
                    .find(|track| track.kind == "audio" && track.selected && !track.external)
            })
            .and_then(|track| track.ff_index)
    }
    pub(super) fn detach_if_current(&mut self, media_id: &str) -> Result<()> {
        if self.current_media().as_deref() == Some(media_id) {
            for action in ["pause", "hide"] {
                self.control(&Control {
                    action: action.into(),
                    value: None,
                    start_ms: None,
                    end_ms: None,
                    bounds: None,
                    track_kind: None,
                })?;
            }
            self.detach();
        }
        Ok(())
    }
    #[cfg(all(test, windows, feature = "e2e-test"))]
    pub(super) fn subtitle_text(&mut self) -> Option<String> {
        self.optional_player()
            .and_then(|player| player.subtitle_text())
    }
    fn poll(&mut self) -> PlayerState {
        match self.session.player.as_mut() {
            Some(player) => player.poll(),
            None => PlayerState {
                error: self.session.error.clone(),
                ..Default::default()
            },
        }
    }
}

use super::{AppState, err, on_main};
use crate::player::Control;
use anyhow::ensure;
use std::path::Path;
use surtitle_core::SubtitleSegment;
use tauri::Manager;
type IpcResult<T> = std::result::Result<T, String>;

pub async fn load_media(app: tauri::AppHandle, state: AppState, media_id: String) -> IpcResult<()> {
    let state = state.clone();
    on_main(app, move || {
        let mut playback = state.playback.operation()?;
        load_media_locked(&state, &mut playback, &media_id)
    })
    .await
    .map_err(err)
}
pub(super) fn load_media_locked(
    state: &AppState,
    playback: &mut super::playback::PlaybackOperation<'_>,
    media_id: &str,
) -> Result<()> {
    let media = lock(&state.db)?.media(media_id)?;
    {
        playback.player()?.load_selected(
            Path::new(&media.path),
            media.last_position_ms,
            media.audio_stream_index,
        )?;
    }
    playback.attach(media_id.to_owned());
    refresh_current_subtitles_locked(state, playback, media_id)
}
pub(crate) fn refresh_current_subtitles(state: &AppState, media_id: &str) -> Result<()> {
    let mut playback = state.playback.operation()?;
    refresh_current_subtitles_locked(state, &mut playback, media_id)
}
pub(super) fn refresh_current_subtitles_locked(
    state: &AppState,
    playback: &mut super::playback::PlaybackOperation<'_>,
    media_id: &str,
) -> Result<()> {
    if playback.current_media().as_deref() != Some(media_id) {
        return Ok(());
    }
    let mut segments = lock(&state.db)?.list_segments(media_id)?;
    configure_sentence_pause(playback, &segments, state.settings()?.sentence_pause)?;
    if segments.is_empty() {
        return playback.player()?.clear_subtitle();
    }
    for segment in &mut segments {
        if let Some(translation) = segment
            .translation
            .as_deref()
            .filter(|s| !s.trim().is_empty())
        {
            segment.text.push('\n');
            segment.text.push_str(translation);
        }
    }
    // A unique path prevents mpv's subtitle cache from retaining old text.
    let path = state
        .root
        .join("prepared")
        .join(format!("{}.srt", surtitle_core::id()));
    std::fs::write(
        &path,
        surtitle_core::subtitles::format(&segments, false, false),
    )?;
    let result = { playback.player()?.subtitle(&path) };
    // sub-add reads the complete text synchronously; no original user file is removed.
    let _ = std::fs::remove_file(&path);
    result
}
pub fn get_player_state(state: AppState) -> IpcResult<PlayerState> {
    state.player_state().map_err(err)
}
pub(super) fn configure_sentence_pause(
    playback: &mut super::playback::PlaybackOperation<'_>,
    segments: &[SubtitleSegment],
    enabled: bool,
) -> Result<()> {
    let ends = surtitle_core::sentence_ranges(segments)?
        .into_iter()
        .map(|range| range.end_ms)
        .collect();
    playback.player()?.configure_sentence_pause(enabled, ends);
    Ok(())
}
fn source_playback_range(segments: &[SubtitleSegment], ids: &[String]) -> Result<(u64, u64)> {
    let media_id = segments
        .first()
        .map(|cue| cue.media_id.as_str())
        .unwrap_or("");
    let range = surtitle_core::confirmed_cue_range(segments, media_id, ids)?;
    Ok((range.start_ms, range.end_ms))
}

pub async fn play_source_range(
    app: tauri::AppHandle,
    state: AppState,
    media_id: String,
    source_cue_ids: Vec<String>,
) -> IpcResult<()> {
    let state = state.clone();
    on_main(app, move || {
        let mut playback = state.playback.operation()?;
        ensure!(
            playback.current_media().as_deref() == Some(&media_id),
            "Open this media before playing its source"
        );
        let segments = lock(&state.db)?.list_segments(&media_id)?;
        let (start, end) = source_playback_range(&segments, &source_cue_ids)?;
        let player = playback.player()?;
        let snapshot = player.poll();
        ensure!(
            snapshot.ready,
            "Wait for the media player to finish loading"
        );
        let range = surtitle_core::replay_range(
            start,
            end,
            snapshot.duration_ms,
            state.settings()?.replay_context_ms,
        )?;
        player.control(&Control {
            action: "seek".into(),
            value: None,
            start_ms: Some(range.start_ms),
            end_ms: Some(range.end_ms),
            bounds: None,
            track_kind: None,
        })
    })
    .await
    .map_err(err)
}
pub async fn player_control(
    app: tauri::AppHandle,
    state: AppState,
    mut request: Control,
) -> IpcResult<()> {
    let state = state.clone();
    let handle = app.clone();
    on_main(app, move || {
        let mut playback = state.playback.operation()?;
        if request.action == "sentence-pause" {
            ensure!(
                matches!(request.value, Some(v) if v == 0. || v == 1.),
                "Invalid sentence pause setting"
            );
            let enabled = request.value == Some(1.);
            let media_id = playback.current_media();
            let segments = media_id
                .as_deref()
                .map(|id| lock(&state.db)?.list_segments(id))
                .transpose()?
                .unwrap_or_default();
            // Patch one preference; a player toggle must not save a stale settings form.
            {
                state.preferences.update(|preferences| {
                    preferences.settings.sentence_pause = enabled;
                    Ok(())
                })?;
            }
            configure_sentence_pause(&mut playback, &segments, enabled)?;
            return Ok(());
        }
        if request.action == "fullscreen" {
            let window = handle
                .get_webview_window("main")
                .context("window not found")?;
            window.set_fullscreen(
                request
                    .value
                    .map(|v| v != 0.)
                    .unwrap_or(!window.is_fullscreen()?),
            )?;
            return Ok(());
        }
        let player = playback.player()?;
        let selection =
            if request.action == "track" && request.track_kind.as_deref() == Some("audio") {
                let id = request.value.context("missing track")?;
                ensure!(id.fract() == 0., "invalid track");
                Some(
                    player
                        .poll()
                        .tracks
                        .into_iter()
                        .find(|t| t.kind == "audio" && t.id as f64 == id && !t.external)
                        .and_then(|t| t.ff_index)
                        .context("This audio track cannot be extracted")?,
                )
            } else {
                None
            };
        if matches!(request.action.as_str(), "source-seek" | "source-loop") {
            if let (Some(start), Some(end)) = (request.start_ms, request.end_ms) {
                let snapshot = player.poll();
                ensure!(
                    snapshot.ready,
                    "Wait for the media player to finish loading"
                );
                let range = surtitle_core::replay_range(
                    start,
                    end,
                    snapshot.duration_ms,
                    state.settings()?.replay_context_ms,
                )?;
                request.start_ms = Some(range.start_ms);
                request.end_ms = Some(range.end_ms);
            } else {
                ensure!(
                    request.action == "source-loop"
                        && request.start_ms.is_none()
                        && request.end_ms.is_none(),
                    "Select a complete source range"
                );
            }
            request.action = request.action.trim_start_matches("source-").into();
        }
        player.control(&request)?;
        if let Some(index) = selection
            && let Some(id) = playback.current_media()
        {
            let db = lock(&state.db)?;
            let mut media = db.media(&id)?;
            media.audio_stream_index = Some(index);
            db.put_media(&media)?;
        }
        Ok(())
    })
    .await
    .map_err(err)
}
pub async fn play_card_audio(
    app: tauri::AppHandle,
    state: AppState,
    card_id: String,
) -> IpcResult<()> {
    let state = state.clone();
    on_main(app, move || {
        let mut playback = state.playback.operation()?;
        let card = lock(&state.db)?.card(&card_id)?;
        let path = card
            .audio_path
            .context("card audio is missing; text review is still available")?;
        let player = playback.player()?;
        player.load(Path::new(&path))?;
        player.control(&Control {
            action: "play".into(),
            value: None,
            start_ms: None,
            end_ms: None,
            bounds: None,
            track_kind: None,
        })?;
        playback.detach();
        Ok(())
    })
    .await
    .map_err(err)
}
/// The caller already validated/materialized the portable archive. Neither this
/// operation nor player reconciliation imports any operational settings or costs.
pub(super) fn restore_learning_archive(
    state: &AppState,
    archive: &surtitle_core::LearningArchive,
) -> Result<()> {
    surtitle_core::transfer::validate(archive)?;
    let mut playback = state.playback.operation()?;
    if let Some(player) = playback.optional_player() {
        player.stop()?;
    }
    let previous = playback.detach();
    let backup = state
        .root
        .join("backups")
        .join(format!("before-restore-{}.sqlite", surtitle_core::id()));
    let restored = lock(&state.db)?.restore(archive, &backup);
    if restored.is_ok() {
        state.preferences.update(|preferences| {
            preferences.ai_continuations.clear();
            Ok(())
        })?;
    }
    // On a transaction/backup failure the old database is intact; reopen its
    // retained current item too, so a failed restore does not strand the player.
    let can_reopen = previous.as_deref().filter(|id| {
        lock(&state.db)
            .and_then(|db| db.media(id))
            .is_ok_and(|media| Path::new(&media.path).is_file())
    });
    if let Some(id) = can_reopen {
        if let Err(error) = load_media_locked(state, &mut playback, id) {
            playback.detach();
            if let Some(player) = playback.optional_player() {
                player.stop()?;
                player.hide();
                player.set_error(error.to_string());
            }
            // Database replacement remains committed even if playback fails.
            // Its missing/error state is exposed without undoing restored data.
            playback.set_error(error.to_string());
        }
    } else if let Some(player) = playback.optional_player() {
        player.hide();
    }
    restored
}

#[cfg(test)]
mod source_playback_tests {
    use super::*;
    use surtitle_core::AppSettings;
    fn cue(id: &str, start_ms: u64, end_ms: u64) -> SubtitleSegment {
        SubtitleSegment {
            id: id.into(),
            media_id: "media".into(),
            start_ms,
            end_ms,
            text: "Source sentence".into(),
            translation: None,
            status: "confirmed".into(),
            review_issues: vec![],
        }
    }
    fn ids(values: &[&str]) -> Vec<String> {
        values.iter().map(|id| (*id).into()).collect()
    }
    #[test]
    fn source_range_uses_every_adjacent_cue_and_rejects_missing_reordered_or_unconfirmed_source() {
        let mut cues = vec![
            cue("a", 100, 1100),
            cue("b", 1000, 2000),
            cue("c", 2200, 3000),
        ];
        assert_eq!(
            source_playback_range(&cues, &ids(&["a", "b"])).unwrap(),
            (100, 2000)
        );
        assert_eq!(
            source_playback_range(&cues, &ids(&["b"])).unwrap(),
            (1000, 2000)
        );
        for source in [&[][..], &["a", "c"], &["b", "a"], &["a", "a"], &["missing"]] {
            assert!(source_playback_range(&cues, &ids(source)).is_err());
        }
        cues[1].status = "provisional".into();
        assert!(source_playback_range(&cues, &ids(&["a", "b"])).is_err());
        cues[1].status = "confirmed".into();
        cues[1].media_id = "other".into();
        assert!(source_playback_range(&cues, &ids(&["a", "b"])).is_err());
        assert!(source_playback_range(&[cue("a", 0, 180_001)], &ids(&["a"])).is_err());
    }
    #[test]
    fn sentence_pause_is_opt_in_and_round_trips_without_replacing_other_preferences() {
        let mut old = serde_json::to_value(AppSettings::default()).unwrap();
        old.as_object_mut().unwrap().remove("sentencePause");
        let mut settings: AppSettings = serde_json::from_value(old).unwrap();
        assert!(!settings.sentence_pause);
        settings.vertex_project = "retained-project".into();
        settings.sentence_pause = true;
        let settings: AppSettings =
            serde_json::from_str(&serde_json::to_string(&settings).unwrap()).unwrap();
        assert!(settings.sentence_pause);
        assert_eq!(settings.vertex_project, "retained-project");
    }
}
