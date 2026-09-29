use super::*;

pub async fn prepare_transcription(
    app: tauri::AppHandle,
    state: AppState,
    media_id: String,
    start_ms: u64,
    end_ms: u64,
) -> std::result::Result<PreparationSummary, String> {
    let receipt = prepare_transcription_receipt(app, state.clone(), media_id, start_ms, end_ms)
        .await
        .map_err(err)?;
    let range = build_transcript_draft(&receipt, &[]).map_err(|e| e.to_string())?;
    Ok(PreparationSummary {
        id: receipt.id,
        media_id: receipt.prepared_job.binding.media_id,
        start_ms: range.start_ms,
        end_ms: range.end_ms,
        core_duration_ms: range.end_ms - range.start_ms,
        send_duration_ms: receipt
            .chunks
            .iter()
            .map(AudioChunk::request_duration_ms)
            .sum(),
        chunk_count: receipt.chunks.len(),
    })
}

pub(crate) async fn prepare_transcription_receipt(
    app: tauri::AppHandle,
    state: AppState,
    media_id: String,
    start_ms: u64,
    end_ms: u64,
) -> Result<AudioPreparationReceipt> {
    async {
        ensure!(end_ms > start_ms, "select an audio interval");
        let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        {
            let mut current = lock(&state.ai_session.preparation)?;
            ensure!(current.is_none(), "audio preparation is already running");
            *current = Some(cancel.clone());
        }
        let operation = async {
            let (media, revision) = {
                let db = lock(&state.db)?;
                (
                    db.media(&media_id)?,
                    transcript_fingerprint(&db.list_segments(&media_id)?)?,
                )
            };
            let audio_stream_index =
                crate::application::media_tools::ensure_audio_stream(&state, &media_id).await?;
            let model = install_silero_model(&state.root.join("models")).await?;
            let lease = crate::application::media_tools::lease(
                &state,
                &[surtitle_tools::ToolKind::FfmpegPair],
            )
            .await?;
            let snapshot = lease.get(surtitle_tools::ToolKind::FfmpegPair)?.clone();
            let assets = VadAssets {
                runtime_path: lock(&state.runtime_dir)?.join("onnxruntime.dll"),
                runtime_sha256: runtime_hash("onnxruntime.dll")?,
                model_path: model,
                model_sha256: SILERO_MODEL_SHA256.into(),
            };
            let p = state.preferences.read()?.clone();
            let options = AudioPreparationOptions {
                media_id,
                transcript_revision: revision,
                title: media.title,
                project_id: p.settings.vertex_project,
                credential_id: p.credential_id.unwrap_or_default(),
                language: media.learning_language,
                start_ms,
                end_ms,
                chunks: ChunkOptions::default(),
                provider: AudioTranscriptionProvider::TranscribePreview,
                audio_stream_index: Some(audio_stream_index),
            };
            let root = state.root.join("prepared");
            let receipt = tauri::async_runtime::spawn_blocking(move || {
                let _lease = lease;
                prepare_audio(
                    std::path::Path::new(&media.path),
                    &root,
                    &snapshot,
                    assets,
                    options,
                    cancel,
                    |progress| {
                        let _ = app.emit("preparation-progress", &progress);
                    },
                )
            })
            .await??;
            Ok::<_, anyhow::Error>(receipt)
        }
        .await;
        *lock(&state.ai_session.preparation)? = None;
        operation
    }
    .await
}

pub fn cancel_preparation(state: AppState) -> std::result::Result<(), String> {
    (|| {
        if let Some(cancel) = lock(&state.ai_session.preparation)?.as_ref() {
            cancel.store(true, std::sync::atomic::Ordering::Relaxed);
        }
        Ok(())
    })()
    .map_err(err)
}
