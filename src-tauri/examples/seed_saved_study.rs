//! Build a fresh, disposable native profile from one fixed saved experiment.
//! This standalone example is not an application fixture hook. It reads no
//! credential or live ledger and contains no provider/authentication operation.
use anyhow::{Context, Result, ensure};
use rusqlite::params;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};
use surtitle_ai::{
    AiStore, AudioAttachment, AudioChunk, AudioPreparationReceipt, BoundaryKind, ChunkResponse,
    ExecutionConfig, ParsedOutput, PreparationBinding, PreparedJob, RequestTask,
    build_transcript_draft, sha256_bytes,
};
use surtitle_core::{AppSettings, Media, Store};

const SOURCE_SHA: &str = "9c76866990fcc8b84006dc32d273ad99df439090b748ebe72103bb78c3216ee7";
const SOURCE_SAMPLES: u64 = 20_362_240;
const MANIFEST_SHA: &str = "d6b1bebae340904a4f0831a764055d5f6ee924e4d11c89bd470089717f3a5817";
const PROVIDER_SHA: &str = "da24e6fd2c7834d797dc1e9522e3f87b0e9795e4ec67a0bc167464b9b0ad620d";
const NATIVE_SHA: &str = "ecb27fdba4e2e45e15514a800406198f3a456d2a76a4ccbe19ed0ffcc4273606";
const INPUT_SHA: &str = "c952318ce618fba38ceb23f9095973dcb3ea7871b25c8da94a51199d7d39cc17";
const REFERENCE_SHA: &str = "85412656e19305048598b6b9963f1581b2b78d63ca514104bb6e1fb758436a6c";

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
    no_speech_detected: bool,
}

fn read_hashed(path: &Path, expected: &str, max: u64) -> Result<Vec<u8>> {
    let metadata = fs::symlink_metadata(path)?;
    ensure!(
        metadata.is_file() && !metadata.file_type().is_symlink() && metadata.len() <= max,
        "Input must be a bounded regular file"
    );
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    fs::File::open(path)?
        .take(max + 1)
        .read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= max && sha256_bytes(&bytes) == expected,
        "Frozen input identity differs: {}",
        path.display()
    );
    Ok(bytes)
}

fn write_new(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

fn write_json(path: &Path, value: &impl serde::Serialize) -> Result<()> {
    write_new(path, &serde_json::to_vec_pretty(value)?)
}

fn guarded_output(work: &Path, output: &Path) -> Result<PathBuf> {
    ensure!(
        output.is_absolute() && !output.exists(),
        "Use a new absolute output directory; existing profiles are never modified"
    );
    let name = output
        .file_name()
        .and_then(|name| name.to_str())
        .context("Output directory needs a UTF-8 name")?;
    ensure!(
        name.starts_with("surtitle-e2e-saved-study-") && name.len() <= 150,
        "Output name must start with surtitle-e2e-saved-study-"
    );
    let parent = output
        .parent()
        .context("Output parent missing")?
        .canonicalize()?;
    ensure!(
        parent.starts_with(work.canonicalize()?),
        "Output must stay within the ignored work directory"
    );
    Ok(parent.join(name))
}

fn rebase(output: &Value, offset: u64, duration: u64) -> Result<ParsedOutput> {
    let ParsedOutput::Transcript { mut cues } = serde_json::from_value(output.clone())? else {
        anyhow::bail!("Saved output is not a parsed transcript")
    };
    ensure!(
        !cues.is_empty() && cues.len() <= 50_000,
        "Expected a bounded nonempty received transcript"
    );
    let mut previous = 0;
    for cue in &mut cues {
        ensure!(
            !cue.text.trim().is_empty()
                && cue.text.len() <= 100_000
                && cue.start_ms >= previous
                && cue.start_ms < cue.end_ms
                && cue.end_ms <= duration,
            "Invalid saved clip-relative cue; no clamping is permitted"
        );
        previous = cue.start_ms;
        cue.start_ms = cue
            .start_ms
            .checked_add(offset)
            .context("Source timestamp overflow")?;
        cue.end_ms = cue
            .end_ms
            .checked_add(offset)
            .context("Source timestamp overflow")?;
    }
    Ok(ParsedOutput::Transcript { cues })
}

struct InputPart {
    audio: Vec<u8>,
    output: ParsedOutput,
    execution: ExecutionConfig,
    original_attempt_id: String,
    original_model_version: Option<String>,
}

fn main() -> Result<()> {
    let mut args = std::env::args_os().skip(1);
    let base = PathBuf::from(
        args.next()
            .context("usage: seed_saved_study ABS_EXPERIMENT_DIR ABS_NEW_WORK_PROFILE")?,
    );
    let requested_output = PathBuf::from(args.next().context("Missing fresh output directory")?);
    ensure!(
        args.next().is_none() && base.is_absolute(),
        "Use exactly two absolute paths"
    );
    let base = base.canonicalize()?;
    let work = base
        .parent()
        .context("Experiment must be inside ignored work")?;
    ensure!(
        work.file_name().is_some_and(|name| name == "work"),
        "Experiment must be a direct child of ignored work"
    );
    let output = guarded_output(work, &requested_output)?;
    let manifest_path = base.join("candidate-evaluation-v1/native-review-manifest.json");
    let provider_path = base.join("candidate-approved-run-v1/report-final.json");
    let native_path = base.join("candidate-evaluation-v1/native-review.json");
    let input_path = base.join("candidate-native-preparation-v1/input.json");
    let reference_path = base.join("joined-selection-candidate-v1/candidate-joined-reference.json");
    let manifest_bytes = read_hashed(&manifest_path, MANIFEST_SHA, 1024 * 1024)?;
    let provider_bytes = read_hashed(&provider_path, PROVIDER_SHA, 16 * 1024 * 1024)?;
    let native_bytes = read_hashed(&native_path, NATIVE_SHA, 16 * 1024 * 1024)?;
    let input_bytes = read_hashed(&input_path, INPUT_SHA, 1024 * 1024)?;
    let reference_bytes = read_hashed(&reference_path, REFERENCE_SHA, 4 * 1024 * 1024)?;
    let manifest: ReviewManifest = serde_json::from_slice(&manifest_bytes)?;
    let provider: Value = serde_json::from_slice(&provider_bytes)?;
    let native: Value = serde_json::from_slice(&native_bytes)?;
    let input: Value = serde_json::from_slice(&input_bytes)?;
    ensure!(
        manifest.schema_version == 1
            && manifest.cases.len() == 2
            && manifest
                .cases
                .iter()
                .map(|case| case.chunks.len())
                .sum::<usize>()
                == 6,
        "Expected exactly the two-profile six-request experiment"
    );
    ensure!(
        provider["schemaVersion"] == 1
            && provider["evidenceKind"] == "provider-validation"
            && native["inputs"]["resultsSha256"] == PROVIDER_SHA
            && native["inputs"]["manifestSha256"] == MANIFEST_SHA,
        "Saved review binding differs"
    );
    ensure!(
        input["audioSha256"] == SOURCE_SHA
            && input["startSample"] == 1_003_520
            && input["endSample"] == 4_843_520,
        "Source selection differs"
    );
    let source = PathBuf::from(
        input["audioPath"]
            .as_str()
            .context("Source audio path missing")?,
    );
    ensure!(
        source.is_absolute(),
        "Source audio must have an absolute path"
    );
    let source_bytes = read_hashed(&source, SOURCE_SHA, 64 * 1024 * 1024)?;
    // The exact hash binds the previously verified PCM16 source and sample count.
    // This helper does not reinterpret arbitrary container duration metadata.
    let mut inputs = Vec::new();
    let requests = provider["requests"]
        .as_array()
        .context("Saved requests missing")?;
    let mut seen_requests = std::collections::HashSet::new();
    for case in &manifest.cases {
        ensure!(
            case.media_id == "AMI/ES2002a"
                && case.source_sha256 == SOURCE_SHA
                && case.source_revision == REFERENCE_SHA,
            "Unexpected recording/reference identity"
        );
        let native_case = native["cases"]
            .as_array()
            .context("Native cases missing")?
            .iter()
            .find(|item| item["id"] == case.id)
            .context("Native profile missing")?;
        let mut case_inputs = Vec::new();
        for (ordinal, part) in case.chunks.iter().enumerate() {
            ensure!(
                part.ordinal as usize == ordinal
                    && seen_requests.insert(part.request_id.clone())
                    && !part.no_speech_detected
                    && part.audio_path.is_absolute()
                    && part.request_start_ms <= part.core_start_ms
                    && part.core_start_ms < part.core_end_ms
                    && part.core_end_ms <= part.request_end_ms
                    && part.request_end_ms <= 302_720,
                "Invalid or duplicate selected source chunk"
            );
            let matches = requests
                .iter()
                .filter(|request| request["id"] == part.request_id)
                .collect::<Vec<_>>();
            ensure!(
                matches.len() == 1,
                "Select exactly one frozen saved request"
            );
            let request = matches[0];
            let attempts = request["attempts"]
                .as_array()
                .context("Saved attempts missing")?;
            ensure!(
                request["state"] == "completed"
                    && request["taskKind"] == "transcribe_preview"
                    && request["sourceAudioSha256"] == part.audio_sha256
                    && request["model"] == "gemini-3.5-transcribe-preview"
                    && attempts.len() == 1
                    && attempts[0]["state"] == "settled",
                "Expected one successfully settled Transcribe response per source chunk"
            );
            let duration = part.request_end_ms - part.request_start_ms;
            let parsed = rebase(&request["output"], part.request_start_ms, duration)?;
            let native_input = native_case["inputEvidence"]
                .as_array()
                .context("Native input evidence missing")?
                .iter()
                .find(|item| item["requestId"] == part.request_id)
                .context("Native rebased source missing")?;
            ensure!(
                serde_json::to_value(&parsed)? == native_input["rebasedOutput"],
                "Saved output does not match production source-clock rebasing"
            );
            case_inputs.push(InputPart {
                audio: read_hashed(&part.audio_path, &part.audio_sha256, 12 * 1024 * 1024)?,
                output: parsed,
                execution: serde_json::from_value(request["execution"].clone())?,
                original_attempt_id: attempts[0]["id"]
                    .as_str()
                    .context("Original attempt ID missing")?
                    .into(),
                original_model_version: attempts[0]["modelVersion"].as_str().map(str::to_owned),
            });
        }
        inputs.push(case_inputs);
    }

    // Every original identity is checked before the first output write. A later
    // failure leaves an explicitly incomplete disposable profile for inspection.
    fs::create_dir(&output)?;
    write_new(
        &output.join("incomplete.fixture"),
        b"surtitle.saved-study.incomplete.v1\n",
    )?;
    for name in [
        "media",
        "prepared",
        "transcript-jobs",
        "reference",
        "card-audio",
        "backups",
        "tools",
        "credentials",
    ] {
        fs::create_dir(output.join(name))?;
    }
    let copied_source = output.join("media/AMI-ES2002a.pcm16.wav");
    write_new(&copied_source, &source_bytes)?;
    ensure!(
        surtitle_tools::sha256_file(&copied_source)? == SOURCE_SHA,
        "Copied source changed"
    );
    for (name, bytes) in [
        ("native-review-manifest.json", &manifest_bytes),
        ("provider-report.json", &provider_bytes),
        ("native-review.json", &native_bytes),
        ("preparation-input.json", &input_bytes),
        ("joined-reference.json", &reference_bytes),
    ] {
        write_new(&output.join("reference").join(name), bytes)?;
    }
    let db = Store::open(output.join("learning.sqlite"))?;
    let ai = AiStore::open(output.join("charges.sqlite"))?;
    let mut settings = AppSettings {
        locale: "en".into(),
        vertex_project: "offline-saved-study".into(),
        ..AppSettings::default()
    };
    let execution = inputs[0][0].execution.clone();
    ensure!(
        inputs
            .iter()
            .flatten()
            .all(|item| item.execution == execution),
        "Saved execution settings must match across this fixed batch"
    );
    settings.ai_models.insert(
        "transcription".into(),
        surtitle_core::AiModelPreference {
            model_id: execution.model_id.clone(),
            transcription_mode: "transcribe".into(),
            max_output_tokens: execution.max_output_tokens,
            thinking_level: None,
            thinking_budget: None,
            price: execution
                .price
                .as_ref()
                .map(|price| surtitle_core::AiPricePreference {
                    id: price.id.clone(),
                    source: price.source.clone(),
                    observed_at_ms: price.observed_at_ms,
                    input_microusd_per_million: price.input_microusd_per_million,
                    output_microusd_per_million: price.output_microusd_per_million,
                }),
        },
    );
    let settings_hash = sha256_bytes(&serde_json::to_vec(&(
        &settings.vertex_project,
        &settings.vertex_location,
    ))?);
    let canonical_revision = surtitle_core::store::subtitle_revision(&[])?;
    let mut quote_contexts = serde_json::Map::new();
    let mut profiles = Vec::new();
    let mut provenance = Vec::new();
    for (case, case_inputs) in manifest.cases.iter().zip(inputs) {
        let profile = if case.id.ends_with("current120") {
            "current120"
        } else if case.id.ends_with("short60") {
            "short60"
        } else {
            anyhow::bail!("Unknown saved profile")
        };
        ensure!(
            case.chunks.len() == if profile == "current120" { 2 } else { 4 },
            "Profile chunk count differs"
        );
        let media_id = format!("saved-transcribe-{profile}");
        let preparation_id = surtitle_core::id();
        let title = format!("Saved Transcribe {profile} · AMI ES2002a (offline)");
        db.put_media(&Media {
            id: media_id.clone(),
            title: title.clone(),
            path: copied_source.to_string_lossy().into_owned(),
            source_url: None,
            kind: "audio".into(),
            duration_ms: SOURCE_SAMPLES / 16,
            learning_language: "en-US".into(),
            explanation_language: "ja".into(),
            created_at: surtitle_core::now(),
            last_position_ms: 62_720,
            segment_count: 0,
            card_count: 0,
            status: "ready".into(),
            error: None,
            audio_stream_index: Some(0),
            subtitle_stream_index: None,
        })?;
        let directory = output.join("prepared").join(&preparation_id);
        fs::create_dir(&directory)?;
        let mut tasks = Vec::new();
        let mut chunks = Vec::new();
        let mut responses = Vec::new();
        for (part, input) in case.chunks.iter().zip(&case_inputs) {
            let audio_path = directory.join(format!("chunk-{}.wav", part.ordinal));
            write_new(&audio_path, &input.audio)?;
            tasks.push(RequestTask::TranscribePreview {
                language: "en-US".into(),
                audio: AudioAttachment::from_file(
                    audio_path,
                    part.request_start_ms,
                    part.request_end_ms - part.request_start_ms,
                )?,
            });
            chunks.push(AudioChunk {
                index: part.ordinal,
                sample_rate: 16_000,
                core_start_sample: part.core_start_ms * 16,
                core_end_sample: part.core_end_ms * 16,
                request_start_sample: part.request_start_ms * 16,
                request_end_sample: part.request_end_ms * 16,
                boundary: if part.ordinal as usize + 1 == case.chunks.len() {
                    BoundaryKind::EndOfSelection
                } else {
                    BoundaryKind::StrongPause
                },
            });
            responses.push(ChunkResponse {
                ordinal: part.ordinal,
                output: input.output.clone(),
            });
        }
        let plan = PreparedJob::new(
            title,
            settings.vertex_project.clone(),
            "unused-offline-saved-study".into(),
            PreparationBinding {
                media_id: media_id.clone(),
                transcript_revision: canonical_revision.clone(),
                source_sha256: SOURCE_SHA.into(),
                settings_sha256: settings_hash.clone(),
            },
            tasks,
            execution.clone(),
        )?;
        let tool_path = directory.join("offline-provenance-not-executable.txt");
        write_new(&tool_path, b"Saved-response fixture provenance only. No media processing tool was executed by this helper.\n")?;
        let tool = surtitle_tools::ToolSnapshot::capture(surtitle_tools::ResolvedTool {
            kind: surtitle_tools::ToolKind::FfmpegPair,
            source: surtitle_tools::ToolSource::External,
            selected_path: tool_path.clone(),
            executable: tool_path,
            ffprobe: None,
        })?;
        let receipt = AudioPreparationReceipt {
            id: preparation_id.clone(),
            directory: directory.clone(),
            source_path: copied_source.clone(),
            source_sha256: SOURCE_SHA.into(),
            audio_stream_index: Some(0),
            model_sha256: input["assets"]["model_sha256"]
                .as_str()
                .context("Retained VAD hash missing")?
                .into(),
            ffmpeg: tool,
            chunks,
            vad_no_speech_ordinals: vec![],
            vad_pause_evidence: None,
            prepared_job: plan.clone(),
            created_at_ms: chrono::Utc::now().timestamp_millis(),
        };
        let draft = build_transcript_draft(&receipt, &responses)?;
        let original_draft = native["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"] == case.id)
            .unwrap();
        ensure!(
            draft
                .segments
                .iter()
                .map(|cue| (&cue.text, cue.start_ms, cue.end_ms))
                .collect::<Vec<_>>()
                == serde_json::from_value::<surtitle_ai::TranscriptDraft>(
                    original_draft["draft"].clone()
                )?
                .segments
                .iter()
                .map(|cue| (&cue.text, cue.start_ms, cue.end_ms))
                .collect::<Vec<_>>(),
            "Current production stitching differs from the saved native text/timeline"
        );
        write_json(&directory.join("receipt.json"), &receipt)?;
        let quote = ai.prepare(plan)?;
        let mut conn = rusqlite::Connection::open(output.join("charges.sqlite"))?;
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        for (part, original) in case.chunks.iter().zip(&case_inputs) {
            let fixture_attempt_id = surtitle_core::id();
            let usage = json!({"offlineFixture":true,"paidRequests":0,"fixtureKind":"saved-study","originalReportSha256":PROVIDER_SHA,
                "originalRequestId":part.request_id,"originalAttemptId":original.original_attempt_id});
            tx.execute("INSERT INTO ai_attempts(id,job_id,ordinal,state,reserve_microusd,charged_microusd,created_at_ms,settled_at_ms,usage_json,model_version) VALUES(?,?,?,'settled',0,0,?,?,?,?)",
                params![fixture_attempt_id, quote.id, part.ordinal, receipt.created_at_ms, receipt.created_at_ms, serde_json::to_string(&usage)?, original.original_model_version])?;
            ensure!(tx.execute("UPDATE ai_requests SET state='completed',response_json=?,error_code=NULL WHERE job_id=? AND ordinal=? AND state='pending'",
                params![serde_json::to_string(&original.output)?, quote.id, part.ordinal])? == 1, "Fixture request was not untouched");
            provenance.push(json!({"profileId":profile,"ordinal":part.ordinal,"fixtureJobId":quote.id,"fixtureAttemptId":fixture_attempt_id,
                "originalRequestId":part.request_id,"originalAttemptId":original.original_attempt_id,"audioSha256":part.audio_sha256}));
        }
        ensure!(tx.execute("UPDATE ai_jobs SET state='completed' WHERE id=? AND state='prepared' AND approved_at_ms IS NULL", [&quote.id])? == 1, "Fixture job must remain unapproved");
        tx.commit()?;
        let receipt_hash = surtitle_tools::sha256_file(&directory.join("receipt.json"))?;
        write_json(
            &output
                .join("transcript-jobs")
                .join(format!("{}.json", quote.id)),
            &json!({"jobId":quote.id,"jobDigest":quote.digest,
            "preparationId":preparation_id,"receiptSha256":receipt_hash,"repairParent":null}),
        )?;
        quote_contexts.insert(
            quote.id.clone(),
            json!({"media_id":media_id,"kind":"transcribe","start_ms":62_720,"end_ms":302_720}),
        );
        profiles.push(json!({"profileId":profile,"mediaId":media_id,"jobId":quote.id,"preparationId":preparation_id,
            "sourceStartMs":62_720,"sourceEndMs":302_720,"requests":case.chunks.len(),"unresolvedBoundaries":draft.conflicts.len(),"wholeTranscriptAdopted":false}));
    }
    let summary = ai.summary()?;
    ensure!(
        summary.daily_charged_or_held_microusd == 0
            && summary.monthly_charged_or_held_microusd == 0
            && summary.unknown_attempts.is_empty()
            && summary.unpriced_attempts == 0,
        "The new fixture ledger must have no charge, hold or unknown attempt"
    );
    write_json(
        &output.join("preferences.json"),
        &json!({"settings":settings,"tools":surtitle_tools::ToolSelections::default(),"credential_id":null,
        "quotes":quote_contexts,"probes":{},"yt_dlp_stable":false,"update_checks":{}}),
    )?;
    let metadata = json!({"format":"surtitle.offline-saved-study.v1","mediaId":"saved-transcribe-current120","mediaPath":copied_source,
        "segmentCount":0,"paidRequests":0,"authRequests":0,"historicalLedgerCopied":false,"rawEvidenceInFixtureLedger":false,
        "originalReportSha256":PROVIDER_SHA,"sourceSha256":SOURCE_SHA,"sourceSamples":SOURCE_SAMPLES,"profiles":profiles,
        "provenance":provenance,"seedSourceSha256":sha256_bytes(include_bytes!("seed_saved_study.rs")),
        "inputs":[{"path":manifest_path,"sha256":MANIFEST_SHA},{"path":provider_path,"sha256":PROVIDER_SHA},{"path":native_path,"sha256":NATIVE_SHA},
            {"path":input_path,"sha256":INPUT_SHA},{"path":reference_path,"sha256":REFERENCE_SHA}],
        "note":"Saved real outputs, rebased and validated against the saved production draft. New zero-cost fixture attempts are not the original paid attempts. Original bounded response evidence is preserved in reference/provider-report.json, not inserted with invented production evidence bindings. No credentials, providers, live ledgers, source edits, or canonical subtitle adoption."});
    write_json(&output.join("fixture.json"), &metadata)?;
    fs::remove_file(output.join("incomplete.fixture"))?;
    println!(
        "{}",
        serde_json::to_string_pretty(
            &json!({"output":output,"profiles":2,"savedResponses":6,"paidRequests":0,"authRequests":0,"fixtureChargedOrHeldMicrousd":0})
        )?
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rebase_preserves_saved_text_and_positive_spans_without_clamping() {
        let original =
            json!({"kind":"transcript","cues":[{"startMs":2,"endMs":17,"text":"No, no."}]});
        let rebased = rebase(&original, 62_720, 1000).unwrap();
        assert_eq!(
            serde_json::to_value(rebased).unwrap(),
            json!({"kind":"transcript","cues":[{"startMs":62722,"endMs":62737,"text":"No, no."}]})
        );
        for (start, end) in [(1000, 1015), (5, 5), (7, 6)] {
            assert!(rebase(&json!({"kind":"transcript","cues":[{"startMs":start,"endMs":end,"text":"Keep original evidence."}]}), 62_720, 1000).is_err());
        }
    }
    #[test]
    fn profile_guard_preserves_existing_directory_and_rejects_escape() {
        let work = tempfile::tempdir().unwrap();
        let fresh = work.path().join("surtitle-e2e-saved-study-new");
        assert_eq!(guarded_output(work.path(), &fresh).unwrap(), fresh);
        fs::create_dir(&fresh).unwrap();
        write_new(&fresh.join("keep"), b"preserved").unwrap();
        assert!(guarded_output(work.path(), &fresh).is_err());
        assert_eq!(fs::read(fresh.join("keep")).unwrap(), b"preserved");
        let elsewhere = tempfile::tempdir().unwrap();
        assert!(
            guarded_output(
                work.path(),
                &elsewhere.path().join("surtitle-e2e-saved-study-outside")
            )
            .is_err()
        );
        assert!(guarded_output(work.path(), &work.path().join("ordinary-profile")).is_err());
    }
    #[test]
    fn changed_or_excessive_inputs_are_rejected_before_copying() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("input.json");
        write_new(&file, b"{}\n").unwrap();
        assert_eq!(
            read_hashed(&file, &sha256_bytes(b"{}\n"), 3).unwrap(),
            b"{}\n"
        );
        assert!(read_hashed(&file, &sha256_bytes(b"different"), 100).is_err());
        assert!(read_hashed(&file, &sha256_bytes(b"{}\n"), 2).is_err());
    }
}
