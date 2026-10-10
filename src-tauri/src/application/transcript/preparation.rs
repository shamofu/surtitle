use super::*;

pub fn list_transcription_preparations(
    state: AppState,
    media_id: String,
) -> std::result::Result<Vec<TranscriptionPreparation>, String> {
    (|| {
        let bindings = job_bindings(&state)?;
        receipts(&state)?
            .into_iter()
            .filter(|receipt| receipt.prepared_job.binding.media_id == media_id)
            .map(|receipt| {
                let parent = repair_parent(&receipt)?;
                let range = build_transcript_draft(&receipt, &[])?;
                Ok(TranscriptionPreparation {
                    id: receipt.id.clone(),
                    audio_stream_index: receipt.audio_stream_index,
                    media_id: media_id.clone(),
                    start_ms: range.start_ms,
                    end_ms: range.end_ms,
                    core_duration_ms: range.end_ms - range.start_ms,
                    send_duration_ms: receipt
                        .chunks
                        .iter()
                        .map(AudioChunk::request_duration_ms)
                        .sum(),
                    chunk_count: receipt.chunks.len(),
                    job_id: bindings
                        .iter()
                        .find(|b| b.preparation_id == receipt.id)
                        .map(|b| b.job_id.clone()),
                    repair_parent_job_id: parent.as_ref().map(|p| p.job_id.clone()),
                    repair_boundary_id: parent.map(|p| p.boundary_id),
                    whole_media: if receipt.directory.join("whole-media.json").exists() {
                        read_json(&receipt.directory.join("whole-media.json"))?
                    } else {
                        range.start_ms == 0
                            && range.end_ms == lock(&state.db)?.media(&media_id)?.duration_ms
                    },
                })
            })
            .collect::<Result<Vec<_>>>()
    })()
    .map_err(err)
}
pub(super) fn create_audio_quote(
    state: &AppState,
    preparation_id: &str,
) -> Result<crate::application::ai::AiQuote> {
    create_audio_quote_selected(state, preparation_id, None)
}
pub(super) fn create_audio_quote_selected(
    state: &AppState,
    preparation_id: &str,
    selected: Option<surtitle_core::AiModelPreference>,
) -> Result<crate::application::ai::AiQuote> {
    let receipt = load_receipt(state, preparation_id)?;
    verify_source(state, &receipt, true)?;
    for task in &receipt.prepared_job.requests {
        audio_attachment(task)
            .context("audio request missing")?
            .verify_integrity()?;
    }
    let parent = repair_parent(&receipt)?;
    if let Some(parent) = &parent {
        validate_repair_parent(state, &receipt, parent)?;
    }
    let p = state.preferences.read()?.clone();
    let inherited = parent
        .as_ref()
        .map(|parent| -> Result<_> {
            let original = state.ai.prepared_job(&parent.job_id)?;
            Ok(crate::application::models::preference_for(
                &original.execution,
                matches!(
                    original.requests.first(),
                    Some(RequestTask::TranscribePreview { .. })
                ),
            ))
        })
        .transpose()?;
    let selected = selected
        .or(inherited)
        .or_else(|| p.settings.ai_models.get("transcription").cloned())
        .context("Choose a Gemini model and transcription API mode")?;
    let execution = crate::application::models::execution_for(
        &p.settings,
        "transcription",
        Some(selected.clone()),
    )?;
    let requests = receipt
        .prepared_job
        .requests
        .iter()
        .map(|task| {
            let (language, audio) = match task {
                RequestTask::AudioTranscription { language, audio }
                | RequestTask::TranscribePreview { language, audio } => {
                    (language.clone(), audio.clone())
                }
                _ => anyhow::bail!("preparation contains a non-audio request"),
            };
            Ok(if selected.transcription_mode == "transcribe" {
                RequestTask::TranscribePreview { language, audio }
            } else {
                RequestTask::AudioTranscription { language, audio }
            })
        })
        .collect::<Result<Vec<_>>>()?;
    for binding in job_bindings(state)?
        .into_iter()
        .filter(|binding| binding.preparation_id == preparation_id)
    {
        let existing = receipt_for_job(state, &binding)?;
        ensure!(
            binding.repair_parent == parent,
            "repair parent metadata changed after its quote"
        );
        if existing.prepared_job.execution == execution
            && existing.prepared_job.requests == requests
            && (p.credential_id.is_none()
                || (p.credential_id.as_deref()
                    == Some(existing.prepared_job.credential_id.as_str())
                    && existing.prepared_job.project_id == p.settings.vertex_project
                    && existing.prepared_job.binding.settings_sha256
                        == crate::application::ai::bindings::settings_fingerprint(&p.settings)?))
        {
            let mut quote = state.ai.quote(&binding.job_id)?;
            if ["prepared", "paused", "needs_review"].contains(&quote.state.as_str())
                && quote.quote_expires_at_ms <= chrono::Utc::now().timestamp_millis()
            {
                quote = state.ai.refresh_quote(&binding.job_id)?;
            }
            if binding.progressive && !binding.publication_detached && quote.state == "prepared" {
                let range = build_transcript_draft(&receipt, &[])?;
                let mut db = lock(&state.db)?;
                let revision =
                    surtitle_core::store::subtitle_revision(&db.list_segments(&range.media_id)?)?;
                db.begin_transcript_publication(
                    &quote.id,
                    &quote.digest,
                    &range.media_id,
                    &revision,
                    range.start_ms,
                    range.end_ms,
                )?;
            }
            let retry = quote.state != "prepared";
            return crate::application::ai::quotes::quote_for_ui(state, quote, retry);
        }
    }
    let mut binding = receipt.prepared_job.binding.clone();
    binding.settings_sha256 = crate::application::ai::bindings::settings_fingerprint(&p.settings)?;
    let policy = if parent.is_none() {
        receipt.prepared_job.apply_policy
    } else {
        TranscriptApplyPolicy::Manual
    };
    let plan = PreparedJob::new(
        receipt.prepared_job.title.clone(),
        p.settings.vertex_project.clone(),
        p.credential_id
            .context("Import a service-account key before creating a cloud quote")?,
        binding,
        requests,
        execution,
    )?
    .with_apply_policy(policy)?;
    let quote = state.ai.prepare(plan)?;
    save_binding(
        state,
        &TranscriptJob {
            job_id: quote.id.clone(),
            job_digest: quote.digest.clone(),
            preparation_id: receipt.id.clone(),
            receipt_sha256: hash_file(&receipt.directory.join("receipt.json"))?,
            repair_parent: parent,
            progressive: policy == TranscriptApplyPolicy::Auto,
            publication_detached: false,
        },
    )?;
    save_quote_context(state, &receipt, &quote.id)?;
    if policy == TranscriptApplyPolicy::Auto {
        let range = build_transcript_draft(&receipt, &[])?;
        let mut db = lock(&state.db)?;
        let revision =
            surtitle_core::store::subtitle_revision(&db.list_segments(&range.media_id)?)?;
        db.begin_transcript_publication(
            &quote.id,
            &quote.digest,
            &range.media_id,
            &revision,
            range.start_ms,
            range.end_ms,
        )?;
    }
    crate::application::ai::quotes::quote_for_ui(state, quote, false)
}
pub(super) fn save_quote_context(
    state: &AppState,
    receipt: &AudioPreparationReceipt,
    job_id: &str,
) -> Result<()> {
    let range = build_transcript_draft(receipt, &[])?;
    state.preferences.update(|p| {
        p.quotes.insert(
            job_id.into(),
            QuoteContext {
                media_id: receipt.prepared_job.binding.media_id.clone(),
                kind: "transcribe".into(),
                start_ms: range.start_ms,
                end_ms: range.end_ms,
            },
        );
        Ok(())
    })
}
pub async fn create_transcription_quote(
    state: AppState,
    preparation_id: String,
    model: Option<surtitle_core::AiModelPreference>,
) -> std::result::Result<crate::application::ai::AiQuote, String> {
    let state = state.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _review = lock(&state.ai_session.transcript_review)?;
        create_audio_quote_selected(&state, &preparation_id, model)
    })
    .await
    .map_err(|_| "audio quote was interrupted".to_string())?
    .map_err(err)
}
