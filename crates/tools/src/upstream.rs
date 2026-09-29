use crate::{CancellationToken, ToolKind};
use anyhow::{Context, Result, bail, ensure};
use pgp::composed::{Deserializable, DetachedSignature, SignedPublicKey};
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs::File, io::Write, path::Path, time::Duration};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum YtDlpChannel {
    #[default]
    Nightly,
    Stable,
}
impl YtDlpChannel {
    fn repository(self) -> &'static str {
        match self {
            Self::Nightly => "yt-dlp/yt-dlp-nightly-builds",
            Self::Stable => "yt-dlp/yt-dlp",
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "method", rename_all = "snake_case")]
pub enum Verification {
    SignedSha256 {
        fingerprint: String,
    },
    /// Hash retrieved over HTTPS from the same provider. This is not an
    /// independent publisher signature.
    HttpsSha256 {
        origin: String,
    },
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
    pub(crate) signature_url: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadProgress {
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
}
pub(crate) struct DownloadReceipt {
    pub sha256: String,
    pub verification: Verification,
}

pub(crate) fn client() -> Result<Client> {
    Client::builder()
        .user_agent("surtitle-tools/0.1 (+https://github.com/yt-dlp/yt-dlp)")
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
        && matches!(
            url.host_str(),
            Some(
                "api.github.com"
                    | "github.com"
                    | "release-assets.githubusercontent.com"
                    | "objects.githubusercontent.com"
                    | "www.gyan.dev"
            )
        )
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
#[derive(Deserialize)]
struct GitHubRelease {
    tag_name: String,
    assets: Vec<GitHubAsset>,
}
#[derive(Deserialize)]
struct GitHubAsset {
    name: String,
    browser_download_url: String,
}
pub(crate) async fn latest(
    client: &Client,
    kind: ToolKind,
    channel: YtDlpChannel,
    cancel: &CancellationToken,
) -> Result<ReleaseCandidate> {
    ensure!(
        cfg!(all(windows, target_arch = "x86_64")),
        "managed downloads currently support Windows x64; external tools remain usable on this platform"
    );
    if kind == ToolKind::FfmpegPair {
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
        return Ok(ReleaseCandidate {
            kind,
            version,
            channel: "release-essentials".into(),
            provider: "gyan.dev (third-party FFmpeg builder)".into(),
            source_page: "https://www.gyan.dev/ffmpeg/builds/".into(),
            declared_license: "GPL-3.0 (provider declaration; see package notices)".into(),
            checksum_url: format!("{asset_url}.sha256"),
            asset_name,
            asset_url,
            signature_url: None,
        });
    }
    let repo = if kind == ToolKind::YtDlp {
        channel.repository()
    } else {
        "denoland/deno"
    };
    let metadata = small(
        client,
        &format!("https://api.github.com/repos/{repo}/releases/latest"),
        cancel,
    )
    .await?;
    let release: GitHubRelease =
        serde_json::from_slice(&metadata).context("invalid upstream release metadata")?;
    validate_version(&release.tag_name)?;
    let name = if kind == ToolKind::YtDlp {
        "yt-dlp.exe"
    } else {
        "deno-x86_64-pc-windows-msvc.zip"
    };
    let get = |name: &str| -> Result<String> {
        let asset = release
            .assets
            .iter()
            .find(|a| a.name == name)
            .with_context(|| format!("upstream release lacks {name}"))?;
        let expected_prefix = format!(
            "https://github.com/{repo}/releases/download/{}/",
            release.tag_name
        );
        ensure!(
            asset.browser_download_url == format!("{expected_prefix}{name}"),
            "upstream asset URL does not match its official release"
        );
        Ok(asset.browser_download_url.clone())
    };
    let (checksum_url, signature_url) = if kind == ToolKind::YtDlp {
        (get("SHA2-256SUMS")?, Some(get("SHA2-256SUMS.sig")?))
    } else {
        (get(&format!("{name}.sha256sum"))?, None)
    };
    Ok(ReleaseCandidate {
        kind,
        version: release.tag_name.clone(),
        channel: if kind == ToolKind::Deno {
            "stable"
        } else if channel == YtDlpChannel::Nightly {
            "nightly"
        } else {
            "stable"
        }
        .into(),
        provider: repo.into(),
        source_page: format!(
            "https://github.com/{repo}/releases/tag/{}",
            release.tag_name
        ),
        declared_license: if kind == ToolKind::YtDlp {
            "GPL-3.0-or-later (official standalone combined executable)"
        } else {
            "MIT plus third-party notices"
        }
        .into(),
        asset_name: name.into(),
        asset_url: get(name)?,
        checksum_url,
        signature_url,
    })
}
pub(crate) async fn download(
    client: &Client,
    candidate: &ReleaseCandidate,
    destination: &Path,
    cancel: &CancellationToken,
    progress: Option<&tokio::sync::mpsc::UnboundedSender<DownloadProgress>>,
) -> Result<DownloadReceipt> {
    let sums = small(client, &candidate.checksum_url, cancel).await?;
    let verification = if let Some(url) = &candidate.signature_url {
        let sig = small(client, url, cancel).await?;
        verify_ytdlp_signature(&sums, &sig)?;
        Verification::SignedSha256 {
            fingerprint: "AC0CBBE6848D6A873464AF4E57CF65933B5A7581".into(),
        }
    } else {
        Verification::HttpsSha256 {
            origin: candidate.provider.clone(),
        }
    };
    let expected = checksum_for_asset(std::str::from_utf8(&sums)?, &candidate.asset_name)?;
    let url = Url::parse(&candidate.asset_url)?;
    ensure!(trusted_url(&url), "untrusted artifact URL");
    let work = async {
        let mut response = client.get(url).send().await?.error_for_status()?;
        let total = response.content_length();
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
            if let Some(sender) = progress {
                let _ = sender.send(DownloadProgress {
                    downloaded_bytes: bytes,
                    total_bytes: total,
                });
            }
        }
        ensure!(
            bytes > 0 && total.is_none_or(|n| n == bytes),
            "incomplete tool package"
        );
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
    // Deno's Windows release checksum currently uses PowerShell Get-FileHash
    // Format-List output, while Unix assets and yt-dlp use GNU checksum lines.
    if text
        .lines()
        .any(|line| line.trim_start().starts_with("Algorithm"))
    {
        let mut fields = std::collections::BTreeMap::new();
        for line in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
            let (key, value) = line
                .split_once(':')
                .context("invalid PowerShell checksum file")?;
            ensure!(
                fields.insert(key.trim(), value.trim()).is_none(),
                "duplicate checksum field"
            );
        }
        ensure!(
            fields.len() == 3 && fields.get("Algorithm") == Some(&"SHA256"),
            "unsupported checksum algorithm or fields"
        );
        let hash = fields.get("Hash").context("missing checksum hash")?;
        let path = fields.get("Path").context("missing checksum asset path")?;
        ensure!(
            path.rsplit(['\\', '/']).next() == Some(asset),
            "checksum refers to a different asset"
        );
        ensure!(
            hash.len() == 64 && hash.bytes().all(|c| c.is_ascii_hexdigit()),
            "invalid SHA256 checksum"
        );
        return Ok(hash.to_ascii_lowercase());
    }
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
fn verify_ytdlp_signature(content: &[u8], signature: &[u8]) -> Result<()> {
    let (key, _) = SignedPublicKey::from_string(include_str!("ytdlp-public.asc"))
        .context("invalid embedded yt-dlp trust key")?;
    key.verify_bindings()
        .context("invalid yt-dlp key bindings")?;
    let sig = if signature.starts_with(b"-----BEGIN PGP") {
        DetachedSignature::from_string(std::str::from_utf8(signature)?)?.0
    } else {
        DetachedSignature::from_bytes(signature)?
    };
    sig.verify(&key, content)
        .context("yt-dlp release signature verification failed; update not installed")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn checksum_selects_exact_asset_and_rejects_ambiguity() {
        let hash = "a".repeat(64);
        let text = format!("{}  other.exe\n{hash} *yt-dlp.exe\n", "b".repeat(64));
        assert_eq!(checksum_for_asset(&text, "yt-dlp.exe").unwrap(), hash);
        assert!(checksum_for_asset(&text, "missing.exe").is_err());
        assert!(checksum_for_asset(&format!("{hash}\n{hash}"), "x").is_err());
        let windows = format!(
            "\r\nAlgorithm : SHA256\r\nHash : {}\r\nPath : C:\\a\\deno\\deno-x64.zip\r\n",
            hash.to_uppercase()
        );
        assert_eq!(checksum_for_asset(&windows, "deno-x64.zip").unwrap(), hash);
        assert!(checksum_for_asset(&windows, "other.zip").is_err());
    }
    #[test]
    fn transport_and_version_boundaries() {
        for url in [
            "http://github.com/a",
            "https://github.com.evil.org/",
            "https://github.com:444/a",
            "https://user@github.com/a",
            "https://localhost/",
        ] {
            assert!(!trusted_url(&Url::parse(url).unwrap()));
        }
        for version in ["../evil", "v1/../../x", "", "v1\\x"] {
            assert!(validate_version(version).is_err());
        }
        validate_version("2026.08.30.232658").unwrap();
        validate_version("v99.1.0").unwrap();
    }
    #[test]
    fn embedded_key_valid_and_unsigned_data_rejected() {
        let (key, _) = SignedPublicKey::from_string(include_str!("ytdlp-public.asc")).unwrap();
        key.verify_bindings().unwrap();
        assert!(verify_ytdlp_signature(b"fake", b"not a signature").is_err());
    }
    #[test]
    fn official_signature_fixture_rejects_tampered_checksums() {
        // Official nightly 2026.08.30.232658. This immutable test fixture does not
        // constrain production updates, which resolve the live channel.
        let checksums = include_bytes!("ytdlp-checksums.fixture");
        let signature = include_bytes!("ytdlp-checksums.fixture.sig");
        verify_ytdlp_signature(checksums, signature).unwrap();
        let mut tampered = checksums.to_vec();
        tampered[0] ^= 1;
        assert!(verify_ytdlp_signature(&tampered, signature).is_err());

        // Git must preserve the signed bytes on Windows; verification must not
        // hide a changed payload by normalizing its line endings.
        let crlf = std::str::from_utf8(checksums)
            .unwrap()
            .replace('\n', "\r\n");
        assert_ne!(crlf.as_bytes(), checksums);
        assert!(verify_ytdlp_signature(crlf.as_bytes(), signature).is_err());
    }
}
