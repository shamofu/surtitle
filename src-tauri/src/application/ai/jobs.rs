use super::*;

#[derive(Clone)]
pub(super) struct ApprovedExecution {
    plan: PreparedJob,
    approval_id: String,
}

pub async fn approve_quote(
    state: AppState,
    quote_id: String,
    digest: String,
    acknowledge_unpriced: bool,
    acknowledge_unqualified: bool,
    retry_policy_version: Option<u32>,
) -> std::result::Result<(), String> {
    approve_and_start(
        state.clone(),
        quote_id,
        &digest,
        false,
        acknowledge_unpriced,
        acknowledge_unqualified,
        retry_policy_version,
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
    retry_policy_version: Option<u32>,
) -> Result<()> {
    let plan = approve_for_execution_with_retry(
        &state,
        &quote_id,
        digest,
        retry,
        acknowledge_unpriced,
        acknowledge_unqualified,
        retry_policy_version,
    )?;
    tauri::async_runtime::spawn(async move {
        let _ = run_approved(state, quote_id, plan).await;
    });
    Ok(())
}

#[cfg(test)]
fn approve_for_execution(
    state: &AppState,
    quote_id: &str,
    digest: &str,
    retry: bool,
    acknowledge_unpriced: bool,
    acknowledge_unqualified: bool,
) -> Result<ApprovedExecution> {
    approve_for_execution_with_retry(
        state,
        quote_id,
        digest,
        retry,
        acknowledge_unpriced,
        acknowledge_unqualified,
        None,
    )
}

fn approve_for_execution_with_retry(
    state: &AppState,
    quote_id: &str,
    digest: &str,
    retry: bool,
    acknowledge_unpriced: bool,
    acknowledge_unqualified: bool,
    retry_policy_version: Option<u32>,
) -> Result<ApprovedExecution> {
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
        quote_for_ui_with_policy(state, quote.clone(), retry, retry_policy_version.is_some())?
            .can_approve,
        "Review the current quote and budget before approval"
    );
    if plan.apply_policy == TranscriptApplyPolicy::Auto {
        crate::application::transcript::automatic::verify_publication_binding(
            state, quote_id, digest,
        )?;
    }
    let approval_id = if retry {
        state.ai.reapprove_scope_with_retry(
            quote_id,
            digest,
            acknowledge_unpriced,
            acknowledge_unqualified,
            retry_policy_version,
        )?
    } else {
        ensure!(
            quote.state == "prepared",
            "Use explicit retry approval for this job"
        );
        state.ai.approve_scope_with_retry(
            quote_id,
            digest,
            acknowledge_unpriced,
            acknowledge_unqualified,
            retry_policy_version,
        )?
    };
    if plan.apply_policy == TranscriptApplyPolicy::Auto {
        let mut db = lock(&state.db)?;
        if db.transcript_publication_exists(quote_id, digest)? {
            db.activate_transcript_publication(quote_id, digest)?;
        }
    }
    drop(review_guard);
    state.ai.clear_job_issue_scoped(quote_id, &approval_id)?;
    Ok(ApprovedExecution { plan, approval_id })
}

// This seam stays inside the application. Production creates only VertexService;
// integration tests use the same AI worker with offline authorization/transport.
trait JobExecutor: Send + Sync {
    fn execute_next_with_guard(
        &self,
        job_id: &str,
        approval_id: &str,
        before_send: impl FnMut() -> surtitle_ai::Result<()> + Send,
    ) -> impl std::future::Future<Output = surtitle_ai::Result<Option<ExecutionResult>>> + Send;
}

impl JobExecutor for VertexService {
    async fn execute_next_with_guard(
        &self,
        job_id: &str,
        approval_id: &str,
        before_send: impl FnMut() -> surtitle_ai::Result<()> + Send,
    ) -> surtitle_ai::Result<Option<ExecutionResult>> {
        VertexService::execute_next_scoped_with_guard(self, job_id, approval_id, before_send).await
    }
}

pub(super) async fn run_approved(
    state: AppState,
    quote_id: String,
    approved: ApprovedExecution,
) -> Result<()> {
    run_approved_with(state, quote_id, approved, |state| {
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
    approved: ApprovedExecution,
    make_executor: impl FnOnce(&AppState) -> Result<E>,
) -> Result<()> {
    let ApprovedExecution { plan, approval_id } = approved;
    let mut phase = "source";
    let execution = async {
        if !state.ai.approval_is_current(&quote_id, &approval_id)? {
            return Ok(());
        }
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
            if !state.ai.approval_is_current(&quote_id, &approval_id)? {
                return Ok(());
            }
            let state_before = state.ai.quote(&quote_id)?.state;
            if ["paused", "cancelled", "completed"].contains(&state_before.as_str()) {
                break;
            }
            if let Err(error) = verify_current_binding(&state, &plan) {
                state.ai.require_review_scoped(
                    &quote_id,
                    &approval_id,
                    "source_changed_before_dispatch",
                )?;
                return Err(error);
            }
            phase = "execute";
            let result = service
                .execute_next_with_guard(&quote_id, &approval_id, || {
                    verify_current_binding(&state, &plan)
                        .map_err(|e| AiError::Invalid(e.to_string()))
                })
                .await;
            let result = match result {
                Ok(Some(result)) => result,
                Ok(None) => break,
                Err(AiError::Superseded | AiError::WorkerBusy) => return Ok(()),
                Err(AiError::RetryWaiting(at) | AiError::PacingWaiting(at)) => {
                    if !wait_for_dispatch(&state, &quote_id, &approval_id, at).await? {
                        return Ok(());
                    }
                    phase = "source";
                    let verify_state = state.clone();
                    let verify_plan = plan.clone();
                    tauri::async_runtime::spawn_blocking(move || {
                        crate::application::transcript::storage::verify_audio_source_content(
                            &verify_state,
                            &verify_plan,
                        )
                    })
                    .await??;
                    continue;
                }
                Err(error) => return Err(error.into()),
            };
            if !state.ai.approval_is_current(&quote_id, &approval_id)? {
                return Ok(());
            }
            phase = "apply";
            let apply =
                apply_received_output(&state, &quote_id, result.ordinal, &plan, result.output);
            if let Err(error) = apply {
                state.ai.require_review_scoped(
                    &quote_id,
                    &approval_id,
                    "result_application_requires_review",
                )?;
                return Err(error);
            }
        }
        phase = "apply";
        if state.ai.approval_is_current(&quote_id, &approval_id)? {
            crate::application::transcript::automatic::apply_completed(&state, &quote_id)?;
        }
        Ok(())
    }
    .await;
    // A second native invocation can approve before the first one reserves its
    // request. Losing that race must not leave an idle job labelled running.
    if !state.ai.approval_is_current(&quote_id, &approval_id)? {
        return Ok(());
    }
    if execution.is_err() && state.ai.quote(&quote_id)?.state == "approved" {
        state.ai.require_review_scoped(
            &quote_id,
            &approval_id,
            "execution_stopped_before_completion",
        )?;
    }
    if let Err(error) = &execution {
        let (code, http, action) = failure_issue(phase, error);
        state
            .ai
            .record_job_issue_scoped(&quote_id, &approval_id, code, phase, http, action)?;
    }
    execution
}

async fn wait_for_dispatch(
    state: &AppState,
    job_id: &str,
    approval_id: &str,
    at: i64,
) -> Result<bool> {
    loop {
        if !state.ai.approval_is_current(job_id, approval_id)?
            || state.ai.quote(job_id)?.state != "approved"
        {
            return Ok(false);
        }
        let remaining = at.saturating_sub(chrono::Utc::now().timestamp_millis());
        if remaining <= 0 {
            return Ok(true);
        }
        tokio::time::sleep(std::time::Duration::from_millis(
            (remaining as u64).min(250),
        ))
        .await;
    }
}

pub(crate) fn record_failure(
    state: &AppState,
    job_id: &str,
    phase: &str,
    error: &anyhow::Error,
) -> Result<()> {
    let (code, http, action) = failure_issue(phase, error);
    state
        .ai
        .record_job_issue(job_id, code, phase, http, action)?;
    Ok(())
}

fn failure_issue(phase: &str, error: &anyhow::Error) -> (&'static str, Option<u16>, &'static str) {
    match error.downcast_ref::<AiError>() {
        Some(AiError::Credentials) => ("credentials", None, "settings"),
        Some(AiError::BudgetDisabled | AiError::BudgetExceeded(_)) => ("budget", None, "settings"),
        Some(AiError::Provider(429)) => ("provider", Some(429), "resume"),
        Some(AiError::Provider(status)) => ("provider", Some(*status), "settings"),
        Some(AiError::UnknownOutcome | AiError::InFlight) => {
            ("unknown_outcome", None, "review_unknown")
        }
        Some(AiError::PreparationChanged) => ("source_changed", None, "prepare_again"),
        _ if phase == "apply" => ("local_apply", None, "retry_local"),
        _ if phase == "source" => ("source_changed", None, "prepare_again"),
        Some(AiError::Invalid(_)) => ("invalid_output", None, "review_result"),
        _ => ("execution", None, "resume"),
    }
}

pub async fn reapprove_quote(
    state: AppState,
    quote_id: String,
    digest: String,
    acknowledge_unpriced: bool,
    acknowledge_unqualified: bool,
    retry_policy_version: Option<u32>,
) -> std::result::Result<(), String> {
    approve_and_start(
        state.clone(),
        quote_id,
        &digest,
        true,
        acknowledge_unpriced,
        acknowledge_unqualified,
        retry_policy_version,
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
