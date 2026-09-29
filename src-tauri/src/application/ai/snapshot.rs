use super::*;

pub fn get_app_snapshot(state: AppState) -> std::result::Result<AppSnapshot, String> {
    (|| {
        let (media, cards) = {
            let db = lock(&state.db)?;
            (db.list_media()?, db.list_cards()?)
        };
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
            tools: crate::application::tool_runtime::statuses(&state)?,
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
