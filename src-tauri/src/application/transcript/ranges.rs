use super::*;

pub(super) fn range_binding(
    binding: &TranscriptJob,
    receipt: &AudioPreparationReceipt,
    ordinal: u32,
) -> Result<ManualRangeBinding> {
    let task = receipt
        .prepared_job
        .requests
        .get(ordinal as usize)
        .context("Unknown transcript range")?;
    let audio = audio_attachment(task).context("Transcript range has no prepared audio")?;
    Ok(ManualRangeBinding {
        job_id: binding.job_id.clone(),
        job_digest: binding.job_digest.clone(),
        preparation_id: receipt.id.clone(),
        source_sha256: receipt.source_sha256.clone(),
        source_revision: receipt.prepared_job.binding.transcript_revision.clone(),
        ordinal,
        request_start_ms: audio.source_start_ms,
        request_end_ms: audio.source_start_ms + audio.duration_ms,
        input_sha256: audio.sha256.clone(),
        request_sha256: sha256_bytes(&serde_json::to_vec(
            receipt.prepared_job.request_body_snapshot(ordinal)?,
        )?),
    })
}
pub(super) fn range_edits(
    state: &AppState,
    binding: &TranscriptJob,
    receipt: &AudioPreparationReceipt,
) -> Result<Vec<surtitle_core::store::TranscriptRangeEdit<ManualRangeRevision>>> {
    let mut saved = lock(&state.db)?
        .transcript_range_edits::<ManualRangeRevision>(&binding.job_id, &binding.job_digest)?;
    ensure!(
        saved
            .iter()
            .all(|e| (e.ordinal as usize) < receipt.chunks.len()),
        "Saved manual range is outside this preparation"
    );
    (0..receipt.chunks.len())
        .map(|ordinal| {
            let expected = range_binding(binding, receipt, ordinal as u32)?;
            let hash = sha256_bytes(&serde_json::to_vec(&expected)?);
            if let Some(index) = saved.iter().position(|e| e.ordinal == ordinal as u32) {
                let edit = saved.remove(index);
                ensure!(
                    edit.binding_sha256 == hash,
                    "Saved manual range binding changed"
                );
                for revision in [&edit.latest_revision, &edit.selected_revision]
                    .into_iter()
                    .flatten()
                {
                    revision.validate(&expected)?;
                }
                ensure!(
                    edit.selected_revision.as_ref().map(|r| &r.id)
                        == edit.selected_revision_id.as_ref(),
                    "Saved manual selection changed"
                );
                Ok(edit)
            } else {
                Ok(surtitle_core::store::TranscriptRangeEdit {
                    ordinal: ordinal as u32,
                    version: 0,
                    binding_sha256: hash,
                    selected_revision_id: None,
                    latest_revision: None,
                    selected_revision: None,
                })
            }
        })
        .collect()
}
pub(super) fn manual_editing_allowed(state: &AppState, binding: &TranscriptJob) -> Result<()> {
    ensure!(
        lock(&state.db)?
            .transcript_adopted(&binding.job_id, &binding.job_digest)?
            .is_none(),
        "Adopted transcript ranges cannot be changed"
    );
    let quote = state.ai.quote(&binding.job_id)?;
    ensure!(
        [
            "prepared",
            "paused",
            "cancelled",
            "completed",
            "needs_review"
        ]
        .contains(&quote.state.as_str()),
        "Pause the AI job before saving local range edits, then refresh"
    );
    ensure!(
        !state
            .ai
            .summary()?
            .unknown_attempts
            .iter()
            .any(|a| a.job_id == binding.job_id && a.state == "reserved"),
        "Wait for the in-flight request to finish after pausing, then refresh"
    );
    Ok(())
}

pub(super) fn save_manual_range(
    state: &AppState,
    job_id: &str,
    draft_digest: &str,
    ordinal: u32,
    expected_range_version: u64,
    content: ManualTranscriptContent,
) -> Result<TranscriptReview> {
    let _review = lock(&state.ai_session.transcript_review)?;
    let binding = load_binding(state, job_id)?;
    manual_editing_allowed(state, &binding)?;
    let (receipt, draft, _) = load_draft(state, &binding)?;
    ensure!(
        draft.digest == draft_digest,
        "Transcript review changed; refresh before saving"
    );
    verify_source(state, &receipt, false)?;
    let native_binding = range_binding(&binding, &receipt, ordinal)?;
    let binding_sha256 = sha256_bytes(&serde_json::to_vec(&native_binding)?);
    let revision = ManualRangeRevision {
        id: uuid::Uuid::new_v4().to_string(),
        ordinal,
        created_at: surtitle_core::now(),
        binding: native_binding,
        content,
    };
    revision.validate(&revision.binding)?;
    let mut selected = draft
        .chunks
        .iter()
        .filter(|c| c.ordinal != ordinal)
        .filter_map(|c| c.manual_revision.clone())
        .collect::<Vec<_>>();
    selected.push(revision.clone());
    let next_version = expected_range_version
        .checked_add(1)
        .context("Range version overflow")?;
    apply_manual_transcript_ranges(
        &draft,
        &[],
        &selected,
        &[(ordinal, next_version)],
        Some(&draft),
    )?;
    // This transaction touches only local review history, never attempts, holds,
    // responses or approvals. A later provider response cannot remove this choice.
    lock(&state.db)?.save_transcript_range_revision(
        job_id,
        &binding.job_digest,
        ordinal,
        &binding_sha256,
        expected_range_version,
        &revision.id,
        &revision,
    )?;
    let (_, updated, base_digest) = load_draft(state, &binding)?;
    lock(&state.db)?.save_transcript_draft(job_id, &binding.job_digest, &base_digest, &updated)?;
    view(state, job_id)
}
pub(super) fn select_range_source(
    state: &AppState,
    job_id: &str,
    draft_digest: &str,
    ordinal: u32,
    expected_range_version: u64,
    source: TranscriptRangeSelection,
) -> Result<TranscriptReview> {
    let _review = lock(&state.ai_session.transcript_review)?;
    let binding = load_binding(state, job_id)?;
    manual_editing_allowed(state, &binding)?;
    let (receipt, draft, _) = load_draft(state, &binding)?;
    ensure!(
        draft.digest == draft_digest,
        "Transcript review changed; refresh before selecting a source"
    );
    verify_source(state, &receipt, false)?;
    let hash = sha256_bytes(&serde_json::to_vec(&range_binding(
        &binding, &receipt, ordinal,
    )?)?);
    let id = match &source {
        TranscriptRangeSelection::Original => None,
        TranscriptRangeSelection::Manual { revision_id } => Some(revision_id.as_str()),
    };
    let mut selected = draft
        .chunks
        .iter()
        .filter(|c| c.ordinal != ordinal)
        .filter_map(|c| c.manual_revision.clone())
        .collect::<Vec<_>>();
    if let Some(id) = id {
        let revision: ManualRangeRevision = lock(&state.db)?.transcript_range_revision(
            job_id,
            &binding.job_digest,
            ordinal,
            &hash,
            id,
        )?;
        revision.validate(&range_binding(&binding, &receipt, ordinal)?)?;
        selected.push(revision);
    }
    let next_version = expected_range_version
        .checked_add(1)
        .context("Range version overflow")?;
    apply_manual_transcript_ranges(
        &draft,
        &[],
        &selected,
        &[(ordinal, next_version)],
        Some(&draft),
    )?;
    lock(&state.db)?.select_transcript_range_revision(
        job_id,
        &binding.job_digest,
        ordinal,
        &hash,
        expected_range_version,
        id,
    )?;
    let (_, updated, base_digest) = load_draft(state, &binding)?;
    lock(&state.db)?.save_transcript_draft(job_id, &binding.job_digest, &base_digest, &updated)?;
    view(state, job_id)
}
pub async fn save_manual_transcript_range(
    state: AppState,
    job_id: String,
    draft_digest: String,
    ordinal: u32,
    expected_range_version: u64,
    content: ManualTranscriptContent,
) -> std::result::Result<TranscriptReview, String> {
    let state = state.clone();
    tauri::async_runtime::spawn_blocking(move || {
        save_manual_range(
            &state,
            &job_id,
            &draft_digest,
            ordinal,
            expected_range_version,
            content,
        )
    })
    .await
    .map_err(|_| "Local range save was interrupted".to_string())?
    .map_err(err)
}
pub async fn select_transcript_range_source(
    state: AppState,
    job_id: String,
    draft_digest: String,
    ordinal: u32,
    expected_range_version: u64,
    source: TranscriptRangeSelection,
) -> std::result::Result<TranscriptReview, String> {
    let state = state.clone();
    tauri::async_runtime::spawn_blocking(move || {
        select_range_source(
            &state,
            &job_id,
            &draft_digest,
            ordinal,
            expected_range_version,
            source,
        )
    })
    .await
    .map_err(|_| "Local range selection was interrupted".to_string())?
    .map_err(err)
}
