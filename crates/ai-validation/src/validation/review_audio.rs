//! Read-only local review of immutable validation artifacts. Never opens a vault,
//! ledger, or transport; source files and model responses remain untouched.
use super::*;
use surtitle_ai::{
    AudioChunk, BoundaryKind, ChunkResponse, ParsedOutput, TranscriptReviewInput,
    build_transcript_draft_from_input,
};

const MAX_REPORT_BYTES: u64 = 16 * 1024 * 1024;

pub(super) fn reparse(
    results_path: &Path,
    request_id: &str,
    attempt_id: &str,
    audio_path: &Path,
    output: &Path,
) -> Result<Value> {
    let original = read_bounded(results_path, MAX_REPORT_BYTES)?;
    let source: Value = serde_json::from_slice(&original).map_err(|_| "Invalid saved report")?;
    let matching: Vec<_> = source["requests"]
        .as_array()
        .ok_or("Missing saved requests")?
        .iter()
        .filter(|request| request["id"].as_str() == Some(request_id))
        .collect();
    if source["schemaVersion"] != 1
        || matching.len() != 1
        || matching[0]["taskKind"] != "transcribe_preview"
    {
        return Err("Select one saved Transcribe request".into());
    }
    let request = matching[0];
    let attempts: Vec<_> = request["attempts"]
        .as_array()
        .ok_or("Missing saved attempts")?
        .iter()
        .filter(|attempt| attempt["id"].as_str() == Some(attempt_id))
        .collect();
    if attempts.len() != 1 || attempts[0]["state"] != "settled" {
        return Err("Reparse requires one explicitly selected settled attempt".into());
    }
    let (bytes, duration) = read_wav(audio_path, 240)?;
    let audio = bind_measured_audio(audio_path.to_owned(), &bytes, duration)?;
    if request["sourceAudioSha256"].as_str() != Some(audio.sha256.as_str()) {
        return Err("The audio file differs from the saved request".into());
    }
    let parsed =
        surtitle_ai::reparse_validation_transcribe_evidence(&audio, &attempts[0]["evidence"])
            .map_err(ai_error)?;
    let mut derived = request.clone();
    derived["output"] =
        serde_json::to_value(&parsed).map_err(|_| "Cannot encode reparsed transcript")?;
    derived["outputProvenance"] = json!({"kind":"offline-transcribe-reparse","attemptId":attempt_id,"originalState":request["state"],"originalOutput":request["output"],"sourceReportSha256":sha256_bytes(&original),"parserContract":"point-word-anchors-positive-subtitle-spans-v1"});
    let artifact = json!({"schemaVersion":1,"reportKind":"surtitle-offline-transcribe-reparse","evidenceKind":source["evidenceKind"],"requests":[derived],
        "inputs":{"resultsSha256":sha256_bytes(&original),"audioSha256":audio.sha256},"networkRequests":0,"ledgerChanges":0,"modelQualified":false,
        "note":"Derived by reparsing saved evidence only. Original execution state, attempt usage and cost are unchanged; this output was not adopted or written back to the ledger."});
    let bytes =
        serde_json::to_vec_pretty(&artifact).map_err(|_| "Cannot encode reparse artifact")?;
    if bytes.len() as u64 > MAX_REPORT_BYTES {
        return Err("Reparse artifact exceeds 16 MiB".into());
    }
    write_new(output, &bytes)?;
    Ok(
        json!({"output":output,"requestId":request_id,"attemptId":attempt_id,"networkRequests":0,"ledgerChanges":0}),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReviewManifest {
    schema_version: u32,
    cases: Vec<ReviewCase>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReviewCase {
    id: String,
    media_id: String,
    source_sha256: String,
    source_revision: String,
    #[serde(default)]
    vad_model_sha256: Option<String>,
    chunks: Vec<ReviewPart>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReviewPart {
    ordinal: u32,
    core_start_ms: u64,
    core_end_ms: u64,
    request_start_ms: u64,
    request_end_ms: u64,
    request_id: String,
    audio_path: PathBuf,
    audio_sha256: String,
    #[serde(default)]
    no_speech_detected: bool,
}

pub(super) fn run(manifest_path: &Path, results_path: &Path, output: &Path) -> Result<Value> {
    let manifest_bytes = read_bounded(manifest_path, MAX_DOCUMENT_BYTES)?;
    let results_bytes = read_bounded(results_path, MAX_REPORT_BYTES)?;
    let manifest: ReviewManifest =
        serde_json::from_slice(&manifest_bytes).map_err(|_| "Invalid audio review manifest")?;
    let results: Value =
        serde_json::from_slice(&results_bytes).map_err(|_| "Invalid validation results JSON")?;
    let mut artifact = review(&manifest, &results)?;
    artifact["inputs"] = json!({"manifestSha256":sha256_bytes(&manifest_bytes),"resultsSha256":sha256_bytes(&results_bytes)});
    let encoded = serde_json::to_vec_pretty(&artifact).map_err(|_| "Cannot encode audio review")?;
    if encoded.len() as u64 > MAX_REPORT_BYTES {
        return Err("Audio review exceeds 16 MiB; use a smaller batch".into());
    }
    write_new(output, &encoded)?;
    Ok(
        json!({"output":output,"cases":manifest.cases.len(),"networkRequests":0,"ledgerChanges":0,"modelQualified":false}),
    )
}

fn valid_sha(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn review(manifest: &ReviewManifest, results: &Value) -> Result<Value> {
    let requests = results["requests"]
        .as_array()
        .ok_or("Results need requests")?;
    if manifest.schema_version != 1
        || results["schemaVersion"] != 1
        || manifest.cases.is_empty()
        || manifest.cases.len() > 120
        || requests.len() > 1000
    {
        return Err("Unsupported or oversized review input".into());
    }
    let mut by_id = BTreeMap::new();
    for request in requests {
        let id = request["id"].as_str().ok_or("Request ID is missing")?;
        if id.is_empty() || by_id.insert(id, request).is_some() {
            return Err("Duplicate or empty request ID".into());
        }
    }
    let mut seen_cases = std::collections::HashSet::new();
    let mut seen_requests = std::collections::HashSet::new();
    let mut total_audio_ms = 0u64;
    let mut reviews = Vec::new();
    for case in &manifest.cases {
        valid_case_id(&case.id)?;
        if !seen_cases.insert(&case.id)
            || !valid_sha(&case.source_sha256)
            || case.media_id.is_empty()
            || case.source_revision.is_empty()
            || case.chunks.is_empty()
            || case.chunks.len() > 120
            || case.chunks.iter().any(|part| part.no_speech_detected)
                && !case.vad_model_sha256.as_deref().is_some_and(valid_sha)
        {
            return Err("Invalid case identity, source or VAD evidence".into());
        }
        let mut chunks = Vec::new();
        let mut attachments = Vec::new();
        let mut responses = Vec::new();
        let mut input_evidence = Vec::new();
        let mut no_speech = Vec::new();
        for (ordinal, part) in case.chunks.iter().enumerate() {
            if part.ordinal as usize != ordinal
                || part.request_id.is_empty()
                || !seen_requests.insert(&part.request_id)
                || seen_requests.len() > 120
                || !valid_sha(&part.audio_sha256)
                || part.request_start_ms >= part.request_end_ms
                || part.request_end_ms > 21_600_000
                || part.core_start_ms >= part.core_end_ms
                || part.request_start_ms > part.core_start_ms
                || part.request_end_ms < part.core_end_ms
            {
                return Err("Invalid or duplicate chunk timeline or request identity".into());
            }
            let duration = part.request_end_ms - part.request_start_ms;
            total_audio_ms = total_audio_ms
                .checked_add(duration)
                .ok_or("Audio duration overflow")?;
            if duration > 240_000 || total_audio_ms > 5_400_000 {
                return Err("Review exceeds 240 seconds per chunk or 90 minutes total".into());
            }
            absolute(&part.audio_path)?;
            let (bytes, measured_duration) = read_wav(&part.audio_path, 240)?;
            if measured_duration != duration || sha256_bytes(&bytes) != part.audio_sha256 {
                return Err(
                    "Audio identity or measured duration differs from review manifest".into(),
                );
            }
            let mut audio = bind_measured_audio(part.audio_path.clone(), &bytes, duration)?;
            audio.source_start_ms = part.request_start_ms;
            attachments.push(audio);
            chunks.push(AudioChunk {
                index: part.ordinal,
                sample_rate: 1000,
                core_start_sample: part.core_start_ms,
                core_end_sample: part.core_end_ms,
                request_start_sample: part.request_start_ms,
                request_end_sample: part.request_end_ms,
                boundary: if ordinal + 1 == case.chunks.len() {
                    BoundaryKind::EndOfSelection
                } else {
                    BoundaryKind::Forced
                },
            });
            if part.no_speech_detected {
                no_speech.push(part.ordinal);
            }
            let request = by_id.get(part.request_id.as_str()).copied();
            if request.is_some_and(|request| {
                request["sourceAudioSha256"].as_str() != Some(part.audio_sha256.as_str())
            }) {
                return Err("Saved request audio hash differs from the selected chunk".into());
            }
            let (response, reason) = rebase(request, part.request_start_ms, duration);
            input_evidence.push(json!({"ordinal":part.ordinal,"requestId":part.request_id,"audioSha256":part.audio_sha256,
                "requestState":request.map(|request| &request["state"]),"originalOutput":request.map(|request| &request["output"]),
                "attemptIds":request.and_then(|request| request["attempts"].as_array()).map(|attempts| attempts.iter().filter_map(|attempt| attempt["id"].as_str()).collect::<Vec<_>>()),
                "rebasedOutput":response,"status":if response.is_some(){"received"}else{"pending"},"reason":reason}));
            if let Some(output) = response {
                responses.push(ChunkResponse {
                    ordinal: part.ordinal,
                    output,
                });
            }
        }
        let draft = build_transcript_draft_from_input(
            &TranscriptReviewInput {
                id: case.id.clone(),
                media_id: case.media_id.clone(),
                source_sha256: case.source_sha256.clone(),
                source_revision: case.source_revision.clone(),
                chunks,
                attachments,
                vad_no_speech_ordinals: no_speech,
                vad_pause_evidence: None,
            },
            &responses,
        )
        .map_err(ai_error)?;
        reviews.push(json!({"id":case.id,"draft":draft,"inputEvidence":input_evidence,"vadModelSha256":case.vad_model_sha256}));
    }
    Ok(
        json!({"schemaVersion":1,"reportKind":"surtitle-offline-audio-review","sourceEvidenceKind":results["evidenceKind"],"cases":reviews,
        "totalAudioMs":total_audio_ms,"networkRequests":0,"ledgerChanges":0,"modelQualified":false,
        "note":"Source cut offsets are declared by the supplied manifest; audio hashes and measured durations are verified. Raw saved outputs are retained, never replaced by inferred silence."}),
    )
}

fn rebase(
    request: Option<&Value>,
    offset: u64,
    duration: u64,
) -> (Option<ParsedOutput>, &'static str) {
    let Some(request) = request else {
        return (None, "request_not_found");
    };
    if request["state"] != "completed"
        || !request["attempts"]
            .as_array()
            .is_some_and(|attempts| attempts.iter().any(|attempt| attempt["state"] == "settled"))
    {
        return (None, "request_not_completed_and_settled");
    }
    if !matches!(
        request["taskKind"].as_str(),
        Some("audio_transcription" | "transcribe_preview")
    ) {
        return (None, "request_is_not_audio");
    }
    let Ok(ParsedOutput::Transcript { mut cues }) =
        serde_json::from_value::<ParsedOutput>(request["output"].clone())
    else {
        return (None, "valid_transcript_output_missing");
    };
    if cues.len() > 50_000 {
        return (None, "transcript_exceeds_review_limit");
    }
    let mut previous = 0;
    for cue in &mut cues {
        if cue.text.trim().is_empty()
            || cue.text.len() > 100_000
            || cue.start_ms < previous
            || cue.start_ms >= cue.end_ms
            || cue.end_ms > duration
        {
            return (None, "invalid_clip_relative_transcript");
        }
        previous = cue.start_ms;
        let Some(start) = offset.checked_add(cue.start_ms) else {
            return (None, "timestamp_overflow");
        };
        let Some(end) = offset.checked_add(cue.end_ms) else {
            return (None, "timestamp_overflow");
        };
        cue.start_ms = start;
        cue.end_ms = end;
    }
    (
        Some(ParsedOutput::Transcript { cues }),
        "completed_output_rebased",
    )
}

#[cfg(test)]
mod tests;
