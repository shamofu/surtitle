//! App-owned audio preparations and local, explicit transcript review.
use crate::service::*;
pub(crate) mod study;
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};
use surtitle_ai::*;
use tauri::State;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RepairParent {
    job_id: String,
    draft_digest: String,
    boundary_id: String,
    start_ms: u64,
    end_ms: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TranscriptJob {
    job_id: String,
    job_digest: String,
    preparation_id: String,
    receipt_sha256: String,
    repair_parent: Option<RepairParent>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionPreparation {
    id: String,
    media_id: String,
    start_ms: u64,
    end_ms: u64,
    core_duration_ms: u64,
    send_duration_ms: u64,
    chunk_count: usize,
    job_id: Option<String>,
    repair_parent_job_id: Option<String>,
    repair_boundary_id: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptReview {
    job_id: String,
    media_id: String,
    draft: TranscriptDraft,
    applied: bool,
    can_apply: bool,
    blocked_reason: Option<String>,
    repair_alternatives: Vec<RepairAlternative>,
    results: Vec<TranscriptResultReview>,
    range_edits: Vec<surtitle_core::store::TranscriptRangeEdit<ManualRangeRevision>>,
    manual_editing_blocked_reason: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairAlternative {
    job_id: String,
    boundary_id: String,
    draft: TranscriptDraft,
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T> {
    ensure!(
        !fs::symlink_metadata(path)?.file_type().is_symlink(),
        "transcript metadata must be an app-owned file"
    );
    let mut file = fs::File::open(path)?;
    ensure!(
        file.metadata()?.len() <= 32 * 1024 * 1024,
        "transcript metadata exceeds its size limit"
    );
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(32 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() <= 32 * 1024 * 1024,
        "transcript metadata exceeds its size limit"
    );
    Ok(serde_json::from_slice(&bytes)?)
}
fn uuid_id(id: &str) -> Result<()> {
    ensure!(
        uuid::Uuid::parse_str(id).is_ok(),
        "invalid transcript preparation or job ID"
    );
    Ok(())
}
fn bindings_root(state: &AppState) -> Result<PathBuf> {
    let root = state.root.join("transcript-jobs");
    fs::create_dir_all(&root)?;
    Ok(root)
}
fn binding_path(state: &AppState, id: &str) -> Result<PathBuf> {
    uuid_id(id)?;
    Ok(bindings_root(state)?.join(format!("{id}.json")))
}
fn save_binding(state: &AppState, binding: &TranscriptJob) -> Result<()> {
    surtitle_core::store::write_json_atomic(&binding_path(state, &binding.job_id)?, binding)
}
fn job_bindings(state: &AppState) -> Result<Vec<TranscriptJob>> {
    let mut bindings = Vec::new();
    for entry in fs::read_dir(bindings_root(state)?)? {
        let path = entry?.path();
        if path.extension().is_some_and(|s| s == "json")
            && let Ok(binding) = read_json::<TranscriptJob>(&path)
        {
            bindings.push(binding);
        }
    }
    Ok(bindings)
}
fn load_binding(state: &AppState, job_id: &str) -> Result<TranscriptJob> {
    let binding: TranscriptJob = read_json(&binding_path(state, job_id)?)?;
    ensure!(
        binding.job_id == job_id && state.ai.quote(job_id)?.digest == binding.job_digest,
        "transcript job binding changed"
    );
    Ok(binding)
}
fn receipts(state: &AppState) -> Result<Vec<AudioPreparationReceipt>> {
    let directory = state.root.join("prepared");
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let root = directory.canonicalize()?;
    let mut out = Vec::new();
    for entry in fs::read_dir(&root)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() || entry.file_type()?.is_symlink() {
            continue;
        }
        let path = entry.path().join("receipt.json");
        if !path.is_file() {
            continue;
        }
        let loaded = (|| -> Result<AudioPreparationReceipt> {
            let receipt: AudioPreparationReceipt = read_json(&path)?;
            uuid_id(&receipt.id)?;
            ensure!(
                receipt.directory.canonicalize()? == entry.path().canonicalize()?
                    && receipt.directory.canonicalize()?.starts_with(&root),
                "preparation directory changed"
            );
            ensure!(
                receipt.source_sha256 == receipt.prepared_job.binding.source_sha256,
                "preparation source hash changed"
            );
            build_transcript_draft(&receipt, &[])?;
            for task in &receipt.prepared_job.requests {
                let audio =
                    audio_attachment(task).context("preparation contains a non-audio request")?;
                task.validate()?;
                ensure!(
                    audio.path.is_absolute()
                        && audio
                            .path
                            .parent()
                            .context("audio parent missing")?
                            .canonicalize()?
                            == receipt.directory.canonicalize()?,
                    "prepared audio escaped its owned directory"
                );
            }
            Ok(receipt)
        })();
        if let Ok(receipt) = loaded {
            out.push(receipt);
        }
    }
    out.sort_by_key(|receipt| std::cmp::Reverse(receipt.created_at_ms));
    Ok(out)
}
fn load_receipt(state: &AppState, id: &str) -> Result<AudioPreparationReceipt> {
    uuid_id(id)?;
    let mut found = receipts(state)?
        .into_iter()
        .filter(|receipt| receipt.id == id)
        .collect::<Vec<_>>();
    ensure!(
        found.len() == 1,
        "audio preparation is missing or its ID is duplicated"
    );
    Ok(found.remove(0))
}
fn audio_attachment(task: &RequestTask) -> Option<&AudioAttachment> {
    match task {
        RequestTask::AudioTranscription { audio, .. }
        | RequestTask::TranscribePreview { audio, .. } => Some(audio),
        _ => None,
    }
}
fn repair_parent(receipt: &AudioPreparationReceipt) -> Result<Option<RepairParent>> {
    let path = receipt.directory.join("repair-parent.json");
    if path.exists() {
        Ok(Some(read_json(&path)?))
    } else {
        Ok(None)
    }
}
fn receipt_for_job(state: &AppState, binding: &TranscriptJob) -> Result<AudioPreparationReceipt> {
    let mut receipt = load_receipt(state, &binding.preparation_id)?;
    ensure!(
        hash_file(&receipt.directory.join("receipt.json"))? == binding.receipt_sha256,
        "prepared receipt changed after the quote"
    );
    let plan = state.ai.prepared_job(&binding.job_id)?;
    ensure!(
        plan.requests.len() == receipt.prepared_job.requests.len()
            && plan
                .requests
                .iter()
                .zip(&receipt.prepared_job.requests)
                .all(|(left, right)| {
                    audio_attachment(left) == audio_attachment(right)
                        && match (left, right) {
                            (
                                RequestTask::AudioTranscription { language: a, .. }
                                | RequestTask::TranscribePreview { language: a, .. },
                                RequestTask::AudioTranscription { language: b, .. }
                                | RequestTask::TranscribePreview { language: b, .. },
                            ) => a == b,
                            _ => false,
                        }
                })
            && plan.binding.media_id == receipt.prepared_job.binding.media_id
            && plan.binding.source_sha256 == receipt.source_sha256
            && plan.binding.transcript_revision == receipt.prepared_job.binding.transcript_revision,
        "quoted audio differs from its local preparation"
    );
    receipt.prepared_job = plan;
    Ok(receipt)
}
struct SourceIdentity {
    path: String,
    language: String,
}
fn verify_source_identity(
    state: &AppState,
    receipt: &AudioPreparationReceipt,
    hash: bool,
) -> Result<SourceIdentity> {
    let db = lock(&state.db)?;
    let media = db.media(&receipt.prepared_job.binding.media_id)?;
    ensure!(
        surtitle_core::store::subtitle_revision(&db.list_segments(&media.id)?)?
            == receipt.prepared_job.binding.transcript_revision,
        "元字幕が変わっています。新しい準備を確認してください。"
    );
    for task in &receipt.prepared_job.requests {
        let language = match task {
            RequestTask::AudioTranscription { language, .. }
            | RequestTask::TranscribePreview { language, .. } => language,
            _ => anyhow::bail!("preparation task changed"),
        };
        ensure!(
            *language == media.learning_language,
            "学習言語が変わっています。"
        );
    }
    ensure!(
        media.audio_stream_index == receipt.audio_stream_index,
        "Selected audio track changed; review a new preparation"
    );
    drop(db);
    ensure!(
        Path::new(&media.path).canonicalize()? == receipt.source_path.canonicalize()?,
        "教材ファイルの場所が変わっています。"
    );
    if hash {
        ensure!(
            hash_file(&receipt.source_path)? == receipt.source_sha256,
            "教材ファイルの内容が変わっています。"
        );
    }
    Ok(SourceIdentity {
        path: media.path,
        language: media.learning_language,
    })
}
fn verify_source(state: &AppState, receipt: &AudioPreparationReceipt, hash: bool) -> Result<()> {
    verify_source_identity(state, receipt, hash).map(|_| ())
}
pub(crate) fn verify_audio_plan(state: &AppState, plan: &PreparedJob) -> Result<()> {
    verify_audio_plan_inner(state, plan, false)
}
pub(crate) fn verify_audio_source_content(state: &AppState, plan: &PreparedJob) -> Result<()> {
    verify_audio_plan_inner(state, plan, true)
}
fn verify_audio_plan_inner(state: &AppState, plan: &PreparedJob, hash: bool) -> Result<()> {
    let digest = plan.digest()?;
    let binding = job_bindings(state)?
        .into_iter()
        .find(|binding| binding.job_digest == digest)
        .context("audio quote has no registered preparation")?;
    let receipt = receipt_for_job(state, &binding)?;
    if let Some(parent) = &binding.repair_parent {
        validate_repair_parent(state, &receipt, parent)?;
    }
    verify_source(state, &receipt, hash)
}

#[tauri::command]
pub fn list_transcription_preparations(
    state: State<'_, AppState>,
    media_id: String,
) -> std::result::Result<Vec<TranscriptionPreparation>, String> {
    (|| {
        let bindings = job_bindings(&state)?;
        receipts(&state)?
            .into_iter()
            .filter(|receipt| receipt.prepared_job.binding.media_id == media_id)
            .map(|receipt| {
                let parent = repair_parent(&receipt)?;
                let range = build_transcript_draft(&receipt, &[])?;
                Ok(TranscriptionPreparation {
                    id: receipt.id.clone(),
                    media_id: media_id.clone(),
                    start_ms: range.start_ms,
                    end_ms: range.end_ms,
                    core_duration_ms: range.end_ms - range.start_ms,
                    send_duration_ms: receipt
                        .chunks
                        .iter()
                        .map(AudioChunk::request_duration_ms)
                        .sum(),
                    chunk_count: receipt.chunks.len(),
                    job_id: bindings
                        .iter()
                        .find(|b| b.preparation_id == receipt.id)
                        .map(|b| b.job_id.clone()),
                    repair_parent_job_id: parent.as_ref().map(|p| p.job_id.clone()),
                    repair_boundary_id: parent.map(|p| p.boundary_id),
                })
            })
            .collect::<Result<Vec<_>>>()
    })()
    .map_err(err)
}
fn create_audio_quote(
    state: &AppState,
    preparation_id: &str,
) -> Result<crate::ai_commands::AiQuote> {
    create_audio_quote_selected(state, preparation_id, None)
}
fn create_audio_quote_selected(
    state: &AppState,
    preparation_id: &str,
    selected: Option<surtitle_core::AiModelPreference>,
) -> Result<crate::ai_commands::AiQuote> {
    let receipt = load_receipt(state, preparation_id)?;
    verify_source(state, &receipt, true)?;
    for task in &receipt.prepared_job.requests {
        audio_attachment(task)
            .context("audio request missing")?
            .verify_integrity()?;
    }
    let parent = repair_parent(&receipt)?;
    if let Some(parent) = &parent {
        validate_repair_parent(state, &receipt, parent)?;
    }
    let p = lock(&state.preferences)?.clone();
    let inherited = parent
        .as_ref()
        .map(|parent| -> Result<_> {
            let original = state.ai.prepared_job(&parent.job_id)?;
            Ok(crate::model_commands::preference_for(
                &original.execution,
                matches!(
                    original.requests.first(),
                    Some(RequestTask::TranscribePreview { .. })
                ),
            ))
        })
        .transpose()?;
    let selected = selected
        .or(inherited)
        .or_else(|| p.settings.ai_models.get("transcription").cloned())
        .context("Choose a Gemini model and transcription API mode")?;
    let execution =
        crate::model_commands::execution_for(&p.settings, "transcription", Some(selected.clone()))?;
    let requests = receipt
        .prepared_job
        .requests
        .iter()
        .map(|task| {
            let (language, audio) = match task {
                RequestTask::AudioTranscription { language, audio }
                | RequestTask::TranscribePreview { language, audio } => {
                    (language.clone(), audio.clone())
                }
                _ => anyhow::bail!("preparation contains a non-audio request"),
            };
            Ok(if selected.transcription_mode == "transcribe" {
                RequestTask::TranscribePreview { language, audio }
            } else {
                RequestTask::AudioTranscription { language, audio }
            })
        })
        .collect::<Result<Vec<_>>>()?;
    for binding in job_bindings(state)?
        .into_iter()
        .filter(|binding| binding.preparation_id == preparation_id)
    {
        let existing = receipt_for_job(state, &binding)?;
        ensure!(
            binding.repair_parent == parent,
            "repair parent metadata changed after its quote"
        );
        if existing.prepared_job.execution == execution
            && existing.prepared_job.requests == requests
            && (p.credential_id.is_none()
                || (p.credential_id.as_deref()
                    == Some(existing.prepared_job.credential_id.as_str())
                    && existing.prepared_job.project_id == p.settings.vertex_project
                    && existing.prepared_job.binding.settings_sha256
                        == crate::ai_commands::settings_fingerprint(&p.settings)?))
        {
            let mut quote = state.ai.quote(&binding.job_id)?;
            if quote.state == "prepared"
                && quote.quote_expires_at_ms <= chrono::Utc::now().timestamp_millis()
            {
                quote = state.ai.refresh_quote(&binding.job_id)?;
            }
            return crate::ai_commands::quote_for_ui(state, quote, false);
        }
    }
    let mut binding = receipt.prepared_job.binding.clone();
    binding.settings_sha256 = crate::ai_commands::settings_fingerprint(&p.settings)?;
    let plan = PreparedJob::new(
        receipt.prepared_job.title.clone(),
        p.settings.vertex_project.clone(),
        p.credential_id
            .context("Import a service-account key before creating a cloud quote")?,
        binding,
        requests,
        execution,
    )?;
    let quote = state.ai.prepare(plan)?;
    save_binding(
        state,
        &TranscriptJob {
            job_id: quote.id.clone(),
            job_digest: quote.digest.clone(),
            preparation_id: receipt.id.clone(),
            receipt_sha256: hash_file(&receipt.directory.join("receipt.json"))?,
            repair_parent: parent,
        },
    )?;
    save_quote_context(state, &receipt, &quote.id)?;
    crate::ai_commands::quote_for_ui(state, quote, false)
}
fn save_quote_context(
    state: &AppState,
    receipt: &AudioPreparationReceipt,
    job_id: &str,
) -> Result<()> {
    let range = build_transcript_draft(receipt, &[])?;
    let mut p = lock(&state.preferences)?;
    p.quotes.insert(
        job_id.into(),
        QuoteContext {
            media_id: receipt.prepared_job.binding.media_id.clone(),
            kind: "transcribe".into(),
            start_ms: range.start_ms,
            end_ms: range.end_ms,
        },
    );
    state.save_preferences(&p)
}
#[tauri::command]
pub async fn create_transcription_quote(
    state: State<'_, AppState>,
    preparation_id: String,
    model: Option<surtitle_core::AiModelPreference>,
) -> std::result::Result<crate::ai_commands::AiQuote, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _review = lock(&state.transcript_review)?;
        create_audio_quote_selected(&state, &preparation_id, model)
    })
    .await
    .map_err(|_| "audio quote was interrupted".to_string())?
    .map_err(err)
}

fn load_draft(
    state: &AppState,
    binding: &TranscriptJob,
) -> Result<(AudioPreparationReceipt, TranscriptDraft, String)> {
    let receipt = receipt_for_job(state, binding)?;
    let mut responses = Vec::new();
    let mut reparsed = Vec::new();
    for ordinal in 0..receipt.chunks.len() {
        let output = match state.ai.response(&binding.job_id, ordinal as u32)? {
            Some(original) => Some(original),
            None => {
                let output = state
                    .ai
                    .selected_transcript_reparse(&binding.job_id, ordinal as u32)?;
                if output.is_some() {
                    reparsed.push(ordinal as u32);
                }
                output
            }
        };
        if let Some(output) = output {
            responses.push(ChunkResponse {
                ordinal: ordinal as u32,
                output,
            });
        }
    }
    let base = build_transcript_draft(&receipt, &responses)?;
    let edits = range_edits(state, binding, &receipt)?;
    let versions = edits
        .iter()
        .map(|e| (e.ordinal, e.version))
        .collect::<Vec<_>>();
    let selected = edits
        .into_iter()
        .filter_map(|e| e.selected_revision)
        .collect::<Vec<_>>();
    let effective = apply_manual_transcript_ranges(&base, &reparsed, &selected, &versions, None)?;
    let base_digest = effective.digest.clone();
    let saved: Option<TranscriptDraft> =
        lock(&state.db)?.latest_transcript_draft(&binding.job_id, &binding.job_digest)?;
    let draft =
        apply_manual_transcript_ranges(&base, &reparsed, &selected, &versions, saved.as_ref())?;
    Ok((receipt, draft, base_digest))
}

fn range_binding(
    binding: &TranscriptJob,
    receipt: &AudioPreparationReceipt,
    ordinal: u32,
) -> Result<ManualRangeBinding> {
    let task = receipt
        .prepared_job
        .requests
        .get(ordinal as usize)
        .context("Unknown transcript range")?;
    let audio = audio_attachment(task).context("Transcript range has no prepared audio")?;
    Ok(ManualRangeBinding {
        job_id: binding.job_id.clone(),
        job_digest: binding.job_digest.clone(),
        preparation_id: receipt.id.clone(),
        source_sha256: receipt.source_sha256.clone(),
        source_revision: receipt.prepared_job.binding.transcript_revision.clone(),
        ordinal,
        request_start_ms: audio.source_start_ms,
        request_end_ms: audio.source_start_ms + audio.duration_ms,
        input_sha256: audio.sha256.clone(),
        request_sha256: sha256_bytes(&serde_json::to_vec(
            receipt.prepared_job.request_body_snapshot(ordinal)?,
        )?),
    })
}
fn range_edits(
    state: &AppState,
    binding: &TranscriptJob,
    receipt: &AudioPreparationReceipt,
) -> Result<Vec<surtitle_core::store::TranscriptRangeEdit<ManualRangeRevision>>> {
    let mut saved = lock(&state.db)?
        .transcript_range_edits::<ManualRangeRevision>(&binding.job_id, &binding.job_digest)?;
    ensure!(
        saved
            .iter()
            .all(|e| (e.ordinal as usize) < receipt.chunks.len()),
        "Saved manual range is outside this preparation"
    );
    (0..receipt.chunks.len())
        .map(|ordinal| {
            let expected = range_binding(binding, receipt, ordinal as u32)?;
            let hash = sha256_bytes(&serde_json::to_vec(&expected)?);
            if let Some(index) = saved.iter().position(|e| e.ordinal == ordinal as u32) {
                let edit = saved.remove(index);
                ensure!(
                    edit.binding_sha256 == hash,
                    "Saved manual range binding changed"
                );
                for revision in [&edit.latest_revision, &edit.selected_revision]
                    .into_iter()
                    .flatten()
                {
                    revision.validate(&expected)?;
                }
                ensure!(
                    edit.selected_revision.as_ref().map(|r| &r.id)
                        == edit.selected_revision_id.as_ref(),
                    "Saved manual selection changed"
                );
                Ok(edit)
            } else {
                Ok(surtitle_core::store::TranscriptRangeEdit {
                    ordinal: ordinal as u32,
                    version: 0,
                    binding_sha256: hash,
                    selected_revision_id: None,
                    latest_revision: None,
                    selected_revision: None,
                })
            }
        })
        .collect()
}
fn manual_editing_allowed(state: &AppState, binding: &TranscriptJob) -> Result<()> {
    ensure!(
        lock(&state.db)?
            .transcript_adopted(&binding.job_id, &binding.job_digest)?
            .is_none(),
        "Adopted transcript ranges cannot be changed"
    );
    let quote = state.ai.quote(&binding.job_id)?;
    ensure!(
        [
            "prepared",
            "paused",
            "cancelled",
            "completed",
            "needs_review"
        ]
        .contains(&quote.state.as_str()),
        "Pause the AI job before saving local range edits, then refresh"
    );
    ensure!(
        !state
            .ai
            .summary()?
            .unknown_attempts
            .iter()
            .any(|a| a.job_id == binding.job_id && a.state == "reserved"),
        "Wait for the in-flight request to finish after pausing, then refresh"
    );
    Ok(())
}

fn save_manual_range(
    state: &AppState,
    job_id: &str,
    draft_digest: &str,
    ordinal: u32,
    expected_range_version: u64,
    content: ManualTranscriptContent,
) -> Result<TranscriptReview> {
    let _review = lock(&state.transcript_review)?;
    let binding = load_binding(state, job_id)?;
    manual_editing_allowed(state, &binding)?;
    let (receipt, draft, _) = load_draft(state, &binding)?;
    ensure!(
        draft.digest == draft_digest,
        "Transcript review changed; refresh before saving"
    );
    verify_source(state, &receipt, false)?;
    let native_binding = range_binding(&binding, &receipt, ordinal)?;
    let binding_sha256 = sha256_bytes(&serde_json::to_vec(&native_binding)?);
    let revision = ManualRangeRevision {
        id: uuid::Uuid::new_v4().to_string(),
        ordinal,
        created_at: surtitle_core::now(),
        binding: native_binding,
        content,
    };
    revision.validate(&revision.binding)?;
    let mut selected = draft
        .chunks
        .iter()
        .filter(|c| c.ordinal != ordinal)
        .filter_map(|c| c.manual_revision.clone())
        .collect::<Vec<_>>();
    selected.push(revision.clone());
    let next_version = expected_range_version
        .checked_add(1)
        .context("Range version overflow")?;
    apply_manual_transcript_ranges(
        &draft,
        &[],
        &selected,
        &[(ordinal, next_version)],
        Some(&draft),
    )?;
    // This transaction touches only local review history, never attempts, holds,
    // responses or approvals. A later provider response cannot remove this choice.
    lock(&state.db)?.save_transcript_range_revision(
        job_id,
        &binding.job_digest,
        ordinal,
        &binding_sha256,
        expected_range_version,
        &revision.id,
        &revision,
    )?;
    let (_, updated, base_digest) = load_draft(state, &binding)?;
    lock(&state.db)?.save_transcript_draft(job_id, &binding.job_digest, &base_digest, &updated)?;
    view(state, job_id)
}
fn select_range_source(
    state: &AppState,
    job_id: &str,
    draft_digest: &str,
    ordinal: u32,
    expected_range_version: u64,
    source: TranscriptRangeSelection,
) -> Result<TranscriptReview> {
    let _review = lock(&state.transcript_review)?;
    let binding = load_binding(state, job_id)?;
    manual_editing_allowed(state, &binding)?;
    let (receipt, draft, _) = load_draft(state, &binding)?;
    ensure!(
        draft.digest == draft_digest,
        "Transcript review changed; refresh before selecting a source"
    );
    verify_source(state, &receipt, false)?;
    let hash = sha256_bytes(&serde_json::to_vec(&range_binding(
        &binding, &receipt, ordinal,
    )?)?);
    let id = match &source {
        TranscriptRangeSelection::Original => None,
        TranscriptRangeSelection::Manual { revision_id } => Some(revision_id.as_str()),
    };
    let mut selected = draft
        .chunks
        .iter()
        .filter(|c| c.ordinal != ordinal)
        .filter_map(|c| c.manual_revision.clone())
        .collect::<Vec<_>>();
    if let Some(id) = id {
        let revision: ManualRangeRevision = lock(&state.db)?.transcript_range_revision(
            job_id,
            &binding.job_digest,
            ordinal,
            &hash,
            id,
        )?;
        revision.validate(&range_binding(&binding, &receipt, ordinal)?)?;
        selected.push(revision);
    }
    let next_version = expected_range_version
        .checked_add(1)
        .context("Range version overflow")?;
    apply_manual_transcript_ranges(
        &draft,
        &[],
        &selected,
        &[(ordinal, next_version)],
        Some(&draft),
    )?;
    lock(&state.db)?.select_transcript_range_revision(
        job_id,
        &binding.job_digest,
        ordinal,
        &hash,
        expected_range_version,
        id,
    )?;
    let (_, updated, base_digest) = load_draft(state, &binding)?;
    lock(&state.db)?.save_transcript_draft(job_id, &binding.job_digest, &base_digest, &updated)?;
    view(state, job_id)
}
#[tauri::command]
pub async fn save_manual_transcript_range(
    state: State<'_, AppState>,
    job_id: String,
    draft_digest: String,
    ordinal: u32,
    expected_range_version: u64,
    content: ManualTranscriptContent,
) -> std::result::Result<TranscriptReview, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        save_manual_range(
            &state,
            &job_id,
            &draft_digest,
            ordinal,
            expected_range_version,
            content,
        )
    })
    .await
    .map_err(|_| "Local range save was interrupted".to_string())?
    .map_err(err)
}
#[tauri::command]
pub async fn select_transcript_range_source(
    state: State<'_, AppState>,
    job_id: String,
    draft_digest: String,
    ordinal: u32,
    expected_range_version: u64,
    source: TranscriptRangeSelection,
) -> std::result::Result<TranscriptReview, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        select_range_source(
            &state,
            &job_id,
            &draft_digest,
            ordinal,
            expected_range_version,
            source,
        )
    })
    .await
    .map_err(|_| "Local range selection was interrupted".to_string())?
    .map_err(err)
}
fn draft_segments(draft: &TranscriptDraft) -> Vec<surtitle_core::SubtitleSegment> {
    draft
        .segments
        .iter()
        .map(|cue| surtitle_core::SubtitleSegment {
            id: format!("{}-{}", draft.id, cue.id),
            media_id: draft.media_id.clone(),
            start_ms: cue.start_ms,
            end_ms: cue.end_ms,
            text: cue.text.clone(),
            translation: None,
            status: cue.status.clone(),
        })
        .collect()
}
fn require_explicit_empty_range_confirmation(draft: &TranscriptDraft) -> Result<()> {
    ensure!(
        draft.chunks.iter().all(|chunk| !chunk.segments.is_empty()
            || chunk
                .manual_revision
                .as_ref()
                .is_some_and(|revision| matches!(
                    revision.content,
                    ManualTranscriptContent::ConfirmedNoSpeech
                ))),
        "Empty ranges require an explicit no-speech confirmation in the range editor before adoption"
    );
    Ok(())
}

fn view(state: &AppState, job_id: &str) -> Result<TranscriptReview> {
    let binding = load_binding(state, job_id)?;
    let (receipt, draft, _) = load_draft(state, &binding)?;
    let applied = lock(&state.db)?
        .transcript_adopted(job_id, &binding.job_digest)?
        .is_some();
    let checked = if applied {
        Ok(())
    } else if binding.repair_parent.is_some() {
        Err(anyhow::anyhow!(
            "修復結果は比較用の候補です。親の境界レビューで内容と時刻を確認して選択してください。"
        ))
    } else {
        (|| {
            manual_editing_allowed(state, &binding)?;
            validate_transcript_adoption(&draft, &draft.digest)?;
            require_explicit_empty_range_confirmation(&draft)?;
            verify_source(state, &receipt, true)?;
            let db = lock(&state.db)?;
            surtitle_core::store::validate_transcript_range(
                &db.list_segments(&draft.media_id)?,
                draft.start_ms,
                draft.end_ms,
                &draft_segments(&draft),
                &draft.media_id,
            )
        })()
    };
    let mut repair_alternatives = Vec::new();
    for repair in job_bindings(state)?
        .into_iter()
        .filter(|b| b.repair_parent.as_ref().is_some_and(|p| p.job_id == job_id))
    {
        let (_, alternative, _) = load_draft(state, &repair)?;
        repair_alternatives.push(RepairAlternative {
            job_id: repair.job_id,
            boundary_id: repair.repair_parent.unwrap().boundary_id,
            draft: alternative,
        });
    }
    Ok(TranscriptReview {
        job_id: job_id.into(),
        media_id: draft.media_id.clone(),
        draft,
        applied,
        can_apply: !applied && checked.is_ok(),
        blocked_reason: checked.err().map(|e| e.to_string()),
        repair_alternatives,
        results: state.ai.transcript_result_reviews(job_id)?,
        range_edits: range_edits(state, &binding, &receipt)?,
        manual_editing_blocked_reason: manual_editing_allowed(state, &binding)
            .err()
            .map(|e| e.to_string()),
    })
}
#[tauri::command]
pub async fn get_transcript_review(
    state: State<'_, AppState>,
    job_id: String,
) -> std::result::Result<TranscriptReview, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _review = lock(&state.transcript_review)?;
        view(&state, &job_id)
    })
    .await
    .map_err(|_| "transcript review was interrupted".to_string())?
    .map_err(err)
}

#[tauri::command]
pub async fn get_transcript_result_detail(
    state: State<'_, AppState>,
    job_id: String,
    ordinal: u32,
) -> std::result::Result<TranscriptResultReview, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _review = lock(&state.transcript_review)?;
        load_binding(&state, &job_id)?;
        state
            .ai
            .transcript_result_detail(&job_id, ordinal)
            .map_err(anyhow::Error::from)
    })
    .await
    .map_err(|_| "Transcript evidence loading was interrupted".to_string())?
    .map_err(err)
}

#[tauri::command]
pub async fn reparse_transcript_evidence(
    state: State<'_, AppState>,
    job_id: String,
    ordinal: u32,
    evidence_sha256: String,
) -> std::result::Result<TranscriptReview, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _review = lock(&state.transcript_review)?;
        load_binding(&state, &job_id)?;
        state
            .ai
            .reparse_transcript_evidence(&job_id, ordinal, &evidence_sha256)?;
        view(&state, &job_id)
    })
    .await
    .map_err(|_| "Local transcript reparse was interrupted".to_string())?
    .map_err(err)
}

#[tauri::command]
pub async fn select_transcript_reparse(
    state: State<'_, AppState>,
    job_id: String,
    ordinal: u32,
    candidate_id: String,
    draft_digest: String,
) -> std::result::Result<TranscriptReview, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _review = lock(&state.transcript_review)?;
        let binding = load_binding(&state, &job_id)?;
        let (_, draft, _) = load_draft(&state, &binding)?;
        ensure!(
            draft.digest == draft_digest,
            "The transcript review changed; reload it before selecting a candidate"
        );
        ensure!(
            lock(&state.db)?
                .transcript_adopted(&job_id, &binding.job_digest)?
                .is_none(),
            "Adopted transcript decisions cannot be replaced"
        );
        ensure!(
            state.ai.response(&job_id, ordinal)?.is_none(),
            "The original valid result is already available"
        );
        state
            .ai
            .select_transcript_reparse(&job_id, ordinal, &candidate_id)?;
        view(&state, &job_id)
    })
    .await
    .map_err(|_| "Local transcript selection was interrupted".to_string())?
    .map_err(err)
}
#[tauri::command]
pub async fn resolve_transcript_boundary(
    state: State<'_, AppState>,
    job_id: String,
    draft_digest: String,
    boundary_id: String,
    choice: BoundaryChoice,
) -> std::result::Result<TranscriptReview, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        resolve_review(&state, &job_id, &draft_digest, &boundary_id, choice)
    })
    .await
    .map_err(|_| "boundary resolution was interrupted".to_string())?
    .map_err(err)
}
fn resolve_review(
    state: &AppState,
    job_id: &str,
    draft_digest: &str,
    boundary_id: &str,
    choice: BoundaryChoice,
) -> Result<TranscriptReview> {
    let _review = lock(&state.transcript_review)?;
    let binding = load_binding(state, job_id)?;
    let (_, draft, base_digest) = load_draft(state, &binding)?;
    ensure!(
        lock(&state.db)?
            .transcript_adopted(job_id, &binding.job_digest)?
            .is_none(),
        "adopted transcript decisions cannot be replaced"
    );
    let updated =
        surtitle_ai::resolve_transcript_boundary(&draft, draft_digest, boundary_id, choice)?;
    lock(&state.db)?.save_transcript_draft(job_id, &binding.job_digest, &base_digest, &updated)?;
    view(state, job_id)
}

#[tauri::command]
pub async fn acknowledge_transcript_warning(
    state: State<'_, AppState>,
    job_id: String,
    draft_digest: String,
    warning_id: String,
) -> std::result::Result<TranscriptReview, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        acknowledge_review_warning(&state, &job_id, &draft_digest, &warning_id)
    })
    .await
    .map_err(|_| "Transcript review was interrupted".to_string())?
    .map_err(err)
}
fn acknowledge_review_warning(
    state: &AppState,
    job_id: &str,
    draft_digest: &str,
    warning_id: &str,
) -> Result<TranscriptReview> {
    let _review = lock(&state.transcript_review)?;
    let binding = load_binding(state, job_id)?;
    ensure!(
        lock(&state.db)?
            .transcript_adopted(job_id, &binding.job_digest)?
            .is_none(),
        "Adopted transcript decisions cannot be replaced"
    );
    let (_, draft, base_digest) = load_draft(state, &binding)?;
    let updated = surtitle_ai::acknowledge_transcript_warning(&draft, draft_digest, warning_id)?;
    lock(&state.db)?.save_transcript_draft(job_id, &binding.job_digest, &base_digest, &updated)?;
    view(state, job_id)
}
fn apply_review(state: &AppState, job_id: &str, expected_digest: &str) -> Result<TranscriptReview> {
    let _review = lock(&state.transcript_review)?;
    let binding = load_binding(state, job_id)?;
    ensure!(
        binding.repair_parent.is_none(),
        "repair results are alternatives; resolve the parent boundary explicitly"
    );
    let adopted = lock(&state.db)?.transcript_adopted(job_id, &binding.job_digest)?;
    if let Some(applied_digest) = adopted {
        ensure!(
            applied_digest == expected_digest,
            "this job was adopted with a different reviewed draft"
        );
        return view(state, job_id);
    }
    let (receipt, draft, _) = load_draft(state, &binding)?;
    manual_editing_allowed(state, &binding)?;
    validate_transcript_adoption(&draft, expected_digest)?;
    require_explicit_empty_range_confirmation(&draft)?;
    let source_identity = verify_source_identity(state, &receipt, true)?;
    let mut db = lock(&state.db)?;
    let current_media = db.media(&draft.media_id)?;
    ensure!(
        current_media.path == source_identity.path
            && current_media.learning_language == source_identity.language,
        "media was relinked or its language changed during transcript verification"
    );
    db.adopt_transcript_once(
        job_id,
        &binding.job_digest,
        &draft.digest,
        &draft.media_id,
        &draft.source_revision,
        draft.start_ms,
        draft.end_ms,
        &draft_segments(&draft),
    )?;
    drop(db);
    crate::commands::refresh_current_subtitles(state, &draft.media_id)?;
    view(state, job_id)
}
#[tauri::command]
pub async fn apply_transcript_review(
    state: State<'_, AppState>,
    job_id: String,
    draft_digest: String,
) -> std::result::Result<TranscriptReview, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || apply_review(&state, &job_id, &draft_digest))
        .await
        .map_err(|_| "transcript adoption was interrupted".to_string())?
        .map_err(err)
}
fn validate_repair_parent(
    state: &AppState,
    receipt: &AudioPreparationReceipt,
    parent: &RepairParent,
) -> Result<()> {
    let binding = load_binding(state, &parent.job_id)?;
    ensure!(
        lock(&state.db)?
            .transcript_adopted(&parent.job_id, &binding.job_digest)?
            .is_none(),
        "the repair parent was already adopted"
    );
    let (_, draft, _) = load_draft(state, &binding)?;
    let range = boundary_repair_range(&draft, &parent.draft_digest, &parent.boundary_id)?;
    let prepared_range = build_transcript_draft(receipt, &[])?;
    ensure!(
        range.start_ms == parent.start_ms
            && range.end_ms == parent.end_ms
            && receipt.chunks.len() == 1
            && prepared_range.start_ms == range.start_ms
            && prepared_range.end_ms == range.end_ms
            && receipt.chunks[0].request_duration_ms() <= 30_000
            && receipt.source_sha256 == draft.source_sha256,
        "repair preparation differs from the reviewed parent boundary"
    );
    Ok(())
}
#[tauri::command]
pub async fn prepare_boundary_repair(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    job_id: String,
    draft_digest: String,
    boundary_id: String,
) -> std::result::Result<crate::ai_commands::AiQuote, String> {
    let state = state.inner().clone();
    async {
        let inspect_state = state.clone();
        let (media_id, range, parent, reused) = tauri::async_runtime::spawn_blocking(move || {
            let state = inspect_state;
            let _review = lock(&state.transcript_review)?;
            let binding = load_binding(&state, &job_id)?;
            let (source, draft, _) = load_draft(&state, &binding)?;
            ensure!(
                lock(&state.db)?
                    .transcript_adopted(&job_id, &binding.job_digest)?
                    .is_none(),
                "adopted transcripts do not accept automatic repair"
            );
            let range = boundary_repair_range(&draft, &draft_digest, &boundary_id)?;
            verify_source(&state, &source, true)?;
            let parent = RepairParent {
                job_id,
                draft_digest,
                boundary_id,
                start_ms: range.start_ms,
                end_ms: range.end_ms,
            };
            for receipt in receipts(&state)? {
                if let Some(saved) = repair_parent(&receipt)?
                    && saved.job_id == parent.job_id
                    && saved.draft_digest == parent.draft_digest
                    && saved.boundary_id == parent.boundary_id
                {
                    validate_repair_parent(&state, &receipt, &saved)?;
                    return Ok::<_, anyhow::Error>((
                        draft.media_id,
                        range,
                        parent,
                        Some(create_audio_quote(&state, &receipt.id)?),
                    ));
                }
            }
            Ok((draft.media_id, range, parent, None))
        })
        .await??;
        if let Some(quote) = reused {
            return Ok(quote);
        }
        let receipt = crate::ai_commands::prepare_transcription_receipt(
            app,
            state.clone(),
            media_id,
            range.start_ms,
            range.end_ms,
        )
        .await?;
        tauri::async_runtime::spawn_blocking(move || {
            let _review = lock(&state.transcript_review)?;
            surtitle_core::store::write_json_atomic(
                &receipt.directory.join("repair-parent.json"),
                &parent,
            )?;
            validate_repair_parent(&state, &receipt, &parent)?;
            create_audio_quote(&state, &receipt.id)
        })
        .await?
    }
    .await
    .map_err(err)
}

#[cfg(feature = "e2e-test")]
pub(crate) fn seed_transcript_review_fixture(state: &AppState) -> Result<()> {
    let Some(preset) = std::env::var_os("SURTITLE_E2E_TRANSCRIPT_REVIEW") else {
        return Ok(());
    };
    ensure!(preset == "boundary", "unknown transcript review fixture");
    let root = PathBuf::from(
        std::env::var_os("SURTITLE_E2E_DATA_DIR")
            .context("transcript fixture requires an isolated data directory")?,
    );
    ensure!(
        root.is_absolute() && root.canonicalize()? == state.root.canonicalize()?,
        "transcript fixture data directory differs"
    );
    seed_fixture_data(state)
}
#[cfg(feature = "e2e-test")]
fn fixture_wav(seconds: u32) -> Vec<u8> {
    let length = seconds * 32000;
    let mut bytes = b"RIFF".to_vec();
    bytes.extend_from_slice(&(length + 36).to_le_bytes());
    bytes
        .extend_from_slice(b"WAVEfmt \x10\0\0\0\x01\0\x01\0\x80\x3e\0\0\0\x7d\0\0\x02\0\x10\0data");
    bytes.extend_from_slice(&length.to_le_bytes());
    bytes.resize(length as usize + 44, 0);
    bytes
}
#[cfg(feature = "e2e-test")]
fn fixture_receipt(
    state: &AppState,
    media_id: &str,
    preparation_id: &str,
    repair: bool,
) -> Result<AudioPreparationReceipt> {
    let directory = state.root.join("prepared").join(if repair {
        "e2e-transcript-repair"
    } else {
        media_id
    });
    fs::create_dir_all(&directory)?;
    let directory = directory.canonicalize()?;
    let source = state.root.join("media").join(format!("{media_id}.wav"));
    let source = source.canonicalize()?;
    let source_sha256 = hash_file(&source)?;
    let mut requests = Vec::new();
    let mut chunks = Vec::new();
    for index in 0..if repair { 1 } else { 2 } {
        let path = directory.join(format!("chunk-{index}.wav"));
        fs::write(&path, fixture_wav(if repair { 8 } else { 7 }))?;
        let request_start = if index == 0 { 0 } else { 1000 };
        requests.push(RequestTask::TranscribePreview {
            language: "en".into(),
            audio: AudioAttachment::from_file(
                path,
                request_start,
                if repair { 8000 } else { 7000 },
            )?,
        });
        chunks.push(AudioChunk {
            index,
            sample_rate: 16000,
            core_start_sample: if index == 0 { 0 } else { 64000 },
            core_end_sample: if repair || index == 1 { 128000 } else { 64000 },
            request_start_sample: request_start * 16,
            request_end_sample: if repair || index == 1 { 128000 } else { 112000 },
            boundary: if repair || index == 1 {
                BoundaryKind::EndOfSelection
            } else {
                BoundaryKind::Forced
            },
        });
    }
    let tool = directory.join("offline-fixture-tool.txt");
    fs::write(&tool, b"This is fixture provenance, not an executable.")?;
    let ffmpeg = surtitle_tools::ToolSnapshot::capture(surtitle_tools::ResolvedTool {
        kind: surtitle_tools::ToolKind::FfmpegPair,
        source: surtitle_tools::ToolSource::Managed,
        selected_path: tool.clone(),
        executable: tool,
        ffprobe: None,
    })?;
    let receipt = AudioPreparationReceipt {
        id: preparation_id.into(),
        directory: directory.clone(),
        source_path: source,
        source_sha256: source_sha256.clone(),
        audio_stream_index: Some(0),
        model_sha256: SILERO_MODEL_SHA256.into(),
        vad_no_speech_ordinals: vec![],
        vad_pause_evidence: None,
        ffmpeg,
        chunks,
        prepared_job: PreparedJob::new(
            if repair {
                "E2E transcript repair".into()
            } else {
                format!("E2E / {media_id}")
            },
            "e2e-project".into(),
            "unused-e2e-fixture".into(),
            PreparationBinding {
                media_id: media_id.into(),
                transcript_revision: surtitle_core::store::subtitle_revision(
                    &lock(&state.db)?.list_segments(media_id)?,
                )?,
                source_sha256,
                settings_sha256: crate::ai_commands::settings_fingerprint(
                    &lock(&state.preferences)?.settings,
                )?,
            },
            requests,
            crate::model_commands::fixture_execution(),
        )?,
        created_at_ms: chrono::Utc::now().timestamp_millis(),
    };
    surtitle_core::store::write_json_atomic(&directory.join("receipt.json"), &receipt)?;
    Ok(receipt)
}
#[cfg(feature = "e2e-test")]
fn register_fixture_job(
    state: &AppState,
    receipt: &AudioPreparationReceipt,
    quote: &JobQuote,
    parent: Option<RepairParent>,
) -> Result<()> {
    save_binding(
        state,
        &TranscriptJob {
            job_id: quote.id.clone(),
            job_digest: quote.digest.clone(),
            preparation_id: receipt.id.clone(),
            receipt_sha256: hash_file(&receipt.directory.join("receipt.json"))?,
            repair_parent: parent,
        },
    )?;
    save_quote_context(state, receipt, &quote.id)
}
#[cfg(feature = "e2e-test")]
fn seed_fixture_data(state: &AppState) -> Result<()> {
    {
        let execution = crate::model_commands::fixture_execution();
        let price = execution.price.unwrap();
        let mut prefs = lock(&state.preferences)?;
        prefs
            .settings
            .ai_models
            .entry("transcription".into())
            .or_insert(surtitle_core::AiModelPreference {
                model_id: execution.model_id,
                transcription_mode: "transcribe".into(),
                max_output_tokens: execution.max_output_tokens,
                thinking_level: None,
                thinking_budget: None,
                price: Some(surtitle_core::AiPricePreference {
                    id: price.id,
                    source: price.source,
                    observed_at_ms: price.observed_at_ms,
                    input_microusd_per_million: price.input_microusd_per_million,
                    output_microusd_per_million: price.output_microusd_per_million,
                }),
            });
        state.save_preferences(&prefs)?;
    }
    let marker = state.root.join("e2e-transcript-fixture.json");
    if marker.exists() {
        return Ok(());
    }
    let mut complete_job = String::new();
    for (media_id, preparation_id, pending) in [
        (
            "e2e-transcript-review",
            "11111111-1111-4111-8111-111111111111",
            false,
        ),
        (
            "e2e-transcript-pending",
            "22222222-2222-4222-8222-222222222222",
            true,
        ),
    ] {
        let source = state.root.join("media").join(format!("{media_id}.wav"));
        fs::write(&source, fixture_wav(8))?;
        let mut db = lock(&state.db)?;
        db.put_media(&surtitle_core::Media {
            id: media_id.into(),
            title: format!("E2E / {media_id}"),
            path: source.to_string_lossy().into_owned(),
            source_url: None,
            kind: "audio".into(),
            duration_ms: 8000,
            learning_language: "en".into(),
            explanation_language: "ja".into(),
            created_at: surtitle_core::now(),
            last_position_ms: 0,
            segment_count: 1,
            card_count: 0,
            status: "ready".into(),
            error: None,
            audio_stream_index: Some(0),
            subtitle_stream_index: None,
        })?;
        db.set_segments(
            media_id,
            &[surtitle_core::SubtitleSegment {
                id: format!("{media_id}-old"),
                media_id: media_id.into(),
                start_ms: 0,
                end_ms: 1000,
                text: "Original subtitle".into(),
                translation: Some("元の訳".into()),
                status: "confirmed".into(),
            }],
        )?;
        drop(db);
        let receipt = fixture_receipt(state, media_id, preparation_id, false)?;
        let quote = state
            .ai
            .seed_transcript_review_fixture(receipt.prepared_job.clone(), pending)?;
        register_fixture_job(state, &receipt, &quote, None)?;
        if !pending {
            complete_job = quote.id;
        }
    }
    let binding = load_binding(state, &complete_job)?;
    let (_, draft, _) = load_draft(state, &binding)?;
    ensure!(
        draft.conflicts.len() == 1,
        "offline transcript fixture needs exactly one boundary conflict"
    );
    let range = boundary_repair_range(&draft, &draft.digest, &draft.conflicts[0].id)?;
    let parent = RepairParent {
        job_id: complete_job,
        draft_digest: draft.digest.clone(),
        boundary_id: draft.conflicts[0].id.clone(),
        start_ms: range.start_ms,
        end_ms: range.end_ms,
    };
    let repair = fixture_receipt(
        state,
        "e2e-transcript-review",
        "33333333-3333-4333-8333-333333333333",
        true,
    )?;
    surtitle_core::store::write_json_atomic(&repair.directory.join("repair-parent.json"), &parent)?;
    let quote = state.ai.prepare(repair.prepared_job.clone())?;
    register_fixture_job(state, &repair, &quote, Some(parent))?;
    surtitle_core::store::write_json_atomic(
        &marker,
        &serde_json::json!({"preset":"boundary","paidRequests":0}),
    )
}

#[cfg(all(test, feature = "e2e-test"))]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, AppState) {
        let directory = tempfile::tempdir().unwrap();
        let state = Services::open(directory.path().to_path_buf()).unwrap();
        seed_fixture_data(&state).unwrap();
        (directory, state)
    }
    fn job(state: &AppState, preparation: &str) -> String {
        job_bindings(state)
            .unwrap()
            .into_iter()
            .find(|b| b.preparation_id == preparation)
            .unwrap()
            .job_id
    }
    const COMPLETE: &str = "11111111-1111-4111-8111-111111111111";
    const PENDING: &str = "22222222-2222-4222-8222-222222222222";
    const REPAIR: &str = "33333333-3333-4333-8333-333333333333";
    fn authored_range() -> ManualTranscriptContent {
        ManualTranscriptContent::Subtitles {
            segments: vec![
                ReviewText {
                    start_ms: 3500,
                    end_ms: 4500,
                    text: "No, no.".into(),
                },
                ReviewText {
                    start_ms: 7500,
                    end_ms: 7900,
                    text: "Locally corrected.".into(),
                },
            ],
        }
    }
    fn charge_snapshot(conn: &rusqlite::Connection) -> Vec<String> {
        [
            "SELECT json_group_array(json_array(id,job_id,ordinal,state,reserve_microusd,charged_microusd,created_at_ms,dispatched_at_ms,settled_at_ms,usage_json,model_version)) FROM (SELECT * FROM ai_attempts ORDER BY id)",
            "SELECT json_group_array(json_array(job_id,ordinal,state,response_json,error_code)) FROM (SELECT * FROM ai_requests ORDER BY job_id,ordinal)",
            "SELECT json_group_array(json_array(id,digest,state,approved_at_ms,approval_json)) FROM (SELECT * FROM ai_jobs ORDER BY id)",
            "SELECT json_group_array(json_array(attempt_id,evidence_json,evidence_sha256)) FROM (SELECT * FROM ai_transcript_evidence ORDER BY attempt_id)",
        ].iter().map(|sql| conn.query_row(sql, [], |r| r.get(0)).unwrap()).collect()
    }
    #[test]
    fn manual_missing_range_is_versioned_reversible_persistent_and_locally_adoptable() {
        let (directory, state) = fixture();
        let pending = job(&state, PENDING);
        let initial = view(&state, &pending).unwrap();
        assert_eq!(initial.range_edits.len(), 2);
        assert_eq!(initial.range_edits[1].version, 0);
        let charges = rusqlite::Connection::open(directory.path().join("charges.sqlite")).unwrap();
        let snapshot = charge_snapshot(&charges);
        let saved = save_manual_range(
            &state,
            &pending,
            &initial.draft.digest,
            1,
            0,
            authored_range(),
        )
        .unwrap();
        assert!(
            saved.can_apply,
            "{:?}; conflicts={:?}",
            saved.blocked_reason, saved.draft.conflicts
        );
        assert_eq!(saved.results[1].state, TranscriptResultState::Pending);
        assert_eq!(saved.draft.chunks[1].source, TranscriptRangeSource::Manual);
        assert!(saved.draft.chunks[1].original_segments.is_empty());
        assert_eq!(saved.range_edits[1].version, 1);
        assert!(
            save_manual_range(
                &state,
                &pending,
                &initial.draft.digest,
                1,
                1,
                authored_range()
            )
            .is_err()
        );
        assert!(
            save_manual_range(
                &state,
                &pending,
                &saved.draft.digest,
                1,
                0,
                authored_range()
            )
            .is_err()
        );
        let id = saved.range_edits[1].selected_revision_id.clone().unwrap();
        let original = select_range_source(
            &state,
            &pending,
            &saved.draft.digest,
            1,
            1,
            TranscriptRangeSelection::Original,
        )
        .unwrap();
        assert!(!original.can_apply);
        assert_eq!(
            original.draft.chunks[1].source,
            TranscriptRangeSource::Unresolved
        );
        let selected = select_range_source(
            &state,
            &pending,
            &original.draft.digest,
            1,
            2,
            TranscriptRangeSelection::Manual { revision_id: id },
        )
        .unwrap();
        assert_eq!(selected.range_edits[1].version, 3);
        assert!(selected.can_apply);
        assert_ne!(
            selected.draft.digest, saved.draft.digest,
            "Returning to an old revision must not revive an old adoption digest"
        );
        assert!(apply_review(&state, &pending, &saved.draft.digest).is_err());
        assert_eq!(charge_snapshot(&charges), snapshot);
        drop(state);
        let state = Services::open(directory.path().to_path_buf()).unwrap();
        let reloaded = view(&state, &pending).unwrap();
        assert_eq!(reloaded.draft, selected.draft);
        assert!(
            apply_review(&state, &pending, &reloaded.draft.digest)
                .unwrap()
                .applied
        );
        assert_eq!(state.ai.quote(&pending).unwrap().completed_requests, 1);
        assert_eq!(state.ai.quote(&pending).unwrap().state, "needs_review");
        assert_eq!(charge_snapshot(&charges), snapshot);
        assert!(
            save_manual_range(
                &state,
                &pending,
                &reloaded.draft.digest,
                1,
                3,
                authored_range()
            )
            .is_err()
        );
    }
    #[test]
    fn invalid_unknown_range_can_be_edited_and_adopted_without_settling_or_refunding() {
        let (directory, state) = fixture();
        let pending = job(&state, PENDING);
        let charges = rusqlite::Connection::open(directory.path().join("charges.sqlite")).unwrap();
        let attempt = uuid::Uuid::new_v4().to_string();
        charges.execute("INSERT INTO ai_attempts(id,job_id,ordinal,state,reserve_microusd,created_at_ms,dispatched_at_ms) VALUES(?,?,1,'unknown',12345,1,2)", rusqlite::params![attempt,pending]).unwrap();
        charges.execute("UPDATE ai_requests SET state='unknown',error_code='invalid_response' WHERE job_id=? AND ordinal=1", [&pending]).unwrap();
        let binding = load_binding(&state, &pending).unwrap();
        let receipt = receipt_for_job(&state, &binding).unwrap();
        let range = range_binding(&binding, &receipt, 1).unwrap();
        let evidence = TranscriptEvidence {
            attempt_id: attempt.clone(),
            job_id: pending.clone(),
            ordinal: 1,
            input_sha256: range.input_sha256,
            request_sha256: range.request_sha256,
            task_sha256: sha256_bytes(
                &serde_json::to_vec(&receipt.prepared_job.requests[1]).unwrap(),
            ),
            model_id: receipt.prepared_job.execution.model_id.clone(),
            parser_revision: "transcript-response-v1".into(),
            response: serde_json::json!({"candidates":[{"finishReason":"STOP","content":{"parts":[{"audioTranscription":{"text":"Authored invalid fixture.","words":[{"word":"Authored","startOffset":"2s","endOffset":"1s"}]}}]}}]}),
            complete: true,
            state: TranscriptResultState::Invalid,
            reason: Some(TranscriptResultReason::ReversedTime),
        };
        let evidence_json = serde_json::to_string(&evidence).unwrap();
        charges
            .execute(
                "INSERT INTO ai_transcript_evidence VALUES(?,?,?)",
                rusqlite::params![
                    attempt,
                    evidence_json,
                    sha256_bytes(evidence_json.as_bytes())
                ],
            )
            .unwrap();
        let before = charge_snapshot(&charges);
        let original = view(&state, &pending).unwrap();
        assert_eq!(original.results[1].state, TranscriptResultState::Invalid);
        assert_eq!(
            original.results[1].reason,
            Some(TranscriptResultReason::SettlementPending)
        );
        assert!(original.manual_editing_blocked_reason.is_none());
        let provider = serde_json::to_value(&original.results).unwrap();
        let saved = save_manual_range(
            &state,
            &pending,
            &original.draft.digest,
            1,
            0,
            authored_range(),
        )
        .unwrap();
        assert_eq!(serde_json::to_value(&saved.results).unwrap(), provider);
        assert!(
            saved.can_apply,
            "{:?}; conflicts={:?}",
            saved.blocked_reason, saved.draft.conflicts
        );
        assert!(
            apply_review(&state, &pending, &saved.draft.digest)
                .unwrap()
                .applied
        );
        assert_eq!(charge_snapshot(&charges), before);
        assert_eq!(
            state
                .ai
                .summary()
                .unwrap()
                .unknown_attempts
                .iter()
                .find(|a| a.id == attempt)
                .unwrap()
                .held_or_charged_microusd,
            Some(12345)
        );
    }
    #[test]
    fn manual_edits_require_pause_and_inflight_completion_but_survive_later_results() {
        let (directory, state) = fixture();
        let pending = job(&state, PENDING);
        let charges = rusqlite::Connection::open(directory.path().join("charges.sqlite")).unwrap();
        charges
            .execute("UPDATE ai_jobs SET state='approved' WHERE id=?", [&pending])
            .unwrap();
        let original = view(&state, &pending).unwrap();
        assert!(original.manual_editing_blocked_reason.is_some());
        assert!(
            save_manual_range(
                &state,
                &pending,
                &original.draft.digest,
                1,
                0,
                authored_range()
            )
            .is_err()
        );
        state.ai.pause(&pending).unwrap();
        let attempt = uuid::Uuid::new_v4().to_string();
        charges.execute("INSERT INTO ai_attempts(id,job_id,ordinal,state,reserve_microusd,created_at_ms,dispatched_at_ms) VALUES(?,?,1,'reserved',999,1,2)", rusqlite::params![attempt,pending]).unwrap();
        assert!(
            save_manual_range(
                &state,
                &pending,
                &original.draft.digest,
                1,
                0,
                authored_range()
            )
            .is_err()
        );
        state.ai.mark_unknown(&attempt).unwrap();
        let saved = save_manual_range(
            &state,
            &pending,
            &original.draft.digest,
            1,
            0,
            authored_range(),
        )
        .unwrap();
        assert!(
            saved.can_apply,
            "{:?}; conflicts={:?}",
            saved.blocked_reason, saved.draft.conflicts
        );
        // Simulate a separately recorded late result without changing the local
        // selection. No production recovery path automatically performs this.
        let output = serde_json::to_string(&ParsedOutput::Transcript {
            cues: vec![GeneratedCue {
                start_ms: 6000,
                end_ms: 6500,
                text: "Later provider result.".into(),
            }],
        })
        .unwrap();
        charges.execute("UPDATE ai_requests SET state='completed',response_json=? WHERE job_id=? AND ordinal=1", rusqlite::params![output,pending]).unwrap();
        let after_provider = charge_snapshot(&charges);
        let updated = view(&state, &pending).unwrap();
        assert_eq!(
            updated.range_edits[1].selected_revision_id,
            saved.range_edits[1].selected_revision_id
        );
        assert!(
            updated
                .draft
                .segments
                .iter()
                .any(|s| s.text == "Locally corrected.")
        );
        assert_eq!(
            updated.draft.chunks[1].original_segments[0].text,
            "Later provider result."
        );
        assert_ne!(updated.draft.digest, saved.draft.digest);
        assert_eq!(charge_snapshot(&charges), after_provider);
    }
    #[test]
    fn valid_empty_provider_results_require_explicit_no_speech_for_every_range() {
        let (directory, state) = fixture();
        let pending = job(&state, PENDING);
        let charges = rusqlite::Connection::open(directory.path().join("charges.sqlite")).unwrap();
        let output = serde_json::to_string(&ParsedOutput::Transcript { cues: vec![] }).unwrap();
        charges
            .execute(
                "UPDATE ai_requests SET state='completed',response_json=? WHERE job_id=?",
                rusqlite::params![output, pending],
            )
            .unwrap();
        let before = charge_snapshot(&charges);
        let original = view(&state, &pending).unwrap();
        // Provider parsing remains valid. Only the new application adoption
        // contract requires an explicit local decision about each empty range.
        assert!(original.draft.can_adopt);
        assert!(!original.can_apply);
        assert!(
            original
                .blocked_reason
                .unwrap()
                .contains("no-speech confirmation")
        );
        assert!(apply_review(&state, &pending, &original.draft.digest).is_err());
        let first = save_manual_range(
            &state,
            &pending,
            &original.draft.digest,
            0,
            0,
            ManualTranscriptContent::ConfirmedNoSpeech,
        )
        .unwrap();
        assert!(!first.can_apply);
        let complete = save_manual_range(
            &state,
            &pending,
            &first.draft.digest,
            1,
            0,
            ManualTranscriptContent::ConfirmedNoSpeech,
        )
        .unwrap();
        assert!(complete.can_apply, "{:?}", complete.blocked_reason);
        assert!(
            apply_review(&state, &pending, &complete.draft.digest)
                .unwrap()
                .applied
        );
        assert_eq!(charge_snapshot(&charges), before);
    }
    #[test]
    fn manual_empty_requires_explicit_silence_and_rejects_stale_source() {
        let (_directory, state) = fixture();
        let pending = job(&state, PENDING);
        let original = view(&state, &pending).unwrap();
        assert!(
            save_manual_range(
                &state,
                &pending,
                &original.draft.digest,
                1,
                0,
                ManualTranscriptContent::Subtitles { segments: vec![] }
            )
            .is_err()
        );
        assert_eq!(view(&state, &pending).unwrap().range_edits[1].version, 0);
        let silent = save_manual_range(
            &state,
            &pending,
            &original.draft.digest,
            1,
            0,
            ManualTranscriptContent::ConfirmedNoSpeech,
        )
        .unwrap();
        assert_eq!(
            silent.range_edits[1]
                .selected_revision
                .as_ref()
                .unwrap()
                .content,
            ManualTranscriptContent::ConfirmedNoSpeech
        );
        let mut segment = lock(&state.db)
            .unwrap()
            .list_segments(&silent.media_id)
            .unwrap()
            .remove(0);
        segment.text = "Independently edited original".into();
        lock(&state.db).unwrap().edit_segment(&segment).unwrap();
        assert!(
            save_manual_range(
                &state,
                &pending,
                &silent.draft.digest,
                1,
                1,
                authored_range()
            )
            .is_err()
        );
        assert!(apply_review(&state, &pending, &silent.draft.digest).is_err());
    }
    #[test]
    fn vad_warning_acknowledgement_survives_restart_and_requires_current_digest_for_adoption() {
        let (directory, state) = fixture();
        let complete = job(&state, COMPLETE);
        // Add authored VAD evidence to this private fixture and rebind its receipt
        // before any decisions exist. No model call or ledger mutation is made.
        let mut receipt = load_receipt(&state, COMPLETE).unwrap();
        receipt.vad_no_speech_ordinals = vec![0];
        surtitle_core::store::write_json_atomic(&receipt.directory.join("receipt.json"), &receipt)
            .unwrap();
        register_fixture_job(&state, &receipt, &state.ai.quote(&complete).unwrap(), None).unwrap();
        let original = view(&state, &complete).unwrap();
        assert_eq!(original.draft.warnings.len(), 1);
        assert!(!original.can_apply);
        let warning_id = original.draft.warnings[0].id.clone();
        assert!(!original.draft.warnings[0].acknowledged);
        assert!(acknowledge_review_warning(&state, &complete, "stale", &warning_id).is_err());
        assert_eq!(view(&state, &complete).unwrap().draft, original.draft);

        let boundary = resolve_review(
            &state,
            &complete,
            &original.draft.digest,
            &original.draft.conflicts[0].id,
            BoundaryChoice::Left,
        )
        .unwrap();
        assert!(
            !boundary.can_apply,
            "A resolved boundary must not silently acknowledge a VAD warning"
        );
        assert!(apply_review(&state, &complete, &boundary.draft.digest).is_err());
        assert!(
            acknowledge_review_warning(&state, &complete, &original.draft.digest, &warning_id)
                .is_err()
        );
        let checked =
            acknowledge_review_warning(&state, &complete, &boundary.draft.digest, &warning_id)
                .unwrap();
        assert!(checked.can_apply && checked.draft.warnings[0].acknowledged);
        assert_eq!(checked.draft.chunks, original.draft.chunks);
        let acknowledged_digest = checked.draft.digest.clone();
        assert_ne!(acknowledged_digest, boundary.draft.digest);

        drop(state);
        let state = Services::open(directory.path().to_path_buf()).unwrap();
        let reloaded = view(&state, &complete).unwrap();
        assert_eq!(reloaded.draft, checked.draft);
        assert!(reloaded.can_apply);
        assert!(
            acknowledge_review_warning(&state, &complete, &boundary.draft.digest, &warning_id)
                .is_err()
        );
        assert!(apply_review(&state, &complete, &boundary.draft.digest).is_err());
        assert!(
            apply_review(&state, &complete, &acknowledged_digest)
                .unwrap()
                .applied
        );
        assert!(
            acknowledge_review_warning(&state, &complete, &acknowledged_digest, &warning_id)
                .is_err()
        );

        drop(state);
        let state = Services::open(directory.path().to_path_buf()).unwrap();
        let adopted = view(&state, &complete).unwrap();
        assert!(adopted.applied && !adopted.can_apply);
        assert_eq!(adopted.draft, checked.draft);
        assert_eq!(
            state.ai.summary().unwrap().monthly_actual_charged_microusd,
            0
        );
        assert_eq!(state.ai.quote(&complete).unwrap().completed_requests, 2);
    }
    #[test]
    fn local_review_requires_all_chunks_and_explicit_resolution_then_preserves_edits_after_restart()
    {
        let (directory, state) = fixture();
        let complete = job(&state, COMPLETE);
        let pending = job(&state, PENDING);
        let original = view(&state, &complete).unwrap();
        assert!(!original.can_apply);
        assert_eq!(original.draft.conflicts.len(), 1);
        assert!(apply_review(&state, &complete, &original.draft.digest).is_err());
        let partial = view(&state, &pending).unwrap();
        assert!(!partial.can_apply);
        assert_eq!(partial.draft.pending_ranges.len(), 1);
        assert!(apply_review(&state, &pending, &partial.draft.digest).is_err());
        let reviewed = resolve_review(
            &state,
            &complete,
            &original.draft.digest,
            &original.draft.conflicts[0].id,
            BoundaryChoice::Left,
        )
        .unwrap();
        assert!(reviewed.can_apply);
        assert_eq!(reviewed.draft.chunks, original.draft.chunks);
        let digest = reviewed.draft.digest.clone();
        drop(state);
        let state = Services::open(directory.path().to_path_buf()).unwrap();
        assert_eq!(view(&state, &complete).unwrap().draft.digest, digest);
        assert!(apply_review(&state, &complete, &digest).unwrap().applied);
        let mut segment = lock(&state.db)
            .unwrap()
            .list_segments("e2e-transcript-review")
            .unwrap()
            .remove(0);
        segment.text = "A later manual correction.".into();
        segment.translation = Some("後の訳".into());
        lock(&state.db).unwrap().edit_segment(&segment).unwrap();
        drop(state);
        let state = Services::open(directory.path().to_path_buf()).unwrap();
        assert!(apply_review(&state, &complete, &digest).unwrap().applied);
        assert_eq!(
            lock(&state.db).unwrap().segment(&segment.id).unwrap().text,
            "A later manual correction."
        );
        assert_eq!(
            state.ai.summary().unwrap().monthly_actual_charged_microusd,
            0
        );
    }
    #[test]
    fn concurrent_decisions_using_one_digest_have_exactly_one_winner() {
        let (_directory, state) = fixture();
        let complete = job(&state, COMPLETE);
        let original = view(&state, &complete).unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let handles = [BoundaryChoice::Left, BoundaryChoice::Right]
            .into_iter()
            .map(|choice| {
                let state = state.clone();
                let id = complete.clone();
                let digest = original.draft.digest.clone();
                let boundary = original.draft.conflicts[0].id.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    resolve_review(&state, &id, &digest, &boundary, choice).is_ok()
                })
            })
            .collect::<Vec<_>>();
        assert_eq!(
            handles
                .into_iter()
                .filter(|handle| handle.thread().id() != std::thread::current().id())
                .map(|handle| u32::from(handle.join().unwrap()))
                .sum::<u32>(),
            1
        );
    }
    #[test]
    fn repair_quote_is_separate_blocked_and_cannot_replace_parent_or_survive_changed_decisions() {
        let (_directory, state) = fixture();
        let complete = job(&state, COMPLETE);
        let repair = job(&state, REPAIR);
        let quoted = serde_json::to_value(create_audio_quote(&state, REPAIR).unwrap()).unwrap();
        assert_eq!(quoted["canApprove"], false);
        assert!(quoted["maximumUsd"].as_f64().unwrap() > 0.0);
        assert_eq!(state.ai.quote(&repair).unwrap().state, "prepared");
        assert!(
            apply_review(
                &state,
                &repair,
                &view(&state, &repair).unwrap().draft.digest
            )
            .is_err()
        );
        let original = view(&state, &complete).unwrap();
        resolve_review(
            &state,
            &complete,
            &original.draft.digest,
            &original.draft.conflicts[0].id,
            BoundaryChoice::Left,
        )
        .unwrap();
        assert!(create_audio_quote(&state, REPAIR).is_err());
        assert!(verify_audio_plan(&state, &state.ai.prepared_job(&repair).unwrap()).is_err());
        assert_eq!(
            state.ai.summary().unwrap().monthly_actual_charged_microusd,
            0
        );
    }
    #[test]
    fn unavailable_unrelated_preparation_and_deleted_audio_do_not_hide_received_results() {
        let (_directory, state) = fixture();
        let complete = job(&state, COMPLETE);
        let directory = state.root.join("prepared").join("broken-unrelated");
        fs::create_dir(&directory).unwrap();
        fs::write(directory.join("receipt.json"), b"broken json").unwrap();
        let receipt = load_receipt(&state, COMPLETE).unwrap();
        fs::remove_file(
            &audio_attachment(&receipt.prepared_job.requests[0])
                .unwrap()
                .path,
        )
        .unwrap();
        assert_eq!(
            view(&state, &complete).unwrap().draft.chunks[0].status,
            "received"
        );
        assert!(create_audio_quote(&state, COMPLETE).is_err());
    }
    #[test]
    fn credential_rotation_requotes_the_same_immutable_audio_without_regeneration() {
        let (_directory, state) = fixture();
        let previous = job(&state, PENDING);
        {
            let mut preferences = lock(&state.preferences).unwrap();
            preferences.settings.vertex_project = "another-project".into();
            preferences.credential_id = Some("c".repeat(64));
        }
        let quote = serde_json::to_value(create_audio_quote(&state, PENDING).unwrap()).unwrap();
        let new_id = quote["id"].as_str().unwrap();
        assert_ne!(new_id, previous);
        assert_eq!(
            state.ai.prepared_job(new_id).unwrap().requests,
            state.ai.prepared_job(&previous).unwrap().requests
        );
        assert_eq!(quote["canApprove"], false);
        assert_eq!(state.ai.quote(new_id).unwrap().completed_requests, 0);
    }
}
