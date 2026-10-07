use super::*;

#[cfg(feature = "e2e-test")]
/// A single predetermined persisted-response fixture, absent from normal builds.
/// It provides no alternate transport, credentials, clock, or arbitrary SQL IPC.
pub(crate) fn seed_ai_recovery_fixture(state: &AppState) -> Result<()> {
    let Some(preset) = std::env::var_os("SURTITLE_E2E_AI_RECOVERY") else {
        return Ok(());
    };
    ensure!(preset == "translation", "unknown AI recovery fixture");
    let isolated = std::env::var_os("SURTITLE_E2E_DATA_DIR")
        .context("AI recovery fixture needs an isolated data directory")?;
    let isolated = std::path::PathBuf::from(isolated);
    ensure!(
        isolated.is_absolute() && isolated.canonicalize()? == state.root.canonicalize()?,
        "AI recovery fixture data directory differs"
    );
    let title = "E2E saved translation recovery";
    if state.ai.list_jobs()?.iter().any(|job| job.title == title) {
        return Ok(());
    }
    let path = state.root.join("media").join("e2e-ai-recovery.wav");
    // Two seconds of generated silence. No downloaded or copyrighted fixture.
    let pcm_len = 16000u32 * 2 * 2;
    let mut wav = Vec::with_capacity(pcm_len as usize + 44);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(pcm_len + 36).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt \x10\0\0\0\x01\0\x01\0");
    wav.extend_from_slice(&16000u32.to_le_bytes());
    wav.extend_from_slice(&32000u32.to_le_bytes());
    wav.extend_from_slice(b"\x02\0\x10\0data");
    wav.extend_from_slice(&pcm_len.to_le_bytes());
    wav.resize(pcm_len as usize + 44, 0);
    std::fs::write(&path, wav)?;
    let media_id = "e2e-ai-recovery";
    let segments = vec![
        surtitle_core::SubtitleSegment {
            timing_precision: "cue".into(),
            id: "e2e-ai-recovery-1".into(),
            media_id: media_id.into(),
            start_ms: 0,
            end_ms: 1000,
            text: "Hello.".into(),
            translation: None,
            status: "confirmed".into(),
            review_issues: vec![],
        },
        surtitle_core::SubtitleSegment {
            timing_precision: "cue".into(),
            id: "e2e-ai-recovery-2".into(),
            media_id: media_id.into(),
            start_ms: 1000,
            end_ms: 2000,
            text: "See you tomorrow.".into(),
            translation: None,
            status: "confirmed".into(),
            review_issues: vec![],
        },
    ];
    {
        let mut db = lock(&state.db)?;
        db.put_media(&surtitle_core::Media {
            id: media_id.into(),
            title: title.into(),
            path: path.to_string_lossy().into_owned(),
            source_url: None,
            kind: "audio".into(),
            duration_ms: 2000,
            learning_language: "en".into(),
            explanation_language: "ja".into(),
            created_at: surtitle_core::now(),
            last_position_ms: 0,
            segment_count: segments.len(),
            card_count: 0,
            status: "ready".into(),
            error: None,
            audio_stream_index: Some(0),
            subtitle_stream_index: None,
        })?;
        db.set_segments(media_id, &segments)?;
    }
    let cues = segments
        .iter()
        .map(|s| SourceCue {
            id: s.id.clone(),
            start_ms: s.start_ms,
            end_ms: s.end_ms,
            text: s.text.clone(),
        })
        .collect::<Vec<_>>();
    let quote = state
        .ai
        .seed_translation_recovery_fixture(PreparedJob::new(
            title.into(),
            "e2e-project".into(),
            "unused-e2e-fixture".into(),
            PreparationBinding {
                media_id: media_id.into(),
                transcript_revision: transcript_fingerprint(&segments)?,
                source_sha256: sha256_bytes(&serde_json::to_vec(&cues)?),
                settings_sha256: settings_fingerprint(&state.preferences.read()?.settings)?,
            },
            vec![RequestTask::Translation {
                target_language: "ja".into(),
                cues,
            }],
            crate::application::models::fixture_execution(),
        )?)?;
    state.preferences.update(|preferences| {
        preferences.quotes.insert(
            quote.id,
            QuoteContext {
                media_id: media_id.into(),
                kind: "translate".into(),
                start_ms: 0,
                end_ms: 2000,
            },
        );
        Ok(())
    })
}
