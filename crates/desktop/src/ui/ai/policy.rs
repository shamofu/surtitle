// SPDX-License-Identifier: GPL-3.0-or-later
//! Typed form parsing and explicit approval checks. No execution authority lives here.
use serde::{Deserialize, Serialize};
use surtitle_ai::{ManualTranscriptContent, ReviewText};
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RawRow {
    pub start: String,
    pub end: String,
    pub text: String,
}
pub(super) fn rebind_request_source(
    value: &mut crate::application::continuations::AiContinuation,
    media: &surtitle_core::Media,
    cues: &[surtitle_core::SubtitleSegment],
) -> Result<(u64, u64), String> {
    if media.id != value.media_id
        || cues.is_empty()
        || cues.len() > 1000
        || cues.iter().any(|cue| {
            cue.media_id != value.media_id
                || cue.end_ms <= cue.start_ms
                || !surtitle_core::model::is_usable_subtitle_status(&cue.status)
        })
    {
        return Err("Select usable source subtitles from the original media".into());
    }
    let start = cues.iter().map(|cue| cue.start_ms).min().unwrap();
    let end = cues.iter().map(|cue| cue.end_ms).max().unwrap();
    value.source_cue_ids = cues.iter().map(|cue| cue.id.clone()).collect();
    value.source_revision = Some(serde_json::to_string(cues).map_err(|error| error.to_string())?);
    value.source_media_signature = Some(
        serde_json::to_string(&(
            &media.path,
            media.audio_stream_index,
            &media.learning_language,
            &media.explanation_language,
        ))
        .map_err(|error| error.to_string())?,
    );
    value.start = timestamp(start);
    value.end = timestamp(end);
    value.whole_media = false;
    value.quote_id = None;
    value.preparation_id = None;
    Ok((start, end))
}
/// Copy only unambiguous transcript text, never provider timings or reasoning.
pub(super) fn original_transcript_text(response: &serde_json::Value) -> Option<String> {
    let candidates = response.get("candidates")?.as_array()?;
    if candidates.len() != 1 {
        return None;
    }
    let parts = candidates[0].get("content")?.get("parts")?.as_array()?;
    let text = parts
        .iter()
        .filter(|part| part.get("thought").and_then(|value| value.as_bool()) != Some(true))
        .filter_map(|part| {
            let transcript = part.get("audioTranscription")?.as_object()?;
            transcript
                .get("text")
                .and_then(|value| value.as_str())
                .or_else(|| part.get("text").and_then(|value| value.as_str()))
        })
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    (!text.trim().is_empty() && text.len() <= 16000).then_some(text)
}
pub(super) fn timestamp(ms: u64) -> String {
    format!(
        "{:02}:{:02}:{:02}.{:03}",
        ms / 3600000,
        ms / 60000 % 60,
        ms / 1000 % 60,
        ms % 1000
    )
}
pub(super) fn parse_time(raw: &str) -> Option<u64> {
    let raw = raw.trim();
    if raw.is_empty() || raw.ends_with('.') {
        return None;
    }
    let (whole, fraction) = raw.split_once('.').unwrap_or((raw, ""));
    if fraction.len() > 3 || !fraction.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let parts: Vec<_> = whole.split(':').collect();
    if !(1..=3).contains(&parts.len()) {
        return None;
    }
    let mut seconds = 0u64;
    for (i, part) in parts.iter().enumerate() {
        if part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        let n = part.parse::<u64>().ok()?;
        if i > 0 && n >= 60 {
            return None;
        }
        seconds = seconds.checked_mul(60)?.checked_add(n)?;
    }
    seconds
        .checked_mul(1000)?
        .checked_add(if fraction.is_empty() {
            0
        } else {
            fraction.parse::<u64>().ok()? * 10u64.pow(3 - fraction.len() as u32)
        })
}
pub(super) fn rows(segments: &[ReviewText]) -> Vec<RawRow> {
    segments
        .iter()
        .map(|s| RawRow {
            start: timestamp(s.start_ms),
            end: timestamp(s.end_ms),
            text: s.text.clone(),
        })
        .collect()
}
pub(super) fn source_matches(
    stored: Option<&str>,
    ids: &[String],
    current: &[surtitle_core::SubtitleSegment],
) -> bool {
    if ids.is_empty() {
        return true;
    }
    let Some(stored) = stored else {
        return false;
    };
    let Ok(previous) = serde_json::from_str::<Vec<surtitle_core::SubtitleSegment>>(stored) else {
        return false;
    };
    let selected: Option<Vec<_>> = ids
        .iter()
        .map(|id| current.iter().find(|cue| &cue.id == id))
        .collect();
    selected.is_some_and(|selected| {
        serde_json::to_value(previous).ok() == serde_json::to_value(selected).ok()
    })
}
pub(super) fn manual(
    rows: &[RawRow],
    start: u64,
    end: u64,
    silence: bool,
) -> Result<ManualTranscriptContent, String> {
    if rows.is_empty() {
        return if silence {
            Ok(ManualTranscriptContent::ConfirmedNoSpeech)
        } else {
            Err("Confirm no speech explicitly, or add subtitle rows".into())
        };
    }
    if rows.len() > 200 {
        return Err("At most 200 subtitle rows can be edited at once".into());
    }
    let mut segments: Vec<ReviewText> = vec![];
    for row in rows {
        let a = parse_time(&row.start).ok_or("Enter a complete start timestamp")?;
        let b = parse_time(&row.end).ok_or("Enter a complete end timestamp")?;
        if a < start
            || b > end
            || a >= b
            || row.text.trim().is_empty()
            || row.text.len() > 16000
            || segments.last().is_some_and(|last| a < last.start_ms)
        {
            return Err("Use ordered, nonempty subtitles inside the displayed audio range".into());
        }
        segments.push(ReviewText {
            start_ms: a,
            end_ms: b,
            text: row.text.trim().into(),
            timing_precision: "cue".into(),
            word_anchors: vec![],
        });
    }
    Ok(ManualTranscriptContent::Subtitles { segments })
}
pub(super) fn approval_error(
    quote: &crate::application::ai::AiQuote,
    provider: surtitle_core::AiProvider,
    generation: u64,
    now: i64,
) -> Option<String> {
    if !quote.is_retry
        && (quote.provider != provider || quote.ai_configuration_generation != generation)
    {
        return Some("AI settings changed. Prepare a new estimate".into());
    }
    if chrono::DateTime::parse_from_rfc3339(&quote.expires_at)
        .map_or(true, |expiry| expiry.timestamp_millis() <= now)
    {
        return Some("This estimate expired. Refresh it before approving".into());
    }
    if !quote.can_approve {
        return Some(
            quote
                .blocked_reason
                .clone()
                .unwrap_or_else(|| "This estimate cannot be approved".into()),
        );
    }
    if quote.digest.is_empty() {
        return Some("This estimate has no approval digest".into());
    }
    None
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn incomplete_timestamp_remains_raw_instead_of_becoming_zero() {
        assert_eq!(parse_time("00:"), None);
        assert_eq!(parse_time("1."), None);
        assert_eq!(parse_time("00:01.025"), Some(1025));
        assert_eq!(parse_time("00:60"), None);
    }
    #[test]
    fn silence_requires_explicit_confirmation_and_manual_times_never_create_word_anchors() {
        assert!(manual(&[], 0, 1000, false).is_err());
        assert!(matches!(
            manual(&[], 0, 1000, true).unwrap(),
            ManualTranscriptContent::ConfirmedNoSpeech
        ));
        let input = vec![RawRow {
            start: "0".into(),
            end: "1".into(),
            text: " raw ".into(),
        }];
        let ManualTranscriptContent::Subtitles { segments } =
            manual(&input, 0, 1000, false).unwrap()
        else {
            panic!()
        };
        assert_eq!(segments[0].text, "raw");
        assert!(segments[0].word_anchors.is_empty());
        assert_eq!(segments[0].timing_precision, "cue");
    }
    #[test]
    fn manual_rows_cannot_escape_the_bound_range_or_reorder_source_times() {
        let input = vec![RawRow {
            start: "1".into(),
            end: "3".into(),
            text: "x".into(),
        }];
        assert!(manual(&input, 0, 2000, false).is_err());
        let input = vec![
            RawRow {
                start: "1".into(),
                end: "2".into(),
                text: "x".into(),
            },
            RawRow {
                start: "0".into(),
                end: "1".into(),
                text: "y".into(),
            },
        ];
        assert!(manual(&input, 0, 2000, false).is_err());
    }
}

#[cfg(test)]
mod approval_tests {
    use super::*;
    fn quote() -> crate::application::ai::AiQuote {
        crate::application::ai::AiQuote {
            ai_configuration_generation: 3,
            provider: surtitle_core::AiProvider::Vertex,
            id: "quote".into(),
            media_id: "media".into(),
            kind: "translate".into(),
            start_ms: 0,
            end_ms: 1000,
            model: "model".into(),
            estimated_usd: Some(0.01),
            maximum_usd: Some(0.02),
            input_tokens: 10,
            max_output_tokens: 100,
            expires_at: "2030-01-01T00:00:00Z".into(),
            warnings: vec![],
            can_approve: true,
            blocked_reason: None,
            is_retry: false,
            focus_term: None,
            digest: "bound-digest".into(),
            request_count: 1,
            send_duration_ms: 0,
            total_output_tokens: 100,
            retry_policy: Some(surtitle_ai::RetryPolicy {
                version: 1,
                max_retries: 2,
            }),
            maximum_request_count: 3,
            maximum_send_duration_ms: 0,
            maximum_total_output_tokens: 300,
            pricing_source: None,
            unpriced: false,
            location: "global".into(),
            apply_policy: surtitle_ai::TranscriptApplyPolicy::Manual,
        }
    }
    #[test]
    fn approval_requires_the_current_provider_generation_unexpired_digest_and_native_permission() {
        let mut q = quote();
        assert!(approval_error(&q, surtitle_core::AiProvider::Vertex, 3, 0).is_none());
        assert!(approval_error(&q, surtitle_core::AiProvider::Openai, 3, 0).is_some());
        assert!(approval_error(&q, surtitle_core::AiProvider::Vertex, 4, 0).is_some());
        assert!(
            approval_error(
                &q,
                surtitle_core::AiProvider::Vertex,
                3,
                chrono::DateTime::parse_from_rfc3339(&q.expires_at)
                    .unwrap()
                    .timestamp_millis()
            )
            .is_some()
        );
        q.digest.clear();
        assert!(approval_error(&q, surtitle_core::AiProvider::Vertex, 3, 0).is_some());
        q.digest = "new".into();
        q.can_approve = false;
        q.blocked_reason = Some("unknown receipt".into());
        assert_eq!(
            approval_error(&q, surtitle_core::AiProvider::Vertex, 3, 0).as_deref(),
            Some("unknown receipt")
        );
    }
    #[test]
    fn a_retry_keeps_its_original_provider_plan_after_active_settings_change() {
        let mut quote = quote();
        quote.is_retry = true;
        assert!(approval_error(&quote, surtitle_core::AiProvider::Openai, 99, 0).is_none());
        quote.can_approve = false;
        quote.blocked_reason = Some("unknown attempts need accounting".into());
        assert_eq!(
            approval_error(&quote, surtitle_core::AiProvider::Openai, 99, 0).as_deref(),
            Some("unknown attempts need accounting")
        );
    }
}

#[cfg(test)]
mod original_text_tests {
    use super::*;
    #[test]
    fn safe_copy_accepts_only_one_structured_transcript_and_excludes_reasoning_and_timings() {
        let response = serde_json::json!({"candidates":[{"content":{"parts":[
            {"thought":true,"audioTranscription":{"text":"private reasoning"}},
            {"text":"unstructured output"},
            {"audioTranscription":{"text":"First sentence","start":-9,"end":999999}},
            {"audioTranscription":{},"text":"Second sentence"}
        ]}}]});
        assert_eq!(
            original_transcript_text(&response).as_deref(),
            Some("First sentence\nSecond sentence")
        );
        let mut ambiguous = response.clone();
        ambiguous["candidates"]
            .as_array_mut()
            .unwrap()
            .push(response["candidates"][0].clone());
        assert!(original_transcript_text(&ambiguous).is_none());
        assert!(
            original_transcript_text(&serde_json::json!({"text":"not a transcript"})).is_none()
        );
        let huge = serde_json::json!({"candidates":[{"content":{"parts":[{"audioTranscription":{"text":"あ".repeat(6000)}}]}}]});
        assert!(original_transcript_text(&huge).is_none());
    }
}

#[cfg(test)]
mod source_rebind_tests {
    use super::*;
    #[test]
    fn explicit_source_reselection_keeps_request_identity_focus_and_incomplete_model_input_but_revokes_quote()
     {
        let mut value:crate::application::continuations::AiContinuation=serde_json::from_value(serde_json::json!({
            "id":"same-request","mediaId":"media","kind":"vocabulary","start":"00:","end":"1.","wholeMedia":true,
            "focusTerm":"focus unchanged","preparationId":"old-audio","quoteId":"old-quote",
            "modelInputs":{"vertex:vocabulary":{"enabled":"true","inputPrice":"1.","thinkingBudget":"-"}}
        })).unwrap();
        let media:surtitle_core::Media=serde_json::from_value(serde_json::json!({
            "id":"media","title":"fixture","path":"C:/current.mp4","kind":"video","durationMs":5000,
            "learningLanguage":"en","explanationLanguage":"ja","createdAt":"","lastPositionMs":0,
            "audioStreamIndex":2,"subtitleStreamIndex":null,"segmentCount":1,"cardCount":0,"status":"ready","error":null
        })).unwrap();
        let cue = surtitle_core::SubtitleSegment {
            id: "cue".into(),
            media_id: "media".into(),
            start_ms: 1500,
            end_ms: 2700,
            text: "Current exact source".into(),
            translation: None,
            status: "confirmed".into(),
            timing_precision: "cue".into(),
            review_issues: vec![],
        };
        let raw = value.model_inputs.clone();
        assert_eq!(
            rebind_request_source(&mut value, &media, std::slice::from_ref(&cue)).unwrap(),
            (1500, 2700)
        );
        assert_eq!(value.id, "same-request");
        assert_eq!(value.focus_term, "focus unchanged");
        assert_eq!(value.model_inputs, raw);
        assert!(value.quote_id.is_none() && value.preparation_id.is_none() && !value.whole_media);
        assert_eq!(
            serde_json::from_str::<Vec<surtitle_core::SubtitleSegment>>(
                value.source_revision.as_deref().unwrap()
            )
            .unwrap()[0]
                .text,
            cue.text
        );
        assert_eq!(
            value.source_media_signature.as_deref(),
            Some("[\"C:/current.mp4\",2,\"en\",\"ja\"]")
        );
        let saved = serde_json::to_value(&value).unwrap();
        let mut foreign = cue.clone();
        foreign.media_id = "other".into();
        assert!(rebind_request_source(&mut value, &media, &[foreign]).is_err());
        assert_eq!(serde_json::to_value(&value).unwrap(), saved);
    }
}
