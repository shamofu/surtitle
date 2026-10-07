//! Validated provider output tied to the original source cues.
use super::{
    task::{contains_term, normalized_term},
    RequestTask,
};
use crate::{AiError, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

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
    let v: Value = serde_json::from_str(text)?;
    match task {
        #[cfg(feature = "development-validation")]
        RequestTask::TranscribeDiagnostic { .. } => Err(AiError::Invalid(
            "Untimed diagnostics require the structured transcription response".into(),
        )),
        RequestTask::Explanation {
            term,
            learning_language,
            explanation_language,
            cues,
            ..
        } => {
            let base = RequestTask::Vocabulary {
                learning_language: learning_language.clone(),
                explanation_language: explanation_language.clone(),
                cues: cues.clone(),
                max_items: 1,
            };
            let ParsedOutput::Vocabulary { mut items } = parse_output(&base, text)? else {
                unreachable!()
            };
            if items.len() != 1 || normalized_term(&items[0].term) != normalized_term(term) {
                return Err(AiError::Invalid(
                    "Explanation changed the selected term or item count".into(),
                ));
            }
            let cited: Vec<_> = cues
                .iter()
                .filter(|c| items[0].source_cue_ids.contains(&c.id))
                .cloned()
                .collect();
            if !contains_term(&cited, term) {
                return Err(AiError::Invalid(
                    "Explanation citation does not contain the selected term".into(),
                ));
            }
            items[0].term = term.clone();
            Ok(ParsedOutput::Vocabulary { items })
        }
        RequestTask::Vocabulary {
            cues, max_items, ..
        } => {
            let items: Vec<VocabularyItem> = serde_json::from_value(
                v.get("items")
                    .cloned()
                    .ok_or_else(|| AiError::Invalid("Missing vocabulary items".into()))?,
            )?;
            let ids: std::collections::HashSet<_> = cues.iter().map(|c| &c.id).collect();
            if items.len() > *max_items as usize
                || items.iter().any(|i| {
                    i.term.trim().is_empty()
                        || i.term.len() >= 4096
                        || i.meaning.trim().is_empty()
                        || i.meaning.len() >= 64 * 1024
                        || i.explanation.trim().is_empty()
                        || i.explanation.len() >= 64 * 1024
                        || i.example.trim().is_empty()
                        || i.example.len() >= 64 * 1024
                        || i.source_cue_ids.is_empty()
                        || i.source_cue_ids.iter().any(|id| !ids.contains(id))
                        || i.source_cue_ids
                            .iter()
                            .collect::<std::collections::HashSet<_>>()
                            .len()
                            != i.source_cue_ids.len()
                })
            {
                return Err(AiError::Invalid(
                    "Generated vocabulary has invalid fields, source references, or item count"
                        .into(),
                ));
            }
            Ok(ParsedOutput::Vocabulary { items })
        }
        RequestTask::Translation { cues, .. } => {
            let translations: Vec<CueTranslation> = serde_json::from_value(
                v.get("translations")
                    .cloned()
                    .ok_or_else(|| AiError::Invalid("Missing translations".into()))?,
            )?;
            let expected: std::collections::HashSet<_> =
                cues.iter().map(|c| c.id.as_str()).collect();
            let returned: std::collections::HashSet<_> =
                translations.iter().map(|c| c.id.as_str()).collect();
            if translations.len() != cues.len()
                || expected != returned
                || translations.iter().any(|c| c.translation.trim().is_empty())
            {
                return Err(AiError::Invalid(
                    "Translation must preserve every source ID exactly once".into(),
                ));
            }
            Ok(ParsedOutput::Translation { translations })
        }
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
