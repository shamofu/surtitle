use crate::service::*;
use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    time::Duration,
};
use surtitle_tools::*;
use tauri::State;
#[path = "card_audio.rs"]
mod card_audio;
#[path = "download.rs"]
mod download;
pub use download::{DownloadJob, DownloadJobSnapshot, DownloadManager};

#[tauri::command]
pub fn list_download_jobs(
    state: State<'_, AppState>,
) -> std::result::Result<Vec<DownloadJobSnapshot>, String> {
    state.downloads.list().map_err(err)
}
#[tauri::command]
pub fn cancel_download(
    state: State<'_, AppState>,
    job_id: String,
) -> std::result::Result<(), String> {
    state.downloads.cancel(&job_id).map_err(err)
}

pub fn kind(id: &str) -> Result<ToolKind> {
    match id {
        "ffmpeg" => Ok(ToolKind::FfmpegPair),
        "yt-dlp" => Ok(ToolKind::YtDlp),
        "deno" => Ok(ToolKind::Deno),
        _ => bail!("unsupported tool"),
    }
}

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
    let output = CommandSpec {
        program: snapshot.tool.ffprobe.clone().context("ffprobe missing")?,
        args: ["-v", "error", "-show_streams", "-of", "json"]
            .into_iter()
            .map(OsString::from)
            .chain([path.into()])
            .collect(),
        guards: vec![snapshot.clone()],
    }
    .run(Duration::from_secs(60), &CancellationToken::new())
    .await?;
    ensure!(
        output.code == Some(0),
        "Media stream inspection failed: {}",
        output.stderr
    );
    parse_streams(&output.stdout)
}
#[tauri::command]
pub async fn list_media_streams(
    state: State<'_, AppState>,
    media_id: String,
) -> std::result::Result<Vec<MediaStream>, String> {
    async {
        let media = lock(&state.db)?.media(&media_id)?;
        let lease = lease(&state, &[ToolKind::FfmpegPair]).await?;
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
pub async fn ensure_audio_stream(state: &Services, media_id: &str) -> Result<u32> {
    let media = lock(&state.db)?.media(media_id)?;
    let lease = lease(state, &[ToolKind::FfmpegPair]).await?;
    let streams = inspect_streams(lease.get(ToolKind::FfmpegPair)?, Path::new(&media.path)).await?;
    let _playback = lock(&state.playback)?;
    let selected_in_player = if lock(&state.playing)?.as_deref() == Some(media_id) {
        lock(&state.player)?
            .as_mut()
            .map(|player| player.poll())
            .and_then(|current| {
                current
                    .tracks
                    .into_iter()
                    .find(|t| t.kind == "audio" && t.selected && !t.external)
            })
            .and_then(|t| t.ff_index)
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
#[tauri::command]
pub async fn select_audio_stream(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    media_id: String,
    stream_index: u32,
) -> std::result::Result<(), String> {
    let state = state.inner().clone();
    async {
        let media = lock(&state.db)?.media(&media_id)?;
        let lease = lease(&state, &[ToolKind::FfmpegPair]).await?;
        choose_audio_stream(
            &inspect_streams(lease.get(ToolKind::FfmpegPair)?, Path::new(&media.path)).await?,
            Some(stream_index),
        )?;
        on_main(app, move || {
            let _playback = lock(&state.playback)?;
            let db = lock(&state.db)?;
            let mut current = db.media(&media_id)?;
            ensure!(
                current.path == media.path,
                "Media changed during stream selection"
            );
            if lock(&state.playing)?.as_deref() == Some(&media_id) {
                let mut player = lock(&state.player)?;
                state
                    .require_player(&mut player)?
                    .select_audio_stream(stream_index)?;
            }
            current.audio_stream_index = Some(stream_index);
            db.put_media(&current)
        })
        .await
    }
    .await
    .map_err(err)
}

#[tauri::command]
pub async fn extract_embedded_subtitles(
    state: State<'_, AppState>,
    media_id: String,
    stream_index: u32,
    replace_existing: Option<bool>,
) -> std::result::Result<(), String> {
    async {
        let media = lock(&state.db)?.media(&media_id)?;
        let previous = serde_json::to_vec(&lock(&state.db)?.list_segments(&media_id)?)?;
        let replace = replace_existing.unwrap_or(false);
        ensure!(replace || lock(&state.db)?.list_segments(&media_id)?.is_empty(), "Confirm replacement of the current subtitles; their previous version will be preserved");
        let lease = lease(&state, &[ToolKind::FfmpegPair]).await?;
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
        crate::commands::refresh_current_subtitles(&state, &media_id)
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
    use super::*;
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
        for mode in ["success", "cancel", "truncated"] {
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
                let _ = write!(
                    socket,
                    "HTTP/1.1 200 OK\r\nContent-Type: audio/wav\r\nContent-Length: {length}\r\nConnection: close\r\n\r\n"
                );
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
                .start(crate::commands::ImportRequest {
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
            if mode == "success" {
                assert_eq!(std::fs::read(result.unwrap().0).unwrap(), [7; 64]);
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
pub(crate) fn selection(p: &Preferences, k: ToolKind) -> ToolSelection {
    match k {
        ToolKind::FfmpegPair => p.tools.ffmpeg.clone(),
        ToolKind::YtDlp => p.tools.yt_dlp.clone(),
        ToolKind::Deno => p.tools.deno.clone(),
    }
}
fn set_selection(p: &mut Preferences, k: ToolKind, value: ToolSelection) {
    match k {
        ToolKind::FfmpegPair => p.tools.ffmpeg = value,
        ToolKind::YtDlp => p.tools.yt_dlp = value,
        ToolKind::Deno => p.tools.deno = value,
    }
}
pub(crate) fn channel(p: &Preferences) -> YtDlpChannel {
    if p.settings.yt_dlp_channel == "stable" {
        YtDlpChannel::Stable
    } else {
        YtDlpChannel::Nightly
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    id: String,
    name: String,
    provider: String,
    status: String,
    version: Option<String>,
    path: Option<String>,
    error: Option<String>,
    can_rollback: bool,
    latest_version: Option<String>,
    update_available: bool,
}
pub fn statuses(state: &Services) -> Result<Vec<ToolStatus>> {
    let p = lock(&state.preferences)?;
    let mut result = Vec::new();
    for (k, name) in [
        (ToolKind::FfmpegPair, "FFmpeg / ffprobe"),
        (ToolKind::YtDlp, "yt-dlp"),
        (ToolKind::Deno, "Deno"),
    ] {
        let id = k.directory();
        let mut install_id = None;
        let (provider, status, version, path, error, can_rollback) = match selection(&p, k) {
            ToolSelection::Managed => match state.tools.installed(k) {
                Ok(Some(i)) => {
                    install_id = Some(i.install_id.clone());
                    (
                        "managed",
                        "ready",
                        Some(i.version.clone()),
                        Some(
                            state
                                .tools
                                .root()
                                .join(id)
                                .join("versions")
                                .join(i.install_id)
                                .join(i.executable_relative)
                                .to_string_lossy()
                                .into_owned(),
                        ),
                        None,
                        state.tools.can_rollback(k),
                    )
                }
                Ok(None) => ("managed", "missing", None, None, None, false),
                Err(e) => ("managed", "error", None, None, Some(e.to_string()), false),
            },
            ToolSelection::External { path } => {
                let exists = path.is_file();
                (
                    "external",
                    if exists { "ready" } else { "missing" },
                    p.probes.get(id).map(|r| r.version.clone()),
                    Some(path.to_string_lossy().into_owned()),
                    if exists {
                        None
                    } else {
                        Some("選択したツールが見つかりません。再選択してください。".into())
                    },
                    false,
                )
            }
        };
        let latest_version = crate::tool_updates::latest_version(&p, k, install_id.as_deref());
        let update_available = provider == "managed"
            && version.is_some()
            && latest_version
                .as_ref()
                .zip(version.as_ref())
                .is_some_and(|(a, b)| a != b);
        result.push(ToolStatus {
            id: id.into(),
            name: name.into(),
            provider: provider.into(),
            status: status.into(),
            version,
            path,
            error,
            can_rollback,
            latest_version,
            update_available,
        });
    }
    result.push(ToolStatus {
        id: "vad".into(),
        name: "Silero VAD".into(),
        provider: "managed".into(),
        status: if state
            .root
            .join("models")
            .join(surtitle_ai::SILERO_MODEL_FILENAME)
            .is_file()
        {
            "ready"
        } else {
            "missing"
        }
        .into(),
        version: Some(surtitle_ai::SILERO_MODEL_VERSION.into()),
        path: None,
        error: None,
        can_rollback: false,
        latest_version: None,
        update_available: false,
    });
    Ok(result)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalCandidate {
    pub tool_id: String,
    pub path: String,
    version: Option<String>,
    pub selectable: bool,
    pub verification: &'static str,
    reason: Option<String>,
}
pub fn discover_external_candidates(path: &std::ffi::OsStr) -> Vec<ExternalCandidate> {
    discover_path(path)
        .into_iter()
        .map(|c| ExternalCandidate {
            tool_id: c.kind.directory().into(),
            path: c.selected_path.to_string_lossy().into_owned(),
            version: None,
            selectable: c.problem.is_none(),
            verification: "unverified",
            reason: c.problem,
        })
        .collect()
}
#[tauri::command]
pub fn scan_external_tools(
    state: State<'_, AppState>,
    rescan: Option<bool>,
) -> std::result::Result<Vec<ExternalCandidate>, String> {
    (|| {
        if rescan.unwrap_or(true) {
            let candidates =
                discover_external_candidates(&std::env::var_os("PATH").unwrap_or_default());
            *lock(&state.tool_candidates)? = candidates;
        }
        Ok(lock(&state.tool_candidates)?.clone())
    })()
    .map_err(err)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRequest {
    tool_id: String,
    provider: String,
    path: Option<String>,
}
#[tauri::command]
pub async fn set_tool_provider(
    state: State<'_, AppState>,
    request: ProviderRequest,
) -> std::result::Result<(), String> {
    async {
        let k = kind(&request.tool_id)?;
        let value = match request.provider.as_str() {
            "managed" => ToolSelection::Managed,
            "external" => ToolSelection::External {
                path: PathBuf::from(request.path.context("select a tool path")?),
            },
            _ => bail!("invalid provider"),
        };
        let report = if matches!(value, ToolSelection::External { .. }) {
            let snapshot = state.tools.resolve_selection(k, &value)?;
            Some(probe(&snapshot, &CancellationToken::new()).await?)
        } else {
            None
        };
        let mut p = lock(&state.preferences)?;
        set_selection(&mut p, k, value);
        if let Some(report) = report {
            p.probes.insert(k.directory().into(), report);
        }
        state.save_preferences(&p)
    }
    .await
    .map_err(err)
}
async fn update(state: &Services, id: &str) -> Result<()> {
    if id == "vad" {
        surtitle_ai::install_silero_model(&state.root.join("models")).await?;
        return Ok(());
    }
    let k = kind(id)?;
    let c = {
        let p = lock(&state.preferences)?;
        ensure!(
            matches!(selection(&p, k), ToolSelection::Managed),
            "外部ツールは利用者のパッケージマネージャーで更新してください / External tools are user managed"
        );
        channel(&p)
    };
    state.tools.update(k, c, &CancellationToken::new()).await?;
    Ok(())
}
#[tauri::command]
pub async fn install_tool(
    state: State<'_, AppState>,
    tool_id: String,
) -> std::result::Result<(), String> {
    update(&state, &tool_id).await.map_err(err)
}
#[tauri::command]
pub async fn update_tool(
    state: State<'_, AppState>,
    tool_id: String,
) -> std::result::Result<(), String> {
    update(&state, &tool_id).await.map_err(err)
}
#[tauri::command]
pub fn rollback_tool(
    state: State<'_, AppState>,
    tool_id: String,
) -> std::result::Result<(), String> {
    (|| {
        let k = kind(&tool_id)?;
        ensure!(
            matches!(
                selection(&*lock(&state.preferences)?, k),
                ToolSelection::Managed
            ),
            "external tools cannot be rolled back by Surtitle"
        );
        state.tools.rollback(k)?;
        Ok(())
    })()
    .map_err(err)
}

pub async fn lease(state: &Services, kinds: &[ToolKind]) -> Result<JobLease> {
    Ok(lease_with_cancel(state, kinds, &CancellationToken::new())
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
async fn lease_with_cancel(
    state: &Services,
    kinds: &[ToolKind],
    cancel: &CancellationToken,
) -> Result<(JobLease, String)> {
    let p = lock(&state.preferences)?.clone();
    let mut selected = Vec::new();
    for k in kinds {
        let s = selection(&p, *k);
        if matches!(s, ToolSelection::Managed) && state.tools.installed(*k)?.is_none() {
            state.tools.update(*k, channel(&p), cancel).await?;
        }
        selected.push((*k, s));
    }
    let mut lease = state.tools.lease_tools(&selected)?;
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
) -> Result<PathBuf> {
    ensure!(
        segment.status == "confirmed" && segment.media_id == media.id,
        "subtitle is not confirmed"
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
    let lease = lease(state, &[ToolKind::FfmpegPair]).await?;
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

pub async fn download_url(
    state: &Services,
    url: &str,
    job: &DownloadJob,
) -> Result<(PathBuf, String)> {
    let parsed = reqwest::Url::parse(url)?;
    ensure!(
        ["http", "https"].contains(&parsed.scheme())
            && parsed.username().is_empty()
            && parsed.password().is_none(),
        "only public HTTP(S) URLs without credentials are supported"
    );
    let host = parsed.host_str().context("URL requires a host")?;
    let youtube = host == "youtu.be" || host == "youtube.com" || host.ends_with(".youtube.com");
    let temporary_directory = tempfile::Builder::new()
        .prefix(".download-")
        .tempdir_in(state.root.join("media"))?;
    let directory = temporary_directory.path().canonicalize()?;
    download::check_capacity(fs2::available_space(&directory)?, 0, 0)?;
    ensure!(!job.cancel.is_cancelled(), "Download cancelled");
    if youtube {
        ensure!(
            !parsed.query_pairs().any(|(key, _)| key == "list")
                && !parsed.path().contains("/playlist"),
            "playlists are not supported"
        );
        job.progress("preparing_tools", 0, None)?;
        let (lease, receipt_id) = lease_with_cancel(
            state,
            &[ToolKind::FfmpegPair, ToolKind::YtDlp, ToolKind::Deno],
            &job.cancel,
        )
        .await?;
        state.downloads.bind_tool_receipt(job, &receipt_id)?;
        let (yt, deno, ffmpeg) = (
            lease.get(ToolKind::YtDlp)?,
            lease.get(ToolKind::Deno)?,
            lease.get(ToolKind::FfmpegPair)?,
        );
        job.progress("inspecting", 0, None)?;
        let metadata = probe_ytdlp_environment(yt, deno, ffmpeg, url, &job.cancel).await?;
        ensure!(
            metadata.get("entries").is_none()
                && metadata["is_live"] != true
                && metadata["live_status"] != "is_live"
                && metadata["live_status"] != "is_upcoming",
            "only single completed videos are supported"
        );
        ensure!(
            metadata["availability"]
                .as_str()
                .is_none_or(|v| ["public", "unlisted"].contains(&v)),
            "login-restricted media is unsupported"
        );
        let command = build_ytdlp_command(
            yt,
            deno,
            ffmpeg,
            YtDlpRequest::Download {
                url: url.into(),
                output_directory: directory.clone(),
            },
        )?;
        let expected = metadata["filesize"]
            .as_u64()
            .or_else(|| metadata["filesize_approx"].as_u64());
        if let Some(size) = expected {
            download::check_capacity(fs2::available_space(&directory)?, size.saturating_mul(2), 0)?;
        }
        job.progress("downloading", 0, expected)?;
        let work = command.run(Duration::from_secs(24 * 3600), &job.cancel);
        tokio::pin!(work);
        let output = loop {
            tokio::select! {
                result = &mut work => break result?,
                _ = tokio::time::sleep(Duration::from_millis(500)) => {
                    let bytes = download::stored_bytes(&directory)?;
                    download::check_capacity(fs2::available_space(&directory)?, 0, bytes)?;
                    job.progress("downloading", bytes, expected)?;
                }
            }
        };
        ensure!(
            output.code == Some(0),
            "yt-dlp取得失敗。yt-dlp更新後に再試行してください: {}",
            output.stderr
        );
        let path = PathBuf::from(
            output
                .stdout
                .lines()
                .last()
                .context("download produced no media path")?,
        )
        .canonicalize()?;
        ensure!(
            path.starts_with(directory.canonicalize()?) && path.is_file(),
            "download output outside media directory"
        );
        let bytes = download::stored_bytes(&directory)?;
        download::check_capacity(fs2::available_space(&directory)?, 0, bytes)?;
        ensure!(!job.cancel.is_cancelled(), "Download cancelled");
        let name = path
            .file_name()
            .context("download filename missing")?
            .to_owned();
        let final_directory = state.root.join("media").join(surtitle_core::id());
        std::fs::rename(&directory, &final_directory)?;
        job.progress("importing", bytes, expected)?;
        return Ok((
            final_directory.join(name),
            metadata["title"].as_str().unwrap_or("YouTube").into(),
        ));
    }
    let title = parsed
        .path_segments()
        .and_then(|mut s| s.next_back())
        .filter(|s| !s.is_empty())
        .unwrap_or("media")
        .to_owned();
    let ext = Path::new(&title)
        .extension()
        .and_then(|s| s.to_str())
        .filter(|s| s.len() <= 8 && s.chars().all(|c| c.is_ascii_alphanumeric()))
        .unwrap_or("media");
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(5))
        .connect_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(24 * 3600))
        .build()?;
    job.progress("connecting", 0, None)?;
    let mut response = tokio::select! { biased; _ = job.cancel.cancelled() => bail!("Download cancelled"), response = client.get(parsed).send() => response? }.error_for_status()?;
    ensure!(
        response
            .headers()
            .get("content-type")
            .and_then(|h| h.to_str().ok())
            .is_none_or(|s| !s.contains("text/html")),
        "URL points to a webpage; enter a direct media URL"
    );
    const MAX: u64 = download::MAX_DOWNLOAD_BYTES;
    ensure!(
        response.content_length().is_none_or(|s| s <= MAX),
        "download exceeds 100 GiB safety limit"
    );
    let temporary = directory.join("download.part");
    let destination = directory.join(format!("media.{ext}"));
    let mut file = std::fs::File::create(&temporary)?;
    let mut total = 0u64;
    let expected = response.content_length();
    if let Some(size) = expected {
        download::check_capacity(fs2::available_space(&directory)?, size, 0)?;
    }
    job.progress("downloading", 0, expected)?;
    loop {
        let bytes = tokio::select! { biased; _ = job.cancel.cancelled() => bail!("Download cancelled"), bytes = response.chunk() => bytes? };
        let Some(bytes) = bytes else {
            break;
        };
        use std::io::Write;
        download::check_capacity(fs2::available_space(&directory)?, bytes.len() as u64, total)?;
        total = total
            .checked_add(bytes.len() as u64)
            .context("download size overflow")?;
        ensure!(total <= MAX, "download exceeds safety limit");
        file.write_all(&bytes)?;
        job.progress("downloading", total, expected)?;
    }
    ensure!(total > 0, "empty media download");
    file.sync_all()?;
    drop(file);
    ensure!(!job.cancel.is_cancelled(), "Download cancelled");
    std::fs::rename(temporary, &destination)?;
    let final_directory = state.root.join("media").join(surtitle_core::id());
    std::fs::rename(&directory, &final_directory)?;
    job.progress("importing", total, expected)?;
    Ok((
        final_directory.join(
            destination
                .file_name()
                .context("download filename missing")?,
        ),
        title,
    ))
}
