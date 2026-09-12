use crate::service::*;
use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use surtitle_ai::*;
use tauri::Emitter;
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSnapshot {
    media: Vec<surtitle_core::Media>,
    cards: Vec<surtitle_core::StudyCard>,
    tools: Vec<crate::tool_commands::ToolStatus>,
    settings: surtitle_core::AppSettings,
    jobs: Vec<JobSummary>,
    budget: BudgetSummary,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobSummary {
    id: String,
    media_id: Option<String>,
    kind: String,
    status: String,
    progress: f64,
    message: Option<String>,
    created_at: String,
    pending_results: usize,
    transcript_review: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetSummary {
    spent_usd: f64,
    reserved_usd: f64,
    limit_usd: f64,
    unknown_attempts: Vec<UnknownAttemptSummary>,
    unpriced_attempts: u64,
    monetary_totals_complete: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnknownAttemptSummary {
    id: String,
    job_id: String,
    ordinal: u32,
    held_usd: Option<f64>,
    created_at: String,
}
#[tauri::command]
pub fn get_app_snapshot(state: State<'_, AppState>) -> std::result::Result<AppSnapshot, String> {
    (|| {
        let (media, cards) = {
            let db = lock(&state.db)?;
            (db.list_media()?, db.list_cards()?)
        };
        let p = lock(&state.preferences)?.clone();
        let summary = state.ai.summary()?;
        let unknown_jobs: std::collections::HashSet<_> = summary
            .unknown_attempts
            .iter()
            .filter(|a| a.state == "unknown")
            .map(|a| a.job_id.as_str())
            .collect();
        let jobs = state
            .ai
            .list_jobs()?
            .into_iter()
            .map(|q| {
                let transcript_review = q.requests.iter().any(|request| request.audio_duration_ms > 0);
                let pending_results = saved_results(&state, &q.id)?
                    .iter()
                    .filter(|result| !result.applied)
                    .count();
                let context = p.quotes.get(&q.id);
                let status = if unknown_jobs.contains(q.id.as_str()) {
                    "unknown"
                } else {
                    match q.state.as_str() {
                        "completed" => "completed",
                        "cancelled" => "cancelled",
                        "approved" => "running",
                        "paused" => "paused",
                        "prepared" => "queued",
                        _ => "failed",
                    }
                };
                let (ja, en) = match status {
                    "unknown" => ("結果不明です。費用記録を保持しています。再実行は別途承認が必要です。", "The outcome is unknown. Accounting is retained. Retrying requires separate approval."),
                    "paused" => ("一時停止しています。続行には残りの処理の承認が必要です。", "Paused. Approve the remaining work to continue."),
                    "failed" => ("処理または元字幕の確認が必要です。受信済み結果と費用は保存されています。", "Review the job or source subtitles. Received results and accounting have been retained."),
                    _ if pending_results > 0 => ("受信済み翻訳を保存しています。確認して適用できます。追加送信はありません。", "Received translations are saved. Review and apply them without another request."),
                    "queued" => ("実行の承認を待っています。", "Waiting for your approval."),
                    "completed" => ("承認された処理が完了しました。", "The approved work is complete."),
                    "cancelled" => ("キャンセルしました。受信済み結果と費用記録は保持します。", "Cancelled. Received results and accounting are retained."),
                    _ => ("承認された範囲を処理しています。", "Processing the approved scope."),
                };
                let message = if p.settings.locale == "ja" { ja } else { en }.to_owned();
                Ok(JobSummary {
                    id: q.id,
                    media_id: Some(q.binding.media_id),
                    kind: context.map(|c| c.kind.clone()).unwrap_or(q.title),
                    status: status.into(),
                    progress: q.completed_requests as f64 / q.requests.len().max(1) as f64,
                    message: Some(message),
                    created_at: utc_time(q.created_at_ms),
                    pending_results,
                    transcript_review,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let unknown_attempts = summary
            .unknown_attempts
            .into_iter()
            .filter(|a| a.state == "unknown")
            .map(|a| UnknownAttemptSummary {
                id: a.id,
                job_id: a.job_id,
                ordinal: a.ordinal,
                held_usd: a.held_or_charged_microusd.map(|amount| amount as f64 / 1_000_000.),
                created_at: utc_time(a.created_at_ms),
            })
            .collect();
        Ok(AppSnapshot {
            media,
            cards,
            tools: crate::tool_commands::statuses(&state)?,
            settings: state.settings()?,
            jobs,
            budget: BudgetSummary {
                spent_usd: summary.monthly_actual_charged_microusd as f64 / 1_000_000.,
                reserved_usd: summary.monthly_held_microusd as f64 / 1_000_000.,
                limit_usd: summary.limits.monthly_microusd as f64 / 1_000_000.,
                unknown_attempts,
                unpriced_attempts: summary.unpriced_attempts,
                monetary_totals_complete: summary.monetary_totals_complete,
            },
        })
    })()
    .map_err(err)
}
#[tauri::command]
pub async fn import_credential(state: State<'_, AppState>) -> std::result::Result<(), String> {
    let Some(file) = rfd::AsyncFileDialog::new()
        .add_filter("Service account JSON", &["json"])
        .pick_file()
        .await
    else {
        return Ok(());
    };
    (|| {
        let vault = CredentialVault::new(state.root.join("credentials"))?;
        let credential = vault.import_service_account(file.path())?;
        let mut p = lock(&state.preferences)?;
        p.settings.vertex_project = credential.project_id;
        p.credential_id = Some(credential.id);
        p.settings.credential_configured = true;
        state.save_preferences(&p)
    })()
    .map_err(err)
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuoteRequest {
    media_id: String,
    kind: String,
    start_ms: u64,
    end_ms: u64,
    #[serde(default)]
    focus_term: Option<String>,
    #[serde(default)]
    model: Option<surtitle_core::AiModelPreference>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiQuote {
    id: String,
    media_id: String,
    kind: String,
    start_ms: u64,
    end_ms: u64,
    model: String,
    estimated_usd: Option<f64>,
    maximum_usd: Option<f64>,
    input_tokens: u64,
    max_output_tokens: u32,
    expires_at: String,
    warnings: Vec<String>,
    can_approve: bool,
    blocked_reason: Option<String>,
    is_retry: bool,
    focus_term: Option<String>,
    digest: String,
    request_count: usize,
    send_duration_ms: u64,
    total_output_tokens: u64,
    pricing_source: Option<String>,
    unpriced: bool,
    location: String,
}
fn utc_time(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .unwrap_or_default()
        .to_rfc3339()
}
pub(crate) fn transcript_fingerprint(
    segments: &[surtitle_core::SubtitleSegment],
) -> Result<String> {
    Ok(sha256_bytes(&serde_json::to_vec(
        &segments
            .iter()
            .map(|s| (&s.id, &s.media_id, s.start_ms, s.end_ms, &s.text, &s.status))
            .collect::<Vec<_>>(),
    )?))
}
pub(crate) fn settings_fingerprint(settings: &surtitle_core::AppSettings) -> Result<String> {
    Ok(sha256_bytes(&serde_json::to_vec(&(
        &settings.vertex_project,
        &settings.vertex_location,
    ))?))
}
fn source_matches(
    original: &SourceCue,
    current: &surtitle_core::SubtitleSegment,
    media_id: &str,
) -> bool {
    current.id == original.id
        && current.media_id == media_id
        && current.start_ms == original.start_ms
        && current.end_ms == original.end_ms
        && current.text == original.text
        && current.status == "confirmed"
}
fn verify_task_sources(db: &surtitle_core::Store, plan: &PreparedJob) -> Result<()> {
    let media = db.media(&plan.binding.media_id)?;
    let draft_study = crate::transcript_commands::study::verify_quote_cues(db, plan)?;
    if plan.requests.iter().any(|task| {
        matches!(
            task,
            RequestTask::AudioTranscription { .. } | RequestTask::TranscribePreview { .. }
        )
    }) {
        ensure!(
            transcript_fingerprint(&db.list_segments(&media.id)?)?
                == plan.binding.transcript_revision,
            "source subtitle revision changed"
        );
    }
    for task in &plan.requests {
        let cues = match task {
            RequestTask::Vocabulary {
                learning_language,
                explanation_language,
                cues,
                ..
            }
            | RequestTask::Explanation {
                learning_language,
                explanation_language,
                cues,
                ..
            } => {
                ensure!(
                    *learning_language == media.learning_language
                        && *explanation_language == media.explanation_language,
                    "languages changed; create a new quote"
                );
                cues
            }
            RequestTask::Translation {
                target_language,
                cues,
            } => {
                ensure!(
                    *target_language == media.explanation_language,
                    "translation language changed; create a new quote"
                );
                cues
            }
            RequestTask::AudioTranscription { language, .. }
            | RequestTask::TranscribePreview { language, .. } => {
                ensure!(
                    *language == media.learning_language,
                    "learning language changed; prepare a new audio quote"
                );
                continue;
            }
            // Workspace builds may unify the development-only diagnostic variant.
            #[allow(unreachable_patterns)]
            _ => bail!("Development diagnostics cannot be applied to learning media"),
        };
        if draft_study {
            continue;
        }
        for original in cues {
            let current = db.segment(&original.id)?;
            ensure!(
                source_matches(original, &current, &plan.binding.media_id),
                "approved source subtitles changed; output was retained for review and further sending stopped"
            );
        }
    }
    Ok(())
}
fn verify_current_binding(state: &AppState, plan: &PreparedJob) -> Result<()> {
    let p = lock(&state.preferences)?;
    ensure!(
        settings_fingerprint(&p.settings)? == plan.binding.settings_sha256
            && p.credential_id.as_deref() == Some(plan.credential_id.as_str()),
        "Vertex project or credential changed; create a new quote"
    );
    for task in &plan.requests {
        if let RequestTask::Explanation { proficiency, .. } = task {
            ensure!(
                *proficiency == p.settings.proficiency,
                "proficiency changed; create a new quote"
            );
        }
    }
    drop(p);
    verify_task_sources(&*lock(&state.db)?, plan)?;
    crate::transcript_commands::study::verify_quote(state, plan, true)?;
    if plan.requests.iter().any(|task| {
        matches!(
            task,
            RequestTask::AudioTranscription { .. } | RequestTask::TranscribePreview { .. }
        )
    }) {
        crate::transcript_commands::verify_audio_plan(state, plan)?;
    }
    Ok(())
}
pub(crate) fn verify_application_binding(state: &AppState, plan: &PreparedJob) -> Result<()> {
    // A received result needs no credential. Semantic settings still bind its
    // contents, whereas rotating a key must not require another paid request.
    let p = lock(&state.preferences)?;
    for task in &plan.requests {
        if let RequestTask::Explanation { proficiency, .. } = task {
            ensure!(
                *proficiency == p.settings.proficiency,
                "proficiency changed; review the saved result"
            );
        }
    }
    drop(p);
    verify_task_sources(&*lock(&state.db)?, plan)?;
    crate::transcript_commands::study::verify_quote(state, plan, false)
}
pub(crate) fn quote_for_ui(state: &AppState, quote: JobQuote, is_retry: bool) -> Result<AiQuote> {
    let p = lock(&state.preferences)?;
    let context = p
        .quotes
        .get(&quote.id)
        .context("quote context is missing")?
        .clone();
    let japanese = p.settings.locale == "ja";
    let credential_configured = p.settings.credential_configured && p.credential_id.is_some();
    drop(p);
    let tr = |ja: &str, en: &str| {
        if japanese {
            ja.to_owned()
        } else {
            en.to_owned()
        }
    };
    let summary = state.ai.summary()?;
    let limits = summary.limits;
    let now = chrono::Utc::now().timestamp_millis();
    let additional = quote.additional_reservation_microusd;
    let remaining: Vec<_> = quote
        .requests
        .iter()
        .filter(|r| quote.remaining_ordinals.contains(&r.ordinal))
        .collect();
    let adopted = lock(&state.db)?
        .transcript_adopted(&quote.id, &quote.digest)?
        .is_some();
    let reason = if adopted {
        Some(tr(
            "このジョブの字幕は採用済みです。追加送信は行いません。",
            "Subtitles from this job have been adopted. Further sending is disabled.",
        ))
    } else if !credential_configured {
        Some(tr(
            "設定でサービスアカウント鍵を読み込んでください。",
            "Import a service-account key in Settings.",
        ))
    } else if now > quote.quote_expires_at_ms {
        Some(tr(
            "見積もりが期限切れです。新しい見積もりを確認してください。",
            "This quote expired. Review a new quote.",
        ))
    } else if remaining.is_empty() {
        Some(tr(
            "全応答を受信済みです。保存済み結果を確認してください。",
            "All responses were received. Review the saved results.",
        ))
    } else if !["prepared", "paused", "needs_review"].contains(&quote.state.as_str()) {
        Some(tr(
            "このジョブは実行中または終了しています。",
            "This job is already running or finished.",
        ))
    } else if summary
        .unknown_attempts
        .iter()
        .any(|attempt| attempt.state == "unknown")
    {
        Some(tr(
            "結果不明の要求を先に確認してください。",
            "Acknowledge requests with unknown outcomes first.",
        ))
    } else if additional.is_some()
        && (limits.per_job_microusd == 0
            || limits.daily_microusd == 0
            || limits.monthly_microusd == 0)
    {
        Some(tr(
            "金額予算は0です。設定で予算を指定してください。",
            "The monetary budget is zero. Set a budget in Settings.",
        ))
    } else if additional.is_some_and(|cost| {
        quote
            .already_charged_or_held_microusd
            .checked_add(cost)
            .is_none_or(|n| n > limits.per_job_microusd)
            || summary
                .daily_charged_or_held_microusd
                .checked_add(cost)
                .is_none_or(|n| n > limits.daily_microusd)
            || summary
                .monthly_charged_or_held_microusd
                .checked_add(cost)
                .is_none_or(|n| n > limits.monthly_microusd)
    }) {
        Some(tr(
            "既発生・保留額と今回の予約額が予算を超えます。",
            "Previous costs, held amounts, and this reservation exceed the budget.",
        ))
    } else {
        None
    };
    let mut warnings = vec![tr(
        "モデルの品質は保証されません。生成された内容を確認して利用してください。",
        "Model quality is not guaranteed. Review generated content before using it.",
    )];
    if additional.is_none() {
        warnings.push(tr("料金不明です。要求数・音声時間・出力設定で範囲を制限しますが、ドル上限は保証できません。", "Pricing is unknown. Request count, audio duration, and output settings bound this scope; a dollar limit cannot be guaranteed."));
    }
    if !summary.monetary_totals_complete {
        warnings.push(tr("費用未算定の要求があります。表示額は算定済み分と金額付き保留の合計です。", "Some requests have uncalculated costs. Displayed amounts cover calculated costs and monetary holds only."));
    }
    let focus_term = state
        .ai
        .prepared_job(&quote.id)?
        .requests
        .iter()
        .find_map(|task| {
            if let RequestTask::Explanation { term, .. } = task {
                Some(term.clone())
            } else {
                None
            }
        });
    Ok(AiQuote {
        id: quote.id,
        digest: quote.digest,
        media_id: context.media_id,
        kind: context.kind,
        start_ms: context.start_ms,
        end_ms: context.end_ms,
        model: quote.execution.model_id,
        location: quote.execution.location,
        estimated_usd: additional.map(|cost| cost as f64 / 1_000_000.),
        maximum_usd: additional.map(|cost| cost as f64 / 1_000_000.),
        input_tokens: remaining.iter().map(|r| r.input_tokens_reserved).sum(),
        max_output_tokens: quote.execution.max_output_tokens,
        total_output_tokens: remaining
            .iter()
            .map(|r| u64::from(r.max_output_tokens))
            .sum(),
        request_count: remaining.len(),
        send_duration_ms: remaining.iter().map(|r| r.audio_duration_ms).sum(),
        pricing_source: quote.execution.price.map(|price| price.source),
        unpriced: additional.is_none(),
        expires_at: utc_time(quote.quote_expires_at_ms),
        warnings,
        can_approve: reason.is_none(),
        blocked_reason: reason,
        is_retry,
        focus_term,
    })
}
#[tauri::command]
pub async fn create_quote(
    state: State<'_, AppState>,
    request: QuoteRequest,
) -> std::result::Result<AiQuote, String> {
    async {
        ensure!(request.end_ms>request.start_ms,"select a nonempty time range");
        ensure!(request.kind != "transcribe", "Prepare local audio before creating a transcription quote");
        let (media,all)={let db=lock(&state.db)?;(db.media(&request.media_id)?,db.list_segments(&request.media_id)?)};
        let cues:Vec<_>=all.iter().filter(|s|s.start_ms<request.end_ms&&s.end_ms>request.start_ms).map(|s|SourceCue{id:s.id.clone(),start_ms:s.start_ms,end_ms:s.end_ms,text:s.text.clone()}).collect();
        ensure!(!cues.is_empty()&&cues.len()<=1000,"select 1–1000 subtitle cues");
        ensure!(all.iter().filter(|s|cues.iter().any(|c|c.id==s.id)).all(|s|s.status=="confirmed"),"selected subtitles are not confirmed");
        let p=lock(&state.preferences)?.clone();
        let credential=p.credential_id.context("設定でサービスアカウント鍵を読み込んでください / Import a service-account key in Settings")?;
        let mut requests=Vec::new();
        // Keep responses bounded; each translation request includes a small immutable set.
        if let Some(term)=request.focus_term.as_deref().map(str::trim).filter(|s|!s.is_empty()) {
            ensure!(request.kind=="vocabulary","selected term explanations use vocabulary jobs");
            requests.push(RequestTask::Explanation{term:term.into(),learning_language:media.learning_language.clone(),explanation_language:media.explanation_language.clone(),proficiency:p.settings.proficiency.clone(),cues:cues.clone()});
        } else {for group in cues.chunks(if request.kind=="translate"{30}else{60}) {
            requests.push(match request.kind.as_str(){"translate"=>RequestTask::Translation{target_language:media.explanation_language.clone(),cues:group.to_vec()},"vocabulary"=>RequestTask::Vocabulary{learning_language:media.learning_language.clone(),explanation_language:media.explanation_language.clone(),cues:group.to_vec(),max_items:20},_=>bail!("invalid AI task")});
        }}
        let purpose = if request.focus_term.as_deref().is_some_and(|term| !term.trim().is_empty()) { "explanation" } else if request.kind == "translate" { "translation" } else { "vocabulary" };
        let execution = crate::model_commands::execution_for(&p.settings, purpose, request.model)?;
        let settings_hash=settings_fingerprint(&p.settings)?;
        // Text jobs bind to the exact selected textual input, not an expensive video hash.
        let source_hash=sha256_bytes(&serde_json::to_vec(&cues)?);
        let quote=state.ai.prepare(PreparedJob::new(format!("{} · {}",media.title,request.kind),p.settings.vertex_project,credential,PreparationBinding{media_id:media.id.clone(),transcript_revision:transcript_fingerprint(&all)?,source_sha256:source_hash,settings_sha256:settings_hash},requests,execution)?)?;
        let context=QuoteContext{media_id:media.id.clone(),kind:request.kind.clone(),start_ms:request.start_ms,end_ms:request.end_ms};
        {let mut p=lock(&state.preferences)?;p.quotes.insert(quote.id.clone(),context);state.save_preferences(&p)?;}
        let quote=if quote.state=="prepared"&&quote.quote_expires_at_ms<=chrono::Utc::now().timestamp_millis(){state.ai.refresh_quote(&quote.id)?}else{quote};
        let is_retry=quote.state!="prepared"||quote.already_charged_or_held_microusd>0;
        quote_for_ui(&state,quote,is_retry)
    }.await.map_err(err)
}
#[tauri::command]
pub async fn approve_quote(
    state: State<'_, AppState>,
    quote_id: String,
    digest: String,
    acknowledge_unpriced: bool,
    acknowledge_unqualified: bool,
) -> std::result::Result<(), String> {
    approve_and_start(
        state.inner().clone(),
        quote_id,
        &digest,
        false,
        acknowledge_unpriced,
        acknowledge_unqualified,
    )
    .map_err(err)
}

fn approve_and_start(
    state: AppState,
    quote_id: String,
    digest: &str,
    retry: bool,
    acknowledge_unpriced: bool,
    acknowledge_unqualified: bool,
) -> Result<()> {
    // Serialize approval against local transcript correction/adoption. A paused
    // job cannot become dispatchable between the editor's check and its write.
    let review_guard = lock(&state.transcript_review)?;
    let quote = state.ai.quote(&quote_id)?;
    let plan = state.ai.prepared_job(&quote_id)?;
    ensure!(
        quote.digest == digest,
        "The reviewed preparation changed. Review the current quote."
    );
    ensure!(
        lock(&state.db)?
            .transcript_adopted(&quote_id, digest)?
            .is_none(),
        "Subtitles from this job have already been adopted"
    );
    verify_current_binding(&state, &plan)?;
    ensure!(
        quote_for_ui(&state, quote.clone(), retry)?.can_approve,
        "Review the current quote and budget before approval"
    );
    if retry {
        state.ai.reapprove_scope(
            &quote_id,
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
            &quote_id,
            digest,
            acknowledge_unpriced,
            acknowledge_unqualified,
        )?;
    }
    drop(review_guard);
    tauri::async_runtime::spawn(async move {
        let _ = run_approved(state, quote_id, plan).await;
    });
    Ok(())
}

async fn run_approved(state: AppState, quote_id: String, plan: PreparedJob) -> Result<()> {
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
                crate::transcript_commands::verify_audio_source_content(&verify_state, &verify_plan)
            })
            .await??;
        }
        let service = VertexService::new(
            state.ai.clone(),
            CredentialVault::new(state.root.join("credentials"))?,
        )?;
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
fn apply_received_output(
    state: &AppState,
    job_id: &str,
    ordinal: u32,
    plan: &PreparedJob,
    output: ParsedOutput,
) -> Result<()> {
    let response_hash = sha256_bytes(&serde_json::to_vec(&output)?);
    // An already applied response is a completed local operation. Its durable
    // marker takes precedence over later source edits, and this path writes nothing.
    if matches!(&output, ParsedOutput::Translation { .. })
        && lock(&state.db)?.ai_result_applied(job_id, ordinal, &response_hash)?
    {
        return Ok(());
    }
    // Hold the same DB mutex across validation and writes to prevent a concurrent
    // subtitle edit from slipping between the check and translation application.
    verify_application_binding(state, plan)?;
    let mut db = lock(&state.db)?;
    verify_task_sources(&db, plan)?;
    let updates_translation = matches!(&output, ParsedOutput::Translation { .. });
    if let ParsedOutput::Translation { translations } = output {
        let Some(RequestTask::Translation { cues, .. }) = plan.requests.get(ordinal as usize)
        else {
            bail!("saved translation does not match its request");
        };
        ensure!(
            translations.len() == cues.len(),
            "saved translation count changed"
        );
        let mut updates = Vec::with_capacity(translations.len());
        for translated in translations {
            ensure!(
                cues.iter().any(|cue| cue.id == translated.id),
                "saved translation references another request"
            );
            let mut source = db.segment(&translated.id)?;
            source.translation = Some(translated.translation);
            updates.push(source);
        }
        db.apply_translations_once(job_id, ordinal, &response_hash, &updates)?;
    }
    drop(db);
    if updates_translation {
        crate::commands::refresh_current_subtitles(state, &plan.binding.media_id)?;
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedAiResult {
    job_id: String,
    ordinal: u32,
    applied: bool,
    can_apply: bool,
    blocked_reason: Option<String>,
    translations: Vec<SavedTranslation>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedTranslation {
    source: String,
    translation: String,
    start_ms: u64,
    end_ms: u64,
}
fn saved_results(state: &AppState, job_id: &str) -> Result<Vec<SavedAiResult>> {
    let plan = state.ai.prepared_job(job_id)?;
    if !plan
        .requests
        .iter()
        .any(|task| matches!(task, RequestTask::Translation { .. }))
    {
        return Ok(Vec::new());
    }
    let valid = verify_application_binding(state, &plan).is_ok();
    let mut results = Vec::new();
    for (ordinal, task) in plan.requests.iter().enumerate() {
        let RequestTask::Translation { cues, .. } = task else {
            continue;
        };
        let Some(output @ ParsedOutput::Translation { .. }) =
            state.ai.response(job_id, ordinal as u32)?
        else {
            continue;
        };
        let hash = sha256_bytes(&serde_json::to_vec(&output)?);
        let applied = lock(&state.db)?.ai_result_applied(job_id, ordinal as u32, &hash)?;
        let ParsedOutput::Translation { translations } = output else {
            unreachable!()
        };
        let translations = translations
            .into_iter()
            .map(|translation| {
                let source = cues
                    .iter()
                    .find(|source| source.id == translation.id)
                    .context("saved translation source missing")?;
                Ok(SavedTranslation {
                    source: source.text.clone(),
                    translation: translation.translation,
                    start_ms: source.start_ms,
                    end_ms: source.end_ms,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        results.push(SavedAiResult {
            job_id: job_id.into(),
            ordinal: ordinal as u32,
            applied,
            can_apply: valid && !applied,
            blocked_reason: if valid || applied {
                None
            } else {
                Some(
                    "元字幕・言語・習熟度が変わっています。保存結果は保持しますが適用できません。"
                        .into(),
                )
            },
            translations,
        });
    }
    Ok(results)
}
/// Reading saved output never refreshes an approval or contacts Vertex.
#[tauri::command]
pub fn list_saved_ai_results(
    state: State<'_, AppState>,
    job_id: String,
) -> std::result::Result<Vec<SavedAiResult>, String> {
    saved_results(&state, &job_id).map_err(err)
}
fn apply_saved_result(state: &AppState, job_id: &str, ordinal: u32) -> Result<()> {
    let plan = state.ai.prepared_job(job_id)?;
    let output = state
        .ai
        .response(job_id, ordinal)?
        .context("no received result was saved")?;
    ensure!(
        matches!(output, ParsedOutput::Translation { .. }),
        "this saved output is not a translation"
    );
    apply_received_output(state, job_id, ordinal, &plan, output)
}
/// Explicit local recovery after an interruption between settlement and application.
#[tauri::command]
pub fn apply_saved_ai_result(
    state: State<'_, AppState>,
    job_id: String,
    ordinal: u32,
) -> std::result::Result<(), String> {
    apply_saved_result(&state, &job_id, ordinal).map_err(err)
}
#[tauri::command]
pub fn create_retry_quote(
    state: State<'_, AppState>,
    job_id: String,
) -> std::result::Result<AiQuote, String> {
    (|| {
        verify_current_binding(&state, &state.ai.prepared_job(&job_id)?)?;
        quote_for_ui(&state, state.ai.refresh_quote(&job_id)?, true)
    })()
    .map_err(err)
}
#[tauri::command]
pub async fn reapprove_quote(
    state: State<'_, AppState>,
    quote_id: String,
    digest: String,
    acknowledge_unpriced: bool,
    acknowledge_unqualified: bool,
) -> std::result::Result<(), String> {
    approve_and_start(
        state.inner().clone(),
        quote_id,
        &digest,
        true,
        acknowledge_unpriced,
        acknowledge_unqualified,
    )
    .map_err(err)
}
#[tauri::command]
pub fn pause_ai_job(state: State<'_, AppState>, job_id: String) -> std::result::Result<(), String> {
    state.ai.pause(&job_id).map_err(|e| e.to_string())
}
#[tauri::command]
pub fn cancel_ai_job(
    state: State<'_, AppState>,
    job_id: String,
) -> std::result::Result<(), String> {
    state.ai.cancel(&job_id).map_err(|e| e.to_string())
}
#[tauri::command]
pub fn resolve_unknown_attempt(
    state: State<'_, AppState>,
    attempt_id: String,
) -> std::result::Result<(), String> {
    state
        .ai
        .acknowledge_unknown(&attempt_id)
        .map_err(|e| e.to_string())
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VocabularyCandidate {
    id: String,
    media_id: String,
    segment_id: String,
    term: String,
    meaning: String,
    example: String,
    explanation: String,
    translation: Option<String>,
    source_cue_ids: Vec<String>,
    start_ms: u64,
    end_ms: u64,
}
#[tauri::command]
pub fn list_vocabulary_candidates(
    state: State<'_, AppState>,
    media_id: String,
) -> std::result::Result<Vec<VocabularyCandidate>, String> {
    (|| {
        let mut out = Vec::new();
        for q in state
            .ai
            .list_jobs()?
            .into_iter()
            .filter(|q| q.binding.media_id == media_id)
        {
            let plan = state.ai.prepared_job(&q.id)?;
            if crate::transcript_commands::study::quote_selection(&plan)?.is_some() {
                continue;
            }
            if verify_task_sources(&*lock(&state.db)?, &plan).is_err() {
                continue;
            }
            for request in &q.requests {
                if let Some(ParsedOutput::Vocabulary { items }) =
                    state.ai.response(&q.id, request.ordinal)?
                {
                    for (i, item) in items.into_iter().enumerate() {
                        let mut sources = item
                            .source_cue_ids
                            .iter()
                            .map(|id| lock(&state.db)?.segment(id))
                            .collect::<Result<Vec<_>>>()?;
                        sources.sort_by_key(|source| source.start_ms);
                        let segment_id = sources
                            .first()
                            .context("candidate has no source")?
                            .id
                            .clone();
                        let separator = if lock(&state.db)?
                            .media(&media_id)?
                            .learning_language
                            .starts_with("ja")
                        {
                            ""
                        } else {
                            " "
                        };
                        let example = sources
                            .iter()
                            .map(|source| source.text.as_str())
                            .collect::<Vec<_>>()
                            .join(separator);
                        let translation = sources
                            .iter()
                            .map(|source| source.translation.as_deref())
                            .collect::<Option<Vec<_>>>()
                            .map(|parts| parts.join(" "));
                        let language = lock(&state.preferences)?.settings.locale.clone();
                        let explanation = if item.example.trim() == example.trim() {
                            item.explanation
                        } else {
                            format!(
                                "{}\n\n{}: {}",
                                item.explanation,
                                if language == "ja" {
                                    "別の用例（出典音声とは異なります）"
                                } else {
                                    "Additional example (not the source audio)"
                                },
                                item.example
                            )
                        };
                        out.push(VocabularyCandidate {
                            id: format!("{}-{}-{i}", q.id, request.ordinal),
                            media_id: media_id.clone(),
                            segment_id,
                            term: item.term,
                            meaning: item.meaning,
                            example,
                            explanation,
                            translation,
                            source_cue_ids: sources
                                .iter()
                                .map(|source| source.id.clone())
                                .collect(),
                            start_ms: sources
                                .iter()
                                .map(|source| source.start_ms)
                                .min()
                                .context("missing source")?,
                            end_ms: sources
                                .iter()
                                .map(|source| source.end_ms)
                                .max()
                                .context("missing source")?,
                        });
                    }
                }
            }
        }
        Ok(out)
    })()
    .map_err(err)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparationSummary {
    id: String,
    media_id: String,
    start_ms: u64,
    end_ms: u64,
    core_duration_ms: u64,
    send_duration_ms: u64,
    chunk_count: usize,
}
#[tauri::command]
pub async fn prepare_transcription(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    media_id: String,
    start_ms: u64,
    end_ms: u64,
) -> std::result::Result<PreparationSummary, String> {
    let receipt =
        prepare_transcription_receipt(app, state.inner().clone(), media_id, start_ms, end_ms)
            .await
            .map_err(err)?;
    let range = build_transcript_draft(&receipt, &[]).map_err(|e| e.to_string())?;
    Ok(PreparationSummary {
        id: receipt.id,
        media_id: receipt.prepared_job.binding.media_id,
        start_ms: range.start_ms,
        end_ms: range.end_ms,
        core_duration_ms: range.end_ms - range.start_ms,
        send_duration_ms: receipt
            .chunks
            .iter()
            .map(AudioChunk::request_duration_ms)
            .sum(),
        chunk_count: receipt.chunks.len(),
    })
}
pub(crate) async fn prepare_transcription_receipt(
    app: tauri::AppHandle,
    state: AppState,
    media_id: String,
    start_ms: u64,
    end_ms: u64,
) -> Result<AudioPreparationReceipt> {
    async {
        ensure!(end_ms > start_ms, "select an audio interval");
        let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        {
            let mut current = lock(&state.preparation)?;
            ensure!(current.is_none(), "audio preparation is already running");
            *current = Some(cancel.clone());
        }
        let operation = async {
            let (media, revision) = {
                let db = lock(&state.db)?;
                (
                    db.media(&media_id)?,
                    transcript_fingerprint(&db.list_segments(&media_id)?)?,
                )
            };
            let audio_stream_index =
                crate::tool_commands::ensure_audio_stream(&state, &media_id).await?;
            let model = install_silero_model(&state.root.join("models")).await?;
            let lease =
                crate::tool_commands::lease(&state, &[surtitle_tools::ToolKind::FfmpegPair])
                    .await?;
            let snapshot = lease.get(surtitle_tools::ToolKind::FfmpegPair)?.clone();
            let assets = VadAssets {
                runtime_path: lock(&state.runtime_dir)?.join("onnxruntime.dll"),
                runtime_sha256: runtime_hash("onnxruntime.dll")?,
                model_path: model,
                model_sha256: SILERO_MODEL_SHA256.into(),
            };
            let p = lock(&state.preferences)?.clone();
            let options = AudioPreparationOptions {
                media_id,
                transcript_revision: revision,
                title: media.title,
                project_id: p.settings.vertex_project,
                credential_id: p.credential_id.unwrap_or_default(),
                language: media.learning_language,
                start_ms,
                end_ms,
                chunks: ChunkOptions::default(),
                provider: AudioTranscriptionProvider::TranscribePreview,
                audio_stream_index: Some(audio_stream_index),
            };
            let root = state.root.join("prepared");
            let receipt = tauri::async_runtime::spawn_blocking(move || {
                let _lease = lease;
                prepare_audio(
                    std::path::Path::new(&media.path),
                    &root,
                    &snapshot,
                    assets,
                    options,
                    cancel,
                    |progress| {
                        let _ = app.emit("preparation-progress", &progress);
                    },
                )
            })
            .await??;
            Ok::<_, anyhow::Error>(receipt)
        }
        .await;
        *lock(&state.preparation)? = None;
        operation
    }
    .await
}
#[tauri::command]
pub fn cancel_preparation(state: State<'_, AppState>) -> std::result::Result<(), String> {
    (|| {
        if let Some(cancel) = lock(&state.preparation)?.as_ref() {
            cancel.store(true, std::sync::atomic::Ordering::Relaxed);
        }
        Ok(())
    })()
    .map_err(err)
}

/// A single predetermined persisted-response fixture, absent from normal builds.
/// It provides no alternate transport, credentials, clock, or arbitrary SQL IPC.
#[cfg(feature = "e2e-test")]
pub(crate) fn seed_ai_recovery_fixture(state: &AppState) -> Result<()> {
    let Some(preset) = std::env::var_os("SURTITLE_E2E_AI_RECOVERY") else {
        return Ok(());
    };
    ensure!(preset == "translation", "unknown AI recovery fixture");
    let isolated = std::env::var_os("SURTITLE_E2E_DATA_DIR")
        .context("AI recovery fixture needs an isolated data directory")?;
    let isolated = std::path::PathBuf::from(isolated);
    ensure!(
        isolated.is_absolute() && isolated.canonicalize()? == state.root.canonicalize()?,
        "AI recovery fixture data directory differs"
    );
    let title = "E2E saved translation recovery";
    if state.ai.list_jobs()?.iter().any(|job| job.title == title) {
        return Ok(());
    }
    let path = state.root.join("media").join("e2e-ai-recovery.wav");
    // Two seconds of generated silence. No downloaded or copyrighted fixture.
    let pcm_len = 16000u32 * 2 * 2;
    let mut wav = Vec::with_capacity(pcm_len as usize + 44);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(pcm_len + 36).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt \x10\0\0\0\x01\0\x01\0");
    wav.extend_from_slice(&16000u32.to_le_bytes());
    wav.extend_from_slice(&32000u32.to_le_bytes());
    wav.extend_from_slice(b"\x02\0\x10\0data");
    wav.extend_from_slice(&pcm_len.to_le_bytes());
    wav.resize(pcm_len as usize + 44, 0);
    std::fs::write(&path, wav)?;
    let media_id = "e2e-ai-recovery";
    let segments = vec![
        surtitle_core::SubtitleSegment {
            id: "e2e-ai-recovery-1".into(),
            media_id: media_id.into(),
            start_ms: 0,
            end_ms: 1000,
            text: "Hello.".into(),
            translation: None,
            status: "confirmed".into(),
        },
        surtitle_core::SubtitleSegment {
            id: "e2e-ai-recovery-2".into(),
            media_id: media_id.into(),
            start_ms: 1000,
            end_ms: 2000,
            text: "See you tomorrow.".into(),
            translation: None,
            status: "confirmed".into(),
        },
    ];
    {
        let mut db = lock(&state.db)?;
        db.put_media(&surtitle_core::Media {
            id: media_id.into(),
            title: title.into(),
            path: path.to_string_lossy().into_owned(),
            source_url: None,
            kind: "audio".into(),
            duration_ms: 2000,
            learning_language: "en".into(),
            explanation_language: "ja".into(),
            created_at: surtitle_core::now(),
            last_position_ms: 0,
            segment_count: segments.len(),
            card_count: 0,
            status: "ready".into(),
            error: None,
            audio_stream_index: Some(0),
            subtitle_stream_index: None,
        })?;
        db.set_segments(media_id, &segments)?;
    }
    let cues = segments
        .iter()
        .map(|s| SourceCue {
            id: s.id.clone(),
            start_ms: s.start_ms,
            end_ms: s.end_ms,
            text: s.text.clone(),
        })
        .collect::<Vec<_>>();
    let quote = state
        .ai
        .seed_translation_recovery_fixture(PreparedJob::new(
            title.into(),
            "e2e-project".into(),
            "unused-e2e-fixture".into(),
            PreparationBinding {
                media_id: media_id.into(),
                transcript_revision: transcript_fingerprint(&segments)?,
                source_sha256: sha256_bytes(&serde_json::to_vec(&cues)?),
                settings_sha256: settings_fingerprint(&lock(&state.preferences)?.settings)?,
            },
            vec![RequestTask::Translation {
                target_language: "ja".into(),
                cues,
            }],
            crate::model_commands::fixture_execution(),
        )?)?;
    let mut preferences = lock(&state.preferences)?;
    preferences.quotes.insert(
        quote.id,
        QuoteContext {
            media_id: media_id.into(),
            kind: "translate".into(),
            start_ms: 0,
            end_ms: 2000,
        },
    );
    state.save_preferences(&preferences)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn segment() -> surtitle_core::SubtitleSegment {
        surtitle_core::SubtitleSegment {
            id: "cue".into(),
            media_id: "media".into(),
            start_ms: 0,
            end_ms: 1000,
            text: "Hello.".into(),
            translation: None,
            status: "confirmed".into(),
        }
    }
    fn cue() -> SourceCue {
        SourceCue {
            id: "cue".into(),
            start_ms: 0,
            end_ms: 1000,
            text: "Hello.".into(),
        }
    }
    #[test]
    fn own_translation_updates_do_not_invalidate_approved_source() {
        let original = segment();
        let mut translated = original.clone();
        translated.translation = Some("こんにちは。".into());
        assert_eq!(
            transcript_fingerprint(&[original]).unwrap(),
            transcript_fingerprint(&[translated.clone()]).unwrap()
        );
        assert!(source_matches(&cue(), &translated, "media"));
    }
    #[test]
    fn edited_text_timing_status_or_media_invalidates_source() {
        let mut changed = segment();
        changed.text = "Goodbye.".into();
        assert!(!source_matches(&cue(), &changed, "media"));
        changed = segment();
        changed.end_ms = 1200;
        assert!(!source_matches(&cue(), &changed, "media"));
        changed = segment();
        changed.status = "draft".into();
        assert!(!source_matches(&cue(), &changed, "media"));
        assert!(!source_matches(&cue(), &segment(), "another-media"));
    }
    fn translation_fixture() -> (tempfile::TempDir, AppState, PreparedJob) {
        let temp = tempfile::tempdir().unwrap();
        let state = Services::open(temp.path().to_path_buf()).unwrap();
        let media = surtitle_core::Media {
            id: "media".into(),
            title: "Fixture".into(),
            path: temp
                .path()
                .join("fixture.mp4")
                .to_string_lossy()
                .into_owned(),
            source_url: None,
            kind: "video".into(),
            duration_ms: 2000,
            learning_language: "en".into(),
            explanation_language: "ja".into(),
            created_at: surtitle_core::now(),
            last_position_ms: 0,
            segment_count: 1,
            card_count: 0,
            status: "ready".into(),
            error: None,
            audio_stream_index: Some(0),
            subtitle_stream_index: None,
        };
        {
            let mut db = lock(&state.db).unwrap();
            db.put_media(&media).unwrap();
            db.set_segments("media", &[segment()]).unwrap();
        }
        let plan = PreparedJob::new(
            "Translation".into(),
            "test-project".into(),
            "unused".into(),
            PreparationBinding {
                media_id: "media".into(),
                transcript_revision: "revision".into(),
                source_sha256: sha256_bytes(b"source"),
                settings_sha256: sha256_bytes(b"settings"),
            },
            vec![RequestTask::Translation {
                target_language: "ja".into(),
                cues: vec![cue()],
            }],
            crate::model_commands::fixture_execution(),
        )
        .unwrap();
        (temp, state, plan)
    }
    fn translation() -> ParsedOutput {
        ParsedOutput::Translation {
            translations: vec![CueTranslation {
                id: "cue".into(),
                translation: "こんにちは。".into(),
            }],
        }
    }
    #[test]
    fn stale_translation_is_never_applied_to_edited_source() {
        let (_temp, state, plan) = translation_fixture();
        let mut changed = segment();
        changed.text = "Goodbye.".into();
        lock(&state.db).unwrap().edit_segment(&changed).unwrap();
        let output = ParsedOutput::Translation {
            translations: vec![CueTranslation {
                id: "cue".into(),
                translation: "こんにちは。".into(),
            }],
        };
        assert!(apply_received_output(&state, "job", 0, &plan, output).is_err());
        assert!(
            lock(&state.db)
                .unwrap()
                .segment("cue")
                .unwrap()
                .translation
                .is_none()
        );
    }
    #[test]
    fn local_application_persists_once_without_keys_or_budget_and_preserves_manual_edits() {
        let (temp, state, plan) = translation_fixture();
        assert!(lock(&state.preferences).unwrap().credential_id.is_none());
        assert_eq!(
            state.ai.summary().unwrap().monthly_actual_charged_microusd,
            0
        );
        let hash = sha256_bytes(&serde_json::to_vec(&translation()).unwrap());
        apply_received_output(&state, "job", 0, &plan, translation()).unwrap();
        assert!(
            lock(&state.db)
                .unwrap()
                .ai_result_applied("job", 0, &hash)
                .unwrap()
        );
        drop(state);
        let state = Services::open(temp.path().to_path_buf()).unwrap();
        let mut edited = lock(&state.db).unwrap().segment("cue").unwrap();
        assert_eq!(edited.translation.as_deref(), Some("こんにちは。"));
        edited.text = "The source was manually corrected.".into();
        edited.translation = Some("手動で変更した訳".into());
        lock(&state.db).unwrap().edit_segment(&edited).unwrap();
        drop(state);
        let state = Services::open(temp.path().to_path_buf()).unwrap();
        apply_received_output(&state, "job", 0, &plan, translation()).unwrap();
        assert_eq!(
            lock(&state.db).unwrap().segment("cue").unwrap().text,
            "The source was manually corrected."
        );
        assert!(
            lock(&state.db)
                .unwrap()
                .ai_result_applied("job", 0, &hash)
                .unwrap()
        );
        assert_eq!(
            lock(&state.db)
                .unwrap()
                .segment("cue")
                .unwrap()
                .translation
                .as_deref(),
            Some("手動で変更した訳")
        );
        assert!(state.ai.list_jobs().unwrap().is_empty());
        assert_eq!(
            state.ai.summary().unwrap().monthly_actual_charged_microusd,
            0
        );
    }
    #[test]
    fn translation_batch_rolls_back_every_row_and_marker_on_failure() {
        let (_temp, state, _plan) = translation_fixture();
        let mut first = segment();
        first.translation = Some("変更前にロールバック".into());
        let mut missing = first.clone();
        missing.id = "missing".into();
        let hash = sha256_bytes(b"response");
        let mut db = lock(&state.db).unwrap();
        assert!(
            db.apply_translations_once("job", 0, &hash, &[first, missing])
                .is_err()
        );
        assert!(db.segment("cue").unwrap().translation.is_none());
        assert!(!db.ai_result_applied("job", 0, &hash).unwrap());
    }
    #[test]
    fn translation_language_change_blocks_local_application() {
        let (_temp, state, plan) = translation_fixture();
        let db = lock(&state.db).unwrap();
        let mut media = db.media("media").unwrap();
        media.explanation_language = "de".into();
        db.put_media(&media).unwrap();
        drop(db);
        assert!(apply_received_output(&state, "job", 0, &plan, translation()).is_err());
        assert!(
            lock(&state.db)
                .unwrap()
                .segment("cue")
                .unwrap()
                .translation
                .is_none()
        );
    }
}
