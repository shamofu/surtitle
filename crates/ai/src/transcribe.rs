//! Vertex Transcribe wire adapter. Compatibility does not imply model quality.
//! Explicit ledger approval is required. Word timestamps are used only
//! to anchor subtitle groups; transport pauses never claim sentence completeness.
use crate::{AiError, AudioAttachment, GeneratedCue, ParsedOutput, Result};

/// Untimed evaluation output is deliberately not a source of adoptable cues.
#[cfg(feature = "development-validation")]
pub(crate) fn parse_untimed_transcribe_parts(parts: &[serde_json::Value]) -> Result<ParsedOutput> {
    let mut text = String::new();
    let mut found = false;
    for part in parts {
        if part.get("thought").and_then(serde_json::Value::as_bool) == Some(true) {
            continue;
        }
        let Some(tx) = part.get("audioTranscription") else {
            continue;
        };
        if !tx.is_object() {
            return Err(invalid("diagnostic transcription must be an object"));
        }
        if tx
            .get("finished")
            .is_some_and(|finished| finished.as_bool() != Some(true))
        {
            return Err(invalid("unfinished diagnostic transcription"));
        }
        let content = tx
            .get("text")
            .and_then(serde_json::Value::as_str)
            .or_else(|| part.get("text").and_then(serde_json::Value::as_str))
            .ok_or_else(|| invalid("diagnostic transcription text is absent"))?;
        if !text.is_empty() && !content.is_empty() {
            text.push('\n');
        }
        text.push_str(content);
        if text.len() > 1024 * 1024 {
            return Err(invalid("diagnostic transcript is excessive"));
        }
        found = true;
    }
    if !found {
        return Err(invalid("structured diagnostic transcription is absent"));
    }
    Ok(ParsedOutput::UntimedTranscript { text })
}

#[cfg(all(test, feature = "development-validation"))]
mod diagnostic_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn untimed_diagnostic_keeps_text_and_can_never_supply_cues() {
        let task = crate::RequestTask::TranscribeDiagnostic {
            language: "ja-JP".into(),
            audio: AudioAttachment {
                path: "unused.wav".into(),
                sha256: crate::sha256_bytes(b"a"),
                byte_len: 4,
                mime_type: "audio/wav".into(),
                source_start_ms: 5000,
                duration_ms: 30000,
            },
        };
        let body = task.body(Some(b"a")).unwrap();
        assert_eq!(
            body["generationConfig"]["audioTranscriptionConfig"]["wordTimestamp"],
            false
        );
        assert_eq!(
            body["generationConfig"]["audioTranscriptionConfig"]["mode"],
            "VERBATIM"
        );
        let raw = json!({"candidates":[{"finishReason":"STOP","content":{"parts":[{"thought":true,"audioTranscription":{"text":"private thought"}},{"audioTranscription":{"text":"ええ、ええ。","words":[{"startOffset":"4s","endOffset":"1s"}]}},{"text":"duplicated plain text"}]}}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":3,"totalTokenCount":13}});
        assert!(
            matches!(crate::vertex::parse_response(&task, &raw).unwrap(), ParsedOutput::UntimedTranscript { text } if text == "ええ、ええ。")
        );
        assert!(crate::models::parse_output(&task, "{\"cues\":[]}").is_err());
        let mut bad = raw.clone();
        bad["candidates"][0]["finishReason"] = "MAX_TOKENS".into();
        assert!(crate::vertex::parse_response(&task, &bad).is_err());
        let mut empty = json!({"candidates":[{"finishReason":"STOP","content":{"role":"model"}}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":0,"totalTokenCount":10}});
        assert!(
            matches!(crate::vertex::parse_response(&task, &empty).unwrap(), ParsedOutput::UntimedTranscript { text } if text.is_empty())
        );
        empty["usageMetadata"]["candidatesTokenCount"] = 1.into();
        empty["usageMetadata"]["totalTokenCount"] = 11.into();
        assert!(crate::vertex::parse_response(&task, &empty).is_err());
    }

    #[test]
    fn untimed_diagnostic_rejects_nonobjects_and_malformed_completion_markers() {
        for transcription in [
            json!(null),
            json!(false),
            json!(12),
            json!("text"),
            json!([]),
        ] {
            assert!(parse_untimed_transcribe_parts(&[json!({"audioTranscription":transcription,"text":"A plain-text fallback cannot validate a malformed structure."})]).is_err());
        }
        for finished in [
            json!(null),
            json!(false),
            json!(1),
            json!("true"),
            json!({}),
        ] {
            assert!(parse_untimed_transcribe_parts(&[
                json!({"audioTranscription":{"text":"Hello.","finished":finished}})
            ])
            .is_err());
        }
        for transcription in [
            json!({"text":"Hello."}),
            json!({"text":"Hello.","finished":true}),
        ] {
            assert!(
                matches!(parse_untimed_transcribe_parts(&[json!({"audioTranscription":transcription})]).unwrap(), ParsedOutput::UntimedTranscript { text } if text == "Hello.")
            );
        }
    }
}
use serde_json::Value;

pub(crate) fn parse_transcribe_parts(
    audio: &AudioAttachment,
    parts: &[Value],
) -> Result<ParsedOutput> {
    let mut cues = Vec::new();
    let mut previous_ns = 0;
    let mut saw_transcription = false;
    for part in parts {
        if part.get("thought").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        let Some(tx) = part.get("audioTranscription") else {
            // Plain text is commonly duplicated alongside structured transcription.
            // It is not itself accepted as timed subtitles.
            continue;
        };
        saw_transcription = true;
        if tx.get("finished").and_then(Value::as_bool) == Some(false) {
            return Err(invalid("unfinished transcription"));
        }
        let text = tx
            .get("text")
            .and_then(Value::as_str)
            .or_else(|| part.get("text").and_then(Value::as_str))
            .unwrap_or("");
        let words = tx
            .get("words")
            .and_then(Value::as_array)
            .ok_or_else(|| invalid("word timing is absent"))?;
        if words.is_empty() {
            if !text.trim().is_empty() {
                return Err(invalid("text without timed words"));
            }
            continue;
        }
        if text.trim().is_empty() || words.len() > 20_000 {
            return Err(invalid("missing transcript or excessive words"));
        }
        let mut anchors = Vec::with_capacity(words.len());
        let mut cursor = 0;
        for word in words {
            let token = word
                .get("word")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| invalid("empty word"))?;
            let start = duration_ms(word.get("startOffset"), false)?;
            let end = duration_ms(word.get("endOffset"), true)?;
            let start_ns = duration_ns(word.get("startOffset"))?;
            let end_ns = duration_ns(word.get("endOffset"))?;
            if start_ns > end_ns || start_ns < previous_ns || end > audio.duration_ms {
                return Err(invalid("word time outside source or out of order"));
            }
            previous_ns = start_ns;
            // Anchor against original provider text to preserve spaces, punctuation,
            // CJK text and natural repetitions. An unaligned word requires review.
            let token = token.trim();
            let found = text[cursor..]
                .find(token)
                .map(|p| p + cursor)
                .ok_or_else(|| invalid("word/text alignment differs"))?;
            if !only_separators(&text[cursor..found]) {
                return Err(invalid("transcript contains unanchored speech"));
            }
            let end_byte = found + token.len();
            anchors.push((start, end, found, end_byte));
            cursor = end_byte;
        }
        if !only_separators(&text[cursor..]) {
            return Err(invalid("trailing speech has no timestamp"));
        }
        let mut group_start = 0;
        let mut groups: Vec<(usize, usize)> = Vec::new();
        for i in 0..anchors.len() {
            let next_byte = anchors.get(i + 1).map(|a| a.2).unwrap_or(text.len());
            let punctuation = &text[anchors[i].2..next_byte];
            let sentence_end = punctuation
                .chars()
                .any(|c| matches!(c, '.' | '?' | '!' | '。' | '？' | '！' | '।'));
            let pause = anchors
                .get(i + 1)
                .is_some_and(|next| next.0.saturating_sub(anchors[i].1) >= 800);
            // Local readability fallback preserves all words and timestamps even for
            // punctuation-free speech; 12s groups are cues, not sentence assertions.
            let bounded = anchors[i].1.saturating_sub(anchors[group_start].0) >= 12_000;
            if sentence_end || pause || bounded || i + 1 == anchors.len() {
                let group_end = anchors[group_start..=i]
                    .iter()
                    .map(|anchor| anchor.1)
                    .max()
                    .unwrap();
                // Providers may quantize short words to point timestamps. Keep
                // those exact anchors; wait for an observed positive span rather
                // than inventing an end time or dropping the word.
                if group_end == anchors[group_start].0 {
                    continue;
                }
                groups.push((group_start, i));
                group_start = i + 1;
            }
        }
        if group_start < anchors.len() {
            let Some(last) = groups.last_mut() else {
                return Err(invalid("transcript has no positive-width subtitle span"));
            };
            // A trailing point-only fragment stays with the preceding subtitle.
            // The text still comes from one exact slice of the original response.
            last.1 = anchors.len() - 1;
        }
        for (group_start, i) in groups {
            let next_byte = anchors.get(i + 1).map(|a| a.2).unwrap_or(text.len());
            let group_end = anchors[group_start..=i]
                .iter()
                .map(|anchor| anchor.1)
                .max()
                .unwrap();
            if group_end <= anchors[group_start].0 {
                return Err(invalid("subtitle group has no positive span"));
            }
            let start_byte = if group_start == 0 {
                0
            } else {
                anchors[group_start].2
            };
            let cue_text = text[start_byte..next_byte].trim().to_owned();
            if cue_text.is_empty() {
                return Err(invalid("empty subtitle group"));
            }
            cues.push(GeneratedCue {
                start_ms: audio
                    .source_start_ms
                    .checked_add(anchors[group_start].0)
                    .ok_or_else(|| invalid("timestamp overflow"))?,
                end_ms: audio
                    .source_start_ms
                    .checked_add(group_end)
                    .ok_or_else(|| invalid("timestamp overflow"))?,
                text: cue_text,
            });
        }
    }
    if !saw_transcription {
        return Err(invalid("structured audioTranscription is absent"));
    }
    Ok(ParsedOutput::Transcript { cues })
}

/// Development-only reinterpretation of already saved provider evidence. It
/// cannot execute a request, authorize spending, or alter a saved ledger result.
#[cfg(feature = "development-validation")]
pub fn reparse_validation_transcribe_evidence(
    audio: &AudioAttachment,
    evidence: &Value,
) -> Result<ParsedOutput> {
    if evidence["evidenceTruncated"] != false {
        return Err(invalid("saved evidence is missing or truncated"));
    }
    let diagnostics = evidence["candidateDiagnostics"]
        .as_array()
        .ok_or_else(|| invalid("saved finish reason is missing"))?;
    if diagnostics.len() != 1 || diagnostics[0]["finishReason"] != "STOP" {
        return Err(invalid("saved response did not finish normally"));
    }
    let transcriptions = evidence["audioTranscriptions"]
        .as_array()
        .ok_or_else(|| invalid("saved transcription is missing"))?;
    if transcriptions.is_empty() || serde_json::to_vec(transcriptions)?.len() > 1024 * 1024 {
        return Err(invalid(
            "saved transcription evidence is absent or excessive",
        ));
    }
    let parts = transcriptions
        .iter()
        .map(|transcription| serde_json::json!({"audioTranscription":transcription}))
        .collect::<Vec<_>>();
    parse_transcribe_parts(audio, &parts)
}

fn invalid(reason: &str) -> AiError {
    AiError::Invalid(format!("Transcribe output requires review: {reason}"))
}
fn only_separators(s: &str) -> bool {
    s.chars().all(|c| {
        c.is_whitespace()
            || c.is_ascii_punctuation()
            || "。！？、，；：…・「」『』（）【】—–“”‘’¿¡".contains(c)
    })
}

/// Protobuf Duration JSON uses a decimal seconds string. Parse integers instead of
/// f64 so hours-long media offsets do not accumulate rounding drift.
fn duration_ms(value: Option<&Value>, ceil: bool) -> Result<u64> {
    let nanos = duration_ns(value)?;
    let millis = if ceil {
        nanos.div_ceil(1_000_000)
    } else {
        nanos / 1_000_000
    };
    u64::try_from(millis).map_err(|_| invalid("duration overflow"))
}

fn duration_ns(value: Option<&Value>) -> Result<u128> {
    let s = value
        .and_then(Value::as_str)
        .and_then(|s| s.strip_suffix('s'))
        .ok_or_else(|| invalid("invalid protobuf duration"))?;
    let (whole, fraction) = s.split_once('.').unwrap_or((s, ""));
    if whole.is_empty()
        || !whole.bytes().all(|b| b.is_ascii_digit())
        || fraction.len() > 9
        || !fraction.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(invalid("invalid duration precision"));
    }
    let seconds = whole
        .parse::<u64>()
        .map_err(|_| invalid("duration overflow"))?;
    let mut fraction_ns = 0_u64;
    if !fraction.is_empty() {
        fraction_ns = fraction
            .parse::<u64>()
            .map_err(|_| invalid("invalid fraction"))?
            * 10_u64.pow(9 - fraction.len() as u32);
    }
    Ok(u128::from(seconds) * 1_000_000_000 + u128::from(fraction_ns))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn attachment() -> AudioAttachment {
        AudioAttachment {
            path: "unused.flac".into(),
            sha256: crate::sha256_bytes(b"fixture"),
            byte_len: 7,
            mime_type: "audio/flac".into(),
            source_start_ms: 7_200_000,
            duration_ms: 3000,
        }
    }
    #[test]
    fn verbatim_request_has_timestamps_and_no_smart_cleanup() {
        let task = crate::RequestTask::TranscribePreview {
            language: "en-US".into(),
            audio: attachment(),
        };
        let body = task.body(Some(b"fixture")).unwrap();
        assert_eq!(
            body["generationConfig"]["audioTranscriptionConfig"]["mode"],
            "VERBATIM"
        );
        assert_eq!(
            body["generationConfig"]["audioTranscriptionConfig"]["wordTimestamp"],
            true
        );
        assert!(body["generationConfig"].get("responseSchema").is_none());
    }
    #[test]
    fn repeated_words_and_global_offsets_survive_fixture() {
        let parts = vec![
            json!({"audioTranscription":{"text":"No, no. Yes!","words":[{"word":"No","startOffset":"0.100s","endOffset":"0.400s"},{"word":"no","startOffset":"0.450s","endOffset":"0.800s"},{"word":"Yes","startOffset":"1.200s","endOffset":"1.500s"}]}}),
        ];
        let ParsedOutput::Transcript { cues } =
            parse_transcribe_parts(&attachment(), &parts).unwrap()
        else {
            panic!()
        };
        assert_eq!(cues.len(), 2);
        assert_eq!(cues[0].text, "No, no.");
        assert_eq!(cues[0].start_ms, 7_200_100);
        assert_eq!(cues[1].end_ms, 7_201_500);
    }
    #[test]
    fn japanese_spacing_is_not_invented() {
        let parts = vec![
            json!({"audioTranscription":{"text":"そう。そうです。","words":[{"word":"そう","startOffset":"0s","endOffset":"0.4s"},{"word":"そう","startOffset":"0.5s","endOffset":"0.8s"},{"word":"です","startOffset":"0.8s","endOffset":"1s"}]}}),
        ];
        let ParsedOutput::Transcript { cues } =
            parse_transcribe_parts(&attachment(), &parts).unwrap()
        else {
            panic!()
        };
        assert_eq!(cues[0].text, "そう。");
        assert_eq!(cues[1].text, "そうです。");
    }
    #[test]
    fn quantized_point_words_are_preserved_inside_real_subtitle_spans() {
        let parts = vec![
            json!({"audioTranscription":{"text":"We are here. Yes.","words":[
                {"word":"We","startOffset":"0s","endOffset":"0.3s"},
                {"word":"are","startOffset":"0.3s","endOffset":"0.3s"},
                {"word":"here","startOffset":"0.3s","endOffset":"0.8s"},
                {"word":"Yes","startOffset":"0.8s","endOffset":"0.8s"}
            ]}}),
        ];
        let original = parts.clone();
        let ParsedOutput::Transcript { cues } =
            parse_transcribe_parts(&attachment(), &parts).unwrap()
        else {
            panic!()
        };
        assert_eq!(cues.len(), 1);
        assert_eq!(cues[0].text, "We are here. Yes.");
        assert_eq!(cues[0].start_ms, 7_200_000);
        assert_eq!(cues[0].end_ms, 7_200_800);
        assert_eq!(parts, original);
        let prefix = vec![
            json!({"audioTranscription":{"text":"Yes. We agree.","words":[
                {"word":"Yes","startOffset":"0s","endOffset":"0s"},
                {"word":"We","startOffset":"0.1s","endOffset":"0.3s"},
                {"word":"agree","startOffset":"0.4s","endOffset":"0.9s"}
            ]}}),
        ];
        let ParsedOutput::Transcript { cues } =
            parse_transcribe_parts(&attachment(), &prefix).unwrap()
        else {
            panic!()
        };
        assert_eq!(cues[0].text, "Yes. We agree.");
        assert_eq!(cues[0].end_ms, 7_200_900);
    }
    #[test]
    fn all_point_subtitles_reversed_submillisecond_times_and_unaligned_text_still_fail() {
        for tx in [
            json!({"text":"No, no.","words":[{"word":"No","startOffset":"1s","endOffset":"1s"},{"word":"no","startOffset":"1s","endOffset":"1s"}]}),
            json!({"text":"No.","words":[{"word":"No","startOffset":"0.1009s","endOffset":"0.1001s"}]}),
            json!({"text":"No no.","words":[{"word":"No","startOffset":"0.1009s","endOffset":"0.2s"},{"word":"no","startOffset":"0.1001s","endOffset":"0.3s"}]}),
            json!({"text":"No.","words":[{"word":"No","startOffset":"3.1s","endOffset":"3.1s"}]}),
            json!({"text":"No extra.","words":[{"word":"No","startOffset":"0s","endOffset":"0.5s"}]}),
        ] {
            assert!(
                parse_transcribe_parts(&attachment(), &[json!({"audioTranscription":tx})]).is_err()
            );
        }
    }
    #[test]
    fn missing_timing_or_unanchored_speech_is_review_required() {
        for tx in [
            json!({"text":"hello"}),
            json!({"text":"well hello","words":[{"word":"hello","startOffset":"0s","endOffset":"1s"}]}),
            json!({"text":"hello","words":[{"word":"hello","startOffset":"-1s","endOffset":"1s"}]}),
        ] {
            assert!(
                parse_transcribe_parts(&attachment(), &[json!({"audioTranscription":tx})]).is_err()
            );
        }
    }
    #[test]
    fn historical_reversed_japanese_and_fifteen_ms_overrun_are_never_repaired() {
        // Sanitized lexical fixtures retain the observed failure shapes without
        // redistributing evaluation recordings or provider responses.
        for tx in [
            json!({"text":"確認する。","words":[{"word":"確認","startOffset":"1.4s","endOffset":"1.2s"},{"word":"する","startOffset":"1.5s","endOffset":"1.8s"}]}),
            json!({"text":"End.","words":[{"word":"End","startOffset":"2.5s","endOffset":"3.015s"}]}),
        ] {
            let parts = vec![json!({"audioTranscription":tx})];
            let original = parts.clone();
            assert!(parse_transcribe_parts(&attachment(), &parts).is_err());
            assert_eq!(parts, original);
        }
    }
    #[test]
    fn duration_rounding_is_outward_and_integer() {
        assert_eq!(duration_ms(Some(&json!("0.000000001s")), false).unwrap(), 0);
        assert_eq!(duration_ms(Some(&json!("0.000000001s")), true).unwrap(), 1);
        assert_eq!(
            duration_ms(Some(&json!("3600.999999999s")), true).unwrap(),
            3_601_000
        );
        assert!(duration_ms(Some(&json!("NaNs")), false).is_err());
    }
}
