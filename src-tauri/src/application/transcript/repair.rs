use super::*;

pub(super) fn validate_repair_parent(
    state: &AppState,
    receipt: &AudioPreparationReceipt,
    parent: &RepairParent,
) -> Result<()> {
    let binding = load_binding(state, &parent.job_id)?;
    ensure!(
        lock(&state.db)?
            .transcript_adopted(&parent.job_id, &binding.job_digest)?
            .is_none(),
        "the repair parent was already adopted"
    );
    let (_, draft, _) = load_draft(state, &binding)?;
    let range = boundary_repair_range(&draft, &parent.draft_digest, &parent.boundary_id)?;
    let prepared_range = build_transcript_draft(receipt, &[])?;
    ensure!(
        range.start_ms == parent.start_ms
            && range.end_ms == parent.end_ms
            && receipt.chunks.len() == 1
            && prepared_range.start_ms == range.start_ms
            && prepared_range.end_ms == range.end_ms
            && receipt.chunks[0].request_duration_ms() <= 30_000
            && receipt.source_sha256 == draft.source_sha256,
        "repair preparation differs from the reviewed parent boundary"
    );
    Ok(())
}
pub async fn prepare_boundary_repair(
    app: tauri::AppHandle,
    state: AppState,
    job_id: String,
    draft_digest: String,
    boundary_id: String,
) -> std::result::Result<crate::application::ai::AiQuote, String> {
    let state = state.clone();
    async {
        let inspect_state = state.clone();
        let (media_id, range, parent, reused) = tauri::async_runtime::spawn_blocking(move || {
            let state = inspect_state;
            let _review = lock(&state.ai_session.transcript_review)?;
            let binding = load_binding(&state, &job_id)?;
            let (source, draft, _) = load_draft(&state, &binding)?;
            ensure!(
                lock(&state.db)?
                    .transcript_adopted(&job_id, &binding.job_digest)?
                    .is_none(),
                "adopted transcripts do not accept automatic repair"
            );
            let range = boundary_repair_range(&draft, &draft_digest, &boundary_id)?;
            verify_source(&state, &source, true)?;
            let parent = RepairParent {
                job_id,
                draft_digest,
                boundary_id,
                start_ms: range.start_ms,
                end_ms: range.end_ms,
            };
            for receipt in receipts(&state)? {
                if let Some(saved) = repair_parent(&receipt)?
                    && saved.job_id == parent.job_id
                    && saved.draft_digest == parent.draft_digest
                    && saved.boundary_id == parent.boundary_id
                {
                    validate_repair_parent(&state, &receipt, &saved)?;
                    return Ok::<_, anyhow::Error>((
                        draft.media_id,
                        range,
                        parent,
                        Some(create_audio_quote(&state, &receipt.id)?),
                    ));
                }
            }
            Ok((draft.media_id, range, parent, None))
        })
        .await??;
        if let Some(quote) = reused {
            return Ok(quote);
        }
        let receipt = crate::application::ai::preparation::prepare_transcription_receipt(
            app,
            state.clone(),
            media_id,
            range.start_ms,
            range.end_ms,
        )
        .await?;
        tauri::async_runtime::spawn_blocking(move || {
            let _review = lock(&state.ai_session.transcript_review)?;
            surtitle_core::store::write_json_atomic(
                &receipt.directory.join("repair-parent.json"),
                &parent,
            )?;
            validate_repair_parent(&state, &receipt, &parent)?;
            create_audio_quote(&state, &receipt.id)
        })
        .await?
    }
    .await
    .map_err(err)
}
