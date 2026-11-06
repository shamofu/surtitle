use crate::{AiError, AiProvider, RequestTask, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// A price supplied by the upstream service or explicitly entered by the user.
/// Rates are USD micro-units per million tokens, not an invoice guarantee.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PriceSnapshot {
    pub id: String,
    pub source: String,
    pub observed_at_ms: i64,
    pub input_microusd_per_million: u64,
    pub output_microusd_per_million: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audio_microusd_per_minute: Option<u64>,
}

impl PriceSnapshot {
    pub fn cost(&self, input: u64, output: u64) -> Result<u64> {
        checked_cost(
            input,
            output,
            self.input_microusd_per_million,
            self.output_microusd_per_million,
        )
    }
    pub fn audio_cost(&self, duration_ms: u64) -> Result<u64> {
        let rate = self
            .audio_microusd_per_minute
            .ok_or_else(|| AiError::Invalid("Audio duration price is required".into()))?;
        u64::try_from((duration_ms as u128 * rate as u128).div_ceil(60_000))
            .map_err(|_| AiError::Invalid("Cost calculation overflow".into()))
    }
    fn validate(&self) -> Result<()> {
        if self.id.is_empty()
            || self.id.len() > 500
            || self.source.is_empty()
            || self.source.len() > 2000
            || self.observed_at_ms <= 0
            || self.input_microusd_per_million > 1_000_000_000_000
            || self
                .audio_microusd_per_minute
                .is_some_and(|rate| rate > 1_000_000_000_000)
            || self.output_microusd_per_million > 1_000_000_000_000
        {
            return Err(AiError::Invalid("Invalid explicit price snapshot".into()));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ThinkingConfig {
    #[default]
    Omit,
    Level {
        level: String,
    },
    Budget {
        tokens: i32,
    },
}

/// Immutable per-job wire settings. Model IDs are syntactically checked, never
/// selected from an application-owned model or price allowlist.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ResponseMode {
    #[default]
    GenerateContent,
    StreamGenerateContent,
    Responses,
    StreamResponses,
    AudioTranscriptions,
}
impl ResponseMode {
    fn is_buffered(&self) -> bool {
        *self == Self::GenerateContent
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OpenAiAudioChunkingStrategy {
    Auto,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OpenAiAudioLanguageHintFormat {
    Languages,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AudioRequestLimits {
    pub maximum_bytes: u64,
    pub maximum_duration_ms: u64,
}

impl AudioRequestLimits {
    pub const fn for_provider(provider: AiProvider) -> Self {
        match provider {
            AiProvider::Vertex => Self {
                maximum_bytes: 12 * 1024 * 1024,
                maximum_duration_ms: 240_000,
            },
            AiProvider::Openai => Self {
                maximum_bytes: crate::AudioAttachment::MAX_OPENAI_FILE_BYTES,
                maximum_duration_ms: crate::AudioAttachment::MAX_OPENAI_DURATION_MS,
            },
        }
    }
}

/// Versioned preparation limits frozen into new Vertex audio approvals.
/// Absence deliberately retains the legacy 12 MiB / 240 second contract.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum VertexAudioPolicy {
    TranscribeFileV1,
    AudioUnderstandingFileV1,
}

impl VertexAudioPolicy {
    /// Conservative application transport bound for the complete JSON request;
    /// this is not a universal upstream Vertex limit.
    pub const MAX_REQUEST_BYTES: u64 = 20_000_000;
    pub const REQUEST_ENVELOPE_RESERVE_BYTES: u64 = 64 * 1024;
    pub const MAX_INLINE_AUDIO_BYTES: u64 =
        (Self::MAX_REQUEST_BYTES - Self::REQUEST_ENVELOPE_RESERVE_BYTES) / 4 * 3;

    pub const fn limits(self) -> AudioRequestLimits {
        AudioRequestLimits {
            maximum_bytes: Self::MAX_INLINE_AUDIO_BYTES,
            maximum_duration_ms: match self {
                // Transcribe requests always enable word timestamps.
                Self::TranscribeFileV1 => 900_000,
                Self::AudioUnderstandingFileV1 => 30_240_000,
            },
        }
    }

    pub(crate) fn validate_request_size(self, serialized_bytes: u64) -> Result<()> {
        if serialized_bytes > Self::MAX_REQUEST_BYTES {
            return Err(AiError::Invalid(
                "Vertex audio request exceeds the application's 20,000,000-byte JSON transport limit"
                    .into(),
            ));
        }
        Ok(())
    }

    pub(crate) fn validate_frozen_request(self, body: &Value, audio_bytes: u64) -> Result<()> {
        let encoded_bytes = audio_bytes.div_ceil(3).checked_mul(4);
        let serialized_bytes = (serde_json::to_vec(body)?.len() as u64)
            .checked_add(encoded_bytes.ok_or(AiError::PreparationChanged)?)
            .ok_or(AiError::PreparationChanged)?;
        self.validate_request_size(serialized_bytes)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ExecutionConfig {
    #[serde(default, skip_serializing_if = "AiProvider::is_vertex")]
    pub provider: AiProvider,
    pub model_id: String,
    pub location: String,
    pub max_output_tokens: u32,
    #[serde(default)]
    pub thinking: ThinkingConfig,
    pub price: Option<PriceSnapshot>,
    // Omitting the legacy default preserves historical serialized plan digests.
    #[serde(default, skip_serializing_if = "ResponseMode::is_buffered")]
    pub response_mode: ResponseMode,
    /// Frozen only for newly prepared OpenAI audio requests. Legacy absence is
    /// significant: neither serialization nor resume adds an upstream option.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub openai_audio_chunking_strategy: Option<OpenAiAudioChunkingStrategy>,
    /// New quotes can select plural hints; absence retains the legacy frozen
    /// singular field and does not change existing plan serialization.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub openai_audio_language_hint_format: Option<OpenAiAudioLanguageHintFormat>,
    /// Optional recording context, preserved verbatim in each frozen request.
    /// Absence preserves historical plan bytes and upstream behavior.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub openai_audio_prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vertex_audio_policy: Option<VertexAudioPolicy>,
}

impl ExecutionConfig {
    pub fn for_task(task: &RequestTask) -> Self {
        Self {
            provider: AiProvider::Vertex,
            model_id: String::new(),
            location: "global".into(),
            max_output_tokens: task.max_output_tokens(),
            thinking: ThinkingConfig::Omit,
            price: None,
            response_mode: ResponseMode::GenerateContent,
            openai_audio_chunking_strategy: None,
            openai_audio_language_hint_format: None,
            openai_audio_prompt: None,
            vertex_audio_policy: None,
        }
    }
    pub fn audio_limits(&self) -> AudioRequestLimits {
        self.vertex_audio_policy
            .map(VertexAudioPolicy::limits)
            .unwrap_or_else(|| AudioRequestLimits::for_provider(self.provider))
    }
    pub fn validate(&self) -> Result<()> {
        if self.vertex_audio_policy.is_some() && self.provider != AiProvider::Vertex {
            return Err(AiError::Invalid(
                "Vertex audio preparation policy requires the Vertex provider".into(),
            ));
        }
        if let Some(prompt) = &self.openai_audio_prompt {
            // This is a local input bound, not an upstream model token limit.
            if prompt.trim().is_empty()
                || prompt.len() > 2000
                || self.provider != AiProvider::Openai
                || self.response_mode != ResponseMode::AudioTranscriptions
            {
                return Err(AiError::Invalid(
                    "Audio context requires OpenAI audio transcriptions and 1–2000 UTF-8 bytes of nonblank text".into(),
                ));
            }
        }
        if self.openai_audio_language_hint_format.is_some()
            && (self.provider != AiProvider::Openai
                || self.response_mode != ResponseMode::AudioTranscriptions)
        {
            return Err(AiError::Invalid(
                "Audio language hints require OpenAI audio transcriptions".into(),
            ));
        }
        if self.openai_audio_chunking_strategy.is_some()
            && (self.provider != AiProvider::Openai
                || self.response_mode != ResponseMode::AudioTranscriptions)
        {
            return Err(AiError::Invalid(
                "Audio chunking requires OpenAI audio transcriptions".into(),
            ));
        }
        // Vertex model IDs become URL path segments; OpenAI IDs stay JSON values.
        if !valid_provider_model_id(self.provider, &self.model_id)
            || !(1..=63).contains(&self.location.len())
            || !self
                .location
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            || !self.location.as_bytes()[0].is_ascii_lowercase()
            || self.location.ends_with('-')
            || self.max_output_tokens == 0
            || self.max_output_tokens > 1_048_576
        {
            return Err(AiError::Invalid(
                "Invalid model ID, location, or explicit output limit".into(),
            ));
        }
        if self.provider == AiProvider::Openai {
            if self.location != "global"
                || !matches!(
                    self.response_mode,
                    ResponseMode::Responses
                        | ResponseMode::StreamResponses
                        | ResponseMode::AudioTranscriptions
                )
                || self.thinking != ThinkingConfig::Omit
            {
                return Err(AiError::Invalid(
                    "Invalid OpenAI endpoint or unsupported thinking setting".into(),
                ));
            }
        } else if !matches!(
            self.response_mode,
            ResponseMode::GenerateContent | ResponseMode::StreamGenerateContent
        ) {
            return Err(AiError::Invalid("Invalid Vertex response mode".into()));
        }
        match &self.thinking {
            ThinkingConfig::Omit => {}
            ThinkingConfig::Level { level }
                if !level.is_empty()
                    && level.len() <= 64
                    && level.bytes().all(|b| b.is_ascii_uppercase() || b == b'_') => {}
            ThinkingConfig::Budget { tokens } if (-1..=1_048_576).contains(tokens) => {}
            _ => return Err(AiError::Invalid("Invalid explicit thinking setting".into())),
        }
        if let Some(price) = &self.price {
            price.validate()?;
        }
        Ok(())
    }
    pub(crate) fn apply(&self, body: &mut Value) -> Result<()> {
        self.validate()?;
        if self.provider == AiProvider::Openai {
            let config = body.as_object_mut().ok_or(AiError::PreparationChanged)?;
            config.insert("model".into(), self.model_id.clone().into());
            match self.openai_audio_chunking_strategy {
                Some(OpenAiAudioChunkingStrategy::Auto) => {
                    config.insert("chunking_strategy".into(), "auto".into());
                }
                None => {
                    config.remove("chunking_strategy");
                }
            }
            match &self.openai_audio_prompt {
                Some(prompt) => {
                    config.insert("prompt".into(), prompt.clone().into());
                }
                None => {
                    config.remove("prompt");
                }
            }
            if self.response_mode != ResponseMode::AudioTranscriptions {
                config.insert("max_output_tokens".into(), self.max_output_tokens.into());
                config.insert("store".into(), false.into());
                config.insert(
                    "stream".into(),
                    (self.response_mode == ResponseMode::StreamResponses).into(),
                );
            }
            return Ok(());
        }
        let config = body["generationConfig"]
            .as_object_mut()
            .ok_or_else(|| AiError::Invalid("Missing generation settings".into()))?;
        config.insert("maxOutputTokens".into(), self.max_output_tokens.into());
        config.insert("candidateCount".into(), 1.into());
        config.remove("thinkingConfig");
        match &self.thinking {
            ThinkingConfig::Omit => {}
            ThinkingConfig::Level { level } => {
                config.insert("thinkingConfig".into(), json!({"thinkingLevel":level}));
            }
            ThinkingConfig::Budget { tokens } => {
                config.insert("thinkingConfig".into(), json!({"thinkingBudget":tokens}));
            }
        }
        Ok(())
    }
    pub(crate) fn endpoint(&self, project: &str) -> Result<String> {
        self.validate()?;
        if self.provider == AiProvider::Openai {
            if project != "openai" {
                return Err(AiError::PreparationChanged);
            }
            return Ok(match self.response_mode {
                ResponseMode::Responses | ResponseMode::StreamResponses => {
                    "https://api.openai.com/v1/responses"
                }
                ResponseMode::AudioTranscriptions => {
                    "https://api.openai.com/v1/audio/transcriptions"
                }
                _ => return Err(AiError::PreparationChanged),
            }
            .into());
        }
        if !crate::models::valid_project_id(project) {
            return Err(AiError::PreparationChanged);
        }
        let host = if self.location == "global" {
            "aiplatform.googleapis.com".into()
        } else {
            format!("{}-aiplatform.googleapis.com", self.location)
        };
        let method = match self.response_mode {
            ResponseMode::GenerateContent => "generateContent",
            ResponseMode::StreamGenerateContent => "streamGenerateContent?alt=sse",
            _ => return Err(AiError::PreparationChanged),
        };
        Ok(format!(
            "https://{host}/v1/projects/{project}/locations/{}/publishers/google/models/{}:{method}",
            self.location, self.model_id
        ))
    }
}

pub(crate) fn checked_cost(input: u64, output: u64, ir: u64, or: u64) -> Result<u64> {
    let n = (input as u128 * ir as u128).div_ceil(1_000_000)
        + (output as u128 * or as u128).div_ceil(1_000_000);
    u64::try_from(n).map_err(|_| AiError::Invalid("Cost calculation overflow".into()))
}

#[cfg(test)]
pub(crate) fn fixture_execution(task: &RequestTask) -> ExecutionConfig {
    let mut execution = ExecutionConfig::for_task(task);
    execution.model_id = task.model().into();
    // Explicit test fixture prices; never reachable from the production defaults.
    let (input, output) = match task {
        RequestTask::TranscribePreview { .. } => (2_000_000, 12_000_000),
        RequestTask::AudioTranscription { .. } => (1_500_000, 9_000_000),
        _ => (300_000, 2_500_000),
    };
    execution.price = Some(PriceSnapshot {
        id: "fixture-price".into(),
        source: "offline fixture".into(),
        observed_at_ms: 1_788_825_600_000,
        input_microusd_per_million: input,
        output_microusd_per_million: output,
        audio_microusd_per_minute: None,
    });
    execution
}

#[cfg(test)]
mod tests;

pub(crate) fn valid_provider_model_id(provider: AiProvider, id: &str) -> bool {
    (1..=200).contains(&id.len())
        && id != "."
        && id != ".."
        && id.bytes().all(|b| {
            b.is_ascii_alphanumeric()
                || b"-._@".contains(&b)
                || provider == AiProvider::Openai && b == b':'
        })
}
