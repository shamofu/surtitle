use super::{DownloadJob, MAX_DOWNLOAD_BYTES, check_capacity, stored_bytes};
use crate::application::{Services, media_tools::lease_with_cancel};
use anyhow::{Context, Result, bail, ensure};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use surtitle_tools::{ToolKind, YtDlpRequest, build_ytdlp_command, probe_ytdlp_environment};

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
    check_capacity(fs2::available_space(&directory)?, 0, 0)?;
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
            check_capacity(fs2::available_space(&directory)?, size.saturating_mul(2), 0)?;
        }
        job.progress("downloading", 0, expected)?;
        let work = command.run(Duration::from_secs(24 * 3600), &job.cancel);
        tokio::pin!(work);
        let output = loop {
            tokio::select! {
                result = &mut work => break result?,
                _ = tokio::time::sleep(Duration::from_millis(500)) => {
                    let bytes = stored_bytes(&directory)?;
                    check_capacity(fs2::available_space(&directory)?, 0, bytes)?;
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
        let bytes = stored_bytes(&directory)?;
        check_capacity(fs2::available_space(&directory)?, 0, bytes)?;
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
    const MAX: u64 = MAX_DOWNLOAD_BYTES;
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
        check_capacity(fs2::available_space(&directory)?, size, 0)?;
    }
    job.progress("downloading", 0, expected)?;
    loop {
        let bytes = tokio::select! { biased; _ = job.cancel.cancelled() => bail!("Download cancelled"), bytes = response.chunk() => bytes? };
        let Some(bytes) = bytes else {
            break;
        };
        use std::io::Write;
        check_capacity(fs2::available_space(&directory)?, bytes.len() as u64, total)?;
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
