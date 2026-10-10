use super::tool_runtime::{channel, selection};
use crate::application::*;
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    time::Duration,
};
use surtitle_tools::*;
mod card_audio;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaStream {
    pub index: u32,
    pub kind: String,
    pub codec: String,
    pub language: Option<String>,
    pub title: Option<String>,
    pub is_default: bool,
    pub supported_text: bool,
}
fn parse_streams(json: &str) -> Result<Vec<MediaStream>> {
    let value: serde_json::Value = serde_json::from_str(json)?;
    let streams = value["streams"].as_array().context("No media streams")?;
    ensure!(streams.len() <= 1024, "too many media streams");
    let mut seen = std::collections::HashSet::new();
    streams
        .iter()
        .map(|s| {
            let index = u32::try_from(s["index"].as_u64().context("invalid stream index")?)?;
            ensure!(seen.insert(index), "duplicate stream index");
            let codec = s["codec_name"].as_str().unwrap_or_default().to_owned();
            Ok(MediaStream {
                index,
                kind: s["codec_type"].as_str().unwrap_or_default().into(),
                supported_text: ["subrip", "webvtt", "ass", "ssa", "mov_text", "text"]
                    .contains(&codec.as_str()),
                codec,
                language: s["tags"]["language"].as_str().map(str::to_owned),
                title: s["tags"]["title"].as_str().map(str::to_owned),
                is_default: s["disposition"]["default"] == 1,
            })
        })
        .collect()
}
async fn inspect_streams(snapshot: &ToolSnapshot, path: &Path) -> Result<Vec<MediaStream>> {
    inspect_streams_with_cancel(snapshot, path, &CancellationToken::new()).await
}
async fn inspect_streams_with_cancel(
    snapshot: &ToolSnapshot,
    path: &Path,
    cancel: &CancellationToken,
) -> Result<Vec<MediaStream>> {
    let output = CommandSpec {
        program: snapshot.tool.ffprobe.clone().context("ffprobe missing")?,
        args: ["-v", "error", "-show_streams", "-of", "json"]
            .into_iter()
            .map(OsString::from)
            .chain([path.into()])
            .collect(),
        guards: vec![snapshot.clone()],
    }
    .run(Duration::from_secs(60), cancel)
    .await?;
    ensure!(
        output.code == Some(0),
        "Media stream inspection failed: {}",
        output.stderr
    );
    parse_streams(&output.stdout)
}
pub async fn list_media_streams(
    state: AppState,
    media_id: String,
    operation_id: Option<String>,
) -> std::result::Result<Vec<MediaStream>, String> {
    async {
        let media = lock(&state.db)?.media(&media_id)?;
        let lease = lease_for_media(
            &state,
            &[ToolKind::FfmpegPair],
            &media_id,
            operation_id.as_deref(),
        )
        .await?;
        inspect_streams(lease.get(ToolKind::FfmpegPair)?, Path::new(&media.path)).await
    }
    .await
    .map_err(err)
}
fn choose_audio_stream(streams: &[MediaStream], selected: Option<u32>) -> Result<u32> {
    if let Some(index) = selected {
        ensure!(
            streams
                .iter()
                .any(|s| s.index == index && s.kind == "audio"),
            "Saved audio stream is unavailable; choose another track"
        );
        return Ok(index);
    }
    streams
        .iter()
        .filter(|s| s.kind == "audio")
        .find(|s| s.is_default)
        .or_else(|| streams.iter().find(|s| s.kind == "audio"))
        .map(|s| s.index)
        .context("This media has no audio stream")
}
/// Persist a concrete FFmpeg stream before preparing any immutable audio receipt.
pub(crate) async fn ensure_audio_stream_with_context(
    state: &Services,
    media_id: &str,
    cancel: &CancellationToken,
    parent_id: Option<&str>,
) -> Result<u32> {
    let media = lock(&state.db)?.media(media_id)?;
    let (lease, _) = lease_with_context(
        state,
        &[ToolKind::FfmpegPair],
        cancel,
        parent_id,
        Some(media_id),
    )
    .await?;
    let streams = inspect_streams_with_cancel(
        lease.get(ToolKind::FfmpegPair)?,
        Path::new(&media.path),
        cancel,
    )
    .await?;
    let mut playback = state.playback.operation()?;
    let selected_in_player = if playback.current_media().as_deref() == Some(media_id) {
        playback.selected_audio_stream()
    } else {
        None
    };
    let index = choose_audio_stream(&streams, media.audio_stream_index.or(selected_in_player))?;
    let db = lock(&state.db)?;
    let mut current = db.media(media_id)?;
    ensure!(
        current.path == media.path && current.audio_stream_index == media.audio_stream_index,
        "Audio selection changed while inspecting the media"
    );
    current.audio_stream_index = Some(index);
    db.put_media(&current)?;
    Ok(index)
}
pub async fn select_audio_stream(
    app: tauri::AppHandle,
    state: AppState,
    media_id: String,
    stream_index: u32,
    operation_id: Option<String>,
) -> std::result::Result<(), String> {
    let state = state.clone();
    async {
        let media = lock(&state.db)?.media(&media_id)?;
        let lease = lease_for_media(
            &state,
            &[ToolKind::FfmpegPair],
            &media_id,
            operation_id.as_deref(),
        )
        .await?;
        choose_audio_stream(
            &inspect_streams(lease.get(ToolKind::FfmpegPair)?, Path::new(&media.path)).await?,
            Some(stream_index),
        )?;
        on_main(app, move || {
            let mut playback = state.playback.operation()?;
            let db = lock(&state.db)?;
            let mut current = db.media(&media_id)?;
            ensure!(
                current.path == media.path,
                "Media changed during stream selection"
            );
            if playback.current_media().as_deref() == Some(&media_id) {
                playback.select_audio_stream(stream_index)?;
            }
            current.audio_stream_index = Some(stream_index);
            db.put_media(&current)
        })
        .await
    }
    .await
    .map_err(err)
}

pub async fn extract_embedded_subtitles(
    state: AppState,
    media_id: String,
    stream_index: u32,
    replace_existing: Option<bool>,
    operation_id: Option<String>,
) -> std::result::Result<(), String> {
    async {
        let media = lock(&state.db)?.media(&media_id)?;
        let previous = serde_json::to_vec(&lock(&state.db)?.list_segments(&media_id)?)?;
        let replace = replace_existing.unwrap_or(false);
        ensure!(replace || lock(&state.db)?.list_segments(&media_id)?.is_empty(), "Confirm replacement of the current subtitles; their previous version will be preserved");
        let lease = lease_for_media(&state, &[ToolKind::FfmpegPair], &media_id, operation_id.as_deref()).await?;
        let snapshot = lease.get(ToolKind::FfmpegPair)?;
        let streams = inspect_streams(snapshot, Path::new(&media.path)).await?;
        ensure!(streams.iter().any(|s| s.index == stream_index && s.kind == "subtitle" && s.supported_text), "Choose an embedded text subtitle stream; image subtitles require OCR and are unsupported");
        let temporary = TemporaryOutput(state.root.join("prepared").join(format!("{}.srt", surtitle_core::id())));
        let output = CommandSpec { program: snapshot.tool.executable.clone(), args: vec!["-nostdin".into(), "-v".into(), "error".into(), "-n".into(), "-i".into(), media.path.clone().into(), "-map".into(), format!("0:{stream_index}").into(), "-f".into(), "srt".into(), temporary.0.clone().into_os_string()], guards: vec![snapshot.clone()] }.run(Duration::from_secs(300), &CancellationToken::new()).await?;
        ensure!(output.code == Some(0), "Subtitle extraction failed: {}", output.stderr);
        ensure!(temporary.0.metadata()?.len() <= 64 * 1024 * 1024, "subtitle output is too large");
        let segments = surtitle_core::subtitles::parse(&std::fs::read_to_string(&temporary.0)?, &media_id)?;
        {
            let mut db = lock(&state.db)?;
            ensure!(db.media(&media_id)?.path == media.path && serde_json::to_vec(&db.list_segments(&media_id)?)? == previous, "Media or subtitles changed during extraction; nothing was replaced");
            db.replace_subtitles(&media_id, &segments, Some(stream_index), replace, "Before importing embedded subtitles")?;
        }
        crate::application::playback::refresh_current_subtitles(&state, &media_id)
    }.await.map_err(err)
}
struct TemporaryOutput(PathBuf);
impl Drop for TemporaryOutput {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}
#[cfg(test)]
mod stream_tests {
    use super::super::download::transfer::download_url;
    use super::*;
    #[tokio::test]
    async fn automatic_setup_keeps_local_parent_and_media_context_on_failure() {
        let root = tempfile::tempdir().unwrap();
        let state =
            Services::open_with_tool_path(root.path().join("data"), std::ffi::OsStr::new(""))
                .unwrap();
        let cancel = CancellationToken::new();
        cancel.cancel();
        let result = lease_with_context(
            &state,
            &[ToolKind::FfmpegPair],
            &cancel,
            Some("local:card-save"),
            Some("media"),
        )
        .await;
        assert!(result.is_err());
        let entries = state.operations.list().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].parent_id.as_deref(), Some("local:card-save"));
        assert_eq!(entries[0].media_id.as_deref(), Some("media"));
        assert_eq!(entries[0].tool_id.as_deref(), Some("ffmpeg"));
        assert_eq!(entries[0].status, "cancelled");
    }
    #[test]
    fn tool_receipts_keep_observed_versions_and_refuse_missing_or_changed_identity() {
        let root = tempfile::tempdir().unwrap();
        let state = Services::open(root.path().join("data")).unwrap();
        let path = root.path().join(ToolKind::Deno.executable());
        std::fs::write(&path, b"fixture executable identity").unwrap();
        let mut snapshot =
            ToolSnapshot::capture(resolve_external(ToolKind::Deno, &path).unwrap()).unwrap();
        assert!(persist_tool_receipt(&state, &[snapshot.clone()]).is_err());
        snapshot.probe = Some(ProbeReport {
            kind: ToolKind::Deno,
            version: "deno fixture-version".into(),
            companion_version: None,
            capabilities: vec!["javascript".into()],
            diagnostics: vec![],
        });
        let id = persist_tool_receipt(&state, &[snapshot.clone()]).unwrap();
        let saved_path = state.root.join("prepared").join(format!("tools-{id}.json"));
        let original = std::fs::read(&saved_path).unwrap();
        let saved: ToolUseReceipt = serde_json::from_slice(&original).unwrap();
        assert_eq!(saved.id, id);
        assert_eq!(
            saved.tools[0].probe.as_ref().unwrap().version,
            "deno fixture-version"
        );
        assert_eq!(saved.tools[0].executable_sha256, snapshot.executable_sha256);
        assert_eq!(saved.tools[0].tool.executable, snapshot.tool.executable);
        std::fs::write(&path, b"changed executable identity").unwrap();
        assert!(persist_tool_receipt(&state, &[snapshot]).is_err());
        assert_eq!(std::fs::read(&saved_path).unwrap(), original);
    }
    #[test]
    fn ffmpeg_absolute_indices_are_not_audio_ordinals_or_mpv_ids() {
        let streams = parse_streams(r#"{"streams":[{"index":0,"codec_type":"video","codec_name":"h264"},{"index":1,"codec_type":"audio","codec_name":"aac","tags":{"language":"eng"}},{"index":4,"codec_type":"audio","codec_name":"aac","disposition":{"default":1},"tags":{"language":"jpn"}},{"index":5,"codec_type":"subtitle","codec_name":"hdmv_pgs_subtitle"},{"index":6,"codec_type":"subtitle","codec_name":"ass"}]}"#).unwrap();
        assert_eq!(choose_audio_stream(&streams, None).unwrap(), 4);
        assert_eq!(choose_audio_stream(&streams, Some(1)).unwrap(), 1);
        assert!(choose_audio_stream(&streams, Some(2)).is_err());
        assert!(choose_audio_stream(&streams, Some(0)).is_err());
        assert!(!streams[3].supported_text);
        assert!(streams[4].supported_text);
        assert!(parse_streams(r#"{"streams":[{"index":1},{"index":1}]}"#).is_err());
        assert!(choose_audio_stream(&[], None).is_err());
    }
    #[tokio::test]
    async fn direct_download_success_cancel_and_truncation_cleanup_are_real() {
        use std::io::{Read, Write};
        for mode in ["success", "unknown_length", "cancel", "truncated"] {
            let root = tempfile::tempdir().unwrap();
            let state = Services::open(root.path().to_owned()).unwrap();
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!("http://{}/fixture.wav", listener.local_addr().unwrap());
            let server = std::thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                socket
                    .set_write_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut buffer = [0u8; 4096];
                let _ = socket.read(&mut buffer);
                let length = if mode == "success" { 64 } else { 1024 * 1024 };
                if mode == "unknown_length" {
                    let _ = write!(
                        socket,
                        "HTTP/1.1 200 OK\r\nContent-Type: audio/wav\r\nConnection: close\r\n\r\n"
                    );
                } else {
                    let _ = write!(
                        socket,
                        "HTTP/1.1 200 OK\r\nContent-Type: audio/wav\r\nContent-Length: {length}\r\nConnection: close\r\n\r\n"
                    );
                }
                if mode != "cancel" {
                    let _ = socket.write_all(&[7; 64]);
                } else {
                    for _ in 0..256 {
                        if socket.write_all(&[7; 4096]).is_err() {
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(10));
                    }
                }
            });
            let (id, job) = state
                .downloads
                .start(crate::application::library::ImportRequest {
                    kind: "url".into(),
                    path_or_url: url.clone(),
                    title: None,
                    learning_language: "en".into(),
                    explanation_language: "ja".into(),
                })
                .unwrap();
            let task_state = state.clone();
            let task_job = job.clone();
            let task =
                tokio::spawn(async move { download_url(&task_state, &url, &task_job).await });
            if mode == "cancel" {
                tokio::time::sleep(Duration::from_millis(80)).await;
                state.downloads.cancel(&id).unwrap();
            }
            let result = tokio::time::timeout(Duration::from_secs(8), task)
                .await
                .unwrap()
                .unwrap();
            if matches!(mode, "success" | "unknown_length") {
                assert_eq!(std::fs::read(result.unwrap().0).unwrap(), [7; 64]);
                let snapshot = state.downloads.list().unwrap().remove(0);
                assert_eq!(snapshot.phase, "importing");
                assert_eq!(snapshot.stored_bytes, 64);
                assert_eq!(snapshot.total_bytes_exact, mode == "success");
                assert_eq!(
                    snapshot.total_bytes,
                    if mode == "success" { Some(64) } else { None }
                );
            } else {
                assert!(result.is_err());
            }
            server.join().unwrap();
            assert!(
                !std::fs::read_dir(root.path().join("media"))
                    .unwrap()
                    .any(|entry| entry
                        .unwrap()
                        .file_name()
                        .to_string_lossy()
                        .starts_with(".download-"))
            );
        }
    }
}
async fn lease_for_media(
    state: &Services,
    kinds: &[ToolKind],
    media_id: &str,
    parent_id: Option<&str>,
) -> Result<JobLease> {
    Ok(lease_with_context(
        state,
        kinds,
        &CancellationToken::new(),
        parent_id,
        Some(media_id),
    )
    .await?
    .0)
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToolUseReceipt {
    schema_version: u32,
    id: String,
    created_at: String,
    tools: Vec<ToolSnapshot>,
}
pub(crate) async fn lease_with_context(
    state: &Services,
    kinds: &[ToolKind],
    cancel: &CancellationToken,
    parent_id: Option<&str>,
    media_id: Option<&str>,
) -> Result<(JobLease, String)> {
    let p = state.preferences.read()?.clone();
    let mut selected = Vec::new();
    for k in kinds {
        let s = selection(&p, *k);
        if matches!(s, ToolSelection::Managed) && state.tools.manager.installed(*k)?.is_none() {
            super::tool_runtime::update_managed(
                state,
                *k,
                channel(&p),
                cancel,
                parent_id,
                media_id,
            )
            .await?;
        }
        selected.push((*k, s));
    }
    let mut lease = state.tools.manager.lease_tools(&selected)?;
    for snapshot in &mut lease.tools {
        probe_and_record(snapshot, cancel).await?;
    }
    let id = persist_tool_receipt(state, &lease.tools)?;
    Ok((lease, id))
}
fn persist_tool_receipt(state: &Services, tools: &[ToolSnapshot]) -> Result<String> {
    ensure!(
        !tools.is_empty(),
        "A tool receipt requires at least one tool"
    );
    for snapshot in tools {
        let report = snapshot
            .probe
            .as_ref()
            .context("Tool version has not been observed")?;
        ensure!(
            report.kind == snapshot.tool.kind && !report.version.trim().is_empty(),
            "Invalid tool version evidence"
        );
        ensure!(
            snapshot.tool.ffprobe.is_some() == report.companion_version.is_some(),
            "FFprobe version evidence is incomplete"
        );
        snapshot.verify()?;
    }
    let id = surtitle_core::id();
    let receipt = state.root.join("prepared").join(format!("tools-{id}.json"));
    ensure!(!receipt.exists(), "Tool receipt already exists");
    surtitle_core::store::write_json_atomic(
        &receipt,
        &ToolUseReceipt {
            schema_version: 1,
            id: id.clone(),
            created_at: surtitle_core::now(),
            tools: tools.to_vec(),
        },
    )?;
    Ok(id)
}
pub async fn extract_card_audio(
    state: &Services,
    media: &surtitle_core::Media,
    segment: &surtitle_core::SubtitleSegment,
    range: surtitle_core::AudioClipRange,
    parent_id: Option<&str>,
) -> Result<PathBuf> {
    ensure!(
        surtitle_core::is_usable_subtitle_status(&segment.status) && segment.media_id == media.id,
        "subtitle is not usable"
    );
    ensure!(
        segment.end_ms > segment.start_ms && segment.end_ms - segment.start_ms <= 180_000,
        "card audio must be at most 180 seconds"
    );
    range.validate_source(segment.start_ms, segment.end_ms)?;
    ensure!(
        range.end_ms <= media.duration_ms,
        "Card audio exceeds media duration"
    );
    let lease = lease_for_media(state, &[ToolKind::FfmpegPair], &media.id, parent_id).await?;
    let snapshot = lease.get(ToolKind::FfmpegPair)?;
    let streams = inspect_streams(snapshot, Path::new(&media.path)).await?;
    let index = media
        .audio_stream_index
        .context("Select an audio stream before saving a card")?;
    ensure!(
        streams
            .iter()
            .any(|s| s.index == index && s.kind == "audio"),
        "Selected audio stream is unavailable"
    );
    card_audio::extract(
        snapshot,
        Path::new(&media.path),
        index,
        range,
        &state.root.join("card-audio"),
    )
    .await
}
