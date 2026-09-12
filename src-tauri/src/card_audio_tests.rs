use super::*;

fn range(start_ms: u64, end_ms: u64) -> AudioClipRange {
    AudioClipRange { start_ms, end_ms }
}

fn wave(samples: &[i16], rate: u32) -> Vec<u8> {
    let bytes = samples.len() as u32 * 2;
    let mut wav = b"RIFF".to_vec();
    wav.extend_from_slice(&(bytes + 36).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt \x10\0\0\0\x01\0\x01\0");
    wav.extend_from_slice(&rate.to_le_bytes());
    wav.extend_from_slice(&(rate * 2).to_le_bytes());
    wav.extend_from_slice(b"\x02\0\x10\0data");
    wav.extend_from_slice(&bytes.to_le_bytes());
    for sample in samples {
        wav.extend_from_slice(&sample.to_le_bytes());
    }
    wav
}

#[test]
fn six_hour_seek_keeps_bounded_preroll_and_absolute_sample_times() {
    for start in [0, 150, 999, 1000, 1999, 3000, 21_600_123] {
        let args = arguments(
            Path::new("日本語 & source.mp4"),
            4,
            range(start, start + 750),
            Path::new("out.wav"),
        )
        .unwrap();
        let after = |key: &str| {
            args[args.iter().position(|arg| arg == key).unwrap() + 1]
                .to_str()
                .unwrap()
        };
        let seek_ms = if args.iter().any(|arg| arg == "-ss") {
            after("-ss").parse::<u64>().unwrap() * 1000
        } else {
            0
        };
        assert!(seek_ms <= start && start - seek_ms < 3000);
        assert!(after("-af").contains(&format!(
            "start_pts={}:end_pts={}",
            start * 16,
            (start + 750) * 16
        )));
        assert_eq!(after("-t"), "0.750");
        assert_eq!(after("-i"), "日本語 & source.mp4");
        assert_eq!(after("-map"), "0:4");
        assert!(!after("-af").contains("apad"));
        assert!(!after("-af").contains("async"));
    }
    assert!(
        arguments(
            Path::new("in"),
            0,
            range(u64::MAX - 100, u64::MAX),
            Path::new("out")
        )
        .is_err()
    );
    assert!(arguments(Path::new("in"), 0, range(0, 182001), Path::new("out")).is_err());
}

#[test]
fn wav_requires_exact_pcm_range_and_rejects_truncation_and_wrong_format() {
    let temporary = tempfile::tempdir().unwrap();
    let path = temporary.path().join("clip.wav");
    for (count, rate, accepted) in [
        (12000, 16000, true),
        (11930, 16000, false),
        (12001, 16000, false),
        (12000, 48000, false),
    ] {
        std::fs::write(&path, wave(&vec![123; count], rate)).unwrap();
        assert_eq!(validate_wav(&path, range(3000, 3750)).is_ok(), accepted);
    }
    let mut truncated = wave(&vec![123; 12000], 16000);
    truncated.truncate(truncated.len() - 2);
    std::fs::write(&path, truncated).unwrap();
    assert!(validate_wav(&path, range(3000, 3750)).is_err());
}

fn ffmpeg(executable: &Path, args: &[OsString]) {
    let result = std::process::Command::new(executable)
        .args(["-nostdin", "-v", "error", "-n"])
        .args(args)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
}

fn reference(executable: &Path, source: &Path, output: &Path) -> Vec<i16> {
    ffmpeg(
        executable,
        &[
            "-i".into(),
            source.as_os_str().to_owned(),
            "-map".into(),
            "0:a:0".into(),
            "-ac".into(),
            "1".into(),
            "-ar".into(),
            "16000".into(),
            "-c:a".into(),
            "pcm_s16le".into(),
            "-f".into(),
            "s16le".into(),
            output.as_os_str().to_owned(),
        ],
    );
    std::fs::read(output)
        .unwrap()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|s| i16::from_le_bytes(*s))
        .collect()
}

fn pcm(path: &Path) -> Vec<i16> {
    let bytes = std::fs::read(path).unwrap();
    let mut position = 12;
    while &bytes[position..position + 4] != b"data" {
        let length =
            u32::from_le_bytes(bytes[position + 4..position + 8].try_into().unwrap()) as usize;
        position += 8 + length + length % 2;
    }
    let length = u32::from_le_bytes(bytes[position + 4..position + 8].try_into().unwrap()) as usize;
    bytes[position + 8..position + 8 + length]
        .as_chunks::<2>()
        .0
        .iter()
        .map(|s| i16::from_le_bytes(*s))
        .collect()
}

fn aligned(actual: &[i16], reference: &[i16], label: &str, lossless: bool) {
    assert_eq!(actual.len(), reference.len(), "{label}");
    // Different decoder/resampler block sizes can change PCM rounding by one unit.
    // A nonperiodic reference makes even a single-sample displacement fail clearly.
    let maximum = actual
        .iter()
        .zip(reference)
        .map(|(a, b)| (i32::from(*a) - i32::from(*b)).abs())
        .max()
        .unwrap();
    if lossless {
        assert!(
            maximum <= 2,
            "{label}: source-clock waveform differs by {maximum}"
        );
    } else {
        // Stateful compressed decoders can synthesize slightly different noise after
        // seeking. Verify the best waveform alignment is zero samples, not just its length.
        let errors: Vec<(i32, f64)> = (-4..=4)
            .map(|shift| {
                let squared = (4..actual.len() - 4)
                    .map(|i| {
                        let difference = f64::from(actual[i])
                            - f64::from(reference[(i as i32 + shift) as usize]);
                        difference * difference
                    })
                    .sum::<f64>();
                (shift, squared)
            })
            .collect();
        let best = errors.iter().min_by(|a, b| a.1.total_cmp(&b.1)).unwrap();
        assert_eq!(best.0, 0, "{label}: shifted source waveform {errors:?}");
        let energy = reference.iter().map(|s| f64::from(*s).powi(2)).sum::<f64>();
        assert!(
            best.1 < energy * 0.0001,
            "{label}: excessive waveform error"
        );
    }
}

#[tokio::test]
#[ignore = "explicit local FFmpeg integration: set SURTITLE_TEST_FFMPEG"]
async fn installed_ffmpeg_preserves_native_rate_wav_tail_without_padding() {
    let executable =
        PathBuf::from(std::env::var_os("SURTITLE_TEST_FFMPEG").expect("Set SURTITLE_TEST_FFMPEG"));
    let snapshot = ToolSnapshot::capture(
        surtitle_tools::resolve_external(surtitle_tools::ToolKind::FfmpegPair, &executable)
            .unwrap(),
    )
    .unwrap();
    let temporary = tempfile::tempdir().unwrap();
    let directory = temporary.path().join("cards");
    std::fs::create_dir(&directory).unwrap();
    let source = temporary.path().join("日本語 & native-rate.wav");
    let samples: Vec<i16> = (0..128000)
        .map(|n| {
            let time = f64::from(n) / 16000.;
            ((std::f64::consts::TAU * (123. * time + 71.3 * time * time)).sin() * 12000.) as i16
        })
        .collect();
    std::fs::write(&source, wave(&samples, 16000)).unwrap();
    for requested in [range(7050, 7750), range(7350, 8000)] {
        let output = extract(&snapshot, &source, 0, requested, &directory)
            .await
            .unwrap();
        // The authored PCM is an independent, exact source-clock reference.
        assert_eq!(
            pcm(&output),
            samples[requested.start_ms as usize * 16..requested.end_ms as usize * 16]
        );
        std::fs::remove_file(output).unwrap();
    }
    assert!(
        extract(&snapshot, &source, 0, range(7350, 8050), &directory)
            .await
            .is_err(),
        "A duration estimate beyond EOF must not pad a partial card clip"
    );
    assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 0);
    assert_eq!(std::fs::read(&source).unwrap(), wave(&samples, 16000));
}

#[tokio::test]
#[ignore = "explicit local FFmpeg integration: set SURTITLE_TEST_FFMPEG"]
async fn installed_ffmpeg_preserves_source_clock_and_cleans_failed_outputs() {
    let executable =
        PathBuf::from(std::env::var_os("SURTITLE_TEST_FFMPEG").expect("Set SURTITLE_TEST_FFMPEG"));
    let snapshot = ToolSnapshot::capture(
        surtitle_tools::resolve_external(surtitle_tools::ToolKind::FfmpegPair, &executable)
            .unwrap(),
    )
    .unwrap();
    let temporary = tempfile::tempdir().unwrap();
    let directory = temporary.path().join("cards");
    std::fs::create_dir(&directory).unwrap();
    for rate in [44100, 48000] {
        let source = temporary.path().join(format!("日本語 & {rate}.wav"));
        let samples: Vec<i16> = (0..rate * 8)
            .map(|n| {
                let time = f64::from(n) / f64::from(rate);
                ((std::f64::consts::TAU * (123. * time + 71.3 * time * time)).sin() * 12000.) as i16
            })
            .collect();
        std::fs::write(&source, wave(&samples, rate)).unwrap();
        for codec in ["wav", "m4a", "mp3"] {
            let encoded = if codec == "wav" {
                source.clone()
            } else {
                let path = source.with_extension(codec);
                ffmpeg(
                    &executable,
                    &[
                        "-i".into(),
                        source.as_os_str().to_owned(),
                        path.as_os_str().to_owned(),
                    ],
                );
                path
            };
            let reference = reference(
                &executable,
                &encoded,
                &encoded.with_extension(format!("{codec}.pcm")),
            );
            for requested in [
                range(0, 750),
                range(150, 1050),
                range(2850, 3900),
                range(3000, 3750),
                range(2000, 4750),
                range(7000, 8000),
            ] {
                let path = extract(&snapshot, &encoded, 0, requested, &directory)
                    .await
                    .unwrap();
                aligned(
                    &pcm(&path),
                    &reference[requested.start_ms as usize * 16..requested.end_ms as usize * 16],
                    &format!("{rate}/{codec}/{requested:?}"),
                    codec == "wav",
                );
                std::fs::remove_file(path).unwrap();
            }
        }
    }
    let source = temporary.path().join("日本語 & 48000.wav");
    for offset in [0.25, 21600.] {
        let delayed = temporary.path().join(format!("delayed-{offset}.mkv"));
        ffmpeg(
            &executable,
            &[
                "-f".into(),
                "lavfi".into(),
                "-i".into(),
                "color=s=16x16:r=1:d=1".into(),
                "-itsoffset".into(),
                offset.to_string().into(),
                "-i".into(),
                source.as_os_str().to_owned(),
                "-map".into(),
                "0:v:0".into(),
                "-map".into(),
                "1:a:0".into(),
                "-c:v".into(),
                "ffv1".into(),
                "-c:a".into(),
                "pcm_s16le".into(),
                delayed.as_os_str().to_owned(),
            ],
        );
        let reference = reference(&executable, &source, &delayed.with_extension("pcm"));
        let start_ms = (offset * 1000.) as u64 + 3000;
        let output = extract(
            &snapshot,
            &delayed,
            1,
            range(start_ms, start_ms + 750),
            &directory,
        )
        .await
        .unwrap();
        aligned(
            &pcm(&output),
            &reference[48000..60000],
            &format!("offset {offset}"),
            true,
        );
        std::fs::remove_file(output).unwrap();
        assert!(
            extract(&snapshot, &delayed, 1, range(0, 750), &directory)
                .await
                .is_err()
        );
        assert_eq!(
            std::fs::read_dir(&directory).unwrap().count(),
            0,
            "Incomplete clip leaked an output"
        );
    }
    let shifted = temporary.path().join("nonzero-format-origin.mkv");
    ffmpeg(
        &executable,
        &[
            "-i".into(),
            source.as_os_str().to_owned(),
            "-c:a".into(),
            "pcm_s16le".into(),
            "-output_ts_offset".into(),
            "5".into(),
            shifted.as_os_str().to_owned(),
        ],
    );
    let shifted_reference = reference(&executable, &source, &shifted.with_extension("pcm"));
    for requested in [range(0, 750), range(3000, 3750)] {
        let output = extract(&snapshot, &shifted, 0, requested, &directory)
            .await
            .unwrap();
        aligned(
            &pcm(&output),
            &shifted_reference[requested.start_ms as usize * 16..requested.end_ms as usize * 16],
            "nonzero format origin",
            true,
        );
        std::fs::remove_file(output).unwrap();
    }
    assert!(
        extract(
            &snapshot,
            &temporary.path().join("missing.mp4"),
            0,
            range(3000, 3750),
            &directory
        )
        .await
        .is_err()
    );
    assert_eq!(
        std::fs::read_dir(&directory).unwrap().count(),
        0,
        "Failed process leaked an output"
    );
}
