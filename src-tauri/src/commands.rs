use crate::{
    player::{Control, PlayerState},
    service::*,
};
use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use std::path::Path;
use surtitle_core::{AppSettings, Media, SaveCard, SubtitleSegment};
use tauri::{Emitter, Manager, State};

type IpcResult<T> = std::result::Result<T, String>;
#[path = "commands_transfer_dialog.rs"]
mod transfer_dialog;
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRequest {
    pub kind: String,
    pub path_or_url: String,
    pub title: Option<String>,
    pub learning_language: String,
    pub explanation_language: String,
}

#[tauri::command]
pub fn list_segments(
    state: State<'_, AppState>,
    media_id: String,
) -> IpcResult<Vec<SubtitleSegment>> {
    lock(&state.db)
        .and_then(|db| db.list_segments(&media_id))
        .map_err(err)
}
#[tauri::command]
pub async fn select_media_files() -> IpcResult<Vec<String>> {
    Ok(rfd::AsyncFileDialog::new()
        .add_filter(
            "Video / audio",
            &[
                "mp4", "mkv", "webm", "mov", "avi", "m4v", "mp3", "wav", "flac", "m4a", "ogg",
                "opus",
            ],
        )
        .pick_files()
        .await
        .unwrap_or_default()
        .iter()
        .map(|p| p.path().to_string_lossy().into_owned())
        .collect())
}
#[tauri::command]
pub async fn import_media(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    request: ImportRequest,
) -> IpcResult<()> {
    if request.kind == "url" {
        start_url_import(app, state, request).await?;
        return Ok(());
    }
    let state = state.inner().clone();
    async {
        let (path, source_url, title) = match request.kind.as_str() {
            "local" => (
                check_local_file(Path::new(&request.path_or_url))?,
                None,
                request.title,
            ),
            _ => bail!("invalid import kind"),
        };
        let kind = if ["mp3", "wav", "flac", "m4a", "ogg", "opus"]
            .iter()
            .any(|e| {
                path.extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case(e))
            }) {
            "audio"
        } else {
            "video"
        };
        let media = Media {
            id: surtitle_core::id(),
            title: title.filter(|t| !t.trim().is_empty()).unwrap_or_else(|| {
                path.file_stem()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned()
            }),
            path: path.to_string_lossy().into_owned(),
            source_url,
            kind: kind.into(),
            duration_ms: 0,
            learning_language: request.learning_language,
            explanation_language: request.explanation_language,
            created_at: surtitle_core::now(),
            last_position_ms: 0,
            audio_stream_index: None,
            subtitle_stream_index: None,
            segment_count: 0,
            card_count: 0,
            status: "ready".into(),
            error: None,
        };
        lock(&state.db)?.put_media(&media)?;
        Ok(())
    }
    .await
    .map_err(err)
}
#[tauri::command]
pub async fn start_url_import(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    request: ImportRequest,
) -> IpcResult<String> {
    let state = state.inner().clone();
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
                let (path, title) =
                    crate::tool_commands::download_url(&state, &request.path_or_url, &job).await?;
                let kind = if path.extension().is_some_and(|ext| {
                    ["mp3", "wav", "flac", "m4a", "ogg", "opus"]
                        .iter()
                        .any(|e| ext.eq_ignore_ascii_case(e))
                }) {
                    "audio"
                } else {
                    "video"
                };
                let media = Media {
                    id: surtitle_core::id(),
                    title: request
                        .title
                        .filter(|t| !t.trim().is_empty())
                        .unwrap_or(title),
                    path: path.to_string_lossy().into_owned(),
                    source_url: Some(request.path_or_url),
                    kind: kind.into(),
                    duration_ms: 0,
                    learning_language: request.learning_language,
                    explanation_language: request.explanation_language,
                    created_at: surtitle_core::now(),
                    last_position_ms: 0,
                    segment_count: 0,
                    card_count: 0,
                    status: "ready".into(),
                    error: None,
                    audio_stream_index: None,
                    subtitle_stream_index: None,
                };
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
#[tauri::command]
pub async fn relink_media(state: State<'_, AppState>, media_id: String) -> IpcResult<()> {
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
#[tauri::command]
pub async fn load_media(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    media_id: String,
) -> IpcResult<()> {
    let state = state.inner().clone();
    on_main(app, move || {
        let _playback = lock(&state.playback)?;
        load_media_locked(&state, &media_id)
    })
    .await
    .map_err(err)
}
fn load_media_locked(state: &AppState, media_id: &str) -> Result<()> {
    let media = lock(&state.db)?.media(media_id)?;
    {
        let mut guard = lock(&state.player)?;
        state.require_player(&mut guard)?.load_selected(
            Path::new(&media.path),
            media.last_position_ms,
            media.audio_stream_index,
        )?;
    }
    *lock(&state.playing)? = Some(media_id.to_owned());
    refresh_current_subtitles_locked(state, media_id)
}
pub(crate) fn refresh_current_subtitles(state: &AppState, media_id: &str) -> Result<()> {
    let _playback = lock(&state.playback)?;
    refresh_current_subtitles_locked(state, media_id)
}
fn refresh_current_subtitles_locked(state: &AppState, media_id: &str) -> Result<()> {
    if lock(&state.playing)?.as_deref() != Some(media_id) {
        return Ok(());
    }
    let mut segments = lock(&state.db)?.list_segments(media_id)?;
    configure_sentence_pause(state, &segments, state.settings()?.sentence_pause)?;
    if segments.is_empty() {
        let mut guard = lock(&state.player)?;
        return state.require_player(&mut guard)?.clear_subtitle();
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
    let result = {
        let mut guard = lock(&state.player)?;
        state.require_player(&mut guard)?.subtitle(&path)
    };
    // sub-add reads the complete text synchronously; no original user file is removed.
    let _ = std::fs::remove_file(&path);
    result
}
#[tauri::command]
pub fn get_player_state(state: State<'_, AppState>) -> IpcResult<PlayerState> {
    state.player_state().map_err(err)
}
fn configure_sentence_pause(
    state: &AppState,
    segments: &[SubtitleSegment],
    enabled: bool,
) -> Result<()> {
    let ends = surtitle_core::sentence_ranges(segments)?
        .into_iter()
        .map(|range| range.end_ms)
        .collect();
    let mut guard = lock(&state.player)?;
    state
        .require_player(&mut guard)?
        .configure_sentence_pause(enabled, ends);
    Ok(())
}
fn source_playback_range(segments: &[SubtitleSegment], ids: &[String]) -> Result<(u64, u64)> {
    ensure!(
        !ids.is_empty() && ids.len() <= 64,
        "Choose the source subtitles to play"
    );
    let first = segments
        .iter()
        .position(|cue| cue.id == ids[0])
        .context("Source subtitle is missing")?;
    let cues = segments
        .get(first..first + ids.len())
        .context("Source subtitles are no longer adjacent")?;
    ensure!(
        cues.iter().zip(ids).all(|(cue, id)| cue.id == *id
            && cue.status == "confirmed"
            && cue.media_id == cues[0].media_id),
        "Source subtitles must be confirmed, ordered and adjacent"
    );
    let start = cues[0].start_ms;
    let end = cues
        .iter()
        .map(|cue| cue.end_ms)
        .max()
        .context("Source subtitle is missing")?;
    ensure!(
        end > start && end - start <= 180_000,
        "Source playback must be at most 180 seconds"
    );
    Ok((start, end))
}
#[cfg(test)]
mod source_playback_tests {
    use super::*;
    fn cue(id: &str, start_ms: u64, end_ms: u64) -> SubtitleSegment {
        SubtitleSegment {
            id: id.into(),
            media_id: "media".into(),
            start_ms,
            end_ms,
            text: "Source sentence".into(),
            translation: None,
            status: "confirmed".into(),
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
#[tauri::command]
pub async fn play_source_range(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    media_id: String,
    source_cue_ids: Vec<String>,
) -> IpcResult<()> {
    let state = state.inner().clone();
    on_main(app, move || {
        let _playback = lock(&state.playback)?;
        ensure!(
            lock(&state.playing)?.as_deref() == Some(&media_id),
            "Open this media before playing its source"
        );
        let segments = lock(&state.db)?.list_segments(&media_id)?;
        let (start, end) = source_playback_range(&segments, &source_cue_ids)?;
        let mut guard = lock(&state.player)?;
        let player = state.require_player(&mut guard)?;
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
#[tauri::command]
pub async fn player_control(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    mut request: Control,
) -> IpcResult<()> {
    let state = state.inner().clone();
    let handle = app.clone();
    on_main(app, move || {
        let _playback = lock(&state.playback)?;
        if request.action == "sentence-pause" {
            ensure!(
                matches!(request.value, Some(v) if v == 0. || v == 1.),
                "Invalid sentence pause setting"
            );
            let enabled = request.value == Some(1.);
            let media_id = lock(&state.playing)?.clone();
            let segments = media_id
                .as_deref()
                .map(|id| lock(&state.db)?.list_segments(id))
                .transpose()?
                .unwrap_or_default();
            // Patch one preference; a player toggle must not save a stale settings form.
            {
                let mut preferences = lock(&state.preferences)?;
                let mut next = preferences.clone();
                next.settings.sentence_pause = enabled;
                state.save_preferences(&next)?;
                *preferences = next;
            }
            configure_sentence_pause(&state, &segments, enabled)?;
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
        let mut guard = lock(&state.player)?;
        let player = state.require_player(&mut guard)?;
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
        drop(guard);
        if let Some(index) = selection
            && let Some(id) = lock(&state.playing)?.clone()
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
#[tauri::command]
pub async fn import_subtitles(
    state: State<'_, AppState>,
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
        let _playback = lock(&state.playback)?;
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
        refresh_current_subtitles_locked(&state, &media_id)
    })()
    .map_err(err)
}
#[tauri::command]
pub fn edit_segment(state: State<'_, AppState>, segment: SubtitleSegment) -> IpcResult<()> {
    (|| {
        let _playback = lock(&state.playback)?;
        lock(&state.db)?.edit_segment(&segment)?;
        refresh_current_subtitles_locked(&state, &segment.media_id)
    })()
    .map_err(err)
}
#[tauri::command]
pub async fn save_card(state: State<'_, AppState>, request: SaveCard) -> IpcResult<()> {
    let state = state.inner().clone();
    async {
        crate::tool_commands::ensure_audio_stream(&state, &request.media_id).await?;
        let (media, source_cues) = {
            let db = lock(&state.db)?;
            (db.media(&request.media_id)?, db.card_source_cues(&request)?)
        };
        let mut segment = source_cues[0].clone();
        segment.end_ms = source_cues
            .iter()
            .map(|cue| cue.end_ms)
            .max()
            .context("missing card source")?;
        let clip_range = surtitle_core::replay_range(
            segment.start_ms,
            segment.end_ms,
            media.duration_ms,
            state.settings()?.replay_context_ms,
        )?;
        // FFmpeg is a first-use dependency. Failure leaves no partially saved card.
        let audio =
            crate::tool_commands::extract_card_audio(&state, &media, &segment, clip_range).await?;
        let db = lock(&state.db)?;
        let current = db.card_source_cues(&request);
        let current_media = db.media(&media.id)?;
        let unchanged = current.is_ok_and(|cues| {
            serde_json::to_value(&cues).ok() == serde_json::to_value(&source_cues).ok()
        }) && current_media.path == media.path
            && current_media.audio_stream_index == media.audio_stream_index;
        if !unchanged {
            let _ = std::fs::remove_file(audio);
            bail!("The subtitle or media changed while preparing card audio. Save it again.");
        }
        let saved = db.save_card_with_audio_range(
            &request,
            Some(audio.to_string_lossy().into_owned()),
            Some(clip_range),
        );
        if saved.is_err() {
            let _ = std::fs::remove_file(&audio);
        }
        saved?;
        Ok(())
    }
    .await
    .map_err(err)
}
#[tauri::command]
pub fn rate_card(state: State<'_, AppState>, card_id: String, rating: String) -> IpcResult<()> {
    (|| {
        let retention = state.settings()?.retention;
        lock(&state.db)?.rate_card(&card_id, &rating, retention, chrono::Utc::now())?;
        Ok(())
    })()
    .map_err(err)
}
#[tauri::command]
pub fn edit_card(state: State<'_, AppState>, request: surtitle_core::EditCard) -> IpcResult<()> {
    lock(&state.db)
        .and_then(|db| db.edit_card(&request).map(|_| ()))
        .map_err(err)
}
#[tauri::command]
pub fn suspend_card(state: State<'_, AppState>, card_id: String, suspended: bool) -> IpcResult<()> {
    lock(&state.db)
        .and_then(|db| db.suspend_card(&card_id, suspended))
        .map_err(err)
}
#[tauri::command]
pub fn delete_card(state: State<'_, AppState>, card_id: String) -> IpcResult<()> {
    // Removing a card never mutates another card's preserved clip. Orphan clip
    // reclamation is deliberately separate from deleting learning records.
    lock(&state.db)
        .and_then(|db| db.delete_card(&card_id).map(|_| ()))
        .map_err(err)
}
#[tauri::command]
pub async fn remove_media(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    media_id: String,
) -> IpcResult<()> {
    let state = state.inner().clone();
    on_main(app, move || {
        let _playback = lock(&state.playback)?;
        if lock(&state.playing)?.as_deref() == Some(&media_id) {
            let mut guard = lock(&state.player)?;
            let player = state.require_player(&mut guard)?;
            player.control(&Control {
                action: "pause".into(),
                value: None,
                start_ms: None,
                end_ms: None,
                bounds: None,
                track_kind: None,
            })?;
            player.control(&Control {
                action: "hide".into(),
                value: None,
                start_ms: None,
                end_ms: None,
                bounds: None,
                track_kind: None,
            })?;
            *lock(&state.playing)? = None;
        }
        lock(&state.db)?.remove_media(&media_id)
    })
    .await
    .map_err(err)
}
#[tauri::command]
pub fn list_subtitle_versions(
    state: State<'_, AppState>,
    media_id: String,
) -> IpcResult<Vec<surtitle_core::SubtitleVersion>> {
    lock(&state.db)
        .and_then(|db| db.subtitle_versions(&media_id))
        .map_err(err)
}
#[tauri::command]
pub fn restore_subtitle_version(
    state: State<'_, AppState>,
    media_id: String,
    version_id: String,
) -> IpcResult<()> {
    (|| {
        let _playback = lock(&state.playback)?;
        lock(&state.db)?.restore_subtitle_version(&media_id, &version_id)?;
        refresh_current_subtitles_locked(&state, &media_id)
    })()
    .map_err(err)
}
#[tauri::command]
pub async fn play_card_audio(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    card_id: String,
) -> IpcResult<()> {
    let state = state.inner().clone();
    on_main(app, move || {
        let _playback = lock(&state.playback)?;
        let card = lock(&state.db)?.card(&card_id)?;
        let path = card
            .audio_path
            .context("card audio is missing; text review is still available")?;
        let mut guard = lock(&state.player)?;
        let player = state.require_player(&mut guard)?;
        player.load(Path::new(&path))?;
        player.control(&Control {
            action: "play".into(),
            value: None,
            start_ms: None,
            end_ms: None,
            bounds: None,
            track_kind: None,
        })?;
        *lock(&state.playing)? = None;
        Ok(())
    })
    .await
    .map_err(err)
}
#[tauri::command]
pub fn update_settings(state: State<'_, AppState>, settings: AppSettings) -> IpcResult<()> {
    (|| {
        ensure!(
            ["dark", "light", "system"].contains(&settings.theme.as_str())
                && ["ja", "en"].contains(&settings.locale.as_str()),
            "invalid settings"
        );
        ensure!(
            settings.daily_budget_usd.is_finite()
                && (0.0..=1000.).contains(&settings.daily_budget_usd),
            "invalid budget"
        );
        ensure!(
            (0.7..=0.97).contains(&settings.retention),
            "invalid retention"
        );
        ensure!(
            settings.replay_context_ms <= 1000,
            "Playback context must be between 0 and 1000 ms"
        );
        ensure!(
            !settings.learning_language.is_empty() && !settings.explanation_language.is_empty(),
            "language is required"
        );
        crate::model_commands::validate_settings(&settings)?;
        ensure!(
            ["nightly", "stable"].contains(&settings.yt_dlp_channel.as_str()),
            "invalid yt-dlp channel"
        );
        let cap = (settings.daily_budget_usd * 1_000_000.).floor() as u64;
        state.ai.set_budget(surtitle_ai::BudgetLimits {
            per_job_microusd: cap,
            daily_microusd: cap,
            monthly_microusd: cap,
        })?;
        let mut p = lock(&state.preferences)?;
        p.settings = settings;
        state.save_preferences(&p)?;
        drop(p);
        let _playback = lock(&state.playback)?;
        let media_id = lock(&state.playing)?.clone();
        if let Some(media_id) = media_id {
            let segments = lock(&state.db)?.list_segments(&media_id)?;
            configure_sentence_pause(&state, &segments, state.settings()?.sentence_pause)?;
        }
        Ok(())
    })()
    .map_err(err)
}
#[tauri::command]
pub async fn export_learning(
    state: State<'_, AppState>,
    format: String,
    media_id: Option<String>,
) -> IpcResult<String> {
    ensure_export_format(&format).map_err(err)?;
    let Some(path) = transfer_dialog::export_path(&state, &format)
        .await
        .map_err(err)?
    else {
        return Ok(String::new());
    };
    (|| {
        let db = lock(&state.db)?;
        let archive = db.archive()?;
        let path = path.as_path();
        match format.as_str() {
            "json" => surtitle_core::transfer::export_json(&archive, path)?,
            "zip" => {
                surtitle_core::transfer::export_zip(&archive, &state.root.join("card-audio"), path)?
            }
            "csv" | "tsv" => std::fs::write(
                path,
                surtitle_core::transfer::export_delimited(
                    &archive.cards,
                    if format == "csv" { ',' } else { '\t' },
                ),
            )?,
            "srt" | "vtt" => {
                let media_id = media_id.context("select a media item for subtitle export")?;
                let segments = db.list_segments(&media_id)?;
                let translated = if segments.iter().any(|s| s.translation.is_some()) {
                    let stem = path.file_stem().unwrap_or_default().to_string_lossy();
                    let translated = path.with_file_name(format!("{stem}.translation.{format}"));
                    ensure!(
                        !translated.exists(),
                        "translation output already exists; choose a different filename"
                    );
                    Some(translated)
                } else {
                    None
                };
                // Validate both destinations before modifying the chosen original output.
                std::fs::write(
                    path,
                    surtitle_core::subtitles::format(&segments, format == "vtt", false),
                )?;
                if let Some(translated) = translated {
                    std::fs::write(
                        &translated,
                        surtitle_core::subtitles::format(&segments, format == "vtt", true),
                    )?;
                }
            }
            _ => bail!("invalid export format"),
        };
        Ok(path.to_string_lossy().into_owned())
    })()
    .map_err(err)
}
fn ensure_export_format(format: &str) -> Result<()> {
    ensure!(
        ["json", "zip", "csv", "tsv", "srt", "vtt"].contains(&format),
        "invalid export format"
    );
    Ok(())
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestorePreview {
    token: String,
    media_count: usize,
    card_count: usize,
    review_count: usize,
    audio_count: usize,
    warnings: Vec<String>,
}
#[tauri::command]
pub async fn preview_restore(state: State<'_, AppState>) -> IpcResult<Option<RestorePreview>> {
    let Some(path) = transfer_dialog::restore_path(&state).await.map_err(err)? else {
        return Ok(None);
    };
    preview_restore_at(&state, &path).map(Some).map_err(err)
}
fn preview_restore_at(state: &AppState, path: &Path) -> Result<RestorePreview> {
    // Keep one current preview plus at most one serialized incoming snapshot.
    // A rejected file leaves the previously displayed preview usable.
    let mut restores = lock(&state.restores)?;
    let snapshot = crate::restore_snapshot::RestoreSnapshot::capture(&state.root, path)?;
    let archive = surtitle_core::transfer::read_archive(snapshot.path())?;
    snapshot.verify_snapshot()?;
    restores.clear();
    let token = surtitle_core::id();
    let warnings = if state.settings()?.locale == "en" {
        vec![
                "Current learning data will be replaced after creating a backup. Cost ledgers, credentials, execution approvals, and tool settings are not imported.".into(),
                "Media files that have moved must be selected again.".into(),
            ]
    } else {
        vec![
                "現在の学習データを置換し、直前のバックアップを作成します。費用台帳・鍵・実行承認・ツール設定はインポートしません。".into(),
                "移動した教材はファイルの再指定が必要です。".into(),
            ]
    };
    let result = RestorePreview {
        token: token.clone(),
        media_count: archive.media.len(),
        card_count: archive.cards.len(),
        review_count: archive.reviews.len(),
        audio_count: archive
            .cards
            .iter()
            .filter(|c| c.audio_path.is_some())
            .count(),
        warnings,
    };
    restores.insert(token, RestorePlan { snapshot, archive });
    Ok(result)
}
#[tauri::command]
pub fn discard_restore_preview(state: State<'_, AppState>, token: String) -> IpcResult<()> {
    lock(&state.restores)
        .map(|mut plans| {
            plans.remove(&token);
        })
        .map_err(err)
}
#[tauri::command]
pub async fn restore_learning(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    token: String,
) -> IpcResult<()> {
    let state = state.inner().clone();
    let archive = take_restore_archive(&state, &token).map_err(err)?;
    on_main(app, move || restore_learning_archive(&state, &archive))
        .await
        .map_err(err)
}
fn take_restore_archive(state: &AppState, token: &str) -> Result<surtitle_core::LearningArchive> {
    let plan = take_restore_plan(state, token)?;
    materialize_restore_plan(state, plan)
}
fn take_restore_plan(state: &AppState, token: &str) -> Result<RestorePlan> {
    let plan = lock(&state.restores)?
        .remove(token)
        .context("restore preview expired")?;
    plan.snapshot.verify_original()?;
    plan.snapshot.verify_snapshot()?;
    Ok(plan)
}
fn materialize_restore_plan(
    state: &AppState,
    mut plan: RestorePlan,
) -> Result<surtitle_core::LearningArchive> {
    surtitle_core::transfer::materialize_audio(
        plan.snapshot.path(),
        &mut plan.archive,
        &state.root.join("card-audio"),
    )?;
    Ok(plan.archive)
}

/// The caller already validated/materialized the portable archive. Neither this
/// operation nor player reconciliation imports any operational settings or costs.
fn restore_learning_archive(
    state: &AppState,
    archive: &surtitle_core::LearningArchive,
) -> Result<()> {
    surtitle_core::transfer::validate(archive)?;
    let _playback = lock(&state.playback)?;
    if let Some(player) = lock(&state.player)?.as_mut() {
        player.stop()?;
    }
    let previous = lock(&state.playing)?.take();
    let backup = state
        .root
        .join("backups")
        .join(format!("before-restore-{}.sqlite", surtitle_core::id()));
    let restored = lock(&state.db)?.restore(archive, &backup);
    // On a transaction/backup failure the old database is intact; reopen its
    // retained current item too, so a failed restore does not strand the player.
    let can_reopen = previous.as_deref().filter(|id| {
        lock(&state.db)
            .and_then(|db| db.media(id))
            .is_ok_and(|media| Path::new(&media.path).is_file())
    });
    if let Some(id) = can_reopen {
        if let Err(error) = load_media_locked(state, id) {
            *lock(&state.playing)? = None;
            if let Some(player) = lock(&state.player)?.as_mut() {
                player.stop()?;
                player.hide();
                player.set_error(error.to_string());
            }
            // Database replacement remains committed even if playback fails.
            // Its missing/error state is exposed without undoing restored data.
            *lock(&state.player_error)? = Some(error.to_string());
        }
    } else if let Some(player) = lock(&state.player)?.as_mut() {
        player.hide();
    }
    restored
}

#[cfg(test)]
#[path = "commands_restore_tests.rs"]
mod restore_tests;
