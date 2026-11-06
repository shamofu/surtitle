use anyhow::{Context, Result, ensure};
use std::{
    ffi::OsString,
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    time::Duration,
};
use surtitle_core::AudioClipRange;
use surtitle_tools::{CancellationToken, CommandSpec, ToolSnapshot};

const SAMPLES_PER_MS: u64 = 16;

fn arguments(
    input: &Path,
    index: u32,
    range: AudioClipRange,
    output: &Path,
) -> Result<Vec<OsString>> {
    ensure!(
        range.end_ms > range.start_ms && range.end_ms - range.start_ms <= 182_000,
        "Invalid card audio range"
    );
    let first_sample = range
        .start_ms
        .checked_mul(SAMPLES_PER_MS)
        .context("Audio time overflow")?;
    let end_sample = range
        .end_ms
        .checked_mul(SAMPLES_PER_MS)
        .context("Audio time overflow")?;
    // Start the resampler on a source-clock integer second, with at least one second
    // of history before the requested clip. A preceding seek avoids decoding hours
    // of media, while its packet-boundary rounding cannot discard the anchor.
    let anchor_seconds = (range.start_ms / 1000).saturating_sub(1);
    let seek_seconds = anchor_seconds.saturating_sub(1);
    let filter = format!(
        "atrim=start={anchor_seconds},aresample=16000,atrim=start_pts={first_sample}:end_pts={end_sample},asetpts=PTS-STARTPTS"
    );
    let duration_ms = range.end_ms - range.start_ms;
    let mut args: Vec<OsString> = vec![
        "-nostdin".into(),
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-n".into(),
        "-copyts".into(),
        "-start_at_zero".into(),
    ];
    // Seeking to zero can skip an AAC/MP3 decoder's negative-timestamp priming packet.
    if seek_seconds > 0 {
        args.extend(["-ss".into(), seek_seconds.to_string().into()]);
    }
    args.extend([
        "-i".into(),
        input.as_os_str().to_owned(),
        "-map".into(),
        format!("0:{index}").into(),
        "-vn".into(),
        "-af".into(),
        filter.into(),
        "-t".into(),
        format!("{}.{:03}", duration_ms / 1000, duration_ms % 1000).into(),
        "-ac".into(),
        "1".into(),
        "-ar".into(),
        "16000".into(),
        "-c:a".into(),
        "pcm_s16le".into(),
        output.as_os_str().to_owned(),
    ]);
    Ok(args)
}

// Validate the bounded WAV without loading its audio into memory. Reject truncated
// output rather than padding it or claiming a shorter clip covers the requested range.
fn validate_wav(path: &Path, range: AudioClipRange) -> Result<()> {
    let expected_bytes = (range.end_ms - range.start_ms)
        .checked_mul(SAMPLES_PER_MS * 2)
        .context("Audio length overflow")?;
    let mut file = File::open(path)?;
    let size = file.metadata()?.len();
    ensure!(
        size <= expected_bytes + 65_536,
        "Card audio exceeds expected size"
    );
    let mut header = [0; 12];
    file.read_exact(&mut header)?;
    ensure!(
        &header[..4] == b"RIFF"
            && &header[8..] == b"WAVE"
            && u64::from(u32::from_le_bytes(header[4..8].try_into()?)) + 8 == size,
        "Invalid card audio WAV header"
    );
    let mut format_seen = false;
    let mut data_seen = false;
    while file.stream_position()? < size {
        let mut chunk = [0; 8];
        file.read_exact(&mut chunk)?;
        let length = u64::from(u32::from_le_bytes(chunk[4..].try_into()?));
        let start = file.stream_position()?;
        let next = start
            .checked_add(length + length % 2)
            .context("WAV chunk overflow")?;
        ensure!(next <= size, "Truncated card audio WAV");
        match &chunk[..4] {
            b"fmt " => {
                ensure!(!format_seen && length >= 16, "Invalid card audio format");
                let mut format = [0; 16];
                file.read_exact(&mut format)?;
                ensure!(
                    format == [1, 0, 1, 0, 128, 62, 0, 0, 0, 125, 0, 0, 2, 0, 16, 0],
                    "Card audio must be mono 16000 Hz PCM16"
                );
                format_seen = true;
            }
            b"data" => {
                ensure!(
                    !data_seen && length == expected_bytes,
                    "Card audio does not cover its complete source range"
                );
                data_seen = true;
            }
            _ => {}
        }
        file.seek(SeekFrom::Start(next))?;
    }
    ensure!(format_seen && data_seen, "Incomplete card audio WAV");
    Ok(())
}

pub(super) async fn extract(
    snapshot: &ToolSnapshot,
    input: &Path,
    index: u32,
    range: AudioClipRange,
    directory: &Path,
) -> Result<PathBuf> {
    let temporary = tempfile::Builder::new()
        .prefix(".extract-")
        .tempdir_in(directory)?;
    let output = temporary.path().join("clip.wav");
    let command = CommandSpec {
        program: snapshot.tool.executable.clone(),
        args: arguments(input, index, range, &output)?,
        guards: vec![snapshot.clone()],
    };
    let result = command
        .run(Duration::from_secs(300), &CancellationToken::new())
        .await?;
    ensure!(
        result.code == Some(0),
        "Card audio extraction failed: {}",
        result.stderr
    );
    validate_wav(&output, range)?;
    let destination = directory.join(format!("{}.wav", surtitle_core::id()));
    ensure!(
        !destination.exists(),
        "Card audio destination already exists"
    );
    std::fs::rename(&output, &destination)?;
    Ok(destination)
}

#[cfg(test)]
#[path = "card_audio_tests.rs"]
mod tests;
