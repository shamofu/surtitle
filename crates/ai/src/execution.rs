use crate::{models::checked_cost, AiError, RequestTask, Result};
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
    fn validate(&self) -> Result<()> {
        if self.id.is_empty()
            || self.id.len() > 500
            || self.source.is_empty()
            || self.source.len() > 2000
            || self.observed_at_ms <= 0
            || self.input_microusd_per_million > 1_000_000_000_000
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
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ExecutionConfig {
    pub model_id: String,
    pub location: String,
    pub max_output_tokens: u32,
    #[serde(default)]
    pub thinking: ThinkingConfig,
    pub price: Option<PriceSnapshot>,
}

impl ExecutionConfig {
    pub fn for_task(task: &RequestTask) -> Self {
        Self {
            model_id: String::new(),
            location: "global".into(),
            max_output_tokens: task.max_output_tokens(),
            thinking: ThinkingConfig::Omit,
            price: None,
        }
    }
    pub fn validate(&self) -> Result<()> {
        // These are path-segment and hostname checks, not model availability checks.
        if !(1..=200).contains(&self.model_id.len())
            || !self
                .model_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'@'))
            || self.model_id == "."
            || self.model_id == ".."
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
        if !crate::models::valid_project_id(project) {
            return Err(AiError::PreparationChanged);
        }
        let host = if self.location == "global" {
            "aiplatform.googleapis.com".into()
        } else {
            format!("{}-aiplatform.googleapis.com", self.location)
        };
        Ok(format!("https://{host}/v1/projects/{project}/locations/{}/publishers/google/models/{}:generateContent", self.location, self.model_id))
    }
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
    });
    execution
}

#[cfg(test)]
mod tests;
