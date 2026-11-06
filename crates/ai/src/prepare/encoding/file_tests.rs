use super::*;
use crate::{AudioChunkProfile, BoundaryKind};

#[test]
#[ignore = "required native validation; needs SURTITLE_TEST_FFMPEG; no API calls"]
fn openai_file_real_encoding_splits_only_oversized_files_and_preserves_pcm() {
    let path =
        PathBuf::from(std::env::var_os("SURTITLE_TEST_FFMPEG").expect("explicit FFmpeg path"));
    let ffmpeg = ToolSnapshot::capture(
        surtitle_tools::resolve_external(surtitle_tools::ToolKind::FfmpegPair, &path).unwrap(),
    )
    .unwrap();
    let temp = tempfile::tempdir().unwrap();
    let spool = temp.path().join("noise.pcm");
    let mut source = std::fs::File::create(&spool).unwrap();
    let mut random = 0x1234_5678_u32;
    let mut buffer = [0_u8; 32_000];
    for second in 0..900 {
        for sample in buffer.as_chunks_mut::<2>().0 {
            random ^= random << 13;
            random ^= random >> 17;
            random ^= random << 5;
            sample.copy_from_slice(&(random as i16).to_le_bytes());
        }
        // Real silence, including a long compressed tail: duration ratios alone
        // overestimate the fitting prefix of this nonuniform recording.
        if (700..704).contains(&second) || second >= 800 {
            buffer.fill(0);
        }
        source.write_all(&buffer).unwrap();
    }
    source.sync_all().unwrap();
    drop(source);
    let profile: AudioChunkProfile = serde_json::from_str("\"openai_file_silence\"").unwrap();
    let whole = plan_chunks(0, 900 * 16_000, &[], ChunkOptions::for_profile(profile))
        .unwrap()
        .remove(0);
    let pauses = [
        Pause {
            start_sample: 700 * 16_000,
            end_sample: 704 * 16_000,
        },
        Pause {
            start_sample: 800 * 16_000,
            end_sample: 900 * 16_000,
        },
    ];
    let (chunks, audio) = encode_openai_file_silence(
        &spool,
        temp.path(),
        whole.clone(),
        &pauses,
        &ffmpeg,
        Arc::new(AtomicBool::new(false)),
        |_, _| {},
    )
    .unwrap();
    assert_eq!(chunks.len(), 2);
    assert_eq!(chunks[0].boundary, BoundaryKind::StrongPause);
    assert_eq!(chunks[0].core_end_sample, 702 * 16_000);
    assert_eq!(
        chunks[0]
            .boundary_provenance
            .as_ref()
            .unwrap()
            .supporting_pause,
        Some(pauses[0])
    );
    assert_eq!(chunks[0].request_end_sample, chunks[1].request_start_sample);
    assert_eq!(crate::total_request_samples(&chunks).unwrap(), 900 * 16_000);
    assert!(audio.iter().all(|file| file.byte_len <= 25_000_000));
    assert!(audio[0].duration_ms > 240_000);
    assert_decoded_pcm(&spool, temp.path(), &ffmpeg, &audio);

    // A missed VAD pause must still yield measured, contiguous files, with the
    // explicit forced-cut warning rather than a false claim of non-speech.
    let forced_directory = temp.path().join("forced");
    std::fs::create_dir(&forced_directory).unwrap();
    let (forced, forced_audio) = encode_openai_file_silence(
        &spool,
        &forced_directory,
        whole,
        &[],
        &ffmpeg,
        Arc::new(AtomicBool::new(false)),
        |_, _| {},
    )
    .unwrap();
    assert_eq!(forced.len(), 2);
    assert_eq!(forced[0].boundary, BoundaryKind::Forced);
    assert!(forced[0]
        .boundary_provenance
        .as_ref()
        .unwrap()
        .supporting_pause
        .is_none());
    assert_eq!(forced[0].request_end_sample, forced[1].request_start_sample);
    assert_eq!(crate::total_request_samples(&forced).unwrap(), 900 * 16_000);
    assert!(forced_audio.iter().all(|file| file.byte_len <= 25_000_000));
    assert_decoded_pcm(&spool, &forced_directory, &ffmpeg, &forced_audio);

    // Vertex's base64 envelope has a smaller file budget. Reuse the same
    // irregular compression input to verify the limit is measured per service.
    let vertex_directory = temp.path().join("vertex-bytes");
    std::fs::create_dir(&vertex_directory).unwrap();
    let limits = crate::VertexAudioPolicy::TranscribeFileV1.limits();
    let (vertex_chunks, vertex_audio) = encode_file_silence(
        &spool,
        &vertex_directory,
        plan_chunks(
            0,
            900 * 16_000,
            &[],
            ChunkOptions::for_profile(AudioChunkProfile::VertexTranscribeFileSilence),
        )
        .unwrap()
        .remove(0),
        &pauses,
        limits,
        &ffmpeg,
        Arc::new(AtomicBool::new(false)),
        |_, _| {},
    )
    .unwrap();
    assert!(vertex_chunks.len() > 1);
    assert_eq!(vertex_chunks[0].boundary, BoundaryKind::Forced);
    assert!(vertex_audio
        .iter()
        .all(|audio| audio.byte_len <= limits.maximum_bytes
            && audio.duration_ms <= limits.maximum_duration_ms));
    assert_decoded_pcm(&spool, &vertex_directory, &ffmpeg, &vertex_audio);
    assert_vertex_duration_limits(temp.path(), &ffmpeg);
}

fn assert_vertex_duration_limits(root: &Path, ffmpeg: &ToolSnapshot) {
    // Compressible audio makes duration the limiting factor, independent of
    // upload size. Exactly 15 minutes must remain a single request.
    let spool = root.join("duration.pcm");
    std::fs::File::create(&spool)
        .unwrap()
        .set_len(1000 * 32_000)
        .unwrap();
    let pauses = [Pause {
        start_sample: 880 * 16_000,
        end_sample: 884 * 16_000,
    }];
    for (name, seconds, policy, evidence, expected_count, kind) in [
        (
            "at-limit",
            900,
            crate::VertexAudioPolicy::TranscribeFileV1,
            pauses.as_slice(),
            1,
            BoundaryKind::EndOfSelection,
        ),
        (
            "duration-pause",
            1000,
            crate::VertexAudioPolicy::TranscribeFileV1,
            pauses.as_slice(),
            2,
            BoundaryKind::StrongPause,
        ),
        (
            "duration-forced",
            1000,
            crate::VertexAudioPolicy::TranscribeFileV1,
            &[][..],
            2,
            BoundaryKind::Forced,
        ),
        (
            "gemini-whole",
            1000,
            crate::VertexAudioPolicy::AudioUnderstandingFileV1,
            pauses.as_slice(),
            1,
            BoundaryKind::EndOfSelection,
        ),
    ] {
        let directory = root.join(name);
        std::fs::create_dir(&directory).unwrap();
        let whole = plan_chunks(
            0,
            seconds * 16_000,
            &[],
            ChunkOptions::for_profile(AudioChunkProfile::VertexTranscribeFileSilence),
        )
        .unwrap()
        .remove(0);
        let (chunks, audio) = encode_file_silence(
            &spool,
            &directory,
            whole,
            evidence,
            policy.limits(),
            ffmpeg,
            Arc::new(AtomicBool::new(false)),
            |_, _| {},
        )
        .unwrap();
        assert_eq!(chunks.len(), expected_count, "{name}");
        assert_eq!(chunks[0].boundary, kind, "{name}");
        assert_eq!(
            crate::total_request_samples(&chunks).unwrap(),
            seconds * 16_000
        );
        assert!(audio
            .iter()
            .all(|audio| audio.duration_ms <= policy.limits().maximum_duration_ms));
        if seconds == 1000 {
            assert_decoded_pcm(&spool, &directory, ffmpeg, &audio);
        }
    }
}

fn assert_decoded_pcm(
    spool: &Path,
    directory: &Path,
    ffmpeg: &ToolSnapshot,
    audio: &[AudioAttachment],
) {
    let combined_path = directory.join("decoded-all.pcm");
    let mut combined = std::fs::File::create(&combined_path).unwrap();
    for file in audio {
        let args = vec![
            "-nostdin".into(),
            "-v".into(),
            "error".into(),
            "-i".into(),
            file.path.as_os_str().to_owned(),
            "-f".into(),
            "s16le".into(),
            "-acodec".into(),
            "pcm_s16le".into(),
            "pipe:1".into(),
        ];
        let (mut child, reader) = LocalChild::start(
            ffmpeg,
            &args,
            true,
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(600),
        )
        .unwrap();
        std::io::copy(&mut reader.unwrap(), &mut combined).unwrap();
        child.finish().unwrap();
    }
    combined.sync_all().unwrap();
    assert_eq!(
        crate::hash_file(&combined_path).unwrap(),
        crate::hash_file(spool).unwrap()
    );
    assert!(!directory.join("candidate.flac").exists());
}
