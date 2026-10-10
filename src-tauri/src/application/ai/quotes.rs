use super::*;

pub(super) fn utc_time(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .unwrap_or_default()
        .to_rfc3339()
}

pub(crate) fn quote_for_ui(state: &AppState, quote: JobQuote, is_retry: bool) -> Result<AiQuote> {
    quote_for_ui_with_policy(state, quote, is_retry, true)
}

pub(super) fn quote_for_ui_with_policy(
    state: &AppState,
    quote: JobQuote,
    is_retry: bool,
    include_retry: bool,
) -> Result<AiQuote> {
    let p = state.preferences.read()?;
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
    let retry_not_before = state.ai.retry_not_before(&quote.id)?;
    let retry_policy = if include_retry {
        state.ai.transcription_retry_policy(&quote.id)?
    } else {
        None
    };
    let multiplier = retry_policy
        .as_ref()
        .map_or(1, |policy| u64::from(policy.max_retries) + 1);
    let base_additional = quote.additional_reservation_microusd;
    let additional = base_additional
        .map(|amount| {
            amount
                .checked_mul(multiplier)
                .context("Retry reservation exceeds the supported amount")
        })
        .transpose()?;
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
    } else if let Some(at) = retry_not_before.filter(|at| *at > now) {
        Some(tr(
            &format!(
                "混雑・利用制限（HTTP 429）のため、{} 以降に残りの処理を承認してください。",
                utc_time(at)
            ),
            &format!(
                "HTTP 429 requires waiting. Approve the remaining work after {}.",
                utc_time(at)
            ),
        ))
    } else if additional.is_some_and(|cost| {
        (limits.per_job_microusd > 0
            && quote
                .already_charged_or_held_microusd
                .checked_add(cost)
                .is_none_or(|n| n > limits.per_job_microusd))
            || (limits.daily_microusd > 0
                && summary
                    .daily_charged_or_held_microusd
                    .checked_add(cost)
                    .is_none_or(|n| n > limits.daily_microusd))
            || (limits.monthly_microusd > 0
                && summary
                    .monthly_charged_or_held_microusd
                    .checked_add(cost)
                    .is_none_or(|n| n > limits.monthly_microusd))
    }) {
        Some(tr(
            "既発生・保留額と今回の予約額が予算を超えます。",
            "Previous costs, held amounts, and this reservation exceed the budget.",
        ))
    } else {
        None
    };
    let mut warnings = if context.kind == "transcribe" {
        Vec::new()
    } else {
        vec![tr(
            "モデルの品質は保証されません。生成された内容を確認して利用してください。",
            "Model quality is not guaranteed. Review generated content before using it.",
        )]
    };
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
    let apply_policy = state.ai.prepared_job(&quote.id)?.apply_policy;
    Ok(AiQuote {
        id: quote.id,
        digest: quote.digest,
        media_id: context.media_id,
        kind: context.kind,
        start_ms: context.start_ms,
        end_ms: context.end_ms,
        model: quote.execution.model_id,
        location: quote.execution.location,
        estimated_usd: base_additional.map(|cost| cost as f64 / 1_000_000.),
        maximum_usd: additional.map(|cost| cost as f64 / 1_000_000.),
        input_tokens: remaining.iter().map(|r| r.input_tokens_reserved).sum(),
        max_output_tokens: quote.execution.max_output_tokens,
        total_output_tokens: remaining
            .iter()
            .map(|r| u64::from(r.max_output_tokens))
            .sum(),
        request_count: remaining.len(),
        send_duration_ms: remaining.iter().map(|r| r.audio_duration_ms).sum(),
        maximum_request_count: remaining.len() * multiplier as usize,
        maximum_send_duration_ms: remaining.iter().map(|r| r.audio_duration_ms).sum::<u64>()
            * multiplier,
        maximum_total_output_tokens: remaining
            .iter()
            .map(|r| u64::from(r.max_output_tokens))
            .sum::<u64>()
            * multiplier,
        retry_policy,
        pricing_source: quote.execution.price.map(|price| price.source),
        unpriced: additional.is_none(),
        expires_at: utc_time(quote.quote_expires_at_ms),
        warnings,
        can_approve: reason.is_none(),
        blocked_reason: reason,
        is_retry,
        focus_term,
        apply_policy,
    })
}

pub async fn create_quote(
    state: AppState,
    request: QuoteRequest,
) -> std::result::Result<AiQuote, String> {
    async {
        ensure!(request.end_ms>request.start_ms,"select a nonempty time range");
        ensure!(request.kind != "transcribe", "Prepare local audio before creating a transcription quote");
        let (media,all)={let db=lock(&state.db)?;(db.media(&request.media_id)?,db.list_segments(&request.media_id)?)};
        let cues:Vec<_>=all.iter().filter(|s|s.start_ms<request.end_ms&&s.end_ms>request.start_ms).map(|s|SourceCue{id:s.id.clone(),start_ms:s.start_ms,end_ms:s.end_ms,text:s.text.clone()}).collect();
        ensure!(!cues.is_empty()&&cues.len()<=1000,"select 1–1000 subtitle cues");
        ensure!(all.iter().filter(|s|cues.iter().any(|c|c.id==s.id)).all(|s|surtitle_core::is_usable_subtitle_status(&s.status)),"selected subtitles are not usable");
        let p=state.preferences.read()?.clone();
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
        let execution = crate::application::models::execution_for(&p.settings, purpose, request.model)?;
        let settings_hash=settings_fingerprint(&p.settings)?;
        // Text jobs bind to the exact selected textual input, not an expensive video hash.
        let source_hash=sha256_bytes(&serde_json::to_vec(&cues)?);
        let quote=state.ai.prepare(PreparedJob::new(format!("{} · {}",media.title,request.kind),p.settings.vertex_project,credential,PreparationBinding{media_id:media.id.clone(),transcript_revision:transcript_fingerprint(&all)?,source_sha256:source_hash,settings_sha256:settings_hash},requests,execution)?)?;
        let context=QuoteContext{media_id:media.id.clone(),kind:request.kind.clone(),start_ms:request.start_ms,end_ms:request.end_ms};
        {state.preferences.update(|p| {p.quotes.insert(quote.id.clone(),context);Ok(()) }) ?;}
        let quote=if quote.state=="prepared"&&quote.quote_expires_at_ms<=chrono::Utc::now().timestamp_millis(){state.ai.refresh_quote(&quote.id)?}else{quote};
        let is_retry=quote.state!="prepared"||quote.already_charged_or_held_microusd>0;
        quote_for_ui(&state,quote,is_retry)
    }.await.map_err(err)
}

pub fn create_retry_quote(state: AppState, job_id: String) -> std::result::Result<AiQuote, String> {
    review_ai_job(state, job_id)
}

pub fn review_ai_job(state: AppState, job_id: String) -> std::result::Result<AiQuote, String> {
    (|| {
        let mut quote = state.ai.quote(&job_id)?;
        let binding = verify_current_binding(&state, &state.ai.prepared_job(&job_id)?);
        if binding.is_ok() && quote.quote_expires_at_ms <= chrono::Utc::now().timestamp_millis()
            && ["prepared", "paused", "needs_review"].contains(&quote.state.as_str()) {
            quote = state.ai.refresh_quote(&job_id)?;
        }
        let retry = quote.state != "prepared";
        let mut view = quote_for_ui(&state, quote, retry)?;
        if let Err(error) = binding {
            jobs::record_failure(&state, &job_id, "source", &error)?;
            view.can_approve = false;
            view.blocked_reason = Some("元の字幕または動画が変更されています。現在の内容から準備し直してください。 / The source changed. Prepare a new job from its current content.".into());
        }
        Ok(view)
    })()
    .map_err(err)
}
