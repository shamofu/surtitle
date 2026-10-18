use super::*;

pub(super) fn apply_received_output(
    state: &AppState,
    job_id: &str,
    ordinal: u32,
    plan: &PreparedJob,
    output: ParsedOutput,
) -> Result<()> {
    if matches!(&output, ParsedOutput::Transcript { .. }) {
        crate::application::transcript::automatic::apply_progress(state, job_id)?;
        return Ok(());
    }
    let response_hash = sha256_bytes(&serde_json::to_vec(&output)?);
    // An already applied response is a completed local operation. Its durable
    // marker takes precedence over later source edits, and this path writes nothing.
    if matches!(&output, ParsedOutput::Translation { .. })
        && lock(&state.db)?.ai_result_applied(job_id, ordinal, &response_hash)?
    {
        return Ok(());
    }
    // Hold the same DB mutex across validation and writes to prevent a concurrent
    // subtitle edit from slipping between the check and translation application.
    verify_application_binding(state, plan).map_err(|_| AiError::PreparationChanged)?;
    let mut db = lock(&state.db)?;
    verify_task_sources(&db, plan).map_err(|_| AiError::PreparationChanged)?;
    let updates_translation = matches!(&output, ParsedOutput::Translation { .. });
    if let ParsedOutput::Translation { translations } = output {
        let Some(RequestTask::Translation { cues, .. }) = plan.requests.get(ordinal as usize)
        else {
            bail!("saved translation does not match its request");
        };
        ensure!(
            translations.len() == cues.len(),
            "saved translation count changed"
        );
        let mut updates = Vec::with_capacity(translations.len());
        for translated in translations {
            ensure!(
                cues.iter().any(|cue| cue.id == translated.id),
                "saved translation references another request"
            );
            let mut source = db.segment(&translated.id)?;
            source.translation = Some(translated.translation);
            updates.push(source);
        }
        db.apply_translations_once(job_id, ordinal, &response_hash, &updates)?;
    }
    drop(db);
    if updates_translation {
        crate::application::playback::refresh_current_subtitles(state, &plan.binding.media_id)?;
    }
    Ok(())
}

pub(super) fn saved_results(state: &AppState, job_id: &str) -> Result<Vec<SavedAiResult>> {
    let plan = state.ai.prepared_job(job_id)?;
    if !plan
        .requests
        .iter()
        .any(|task| matches!(task, RequestTask::Translation { .. }))
    {
        return Ok(Vec::new());
    }
    let valid = verify_application_binding(state, &plan).is_ok();
    let mut results = Vec::new();
    for (ordinal, task) in plan.requests.iter().enumerate() {
        let RequestTask::Translation { cues, .. } = task else {
            continue;
        };
        let Some(output @ ParsedOutput::Translation { .. }) =
            state.ai.response(job_id, ordinal as u32)?
        else {
            continue;
        };
        let hash = sha256_bytes(&serde_json::to_vec(&output)?);
        let applied = lock(&state.db)?.ai_result_applied(job_id, ordinal as u32, &hash)?;
        let ParsedOutput::Translation { translations } = output else {
            unreachable!()
        };
        let translations = translations
            .into_iter()
            .map(|translation| {
                let source = cues
                    .iter()
                    .find(|source| source.id == translation.id)
                    .context("saved translation source missing")?;
                Ok(SavedTranslation {
                    source: source.text.clone(),
                    translation: translation.translation,
                    start_ms: source.start_ms,
                    end_ms: source.end_ms,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        results.push(SavedAiResult {
            job_id: job_id.into(),
            ordinal: ordinal as u32,
            applied,
            can_apply: valid && !applied,
            blocked_reason: if valid || applied {
                None
            } else {
                Some(
                    "元字幕・言語・習熟度が変わっています。保存結果は保持しますが適用できません。"
                        .into(),
                )
            },
            translations,
        });
    }
    Ok(results)
}

/// Reading saved output never refreshes an approval or contacts Vertex.
pub fn list_saved_ai_results(
    state: AppState,
    job_id: String,
) -> std::result::Result<Vec<SavedAiResult>, String> {
    saved_results(&state, &job_id).map_err(err)
}

pub(super) fn apply_saved_result(state: &AppState, job_id: &str, ordinal: u32) -> Result<()> {
    let plan = state.ai.prepared_job(job_id)?;
    let output = state
        .ai
        .response(job_id, ordinal)?
        .context("no received result was saved")?;
    ensure!(
        matches!(output, ParsedOutput::Translation { .. }),
        "this saved output is not a translation"
    );
    apply_received_output(state, job_id, ordinal, &plan, output)
}

/// Explicit local recovery after an interruption between settlement and application.
pub fn apply_saved_ai_result(
    state: AppState,
    job_id: String,
    ordinal: u32,
) -> std::result::Result<(), String> {
    (|| {
        apply_saved_result(&state, &job_id, ordinal)?;
        if saved_results(&state, &job_id)?
            .iter()
            .all(|result| result.applied)
        {
            state.ai.finish_local_application(&job_id)?;
            if state
                .ai
                .job_issue(&job_id)?
                .is_some_and(|issue| issue.code == "local_apply")
            {
                state.ai.clear_job_issue(&job_id)?;
            }
        }
        Ok(())
    })()
    .map_err(err)
}

pub fn list_vocabulary_candidates(
    state: AppState,
    media_id: String,
) -> std::result::Result<Vec<VocabularyCandidate>, String> {
    (|| {
        let mut out = Vec::new();
        for q in state
            .ai
            .list_jobs()?
            .into_iter()
            .filter(|q| q.binding.media_id == media_id)
        {
            let plan = state.ai.prepared_job(&q.id)?;
            if crate::application::transcript::study::quote_selection(&plan)?.is_some() {
                continue;
            }
            if verify_task_sources(&*lock(&state.db)?, &plan).is_err() {
                continue;
            }
            for request in &q.requests {
                if let Some(ParsedOutput::Vocabulary { items }) =
                    state.ai.response(&q.id, request.ordinal)?
                {
                    for (i, item) in items.into_iter().enumerate() {
                        let mut sources = item
                            .source_cue_ids
                            .iter()
                            .map(|id| lock(&state.db)?.segment(id))
                            .collect::<Result<Vec<_>>>()?;
                        sources.sort_by_key(|source| source.start_ms);
                        let segment_id = sources
                            .first()
                            .context("candidate has no source")?
                            .id
                            .clone();
                        let separator = if lock(&state.db)?
                            .media(&media_id)?
                            .learning_language
                            .starts_with("ja")
                        {
                            ""
                        } else {
                            " "
                        };
                        let example = sources
                            .iter()
                            .map(|source| source.text.as_str())
                            .collect::<Vec<_>>()
                            .join(separator);
                        let translation = sources
                            .iter()
                            .map(|source| source.translation.as_deref())
                            .collect::<Option<Vec<_>>>()
                            .map(|parts| parts.join(" "));
                        let language = state.preferences.read()?.settings.locale.clone();
                        let explanation = if item.example.trim() == example.trim() {
                            item.explanation
                        } else {
                            format!(
                                "{}\n\n{}: {}",
                                item.explanation,
                                if language == "ja" {
                                    "別の用例（出典音声とは異なります）"
                                } else {
                                    "Additional example (not the source audio)"
                                },
                                item.example
                            )
                        };
                        out.push(VocabularyCandidate {
                            id: format!("{}-{}-{i}", q.id, request.ordinal),
                            media_id: media_id.clone(),
                            segment_id,
                            term: item.term,
                            meaning: item.meaning,
                            example,
                            explanation,
                            translation,
                            source_cue_ids: sources
                                .iter()
                                .map(|source| source.id.clone())
                                .collect(),
                            start_ms: sources
                                .iter()
                                .map(|source| source.start_ms)
                                .min()
                                .context("missing source")?,
                            end_ms: sources
                                .iter()
                                .map(|source| source.end_ms)
                                .max()
                                .context("missing source")?,
                        });
                    }
                }
            }
        }
        Ok(out)
    })()
    .map_err(err)
}
