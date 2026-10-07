use super::*;

#[cfg(feature = "e2e-test")]
pub(crate) fn seed_transcript_review_fixture(state: &AppState) -> Result<()> {
    let Some(preset) = std::env::var_os("SURTITLE_E2E_TRANSCRIPT_REVIEW") else {
        return Ok(());
    };
    ensure!(preset == "boundary", "unknown transcript review fixture");
    let root = PathBuf::from(
        std::env::var_os("SURTITLE_E2E_DATA_DIR")
            .context("transcript fixture requires an isolated data directory")?,
    );
    ensure!(
        root.is_absolute() && root.canonicalize()? == state.root.canonicalize()?,
        "transcript fixture data directory differs"
    );
    seed_fixture_data(state)
}
#[cfg(feature = "e2e-test")]
pub(super) fn fixture_wav(seconds: u32) -> Vec<u8> {
    let length = seconds * 32000;
    let mut bytes = b"RIFF".to_vec();
    bytes.extend_from_slice(&(length + 36).to_le_bytes());
    bytes
        .extend_from_slice(b"WAVEfmt \x10\0\0\0\x01\0\x01\0\x80\x3e\0\0\0\x7d\0\0\x02\0\x10\0data");
    bytes.extend_from_slice(&length.to_le_bytes());
    bytes.resize(length as usize + 44, 0);
    bytes
}
#[cfg(feature = "e2e-test")]
pub(crate) fn fixture_receipt(
    state: &AppState,
    media_id: &str,
    preparation_id: &str,
    repair: bool,
) -> Result<AudioPreparationReceipt> {
    let directory = state.root.join("prepared").join(if repair {
        "e2e-transcript-repair"
    } else {
        media_id
    });
    fs::create_dir_all(&directory)?;
    let directory = directory.canonicalize()?;
    let source = state.root.join("media").join(format!("{media_id}.wav"));
    let source = source.canonicalize()?;
    let source_sha256 = hash_file(&source)?;
    let mut requests = Vec::new();
    let mut chunks = Vec::new();
    for index in 0..if repair { 1 } else { 2 } {
        let path = directory.join(format!("chunk-{index}.wav"));
        fs::write(&path, fixture_wav(if repair { 8 } else { 7 }))?;
        let request_start = if index == 0 { 0 } else { 1000 };
        requests.push(RequestTask::TranscribePreview {
            language: "en".into(),
            audio: AudioAttachment::from_file(
                path,
                request_start,
                if repair { 8000 } else { 7000 },
            )?,
        });
        chunks.push(AudioChunk {
            index,
            sample_rate: 16000,
            core_start_sample: if index == 0 { 0 } else { 64000 },
            core_end_sample: if repair || index == 1 { 128000 } else { 64000 },
            request_start_sample: request_start * 16,
            request_end_sample: if repair || index == 1 { 128000 } else { 112000 },
            boundary: if repair || index == 1 {
                BoundaryKind::EndOfSelection
            } else {
                BoundaryKind::Forced
            },
        });
    }
    let tool = directory.join("offline-fixture-tool.txt");
    fs::write(&tool, b"This is fixture provenance, not an executable.")?;
    let ffmpeg = surtitle_tools::ToolSnapshot::capture(surtitle_tools::ResolvedTool {
        kind: surtitle_tools::ToolKind::FfmpegPair,
        source: surtitle_tools::ToolSource::Managed,
        selected_path: tool.clone(),
        executable: tool,
        ffprobe: None,
    })?;
    let receipt = AudioPreparationReceipt {
        id: preparation_id.into(),
        directory: directory.clone(),
        source_path: source,
        source_sha256: source_sha256.clone(),
        audio_stream_index: Some(0),
        model_sha256: SILERO_MODEL_SHA256.into(),
        vad_no_speech_ordinals: vec![],
        vad_pause_evidence: None,
        ffmpeg,
        chunks,
        prepared_job: PreparedJob::new(
            if repair {
                "E2E transcript repair".into()
            } else {
                format!("E2E / {media_id}")
            },
            "e2e-project".into(),
            "unused-e2e-fixture".into(),
            PreparationBinding {
                media_id: media_id.into(),
                transcript_revision: surtitle_core::store::subtitle_revision(
                    &lock(&state.db)?.list_segments(media_id)?,
                )?,
                source_sha256,
                settings_sha256: crate::application::ai::bindings::settings_fingerprint(
                    &state.preferences.read()?.settings,
                )?,
            },
            requests,
            crate::application::models::fixture_execution(),
        )?,
        created_at_ms: chrono::Utc::now().timestamp_millis(),
    };
    surtitle_core::store::write_json_atomic(&directory.join("receipt.json"), &receipt)?;
    Ok(receipt)
}
#[cfg(feature = "e2e-test")]
pub(super) fn register_fixture_job(
    state: &AppState,
    receipt: &AudioPreparationReceipt,
    quote: &JobQuote,
    parent: Option<RepairParent>,
) -> Result<()> {
    save_binding(
        state,
        &TranscriptJob {
            job_id: quote.id.clone(),
            job_digest: quote.digest.clone(),
            preparation_id: receipt.id.clone(),
            receipt_sha256: hash_file(&receipt.directory.join("receipt.json"))?,
            repair_parent: parent,
            progressive: false,
            publication_detached: false,
        },
    )?;
    save_quote_context(state, receipt, &quote.id)
}
#[cfg(feature = "e2e-test")]
pub(crate) fn seed_fixture_data(state: &AppState) -> Result<()> {
    {
        let execution = crate::application::models::fixture_execution();
        let price = execution.price.unwrap();
        state.preferences.update(|prefs| {
            prefs
                .settings
                .ai_models
                .entry("transcription".into())
                .or_insert(surtitle_core::AiModelPreference {
                    model_id: execution.model_id,
                    transcription_mode: "transcribe".into(),
                    max_output_tokens: execution.max_output_tokens,
                    thinking_level: None,
                    thinking_budget: None,
                    price: Some(surtitle_core::AiPricePreference {
                        id: price.id,
                        source: price.source,
                        observed_at_ms: price.observed_at_ms,
                        input_microusd_per_million: price.input_microusd_per_million,
                        output_microusd_per_million: price.output_microusd_per_million,
                    }),
                });
            Ok(())
        })?;
    }
    let marker = state.root.join("e2e-transcript-fixture.json");
    if marker.exists() {
        return Ok(());
    }
    let mut complete_job = String::new();
    for (media_id, preparation_id, pending) in [
        (
            "e2e-transcript-review",
            "11111111-1111-4111-8111-111111111111",
            false,
        ),
        (
            "e2e-transcript-pending",
            "22222222-2222-4222-8222-222222222222",
            true,
        ),
    ] {
        let source = state.root.join("media").join(format!("{media_id}.wav"));
        fs::write(&source, fixture_wav(8))?;
        let mut db = lock(&state.db)?;
        db.put_media(&surtitle_core::Media {
            id: media_id.into(),
            title: format!("E2E / {media_id}"),
            path: source.to_string_lossy().into_owned(),
            source_url: None,
            kind: "audio".into(),
            duration_ms: 8000,
            learning_language: "en".into(),
            explanation_language: "ja".into(),
            created_at: surtitle_core::now(),
            last_position_ms: 0,
            segment_count: 1,
            card_count: 0,
            status: "ready".into(),
            error: None,
            audio_stream_index: Some(0),
            subtitle_stream_index: None,
        })?;
        db.set_segments(
            media_id,
            &[surtitle_core::SubtitleSegment {
                timing_precision: "cue".into(),
                id: format!("{media_id}-old"),
                media_id: media_id.into(),
                start_ms: 0,
                end_ms: 1000,
                text: "Original subtitle".into(),
                translation: Some("元の訳".into()),
                status: "confirmed".into(),
                review_issues: vec![],
            }],
        )?;
        drop(db);
        let receipt = fixture_receipt(state, media_id, preparation_id, false)?;
        let quote = state
            .ai
            .seed_transcript_review_fixture(receipt.prepared_job.clone(), pending)?;
        register_fixture_job(state, &receipt, &quote, None)?;
        if !pending {
            complete_job = quote.id;
        }
    }
    let binding = load_binding(state, &complete_job)?;
    let (_, draft, _) = load_draft(state, &binding)?;
    ensure!(
        draft.conflicts.len() == 1,
        "offline transcript fixture needs exactly one boundary conflict"
    );
    let range = boundary_repair_range(&draft, &draft.digest, &draft.conflicts[0].id)?;
    let parent = RepairParent {
        job_id: complete_job,
        draft_digest: draft.digest.clone(),
        boundary_id: draft.conflicts[0].id.clone(),
        start_ms: range.start_ms,
        end_ms: range.end_ms,
    };
    let repair = fixture_receipt(
        state,
        "e2e-transcript-review",
        "33333333-3333-4333-8333-333333333333",
        true,
    )?;
    surtitle_core::store::write_json_atomic(&repair.directory.join("repair-parent.json"), &parent)?;
    let quote = state.ai.prepare(repair.prepared_job.clone())?;
    register_fixture_job(state, &repair, &quote, Some(parent))?;
    surtitle_core::store::write_json_atomic(
        &marker,
        &serde_json::json!({"preset":"boundary","paidRequests":0}),
    )
}
