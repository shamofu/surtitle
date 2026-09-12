//! Local study excerpts are independent of whole-track adoption and paid work.
use super::*;
use anyhow::bail;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use surtitle_core::{DraftStudySelection, DraftStudySelectionEdit, SubtitleSegment};

const QUOTE_PREFIX: &str = "draft-study:";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SourceSnapshot {
    selection: StudySelectionSnapshot,
    job_digest: String,
    path: String,
    audio_stream_index: Option<u32>,
    source_bytes: u64,
    source_modified_ns: u128,
    evidence: Vec<(u32, Option<String>)>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionView {
    #[serde(flatten)]
    selection: Value,
    stale: bool,
    blocking_reasons: Vec<String>,
    can_confirm: bool,
}

fn source_evidence(
    state: &AppState,
    job: &str,
    snapshot: &StudySelectionSnapshot,
) -> Result<Vec<(u32, Option<String>)>> {
    snapshot
        .relevant_chunks
        .iter()
        .map(|chunk| {
            let detail = state.ai.transcript_result_detail(job, chunk.ordinal)?;
            Ok((chunk.ordinal, detail.evidence_sha256))
        })
        .collect()
}

fn validate_source(
    state: &AppState,
    selected: &DraftStudySelection,
    hash: bool,
) -> Result<SourceSnapshot> {
    let job = selected
        .job_id
        .as_deref()
        .context("This restored bookmark needs a new source selection")?;
    let saved: SourceSnapshot = serde_json::from_value(selected.source_snapshot.clone())?;
    let binding = load_binding(state, job)?;
    ensure!(
        binding.job_digest == saved.job_digest,
        "Source job changed; select the range again"
    );
    let (receipt, draft, _) = load_draft(state, &binding)?;
    validate_study_selection_snapshot(&draft, &saved.selection)?;
    ensure!(
        source_evidence(state, job, &saved.selection)? == saved.evidence,
        "Received evidence changed; select the range again"
    );
    let media = lock(&state.db)?.media(&selected.media_id)?;
    ensure!(
        media.id == saved.selection.media_id
            && media.path == saved.path
            && media.audio_stream_index == saved.audio_stream_index,
        "The source media or audio track changed"
    );
    ensure!(
        selected.source_start_ms == saved.selection.range.start_ms
            && selected.source_end_ms == saved.selection.range.end_ms,
        "Stored source bounds changed"
    );
    ensure!(
        Path::new(&media.path).is_file(),
        "The source media is missing"
    );
    let (bytes, modified) = source_metadata(Path::new(&media.path))?;
    ensure!(
        bytes == saved.source_bytes && modified == saved.source_modified_ns,
        "The source media file changed"
    );
    ensure!(
        receipt.prepared_job.requests.iter().all(|task| match task {
            RequestTask::AudioTranscription { language, .. }
            | RequestTask::TranscribePreview { language, .. } =>
                *language == media.learning_language,
            _ => false,
        }),
        "The source language changed"
    );
    if hash {
        ensure!(
            surtitle_tools::sha256_file(Path::new(&media.path))? == saved.selection.source_sha256,
            "Source audio changed; select and prepare it again"
        );
    }
    Ok(saved)
}

fn selection_view(state: &AppState, selected: DraftStudySelection) -> Result<SelectionView> {
    let checked = validate_source(state, &selected, false);
    let mut reasons = checked
        .as_ref()
        .err()
        .map(|error| vec![error.to_string()])
        .unwrap_or_default();
    if let Ok(source) = &checked
        && !source.selection.confirmation_blockers.is_empty()
    {
        reasons.push("The original range has timing, boundary, or missing-response warnings. Confirm only the excerpt you reviewed; original warnings remain.".into());
    }
    let mut value = serde_json::to_value(&selected)?;
    value
        .as_object_mut()
        .context("Invalid selection")?
        .remove("sourceSnapshot");
    value
        .as_object_mut()
        .context("Invalid selection")?
        .insert("jobId".into(), json!(selected.job_id));
    Ok(SelectionView {
        selection: value,
        stale: checked.is_err(),
        blocking_reasons: reasons,
        can_confirm: checked.is_ok(),
    })
}

fn source_metadata(path: &Path) -> Result<(u64, u128)> {
    let metadata = std::fs::metadata(path)?;
    Ok((
        metadata.len(),
        metadata
            .modified()?
            .duration_since(std::time::UNIX_EPOCH)?
            .as_nanos(),
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrepareSelection {
    job_id: String,
    cue_ids: Option<Vec<String>>,
    ordinal: Option<u32>,
}

fn source_block_text(state: &AppState, job: &str, ordinal: u32) -> Result<String> {
    let detail = state.ai.transcript_result_detail(job, ordinal)?;
    // Read one unambiguous provider text field; never infer timestamps from it.
    let Some(evidence) = detail.evidence else {
        return Ok(String::new());
    };
    let Some(candidates) = evidence
        .response
        .get("candidates")
        .and_then(Value::as_array)
        .filter(|items| items.len() == 1)
    else {
        return Ok(String::new());
    };
    let parts = candidates[0]
        .pointer("/content/parts")
        .and_then(Value::as_array);
    let texts = parts
        .into_iter()
        .flatten()
        .filter(|part| part.get("thought").and_then(Value::as_bool) != Some(true))
        .filter_map(|part| {
            part.pointer("/audioTranscription/text")
                .and_then(Value::as_str)
        })
        .collect::<Vec<_>>();
    ensure!(
        texts.len() <= 1,
        "Source response has multiple text alternatives; inspect the original evidence"
    );
    let value = texts.first().copied().unwrap_or("");
    ensure!(
        value.len() <= 128 * 1024,
        "Source text exceeds the local editor limit"
    );
    Ok(value.into())
}

fn prepare_selection(state: &AppState, request: PrepareSelection) -> Result<SelectionView> {
    let binding = load_binding(state, &request.job_id)?;
    let (_, draft, _) = load_draft(state, &binding)?;
    let selection = match (&request.cue_ids, request.ordinal) {
        (Some(ids), None) => StudySelectionRequest::Cues {
            cue_ids: ids.clone(),
        },
        (None, Some(ordinal)) => StudySelectionRequest::SourceChunk { ordinal },
        _ => bail!("Choose existing cues or one source block"),
    };
    let snapshot = build_study_selection_snapshot(&draft, &selection)?;
    let media = lock(&state.db)?.media(&draft.media_id)?;
    let evidence = source_evidence(state, &request.job_id, &snapshot)?;
    let manual_block = request.ordinal.is_some_and(|ordinal| {
        draft.chunks.iter().any(|chunk| {
            chunk.ordinal == ordinal && chunk.source == surtitle_ai::TranscriptRangeSource::Manual
        })
    });
    let text = if let Some(ordinal) = request.ordinal {
        if manual_block {
            snapshot.selected_text.clone()
        } else {
            source_block_text(state, &request.job_id, ordinal)?
        }
    } else {
        snapshot.selected_text.clone()
    };
    let (source_bytes, source_modified_ns) = source_metadata(Path::new(&media.path))?;
    let source_snapshot = SourceSnapshot {
        selection: snapshot.clone(),
        job_digest: binding.job_digest,
        path: media.path,
        audio_stream_index: media.audio_stream_index,
        source_bytes,
        source_modified_ns,
        evidence,
    };
    let manual = snapshot
        .relevant_chunks
        .iter()
        .filter(|chunk| chunk.source == surtitle_ai::TranscriptRangeSource::Manual)
        .count();
    let origin = if request.ordinal.is_some() {
        if manual_block { "manual" } else { "ai" }
    } else if manual == snapshot.relevant_chunks.len() && manual > 0 {
        "manual"
    } else if manual > 0 {
        "mixed"
    } else {
        "ai"
    };
    let selected = DraftStudySelection {
        id: surtitle_core::id(),
        media_id: draft.media_id,
        job_id: Some(request.job_id),
        version: 1,
        text,
        start_ms: snapshot.range.start_ms,
        end_ms: snapshot.range.end_ms,
        source_start_ms: snapshot.range.start_ms,
        source_end_ms: snapshot.range.end_ms,
        cue_ids: request.cue_ids.unwrap_or_default(),
        ordinal: request.ordinal,
        origin: origin.into(),
        timing: if request.ordinal.is_some() {
            "source_block"
        } else {
            "cue"
        }
        .into(),
        confirmed: false,
        created_at: String::new(),
        updated_at: String::new(),
        source_snapshot: serde_json::to_value(source_snapshot)?,
    };
    validate_source(state, &selected, true)?;
    let saved = lock(&state.db)?.insert_draft_study_selection(&selected)?;
    selection_view(state, saved)
}

#[tauri::command]
pub async fn prepare_draft_selection(
    state: State<'_, AppState>,
    request: PrepareSelection,
) -> std::result::Result<SelectionView, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock(&state.transcript_review)?;
        prepare_selection(&state, request)
    })
    .await
    .map_err(|_| "Selection preparation interrupted".to_string())?
    .map_err(err)
}

#[tauri::command]
pub async fn list_draft_selections(
    state: State<'_, AppState>,
    media_id: String,
) -> std::result::Result<Vec<SelectionView>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock(&state.transcript_review)?;
        let selections = lock(&state.db)?.list_draft_study_selections(&media_id)?;
        selections
            .into_iter()
            .map(|selection| selection_view(&state, selection))
            .collect::<Result<Vec<_>>>()
    })
    .await
    .map_err(|_| "Bookmark loading interrupted".to_string())?
    .map_err(err)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateSelection {
    id: String,
    version: u64,
    text: String,
    start_ms: u64,
    end_ms: u64,
    confirm: bool,
}

fn update_selection(state: &AppState, request: UpdateSelection) -> Result<SelectionView> {
    let selected = lock(&state.db)?.draft_study_selection(&request.id)?;
    ensure!(
        selected.version == request.version,
        "This bookmark changed; reopen it"
    );
    validate_source(state, &selected, request.confirm)?;
    let saved = lock(&state.db)?.update_draft_study_selection(
        &request.id,
        request.version,
        &DraftStudySelectionEdit {
            text: request.text,
            start_ms: request.start_ms,
            end_ms: request.end_ms,
            confirmed: request.confirm,
        },
    )?;
    selection_view(state, saved)
}

#[tauri::command]
pub async fn update_draft_selection(
    state: State<'_, AppState>,
    request: UpdateSelection,
) -> std::result::Result<SelectionView, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock(&state.transcript_review)?;
        update_selection(&state, request)
    })
    .await
    .map_err(|_| "Bookmark update interrupted".to_string())?
    .map_err(err)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SelectionVersion {
    id: String,
    version: u64,
}

#[tauri::command]
pub fn remove_draft_selection(
    state: State<'_, AppState>,
    request: SelectionVersion,
) -> std::result::Result<(), String> {
    (|| {
        let _guard = lock(&state.transcript_review)?;
        lock(&state.db)?.remove_draft_study_selection(&request.id, request.version)
    })()
    .map_err(err)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SelectionCard {
    selection_id: String,
    version: u64,
    term: String,
    meaning: String,
    explanation: Option<String>,
    translation: Option<String>,
}

fn confirmed_selection(
    state: &AppState,
    id: &str,
    version: u64,
    hash: bool,
) -> Result<(DraftStudySelection, SubtitleSegment)> {
    let (selected, cue) = {
        let db = lock(&state.db)?;
        (
            db.draft_study_selection(id)?,
            db.draft_study_source_cue(id, version)?,
        )
    };
    validate_source(state, &selected, hash)?;
    Ok((selected, cue))
}

#[tauri::command]
pub async fn save_draft_selection_card(
    state: State<'_, AppState>,
    request: SelectionCard,
) -> std::result::Result<(), String> {
    let state = state.inner().clone();
    async {
        let (selected, cue) = {
            let _guard = lock(&state.transcript_review)?;
            confirmed_selection(&state, &request.selection_id, request.version, true)?
        };
        crate::tool_commands::ensure_audio_stream(&state, &selected.media_id).await?;
        let media = lock(&state.db)?.media(&selected.media_id)?;
        let clip = surtitle_core::replay_range(
            cue.start_ms,
            cue.end_ms,
            media.duration_ms,
            state.settings()?.replay_context_ms,
        )?;
        let audio = crate::tool_commands::extract_card_audio(&state, &media, &cue, clip).await?;
        let saved = (|| {
            let _guard = lock(&state.transcript_review)?;
            let (current, _) =
                confirmed_selection(&state, &request.selection_id, request.version, true)?;
            let db = lock(&state.db)?;
            let current_media = db.media(&selected.media_id)?;
            ensure!(
                current_media.path == media.path
                    && current_media.audio_stream_index == media.audio_stream_index
                    && current_media.learning_language == media.learning_language
                    && current_media.explanation_language == media.explanation_language,
                "The source media changed while extracting audio; review the excerpt again"
            );
            db.save_draft_selection_card(
                &request.selection_id,
                request.version,
                &surtitle_core::DraftStudyCardFields {
                    term: request.term,
                    meaning: request.meaning,
                    example: current.text,
                    explanation: request.explanation,
                    translation: request.translation,
                },
                Some(audio.to_string_lossy().into_owned()),
                Some(clip),
            )?;
            Ok(())
        })();
        if saved.is_err() {
            let _ = std::fs::remove_file(audio);
        }
        saved
    }
    .await
    .map_err(err)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SelectionQuote {
    selection_id: String,
    version: u64,
    focus_term: Option<String>,
    model: surtitle_core::AiModelPreference,
}

pub(crate) fn quote_selection(plan: &PreparedJob) -> Result<Option<(String, u64)>> {
    let Some(binding) = plan.binding.transcript_revision.strip_prefix(QUOTE_PREFIX) else {
        return Ok(None);
    };
    let (id, version) = binding
        .rsplit_once(':')
        .context("Invalid draft study quote")?;
    uuid_id(id)?;
    Ok(Some((id.into(), version.parse()?)))
}

pub(crate) fn verify_quote(state: &AppState, plan: &PreparedJob, hash: bool) -> Result<()> {
    if let Some((id, version)) = quote_selection(plan)? {
        let (selected, _) = confirmed_selection(state, &id, version, hash)?;
        ensure!(
            selected.media_id == plan.binding.media_id,
            "Draft quote media changed"
        );
    }
    Ok(())
}

pub(crate) fn verify_quote_cues(db: &surtitle_core::Store, plan: &PreparedJob) -> Result<bool> {
    let Some((id, version)) = quote_selection(plan)? else {
        return Ok(false);
    };
    let cue = db.draft_study_source_cue(&id, version)?;
    ensure!(
        cue.media_id == plan.binding.media_id && plan.requests.len() == 1,
        "Draft study quote changed"
    );
    let sources = match &plan.requests[0] {
        RequestTask::Explanation { cues, .. } | RequestTask::Vocabulary { cues, .. } => cues,
        _ => bail!("Unsupported draft study task"),
    };
    ensure!(
        sources.len() == 1
            && sources[0].id == cue.id
            && sources[0].text == cue.text
            && sources[0].start_ms == cue.start_ms
            && sources[0].end_ms == cue.end_ms,
        "Confirmed study input changed; create a new quote"
    );
    ensure!(
        sha256_bytes(&serde_json::to_vec(sources)?) == plan.binding.source_sha256,
        "Draft study input fingerprint changed"
    );
    Ok(true)
}

#[tauri::command]
pub async fn create_draft_selection_quote(
    state: State<'_, AppState>,
    request: SelectionQuote,
) -> std::result::Result<crate::ai_commands::AiQuote, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock(&state.transcript_review)?;
        let (selected, cue) =
            confirmed_selection(&state, &request.selection_id, request.version, true)?;
        let media = lock(&state.db)?.media(&selected.media_id)?;
        let p = lock(&state.preferences)?.clone();
        let credential = p
            .credential_id
            .context("Import a service-account key in Settings")?;
        let cues = vec![SourceCue {
            id: cue.id,
            start_ms: cue.start_ms,
            end_ms: cue.end_ms,
            text: cue.text,
        }];
        let term = request
            .focus_term
            .as_deref()
            .map(str::trim)
            .filter(|term| !term.is_empty());
        let task = if let Some(term) = term {
            RequestTask::Explanation {
                term: term.into(),
                learning_language: media.learning_language,
                explanation_language: media.explanation_language,
                proficiency: p.settings.proficiency.clone(),
                cues: cues.clone(),
            }
        } else {
            RequestTask::Vocabulary {
                learning_language: media.learning_language,
                explanation_language: media.explanation_language,
                cues: cues.clone(),
                max_items: 20,
            }
        };
        let execution = crate::model_commands::execution_for(
            &p.settings,
            if term.is_some() {
                "explanation"
            } else {
                "vocabulary"
            },
            Some(request.model),
        )?;
        let quote = state.ai.prepare(PreparedJob::new(
            format!("{} · study excerpt", media.title),
            p.settings.vertex_project.clone(),
            credential,
            PreparationBinding {
                media_id: media.id.clone(),
                transcript_revision: format!("{QUOTE_PREFIX}{}:{}", selected.id, selected.version),
                source_sha256: sha256_bytes(&serde_json::to_vec(&cues)?),
                settings_sha256: crate::ai_commands::settings_fingerprint(&p.settings)?,
            },
            vec![task],
            execution,
        )?)?;
        {
            let mut p = lock(&state.preferences)?;
            p.quotes.insert(
                quote.id.clone(),
                QuoteContext {
                    media_id: media.id,
                    kind: "vocabulary".into(),
                    start_ms: selected.start_ms,
                    end_ms: selected.end_ms,
                },
            );
            state.save_preferences(&p)?;
        }
        let quote = if quote.state == "prepared"
            && quote.quote_expires_at_ms <= chrono::Utc::now().timestamp_millis()
        {
            state.ai.refresh_quote(&quote.id)?
        } else {
            quote
        };
        let retry = quote.state != "prepared" || quote.already_charged_or_held_microusd > 0;
        crate::ai_commands::quote_for_ui(&state, quote, retry)
    })
    .await
    .map_err(|_| "Study quote interrupted".to_string())?
    .map_err(err)
}

#[tauri::command]
pub async fn list_draft_selection_candidates(
    state: State<'_, AppState>,
    request: SelectionVersion,
) -> std::result::Result<Vec<Value>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock(&state.transcript_review)?;
        let (selected, cue) = confirmed_selection(&state, &request.id, request.version, false)?;
        let mut results = Vec::new();
        for job in state.ai.list_jobs()? {
            if job.binding.transcript_revision != format!("{QUOTE_PREFIX}{}:{}", selected.id, selected.version) { continue; }
            let plan = state.ai.prepared_job(&job.id)?;
            crate::ai_commands::verify_application_binding(&state, &plan)?;
            if let Some(ParsedOutput::Vocabulary { items }) = state.ai.response(&job.id, 0)? {
                for (index, item) in items.into_iter().enumerate() {
                    let explanation = if item.example.trim() == selected.text.trim() { item.explanation } else { format!("{}\n\nAdditional generated example: {}", item.explanation, item.example) };
                    results.push(json!({ "id": format!("{}-0-{index}", job.id), "mediaId":selected.media_id, "segmentId":cue.id, "term":item.term, "meaning":item.meaning, "example":selected.text, "explanation":explanation, "translation":null, "sourceCueIds":[cue.id], "startMs":selected.start_ms, "endMs":selected.end_ms }));
                }
            }
        }
        Ok(results)
    }).await.map_err(|_| "Saved study results loading interrupted".to_string())?.map_err(err)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportSelection {
    id: String,
    version: u64,
    format: String,
}

#[tauri::command]
pub async fn export_draft_selection(
    state: State<'_, AppState>,
    request: ExportSelection,
) -> std::result::Result<(), String> {
    async {
        ensure!(["json", "srt", "vtt"].contains(&request.format.as_str()), "Unsupported excerpt format");
        let Some(file) = rfd::AsyncFileDialog::new().set_file_name(format!("study-excerpt.{}", request.format)).save_file().await else { return Ok(()); };
        let _guard = lock(&state.transcript_review)?;
        let selected = lock(&state.db)?.draft_study_selection(&request.id)?;
        ensure!(selected.version == request.version, "The bookmark changed; export it again");
        let mut portable = serde_json::to_value(&selected)?;
        portable.as_object_mut().context("Invalid selection")?.remove("sourceSnapshot");
        portable.as_object_mut().context("Invalid selection")?.remove("jobId");
        let coverage = json!({ "format":"surtitle.study-excerpt", "schemaVersion":1, "coverage":"selected_range_only", "wholeTranscriptAdopted":false, "selection":portable });
        let contents = if request.format == "json" { serde_json::to_string_pretty(&coverage)? } else {
            let (_, cue) = confirmed_selection(&state, &request.id, request.version, false)?;
            surtitle_core::subtitles::format(&[cue], request.format == "vtt", false)
        };
        // Explicit subtitle exports include coverage in a separately named receipt.
        // Never overwrite a pre-existing receipt as an incidental side effect.
        if request.format != "json" {
            let receipt = file.path().with_extension(format!("{}.coverage.json", surtitle_core::id()));
            let mut output = std::fs::OpenOptions::new().write(true).create_new(true).open(receipt)?;
            std::io::Write::write_all(&mut output, &serde_json::to_vec_pretty(&coverage)?)?;
        }
        std::fs::write(file.path(), contents)?;
        Ok(())
    }.await.map_err(err)
}

#[cfg(all(test, feature = "e2e-test"))]
mod tests;
