//! Immutable prepared plans, frozen request bodies, and estimates.
use super::{valid_project_id, valid_sha, RequestTask};
use crate::{sha256_bytes, AiError, ExecutionConfig, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PreparationBinding {
    pub media_id: String,
    pub transcript_revision: String,
    pub source_sha256: String,
    pub settings_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PreparedJob {
    pub title: String,
    pub project_id: String,
    pub credential_id: String,
    pub binding: PreparationBinding,
    pub requests: Vec<RequestTask>,
    pub execution: ExecutionConfig,
    frozen_requests: Vec<Value>,
    frozen_task_digests: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RequestEstimate {
    pub ordinal: u32,
    pub model: String,
    pub input_tokens_reserved: u64,
    pub output_tokens_reserved: u64,
    pub max_output_tokens: u32,
    pub estimated_max_microusd: Option<u64>,
    pub audio_duration_ms: u64,
}

impl PreparedJob {
    /// Free local audio container. Missing identity/model/templates deliberately
    /// makes this invalid for AiStore::prepare and every dispatch entrypoint.
    pub fn local_audio_draft(
        title: String,
        binding: PreparationBinding,
        requests: Vec<RequestTask>,
    ) -> Result<Self> {
        if requests.is_empty() || requests.len() > 5000 {
            return Err(AiError::Invalid(
                "Empty or oversized local audio draft".into(),
            ));
        }
        for task in &requests {
            if !matches!(
                task,
                RequestTask::AudioTranscription { .. } | RequestTask::TranscribePreview { .. }
            ) {
                return Err(AiError::Invalid(
                    "A local audio draft only holds audio attachments".into(),
                ));
            }
            task.validate()?;
        }
        let execution = ExecutionConfig::for_task(&requests[0]);
        Ok(Self {
            title,
            project_id: String::new(),
            credential_id: String::new(),
            binding,
            requests,
            execution,
            frozen_requests: Vec::new(),
            frozen_task_digests: Vec::new(),
        })
    }

    pub fn new(
        title: String,
        project_id: String,
        credential_id: String,
        binding: PreparationBinding,
        requests: Vec<RequestTask>,
        execution: ExecutionConfig,
    ) -> Result<Self> {
        execution.validate()?;
        let mut frozen_requests = Vec::with_capacity(requests.len());
        for task in &requests {
            task.validate()?;
            let mut body = task.body(Some(&[]))?;
            execution.apply(&mut body)?;
            frozen_requests.push(body);
        }
        let frozen_task_digests = requests
            .iter()
            .map(|task| serde_json::to_vec(task).map(|bytes| sha256_bytes(&bytes)))
            .collect::<std::result::Result<_, _>>()?;
        let job = Self {
            title,
            project_id,
            credential_id,
            binding,
            requests,
            execution,
            frozen_requests,
            frozen_task_digests,
        };
        job.validate()?;
        Ok(job)
    }
    pub fn with_execution(self, execution: ExecutionConfig) -> Result<Self> {
        Self::new(
            self.title,
            self.project_id,
            self.credential_id,
            self.binding,
            self.requests,
            execution,
        )
    }
    pub fn request_body_snapshot(&self, ordinal: u32) -> Result<&Value> {
        self.frozen_requests
            .get(ordinal as usize)
            .ok_or(AiError::PreparationChanged)
    }
    pub fn total_output_tokens(&self) -> u64 {
        self.requests.len() as u64 * self.execution.max_output_tokens as u64
    }
    #[cfg(test)]
    pub(crate) fn refreeze(self) -> Self {
        let execution = self.execution.clone();
        self.with_execution(execution).unwrap()
    }
    #[cfg(test)]
    pub(crate) fn fixture(
        title: String,
        project_id: String,
        credential_id: String,
        binding: PreparationBinding,
        requests: Vec<RequestTask>,
    ) -> Self {
        let execution = crate::execution::fixture_execution(&requests[0]);
        Self::new(
            title,
            project_id,
            credential_id,
            binding,
            requests,
            execution,
        )
        .unwrap()
    }

    pub fn digest(&self) -> Result<String> {
        Ok(sha256_bytes(&serde_json::to_vec(self)?))
    }

    pub fn validate(&self) -> Result<()> {
        self.execution.validate()?;
        if self.frozen_requests.len() != self.requests.len()
            || self.frozen_task_digests.len() != self.requests.len()
        {
            return Err(AiError::PreparationChanged);
        }
        if self.title.trim().is_empty()
            || self.title.len() > 500
            || !valid_project_id(&self.project_id)
            || self.credential_id.is_empty()
            || self.requests.is_empty()
            || self.requests.len() > 5000
        {
            return Err(AiError::Invalid("Invalid or empty job preparation".into()));
        }
        if self.binding.media_id.is_empty()
            || self.binding.transcript_revision.is_empty()
            || !valid_sha(&self.binding.source_sha256)
            || !valid_sha(&self.binding.settings_sha256)
        {
            return Err(AiError::Invalid(
                "An immutable source, transcript revision, and settings fingerprint are required"
                    .into(),
            ));
        }
        for ((task, body), task_digest) in self
            .requests
            .iter()
            .zip(&self.frozen_requests)
            .zip(&self.frozen_task_digests)
        {
            task.validate()?;
            if &sha256_bytes(&serde_json::to_vec(task)?) != task_digest {
                return Err(AiError::PreparationChanged);
            }
            // Preserve prompts/schema from preparation across binary updates.
            let mut checked = body.clone();
            self.execution.apply(&mut checked)?;
            if checked != *body
                || body.as_object().is_none_or(|o| {
                    o.keys().any(|k| {
                        !["contents", "systemInstruction", "generationConfig"].contains(&k.as_str())
                    })
                })
                || serde_json::to_vec(body)?.len() > 2 * 1024 * 1024
            {
                return Err(AiError::PreparationChanged);
            }
            let inline = body.pointer("/contents/0/parts/0/inlineData");
            match task.audio_attachment() {
                Some(audio) => {
                    if inline.and_then(|v| v.get("data")).and_then(Value::as_str) != Some("")
                        || inline
                            .and_then(|v| v.get("mimeType"))
                            .and_then(Value::as_str)
                            != Some(&audio.mime_type)
                    {
                        return Err(AiError::PreparationChanged);
                    }
                }
                _ if inline.is_some() => return Err(AiError::PreparationChanged),
                _ => {}
            }
        }
        Ok(())
    }

    pub fn estimates(&self) -> Result<Vec<RequestEstimate>> {
        self.validate()?;
        self.requests
            .iter()
            .enumerate()
            .map(|(n, r)| r.estimate_with(n as u32, &self.execution, &self.frozen_requests[n]))
            .collect()
    }
}
