// SPDX-License-Identifier: GPL-3.0-or-later
//! Explicit local integration fixture, independent of saved provider outputs.
//! No speech recordings are embedded or downloaded by this test.
use super::*;
use crate::{
    acknowledge_transcript_warning, build_transcript_draft, validate_transcript_adoption,
    ChunkResponse, GeneratedCue, ParsedOutput,
};

const INPUTS: [(&str, &str); 6] = [
    (
        "1089-134686-0001-pcm16.wav",
        "c65ee5ee7bd8acab3ac6b97a29100187f397cccc4d1b00ae4ec31f39f3f7d3ab",
    ),
    (
        "1089-134686-0003-pcm16.wav",
        "6786f692cd28a02b4c26d5bb5683b778fb2c6ae09bb6243355f1bc30e66eb5e3",
    ),
    (
        "1089-134686-0001.TextGrid",
        "7af2a45d42e7ca8fcad6310fd2e2089adf883cf346873c138c1a0815ea1aa0e6",
    ),
    (
        "1089-134686-0003.TextGrid",
        "7b10f440fa9b2d662e0b3bf3bd330a4181eea3c57ef3a93d03041cb18cced9f3",
    ),
    (
        "1089-134686-0001.txt",
        "0a82f678afe953b8ac316479bbe3548169e249817dfc236153c5aad966da92b3",
    ),
    (
        "1089-134686-0003.txt",
        "47ad56a9f71a9af9df360a3825070def4355bc4bf65defe6a180237f1d90677e",
    ),
];

#[test]
#[ignore = "requires explicit SURTITLE_SPOKEN_FIXTURES, SURTITLE_TEST_FFMPEG and existing pinned native assets; no network"]
fn real_spoken_audio_and_interior_pause_require_only_local_warning_review() {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap();
    let fixture_root = PathBuf::from(
        std::env::var_os("SURTITLE_SPOKEN_FIXTURES")
            .expect("explicit existing LibriSpeech fixture directory"),
    );
    assert!(fixture_root.is_absolute());
    let fixtures: Vec<_> = INPUTS
        .iter()
        .map(|(file, expected)| {
            let path = fixture_root.join(file);
            assert!(std::fs::metadata(&path).unwrap().len() <= 1024 * 1024);
            let bytes = std::fs::read(path).unwrap();
            assert_eq!(sha256_bytes(&bytes), *expected, "Fixture differs: {file}");
            bytes
        })
        .collect();
    let first_pcm = pcm16(&fixtures[0]);
    let second_pcm = pcm16(&fixtures[1]);
    assert_eq!(first_pcm.len() / 2, 52_400);
    assert_eq!(second_pcm.len() / 2, 42_880);
    assert!(first_pcm.iter().any(|byte| *byte != 0));
    assert!(second_pcm.iter().any(|byte| *byte != 0));

    // Copy both recordings unchanged; the known zero interval is constructed,
    // not inferred from the source references or any model response.
    let mut source_pcm = vec![0_u8; 16_000 * 2];
    source_pcm.extend(first_pcm);
    let pause_start_sample = source_pcm.len() as u64 / 2;
    source_pcm.resize(source_pcm.len() + 4 * 16_000 * 2, 0);
    let pause_end_sample = source_pcm.len() as u64 / 2;
    source_pcm.extend(second_pcm);
    let selected_end_sample = source_pcm.len() as u64 / 2;
    source_pcm.resize(source_pcm.len() + 16_000 * 2, 0);
    assert_eq!((pause_start_sample, pause_end_sample), (68_400, 132_400));
    assert_eq!(selected_end_sample, 175_280);

    let root = repo.join("work/vad-spoken-pause-acceptance");
    std::fs::create_dir_all(&root).unwrap();
    let directory = tempfile::Builder::new()
        .prefix("spoken-pause-")
        .tempdir_in(root)
        .unwrap();
    let source = directory.path().join("constructed-spoken-pause.wav");
    std::fs::write(&source, wav16(&source_pcm)).unwrap();
    let assets = VadAssets {
        runtime_path: repo.join("src-tauri/resources/native/onnxruntime.dll"),
        runtime_sha256: "69d8e6d3879a3b4001cdc74c8ed9ccc7e7f799a5b847059738323404519ec471".into(),
        model_path: repo.join("work/native-fixtures/silero_vad.onnx"),
        model_sha256: SILERO_MODEL_SHA256.into(),
    };
    let ffmpeg = ToolSnapshot::capture(
        surtitle_tools::resolve_external(
            ToolKind::FfmpegPair,
            &PathBuf::from(std::env::var_os("SURTITLE_TEST_FFMPEG").expect("explicit FFmpeg path")),
        )
        .unwrap(),
    )
    .unwrap();
    let receipt = prepare_audio(
        &source,
        &directory.path().join("prepared"),
        &ffmpeg,
        assets.clone(),
        AudioPreparationOptions {
            media_id: "local-spoken-pause-fixture".into(),
            transcript_revision: "local-reference-v1".into(),
            title: "Local spoken pause integration".into(),
            project_id: String::new(),
            credential_id: String::new(),
            language: "en".into(),
            start_ms: 1000,
            end_ms: 10_955,
            audio_stream_index: Some(0),
            chunks: ChunkOptions::default(),
            provider: AudioTranscriptionProvider::TranscribePreview,
        },
        Arc::new(AtomicBool::new(false)),
        |_| {},
    )
    .unwrap();
    assert!(
        receipt.prepared_job.validate().is_err(),
        "Local input grants no paid authority"
    );
    assert_eq!(receipt.chunks.len(), 1);
    assert!(
        receipt.vad_no_speech_ordinals.is_empty(),
        "The chunk contains real speech"
    );
    let evidence = receipt.vad_pause_evidence.as_ref().unwrap();
    evidence.validate().unwrap();
    assert_eq!(
        (evidence.source_start_sample, evidence.source_end_sample),
        (16_000, selected_end_sample)
    );
    assert_eq!(evidence.model_sha256, assets.model_sha256);
    assert_eq!(evidence.runtime_sha256, assets.runtime_sha256);

    // Independently saved upstream MFA word spans: 0.330–2.800 s and
    // 0.430–2.460 s, rebased only by the exact composition sample offsets.
    // They are automatic reference anchors, not human timing ground truth.
    let first_text = std::str::from_utf8(&fixtures[4]).unwrap().trim();
    let second_text = std::str::from_utf8(&fixtures[5]).unwrap().trim();
    let raw = vec![
        GeneratedCue {
            start_ms: 1330,
            end_ms: 3800,
            text: first_text.into(),
        },
        GeneratedCue {
            start_ms: 5500,
            end_ms: 6500,
            text: "This subtitle was deliberately invented for the local test.".into(),
        },
        GeneratedCue {
            start_ms: 8705,
            end_ms: 10735,
            text: second_text.into(),
        },
    ];
    let draft = build_transcript_draft(
        &receipt,
        &[ChunkResponse {
            ordinal: 0,
            output: ParsedOutput::Transcript { cues: raw.clone() },
        }],
    )
    .unwrap();
    eprintln!(
        "Strict VAD evidence: {}",
        serde_json::to_string(evidence).unwrap()
    );
    assert_eq!(draft.warnings.len(), 1);
    assert_eq!(draft.warnings[0].kind, "speech_in_vad_pause_range");
    assert!(draft.warnings[0].start_ms <= 5500 && draft.warnings[0].end_ms >= 6500);
    assert_eq!(
        draft
            .segments
            .iter()
            .map(|cue| cue.status.as_str())
            .collect::<Vec<_>>(),
        ["confirmed", "provisional", "confirmed"]
    );
    for (actual, original) in draft.chunks[0].segments.iter().zip(&raw) {
        assert_eq!(
            (&actual.text, actual.start_ms, actual.end_ms),
            (&original.text, original.start_ms, original.end_ms)
        );
    }
    assert_eq!(draft.chunks[0].segments.len(), raw.len());
    assert!(!draft.can_adopt);
    assert!(validate_transcript_adoption(&draft, &draft.digest).is_err());
    assert!(acknowledge_transcript_warning(&draft, "stale", &draft.warnings[0].id).is_err());
    let reviewed =
        acknowledge_transcript_warning(&draft, &draft.digest, &draft.warnings[0].id).unwrap();
    assert!(reviewed.can_adopt);
    assert_eq!(reviewed.chunks, draft.chunks);
    assert_ne!(reviewed.digest, draft.digest);
    validate_transcript_adoption(&reviewed, &reviewed.digest).unwrap();

    let RequestTask::TranscribePreview { audio, .. } = &receipt.prepared_job.requests[0] else {
        panic!("audio expected");
    };
    let args: Vec<OsString> = ["-nostdin", "-hide_banner", "-loglevel", "error", "-i"]
        .into_iter()
        .map(Into::into)
        .chain([audio.path.as_os_str().to_owned()])
        .chain(
            [
                "-f",
                "s16le",
                "-acodec",
                "pcm_s16le",
                "-ar",
                "16000",
                "-ac",
                "1",
                "pipe:1",
            ]
            .into_iter()
            .map(Into::into),
        )
        .collect();
    let (mut child, stdout) = LocalChild::start(
        &ffmpeg,
        &args,
        true,
        Arc::new(AtomicBool::new(false)),
        Duration::from_secs(30),
    )
    .unwrap();
    let mut decoded = Vec::new();
    stdout
        .unwrap()
        .take(1024 * 1024)
        .read_to_end(&mut decoded)
        .unwrap();
    child.finish().unwrap();
    let selected_pcm = &source_pcm[32_000..selected_end_sample as usize * 2];
    assert_eq!(
        decoded, selected_pcm,
        "Preparation must retain every selected PCM sample"
    );
    for ((file, expected), bytes) in INPUTS.iter().zip(&fixtures) {
        assert_eq!(
            sha256_bytes(&std::fs::read(fixture_root.join(file)).unwrap()),
            *expected
        );
        assert_eq!(sha256_bytes(bytes), *expected);
    }
    let receipt_bytes = std::fs::read(receipt.directory.join("receipt.json")).unwrap();
    let saved: AudioPreparationReceipt = serde_json::from_slice(&receipt_bytes).unwrap();
    assert_eq!(saved.vad_pause_evidence, receipt.vad_pause_evidence);
    assert_eq!(saved.source_sha256, hash_file(&source).unwrap());
    let report = serde_json::json!({
        "schemaVersion": 1, "reportKind": "local-spoken-interior-pause-integration", "passed": true,
        "sourceProvenance": {"dataset":"LibriSpeech via MontrealCorpusTools/aligned-librispeech", "commit":"5143690d1a6ebcd37b7f4d1b0f9fa8c83944aba5", "license":"CC-BY-4.0", "privateEvaluationCopy":true,
            "inputs": INPUTS.iter().map(|(file, sha256)| serde_json::json!({"file":file,"sha256":sha256})).collect::<Vec<_>>()},
        "referenceProvenance": {"timing":"independent upstream automatic MFA word intervals; not human ground truth", "responseKind":"authored local fixture; no provider response", "inventedCueIndex":1},
        "composition": {"leadingSamples":16000,"firstSpeechSamples":52400,"insertedPauseSamples":64000,"secondSpeechSamples":42880,"trailingSamples":16000,
            "pauseStartSample":pause_start_sample,"pauseEndSample":pause_end_sample,"selectedStartSample":16000,"selectedEndSample":selected_end_sample},
        "sourceSha256":receipt.source_sha256, "selectedPcmSha256":sha256_bytes(selected_pcm), "preparedPcmSha256":sha256_bytes(&decoded),
        "receiptSha256":sha256_bytes(&receipt_bytes), "receiptPath":receipt.directory.join("receipt.json"),
        "vadPauseEvidence":evidence,"warnings":draft.warnings,"rawResponse":raw,"draft":draft,"reviewedDigest":reviewed.digest,
        "ffmpeg":ffmpeg,"localPreparationCalls":1,"additionalInferenceCalls":0,"pcmPreserved":true,"sourceInputsUnchanged":true,
        "networkRequests":0,"ledgerChanges":0,"adoptions":0,"modelQualified":false,
        "limitations":["Two clean English utterances and constructed digital silence, not representative noisy/conversational audio.","This checks local warning plumbing and sample preservation; it does not evaluate cloud recognition or improve retained corpus scores."]
    });
    let report_path = directory.path().join("report.json");
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&report_path)
        .unwrap()
        .write_all(&serde_json::to_vec_pretty(&report).unwrap())
        .unwrap();
    let retained = directory.keep();
    eprintln!(
        "Retained spoken-pause evidence: {}",
        retained.join("report.json").display()
    );
}

fn pcm16(wav: &[u8]) -> &[u8] {
    assert_eq!(&wav[..4], b"RIFF");
    assert_eq!(&wav[8..12], b"WAVE");
    let mut offset = 12;
    let mut valid_format = false;
    while offset + 8 <= wav.len() {
        let length = u32::from_le_bytes(wav[offset + 4..offset + 8].try_into().unwrap()) as usize;
        let data = &wav[offset + 8..offset + 8 + length];
        match &wav[offset..offset + 4] {
            b"fmt " => {
                assert_eq!(&data[..4], &[1, 0, 1, 0]);
                assert_eq!(u32::from_le_bytes(data[4..8].try_into().unwrap()), 16_000);
                assert_eq!(&data[12..16], &[2, 0, 16, 0]);
                valid_format = true;
            }
            b"data" => {
                assert!(valid_format && length.is_multiple_of(2));
                return data;
            }
            _ => {}
        }
        offset += 8 + length + length % 2;
    }
    panic!("PCM data missing");
}

fn wav16(pcm: &[u8]) -> Vec<u8> {
    let mut wav = b"RIFF".to_vec();
    wav.extend((36 + pcm.len() as u32).to_le_bytes());
    wav.extend(b"WAVEfmt ");
    wav.extend(16_u32.to_le_bytes());
    wav.extend([1, 0, 1, 0]);
    wav.extend(16_000_u32.to_le_bytes());
    wav.extend(32_000_u32.to_le_bytes());
    wav.extend([2, 0, 16, 0]);
    wav.extend(b"data");
    wav.extend((pcm.len() as u32).to_le_bytes());
    wav.extend(pcm);
    wav
}
