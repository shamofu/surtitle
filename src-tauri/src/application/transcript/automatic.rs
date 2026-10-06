//! Local completion policy. Transport results and competing candidates are never rewritten.
use super::*;

fn issue_records(draft: &TranscriptDraft) -> Vec<surtitle_core::TranscriptIssueRecord> {
    let make = |id: String, kind: String, start_ms: u64, end_ms: u64, alternatives| {
        surtitle_core::TranscriptIssueRecord {
            id: format!("{}-{id}", draft.id),
            media_id: draft.media_id.clone(),
            source_id: draft.id.clone(),
            active: true,
            kind,
            start_ms: start_ms.max(draft.start_ms),
            end_ms: end_ms.min(draft.end_ms),
            alternatives,
        }
    };
    let mut issues = Vec::new();
    for warning in draft
        .warnings
        .iter()
        .filter(|warning| !warning.acknowledged)
    {
        let alternatives = draft
            .chunks
            .iter()
            .filter(|chunk| chunk.ordinal == warning.ordinal)
            .flat_map(|chunk| &chunk.original_segments)
            .filter(|cue| cue.start_ms < warning.end_ms && cue.end_ms > warning.start_ms)
            .map(|cue| surtitle_core::SubtitleReviewAlternative {
                start_ms: cue.start_ms,
                end_ms: cue.end_ms,
                text: cue.text.clone(),
            })
            .collect();
        issues.push(make(
            warning.id.clone(),
            warning.kind.clone(),
            warning.start_ms,
            warning.end_ms,
            alternatives,
        ));
    }
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
    for chunk in draft
        .chunks
        .iter()
        .filter(|chunk| chunk.status != "pending" && chunk.segments.is_empty())
    {
        issues.push(make(
            format!("empty-{}", chunk.ordinal),
            "no_speech".into(),
            chunk.core_start_ms,
            chunk.core_end_ms,
            vec![],
        ));
    }
    issues
}

fn generated_segments(draft: &TranscriptDraft) -> Vec<surtitle_core::SubtitleSegment> {
    draft
        .segments
        .iter()
        .map(|cue| {
            let mut issues = Vec::new();
            for warning in draft.warnings.iter().filter(|warning| {
                !warning.acknowledged
                    && cue.start_ms < warning.end_ms
                    && cue.end_ms > warning.start_ms
            }) {
                issues.push(surtitle_core::SubtitleReviewIssue {
                    id: warning.id.clone(),
                    kind: warning.kind.clone(),
                    start_ms: warning.start_ms,
                    end_ms: warning.end_ms,
                    alternatives: vec![],
                });
            }
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
                id: format!("{}-{}", draft.id, cue.id),
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
    let segments = generated_segments(&draft);
    let issues = issue_records(&draft);
    let mut db = lock(&state.db)?;
    let media = db.media(&draft.media_id)?;
    ensure!(
        media.path == identity.path
            && media.learning_language == identity.language
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
    for job_id in state.ai.recoverable_transcript_applications()? {
        if let Err(error) = apply_completed(state, &job_id) {
            crate::application::ai::jobs::record_failure(state, &job_id, "apply", &error)?;
        }
    }
    Ok(())
}

pub(crate) fn applied_has_warnings(state: &AppState, job_id: &str) -> Result<bool> {
    let binding = load_binding(state, job_id)?;
    let quote = state.ai.quote(job_id)?;
    let prefix = format!("{}-", binding.preparation_id);
    let db = lock(&state.db)?;
    let segments = db.list_segments(&quote.binding.media_id)?;
    Ok(segments
        .iter()
        .any(|cue| cue.id.starts_with(&prefix) && !cue.review_issues.is_empty())
        || db
            .list_transcript_issues(&quote.binding.media_id)?
            .iter()
            .any(|issue| {
                issue.source_id == binding.preparation_id
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
