use super::*;

pub(super) fn load_draft(
    state: &AppState,
    binding: &TranscriptJob,
) -> Result<(AudioPreparationReceipt, TranscriptDraft, String)> {
    let receipt = receipt_for_job(state, binding)?;
    let mut responses = Vec::new();
    let mut reparsed = Vec::new();
    for ordinal in 0..receipt.chunks.len() {
        let output = match state.ai.response(&binding.job_id, ordinal as u32)? {
            Some(original) => Some(original),
            None => {
                let output = state
                    .ai
                    .selected_transcript_reparse(&binding.job_id, ordinal as u32)?;
                if output.is_some() {
                    reparsed.push(ordinal as u32);
                }
                output
            }
        };
        if let Some(output) = output {
            responses.push(ChunkResponse {
                ordinal: ordinal as u32,
                output,
            });
        }
    }
    let base = build_transcript_draft(&receipt, &responses)?;
    let edits = range_edits(state, binding, &receipt)?;
    let versions = edits
        .iter()
        .map(|e| (e.ordinal, e.version))
        .collect::<Vec<_>>();
    let selected = edits
        .into_iter()
        .filter_map(|e| e.selected_revision)
        .collect::<Vec<_>>();
    let effective = apply_manual_transcript_ranges(&base, &reparsed, &selected, &versions, None)?;
    let base_digest = effective.digest.clone();
    let saved: Option<TranscriptDraft> =
        lock(&state.db)?.latest_transcript_draft(&binding.job_id, &binding.job_digest)?;
    let draft =
        apply_manual_transcript_ranges(&base, &reparsed, &selected, &versions, saved.as_ref())?;
    Ok((receipt, draft, base_digest))
}

pub(super) fn draft_segments(draft: &TranscriptDraft) -> Vec<surtitle_core::SubtitleSegment> {
    draft
        .segments
        .iter()
        .map(|cue| surtitle_core::SubtitleSegment {
            id: format!("{}-{}", draft.id, cue.id),
            media_id: draft.media_id.clone(),
            start_ms: cue.start_ms,
            end_ms: cue.end_ms,
            text: cue.text.clone(),
            translation: None,
            status: cue.status.clone(),
        })
        .collect()
}
pub(super) fn require_explicit_empty_range_confirmation(draft: &TranscriptDraft) -> Result<()> {
    ensure!(
        draft.chunks.iter().all(|chunk| !chunk.segments.is_empty()
            || chunk
                .manual_revision
                .as_ref()
                .is_some_and(|revision| matches!(
                    revision.content,
                    ManualTranscriptContent::ConfirmedNoSpeech
                ))),
        "Empty ranges require an explicit no-speech confirmation in the range editor before adoption"
    );
    Ok(())
}

pub(super) fn view(state: &AppState, job_id: &str) -> Result<TranscriptReview> {
    let binding = load_binding(state, job_id)?;
    let (receipt, draft, _) = load_draft(state, &binding)?;
    let applied = lock(&state.db)?
        .transcript_adopted(job_id, &binding.job_digest)?
        .is_some();
    let checked = if applied {
        Ok(())
    } else if binding.repair_parent.is_some() {
        Err(anyhow::anyhow!(
            "修復結果は比較用の候補です。親の境界レビューで内容と時刻を確認して選択してください。"
        ))
    } else {
        (|| {
            manual_editing_allowed(state, &binding)?;
            validate_transcript_adoption(&draft, &draft.digest)?;
            require_explicit_empty_range_confirmation(&draft)?;
            verify_source(state, &receipt, true)?;
            let db = lock(&state.db)?;
            surtitle_core::store::validate_transcript_range(
                &db.list_segments(&draft.media_id)?,
                draft.start_ms,
                draft.end_ms,
                &draft_segments(&draft),
                &draft.media_id,
            )
        })()
    };
    let mut repair_alternatives = Vec::new();
    for repair in job_bindings(state)?
        .into_iter()
        .filter(|b| b.repair_parent.as_ref().is_some_and(|p| p.job_id == job_id))
    {
        let (_, alternative, _) = load_draft(state, &repair)?;
        repair_alternatives.push(RepairAlternative {
            job_id: repair.job_id,
            boundary_id: repair.repair_parent.unwrap().boundary_id,
            draft: alternative,
        });
    }
    Ok(TranscriptReview {
        job_id: job_id.into(),
        media_id: draft.media_id.clone(),
        draft,
        applied,
        can_apply: !applied && checked.is_ok(),
        blocked_reason: checked.err().map(|e| e.to_string()),
        repair_alternatives,
        results: state.ai.transcript_result_reviews(job_id)?,
        range_edits: range_edits(state, &binding, &receipt)?,
        manual_editing_blocked_reason: manual_editing_allowed(state, &binding)
            .err()
            .map(|e| e.to_string()),
    })
}
pub async fn get_transcript_review(
    state: AppState,
    job_id: String,
) -> std::result::Result<TranscriptReview, String> {
    let state = state.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _review = lock(&state.ai_session.transcript_review)?;
        view(&state, &job_id)
    })
    .await
    .map_err(|_| "transcript review was interrupted".to_string())?
    .map_err(err)
}

pub async fn get_transcript_result_detail(
    state: AppState,
    job_id: String,
    ordinal: u32,
) -> std::result::Result<TranscriptResultReview, String> {
    let state = state.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _review = lock(&state.ai_session.transcript_review)?;
        load_binding(&state, &job_id)?;
        state
            .ai
            .transcript_result_detail(&job_id, ordinal)
            .map_err(anyhow::Error::from)
    })
    .await
    .map_err(|_| "Transcript evidence loading was interrupted".to_string())?
    .map_err(err)
}

pub async fn reparse_transcript_evidence(
    state: AppState,
    job_id: String,
    ordinal: u32,
    evidence_sha256: String,
) -> std::result::Result<TranscriptReview, String> {
    let state = state.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _review = lock(&state.ai_session.transcript_review)?;
        load_binding(&state, &job_id)?;
        state
            .ai
            .reparse_transcript_evidence(&job_id, ordinal, &evidence_sha256)?;
        view(&state, &job_id)
    })
    .await
    .map_err(|_| "Local transcript reparse was interrupted".to_string())?
    .map_err(err)
}

pub async fn select_transcript_reparse(
    state: AppState,
    job_id: String,
    ordinal: u32,
    candidate_id: String,
    draft_digest: String,
) -> std::result::Result<TranscriptReview, String> {
    let state = state.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _review = lock(&state.ai_session.transcript_review)?;
        let binding = load_binding(&state, &job_id)?;
        let (_, draft, _) = load_draft(&state, &binding)?;
        ensure!(
            draft.digest == draft_digest,
            "The transcript review changed; reload it before selecting a candidate"
        );
        ensure!(
            lock(&state.db)?
                .transcript_adopted(&job_id, &binding.job_digest)?
                .is_none(),
            "Adopted transcript decisions cannot be replaced"
        );
        ensure!(
            state.ai.response(&job_id, ordinal)?.is_none(),
            "The original valid result is already available"
        );
        state
            .ai
            .select_transcript_reparse(&job_id, ordinal, &candidate_id)?;
        view(&state, &job_id)
    })
    .await
    .map_err(|_| "Local transcript selection was interrupted".to_string())?
    .map_err(err)
}
pub async fn resolve_transcript_boundary(
    state: AppState,
    job_id: String,
    draft_digest: String,
    boundary_id: String,
    choice: BoundaryChoice,
) -> std::result::Result<TranscriptReview, String> {
    let state = state.clone();
    tauri::async_runtime::spawn_blocking(move || {
        resolve_review(&state, &job_id, &draft_digest, &boundary_id, choice)
    })
    .await
    .map_err(|_| "boundary resolution was interrupted".to_string())?
    .map_err(err)
}
pub(super) fn resolve_review(
    state: &AppState,
    job_id: &str,
    draft_digest: &str,
    boundary_id: &str,
    choice: BoundaryChoice,
) -> Result<TranscriptReview> {
    let _review = lock(&state.ai_session.transcript_review)?;
    let binding = load_binding(state, job_id)?;
    let (_, draft, base_digest) = load_draft(state, &binding)?;
    ensure!(
        lock(&state.db)?
            .transcript_adopted(job_id, &binding.job_digest)?
            .is_none(),
        "adopted transcript decisions cannot be replaced"
    );
    let updated =
        surtitle_ai::resolve_transcript_boundary(&draft, draft_digest, boundary_id, choice)?;
    lock(&state.db)?.save_transcript_draft(job_id, &binding.job_digest, &base_digest, &updated)?;
    view(state, job_id)
}

pub async fn acknowledge_transcript_warning(
    state: AppState,
    job_id: String,
    draft_digest: String,
    warning_id: String,
) -> std::result::Result<TranscriptReview, String> {
    let state = state.clone();
    tauri::async_runtime::spawn_blocking(move || {
        acknowledge_review_warning(&state, &job_id, &draft_digest, &warning_id)
    })
    .await
    .map_err(|_| "Transcript review was interrupted".to_string())?
    .map_err(err)
}
pub(super) fn acknowledge_review_warning(
    state: &AppState,
    job_id: &str,
    draft_digest: &str,
    warning_id: &str,
) -> Result<TranscriptReview> {
    let _review = lock(&state.ai_session.transcript_review)?;
    let binding = load_binding(state, job_id)?;
    ensure!(
        lock(&state.db)?
            .transcript_adopted(job_id, &binding.job_digest)?
            .is_none(),
        "Adopted transcript decisions cannot be replaced"
    );
    let (_, draft, base_digest) = load_draft(state, &binding)?;
    let updated = surtitle_ai::acknowledge_transcript_warning(&draft, draft_digest, warning_id)?;
    lock(&state.db)?.save_transcript_draft(job_id, &binding.job_digest, &base_digest, &updated)?;
    view(state, job_id)
}
pub(super) fn apply_review(
    state: &AppState,
    job_id: &str,
    expected_digest: &str,
) -> Result<TranscriptReview> {
    let _review = lock(&state.ai_session.transcript_review)?;
    let binding = load_binding(state, job_id)?;
    ensure!(
        binding.repair_parent.is_none(),
        "repair results are alternatives; resolve the parent boundary explicitly"
    );
    let adopted = lock(&state.db)?.transcript_adopted(job_id, &binding.job_digest)?;
    if let Some(applied_digest) = adopted {
        ensure!(
            applied_digest == expected_digest,
            "this job was adopted with a different reviewed draft"
        );
        return view(state, job_id);
    }
    let (receipt, draft, _) = load_draft(state, &binding)?;
    manual_editing_allowed(state, &binding)?;
    validate_transcript_adoption(&draft, expected_digest)?;
    require_explicit_empty_range_confirmation(&draft)?;
    let source_identity = verify_source_identity(state, &receipt, true)?;
    let mut db = lock(&state.db)?;
    let current_media = db.media(&draft.media_id)?;
    ensure!(
        current_media.path == source_identity.path
            && current_media.learning_language == source_identity.language,
        "media was relinked or its language changed during transcript verification"
    );
    db.adopt_transcript_once(
        job_id,
        &binding.job_digest,
        &draft.digest,
        &draft.media_id,
        &draft.source_revision,
        draft.start_ms,
        draft.end_ms,
        &draft_segments(&draft),
    )?;
    drop(db);
    crate::application::playback::refresh_current_subtitles(state, &draft.media_id)?;
    view(state, job_id)
}
pub async fn apply_transcript_review(
    state: AppState,
    job_id: String,
    draft_digest: String,
) -> std::result::Result<TranscriptReview, String> {
    let state = state.clone();
    tauri::async_runtime::spawn_blocking(move || apply_review(&state, &job_id, &draft_digest))
        .await
        .map_err(|_| "transcript adoption was interrupted".to_string())?
        .map_err(err)
}
