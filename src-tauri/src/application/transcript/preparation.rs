use super::*;

pub fn list_transcription_preparations(
    state: AppState,
    media_id: String,
) -> std::result::Result<Vec<TranscriptionPreparation>, String> {
    (|| {
        let bindings = job_bindings(&state)?;
        let settings = state.preferences.read()?.settings.clone();
        receipts(&state)?
            .into_iter()
            .filter(|receipt| receipt.prepared_job.binding.media_id == media_id)
            .map(|receipt| {
                let parent = repair_parent(&receipt)?;
                let range = build_transcript_draft(&receipt, &[])?;
                Ok(TranscriptionPreparation {
                    provider: receipt
                        .preparation_context
                        .as_ref()
                        .map_or(surtitle_core::AiProvider::Vertex, |c| c.provider),
                    ai_configuration_generation: receipt
                        .preparation_context
                        .as_ref()
                        .map_or(0, |c| c.configuration_generation),
                    compatible: super::policy::compatible(&receipt, &settings, parent.is_some()),
                    chunk_profile: receipt.chunk_profile,
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
    let parent = repair_parent(&receipt)?;
    if let Some(parent) = &parent {
        validate_repair_parent(state, &receipt, parent)?;
    }
    let p = state.preferences.read()?.clone();
    ensure!(
        super::policy::compatible(&receipt, &p.settings, parent.is_some()),
        "Prepare audio again for the selected service and current configuration"
    );
    let provider = p.settings.active_provider;
    let generation = p.settings.ai_configuration_generation;
    let inherited = parent
        .as_ref()
        .map(|parent| -> Result<_> {
            let original = state.ai.prepared_job(&parent.job_id)?;
            Ok((original.execution.provider == provider).then(|| {
                crate::application::models::preference_for(
                    &original.execution,
                    matches!(
                        original.requests.first(),
                        Some(RequestTask::TranscribePreview { .. })
                    ),
                )
            }))
        })
        .transpose()?
        .flatten();
    let selected = super::policy::selected_model(&p.settings, selected.or(inherited))?;
    ensure!(
        super::policy::compatible_selected(&receipt, &p.settings, parent.is_some(), &selected),
        "Prepare audio again for the selected transcription mode"
    );
    let mut execution = crate::application::models::execution_for(
        &p.settings,
        "transcription",
        Some(selected.clone()),
    )?;
    if provider == surtitle_core::AiProvider::Vertex {
        execution.vertex_audio_policy =
            super::policy::vertex_policy(&selected.transcription_mode, parent.is_some());
    }
    if provider == surtitle_core::AiProvider::Openai {
        execution.openai_audio_chunking_strategy = super::policy::OPENAI_CHUNKING_STRATEGY;
        execution.openai_audio_language_hint_format = (execution.model_id == "gpt-transcribe")
            .then_some(surtitle_ai::OpenAiAudioLanguageHintFormat::Languages);
        execution.openai_audio_prompt = (execution.model_id == "gpt-transcribe")
            .then_some(super::policy::OPENAI_AUDIO_PROMPT)
            .flatten()
            .map(str::to_owned);
    }
    for task in &receipt.prepared_job.requests {
        audio_attachment(task)
            .context("audio request missing")?
            .verify_integrity_with_limits(execution.audio_limits())?;
    }
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
            && (p.credential_for(provider).is_none()
                || (p.credential_for(provider)
                    == Some(existing.prepared_job.credential_id.as_str())
                    && existing.prepared_job.project_id == p.settings.project_for(provider)
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
            if !retry {
                state.preferences.update(|p| {
                    p.quote_generations.insert(quote.id.clone(), generation);
                    Ok(())
                })?;
            }
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
        p.settings.project_for(provider).to_owned(),
        p.credential_for(provider)
            .context("Configure this service before creating a cloud quote")?
            .to_owned(),
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
    state.preferences.update(|p| {
        p.quote_generations.insert(quote.id.clone(), generation);
        Ok(())
    })?;
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
    provider: Option<surtitle_core::AiProvider>,
    ai_configuration_generation: Option<u64>,
) -> std::result::Result<crate::application::ai::AiQuote, String> {
    let state = state.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _review = lock(&state.ai_session.transcript_review)?;
        let _transition = state.preferences.settings_transition()?;
        crate::application::models::verify_ai_selection(
            &state.preferences.read()?.settings,
            provider,
            ai_configuration_generation,
        )?;
        create_audio_quote_selected(&state, &preparation_id, model)
    })
    .await
    .map_err(|_| "audio quote was interrupted".to_string())?
    .map_err(err)
}
