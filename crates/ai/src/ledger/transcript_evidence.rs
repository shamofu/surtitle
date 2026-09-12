//! Bounded transcript evidence and explicit local reinterpretation. These tables
//! live only in the paid-work database, outside portable learning backups.
use super::*;
use crate::{sha256_bytes, vertex::parse_response};
use serde_json::{json, Value};

const MAX_EVIDENCE_BYTES: usize = 2 * 1024 * 1024;
const MAX_TEXT_BYTES: usize = 1024 * 1024;
const PARSER_REVISION: &str = "transcript-response-v1";

pub(super) fn initialize(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS ai_transcript_evidence (
        attempt_id TEXT PRIMARY KEY REFERENCES ai_attempts(id),
        evidence_json TEXT NOT NULL, evidence_sha256 TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS ai_transcript_reparses (
        id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES ai_transcript_evidence(attempt_id),
        candidate_json TEXT NOT NULL, selected INTEGER NOT NULL DEFAULT 0 CHECK(selected IN (0,1)));
        CREATE UNIQUE INDEX IF NOT EXISTS ai_transcript_reparse_revision
        ON ai_transcript_reparses(attempt_id, json_extract(candidate_json,'$.parserRevision'));",
    )?;
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TranscriptResultState {
    Pending,
    Invalid,
    Empty,
    Received,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TranscriptResultReason {
    NotReceived,
    EvidenceUnavailable,
    EvidenceIncomplete,
    CandidateMissing,
    CandidateCount,
    IncompleteResponse,
    ContentMissing,
    InvalidStructure,
    InvalidWordTiming,
    ReversedTime,
    TimeOutsideAudio,
    UnalignedWords,
    UsageUnknown,
    SettlementPending,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptEvidence {
    pub attempt_id: String,
    pub job_id: String,
    pub ordinal: u32,
    pub input_sha256: String,
    pub request_sha256: String,
    pub task_sha256: String,
    pub model_id: String,
    pub parser_revision: String,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub response: Value,
    pub complete: bool,
    pub state: TranscriptResultState,
    pub reason: Option<TranscriptResultReason>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptReparse {
    pub id: String,
    pub evidence_sha256: String,
    pub parser_revision: String,
    pub state: TranscriptResultState,
    pub reason: Option<TranscriptResultReason>,
    pub output: Option<ParsedOutput>,
    pub selected: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptResultReview {
    pub ordinal: u32,
    pub state: TranscriptResultState,
    pub reason: Option<TranscriptResultReason>,
    pub attempt_state: Option<String>,
    pub evidence_sha256: Option<String>,
    pub evidence: Option<TranscriptEvidence>,
    pub reparses: Vec<TranscriptReparse>,
}

fn audio(task: &RequestTask) -> Option<&crate::AudioAttachment> {
    match task {
        RequestTask::TranscribePreview { audio, .. }
        | RequestTask::AudioTranscription { audio, .. } => Some(audio),
        _ => None,
    }
}
fn invalid() -> AiError {
    AiError::Invalid("Saved transcript evidence binding is invalid".into())
}

/// Only explicitly allowed wire fields survive. Oversized fields are removed
/// whole and mark evidence incomplete; a truncated prefix is never reparsed.
fn sanitize(response: &Value) -> (Value, bool) {
    let mut complete = true;
    let mut remaining = MAX_TEXT_BYTES;
    fn scalar(value: &Value, max: usize, remaining: &mut usize, complete: &mut bool) -> Value {
        match value {
            Value::String(s) if s.len() <= max && s.len() <= *remaining => {
                *remaining -= s.len();
                value.clone()
            }
            Value::Bool(_) | Value::Number(_) | Value::Null => value.clone(),
            _ => {
                *complete = false;
                Value::Null
            }
        }
    }
    fn fields(
        source: &Value,
        names: &[(&str, usize)],
        remaining: &mut usize,
        complete: &mut bool,
    ) -> Value {
        let mut out = serde_json::Map::new();
        for (name, max) in names {
            if let Some(v) = source.get(*name) {
                out.insert((*name).into(), scalar(v, *max, remaining, complete));
            }
        }
        Value::Object(out)
    }
    let mut out = json!({});
    if let Some(version) = response
        .get("modelVersion")
        .and_then(Value::as_str)
        .filter(|v| {
            !v.is_empty()
                && v.len() <= 200
                && v.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-._@".contains(&b))
        })
    {
        out["modelVersion"] = json!(version);
    }
    if response.get("usageMetadata").is_some() {
        out["usageMetadata"] = crate::vertex::sanitized_usage(&response["usageMetadata"]);
    }
    if let Some(candidates) = response.get("candidates") {
        out["candidates"] = if let Some(candidates) = candidates.as_array().filter(|a| a.len() <= 8)
        {
            Value::Array(
                candidates
                    .iter()
                    .map(|candidate| {
                        let mut saved = json!({});
                        if candidate.get("finishReason").is_some() {
                            const FINISH_REASONS: &[&str] = &[
                                "STOP",
                                "MAX_TOKENS",
                                "SAFETY",
                                "RECITATION",
                                "OTHER",
                                "BLOCKLIST",
                                "PROHIBITED_CONTENT",
                                "SPII",
                                "MALFORMED_FUNCTION_CALL",
                                "FINISH_REASON_UNSPECIFIED",
                                "IMAGE_SAFETY",
                                "IMAGE_PROHIBITED_CONTENT",
                                "IMAGE_RECITATION",
                                "IMAGE_OTHER",
                                "NO_IMAGE",
                                "UNEXPECTED_TOOL_CALL",
                                "TOO_MANY_TOOL_CALLS",
                            ];
                            saved["finishReason"] = json!(candidate["finishReason"]
                                .as_str()
                                .filter(|reason| FINISH_REASONS.contains(reason))
                                .unwrap_or("UNRECOGNIZED"));
                        }
                        if let Some(content) = candidate.get("content") {
                            if !content.is_object() {
                                complete = false;
                                saved["content"] = Value::Null;
                                return saved;
                            }
                            let mut content_out =
                                fields(content, &[("role", 32)], &mut remaining, &mut complete);
                            if let Some(parts) = content.get("parts") {
                                content_out["parts"] = if let Some(parts) =
                                    parts.as_array().filter(|p| p.len() <= 4096)
                                {
                                    Value::Array(
                                        parts
                                            .iter()
                                            .filter(|part| {
                                                part.get("thought").and_then(Value::as_bool)
                                                    != Some(true)
                                            })
                                            .map(|part| {
                                                let mut part_out = fields(
                                                    part,
                                                    &[("text", MAX_TEXT_BYTES)],
                                                    &mut remaining,
                                                    &mut complete,
                                                );
                                                if let Some(tx) = part.get("audioTranscription") {
                                                    if !tx.is_object() {
                                                        complete = false;
                                                        part_out["audioTranscription"] =
                                                            Value::Null;
                                                        return part_out;
                                                    }
                                                    let mut tx_out = fields(
                                                        tx,
                                                        &[
                                                            ("text", MAX_TEXT_BYTES),
                                                            ("finished", 0),
                                                        ],
                                                        &mut remaining,
                                                        &mut complete,
                                                    );
                                                    if let Some(words) = tx.get("words") {
                                                        tx_out["words"] = if let Some(words) = words
                                                            .as_array()
                                                            .filter(|w| w.len() <= 20_000)
                                                        {
                                                            Value::Array(
                                                                words
                                                                    .iter()
                                                                    .map(|word| {
                                                                        fields(
                                                                            word,
                                                                            &[
                                                                                ("word", 16000),
                                                                                ("startOffset", 64),
                                                                                ("endOffset", 64),
                                                                            ],
                                                                            &mut remaining,
                                                                            &mut complete,
                                                                        )
                                                                    })
                                                                    .collect(),
                                                            )
                                                        } else {
                                                            complete = false;
                                                            Value::Null
                                                        };
                                                    }
                                                    part_out["audioTranscription"] = tx_out;
                                                }
                                                part_out
                                            })
                                            .collect(),
                                    )
                                } else {
                                    complete = false;
                                    Value::Null
                                };
                            }
                            saved["content"] = content_out;
                        }
                        saved
                    })
                    .collect(),
            )
        } else {
            complete = false;
            Value::Null
        };
    }
    if serde_json::to_vec(&out).map_or(true, |bytes| bytes.len() > MAX_EVIDENCE_BYTES) {
        return (json!({}), false);
    }
    (out, complete)
}

fn classified(
    task: &RequestTask,
    response: &Value,
) -> (
    TranscriptResultState,
    Option<TranscriptResultReason>,
    Option<ParsedOutput>,
) {
    use TranscriptResultReason as R;
    let parsed = parse_response(task, response);
    match parsed {
        Ok(output @ ParsedOutput::Transcript { .. }) => {
            let state = if matches!(&output, ParsedOutput::Transcript { cues } if cues.is_empty()) {
                TranscriptResultState::Empty
            } else {
                TranscriptResultState::Received
            };
            (state, None, Some(output))
        }
        result => {
            let reason = if response
                .get("candidates")
                .and_then(Value::as_array)
                .is_none_or(Vec::is_empty)
            {
                R::CandidateMissing
            } else if response["candidates"]
                .as_array()
                .is_some_and(|a| a.len() != 1)
            {
                R::CandidateCount
            } else if response["candidates"][0]["finishReason"] != "STOP" {
                R::IncompleteResponse
            } else if let Err(AiError::Invalid(message)) = result {
                if message.contains("no content")
                    || message.contains("audioTranscription is absent")
                {
                    R::ContentMissing
                } else if message.contains("word time outside source or out of order")
                    || message.contains("subtitle timing is invalid")
                {
                    timing_reason(task, response)
                } else if message.contains("alignment")
                    || message.contains("unanchored")
                    || message.contains("no timestamp")
                {
                    R::UnalignedWords
                } else {
                    R::InvalidStructure
                }
            } else {
                R::InvalidStructure
            };
            (TranscriptResultState::Invalid, Some(reason), None)
        }
    }
}

fn timing_reason(task: &RequestTask, response: &Value) -> TranscriptResultReason {
    use TranscriptResultReason as R;
    let Some(audio) = audio(task) else {
        return R::InvalidWordTiming;
    };
    let Some(parts) = response["candidates"][0]["content"]["parts"].as_array() else {
        return R::InvalidWordTiming;
    };
    let mut intervals = Vec::new();
    for part in parts
        .iter()
        .filter(|part| part.get("thought").and_then(Value::as_bool) != Some(true))
    {
        if let Some(words) = part["audioTranscription"]["words"].as_array() {
            fn millis(value: &Value) -> Option<f64> {
                let n = value.as_str()?.strip_suffix('s')?.parse::<f64>().ok()? * 1000.0;
                n.is_finite().then_some(n)
            }
            intervals.extend(words.iter().filter_map(|word| {
                Some((millis(&word["startOffset"])?, millis(&word["endOffset"])?))
            }));
        } else if let Some(text) = part["text"].as_str() {
            if let Ok(value) = serde_json::from_str::<Value>(text) {
                if let Some(cues) = value["cues"].as_array() {
                    intervals.extend(cues.iter().filter_map(|cue| {
                        Some((cue["startMs"].as_f64()?, cue["endMs"].as_f64()?))
                    }));
                }
            }
        }
    }
    if intervals.iter().any(|(start, end)| start > end) {
        R::ReversedTime
    } else if intervals
        .iter()
        .any(|(start, end)| *start < 0.0 || *end > audio.duration_ms as f64)
    {
        R::TimeOutsideAudio
    } else {
        R::InvalidWordTiming
    }
}

impl AiStore {
    pub(crate) fn record_transcript_evidence(
        &self,
        request: &ReservedRequest,
        response: &Value,
    ) -> Result<()> {
        self.record_transcript_evidence_inner(request, response, None)
    }

    pub(crate) fn record_transcript_rejection(
        &self,
        request: &ReservedRequest,
        reason: TranscriptResultReason,
    ) -> Result<()> {
        self.record_transcript_evidence_inner(request, &json!({}), Some(reason))
    }

    fn record_transcript_evidence_inner(
        &self,
        request: &ReservedRequest,
        response: &Value,
        rejection: Option<TranscriptResultReason>,
    ) -> Result<()> {
        let Some(audio) = audio(&request.task) else {
            return Ok(());
        };
        let (saved, mut complete) = sanitize(response);
        let (state, reason, original) = classified(&request.task, response);
        // Removing unknown fields must never turn an invalid response into a
        // valid empty response, or otherwise change the parser's interpretation.
        let (saved_state, _, reparsed) = classified(&request.task, &saved);
        complete &= state == saved_state
            && serde_json::to_value(original)? == serde_json::to_value(reparsed)?;
        let evidence = TranscriptEvidence {
            attempt_id: request.attempt_id.clone(),
            job_id: request.job_id.clone(),
            ordinal: request.ordinal,
            input_sha256: audio.sha256.clone(),
            request_sha256: sha256_bytes(&serde_json::to_vec(&request.body_snapshot)?),
            task_sha256: sha256_bytes(&serde_json::to_vec(&request.task)?),
            model_id: request.execution.model_id.clone(),
            parser_revision: PARSER_REVISION.into(),
            response: saved,
            complete: complete && rejection.is_none(),
            state,
            reason: rejection.or(reason),
        };
        let serialized = serde_json::to_string(&evidence)?;
        let conn = self.connect()?;
        let valid: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM ai_attempts WHERE id=? AND job_id=? AND ordinal=? AND state='reserved' AND dispatched_at_ms IS NOT NULL)", params![request.attempt_id, request.job_id, request.ordinal], |r| r.get(0))?;
        if !valid {
            return Err(invalid());
        }
        conn.execute(
            "INSERT INTO ai_transcript_evidence VALUES (?,?,?)",
            params![
                request.attempt_id,
                serialized,
                sha256_bytes(serialized.as_bytes())
            ],
        )?;
        Ok(())
    }

    fn load_transcript_evidence(&self, attempt_id: &str) -> Result<(TranscriptEvidence, String)> {
        let (serialized, digest): (String, String) = self.connect()?.query_row(
            "SELECT evidence_json,evidence_sha256 FROM ai_transcript_evidence WHERE attempt_id=?",
            [attempt_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        if serialized.len() > MAX_EVIDENCE_BYTES + 4096
            || sha256_bytes(serialized.as_bytes()) != digest
        {
            return Err(invalid());
        }
        let evidence: TranscriptEvidence = serde_json::from_str(&serialized)?;
        let plan = self.prepared_job(&evidence.job_id)?;
        let task = plan
            .requests
            .get(evidence.ordinal as usize)
            .ok_or_else(invalid)?;
        if evidence.attempt_id != attempt_id
            || audio(task).is_none_or(|a| a.sha256 != evidence.input_sha256)
            || evidence.task_sha256 != sha256_bytes(&serde_json::to_vec(task)?)
            || evidence.request_sha256
                != sha256_bytes(&serde_json::to_vec(
                    plan.request_body_snapshot(evidence.ordinal)?,
                )?)
            || evidence.model_id != plan.execution.model_id
        {
            return Err(invalid());
        }
        Ok((evidence, digest))
    }

    pub fn transcript_result_reviews(&self, job_id: &str) -> Result<Vec<TranscriptResultReview>> {
        self.read_transcript_result_reviews(job_id, None, false)
    }

    /// Load one bounded response only after the user requests its details.
    pub fn transcript_result_detail(
        &self,
        job_id: &str,
        ordinal: u32,
    ) -> Result<TranscriptResultReview> {
        self.read_transcript_result_reviews(job_id, Some(ordinal), true)?
            .pop()
            .ok_or_else(invalid)
    }

    fn read_transcript_result_reviews(
        &self,
        job_id: &str,
        only: Option<u32>,
        include_content: bool,
    ) -> Result<Vec<TranscriptResultReview>> {
        let plan = self.prepared_job(job_id)?;
        let conn = self.connect()?;
        let mut results = Vec::new();
        for (ordinal, task) in plan.requests.iter().enumerate() {
            if only.is_some_and(|expected| ordinal as u32 != expected) {
                continue;
            }
            if audio(task).is_none() {
                return Err(invalid());
            }
            let ordinal = ordinal as u32;
            let latest: Option<(String, String)> = conn.query_row("SELECT id,state FROM ai_attempts WHERE job_id=? AND ordinal=? ORDER BY created_at_ms DESC,rowid DESC LIMIT 1", params![job_id, ordinal], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
            let mut result = TranscriptResultReview {
                ordinal,
                state: TranscriptResultState::Pending,
                reason: Some(TranscriptResultReason::NotReceived),
                attempt_state: latest.as_ref().map(|a| a.1.clone()),
                evidence_sha256: None,
                evidence: None,
                reparses: Vec::new(),
            };
            if let Some((attempt, attempt_state)) = latest {
                let exists: bool = conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM ai_transcript_evidence WHERE attempt_id=?)",
                    [&attempt],
                    |r| r.get(0),
                )?;
                if exists {
                    let (evidence, digest) = self.load_transcript_evidence(&attempt)?;
                    result.state = evidence.state;
                    result.reason = evidence.reason;
                    if !evidence.complete {
                        result.reason = Some(TranscriptResultReason::EvidenceIncomplete);
                    } else if ["reserved", "unknown"].contains(&attempt_state.as_str()) {
                        result.reason = Some(TranscriptResultReason::SettlementPending);
                    }
                    result.evidence_sha256 = Some(digest);
                    result.evidence = Some(evidence);
                    let mut stmt = conn.prepare("SELECT candidate_json,selected FROM ai_transcript_reparses WHERE attempt_id=? ORDER BY rowid")?;
                    for item in stmt.query_map([&attempt], |r| {
                        Ok((r.get::<_, String>(0)?, r.get::<_, bool>(1)?))
                    })? {
                        let (raw, selected) = item?;
                        if raw.len() > MAX_EVIDENCE_BYTES * 2 {
                            return Err(invalid());
                        }
                        let mut candidate: TranscriptReparse = serde_json::from_str(&raw)?;
                        candidate.selected = selected;
                        result.reparses.push(candidate);
                    }
                } else if let Some(output) = self.response(job_id, ordinal)? {
                    result.state = if matches!(output, ParsedOutput::Transcript { cues } if cues.is_empty())
                    {
                        TranscriptResultState::Empty
                    } else {
                        TranscriptResultState::Received
                    };
                    result.reason = Some(TranscriptResultReason::EvidenceUnavailable);
                } else if !["reserved", "released"].contains(&attempt_state.as_str()) {
                    result.reason = Some(TranscriptResultReason::EvidenceUnavailable);
                }
            }
            if !include_content {
                if let Some(evidence) = &mut result.evidence {
                    evidence.response = Value::Null;
                }
                for candidate in &mut result.reparses {
                    candidate.output = None;
                }
            }
            results.push(result);
        }
        Ok(results)
    }

    /// Reparse a bound snapshot without credentials, input regeneration, network,
    /// settlement, or replacement of the original failed attempt.
    pub fn reparse_transcript_evidence(
        &self,
        job_id: &str,
        ordinal: u32,
        expected_sha256: &str,
    ) -> Result<TranscriptReparse> {
        let mut conn = self.connect()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let review = self.transcript_result_detail(job_id, ordinal)?;
        let evidence = review.evidence.as_ref().ok_or_else(invalid)?;
        if review.evidence_sha256.as_deref() != Some(expected_sha256) || !evidence.complete {
            return Err(invalid());
        }
        if let Some(existing) = review.reparses.iter().find(|candidate| {
            candidate.evidence_sha256 == expected_sha256
                && candidate.parser_revision == PARSER_REVISION
        }) {
            return Ok(existing.clone());
        }
        if review.reparses.len() >= 10 {
            return Err(AiError::Invalid(
                "This response already has ten parser revisions; preserve its review history"
                    .into(),
            ));
        }
        let task = self
            .prepared_job(job_id)?
            .requests
            .get(ordinal as usize)
            .cloned()
            .ok_or_else(invalid)?;
        let (state, reason, output) = classified(&task, &evidence.response);
        let candidate = TranscriptReparse {
            id: uuid::Uuid::new_v4().to_string(),
            evidence_sha256: expected_sha256.into(),
            parser_revision: PARSER_REVISION.into(),
            state,
            reason,
            output,
            selected: false,
        };
        tx.execute(
            "INSERT INTO ai_transcript_reparses(id,attempt_id,candidate_json) VALUES (?,?,?)",
            params![
                candidate.id,
                evidence.attempt_id,
                serde_json::to_string(&candidate)?
            ],
        )?;
        tx.commit()?;
        Ok(candidate)
    }

    pub fn select_transcript_reparse(
        &self,
        job_id: &str,
        ordinal: u32,
        candidate_id: &str,
    ) -> Result<()> {
        let review = self.transcript_result_detail(job_id, ordinal)?;
        let candidate = review
            .reparses
            .iter()
            .find(|c| c.id == candidate_id)
            .ok_or_else(invalid)?;
        self.validate_transcript_candidate(job_id, ordinal, &review, candidate)?;
        let evidence = review.evidence.as_ref().ok_or_else(invalid)?;
        let mut conn = self.connect()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute(
            "UPDATE ai_transcript_reparses SET selected=0 WHERE attempt_id=?",
            [&evidence.attempt_id],
        )?;
        tx.execute(
            "UPDATE ai_transcript_reparses SET selected=1 WHERE id=?",
            [candidate_id],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn selected_transcript_reparse(
        &self,
        job_id: &str,
        ordinal: u32,
    ) -> Result<Option<ParsedOutput>> {
        let review = self.transcript_result_detail(job_id, ordinal)?;
        let Some(candidate) = review.reparses.iter().find(|c| c.selected) else {
            return Ok(None);
        };
        self.validate_transcript_candidate(job_id, ordinal, &review, candidate)?;
        Ok(candidate.output.clone())
    }

    fn validate_transcript_candidate(
        &self,
        job_id: &str,
        ordinal: u32,
        review: &TranscriptResultReview,
        candidate: &TranscriptReparse,
    ) -> Result<()> {
        if candidate.output.is_none()
            || review.evidence_sha256.as_deref() != Some(&candidate.evidence_sha256)
            || review
                .attempt_state
                .as_deref()
                .is_none_or(|s| ["reserved", "unknown"].contains(&s))
        {
            return Err(invalid());
        }
        let evidence = review.evidence.as_ref().ok_or_else(invalid)?;
        let task = self
            .prepared_job(job_id)?
            .requests
            .get(ordinal as usize)
            .cloned()
            .ok_or_else(invalid)?;
        let (_, _, output) = classified(&task, &evidence.response);
        if !evidence.complete
            || candidate.parser_revision != PARSER_REVISION
            || serde_json::to_value(&candidate.output)? != serde_json::to_value(output)?
        {
            return Err(invalid());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
