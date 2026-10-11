//! Validated provider output tied to the original source cues.
use super::{
    task::{contains_term, normalized_term},
    RequestTask,
};
use crate::{AiError, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Fixed, user-visible diagnostics; never include provider-controlled text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, thiserror::Error)]
#[serde(rename_all = "snake_case")]
pub enum OutputFailureReason {
    #[error("the response reached its output limit")]
    OutputLimit,
    #[error("the provider blocked this response")]
    Blocked,
    #[error("the response was incomplete")]
    Incomplete,
    #[error("the response was not valid JSON")]
    InvalidJson,
    #[error("the response fields did not match the requested format")]
    InvalidFields,
    #[error("the response did not match the selected expression or its sources")]
    InvalidSource,
}

impl OutputFailureReason {
    pub fn code(self) -> &'static str {
        match self {
            Self::OutputLimit => "output_limit",
            Self::Blocked => "output_blocked",
            Self::Incomplete => "output_incomplete",
            Self::InvalidJson => "output_json",
            Self::InvalidFields => "output_fields",
            Self::InvalidSource => "output_source",
        }
    }

    pub fn from_code(code: &str) -> Option<Self> {
        match code {
            "output_limit" => Some(Self::OutputLimit),
            "output_blocked" => Some(Self::Blocked),
            "output_incomplete" => Some(Self::Incomplete),
            "output_json" => Some(Self::InvalidJson),
            "output_fields" => Some(Self::InvalidFields),
            "output_source" => Some(Self::InvalidSource),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VocabularyItem {
    pub term: String,
    pub meaning: String,
    pub explanation: String,
    pub example: String,
    #[serde(rename = "sourceCueIds")]
    pub source_cue_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeneratedCue {
    #[serde(rename = "startMs")]
    pub start_ms: u64,
    #[serde(rename = "endMs")]
    pub end_ms: u64,
    pub text: String,
    #[serde(
        rename = "timingPrecision",
        default = "cue_precision",
        skip_serializing_if = "is_cue_precision"
    )]
    pub timing_precision: String,
    #[serde(rename = "wordAnchors", default, skip_serializing_if = "Vec::is_empty")]
    pub word_anchors: Vec<WordAnchor>,
}

/// Original provider anchors, in source time and UTF-8 byte offsets into cue text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WordAnchor {
    pub start_ms: u64,
    pub end_ms: u64,
    pub text_start: usize,
    pub text_end: usize,
}

pub fn cue_precision() -> String {
    "cue".into()
}
pub fn is_cue_precision(value: &str) -> bool {
    value == "cue"
}

impl Default for GeneratedCue {
    fn default() -> Self {
        Self {
            start_ms: 0,
            end_ms: 0,
            text: String::new(),
            timing_precision: cue_precision(),
            word_anchors: vec![],
        }
    }
}

pub(crate) fn valid_timing_metadata(
    text: &str,
    start_ms: u64,
    end_ms: u64,
    precision: &str,
    words: &[WordAnchor],
) -> bool {
    if !["cue", "source_block"].contains(&precision)
        || precision == "source_block" && !words.is_empty()
    {
        return false;
    }
    let mut previous_byte = 0;
    let mut previous_start = start_ms;
    words.iter().all(|word| {
        let valid = word.text_start >= previous_byte
            && word.text_start < word.text_end
            && word.text_end <= text.len()
            && text.is_char_boundary(word.text_start)
            && text.is_char_boundary(word.text_end)
            && text
                .get(word.text_start..word.text_end)
                .is_some_and(|token| !token.is_empty() && token.trim() == token)
            && word.start_ms >= previous_start
            && word.start_ms <= word.end_ms
            && word.end_ms <= end_ms;
        previous_byte = word.text_end;
        previous_start = word.start_ms;
        valid
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CueTranslation {
    pub id: String,
    pub translation: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ParsedOutput {
    #[cfg(feature = "development-validation")]
    UntimedTranscript {
        text: String,
    },
    Vocabulary {
        items: Vec<VocabularyItem>,
    },
    Translation {
        translations: Vec<CueTranslation>,
    },
    Transcript {
        cues: Vec<GeneratedCue>,
    },
}

pub(crate) fn parse_output(task: &RequestTask, text: &str) -> Result<ParsedOutput> {
    if matches!(
        task,
        RequestTask::Explanation { .. }
            | RequestTask::Vocabulary { .. }
            | RequestTask::Translation { .. }
    ) {
        return parse_text_output(task, text)
            .map_err(|reason| AiError::Invalid(reason.to_string()));
    }
    let v: Value = serde_json::from_str(text)?;
    match task {
        #[cfg(feature = "development-validation")]
        RequestTask::TranscribeDiagnostic { .. } => Err(AiError::Invalid(
            "Untimed diagnostics require the structured transcription response".into(),
        )),
        RequestTask::Explanation { .. }
        | RequestTask::Vocabulary { .. }
        | RequestTask::Translation { .. } => unreachable!("text tasks were parsed above"),
        RequestTask::AudioTranscription { audio, .. }
        | RequestTask::TranscribePreview { audio, .. } => {
            let mut cues: Vec<GeneratedCue> = serde_json::from_value(
                v.get("cues")
                    .cloned()
                    .ok_or_else(|| AiError::Invalid("Missing subtitle cues".into()))?,
            )?;
            let mut previous_start = 0;
            for c in &mut cues {
                // General audio JSON cannot assert word-level provenance.
                c.timing_precision = cue_precision();
                c.word_anchors.clear();
                if c.start_ms >= c.end_ms
                    || c.end_ms > audio.duration_ms
                    || c.start_ms < previous_start
                    || c.text.trim().is_empty()
                {
                    return Err(AiError::Invalid(
                        "Generated subtitle timing is invalid; source review is required".into(),
                    ));
                }
                previous_start = c.start_ms;
                c.start_ms = audio
                    .source_start_ms
                    .checked_add(c.start_ms)
                    .ok_or_else(|| {
                        AiError::Invalid("Generated subtitle timestamp overflow".into())
                    })?;
                c.end_ms = audio.source_start_ms.checked_add(c.end_ms).ok_or_else(|| {
                    AiError::Invalid("Generated subtitle timestamp overflow".into())
                })?;
            }
            Ok(ParsedOutput::Transcript { cues })
        }
    }
}

/// Validation diagnostics remain separate from the post-settlement error used
/// by execution: a parser failure alone never authorizes another paid request.
pub(crate) fn parse_text_output(
    task: &RequestTask,
    text: &str,
) -> std::result::Result<ParsedOutput, OutputFailureReason> {
    use OutputFailureReason::{InvalidFields, InvalidJson, InvalidSource};
    let value: Value = serde_json::from_str(text).map_err(|_| InvalidJson)?;
    match task {
        RequestTask::Explanation { cues, .. } | RequestTask::Vocabulary { cues, .. } => {
            let (selected_term, max_items) = match task {
                RequestTask::Explanation { term, .. } => (Some(term), 1),
                RequestTask::Vocabulary { max_items, .. } => (None, *max_items),
                _ => unreachable!(),
            };
            let mut items: Vec<VocabularyItem> =
                serde_json::from_value(value.get("items").cloned().ok_or(InvalidFields)?)
                    .map_err(|_| InvalidFields)?;
            if items.len() > usize::from(max_items)
                || selected_term.is_some() && items.len() != 1
                || items.iter().any(|item| {
                    item.term.trim().is_empty()
                        || item.term.len() >= 4096
                        || [&item.meaning, &item.explanation, &item.example]
                            .iter()
                            .any(|field| field.trim().is_empty() || field.len() >= 64 * 1024)
                })
            {
                return Err(InvalidFields);
            }
            let ids: std::collections::HashSet<_> = cues.iter().map(|cue| &cue.id).collect();
            if items.iter().any(|item| {
                item.source_cue_ids.is_empty()
                    || item.source_cue_ids.iter().any(|id| !ids.contains(id))
                    || item
                        .source_cue_ids
                        .iter()
                        .collect::<std::collections::HashSet<_>>()
                        .len()
                        != item.source_cue_ids.len()
            }) {
                return Err(InvalidSource);
            }
            if let Some(term) = selected_term {
                if normalized_term(&items[0].term) != normalized_term(term) {
                    return Err(InvalidSource);
                }
                let cited: Vec<_> = cues
                    .iter()
                    .filter(|cue| items[0].source_cue_ids.contains(&cue.id))
                    .cloned()
                    .collect();
                if !contains_term(&cited, term) {
                    return Err(InvalidSource);
                }
                items[0].term = term.clone();
            }
            Ok(ParsedOutput::Vocabulary { items })
        }
        RequestTask::Translation { cues, .. } => {
            let translations: Vec<CueTranslation> =
                serde_json::from_value(value.get("translations").cloned().ok_or(InvalidFields)?)
                    .map_err(|_| InvalidFields)?;
            let expected: std::collections::HashSet<_> =
                cues.iter().map(|cue| cue.id.as_str()).collect();
            let returned: std::collections::HashSet<_> =
                translations.iter().map(|cue| cue.id.as_str()).collect();
            if translations.len() != cues.len() || expected != returned {
                return Err(InvalidSource);
            }
            if translations
                .iter()
                .any(|cue| cue.translation.trim().is_empty())
            {
                return Err(InvalidFields);
            }
            Ok(ParsedOutput::Translation { translations })
        }
        _ => Err(InvalidFields),
    }
}
