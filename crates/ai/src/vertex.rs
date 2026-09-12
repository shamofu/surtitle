use crate::{
    models::parse_output, AiError, AiStore, CredentialVault, ParsedOutput, RequestTask,
    ReservedRequest, Result,
};
use gcp_auth::TokenProvider;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{future::Future, time::Duration};
use zeroize::Zeroizing;

const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

// These private seams keep fault injection out of the public API and renderer.
// Production always uses CredentialVault and the HTTPS-only, nonretrying client
// created below. Test doubles are compiled only in vertex::fault_tests.
trait Authorization: Send + Sync {
    fn access_token(
        &self,
        request: &ReservedRequest,
    ) -> impl Future<Output = Result<Zeroizing<String>>> + Send;
}

trait Transport: Send + Sync {
    type Response: ResponseBody + Send;
    fn send(
        &self,
        url: &str,
        token: &str,
        body: &Value,
    ) -> impl Future<Output = std::result::Result<Self::Response, ()>> + Send;
}

trait ResponseBody {
    fn status(&self) -> u16;
    fn chunk(&mut self) -> impl Future<Output = std::result::Result<Option<Vec<u8>>, ()>> + Send;
}

impl Authorization for CredentialVault {
    async fn access_token(&self, request: &ReservedRequest) -> Result<Zeroizing<String>> {
        let (key, metadata) = self.load_json(&request.credential_id)?;
        if metadata.project_id != request.project_id {
            return Err(AiError::Credentials);
        }
        let auth =
            gcp_auth::CustomServiceAccount::from_json(&key).map_err(|_| AiError::Credentials)?;
        drop(key);
        let token = auth
            .token(&["https://www.googleapis.com/auth/cloud-platform"])
            .await
            .map_err(|_| AiError::Credentials)?;
        Ok(Zeroizing::new(token.as_str().to_owned()))
    }
}

impl Transport for reqwest::Client {
    type Response = reqwest::Response;

    async fn send(
        &self,
        url: &str,
        token: &str,
        body: &Value,
    ) -> std::result::Result<Self::Response, ()> {
        self.post(url)
            .bearer_auth(token)
            .json(body)
            .send()
            .await
            .map_err(|_| ())
    }
}

impl ResponseBody for reqwest::Response {
    fn status(&self) -> u16 {
        reqwest::Response::status(self).as_u16()
    }

    async fn chunk(&mut self) -> std::result::Result<Option<Vec<u8>>, ()> {
        reqwest::Response::chunk(self)
            .await
            .map(|chunk| chunk.map(|bytes| bytes.to_vec()))
            .map_err(|_| ())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionResult {
    pub job_id: String,
    pub ordinal: u32,
    pub attempt_id: String,
    pub charged_microusd: Option<u64>,
    pub output: ParsedOutput,
}

#[derive(Clone)]
pub struct VertexService {
    store: AiStore,
    vault: CredentialVault,
    client: reqwest::Client,
}

impl VertexService {
    pub fn new(store: AiStore, vault: CredentialVault) -> Result<Self> {
        let client = reqwest::Client::builder()
            .https_only(true)
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .connect_timeout(Duration::from_secs(20))
            .timeout(Duration::from_secs(300))
            .build()
            .map_err(|_| AiError::Invalid("Unable to initialize Vertex HTTPS client".into()))?;
        Ok(Self {
            store,
            vault,
            client,
        })
    }

    /// The sole paid network entrypoint. No ambient credentials, automatic retry,
    /// automatic model fallback, or implicit preparation/approval is performed.
    pub async fn execute_next(&self, job_id: &str) -> Result<Option<ExecutionResult>> {
        self.execute_next_with_guard(job_id, || Ok(())).await
    }

    /// Check native source/settings state after preflight, immediately before the
    /// paid HTTP send. A guard failure releases the unsent reservation only.
    pub async fn execute_next_with_guard(
        &self,
        job_id: &str,
        before_send: impl FnOnce() -> Result<()>,
    ) -> Result<Option<ExecutionResult>> {
        execute_with_io(&self.store, &self.vault, &self.client, job_id, before_send).await
    }
}

/// Every transport, including the offline fault harness, uses the same durable
/// reserve, preflight, dispatch validation, bounded parse, and settlement path.
async fn execute_with_io(
    store: &AiStore,
    auth: &impl Authorization,
    transport: &impl Transport,
    job_id: &str,
    before_send: impl FnOnce() -> Result<()>,
) -> Result<Option<ExecutionResult>> {
    let Some(reservation) = store.reserve_next(job_id)? else {
        return Ok(None);
    };
    // Validate and load immutable local input before requesting an OAuth token.
    let prepared = prepare_authenticated(auth, &reservation).await;
    let (body, token) = match prepared {
        Ok(v) => v,
        Err(error) => {
            store.release_unsent(&reservation.attempt_id, "preflight_failed")?;
            return Err(error);
        }
    };
    if let Err(error) = before_send() {
        store.release_unsent(&reservation.attempt_id, "source_changed_before_send")?;
        return Err(error);
    }
    // Authentication may take time, and the guard may observe a cancellation.
    // Recheck the exact reservation, current limits, and approval immediately
    // before handing the request to the transport.
    if let Err(error) = store.validate_dispatch(&reservation) {
        store.release_unsent(&reservation.attempt_id, "dispatch_validation_failed")?;
        return Err(error);
    }
    let url = reservation.execution.endpoint(&reservation.project_id)?;
    let response = transport.send(&url, &token, &body).await;
    drop(token);
    let mut response = match response {
        Ok(r) => r,
        Err(_) => {
            store.mark_unknown(&reservation.attempt_id)?;
            return Err(AiError::UnknownOutcome);
        }
    };
    if !(200..300).contains(&response.status()) {
        let status = response.status();
        // Conservatively retain the reservation even for rejected HTTP requests;
        // no response usage means the client cannot prove the billing outcome.
        store.mark_unknown(&reservation.attempt_id)?;
        return Err(AiError::Provider(status));
    }
    // Bound memory even if a provider response violates the requested token cap.
    let mut bytes = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) if chunk.len() <= MAX_RESPONSE_BYTES - bytes.len() => {
                bytes.extend_from_slice(&chunk)
            }
            Ok(None) => break,
            _ => {
                store.mark_unknown(&reservation.attempt_id)?;
                return Err(AiError::UnknownOutcome);
            }
        }
    }
    let value: Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(_) => {
            // Malformed JSON has no safe text fields to retain. Persist a fixed
            // rejection state without copying its bytes or parser diagnostics.
            let _ = store.record_transcript_rejection(
                &reservation,
                crate::TranscriptResultReason::InvalidStructure,
            );
            store.mark_unknown(&reservation.attempt_id)?;
            return Err(AiError::UnknownOutcome);
        }
    };
    // Evidence is durable before settlement. A persistence failure retains the
    // reservation and never exposes an adoptable result or triggers a resend.
    if store
        .record_transcript_evidence(&reservation, &value)
        .is_err()
    {
        store.mark_unknown(&reservation.attempt_id)?;
        return Err(AiError::UnknownOutcome);
    }
    store.record_model_version(
        &reservation.attempt_id,
        value.get("modelVersion").and_then(Value::as_str),
    )?;
    #[cfg(feature = "development-validation")]
    if store
        .record_validation_evidence(&reservation, &value)
        .is_err()
    {
        store.mark_unknown(&reservation.attempt_id)?;
        return Err(AiError::UnknownOutcome);
    }
    let usage = match value.get("usageMetadata") {
        Some(v) => v,
        None => {
            store.mark_unknown(&reservation.attempt_id)?;
            return Err(AiError::UnknownOutcome);
        }
    };
    let (input_tokens, output_tokens) = match usage_counts(usage) {
        Ok(n) => n,
        Err(_) => {
            store.mark_unknown_usage(&reservation.attempt_id, &sanitized_usage(usage))?;
            return Err(AiError::UnknownOutcome);
        }
    };
    let actual = match reservation
        .execution
        .price
        .as_ref()
        .map(|price| price.cost(input_tokens, output_tokens))
        .transpose()
    {
        Ok(cost) => cost,
        Err(_) => {
            store.mark_unknown_usage(&reservation.attempt_id, &sanitized_usage(usage))?;
            return Err(AiError::UnknownOutcome);
        }
    };
    let usage = &sanitized_usage(usage);
    let parsed = parse_response(&reservation.task, &value);
    match parsed {
        Ok(output) => {
            match actual {
                Some(cost) => {
                    store.settle(&reservation.attempt_id, cost, usage, Some(&output), None)?
                }
                None => {
                    store.settle_unpriced(&reservation.attempt_id, usage, Some(&output), None)?
                }
            }
            if output_tokens > reservation.execution.max_output_tokens as u64 {
                store.require_review(
                    job_id,
                    "Provider exceeded approved output setting; response retained, no further send",
                )?;
                return Err(AiError::Invalid(
                    "Provider exceeded the approved output setting; inspect the saved result"
                        .into(),
                ));
            }
            Ok(Some(ExecutionResult {
                job_id: job_id.into(),
                ordinal: reservation.ordinal,
                attempt_id: reservation.attempt_id,
                charged_microusd: actual,
                output,
            }))
        }
        Err(_) => {
            match actual {
                Some(cost) => store.settle(
                    &reservation.attempt_id,
                    cost,
                    usage,
                    None,
                    Some("output_requires_review"),
                )?,
                None => store.settle_unpriced(
                    &reservation.attempt_id,
                    usage,
                    None,
                    Some("output_requires_review"),
                )?,
            }
            // Deserializers may embed provider-controlled strings in their
            // diagnostics. The renderer gets a static message, never raw
            // response content, transport diagnostics, or credential details.
            Err(AiError::Invalid(
                    "Provider output failed validation and requires review; no automatic retry was made"
                        .into(),
                ))
        }
    }
}

async fn prepare_authenticated(
    auth: &impl Authorization,
    reservation: &ReservedRequest,
) -> Result<(Value, Zeroizing<String>)> {
    let body = prepare_body(reservation)?;
    let token = auth.access_token(reservation).await?;
    Ok((body, token))
}

fn prepare_body(r: &ReservedRequest) -> Result<Value> {
    let audio = r
        .task
        .audio_attachment()
        .map(|audio| audio.verified_bytes())
        .transpose()?;
    let mut body = r.body_snapshot.clone();
    if let Some(bytes) = audio {
        use base64::Engine;
        let data = body
            .pointer_mut("/contents/0/parts/0/inlineData/data")
            .ok_or(AiError::PreparationChanged)?;
        *data = base64::engine::general_purpose::STANDARD
            .encode(bytes)
            .into();
    }
    Ok(body)
}

fn usage_counts(usage: &Value) -> Result<(u64, u64)> {
    let input = usage
        .get("promptTokenCount")
        .and_then(Value::as_u64)
        .ok_or(AiError::UnknownOutcome)?;
    let output = match usage.get("candidatesTokenCount") {
        Some(value) => value.as_u64().ok_or(AiError::UnknownOutcome)?,
        None if verified_zero_output(usage) => 0,
        None => return Err(AiError::UnknownOutcome),
    };
    let thoughts = match usage.get("thoughtsTokenCount") {
        None => 0,
        Some(value) => value.as_u64().ok_or(AiError::UnknownOutcome)?,
    };
    let output = output
        .checked_add(thoughts)
        .ok_or(AiError::UnknownOutcome)?;
    Ok((input, output))
}

pub(crate) fn sanitized_usage(usage: &Value) -> Value {
    let mut result = serde_json::Map::new();
    for name in [
        "promptTokenCount",
        "candidatesTokenCount",
        "thoughtsTokenCount",
        "totalTokenCount",
        "cachedContentTokenCount",
        "toolUsePromptTokenCount",
    ] {
        if let Some(n) = usage.get(name).and_then(Value::as_u64) {
            result.insert(name.into(), n.into());
        }
    }
    Value::Object(result)
}

#[cfg(test)]
fn usage_cost(model: &str, usage: &Value) -> Result<u64> {
    let (input, output) = usage_counts(usage)?;
    let (ir, or) = match model {
        crate::TRANSCRIBE_MODEL => (2_000_000, 12_000_000),
        _ => (300_000, 2_500_000),
    };
    crate::models::checked_cost(input, output, ir, or)
}

/// ProtoJSON can omit zero counters. Infer zero only when the independently
/// reported total equals the input count and every other output/tool counter is
/// absent or explicitly zero. Missing or malformed usage still retains the hold.
/// Vertex's total is prompt + candidates + tool-use prompt + thoughts.
fn verified_zero_output(usage: &Value) -> bool {
    let Some(input) = usage.get("promptTokenCount").and_then(Value::as_u64) else {
        return false;
    };
    usage.get("totalTokenCount").and_then(Value::as_u64) == Some(input)
        && [
            "candidatesTokenCount",
            "thoughtsTokenCount",
            "toolUsePromptTokenCount",
        ]
        .iter()
        .all(|key| match usage.get(*key) {
            None => true,
            Some(value) => value.as_u64() == Some(0),
        })
}

fn empty_candidate_content(candidate: &Value) -> bool {
    let Some(content) = candidate.get("content") else {
        return true;
    };
    let Some(content) = content.as_object() else {
        return false;
    };
    if content
        .keys()
        .any(|key| !["role", "parts"].contains(&key.as_str()))
        || content
            .get("role")
            .is_some_and(|role| role.as_str() != Some("model"))
    {
        return false;
    }
    match content.get("parts") {
        None => true,
        Some(parts) => parts.as_array().is_some_and(|parts| {
            parts.iter().all(|part| {
                part.as_object().is_some_and(|fields| {
                    fields.len() == 1 && fields.get("text").and_then(Value::as_str) == Some("")
                })
            })
        }),
    }
}

pub(crate) fn parse_response(task: &RequestTask, response: &Value) -> Result<ParsedOutput> {
    let candidates = response
        .get("candidates")
        .and_then(Value::as_array)
        .ok_or_else(|| AiError::Invalid("Provider returned no candidates".into()))?;
    if candidates.len() != 1 {
        return Err(AiError::Invalid(
            "Expected exactly one response candidate".into(),
        ));
    }
    let candidate = &candidates[0];
    if candidate.get("finishReason").and_then(Value::as_str) != Some("STOP") {
        return Err(AiError::Invalid(
            "Provider response was blocked, truncated, or incomplete; no automatic retry was made"
                .into(),
        ));
    }
    #[cfg(feature = "development-validation")]
    if matches!(task, RequestTask::TranscribeDiagnostic { .. })
        && verified_zero_output(&response["usageMetadata"])
        && empty_candidate_content(candidate)
    {
        return Ok(ParsedOutput::UntimedTranscript {
            text: String::new(),
        });
    }
    // Synchronous Transcribe returns no content for silence. Accept that only
    // with STOP and independently consistent zero-output usage; never treat a
    // missing transcription with nonzero/unknown usage as an empty subtitle set.
    if matches!(task, RequestTask::TranscribePreview { .. })
        && verified_zero_output(&response["usageMetadata"])
        && empty_candidate_content(candidate)
    {
        return Ok(ParsedOutput::Transcript { cues: Vec::new() });
    }
    let parts = candidate
        .pointer("/content/parts")
        .and_then(Value::as_array)
        .ok_or_else(|| AiError::Invalid("Provider response has no content".into()))?;
    #[cfg(feature = "development-validation")]
    if matches!(task, RequestTask::TranscribeDiagnostic { .. }) {
        return crate::transcribe::parse_untimed_transcribe_parts(parts);
    }
    if let RequestTask::TranscribePreview { audio, .. } = task {
        return crate::transcribe::parse_transcribe_parts(audio, parts);
    }
    let text = parts
        .iter()
        .filter(|p| p.get("thought").and_then(Value::as_bool) != Some(true))
        .filter_map(|p| p.get("text").and_then(Value::as_str))
        .collect::<String>();
    parse_output(task, &text)
}

#[cfg(test)]
mod fault_tests;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn billing_includes_hidden_thinking() {
        let u = serde_json::json!({"promptTokenCount":1000,"candidatesTokenCount":1000,"thoughtsTokenCount":1000});
        assert_eq!(usage_cost(crate::VOCABULARY_MODEL, &u).unwrap(), 5300);
    }
    #[test]
    fn absent_usage_is_not_zero() {
        assert!(usage_cost(crate::VOCABULARY_MODEL, &serde_json::json!({})).is_err());
    }

    #[test]
    fn omitted_zero_output_requires_consistent_total_and_all_other_counters() {
        let empty = serde_json::json!({"promptTokenCount":52,"totalTokenCount":52});
        assert_eq!(usage_cost(crate::TRANSCRIBE_MODEL, &empty).unwrap(), 104);
        for invalid in [
            serde_json::json!({"promptTokenCount":52}),
            serde_json::json!({"totalTokenCount":52}),
            serde_json::json!({"promptTokenCount":52,"totalTokenCount":53}),
            serde_json::json!({"promptTokenCount":52,"totalTokenCount":52,"candidatesTokenCount":null}),
            serde_json::json!({"promptTokenCount":52,"totalTokenCount":52,"thoughtsTokenCount":1}),
            serde_json::json!({"promptTokenCount":52,"totalTokenCount":52,"toolUsePromptTokenCount":1}),
            serde_json::json!({"promptTokenCount":52,"totalTokenCount":52,"thoughtsTokenCount":-1}),
            serde_json::json!({"promptTokenCount":52,"totalTokenCount":52,"toolUsePromptTokenCount":0.5}),
        ] {
            assert!(!verified_zero_output(&invalid), "{invalid}");
            assert!(
                usage_cost(crate::TRANSCRIBE_MODEL, &invalid).is_err(),
                "{invalid}"
            );
        }
    }

    #[test]
    fn silent_transcribe_requires_stop_zero_usage_and_no_substantive_content() {
        let audio = crate::AudioAttachment {
            path: "unused.wav".into(),
            sha256: crate::sha256_bytes(b"silence"),
            byte_len: 64044,
            mime_type: "audio/wav".into(),
            source_start_ms: 0,
            duration_ms: 2000,
        };
        let task = RequestTask::TranscribePreview {
            language: "en-US".into(),
            audio,
        };
        let raw = serde_json::json!({"candidates":[{"finishReason":"STOP","content":{"role":"model"}}],"usageMetadata":{"promptTokenCount":52,"totalTokenCount":52}});
        for content in [
            None,
            Some(serde_json::json!({})),
            Some(serde_json::json!({"role":"model","parts":[]})),
            Some(serde_json::json!({"parts":[{"text":""}]})),
        ] {
            let mut response = raw.clone();
            if let Some(content) = content {
                response["candidates"][0]["content"] = content;
            } else {
                response["candidates"][0]
                    .as_object_mut()
                    .unwrap()
                    .remove("content");
            }
            assert!(
                matches!(parse_response(&task, &response).unwrap(), ParsedOutput::Transcript { cues } if cues.is_empty())
            );
        }
        for content in [
            serde_json::json!({"parts":[{"text":"speech without timing"}]}),
            serde_json::json!({"parts":[{"functionCall":{"name":"untrusted"}}]}),
            serde_json::json!({"parts":null}),
            serde_json::json!(null),
        ] {
            let mut response = raw.clone();
            response["candidates"][0]["content"] = content;
            assert!(parse_response(&task, &response).is_err());
        }
        let mut incomplete = raw.clone();
        incomplete["candidates"][0]["finishReason"] = serde_json::json!("MAX_TOKENS");
        assert!(parse_response(&task, &incomplete).is_err());
        let mut uncertain = raw;
        uncertain["usageMetadata"]["totalTokenCount"] = serde_json::json!(53);
        assert!(parse_response(&task, &uncertain).is_err());
    }

    #[test]
    fn changed_prepared_audio_fails_before_sending() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("clip.flac");
        std::fs::write(&path, b"original").unwrap();
        let audio = crate::AudioAttachment::from_file(path.clone(), 0, 1000).unwrap();
        std::fs::write(path, b"modified").unwrap();
        assert!(matches!(
            audio.verified_bytes(),
            Err(AiError::PreparationChanged)
        ));
    }
    #[test]
    fn source_refs_are_validated() {
        let task = RequestTask::Vocabulary {
            learning_language: "en".into(),
            explanation_language: "ja".into(),
            cues: vec![crate::SourceCue {
                id: "known".into(),
                start_ms: 0,
                end_ms: 1000,
                text: "word".into(),
            }],
            max_items: 2,
        };
        let raw = serde_json::json!({"candidates":[{"finishReason":"STOP","content":{"parts":[{"text":"{\"items\":[{\"term\":\"x\",\"meaning\":\"y\",\"explanation\":\"\",\"example\":\"\",\"sourceCueIds\":[\"invented\"]}]}"}]}}]});
        assert!(parse_response(&task, &raw).is_err());
    }
    #[test]
    fn truncated_json_is_not_accepted() {
        let task = RequestTask::Vocabulary {
            learning_language: "en".into(),
            explanation_language: "ja".into(),
            cues: vec![],
            max_items: 1,
        };
        let raw = serde_json::json!({"candidates":[{"finishReason":"MAX_TOKENS","content":{"parts":[{"text":"{\"items\":[]}"}]}}]});
        assert!(parse_response(&task, &raw).is_err());
    }
}
