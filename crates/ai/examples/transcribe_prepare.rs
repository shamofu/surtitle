//! Local evaluation preparation using the production Silero and chunk planner.
//! Input is an explicitly decoded mono 16 kHz PCM16 WAV. No credentials or HTTP.
use serde::Deserialize;
use serde_json::json;
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
};
use surtitle_ai::{hash_file, plan_chunks, ChunkOptions, SileroVad, VadAssets};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    source_id: String,
    audio_path: PathBuf,
    audio_sha256: String,
    assets: VadAssets,
    start_sample: u64,
    end_sample: u64,
    profiles: Vec<String>,
}

fn profile(name: &str) -> Result<ChunkOptions> {
    match name {
        "current120" => Ok(ChunkOptions::default()),
        "short60" => Ok(ChunkOptions {
            minimum_ms: 45_000,
            target_ms: 60_000,
            search_end_ms: 75_000,
            hard_maximum_ms: 90_000,
            ..ChunkOptions::default()
        }),
        _ => Err("Unknown explicit chunk profile".into()),
    }
}

fn wav_data(file: &mut File) -> Result<(u64, u64)> {
    let length = file.metadata()?.len();
    let mut header = [0u8; 12];
    file.read_exact(&mut header)?;
    if &header[..4] != b"RIFF"
        || &header[8..] != b"WAVE"
        || u64::from(u32::from_le_bytes(header[4..8].try_into()?)) + 8 != length
    {
        return Err("A complete RIFF WAV is required".into());
    }
    let mut format = false;
    let mut data = None;
    while file.stream_position()? < length {
        let mut chunk = [0u8; 8];
        file.read_exact(&mut chunk)?;
        let bytes = u64::from(u32::from_le_bytes(chunk[4..].try_into()?));
        let offset = file.stream_position()?;
        let next = offset
            .checked_add(bytes)
            .and_then(|v| v.checked_add(bytes % 2))
            .ok_or("WAV overflow")?;
        if next > length {
            return Err("WAV chunk exceeds the file".into());
        }
        match &chunk[..4] {
            b"fmt " => {
                if format || bytes != 16 {
                    return Err("Require one PCM16 fmt chunk".into());
                }
                let mut fmt = [0u8; 16];
                file.read_exact(&mut fmt)?;
                format = fmt == [1, 0, 1, 0, 128, 62, 0, 0, 0, 125, 0, 0, 2, 0, 16, 0];
                if !format {
                    return Err("Require mono 16 kHz signed PCM16".into());
                }
            }
            b"data" => {
                if data.is_some() || bytes == 0 || bytes % 2 != 0 {
                    return Err("Invalid PCM data".into());
                }
                data = Some((offset, bytes / 2));
            }
            _ => {}
        }
        file.seek(SeekFrom::Start(next))?;
    }
    if !format {
        return Err("PCM format is absent".into());
    }
    data.ok_or_else(|| "PCM data is absent".into())
}

fn write_wav(source: &mut File, data_offset: u64, start: u64, end: u64, path: &Path) -> Result<()> {
    let bytes = u32::try_from((end - start).checked_mul(2).ok_or("PCM overflow")?)?;
    let mut output = OpenOptions::new().write(true).create_new(true).open(path)?;
    output.write_all(b"RIFF")?;
    output.write_all(&(bytes + 36).to_le_bytes())?;
    output.write_all(b"WAVEfmt \x10\0\0\0\x01\0\x01\0\x80\x3e\0\0\0\x7d\0\0\x02\0\x10\0data")?;
    output.write_all(&bytes.to_le_bytes())?;
    source.seek(SeekFrom::Start(data_offset + start * 2))?;
    if std::io::copy(&mut source.take(u64::from(bytes)), &mut output)? != u64::from(bytes) {
        return Err("PCM input ended early".into());
    }
    output.sync_all()?;
    Ok(())
}

fn prepare(input: Input, output: &Path) -> Result<serde_json::Value> {
    if !input.audio_path.is_absolute()
        || !output.is_absolute()
        || input.source_id.is_empty()
        || input.source_id.len() > 100
        || !input
            .source_id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_".contains(&c))
        || input.profiles.is_empty()
        || input.profiles.len() > 2
        || (input.profiles.len() == 2 && input.profiles[0] == input.profiles[1])
    {
        return Err("Invalid source identity, profiles or absolute paths".into());
    }
    for name in &input.profiles {
        profile(name)?;
    }
    if hash_file(&input.audio_path)? != input.audio_sha256 {
        return Err("Source hash differs".into());
    }
    let mut file = File::open(&input.audio_path)?;
    let (offset, total_samples) = wav_data(&mut file)?;
    if input.start_sample >= input.end_sample
        || input.end_sample > total_samples
        || input.end_sample - input.start_sample > 3600 * 16_000
    {
        return Err("Select a nonempty range of at most one hour".into());
    }
    let mut vad = SileroVad::open(input.assets.clone())?;
    file.seek(SeekFrom::Start(offset + input.start_sample * 2))?;
    let analysis = vad.analyze_pcm16(
        (&mut file).take((input.end_sample - input.start_sample) * 2),
        &AtomicBool::new(false),
        |_| {},
    )?;
    if analysis.total_samples != input.end_sample - input.start_sample {
        return Err("VAD sample count differs".into());
    }
    let pauses = analysis
        .pauses
        .iter()
        .map(|p| surtitle_ai::Pause {
            start_sample: p.start_sample + input.start_sample,
            end_sample: p.end_sample + input.start_sample,
        })
        .collect::<Vec<_>>();
    // Never overwrite a previous preparation, including an interrupted one.
    fs::create_dir(output)?;
    let mut selections = Vec::new();
    for name in &input.profiles {
        let options = profile(name)?;
        let chunks = plan_chunks(input.start_sample, input.end_sample, &pauses, options)?;
        let mut entries = Vec::new();
        for chunk in &chunks {
            let id = format!("{}-{}-{:03}", input.source_id, name, chunk.index);
            let path = output.join(format!("{id}.wav"));
            write_wav(
                &mut file,
                offset,
                chunk.request_start_sample,
                chunk.request_end_sample,
                &path,
            )?;
            entries.push(json!({"id":id,"index":chunk.index,"coreStartSample":chunk.core_start_sample,"coreEndSample":chunk.core_end_sample,"requestStartSample":chunk.request_start_sample,"requestEndSample":chunk.request_end_sample,"boundary":chunk.boundary,"audioPath":path,"audioSha256":hash_file(&path)?}));
        }
        selections.push(json!({"id":format!("{}-{name}",input.source_id),"sourceId":input.source_id,"profileId":name,"startSample":input.start_sample,"endSample":input.end_sample,"options":options,"chunks":entries}));
    }
    if hash_file(&input.audio_path)? != input.audio_sha256 {
        return Err("Source changed during preparation".into());
    }
    Ok(
        json!({"schemaVersion":1,"sourceId":input.source_id,"sourceAudioSha256":input.audio_sha256,"sampleRate":16000,"totalSamples":total_samples,"vadSourceStartSample":input.start_sample,"vad":analysis,"assets":input.assets,"selections":selections,"generationRequests":0}),
    )
}

fn main() -> Result<()> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 2 {
        return Err("Usage: transcribe_prepare INPUT_JSON ABS_FRESH_OUTPUT_DIRECTORY".into());
    }
    let input_path = PathBuf::from(&args[0]);
    if fs::metadata(&input_path)?.len() > 2 * 1024 * 1024 {
        return Err("Input document too large".into());
    }
    let input = serde_json::from_slice(&fs::read(input_path)?)?;
    let output = PathBuf::from(&args[1]);
    let result = prepare(input, &output)?;
    let mut receipt = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(output.join("preparation.json"))?;
    serde_json::to_writer_pretty(&mut receipt, &result)?;
    receipt.sync_all()?;
    println!(
        "{}",
        json!({"preparation":output.join("preparation.json"),"generationRequests":0})
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    const PCM_FORMAT: [u8; 16] = [1, 0, 1, 0, 128, 62, 0, 0, 0, 125, 0, 0, 2, 0, 16, 0];

    fn authored_riff(chunks: &[(&[u8; 4], &[u8])]) -> Vec<u8> {
        let mut bytes = b"RIFF\0\0\0\0WAVE".to_vec();
        for (kind, payload) in chunks {
            bytes.extend_from_slice(*kind);
            bytes.extend_from_slice(&(payload.len() as u32).to_le_bytes());
            bytes.extend_from_slice(payload);
            if payload.len() % 2 != 0 {
                bytes.push(0);
            }
        }
        let size = (bytes.len() as u32 - 8).to_le_bytes();
        bytes[4..8].copy_from_slice(&size);
        bytes
    }

    #[test]
    fn padded_ancillary_chunks_do_not_shift_pcm_samples() {
        let temp = tempfile::tempdir().unwrap();
        let pcm = [0, 128, 255, 255, 0, 0, 1, 0, 255, 127];
        let bytes = authored_riff(&[
            (b"fmt ", &PCM_FORMAT),
            (b"JUNK", &[9, 8, 7]),
            (b"data", &pcm),
            (b"LIST", &[1]),
        ]);
        let path = temp.path().join("ancillary.wav");
        fs::write(&path, bytes).unwrap();
        let mut file = File::open(path).unwrap();
        let (offset, samples) = wav_data(&mut file).unwrap();
        assert_eq!((offset, samples), (56, 5));
        file.seek(SeekFrom::Start(offset)).unwrap();
        let mut actual = [0u8; 10];
        file.read_exact(&mut actual).unwrap();
        assert_eq!(actual, pcm);
    }

    #[test]
    fn malformed_riff_cannot_supply_a_partial_or_ambiguous_audio_range() {
        let temp = tempfile::tempdir().unwrap();
        let pcm = [1, 0, 2, 0];
        let valid = authored_riff(&[(b"fmt ", &PCM_FORMAT), (b"data", &pcm)]);
        let mut bad_length = valid.clone();
        bad_length[4..8].copy_from_slice(&(valid.len() as u32 - 6).to_le_bytes());
        let mut data_overrun = valid.clone();
        data_overrun[40..44].copy_from_slice(&6u32.to_le_bytes());
        let mut stereo = PCM_FORMAT;
        stereo[2] = 2;
        let mut wrong_rate = PCM_FORMAT;
        wrong_rate[4..8].copy_from_slice(&8000u32.to_le_bytes());
        let mut truncated_header = valid.clone();
        truncated_header.push(0);
        let size = (truncated_header.len() as u32 - 8).to_le_bytes();
        truncated_header[4..8].copy_from_slice(&size);
        let mut missing_pad = authored_riff(&[
            (b"fmt ", &PCM_FORMAT),
            (b"JUNK", &[1, 2, 3]),
            (b"data", &pcm),
        ]);
        missing_pad.remove(47);
        let size = (missing_pad.len() as u32 - 8).to_le_bytes();
        missing_pad[4..8].copy_from_slice(&size);
        for (name, bytes) in [
            ("riff-length", bad_length),
            ("data-overrun", data_overrun),
            (
                "duplicate-fmt",
                authored_riff(&[
                    (b"fmt ", &PCM_FORMAT),
                    (b"fmt ", &PCM_FORMAT),
                    (b"data", &pcm),
                ]),
            ),
            (
                "duplicate-data",
                authored_riff(&[(b"fmt ", &PCM_FORMAT), (b"data", &pcm), (b"data", &pcm)]),
            ),
            (
                "odd-pcm",
                authored_riff(&[(b"fmt ", &PCM_FORMAT), (b"data", &[1, 0, 2])]),
            ),
            (
                "empty-pcm",
                authored_riff(&[(b"fmt ", &PCM_FORMAT), (b"data", &[])]),
            ),
            ("missing-fmt", authored_riff(&[(b"data", &pcm)])),
            (
                "stereo",
                authored_riff(&[(b"fmt ", &stereo), (b"data", &pcm)]),
            ),
            (
                "wrong-rate",
                authored_riff(&[(b"fmt ", &wrong_rate), (b"data", &pcm)]),
            ),
            ("truncated-chunk-header", truncated_header),
            ("missing-ancillary-padding", missing_pad),
        ] {
            let path = temp.path().join(format!("{name}.wav"));
            fs::write(&path, bytes).unwrap();
            assert!(wav_data(&mut File::open(path).unwrap()).is_err(), "{name}");
        }
    }
    #[test]
    fn profiles_keep_overlap_and_preserve_every_original_sample() {
        for name in ["current120", "short60"] {
            let options = profile(name).unwrap();
            let chunks = plan_chunks(7, 240 * 16000 + 7, &[], options).unwrap();
            assert_eq!(chunks.first().unwrap().core_start_sample, 7);
            assert_eq!(chunks.last().unwrap().core_end_sample, 240 * 16000 + 7);
            assert!(chunks
                .windows(2)
                .all(|w| w[0].core_end_sample == w[1].core_start_sample));
            assert_eq!(options.context_ms, 3000);
        }
        assert!(profile("unknown").is_err());
    }
    #[test]
    fn wav_slice_has_exact_nonzero_source_samples_and_rejects_overwrite() {
        let temp = tempfile::tempdir().unwrap();
        let raw = temp.path().join("input.pcm");
        let bytes: Vec<u8> = (0..16007_i16).flat_map(i16::to_le_bytes).collect();
        fs::write(&raw, &bytes).unwrap();
        let mut source = File::open(raw).unwrap();
        let path = temp.path().join("slice.wav");
        write_wav(&mut source, 0, 7, 16007, &path).unwrap();
        let mut sliced = File::open(&path).unwrap();
        let (offset, samples) = wav_data(&mut sliced).unwrap();
        assert_eq!((offset, samples), (44, 16000));
        assert_eq!(&fs::read(&path).unwrap()[44..], &bytes[14..]);
        assert!(write_wav(&mut source, 0, 7, 16007, &path).is_err());
    }
}
