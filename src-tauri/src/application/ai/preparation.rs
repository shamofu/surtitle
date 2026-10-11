use super::*;

pub(super) fn transcription_range(
    segments: &[surtitle_core::SubtitleSegment],
    mut start_ms: u64,
    mut end_ms: u64,
    duration_ms: u64,
) -> Result<(u64, u64)> {
    ensure!(
        start_ms < end_ms && end_ms <= duration_ms,
        "Select a range inside the recording"
    );
    loop {
        let previous = (start_ms, end_ms);
        for cue in segments.iter().filter(|cue| cue.timing_precision == "cue") {
            if cue.start_ms < end_ms && cue.end_ms > start_ms {
                start_ms = start_ms.min(cue.start_ms);
                end_ms = end_ms.max(cue.end_ms);
            }
        }
        if previous == (start_ms, end_ms) {
            ensure!(
                end_ms <= duration_ms,
                "Subtitle range exceeds the recording"
            );
            return Ok((start_ms, end_ms));
        }
    }
}

pub async fn prepare_transcription(
    app: tauri::AppHandle,
    state: AppState,
    media_id: String,
    start_ms: u64,
    end_ms: u64,
    whole_media: bool,
) -> std::result::Result<PreparationSummary, String> {
    prepare_transcription_with_operation(app, state, media_id, start_ms, end_ms, whole_media, None)
        .await
}

pub async fn prepare_transcription_with_operation(
    app: tauri::AppHandle,
    state: AppState,
    media_id: String,
    start_ms: u64,
    end_ms: u64,
    whole_media: bool,
    operation_id: Option<String>,
) -> std::result::Result<PreparationSummary, String> {
    let receipt = prepare_transcription_receipt_with_operation(
        app,
        state.clone(),
        media_id,
        start_ms,
        end_ms,
        whole_media,
        operation_id,
    )
    .await
    .map_err(err)?;
    let range = build_transcript_draft(&receipt, &[]).map_err(|e| e.to_string())?;
    Ok(PreparationSummary {
        id: receipt.id,
        audio_stream_index: receipt.audio_stream_index,
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
        whole_media,
    })
}

pub(crate) async fn prepare_transcription_receipt(
    app: tauri::AppHandle,
    state: AppState,
    media_id: String,
    start_ms: u64,
    end_ms: u64,
    whole_media: bool,
) -> Result<AudioPreparationReceipt> {
    prepare_transcription_receipt_with_operation(
        app,
        state,
        media_id,
        start_ms,
        end_ms,
        whole_media,
        None,
    )
    .await
}

/// Dropping an invocation must stop its workers and release the single preparation slot.
struct PreparationReservation {
    state: AppState,
    cancel: PreparationCancellation,
}
impl Drop for PreparationReservation {
    fn drop(&mut self) {
        self.cancel
            .local
            .store(true, std::sync::atomic::Ordering::Relaxed);
        self.cancel.network.cancel();
        if let Ok(mut current) = lock(&self.state.ai_session.preparation)
            && current
                .as_ref()
                .is_some_and(|active| active.id == self.cancel.id)
        {
            *current = None;
        }
    }
}

async fn prepare_transcription_receipt_with_operation(
    app: tauri::AppHandle,
    state: AppState,
    media_id: String,
    start_ms: u64,
    end_ms: u64,
    whole_media: bool,
    operation_id: Option<String>,
) -> Result<AudioPreparationReceipt> {
    ensure!(end_ms > start_ms, "select an audio interval");
    let label = lock(&state.db)?.media(&media_id)?.title;
    let (activity, cancel) = {
        let mut current = lock(&state.ai_session.preparation)?;
        ensure!(current.is_none(), "audio preparation is already running");
        let activity = state.operations.start(
            "preparation",
            &label,
            crate::application::operations::OperationContext {
                id: operation_id,
                media_id: Some(&media_id),
                ..Default::default()
            },
        )?;
        let cancel = PreparationCancellation {
            id: activity.reporter().id().to_owned(),
            local: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            network: surtitle_tools::CancellationToken::new(),
        };
        *current = Some(cancel.clone());
        (activity, cancel)
    };
    let reporter = activity.reporter();
    let _reservation = PreparationReservation {
        state: state.clone(),
        cancel: cancel.clone(),
    };
    let operation = async {
        let (media, revision, start_ms, end_ms) = {
            let db = lock(&state.db)?;
            let media = db.media(&media_id)?;
            let segments = db.list_segments(&media_id)?;
            let (start_ms, end_ms) =
                transcription_range(&segments, start_ms, end_ms, media.duration_ms)?;
            (media, transcript_fingerprint(&segments)?, start_ms, end_ms)
        };
        ensure!(
            !whole_media || (start_ms == 0 && media.duration_ms > 0 && end_ms == media.duration_ms),
            "Whole-media transcription requires the complete known media duration"
        );
        reporter.progress("inspecting", None, None, None);
        let audio_stream_index = crate::application::media_tools::ensure_audio_stream_with_context(
            &state,
            &media_id,
            &cancel.network,
            Some(reporter.id()),
        )
        .await?;
        reporter.progress("preparing", None, None, None);
        let model = crate::application::tool_runtime::install_vad(
            &state,
            &cancel.network,
            Some(reporter.id()),
            Some(&media_id),
        )
        .await?;
        let (lease, _) = crate::application::media_tools::lease_with_context(
            &state,
            &[surtitle_tools::ToolKind::FfmpegPair],
            &cancel.network,
            Some(reporter.id()),
            Some(&media_id),
        )
        .await?;
        let snapshot = lease.get(surtitle_tools::ToolKind::FfmpegPair)?.clone();
        let assets = VadAssets {
            runtime_path: lock(&state.runtime_dir)?.join("onnxruntime.dll"),
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
        let local_cancel = cancel.local.clone();
        let worker_progress = reporter.clone();
        let mut receipt = tauri::async_runtime::spawn_blocking(move || {
            let _lease = lease;
            prepare_audio(
                std::path::Path::new(&media.path),
                &root,
                &snapshot,
                assets,
                options,
                local_cancel,
                |progress| {
                    match progress.phase.as_str() {
                        "detecting_speech" => worker_progress.progress(
                            &progress.phase,
                            Some(progress.processed_ms),
                            Some(progress.total_ms),
                            Some("milliseconds"),
                        ),
                        "extracting" => worker_progress.progress(
                            "extracting_audio",
                            Some(progress.processed_ms),
                            Some(progress.total_ms),
                            Some("milliseconds"),
                        ),
                        "prepared" => worker_progress.progress("saving", None, None, None),
                        _ => worker_progress.progress(&progress.phase, None, None, None),
                    }
                    let _ = app.emit("preparation-progress", &progress);
                },
            )
        })
        .await??;
        reporter.progress("saving", None, None, None);
        receipt.prepared_job = receipt
            .prepared_job
            .with_apply_policy(TranscriptApplyPolicy::Auto)?;
        surtitle_core::store::write_json_atomic(&receipt.directory.join("receipt.json"), &receipt)?;
        surtitle_core::store::write_json_atomic(
            &receipt.directory.join("whole-media.json"),
            &whole_media,
        )?;
        Ok::<_, anyhow::Error>(receipt)
    }
    .await;
    let result_id = operation.as_ref().ok().map(|receipt| receipt.id.as_str());
    activity.finish(&operation, cancel.network.is_cancelled(), result_id);
    operation
}

pub fn cancel_preparation(state: AppState) -> std::result::Result<(), String> {
    cancel_preparation_with_operation(state, None)
}
pub fn cancel_preparation_with_operation(
    state: AppState,
    operation_id: Option<String>,
) -> std::result::Result<(), String> {
    (|| {
        if let Some(cancel) = lock(&state.ai_session.preparation)?.as_ref()
            && operation_id.as_ref().is_none_or(|id| id == &cancel.id)
        {
            cancel
                .local
                .store(true, std::sync::atomic::Ordering::Relaxed);
            cancel.network.cancel();
        }
        Ok(())
    })()
    .map_err(err)
}

#[cfg(test)]
mod operation_tests {
    use super::*;

    #[test]
    fn cancelling_an_older_preparation_cannot_cancel_the_current_one() {
        let directory = tempfile::tempdir().unwrap();
        let state =
            Services::open_with_tool_path(directory.path().join("data"), std::ffi::OsStr::new(""))
                .unwrap();
        let cancel = PreparationCancellation {
            id: surtitle_core::id(),
            local: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            network: surtitle_tools::CancellationToken::new(),
        };
        *lock(&state.ai_session.preparation).unwrap() = Some(cancel.clone());
        cancel_preparation_with_operation(state.clone(), Some(surtitle_core::id())).unwrap();
        assert!(!cancel.network.is_cancelled());
        assert!(!cancel.local.load(std::sync::atomic::Ordering::Relaxed));
        cancel_preparation_with_operation(state.clone(), Some(cancel.id.clone())).unwrap();
        assert!(cancel.network.is_cancelled());
        assert!(cancel.local.load(std::sync::atomic::Ordering::Relaxed));
        drop(PreparationReservation {
            state: state.clone(),
            cancel,
        });
        assert!(lock(&state.ai_session.preparation).unwrap().is_none());
    }
}
