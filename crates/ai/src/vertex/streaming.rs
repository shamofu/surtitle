//! Bounded SSE decoding for text and JSON-cue GenerateContent responses. HTTP chunks are
//! arbitrary byte boundaries, not events or UTF-8 boundaries. Never retain thought
//! text/signatures, provider diagnostics, or other unknown response properties.
use super::{Value, MAX_RESPONSE_BYTES};
use serde_json::json;

#[derive(Default)]
pub(super) struct StreamResponse {
    pending: Vec<u8>,
    data: Vec<u8>,
    total: usize,
    text: String,
    candidate_seen: bool,
    finish_reason: Option<String>,
    usage: Option<Value>,
    valid_usage: bool,
    final_usage: bool,
    model_version: Option<String>,
    block_reason: Option<String>,
    done: bool,
}

impl StreamResponse {
    pub(super) fn push(&mut self, bytes: &[u8]) -> Result<Vec<String>, ()> {
        if bytes.len() > MAX_RESPONSE_BYTES - self.total {
            return Err(());
        }
        self.total += bytes.len();
        self.pending.extend_from_slice(bytes);
        let mut consumed = 0;
        let mut deltas = Vec::new();
        while let Some(end) = self.pending[consumed..].iter().position(|b| *b == b'\n') {
            let end = consumed + end;
            let line = self.pending[consumed..end]
                .strip_suffix(b"\r")
                .unwrap_or(&self.pending[consumed..end])
                .to_vec();
            consumed = end + 1;
            if line.is_empty() {
                if !self.data.is_empty() {
                    let data = std::mem::take(&mut self.data);
                    if data == b"[DONE]" {
                        if self.finish_reason.is_none() || self.done {
                            return Err(());
                        }
                        self.done = true;
                    } else {
                        if self.done {
                            return Err(());
                        }
                        let value: Value = serde_json::from_slice(&data).map_err(|_| ())?;
                        if let Some(text) = self.merge(value)? {
                            deltas.push(text);
                        }
                    }
                }
            } else if let Some(data) = line.strip_prefix(b"data:") {
                if !self.data.is_empty() {
                    self.data.push(b'\n');
                }
                self.data
                    .extend_from_slice(data.strip_prefix(b" ").unwrap_or(data));
            }
            // SSE comments and control fields do not contain model output.
        }
        self.pending.drain(..consumed);
        Ok(deltas)
    }

    fn merge(&mut self, value: Value) -> Result<Option<String>, ()> {
        if !value.is_object() || value.get("error").is_some() {
            return Err(());
        }
        let mut delta = String::new();
        if let Some(candidates) = value.get("candidates") {
            let candidates = candidates.as_array().ok_or(())?;
            if candidates.len() > 1 {
                return Err(());
            }
            if let Some(candidate) = candidates.first() {
                if !candidate.is_object()
                    || candidate
                        .get("index")
                        .is_some_and(|i| i.as_u64() != Some(0))
                {
                    return Err(());
                }
                self.candidate_seen = true;
                if let Some(parts) = candidate.pointer("/content/parts") {
                    for part in parts.as_array().ok_or(())? {
                        if !part.is_object() {
                            return Err(());
                        }
                        // A malformed thought flag is not safe to interpret as false.
                        match part.get("thought") {
                            Some(Value::Bool(true)) => continue,
                            None | Some(Value::Bool(false)) => {}
                            _ => return Err(()),
                        }
                        if let Some(text) = part.get("text") {
                            delta.push_str(text.as_str().ok_or(())?);
                        }
                    }
                }
                if !delta.is_empty() {
                    if self.finish_reason.is_some() {
                        return Err(());
                    }
                    self.final_usage = false;
                    self.text.push_str(&delta);
                }
                if let Some(reason) = candidate.get("finishReason") {
                    let reason = reason.as_str().ok_or(())?;
                    if reason.len() > 64
                        || !reason.bytes().all(|b| b.is_ascii_uppercase() || b == b'_')
                    {
                        return Err(());
                    }
                    if self
                        .finish_reason
                        .as_ref()
                        .is_some_and(|prior| prior != reason)
                    {
                        return Err(());
                    }
                    if !reason.is_empty() && self.finish_reason.is_none() {
                        self.finish_reason = Some(reason.into());
                        self.final_usage = false;
                    }
                }
            }
        }
        if let Some(usage) = value.get("usageMetadata") {
            if !usage.is_object() {
                return Err(());
            }
            // Usage is a cumulative snapshot. Repeated chunks must not double bill.
            self.usage = Some(super::sanitized_usage(usage));
            // Check the original numbers before sanitization removes malformed values.
            self.valid_usage = super::usage_counts(usage).is_ok();
            self.final_usage = self.finish_reason.is_some() || !self.candidate_seen;
        }
        if let Some(version) = value.get("modelVersion").and_then(Value::as_str) {
            if version.len() <= 200
                && version
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-._@".contains(&b))
            {
                if self
                    .model_version
                    .as_ref()
                    .is_some_and(|prior| prior != version)
                {
                    return Err(());
                }
                self.model_version = Some(version.into());
            }
        }
        if let Some(reason) = value
            .pointer("/promptFeedback/blockReason")
            .and_then(Value::as_str)
        {
            if reason.len() <= 64 && reason.bytes().all(|b| b.is_ascii_uppercase() || b == b'_') {
                self.block_reason = Some(reason.into());
            }
        }
        Ok((!delta.is_empty()).then_some(delta))
    }

    pub(super) fn finish(self) -> Result<Value, ()> {
        // EOF does not complete an unterminated SSE event or establish final usage.
        if !self.pending.is_empty()
            || !self.data.is_empty()
            || !self.final_usage
            || !self.valid_usage
        {
            return Err(());
        }
        let candidates = if self.candidate_seen {
            vec![json!({"index":0,"finishReason":self.finish_reason,
                "content":{"role":"model","parts":[{"text":self.text}]}})]
        } else {
            Vec::new()
        };
        let mut response = json!({"candidates":candidates,"usageMetadata":self.usage});
        if let Some(version) = self.model_version {
            response["modelVersion"] = json!(version);
        }
        if let Some(reason) = self.block_reason {
            response["promptFeedback"] = json!({"blockReason":reason});
        }
        Ok(response)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(value: Value) -> Vec<u8> {
        format!("data: {value}\r\n\r\n").into_bytes()
    }
    fn terminal() -> Value {
        json!({"candidates":[{"index":0,"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5,"thoughtsTokenCount":2}})
    }

    #[test]
    fn arbitrary_byte_boundaries_filter_thoughts_and_keep_last_usage() {
        let mut wire = frame(
            json!({"candidates":[{"content":{"parts":[{"text":"secret", "thought":true},{"text":"語彙"}]}}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":1}}),
        );
        wire.extend(frame(
            json!({"candidates":[{"content":{"parts":[{"text":"😀"}]}}]}),
        ));
        wire.extend(frame(terminal()));
        for size in 1..=wire.len() {
            let mut stream = StreamResponse::default();
            let mut deltas = String::new();
            for chunk in wire.chunks(size) {
                deltas.extend(stream.push(chunk).unwrap());
            }
            let result = stream.finish().unwrap();
            assert_eq!(deltas, "語彙😀");
            assert_eq!(
                result["candidates"][0]["content"]["parts"][0]["text"],
                "語彙😀"
            );
            assert_eq!(result["usageMetadata"]["candidatesTokenCount"], 5);
            assert!(!result.to_string().contains("secret"));
        }
    }

    #[test]
    fn incomplete_and_ambiguous_streams_are_not_complete_results() {
        for input in [
            b"data: {\"candidates\":[]}".to_vec(),
            frame(json!({"candidates":[{"content":{"parts":[{"text":"partial"}]}}]})),
            frame(json!({"candidates":[{"finishReason":"STOP"}]})),
            frame(
                json!({"candidates":[{"index":1,"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":2}}),
            ),
            frame(json!({"error":{"message":"private"}})),
        ] {
            let mut stream = StreamResponse::default();
            assert!(stream.push(&input).and_then(|_| stream.finish()).is_err());
        }
    }

    #[test]
    fn truncation_with_final_usage_is_kept_for_settled_rejection() {
        let mut value = terminal();
        value["candidates"][0]["finishReason"] = json!("MAX_TOKENS");
        let mut stream = StreamResponse::default();
        stream.push(&frame(value)).unwrap();
        assert_eq!(
            stream.finish().unwrap()["candidates"][0]["finishReason"],
            "MAX_TOKENS"
        );
    }

    #[test]
    fn repeated_terminal_metadata_preserves_final_usage() {
        let mut stream = StreamResponse::default();
        stream.push(&frame(terminal())).unwrap();
        stream
            .push(&frame(
                json!({"candidates":[{"index":0,"finishReason":"STOP"}]}),
            ))
            .unwrap();
        let result = stream.finish().unwrap();
        assert_eq!(result["usageMetadata"]["candidatesTokenCount"], 5);
        assert_eq!(result["usageMetadata"]["thoughtsTokenCount"], 2);

        let mut stream = StreamResponse::default();
        stream.push(&frame(terminal())).unwrap();
        assert!(stream
            .push(&frame(json!({"candidates":[{"content":{"parts":[{"text":"late"}]},"finishReason":"STOP"}]})))
            .is_err());
    }

    #[test]
    fn stale_usage_after_more_content_and_oversized_wire_are_rejected() {
        let mut stream = StreamResponse::default();
        stream
            .push(&frame(
                json!({"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":1}}),
            ))
            .unwrap();
        stream.push(&frame(json!({"candidates":[{"content":{"parts":[{"text":"more"}]},"finishReason":"STOP"}]}))).unwrap();
        assert!(stream.finish().is_err());
        assert!(StreamResponse::default()
            .push(&vec![b'x'; MAX_RESPONSE_BYTES + 1])
            .is_err());
    }
}
