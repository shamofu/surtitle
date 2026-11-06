//! OpenAI wire normalization into the common bounded evidence/validation envelope.
use crate::{AiError, ExecutionConfig, RequestTask, Result};
use serde_json::{json, Value};

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reasoning_is_not_double_billed_and_untrusted_fields_are_not_retained() {
        let raw = json!({"status":"completed","model":"ft:gpt-4.1-2025-04-14:org:suffix:id","output":[{"type":"reasoning","summary":[{"text":"secret"}]},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"{}"}]}],"usage":{"input_tokens":100,"output_tokens":50,"output_tokens_details":{"reasoning_tokens":40},"input_tokens_details":{"cached_tokens":80}},"debug":"secret"});
        let value = normalize_response(&raw, None).unwrap();
        assert_eq!(value["usageMetadata"]["candidatesTokenCount"], 50);
        assert_eq!(value["usageMetadata"]["promptTokenCount"], 100);
        assert_eq!(value["modelVersion"], "ft:gpt-4.1-2025-04-14:org:suffix:id");
        assert!(!value.to_string().contains("secret"));
        let mut invalid = raw;
        invalid["usage"]["output_tokens"] = json!(-1);
        assert!(normalize_response(&invalid, None)
            .unwrap()
            .get("usageMetadata")
            .is_none());
    }
    #[test]
    fn duration_usage_preserves_fractional_seconds_conservatively_without_inventing_cues() {
        let value = normalize_response(
            &json!({"text":"ええ、ええ。","usage":{"type":"duration","seconds":1.2345}}),
            Some(2),
        )
        .unwrap();
        assert_eq!(value["usageMetadata"]["audioDurationMillis"], 1235);
        assert_eq!(
            value["candidates"][0]["content"]["parts"][0]["audioTranscription"]["text"],
            "ええ、ええ。"
        );
        assert!(!value.to_string().contains("startMs"));
        for seconds in [json!(-1), json!("2"), json!(null)] {
            assert!(normalize_response(
                &json!({"text":"hello","usage":{"type":"duration","seconds":seconds}}),
                Some(2)
            )
            .unwrap()
            .get("usageMetadata")
            .is_none());
        }
    }
    #[test]
    fn sse_requires_terminal_response_and_handles_every_byte_boundary() {
        let wire = concat!("event: response.output_text.delta\r\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"語😀\"}\r\n\r\n", "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"語😀\"}]}],\"usage\":{\"input_tokens\":1,\"output_tokens\":2}}}\r\n\r\n").as_bytes();
        for size in 1..=wire.len() {
            let mut stream = ResponseStream::default();
            let mut text = String::new();
            for bytes in wire.chunks(size) {
                text.extend(stream.push(bytes).unwrap());
            }
            assert_eq!(text, "語😀");
            assert_eq!(stream.finish().unwrap()["usage"]["output_tokens"], 2);
        }
        let mut stream = ResponseStream::default();
        stream
            .push(b"data: {\"type\":\"response.output_text.delta\",\"delta\":\"x\"}\n\n")
            .unwrap();
        assert!(stream.finish().is_err());
    }
    #[test]
    fn strict_schema_rejects_extra_properties_at_every_object_level() {
        let mut schema = json!({"type":"OBJECT","properties":{"items":{"type":"ARRAY","items":{"type":"OBJECT","properties":{"term":{"type":"STRING"}},"required":["term"]}}},"required":["items"]});
        strict_schema(&mut schema).unwrap();
        assert_eq!(schema["type"], "object");
        assert_eq!(schema["additionalProperties"], false);
        assert_eq!(
            schema["properties"]["items"]["items"]["additionalProperties"],
            false
        );
    }
}

pub(crate) fn audio_language_hint(task: &RequestTask) -> Result<Option<&str>> {
    let language = match task {
        RequestTask::AudioTranscription { language, .. }
        | RequestTask::TranscribePreview { language, .. } => language,
        _ => return Err(AiError::Invalid("Unsupported OpenAI audio task".into())),
    };
    if language == "auto" {
        return Ok(None);
    }
    // Preserve the existing task-language normalization for both wire formats.
    let hint = language.split('-').next().unwrap_or("");
    if hint.len() != 2 || !hint.bytes().all(|b| b.is_ascii_lowercase()) {
        return Err(AiError::Invalid(
            "OpenAI language hint must use a two-letter language code".into(),
        ));
    }
    Ok(Some(hint))
}

pub(crate) fn frozen_body(task: &RequestTask, execution: &ExecutionConfig) -> Result<Value> {
    if let Some(audio) = task.audio_attachment() {
        if execution.response_mode != crate::ResponseMode::AudioTranscriptions
            || audio.mime_type != "audio/flac"
        {
            return Err(AiError::Invalid(
                "OpenAI transcription requires prepared FLAC and synchronous audio mode".into(),
            ));
        }
        let mut body = json!({"model":execution.model_id,"response_format":"json","file":{"mime_type":"audio/flac","data":""}});
        if let Some(hint) = audio_language_hint(task)? {
            match execution.openai_audio_language_hint_format {
                Some(crate::OpenAiAudioLanguageHintFormat::Languages) => {
                    body["languages"] = json!([hint]);
                }
                None => body["language"] = hint.into(),
            }
        }
        return Ok(body);
    }
    if !matches!(
        execution.response_mode,
        crate::ResponseMode::Responses | crate::ResponseMode::StreamResponses
    ) {
        return Err(AiError::Invalid("Text tasks require Responses mode".into()));
    }
    let source = task.body(Some(&[]))?;
    let mut schema = source["generationConfig"]["responseSchema"].clone();
    strict_schema(&mut schema)?;
    Ok(
        json!({"instructions":source["systemInstruction"]["parts"][0]["text"],"input":[{"role":"user","content":[{"type":"input_text","text":source["contents"][0]["parts"][0]["text"]}]}],"text":{"format":{"type":"json_schema","name":"surtitle_result","strict":true,"schema":schema}}}),
    )
}

fn strict_schema(value: &mut Value) -> Result<()> {
    if !value.is_object() {
        return Err(AiError::PreparationChanged);
    }
    if let Some(kind) = value.get("type").and_then(Value::as_str) {
        value["type"] = kind.to_ascii_lowercase().into();
    }
    if value["type"] == "object" {
        value["additionalProperties"] = false.into();
        let properties = value["properties"]
            .as_object_mut()
            .ok_or(AiError::PreparationChanged)?;
        for child in properties.values_mut() {
            strict_schema(child)?;
        }
    }
    if value["type"] == "array" {
        strict_schema(&mut value["items"])?;
    }
    Ok(())
}

pub(crate) fn normalize_response(raw: &Value, submitted_seconds: Option<u64>) -> Result<Value> {
    let (parts, finish, usage) = if let Some(submitted) = submitted_seconds {
        let text = raw
            .get("text")
            .and_then(Value::as_str)
            .ok_or(AiError::UnknownOutcome)?;
        let duration = raw
            .pointer("/usage/seconds")
            .and_then(Value::as_f64)
            .filter(|n| n.is_finite() && *n >= 0.0 && *n <= 86_400.0);
        let usage=duration.filter(|_|raw["usage"]["type"]=="duration").map(|n|json!({"audioDurationMillis":(n*1000.0).ceil() as u64,"audioSubmittedSeconds":submitted,"promptTokenCount":0,"candidatesTokenCount":0}));
        (
            json!([{"audioTranscription":{"text":text,"finished":true}}]),
            "STOP",
            usage,
        )
    } else {
        let mut text = String::new();
        let mut refused = false;
        let output = raw
            .get("output")
            .and_then(Value::as_array)
            .ok_or(AiError::UnknownOutcome)?;
        for item in output {
            if item["type"] == "message" {
                if item["role"] != "assistant" {
                    return Err(AiError::UnknownOutcome);
                }
                for content in item["content"].as_array().ok_or(AiError::UnknownOutcome)? {
                    match content["type"].as_str() {
                        Some("output_text") => {
                            text.push_str(content["text"].as_str().ok_or(AiError::UnknownOutcome)?)
                        }
                        Some("refusal") => refused = true,
                        _ => return Err(AiError::UnknownOutcome),
                    }
                }
            } else if item["type"] != "reasoning" {
                return Err(AiError::UnknownOutcome);
            }
        }
        let finish = if refused {
            "SAFETY"
        } else {
            match raw["status"].as_str() {
                Some("completed") => "STOP",
                Some("incomplete")
                    if raw["incomplete_details"]["reason"] == "max_output_tokens" =>
                {
                    "MAX_TOKENS"
                }
                _ => "OTHER",
            }
        };
        let usage=raw.pointer("/usage/input_tokens").and_then(Value::as_u64).zip(raw.pointer("/usage/output_tokens").and_then(Value::as_u64)).map(|(input,output)|json!({"promptTokenCount":input,"candidatesTokenCount":output,"thoughtsTokenCount":0}));
        (json!([{"text":text}]), finish, usage)
    };
    let mut out =
        json!({"candidates":[{"finishReason":finish,"content":{"role":"model","parts":parts}}]});
    if let Some(usage) = usage {
        out["usageMetadata"] = usage;
    }
    if let Some(model) = raw
        .get("model")
        .and_then(Value::as_str)
        .filter(|model| crate::execution::valid_provider_model_id(crate::AiProvider::Openai, model))
    {
        out["modelVersion"] = model.into();
    }
    Ok(out)
}

#[derive(Default)]
pub(crate) struct ResponseStream {
    pending: Vec<u8>,
    data: Vec<u8>,
    total: usize,
    terminal: Option<Value>,
}
impl ResponseStream {
    pub(crate) fn push(&mut self, bytes: &[u8]) -> std::result::Result<Vec<String>, ()> {
        if bytes.len() > 8 * 1024 * 1024 - self.total {
            return Err(());
        }
        self.total += bytes.len();
        self.pending.extend_from_slice(bytes);
        let mut consumed = 0;
        let mut deltas = Vec::new();
        while let Some(n) = self.pending[consumed..].iter().position(|b| *b == b'\n') {
            let end = consumed + n;
            let line = self.pending[consumed..end]
                .strip_suffix(b"\r")
                .unwrap_or(&self.pending[consumed..end])
                .to_vec();
            consumed = end + 1;
            if line.is_empty() && !self.data.is_empty() {
                let data = std::mem::take(&mut self.data);
                let value: Value = serde_json::from_slice(&data).map_err(|_| ())?;
                if self.terminal.is_some() {
                    return Err(());
                }
                match value["type"].as_str() {
                    Some("response.output_text.delta") => {
                        deltas.push(value["delta"].as_str().ok_or(())?.into())
                    }
                    Some("response.completed" | "response.incomplete") => {
                        self.terminal = Some(value.get("response").ok_or(())?.clone())
                    }
                    Some("error" | "response.failed") => return Err(()),
                    Some(_) => {}
                    None => return Err(()),
                }
            } else if let Some(data) = line.strip_prefix(b"data:") {
                if !self.data.is_empty() {
                    self.data.push(b'\n');
                }
                self.data
                    .extend_from_slice(data.strip_prefix(b" ").unwrap_or(data));
            }
        }
        self.pending.drain(..consumed);
        Ok(deltas)
    }
    pub(crate) fn finish(self) -> std::result::Result<Value, ()> {
        if !self.pending.is_empty() || !self.data.is_empty() {
            return Err(());
        }
        self.terminal.ok_or(())
    }
}

pub(crate) fn quota_exhausted(bytes: &[u8]) -> bool {
    let Ok(value) = serde_json::from_slice::<Value>(bytes) else {
        return false;
    };
    ["code", "type"].iter().any(|field| {
        matches!(
            value["error"][*field].as_str(),
            Some("insufficient_quota" | "credit_balance_exhausted")
        )
    })
}
