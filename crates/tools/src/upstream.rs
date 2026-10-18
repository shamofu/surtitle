use crate::{CancellationToken, ToolKind};
use anyhow::{Context, Result, bail, ensure};
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs::File, io::Write, path::Path, time::Duration};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "method", rename_all = "snake_case")]
pub enum Verification {
    /// Hash retrieved over HTTPS from the same provider. This is not an
    /// independent publisher signature.
    HttpsSha256 { origin: String },
}
/// Created from upstream metadata, not deserializable from untrusted IPC.
/// Version coordinates identify this download; they do not limit future updates.
#[derive(Debug, Clone, Serialize)]
pub struct ReleaseCandidate {
    pub kind: ToolKind,
    pub version: String,
    pub channel: String,
    pub provider: String,
    pub source_page: String,
    pub declared_license: String,
    pub asset_name: String,
    pub(crate) asset_url: String,
    pub(crate) checksum_url: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadProgress {
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
}
/// Work within an installation. Download completion is not installation completion.
#[derive(Debug, Clone)]
pub struct ToolUpdateProgress {
    pub phase: &'static str,
    pub download: Option<DownloadProgress>,
}
impl ToolUpdateProgress {
    pub(crate) fn phase(phase: &'static str) -> Self {
        Self {
            phase,
            download: None,
        }
    }
    pub(crate) fn download(downloaded_bytes: u64, total_bytes: Option<u64>) -> Self {
        Self {
            phase: "downloading",
            download: Some(DownloadProgress {
                downloaded_bytes,
                total_bytes,
            }),
        }
    }
}
pub(crate) struct DownloadReceipt {
    pub sha256: String,
    pub verification: Verification,
}

pub(crate) fn client() -> Result<Client> {
    Client::builder()
        .user_agent("surtitle-tools/0.1")
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(15 * 60))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 8 {
                return attempt.error("too many redirects");
            }
            if trusted_url(attempt.url()) {
                attempt.follow()
            } else {
                attempt.error("untrusted download redirect")
            }
        }))
        .build()
        .context("cannot create HTTPS client")
}
fn trusted_url(url: &Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port_or_known_default() == Some(443)
        && url.host_str() == Some("www.gyan.dev")
}
fn validate_version(version: &str) -> Result<()> {
    ensure!(
        !version.is_empty()
            && version.len() <= 120
            && !version.contains("..")
            && version
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c)),
        "invalid upstream version coordinate"
    );
    Ok(())
}
async fn small(client: &Client, url: &str, cancel: &CancellationToken) -> Result<Vec<u8>> {
    let url = Url::parse(url)?;
    ensure!(trusted_url(&url), "untrusted upstream URL");
    let work = async {
        let mut response = client.get(url).send().await?.error_for_status()?;
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            ensure!(
                bytes.len() + chunk.len() <= 4 * 1024 * 1024,
                "upstream metadata exceeds limit"
            );
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    };
    tokio::select! { biased; _ = cancel.cancelled() => bail!("operation cancelled"), result = tokio::time::timeout(Duration::from_secs(45), work) => result.context("upstream metadata timed out")? }
}
pub(crate) async fn latest(
    client: &Client,
    kind: ToolKind,
    cancel: &CancellationToken,
) -> Result<ReleaseCandidate> {
    ensure!(
        cfg!(all(windows, target_arch = "x86_64")),
        "managed downloads currently support Windows x64; external tools remain usable on this platform"
    );
    let version = String::from_utf8(
        small(
            client,
            "https://www.gyan.dev/ffmpeg/builds/release-version",
            cancel,
        )
        .await?,
    )?
    .trim()
    .to_owned();
    validate_version(&version)?;
    let asset_name = format!("ffmpeg-{version}-essentials_build.zip");
    let asset_url = format!("https://www.gyan.dev/ffmpeg/builds/packages/{asset_name}");
    Ok(ReleaseCandidate {
        kind,
        version,
        channel: "release-essentials".into(),
        provider: "gyan.dev (third-party FFmpeg builder)".into(),
        source_page: "https://www.gyan.dev/ffmpeg/builds/".into(),
        declared_license: "GPL-3.0 (provider declaration; see package notices)".into(),
        checksum_url: format!("{asset_url}.sha256"),
        asset_name,
        asset_url,
    })
}

pub(crate) async fn download(
    client: &Client,
    candidate: &ReleaseCandidate,
    destination: &Path,
    cancel: &CancellationToken,
    progress: &mut (impl FnMut(ToolUpdateProgress) + Send),
) -> Result<DownloadReceipt> {
    let sums = small(client, &candidate.checksum_url, cancel).await?;
    let verification = Verification::HttpsSha256 {
        origin: candidate.provider.clone(),
    };
    let expected = checksum_for_asset(std::str::from_utf8(&sums)?, &candidate.asset_name)?;
    let url = Url::parse(&candidate.asset_url)?;
    ensure!(trusted_url(&url), "untrusted artifact URL");
    let work = async {
        progress(ToolUpdateProgress::phase("connecting"));
        let mut response = client.get(url).send().await?.error_for_status()?;
        let total = response.content_length();
        progress(ToolUpdateProgress::download(0, total));
        const MAX: u64 = 512 * 1024 * 1024;
        ensure!(
            total.is_none_or(|n| n <= MAX),
            "tool package exceeds 512 MiB limit"
        );
        let mut file = File::create(destination)?;
        let mut hash = Sha256::new();
        let mut bytes = 0u64;
        while let Some(chunk) = response.chunk().await? {
            bytes += chunk.len() as u64;
            ensure!(bytes <= MAX, "tool package exceeds 512 MiB limit");
            hash.update(&chunk);
            file.write_all(&chunk)?;
            progress(ToolUpdateProgress::download(bytes, total));
        }
        ensure!(
            bytes > 0 && total.is_none_or(|n| n == bytes),
            "incomplete tool package"
        );
        progress(ToolUpdateProgress::phase("verifying"));
        file.sync_all()?;
        let actual = format!("{:x}", hash.finalize());
        ensure!(
            actual == expected,
            "downloaded package checksum does not match upstream"
        );
        Ok(DownloadReceipt {
            sha256: actual,
            verification,
        })
    };
    tokio::select! { biased; _ = cancel.cancelled() => bail!("operation cancelled"), result = work => result }
}
fn checksum_for_asset(text: &str, asset: &str) -> Result<String> {
    let mut result = None;
    for line in text.lines().map(str::trim).filter(|l| !l.is_empty()) {
        let mut parts = line.split_whitespace();
        let hash = parts.next().unwrap_or("");
        if hash.len() != 64 || !hash.bytes().all(|c| c.is_ascii_hexdigit()) {
            continue;
        }
        let name = parts.next().map(|s| s.trim_start_matches('*'));
        if name.is_none() || name == Some(asset) {
            ensure!(result.is_none(), "ambiguous checksum manifest");
            result = Some(hash.to_ascii_lowercase());
        }
    }
    result.context("upstream checksum manifest has no entry for this asset")
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn checksum_selects_exact_asset_and_rejects_ambiguity() {
        let hash = "a".repeat(64);
        let text = format!("{}  other.zip\n{hash} *ffmpeg.zip\n", "b".repeat(64));
        assert_eq!(checksum_for_asset(&text, "ffmpeg.zip").unwrap(), hash);
        assert!(checksum_for_asset(&text, "missing.zip").is_err());
        assert!(checksum_for_asset(&format!("{hash}\n{hash}"), "x").is_err());
    }
    #[test]
    fn transport_and_version_boundaries() {
        for url in [
            "http://www.gyan.dev/a",
            "https://www.gyan.dev.evil.org/",
            "https://www.gyan.dev:444/a",
            "https://user@www.gyan.dev/a",
            "https://localhost/",
        ] {
            assert!(!trusted_url(&Url::parse(url).unwrap()));
        }
        assert!(trusted_url(
            &Url::parse("https://www.gyan.dev/ffmpeg/builds/release-version").unwrap()
        ));
        for version in ["../evil", "v1/../../x", "", "v1\\x"] {
            assert!(validate_version(version).is_err());
        }
        validate_version("8.0.1").unwrap();
        validate_version("v99.1.0").unwrap();
    }
}
