//! Opt-in development qualification. A scoped store clone grants one reviewed
//! immutable request; enabling the feature alone never unlocks desktop audio.
use super::*;
mod campaigns;
pub use campaigns::{ValidationCampaignApproval, ValidationCampaignJob, ValidationCampaignQuote};
const MAX_VALIDATION_REQUESTS: u64 = 120;
const MAX_VALIDATION_AUDIO_MS: u64 = 90 * 60 * 1000;
const MAX_DIAGNOSTIC_BYTES: usize = 128 * 1024;

#[derive(Debug, Clone)]
pub struct ValidationApproval {
    pub plan_digest: String,
    pub model: String,
    pub max_requests: u32,
    pub expires_at_ms: i64,
    pub max_reservation_microusd: Option<u64>,
    pub total_limit_microusd: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationTotals {
    pub total_limit_microusd: u64,
    pub charged_or_held_microusd: u64,
    pub unpriced_attempts: u64,
    pub monetary_totals_complete: bool,
    pub max_requests: u64,
    pub attempted_requests: u64,
    pub remaining_requests: u64,
    pub max_audio_duration_ms: u64,
    pub attempted_audio_duration_ms: u64,
    pub remaining_audio_duration_ms: u64,
    pub legacy_attempted_requests: u64,
    pub legacy_attempted_audio_duration_ms: u64,
    pub campaign_attempted_requests: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationAttempt {
    pub id: String,
    pub job_id: String,
    pub ordinal: u32,
    pub state: String,
    pub reserved_microusd: Option<u64>,
    pub charged_microusd: Option<u64>,
    pub created_at_ms: i64,
    pub dispatched_at_ms: Option<i64>,
    pub settled_at_ms: Option<i64>,
    pub usage: serde_json::Value,
    pub evidence: Option<serde_json::Value>,
    pub model_version: Option<String>,
    pub usage_state: String,
    pub cost_state: String,
}

#[derive(Debug, Clone)]
pub(super) struct DevelopmentScope {
    job_id: String,
    approval: ValidationApproval,
    previous_attempts: u64,
    audio_duration_ms: u64,
    campaign: Option<(String, String)>,
}

impl DevelopmentScope {
    pub(super) fn verify(&self, plan: &PreparedJob, job_id: &str, at: i64) -> Result<()> {
        if job_id != self.job_id
            || self.approval.max_requests != 1
            || plan.requests.len() != 1
            || at >= self.approval.expires_at_ms
            || plan.digest()? != self.approval.plan_digest
            || plan.execution.model_id != self.approval.model
            || plan.estimates()?[0].audio_duration_ms > 240_000
            || plan.estimates()?[0].estimated_max_microusd != self.approval.max_reservation_microusd
        {
            return Err(AiError::ApprovalRequired);
        }
        Ok(())
    }
}

impl AiStore {
    /// Initialize the isolated validation database once. There is deliberately no
    /// reset/update API: accepted unknown attempts remain spent across restarts,
    /// retries, UTC days, and months.
    pub fn initialize_validation_total(&self, limit_microusd: u64) -> Result<()> {
        if limit_microusd == 0 || limit_microusd > 1_000_000_000_000 {
            return Err(AiError::Invalid(
                "Choose an explicit positive validation total".into(),
            ));
        }
        let mut connection = self.connect()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute_batch("CREATE TABLE IF NOT EXISTS ai_validation_settings (
            id INTEGER PRIMARY KEY CHECK(id=1), total_limit_microusd INTEGER NOT NULL CHECK(total_limit_microusd>0),
            max_requests INTEGER NOT NULL CHECK(max_requests>0), max_audio_duration_ms INTEGER NOT NULL CHECK(max_audio_duration_ms>0)
        ); CREATE TABLE IF NOT EXISTS ai_validation_evidence (
            attempt_id TEXT PRIMARY KEY REFERENCES ai_attempts(id), evidence_json TEXT NOT NULL
        );")?;
        let attempts: i64 =
            tx.query_row("SELECT COUNT(*) FROM ai_attempts", [], |row| row.get(0))?;
        let initialized: i64 =
            tx.query_row("SELECT COUNT(*) FROM ai_validation_settings", [], |row| {
                row.get(0)
            })?;
        if attempts != 0 || initialized != 0 {
            return Err(AiError::Invalid(
                "Validation totals already initialized; resetting is forbidden".into(),
            ));
        }
        tx.execute(
            "INSERT INTO ai_validation_settings VALUES (1,?,?,?)",
            params![
                limit_microusd as i64,
                MAX_VALIDATION_REQUESTS as i64,
                MAX_VALIDATION_AUDIO_MS as i64
            ],
        )?;
        audit(
            &tx,
            self.now_ms(),
            "validation_total_initialized",
            None,
            &limit_microusd.to_string(),
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn validation_totals(&self) -> Result<ValidationTotals> {
        validation_totals(&self.connect()?)
    }

    pub fn validation_attempts(&self) -> Result<Vec<ValidationAttempt>> {
        let connection = self.connect()?;
        let mut statement = connection.prepare("SELECT a.id,a.job_id,a.ordinal,a.state,a.reserve_microusd,a.charged_microusd,a.created_at_ms,a.dispatched_at_ms,a.settled_at_ms,a.usage_json,e.evidence_json,a.model_version FROM ai_attempts a LEFT JOIN ai_validation_evidence e ON e.attempt_id=a.id ORDER BY a.created_at_ms,a.id")?;
        let rows = statement.query_map([], |row| {
            let usage: Option<String> = row.get(9)?;
            let evidence: Option<String> = row.get(10)?;
            let reserved: Option<i64> = row.get(4)?;
            let charged: Option<i64> = row.get(5)?;
            let state: String = row.get(3)?;
            Ok(ValidationAttempt {
                model_version: row.get(11)?,
                usage_state: if state == "settled" && usage.is_some() {
                    "known"
                } else {
                    "unknown"
                }
                .into(),
                cost_state: if charged.is_some() {
                    "calculated"
                } else if reserved.is_some() {
                    "held"
                } else {
                    "unpriced"
                }
                .into(),
                id: row.get(0)?,
                job_id: row.get(1)?,
                ordinal: row.get(2)?,
                state: row.get(3)?,
                reserved_microusd: row.get::<_, Option<i64>>(4)?.map(|n| n as u64),
                charged_microusd: row.get::<_, Option<i64>>(5)?.map(|n| n as u64),
                created_at_ms: row.get(6)?,
                dispatched_at_ms: row.get(7)?,
                settled_at_ms: row.get(8)?,
                usage: usage
                    .and_then(|v| serde_json::from_str(&v).ok())
                    .map(|v| sanitized_usage(&v))
                    .unwrap_or_else(|| serde_json::json!({})),
                evidence: evidence.and_then(|v| serde_json::from_str(&v).ok()),
            })
        })?;
        rows.collect::<std::result::Result<_, _>>()
            .map_err(Into::into)
    }

    /// Keep bounded, allowlisted provider evidence for development evaluation.
    /// Generated non-thought text may include source material. Authorization
    /// headers, credentials, thought text and arbitrary provider diagnostics are
    /// never read or persisted by this method.
    pub(crate) fn record_validation_evidence(
        &self,
        reservation: &ReservedRequest,
        response: &serde_json::Value,
    ) -> Result<()> {
        let Some(scope) = &self.development else {
            return Ok(());
        };
        if scope.job_id != reservation.job_id
            || scope.approval.model != reservation.execution.model_id
        {
            return Err(AiError::ApprovalRequired);
        }
        let evidence = sanitized_evidence(response);
        self.connect()?.execute(
            "INSERT INTO ai_validation_evidence(attempt_id,evidence_json) VALUES (?,?)",
            params![reservation.attempt_id, serde_json::to_string(&evidence)?],
        )?;
        Ok(())
    }

    /// Scope an in-memory development permit to the reviewed job, model, digest,
    /// count, expiry, reservation and durable lifetime total. No permit is saved
    /// in preferences or reconstructed automatically after restart.
    pub fn with_development_validation(
        &self,
        job_id: &str,
        approval: ValidationApproval,
    ) -> Result<Self> {
        let at = self.now_ms();
        if approval.expires_at_ms <= at
            || approval.expires_at_ms > at.saturating_add(30 * 60 * 1000)
            || approval
                .max_reservation_microusd
                .is_some_and(|n| n > approval.total_limit_microusd)
        {
            return Err(AiError::ApprovalRequired);
        }
        let previous_attempts: u32 = self.connect()?.query_row(
            "SELECT COUNT(*) FROM ai_attempts WHERE job_id=?",
            [job_id],
            |row| row.get(0),
        )?;
        let prepared = self.prepared_job(job_id)?;
        let audio_duration_ms = prepared.estimates()?[0].audio_duration_ms;
        let scope = DevelopmentScope {
            job_id: job_id.into(),
            approval,
            previous_attempts: previous_attempts as u64,
            audio_duration_ms,
            campaign: None,
        };
        if campaigns::job_campaign(&self.connect()?, job_id)?.is_some() {
            return Err(AiError::ApprovalRequired);
        }
        scope.verify(&prepared, job_id, at)?;
        let totals = self.validation_totals()?;
        if totals.total_limit_microusd != scope.approval.total_limit_microusd {
            return Err(AiError::ApprovalRequired);
        }
        let mut scoped = self.clone();
        scoped.development = Some(std::sync::Arc::new(scope));
        Ok(scoped)
    }

    pub(super) fn check_development_budget(
        &self,
        connection: &Connection,
        additional: u64,
        reserving: bool,
    ) -> Result<()> {
        let Some(scope) = &self.development else {
            let isolated: bool = connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='ai_validation_settings')",
                [], |row| row.get(0))?;
            if isolated {
                return Err(AiError::ApprovalRequired);
            }
            return Ok(());
        };
        let attempts: u32 = connection.query_row(
            "SELECT COUNT(*) FROM ai_attempts WHERE job_id=?",
            [&scope.job_id],
            |row| row.get(0),
        )?;
        let max_attempts = scope.previous_attempts + scope.approval.max_requests as u64;
        if attempts as u64 > max_attempts || (reserving && attempts as u64 >= max_attempts) {
            return Err(AiError::ApprovalRequired);
        }
        let totals = validation_totals(connection)?;
        if scope.campaign.is_some() && !totals.monetary_totals_complete {
            return Err(AiError::ApprovalRequired);
        }
        if totals.total_limit_microusd != scope.approval.total_limit_microusd {
            return Err(AiError::ApprovalRequired);
        }
        let additional_requests = u64::from(reserving);
        let additional_audio = if reserving {
            scope.audio_duration_ms
        } else {
            0
        };
        if let Some((id, digest)) = &scope.campaign {
            campaigns::check_campaign(connection, scope, id, digest, self.now_ms(), reserving)?;
        } else if campaigns::job_campaign(connection, &scope.job_id)?.is_some() {
            return Err(AiError::ApprovalRequired);
        } else if totals
            .legacy_attempted_requests
            .saturating_add(additional_requests)
            > totals.max_requests
        {
            return Err(AiError::BudgetExceeded("validation request count"));
        }
        if scope.campaign.is_none()
            && totals
                .legacy_attempted_audio_duration_ms
                .saturating_add(additional_audio)
                > totals.max_audio_duration_ms
        {
            return Err(AiError::BudgetExceeded("validation audio duration"));
        }
        if totals
            .charged_or_held_microusd
            .checked_add(additional)
            .is_none_or(|n| n > totals.total_limit_microusd)
        {
            return Err(AiError::BudgetExceeded("validation lifetime"));
        }
        Ok(())
    }
}

fn sanitized_usage(usage: &serde_json::Value) -> serde_json::Value {
    let mut kept = serde_json::Map::new();
    for name in [
        "promptTokenCount",
        "candidatesTokenCount",
        "thoughtsTokenCount",
        "totalTokenCount",
        "cachedContentTokenCount",
    ] {
        if let Some(value) = usage.get(name).and_then(serde_json::Value::as_u64) {
            kept.insert(name.into(), value.into());
        }
    }
    serde_json::Value::Object(kept)
}

fn sanitized_evidence(response: &serde_json::Value) -> serde_json::Value {
    use serde_json::{json, Value};
    fn bounded_text(value: Option<&Value>, max: usize) -> Option<String> {
        value
            .and_then(Value::as_str)
            .filter(|s| s.len() <= max)
            .map(str::to_owned)
    }
    let mut transcriptions = Vec::new();
    let mut omitted = false;
    let (diagnostics, diagnostics_truncated) = candidate_diagnostics(response);
    omitted |= diagnostics_truncated;
    if let Some(parts) = response
        .pointer("/candidates/0/content/parts")
        .and_then(Value::as_array)
    {
        for part in parts.iter().take(32) {
            if part.get("thought").and_then(Value::as_bool) == Some(true) {
                continue;
            }
            let Some(tx) = part.get("audioTranscription") else {
                continue;
            };
            let mut words = Vec::new();
            if let Some(raw) = tx.get("words").and_then(Value::as_array) {
                omitted |= raw.len() > 20_000;
                for word in raw.iter().take(20_000) {
                    words.push(json!({"word":bounded_text(word.get("word"),2048),
                        "startOffset":bounded_text(word.get("startOffset"),64),"endOffset":bounded_text(word.get("endOffset"),64)}));
                }
            }
            transcriptions.push(json!({"text":bounded_text(tx.get("text"),100_000),
                "finished":tx.get("finished").and_then(Value::as_bool),"words":words}));
        }
        omitted |= parts.len() > 32;
    }
    let mut evidence = json!({"usage":sanitized_usage(&response["usageMetadata"]),"audioTranscriptions":transcriptions,"candidateDiagnostics":diagnostics,"evidenceTruncated":omitted});
    if serde_json::to_vec(&evidence).map_or(true, |bytes| bytes.len() > 1024 * 1024) {
        evidence["audioTranscriptions"] = json!([]);
        evidence["evidenceTruncated"] = json!(true);
    }
    evidence
}

fn candidate_diagnostics(response: &serde_json::Value) -> (serde_json::Value, bool) {
    use serde_json::{json, Value};
    // Reserve room for the bounded array/object keys, booleans, indices and
    // commas. The remaining budget counts JSON-encoded text bytes, not chars.
    let mut remaining = MAX_DIAGNOSTIC_BYTES - 8192;
    let mut omitted = false;
    let mut diagnostics = Vec::new();
    if let Some(candidates) = response.get("candidates").and_then(Value::as_array) {
        omitted |= candidates.len() > 8;
        for (index, candidate) in candidates.iter().take(8).enumerate() {
            let finish_reason =
                candidate
                    .get("finishReason")
                    .and_then(Value::as_str)
                    .map(|reason| match reason {
                        "STOP"
                        | "MAX_TOKENS"
                        | "SAFETY"
                        | "RECITATION"
                        | "OTHER"
                        | "BLOCKLIST"
                        | "PROHIBITED_CONTENT"
                        | "SPII"
                        | "MALFORMED_FUNCTION_CALL"
                        | "FINISH_REASON_UNSPECIFIED"
                        | "IMAGE_SAFETY"
                        | "IMAGE_PROHIBITED_CONTENT"
                        | "IMAGE_RECITATION"
                        | "IMAGE_OTHER"
                        | "NO_IMAGE"
                        | "UNEXPECTED_TOOL_CALL"
                        | "TOO_MANY_TOOL_CALLS" => reason,
                        _ => "UNRECOGNIZED",
                    });
            let mut texts = Vec::new();
            let mut truncated = false;
            if let Some(parts) = candidate
                .pointer("/content/parts")
                .and_then(Value::as_array)
            {
                truncated |= parts.len() > 32;
                for part in parts.iter().take(32) {
                    if part.get("thought").and_then(Value::as_bool) == Some(true) {
                        continue;
                    }
                    if let Some(text) = part.get("text").and_then(Value::as_str) {
                        let (bounded, was_truncated) = diagnostic_text(text, &mut remaining);
                        texts.push(bounded);
                        truncated |= was_truncated;
                    }
                }
            }
            omitted |= truncated;
            diagnostics.push(json!({"index":index,"finishReason":finish_reason,"textParts":texts,"textTruncated":truncated}));
        }
    }
    let diagnostics = json!(diagnostics);
    if serde_json::to_vec(&diagnostics).map_or(true, |v| v.len() > MAX_DIAGNOSTIC_BYTES) {
        return (json!([]), true);
    }
    (diagnostics, omitted)
}

fn diagnostic_text(text: &str, remaining: &mut usize) -> (String, bool) {
    if *remaining < 2 {
        return (String::new(), !text.is_empty());
    }
    *remaining -= 2; // JSON string quotes.
    let mut end = 0;
    for (offset, ch) in text.char_indices() {
        let encoded = match ch {
            '"' | '\\' | '\u{08}' | '\u{0c}' | '\n' | '\r' | '\t' => 2,
            '\0'..='\u{1f}' => 6,
            _ => ch.len_utf8(),
        };
        if encoded > *remaining {
            break;
        }
        *remaining -= encoded;
        end = offset + ch.len_utf8();
    }
    (text[..end].to_owned(), end < text.len())
}

fn validation_totals(connection: &Connection) -> Result<ValidationTotals> {
    let total: i64 = connection.query_row(
        "SELECT total_limit_microusd FROM ai_validation_settings WHERE id=1",
        [],
        |row| row.get(0),
    )?;
    let spent: i64 = connection.query_row(
        "SELECT COALESCE(SUM(COALESCE(charged_microusd,reserve_microusd)),0) FROM ai_attempts",
        [],
        |row| row.get(0),
    )?;
    if total <= 0 || spent < 0 {
        return Err(AiError::Invalid("Invalid validation budget state".into()));
    }
    let (max_requests, max_audio_duration_ms): (u32, u64) = connection.query_row(
        "SELECT max_requests,max_audio_duration_ms FROM ai_validation_settings WHERE id=1",
        [],
        |row| Ok((row.get(0)?, row.get::<_, i64>(1)? as u64)),
    )?;
    let mut statement = connection.prepare(
        "SELECT j.plan_json,a.ordinal FROM ai_attempts a JOIN ai_jobs j ON j.id=a.job_id",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, u32>(1)?))
    })?;
    let mut attempted_requests = 0u64;
    let mut attempted_audio_duration_ms = 0u64;
    for row in rows {
        let (plan, ordinal) = row?;
        let plan: PreparedJob = serde_json::from_str(&plan)?;
        let task = plan
            .requests
            .get(ordinal as usize)
            .ok_or(AiError::PreparationChanged)?;
        attempted_requests = attempted_requests.saturating_add(1);
        attempted_audio_duration_ms =
            attempted_audio_duration_ms.saturating_add(task.estimate(ordinal)?.audio_duration_ms);
    }
    let (campaign_attempted_requests, campaign_audio) = campaigns::attempt_totals(connection)?;
    let legacy_attempted_requests = attempted_requests.saturating_sub(campaign_attempted_requests);
    let legacy_attempted_audio_duration_ms =
        attempted_audio_duration_ms.saturating_sub(campaign_audio);
    Ok(ValidationTotals {
        unpriced_attempts: unpriced_count(connection, None)?,
        monetary_totals_complete: unpriced_count(connection, None)? == 0,
        total_limit_microusd: total as u64,
        charged_or_held_microusd: spent as u64,
        max_requests: max_requests as u64,
        attempted_requests,
        remaining_requests: (max_requests as u64).saturating_sub(legacy_attempted_requests),
        max_audio_duration_ms,
        attempted_audio_duration_ms,
        remaining_audio_duration_ms: max_audio_duration_ms
            .saturating_sub(legacy_attempted_audio_duration_ms),
        legacy_attempted_requests,
        legacy_attempted_audio_duration_ms,
        campaign_attempted_requests,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    pub(super) fn setup() -> (tempfile::TempDir, AiStore, JobQuote) {
        let directory = tempfile::tempdir().unwrap();
        let store = AiStore::open(directory.path().join("validation.sqlite")).unwrap();
        store.initialize_validation_total(2_000_000).unwrap();
        store
            .set_budget(BudgetLimits {
                per_job_microusd: 2_000_000,
                daily_microusd: 2_000_000,
                monthly_microusd: 2_000_000,
            })
            .unwrap();
        let quote = store
            .prepare(PreparedJob::fixture(
                "Development audio validation".into(),
                "fixture-project".into(),
                "fixture-key".into(),
                PreparationBinding {
                    media_id: "clip".into(),
                    transcript_revision: "one".into(),
                    source_sha256: crate::sha256_bytes(b"audio"),
                    settings_sha256: crate::sha256_bytes(b"settings"),
                },
                vec![RequestTask::TranscribePreview {
                    language: "en-US".into(),
                    audio: AudioAttachment {
                        path: "not-opened.flac".into(),
                        sha256: crate::sha256_bytes(b"audio"),
                        byte_len: 5,
                        mime_type: "audio/flac".into(),
                        source_start_ms: 0,
                        duration_ms: 1000,
                    },
                }],
            ))
            .unwrap();
        (directory, store, quote)
    }
    pub(super) fn approval(q: &JobQuote) -> ValidationApproval {
        ValidationApproval {
            plan_digest: q.digest.clone(),
            model: TRANSCRIBE_MODEL.into(),
            max_requests: 1,
            expires_at_ms: TEST_NOW_MS + 60_000,
            max_reservation_microusd: q.estimated_max_microusd,
            total_limit_microusd: 2_000_000,
        }
    }
    #[test]
    fn ordinary_audio_scope_is_explicit_and_development_limits_remain_separate() {
        let (_directory, store, quote) = setup();
        assert!(store
            .approve_scope(&quote.id, &quote.digest, false, false)
            .is_err());
        assert!(store.reserve_next(&quote.id).is_err());
        assert!(store
            .approve_scope(&quote.id, &quote.digest, false, true)
            .is_err());
        let scoped = store
            .with_development_validation(&quote.id, approval(&quote))
            .unwrap();
        scoped
            .approve_scope(&quote.id, &quote.digest, false, true)
            .unwrap();
        let reservation = scoped.reserve_next(&quote.id).unwrap().unwrap();
        assert!(store.validate_dispatch(&reservation).is_err());
        scoped.validate_dispatch(&reservation).unwrap();
        assert_eq!(reservation.execution.model_id, TRANSCRIBE_MODEL);
    }
    #[test]
    fn long_audio_validation_remains_one_request_with_lifetime_audio_accounting() {
        let (_directory, store, initial) = setup();
        let mut plan = store.prepared_job(&initial.id).unwrap();
        if let RequestTask::TranscribePreview { audio, .. } = &mut plan.requests[0] {
            audio.duration_ms = 240_000;
        }
        let quote = store.prepare(plan.refreeze()).unwrap();
        let scoped = store
            .with_development_validation(&quote.id, approval(&quote))
            .unwrap();
        scoped
            .approve_scope(&quote.id, &quote.digest, false, true)
            .unwrap();
        let reserved = scoped.reserve_next(&quote.id).unwrap().unwrap();
        scoped.validate_dispatch(&reserved).unwrap();
        let totals = scoped.validation_totals().unwrap();
        assert_eq!(totals.attempted_requests, 1);
        assert_eq!(totals.attempted_audio_duration_ms, 240_000);
        assert_eq!(totals.max_audio_duration_ms, 5_400_000);
        assert_eq!(totals.max_requests, 120);
        assert!(scoped.reserve_next(&quote.id).is_err());
    }
    #[test]
    fn permit_rejects_wrong_digest_model_count_expiry_and_reservation() {
        let (_directory, store, quote) = setup();
        for mutate in 0..6 {
            let mut permit = approval(&quote);
            match mutate {
                0 => permit.plan_digest = crate::sha256_bytes(b"other"),
                1 => permit.model = AUDIO_MODEL.into(),
                2 => permit.max_requests = 2,
                3 => permit.expires_at_ms = TEST_NOW_MS,
                4 => permit.max_reservation_microusd = Some(1),
                _ => permit.total_limit_microusd += 1,
            }
            assert!(store
                .with_development_validation(&quote.id, permit)
                .is_err());
        }
        let scoped = store
            .with_development_validation(&quote.id, approval(&quote))
            .unwrap();
        scoped.approve(&quote.id, &quote.digest).unwrap();
        let reservation = scoped.reserve_next(&quote.id).unwrap().unwrap();
        scoped.set_test_time(TEST_NOW_MS + 60_001);
        assert!(matches!(
            scoped.validate_dispatch(&reservation),
            Err(AiError::ApprovalRequired)
        ));
    }

    #[test]
    fn a_consumed_permit_cannot_authorize_a_second_attempt() {
        let (_directory, store, quote) = setup();
        let scoped = store
            .with_development_validation(&quote.id, approval(&quote))
            .unwrap();
        scoped.approve(&quote.id, &quote.digest).unwrap();
        let request = scoped.reserve_next(&quote.id).unwrap().unwrap();
        scoped
            .release_unsent(&request.attempt_id, "fixture_preflight_failure")
            .unwrap();
        assert!(matches!(
            scoped.reapprove(&quote.id, &quote.digest),
            Err(AiError::ApprovalRequired)
        ));
        let fresh = store
            .with_development_validation(&quote.id, approval(&quote))
            .unwrap();
        fresh.reapprove(&quote.id, &quote.digest).unwrap();
        assert!(fresh.reserve_next(&quote.id).unwrap().is_some());
    }

    #[test]
    fn lifetime_request_and_audio_limits_count_unsent_attempts_without_double_counting_dispatch() {
        for (request_limit, audio_limit, expected_error) in [
            (2, 90 * 60 * 1000, "validation request count"),
            (120, 2000, "validation audio duration"),
        ] {
            let (_directory, store, quote) = setup();
            store
                .connect()
                .unwrap()
                .execute(
                    "UPDATE ai_validation_settings SET max_requests=?,max_audio_duration_ms=?",
                    params![request_limit, audio_limit],
                )
                .unwrap();
            for attempt in 0..2 {
                let scoped = store
                    .with_development_validation(&quote.id, approval(&quote))
                    .unwrap();
                if attempt == 0 {
                    scoped.approve(&quote.id, &quote.digest)
                } else {
                    scoped.reapprove(&quote.id, &quote.digest)
                }
                .unwrap();
                let reservation = scoped.reserve_next(&quote.id).unwrap().unwrap();
                scoped.validate_dispatch(&reservation).unwrap();
                scoped
                    .release_unsent(&reservation.attempt_id, "offline_limit_fixture")
                    .unwrap();
            }
            let totals = store.validation_totals().unwrap();
            assert_eq!(totals.attempted_requests, 2);
            assert_eq!(totals.attempted_audio_duration_ms, 2000);
            assert_eq!(totals.charged_or_held_microusd, 0);
            let next = store
                .with_development_validation(&quote.id, approval(&quote))
                .unwrap();
            assert!(
                matches!(next.reapprove(&quote.id,&quote.digest),Err(AiError::BudgetExceeded(which)) if which == expected_error)
            );
        }
    }

    #[test]
    fn evidence_preserves_word_offsets_but_excludes_thought_and_unknown_fields() {
        let evidence = sanitized_evidence(&serde_json::json!({
            "usageMetadata":{"promptTokenCount":100,"thoughtsTokenCount":-1,"access_token":"credential-sentinel"},
            "candidates":[{"content":{"parts":[
                {"thought":true,"text":"thought-sentinel","audioTranscription":{"text":"thought-sentinel","words":[]}},
                {"audioTranscription":{"text":"Hello.","finished":true,"private_key":"credential-sentinel","words":[{"word":"Hello","startOffset":"0.123s","endOffset":"0.456s","secret":"credential-sentinel"}]}}
            ]}}]
        }));
        assert_eq!(
            evidence["audioTranscriptions"][0]["words"][0]["startOffset"],
            "0.123s"
        );
        assert_eq!(evidence["usage"]["promptTokenCount"], 100);
        assert!(evidence["usage"].get("thoughtsTokenCount").is_none());
        let encoded = evidence.to_string();
        assert!(!encoded.contains("credential-sentinel"));
        assert!(!encoded.contains("thought-sentinel"));
    }
    #[test]
    fn diagnostics_keep_generated_text_and_known_finish_reason_only() {
        let generated = "{\"items\":[{\"sourceCueIds\":[\"cue-19\"]}]}";
        let evidence = sanitized_evidence(&serde_json::json!({
            "private_key":"credential-sentinel","error":{"message":"diagnostic-sentinel"},
            "candidates":[
                {"finishReason":"STOP","finishMessage":"diagnostic-sentinel","content":{"parts":[
                    {"thought":true,"text":"thought-sentinel"},
                    {"text":generated,"access_token":"credential-sentinel","thoughtSignature":"signature-sentinel"}
                ]}},
                {"finishReason":"credential-sentinel","content":{"parts":[]}}
            ]
        }));
        assert_eq!(evidence["candidateDiagnostics"][0]["finishReason"], "STOP");
        assert_eq!(
            evidence["candidateDiagnostics"][0]["textParts"],
            serde_json::json!([generated])
        );
        assert_eq!(
            evidence["candidateDiagnostics"][1]["finishReason"],
            "UNRECOGNIZED"
        );
        assert_eq!(evidence["evidenceTruncated"], false);
        let encoded = evidence.to_string();
        for sentinel in [
            "credential-sentinel",
            "diagnostic-sentinel",
            "thought-sentinel",
            "signature-sentinel",
        ] {
            assert!(!encoded.contains(sentinel));
        }
    }
    #[test]
    fn diagnostics_have_one_aggregate_encoded_limit_and_explicit_truncation() {
        let text = "日本語\u{0000}\"\\".repeat(20_000);
        let evidence = sanitized_evidence(&serde_json::json!({"candidates":[
            {"finishReason":"MAX_TOKENS","content":{"parts":[{"text":text},{"text":"later text"}]}},
            {"finishReason":"STOP","content":{"parts":[{"text":"another candidate"}]}}
        ]}));
        assert!(
            serde_json::to_vec(&evidence["candidateDiagnostics"])
                .unwrap()
                .len()
                <= MAX_DIAGNOSTIC_BYTES
        );
        assert_eq!(evidence["evidenceTruncated"], true);
        assert_eq!(evidence["candidateDiagnostics"][0]["textTruncated"], true);
        assert_eq!(evidence["candidateDiagnostics"][1]["textTruncated"], true);
        let prefix = evidence["candidateDiagnostics"][0]["textParts"][0]
            .as_str()
            .unwrap();
        assert!(!prefix.is_empty());
        assert!(text.starts_with(prefix));
        assert!(prefix.len() < text.len());
        let evidence =
            sanitized_evidence(&serde_json::json!({"candidates":vec![serde_json::json!({
            "finishReason":"STOP","content":{"parts":vec![serde_json::json!({"text":"x"});33]}
        });9]}));
        assert_eq!(
            evidence["candidateDiagnostics"].as_array().unwrap().len(),
            8
        );
        assert_eq!(
            evidence["candidateDiagnostics"][0]["textParts"]
                .as_array()
                .unwrap()
                .len(),
            32
        );
        assert_eq!(evidence["evidenceTruncated"], true);
    }
    #[test]
    fn lifetime_budget_survives_acknowledgement_restart_and_month_boundary() {
        let (directory, store, quote) = setup();
        let scoped = store
            .with_development_validation(&quote.id, approval(&quote))
            .unwrap();
        scoped.approve(&quote.id, &quote.digest).unwrap();
        let reservation = scoped.reserve_next(&quote.id).unwrap().unwrap();
        scoped.mark_unknown(&reservation.attempt_id).unwrap();
        scoped.acknowledge_unknown(&reservation.attempt_id).unwrap();
        let reopened = AiStore::open(directory.path().join("validation.sqlite")).unwrap();
        reopened.set_test_time(TEST_NOW_MS + 24 * 24 * 60 * 60 * 1000);
        assert_eq!(
            reopened
                .validation_totals()
                .unwrap()
                .charged_or_held_microusd,
            reservation.reserved_microusd.unwrap()
        );
        assert!(reopened.initialize_validation_total(4_000_000).is_err());
        // Old unknowns keep consuming the lifetime pool, independently of daily
        // and monthly totals and independently of explicit acknowledgement.
        let connection = reopened.connect().unwrap();
        connection
            .execute(
                "UPDATE ai_validation_settings SET total_limit_microusd=?",
                [reservation.reserved_microusd.unwrap() as i64],
            )
            .unwrap();
        let mut next = approval(&quote);
        next.expires_at_ms = reopened.now_ms() + 60_000;
        next.total_limit_microusd = reservation.reserved_microusd.unwrap();
        let retry = reopened
            .with_development_validation(&quote.id, next)
            .unwrap();
        retry.refresh_quote(&quote.id).unwrap();
        assert!(matches!(
            retry.reapprove(&quote.id, &quote.digest),
            Err(AiError::BudgetExceeded("validation lifetime"))
        ));
    }
}
