//! Local completion policy. Transport results and competing candidates are never rewritten.
use super::*;

pub(super) fn issue_records(
    job_id: &str,
    draft: &TranscriptDraft,
) -> Vec<surtitle_core::TranscriptIssueRecord> {
    let make = |id: String, kind: String, start_ms: u64, end_ms: u64, alternatives| {
        surtitle_core::TranscriptIssueRecord {
            id: format!("{job_id}-{id}"),
            media_id: draft.media_id.clone(),
            source_id: job_id.into(),
            active: true,
            kind,
            start_ms: start_ms.max(draft.start_ms),
            end_ms: end_ms.min(draft.end_ms),
            alternatives,
        }
    };
    let mut issues = Vec::new();
    for conflict in draft
        .conflicts
        .iter()
        .filter(|conflict| conflict.resolution.is_none())
    {
        issues.push(make(
            conflict.id.clone(),
            "boundary_conflict".into(),
            conflict.start_ms,
            conflict.end_ms,
            conflict
                .left_alternative
                .iter()
                .chain(&conflict.right_alternative)
                .map(|value| surtitle_core::SubtitleReviewAlternative {
                    start_ms: value.start_ms,
                    end_ms: value.end_ms,
                    text: value.text.clone(),
                })
                .collect(),
        ));
    }
    issues
}

pub(super) fn generated_segments(
    job_id: &str,
    draft: &TranscriptDraft,
) -> Vec<surtitle_core::SubtitleSegment> {
    draft
        .segments
        .iter()
        .map(|cue| {
            let mut issues = Vec::new();
            for conflict in draft.conflicts.iter().filter(|conflict| {
                conflict.resolution.is_none()
                    && cue.start_ms < conflict.end_ms
                    && cue.end_ms > conflict.start_ms
            }) {
                issues.push(surtitle_core::SubtitleReviewIssue {
                    id: conflict.id.clone(),
                    kind: "boundary_conflict".into(),
                    start_ms: conflict.start_ms,
                    end_ms: conflict.end_ms,
                    alternatives: conflict
                        .left_alternative
                        .iter()
                        .chain(&conflict.right_alternative)
                        .map(|value| surtitle_core::SubtitleReviewAlternative {
                            start_ms: value.start_ms,
                            end_ms: value.end_ms,
                            text: value.text.clone(),
                        })
                        .collect(),
                });
            }
            surtitle_core::SubtitleSegment {
                timing_precision: cue.timing_precision.clone(),
                id: format!("{job_id}-{}", cue.id),
                media_id: draft.media_id.clone(),
                start_ms: cue.start_ms,
                end_ms: cue.end_ms,
                text: cue.text.clone(),
                translation: None,
                status: if issues.is_empty() {
                    "generated"
                } else {
                    "generated_review"
                }
                .into(),
                review_issues: issues,
            }
        })
        .collect()
}

/// Publish only received ranges, preserving the user's changes and untouched audio.
pub(crate) fn apply_progress(state: &AppState, job_id: &str) -> Result<bool> {
    let _review = lock(&state.ai_session.transcript_review)?;
    apply_progress_locked(state, job_id)
}

fn apply_progress_locked(state: &AppState, job_id: &str) -> Result<bool> {
    let plan = state.ai.prepared_job(job_id)?;
    if plan.apply_policy != TranscriptApplyPolicy::Auto {
        return Ok(false);
    }
    let binding = load_binding(state, job_id)?;
    if !binding.progressive || binding.publication_detached {
        return Ok(false);
    }
    if state
        .ai
        .transcript_application_recorded(job_id, &binding.job_digest)?
    {
        return Ok(false);
    }
    let (receipt, draft, _) = load_draft(state, &binding)?;
    validate_transcript_draft(&draft)?;
    let identity = verify_source_identity(state, &receipt, false)?;
    let received = draft
        .chunks
        .iter()
        .filter(|chunk| chunk.status != "pending")
        .map(|chunk| surtitle_core::store::TranscriptPublicationRange {
            start_ms: chunk.core_start_ms,
            end_ms: chunk.core_end_ms,
        })
        .collect::<Vec<_>>();
    if received.is_empty() {
        return Ok(false);
    }
    let mut db = lock(&state.db)?;
    let media = db.media(&draft.media_id)?;
    ensure!(
        media.path == identity.path
            && media.learning_language == identity.language
            && media.audio_stream_index == receipt.audio_stream_index,
        AiError::PreparationChanged
    );
    // A restore removes operational sessions. Never reconstruct one from old output.
    if !db.transcript_publication_exists(job_id, &binding.job_digest)? {
        return Ok(false);
    }
    let report = db.publish_transcript_progress(
        job_id,
        &binding.job_digest,
        &received,
        &generated_segments(job_id, &draft),
        &issue_records(job_id, &draft),
    )?;
    drop(db);
    // Also refresh after an idempotent retry: the DB may have committed before
    // the previous attempt failed to refresh the current player.
    crate::application::playback::refresh_current_subtitles(state, &draft.media_id)?;
    Ok(report.changed)
}

/// Mark local publication intent independently of portable learning records.
pub(crate) fn detach_publications(state: &AppState, media_id: Option<&str>) -> Result<()> {
    for mut binding in job_bindings(state)? {
        let plan = state.ai.prepared_job(&binding.job_id)?;
        if binding.progressive && media_id.is_none_or(|id| plan.binding.media_id == id) {
            binding.publication_detached = true;
            save_binding(state, &binding)?;
        }
    }
    Ok(())
}

pub(crate) fn verify_publication_binding(
    state: &AppState,
    job_id: &str,
    digest: &str,
) -> Result<()> {
    let binding = load_binding(state, job_id)?;
    if binding.progressive {
        ensure!(
            !binding.publication_detached
                && lock(&state.db)?.transcript_publication_active(job_id, digest)?,
            "The subtitle source was replaced. Prepare a new transcription."
        );
    }
    Ok(())
}

/// Completed cloud work can be committed again after a crash without another request.
pub(crate) fn apply_completed(state: &AppState, job_id: &str) -> Result<bool> {
    let plan = state.ai.prepared_job(job_id)?;
    let quote = state.ai.quote(job_id)?;
    if plan.apply_policy != TranscriptApplyPolicy::Auto
        || !["completed", "needs_review", "paused"].contains(&quote.state.as_str())
        || quote.completed_requests as usize != quote.requests.len()
    {
        return Ok(false);
    }
    let binding = load_binding(state, job_id)?;
    if binding.progressive {
        let _review = lock(&state.ai_session.transcript_review)?;
        let binding = load_binding(state, job_id)?;
        if state
            .ai
            .transcript_application_recorded(job_id, &binding.job_digest)?
        {
            crate::application::playback::refresh_current_subtitles(
                state,
                &quote.binding.media_id,
            )?;
            state.ai.finish_local_application(job_id)?;
            state.ai.clear_job_issue(job_id)?;
            return Ok(false);
        }
        if !binding.publication_detached
            && !state
                .ai
                .transcript_application_recorded(job_id, &binding.job_digest)?
        {
            let receipt = receipt_for_job(state, &binding)?;
            verify_source_identity(state, &receipt, true)?;
        }
        let changed = apply_progress_locked(state, job_id)?;
        if !binding.publication_detached
            && lock(&state.db)?.transcript_publication_active(job_id, &binding.job_digest)?
        {
            lock(&state.db)?.finish_transcript_publication(job_id, &binding.job_digest)?;
            state
                .ai
                .record_transcript_application(job_id, &binding.job_digest)?;
        }
        state.ai.finish_local_application(job_id)?;
        state.ai.clear_job_issue(job_id)?;
        return Ok(changed);
    }
    let _review = lock(&state.ai_session.transcript_review)?;
    if state
        .ai
        .transcript_application_recorded(job_id, &quote.digest)?
    {
        // The current subtitles may come from a subsequent edit or restore.
        // Refresh the player from those current rows, without reapplying output.
        crate::application::playback::refresh_current_subtitles(state, &quote.binding.media_id)?;
        state.ai.finish_local_application(job_id)?;
        state.ai.clear_job_issue(job_id)?;
        return Ok(false);
    }
    let binding = load_binding(state, job_id)?;
    ensure!(
        binding.repair_parent.is_none(),
        "Repair jobs cannot replace the complete transcript"
    );
    if lock(&state.db)?
        .transcript_adopted(job_id, &binding.job_digest)?
        .is_some()
    {
        state
            .ai
            .record_transcript_application(job_id, &binding.job_digest)?;
        crate::application::playback::refresh_current_subtitles(state, &quote.binding.media_id)?;
        state.ai.finish_local_application(job_id)?;
        state.ai.clear_job_issue(job_id)?;
        return Ok(false);
    }
    let (receipt, draft, _) = load_draft(state, &binding)?;
    validate_transcript_draft(&draft)?;
    ensure!(
        draft.pending_ranges.is_empty(),
        "Automatic application requires every response"
    );
    let identity =
        verify_source_identity(state, &receipt, true).map_err(|_| AiError::PreparationChanged)?;
    let segments = generated_segments(job_id, &draft);
    let issues = issue_records(job_id, &draft);
    let mut db = lock(&state.db)?;
    let media = db.media(&draft.media_id)?;
    ensure!(
        media.path == identity.path
            && media.learning_language == identity.language
            && media.audio_stream_index == receipt.audio_stream_index
            && surtitle_core::store::subtitle_revision(&db.list_segments(&draft.media_id)?)?
                == draft.source_revision,
        AiError::PreparationChanged
    );
    let changed = db.adopt_transcript_with_issues_once(
        job_id,
        &binding.job_digest,
        &draft.digest,
        &draft.media_id,
        &draft.source_revision,
        draft.start_ms,
        draft.end_ms,
        &segments,
        &issues,
    )?;
    drop(db);
    state
        .ai
        .record_transcript_application(job_id, &binding.job_digest)?;
    crate::application::playback::refresh_current_subtitles(state, &draft.media_id)?;
    state.ai.finish_local_application(job_id)?;
    state.ai.clear_job_issue(job_id)?;
    Ok(changed)
}

pub(crate) fn recover(state: &AppState) -> Result<()> {
    for binding in job_bindings(state)?
        .into_iter()
        .filter(|binding| binding.progressive && !binding.publication_detached)
    {
        let result = (|| {
            if !state
                .ai
                .transcript_application_recorded(&binding.job_id, &binding.job_digest)?
            {
                verify_source(state, &receipt_for_job(state, &binding)?, true)?;
            }
            apply_progress(state, &binding.job_id)
        })();
        if let Err(error) = result {
            crate::application::ai::jobs::record_failure(state, &binding.job_id, "apply", &error)?;
        }
    }
    for job_id in state.ai.recoverable_transcript_applications()? {
        // Existing approved plans and results stay immutable. Only sessions
        // explicitly created for progressive publication resume on startup.
        if !load_binding(state, &job_id)?.progressive {
            continue;
        }
        if let Err(error) = apply_completed(state, &job_id) {
            crate::application::ai::jobs::record_failure(state, &job_id, "apply", &error)?;
        }
    }
    Ok(())
}

pub(crate) fn progress_ranges(
    state: &AppState,
    job_id: &str,
) -> Result<Vec<crate::application::ai::TranscriptionRangeSummary>> {
    let binding = load_binding(state, job_id)?;
    let receipt = receipt_for_job(state, &binding)?;
    let results = state.ai.transcript_result_reviews(job_id)?;
    receipt
        .chunks
        .iter()
        .map(|chunk| {
            let output = match state.ai.response(job_id, chunk.index)? {
                Some(output) => Some(output),
                None => state.ai.selected_transcript_reparse(job_id, chunk.index)?,
            };
            let status = match output {
                Some(ParsedOutput::Transcript { cues })
                    if cues
                        .iter()
                        .any(|cue| cue.timing_precision == "source_block") =>
                {
                    "source_block"
                }
                Some(ParsedOutput::Transcript { .. }) => "received",
                _ if results.iter().any(|result| {
                    result.ordinal == chunk.index && result.state == TranscriptResultState::Invalid
                }) =>
                {
                    "failed"
                }
                _ => "pending",
            };
            Ok(crate::application::ai::TranscriptionRangeSummary {
                start_ms: chunk.core_start_ms(),
                end_ms: chunk.core_end_ms(),
                state: status.into(),
            })
        })
        .collect()
}

pub(crate) fn applied_has_warnings(state: &AppState, job_id: &str) -> Result<bool> {
    let binding = load_binding(state, job_id)?;
    let quote = state.ai.quote(job_id)?;
    let prefix = format!("{job_id}-");
    let db = lock(&state.db)?;
    let segments = db.list_segments(&quote.binding.media_id)?;
    Ok(segments
        .iter()
        .any(|cue| cue.id.starts_with(&prefix) && !cue.review_issues.is_empty())
        || db
            .list_transcript_issues(&quote.binding.media_id)?
            .iter()
            .any(|issue| {
                (issue.source_id == job_id || issue.source_id == binding.preparation_id)
                    && !segments
                        .iter()
                        .any(|cue| cue.start_ms < issue.end_ms && cue.end_ms > issue.start_ms)
            }))
}

pub fn list_transcript_issues(
    state: AppState,
    media_id: String,
) -> std::result::Result<Vec<surtitle_core::TranscriptIssueRecord>, String> {
    (|| lock(&state.db)?.list_transcript_issues(&media_id))().map_err(err)
}
