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
    drop(review_guard);
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
        let service = make_executor(&state)?;
        loop {
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
            let Some(result) = service
                .execute_next_with_guard(&quote_id, || {
                    verify_current_binding(&state, &plan)
                        .map_err(|e| AiError::Invalid(e.to_string()))
                })
                .await?
            else {
                break;
            };
            let apply =
                apply_received_output(&state, &quote_id, result.ordinal, &plan, result.output);
            if let Err(error) = apply {
                state
                    .ai
                    .require_review(&quote_id, "result_application_requires_review")?;
                return Err(error);
            }
        }
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
    execution
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

pub fn cancel_ai_job(state: AppState, job_id: String) -> std::result::Result<(), String> {
    state.ai.cancel(&job_id).map_err(|e| e.to_string())
}

pub fn resolve_unknown_attempt(
    state: AppState,
    attempt_id: String,
) -> std::result::Result<(), String> {
    state
        .ai
        .acknowledge_unknown(&attempt_id)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests;
