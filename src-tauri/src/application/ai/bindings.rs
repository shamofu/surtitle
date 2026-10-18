use super::*;

pub(crate) fn transcript_fingerprint(
    segments: &[surtitle_core::SubtitleSegment],
) -> Result<String> {
    surtitle_core::store::subtitle_revision(segments)
}

pub(crate) fn settings_fingerprint(settings: &surtitle_core::AppSettings) -> Result<String> {
    Ok(sha256_bytes(&serde_json::to_vec(&(
        &settings.vertex_project,
        &settings.vertex_location,
    ))?))
}

pub(super) fn source_matches(
    original: &SourceCue,
    current: &surtitle_core::SubtitleSegment,
    media_id: &str,
) -> bool {
    current.id == original.id
        && current.media_id == media_id
        && current.start_ms == original.start_ms
        && current.end_ms == original.end_ms
        && current.text == original.text
        && surtitle_core::is_usable_subtitle_status(&current.status)
}

pub(super) fn verify_task_sources(db: &surtitle_core::Store, plan: &PreparedJob) -> Result<()> {
    let media = db.media(&plan.binding.media_id)?;
    let draft_study = crate::application::transcript::study::verify_quote_cues(db, plan)?;
    if plan.apply_policy != TranscriptApplyPolicy::Auto
        && plan.requests.iter().any(|task| {
            matches!(
                task,
                RequestTask::AudioTranscription { .. } | RequestTask::TranscribePreview { .. }
            )
        })
    {
        ensure!(
            transcript_fingerprint(&db.list_segments(&media.id)?)?
                == plan.binding.transcript_revision,
            "source subtitle revision changed"
        );
    }
    for task in &plan.requests {
        let cues = match task {
            RequestTask::Vocabulary {
                learning_language,
                explanation_language,
                cues,
                ..
            }
            | RequestTask::Explanation {
                learning_language,
                explanation_language,
                cues,
                ..
            } => {
                ensure!(
                    *learning_language == media.learning_language
                        && *explanation_language == media.explanation_language,
                    "languages changed; create a new quote"
                );
                cues
            }
            RequestTask::Translation {
                target_language,
                cues,
            } => {
                ensure!(
                    *target_language == media.explanation_language,
                    "translation language changed; create a new quote"
                );
                cues
            }
            RequestTask::AudioTranscription { language, .. }
            | RequestTask::TranscribePreview { language, .. } => {
                ensure!(
                    *language == media.learning_language,
                    "learning language changed; prepare a new audio quote"
                );
                continue;
            }
            // Workspace builds may unify the development-only diagnostic variant.
            #[allow(unreachable_patterns)]
            _ => bail!("Development diagnostics cannot be applied to learning media"),
        };
        if draft_study {
            continue;
        }
        for original in cues {
            let current = db.segment(&original.id)?;
            ensure!(
                source_matches(original, &current, &plan.binding.media_id),
                "approved source subtitles changed; output was retained for review and further sending stopped"
            );
        }
    }
    Ok(())
}

pub(super) fn verify_current_binding(state: &AppState, plan: &PreparedJob) -> Result<()> {
    let p = state.preferences.read()?;
    ensure!(
        settings_fingerprint(&p.settings)? == plan.binding.settings_sha256
            && p.credential_id.as_deref() == Some(plan.credential_id.as_str()),
        "Vertex project or credential changed; create a new quote"
    );
    for task in &plan.requests {
        if let RequestTask::Explanation { proficiency, .. } = task {
            ensure!(
                *proficiency == p.settings.proficiency,
                "proficiency changed; create a new quote"
            );
        }
    }
    drop(p);
    verify_task_sources(&*lock(&state.db)?, plan)?;
    crate::application::transcript::study::verify_quote(state, plan, true)?;
    if plan.requests.iter().any(|task| {
        matches!(
            task,
            RequestTask::AudioTranscription { .. } | RequestTask::TranscribePreview { .. }
        )
    }) {
        crate::application::transcript::storage::verify_audio_plan(state, plan)?;
    }
    Ok(())
}

pub(crate) fn verify_application_binding(state: &AppState, plan: &PreparedJob) -> Result<()> {
    // A received result needs no credential. Semantic settings still bind its
    // contents, whereas rotating a key must not require another paid request.
    let p = state.preferences.read()?;
    for task in &plan.requests {
        if let RequestTask::Explanation { proficiency, .. } = task {
            ensure!(
                *proficiency == p.settings.proficiency,
                "proficiency changed; review the saved result"
            );
        }
    }
    drop(p);
    verify_task_sources(&*lock(&state.db)?, plan)?;
    crate::application::transcript::study::verify_quote(state, plan, false)
}
