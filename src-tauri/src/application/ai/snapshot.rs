use super::*;
use crate::application::changes::ChangeDomain;

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) media: Option<Vec<surtitle_core::Media>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) cards: Option<Vec<surtitle_core::StudyCard>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) tools: Option<Vec<crate::application::tool_runtime::ToolStatus>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) settings: Option<surtitle_core::AppSettings>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) jobs: Option<Vec<JobSummary>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) budget: Option<BudgetSummary>,
}

pub fn get_app_snapshot(state: AppState) -> std::result::Result<AppSnapshot, String> {
    (|| {
        let (jobs, budget) = ai_snapshot(&state)?;
        let (media, cards) = {
            let db = lock(&state.db)?;
            (db.list_media()?, db.list_cards()?)
        };
        Ok(AppSnapshot {
            media,
            cards,
            tools: crate::application::tool_runtime::statuses(&state)?,
            settings: state.settings()?,
            jobs,
            budget,
        })
    })()
    .map_err(err)
}

pub fn get_snapshot_patch(
    state: AppState,
    domains: Vec<ChangeDomain>,
) -> std::result::Result<SnapshotPatch, String> {
    (|| {
        let mut patch = SnapshotPatch::default();
        if domains.contains(&ChangeDomain::Media) {
            patch.media = Some(lock(&state.db)?.list_media()?);
        }
        if domains.contains(&ChangeDomain::Cards) {
            patch.cards = Some(lock(&state.db)?.list_cards()?);
        }
        if domains.contains(&ChangeDomain::Settings) {
            patch.settings = Some(state.settings()?);
        }
        if domains.contains(&ChangeDomain::Tools) {
            patch.tools = Some(crate::application::tool_runtime::statuses(&state)?);
        }
        if domains.contains(&ChangeDomain::Jobs) || domains.contains(&ChangeDomain::Budget) {
            let (jobs, budget) = ai_snapshot(&state)?;
            if domains.contains(&ChangeDomain::Jobs) {
                patch.jobs = Some(jobs);
            }
            if domains.contains(&ChangeDomain::Budget) {
                patch.budget = Some(budget);
            }
        }
        Ok(patch)
    })()
    .map_err(err)
}

fn ai_snapshot(state: &AppState) -> Result<(Vec<JobSummary>, BudgetSummary)> {
    let p = state.preferences.read()?.clone();
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
            .filter(|quote| quote.state != "prepared")
            .map(|q| {
                let has_audio = q.requests.iter().any(|request| request.audio_duration_ms > 0);
                let has_transcript_result = has_audio && state.ai.has_transcript_result(&q.id)?;
                let applied = has_audio && (lock(&state.db)?.transcript_adopted(&q.id, &q.digest)?.is_some()
                    || state.ai.transcript_application_recorded(&q.id, &q.digest)?);
                let plan = state.ai.prepared_job(&q.id)?;
                let automatic = has_audio && plan.apply_policy == TranscriptApplyPolicy::Auto;
                let skip_rejected = plan.text_failure_policy == TextFailurePolicy::SkipRejected;
                let transcript_review = has_transcript_result && !applied && !automatic;
                let transcription_ranges = if has_audio {
                    // Damaged or unavailable local preparation metadata must
                    // not hide the library or the independently stored ledger.
                    crate::application::transcript::automatic::progress_ranges(state, &q.id).unwrap_or_default()
                } else { Vec::new() };
                let result_state = if applied {
                    let has_warnings = crate::application::transcript::automatic::applied_has_warnings(state, &q.id)?;
                    if has_warnings { "applied_with_warnings" } else { "applied" }
                } else if has_transcript_result { "ready" } else { "none" };
                let issue = state.ai.job_issue(&q.id)?;
                let retry = state.ai.retry_status(&q.id)?;
                let pacing = state.ai.pacing_status(&q.id)?;
                let pending_results = saved_results(state, &q.id)?
                    .iter()
                    .filter(|result| !result.applied)
                    .count();
                let context = p.quotes.get(&q.id);
                let status = if unknown_jobs.contains(q.id.as_str()) {
                    "unknown"
                } else if applied {
                    "completed"
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
                let execution_outcome = execution_outcome(&q, status, skip_rejected, issue.as_ref());
                let (ja, en) = match issue.as_ref().map(|issue| issue.code.as_str()) {
                    Some("credentials") => ("認証設定を確認してください。受信済み結果は保存されています。", "Check your credentials. Received results are saved."),
                    Some("budget") => ("予算の上限に達しました。設定を見直して残りを再開できます。", "The budget limit was reached. Update it to resume the remaining work."),
                    Some("provider") if status == "paused" && issue.as_ref().is_some_and(|issue| issue.http_status == Some(429)) => ("一時停止しています。混雑・利用制限（HTTP 429）の費用記録と受信済み結果は保持しています。続行には残りの処理の承認が必要です。", "Paused. Accounting for HTTP 429 and received results are retained. Approve the remaining work to continue."),
                    Some("provider") if status == "cancelled" && issue.as_ref().is_some_and(|issue| issue.http_status == Some(429)) => ("キャンセルしました。混雑・利用制限（HTTP 429）の費用記録と受信済み結果は保持しています。", "Cancelled. Accounting for HTTP 429 and received results are retained."),
                    Some("provider") if status == "unknown" && issue.as_ref().is_some_and(|issue| issue.http_status == Some(429)) => ("混雑・利用制限（HTTP 429）で停止しました。旧承認の要求は結果不明として費用記録を保持しています。結果不明の要求を確認してから、残りの処理を承認してください。", "Stopped by congestion or a usage limit (HTTP 429). Accounting for this earlier approval is retained as unknown. Acknowledge the unknown request before approving the remaining work."),
                    Some("provider") if issue.as_ref().is_some_and(|issue| issue.http_status == Some(429)) => ("混雑・利用制限（HTTP 429）で停止しました。完了済みの区間は保存されています。残りの処理を確認して再開できます。", "Stopped by congestion or a usage limit (HTTP 429). Completed sections are saved. Review the remaining work to resume."),
                    Some("provider") => ("サービスがリクエストを受け付けませんでした。モデルとプロジェクトの設定を確認してください。", "The service rejected the request. Check the model and project settings."),
                    Some("source_changed") => ("元の動画または字幕が変更されています。受信済み結果は保存されています。", "The source media or subtitles changed. Received results are saved."),
                    Some("local_apply") => ("結果は受信済みですが、字幕への反映に失敗しました。追加送信せずに反映を再試行できます。", "Results were received but could not be applied. Retry applying without another request."),
                    Some("invalid_output") => ("受信結果を確定できませんでした。処理の詳細を確認し、必要な範囲を再見積もりできます。", "The response could not be finalized. Check the processing details and estimate the needed work again."),
                    Some("output_limit") => ("出力上限に達し、この結果を確定できませんでした。対象範囲や出力設定を見直して再見積もりできます。", "The response reached its output limit and could not be finalized. Adjust the scope or output settings and review a new estimate."),
                    Some("output_blocked") => ("サービスがこの応答を返せなかったため、結果を確定できませんでした。対象の内容を確認してください。", "The provider blocked this response. Review the selected source."),
                    Some("output_incomplete") => ("応答が完了していないため、結果を確定できませんでした。受信した途中の内容は処理の詳細で確認できます。", "The response was incomplete. Its unfinished content is available in the processing details."),
                    Some("output_json" | "output_fields") => ("応答が必要な形式を満たさず、結果を確定できませんでした。受信内容と利用記録は処理の詳細で確認できます。", "The response did not match the required format. Check its received content and usage in the processing details."),
                    Some("output_source") => ("応答の表現または出典が選択した字幕と一致せず、結果を確定できませんでした。対象の表現と字幕を確認してください。", "The expression or citations did not match the selected subtitles. Review the selected phrase and source."),
                    _ => match status {
                    "unknown" => ("結果不明です。費用記録を保持しています。再実行は別途承認が必要です。", "The outcome is unknown. Accounting is retained. Retrying requires separate approval."),
                    "paused" => ("一時停止しています。続行には残りの処理の承認が必要です。", "Paused. Approve the remaining work to continue."),
                    "failed" => ("処理または元字幕の確認が必要です。受信済み結果と費用は保存されています。", "Review the job or source subtitles. Received results and accounting have been retained."),
                    _ if pending_results > 0 => ("受信済み翻訳を保存しています。確認して適用できます。追加送信はありません。", "Received translations are saved. Review and apply them without another request."),
                    "queued" => ("実行の承認を待っています。", "Waiting for your approval."),
                    "completed" if applied => ("文字起こしが完了しました。字幕はそのまま使えます。", "Transcription is complete. Your subtitles are ready to use."),
                    "completed" if transcript_review => ("結果を受信しました。字幕への反映を確認してください。", "Results received. Review them to apply the subtitles."),
                    "completed" => ("承認された処理が完了しました。", "The approved work is complete."),
                    "cancelled" => ("キャンセルしました。受信済み結果と費用記録は保持します。", "Cancelled. Received results and accounting are retained."),
                    _ if automatic => ("文字起こし中です。届いた字幕から学習できます。", "Transcribing. You can study the subtitles as they arrive."),
                    _ => ("承認された範囲を処理しています。", "Processing the approved scope."),
                    },
                };
                let needs_attention = issue.is_some() || pending_results > 0 || transcript_review
                    || ["unknown", "paused", "failed", "queued"].contains(&status);
                let (ja, en) = match retry.as_ref().map(|retry| retry.state.as_str()) {
                    Some("waiting") if status == "running" => ("混雑・利用制限（HTTP 429）のため待機しています。同じ区間を再試行します。", "Waiting after congestion or a usage limit (HTTP 429). The same section will be retried."),
                    Some("retrying") if status == "running" => ("混雑・利用制限（HTTP 429）が発生した区間を再試行しています。", "Retrying the section that received HTTP 429."),
                    Some("exhausted") if status == "failed" => ("混雑・利用制限（HTTP 429）の再試行上限に達しました。完了済みの区間は保存されています。残りの処理には再承認が必要です。", "The HTTP 429 retry limit was reached. Completed sections are saved. Approve the remaining work to continue."),
                    Some("deferred") if status == "failed" => ("混雑・利用制限（HTTP 429）により5分を超える待機が必要です。表示された再開可能時刻以降に残りの処理を承認してください。", "HTTP 429 requires waiting longer than five minutes. Approve the remaining work after the displayed resume time."),
                    _ if status == "running" && pacing.as_ref().is_some_and(|pacing| pacing.slowed) => ("混雑を避けるため送信間隔を調整しています。受信済み字幕は使えます。", "Spacing requests to reduce congestion. Received subtitles remain available."),
                    _ if status == "running" && pacing.is_some() => ("次の区間の送信まで待機しています。受信済み字幕は使えます。", "Waiting before sending the next section. Received subtitles remain available."),
                    _ => (ja, en),
                };
                let (ja, en) = if skip_rejected && status == "running" && q.request_counts.rejected > 0 {
                    ("取得できなかった区間を記録し、残りの区間を処理しています。成功した結果はそのまま使えます。", "Skipped a rejected response and continued with the remaining sections. Successful results remain available.")
                } else if execution_outcome.as_deref() == Some("partial") {
                    ("全区間の処理が終了しました。一部の結果を取得できませんでしたが、成功した結果は使えます。", "All sections were processed. Some responses could not be finalized; successful results are available.")
                } else { (ja, en) };
                let (ja, en) = if status == "running" && state.ai_session.dispatch.is_waiting(&q.id) {
                    ("順番を待っています。実行中の区間が終わると処理します。", "Queued. Processing continues after the current request finishes.")
                } else { (ja, en) };
                let message = if p.settings.locale == "ja" { ja } else { en }.to_owned();
                let processed = if skip_rejected { q.request_counts.succeeded + q.request_counts.rejected } else { q.completed_requests };
                Ok(JobSummary {
                    id: q.id,
                    media_id: Some(q.binding.media_id),
                    kind: context.map(|c| c.kind.clone()).unwrap_or(q.title),
                    status: status.into(),
                    progress: processed as f64 / q.requests.len().max(1) as f64,
                    request_counts: q.request_counts,
                    execution_outcome,
                    message: Some(message),
                    created_at: utc_time(q.created_at_ms),
                    pending_results,
                    transcript_review,
                    has_transcript_result,
                    needs_attention,
                    result_state: result_state.into(),
                    issue,
                    automatic_transcript: automatic,
                    transcription_ranges,
                    retry,
                    pacing,
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
            held_usd: a
                .held_or_charged_microusd
                .map(|amount| amount as f64 / 1_000_000.),
            created_at: utc_time(a.created_at_ms),
        })
        .collect();
    let budget = BudgetSummary {
        spent_usd: summary.monthly_actual_charged_microusd as f64 / 1_000_000.,
        reserved_usd: summary.monthly_held_microusd as f64 / 1_000_000.,
        limit_usd: summary.limits.monthly_microusd as f64 / 1_000_000.,
        unknown_attempts,
        unpriced_attempts: summary.unpriced_attempts,
        monetary_totals_complete: summary.monetary_totals_complete,
    };
    Ok((jobs, budget))
}

fn execution_outcome(
    quote: &JobQuote,
    status: &str,
    skip_rejected: bool,
    issue: Option<&JobIssue>,
) -> Option<String> {
    let counts = &quote.request_counts;
    Some(
        match status {
            "queued" => return None,
            "running" => "running",
            "completed" => "complete",
            "paused" | "cancelled" | "unknown" => "stopped",
            _ if skip_rejected
                && counts.rejected > 0
                && counts.pending == 0
                && counts.in_flight == 0
                && issue
                    .is_none_or(|issue| OutputFailureReason::from_code(&issue.code).is_some()) =>
            {
                if counts.succeeded > 0 {
                    "partial"
                } else {
                    "failed"
                }
            }
            _ if counts.pending > 0
                || counts.in_flight > 0
                || issue
                    .is_some_and(|issue| OutputFailureReason::from_code(&issue.code).is_none()) =>
            {
                "stopped"
            }
            _ => "failed",
        }
        .into(),
    )
}
