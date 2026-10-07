use super::*;

pub async fn approve_quote(
    state: AppState,
    quote_id: String,
    digest: String,
    acknowledge_unpriced: bool,
    acknowledge_unqualified: bool,
) -> std::result::Result<(), String> {
    approve_and_start(
        state.clone(),
        quote_id,
        &digest,
        false,
        acknowledge_unpriced,
        acknowledge_unqualified,
    )
    .map_err(err)
}

pub(super) fn approve_and_start(
    state: AppState,
    quote_id: String,
    digest: &str,
    retry: bool,
    acknowledge_unpriced: bool,
    acknowledge_unqualified: bool,
) -> Result<()> {
    let plan = approve_for_execution(
        &state,
        &quote_id,
        digest,
        retry,
        acknowledge_unpriced,
        acknowledge_unqualified,
    )?;
    tauri::async_runtime::spawn(async move {
        let _ = run_approved(state, quote_id, plan).await;
    });
    Ok(())
}

fn approve_for_execution(
    state: &AppState,
    quote_id: &str,
    digest: &str,
    retry: bool,
    acknowledge_unpriced: bool,
    acknowledge_unqualified: bool,
) -> Result<PreparedJob> {
    // Serialize approval against local transcript correction/adoption. A paused
    // job cannot become dispatchable between the editor's check and its write.
    let review_guard = lock(&state.ai_session.transcript_review)?;
    let quote = state.ai.quote(quote_id)?;
    let plan = state.ai.prepared_job(quote_id)?;
    ensure!(
        quote.digest == digest,
        "The reviewed preparation changed. Review the current quote."
    );
    ensure!(
        lock(&state.db)?
            .transcript_adopted(quote_id, digest)?
            .is_none(),
        "Subtitles from this job have already been adopted"
    );
    verify_current_binding(state, &plan)?;
    ensure!(
        quote_for_ui(state, quote.clone(), retry)?.can_approve,
        "Review the current quote and budget before approval"
    );
    if plan.apply_policy == TranscriptApplyPolicy::Auto {
        crate::application::transcript::automatic::verify_publication_binding(
            state, quote_id, digest,
        )?;
    }
    if retry {
        state.ai.reapprove_scope(
            quote_id,
            digest,
            acknowledge_unpriced,
            acknowledge_unqualified,
        )?;
    } else {
        ensure!(
            quote.state == "prepared",
            "Use explicit retry approval for this job"
        );
        state.ai.approve_scope(
            quote_id,
            digest,
            acknowledge_unpriced,
            acknowledge_unqualified,
        )?;
    }
    if plan.apply_policy == TranscriptApplyPolicy::Auto {
        let mut db = lock(&state.db)?;
        if db.transcript_publication_exists(quote_id, digest)? {
            db.activate_transcript_publication(quote_id, digest)?;
        }
    }
    drop(review_guard);
    state.ai.clear_job_issue(quote_id)?;
    Ok(plan)
}

// This seam stays inside the application. Production creates only VertexService;
// integration tests use the same AI worker with offline authorization/transport.
trait JobExecutor: Send + Sync {
    fn execute_next_with_guard(
        &self,
        job_id: &str,
        before_send: impl FnOnce() -> surtitle_ai::Result<()> + Send,
    ) -> impl std::future::Future<Output = surtitle_ai::Result<Option<ExecutionResult>>> + Send;
}

impl JobExecutor for VertexService {
    async fn execute_next_with_guard(
        &self,
        job_id: &str,
        before_send: impl FnOnce() -> surtitle_ai::Result<()> + Send,
    ) -> surtitle_ai::Result<Option<ExecutionResult>> {
        VertexService::execute_next_with_guard(self, job_id, before_send).await
    }
}

pub(super) async fn run_approved(
    state: AppState,
    quote_id: String,
    plan: PreparedJob,
) -> Result<()> {
    run_approved_with(state, quote_id, plan, |state| {
        Ok(VertexService::new(
            state.ai.clone(),
            CredentialVault::new(state.root.join("credentials"))?,
        )?)
    })
    .await
}

async fn run_approved_with<E: JobExecutor>(
    state: AppState,
    quote_id: String,
    plan: PreparedJob,
    make_executor: impl FnOnce(&AppState) -> Result<E>,
) -> Result<()> {
    let mut phase = "source";
    let execution = async {
        if plan.requests.iter().any(|task| {
            matches!(
                task,
                RequestTask::AudioTranscription { .. } | RequestTask::TranscribePreview { .. }
            )
        }) {
            let verify_state = state.clone();
            let verify_plan = plan.clone();
            tauri::async_runtime::spawn_blocking(move || {
                crate::application::transcript::storage::verify_audio_source_content(
                    &verify_state,
                    &verify_plan,
                )
            })
            .await??;
        }
        phase = "execute";
        let service = make_executor(&state)?;
        loop {
            phase = "source";
            let state_before = state.ai.quote(&quote_id)?.state;
            if ["paused", "cancelled", "completed"].contains(&state_before.as_str()) {
                break;
            }
            if let Err(error) = verify_current_binding(&state, &plan) {
                state
                    .ai
                    .require_review(&quote_id, "source_changed_before_dispatch")?;
                return Err(error);
            }
            phase = "execute";
            let Some(result) = service
                .execute_next_with_guard(&quote_id, || {
                    verify_current_binding(&state, &plan)
                        .map_err(|e| AiError::Invalid(e.to_string()))
                })
                .await?
            else {
                break;
            };
            phase = "apply";
            let apply =
                apply_received_output(&state, &quote_id, result.ordinal, &plan, result.output);
            if let Err(error) = apply {
                state
                    .ai
                    .require_review(&quote_id, "result_application_requires_review")?;
                return Err(error);
            }
        }
        phase = "apply";
        crate::application::transcript::automatic::apply_completed(&state, &quote_id)?;
        Ok(())
    }
    .await;
    // A second native invocation can approve before the first one reserves its
    // request. Losing that race must not leave an idle job labelled running.
    if execution.is_err() && state.ai.quote(&quote_id)?.state == "approved" {
        state
            .ai
            .require_review(&quote_id, "execution_stopped_before_completion")?;
    }
    if let Err(error) = &execution {
        record_failure(&state, &quote_id, phase, error)?;
    }
    execution
}

pub(crate) fn record_failure(
    state: &AppState,
    job_id: &str,
    phase: &str,
    error: &anyhow::Error,
) -> Result<()> {
    let (code, http, action) = match error.downcast_ref::<AiError>() {
        Some(AiError::Credentials) => ("credentials", None, "settings"),
        Some(AiError::BudgetDisabled | AiError::BudgetExceeded(_)) => ("budget", None, "settings"),
        Some(AiError::Provider(status)) => ("provider", Some(*status), "settings"),
        Some(AiError::UnknownOutcome | AiError::InFlight) => {
            ("unknown_outcome", None, "review_unknown")
        }
        Some(AiError::PreparationChanged) => ("source_changed", None, "prepare_again"),
        _ if phase == "apply" => ("local_apply", None, "retry_local"),
        _ if phase == "source" => ("source_changed", None, "prepare_again"),
        Some(AiError::Invalid(_)) => ("invalid_output", None, "review_result"),
        _ => ("execution", None, "resume"),
    };
    state
        .ai
        .record_job_issue(job_id, code, phase, http, action)?;
    Ok(())
}

pub async fn reapprove_quote(
    state: AppState,
    quote_id: String,
    digest: String,
    acknowledge_unpriced: bool,
    acknowledge_unqualified: bool,
) -> std::result::Result<(), String> {
    approve_and_start(
        state.clone(),
        quote_id,
        &digest,
        true,
        acknowledge_unpriced,
        acknowledge_unqualified,
    )
    .map_err(err)
}

pub fn pause_ai_job(state: AppState, job_id: String) -> std::result::Result<(), String> {
    state.ai.pause(&job_id).map_err(|e| e.to_string())
}

/// Reapply already received output. This path never creates or dispatches a request.
pub fn retry_ai_application(state: AppState, job_id: String) -> std::result::Result<(), String> {
    (|| {
        let result = (|| {
            let plan = state.ai.prepared_job(&job_id)?;
            crate::application::transcript::automatic::apply_progress(&state, &job_id)?;
            for (ordinal, task) in plan.requests.iter().enumerate() {
                if matches!(task, RequestTask::Translation { .. })
                    && let Some(output) = state.ai.response(&job_id, ordinal as u32)?
                {
                    apply_received_output(&state, &job_id, ordinal as u32, &plan, output)?;
                }
            }
            crate::application::transcript::automatic::apply_completed(&state, &job_id)?;
            state.ai.finish_local_application(&job_id)?;
            Ok::<_, anyhow::Error>(())
        })();
        match result {
            Ok(()) => state.ai.clear_job_issue(&job_id)?,
            Err(error) => {
                record_failure(&state, &job_id, "apply", &error)?;
                return Err(error);
            }
        }
        Ok(())
    })()
    .map_err(err)
}

pub fn cancel_ai_job(state: AppState, job_id: String) -> std::result::Result<(), String> {
    state.ai.cancel(&job_id).map_err(|e| e.to_string())
}

pub fn resolve_unknown_attempt(
    state: AppState,
    attempt_id: String,
) -> std::result::Result<(), String> {
    (|| {
        let job_id = state
            .ai
            .summary()?
            .unknown_attempts
            .into_iter()
            .find(|attempt| attempt.id == attempt_id)
            .context("Unknown request is no longer pending")?
            .job_id;
        state.ai.acknowledge_unknown(&attempt_id)?;
        if !state
            .ai
            .summary()?
            .unknown_attempts
            .iter()
            .any(|attempt| attempt.job_id == job_id && attempt.state == "unknown")
        {
            state
                .ai
                .record_job_issue(&job_id, "interrupted", "recovery", None, "resume")?;
        }
        Ok(())
    })()
    .map_err(err)
}

#[cfg(test)]
mod tests;
#[cfg(all(test, feature = "e2e-test"))]
mod transcription_tests;
