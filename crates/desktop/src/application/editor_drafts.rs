use super::*;
use surtitle_core::{
    EditorDraftVersion, EditorDraftView, SaveCard, SaveEditorDraft, SubtitleSegment,
};

type IpcResult<T> = std::result::Result<T, String>;

pub fn prepare_candidate_editor_draft(
    state: &AppState,
    candidate: &super::ai::VocabularyCandidate,
    source_cues: Vec<SubtitleSegment>,
    expected_media_signature: String,
) -> IpcResult<EditorDraftView> {
    (|| {
        // Keep source verification and creation under the same lock. A relink,
        // audio change or subtitle edit must not replace the reviewed source
        // between these checks and the durable draft write.
        let db = lock(&state.db)?;
        let media = db.media(&candidate.media_id)?;
        let signature = serde_json::to_string(&(
            &media.path,
            media.audio_stream_index,
            &media.learning_language,
            &media.explanation_language,
        ))?;
        ensure!(
            signature == expected_media_signature,
            "The candidate source media changed; refresh the candidates before continuing"
        );
        ensure!(
            !source_cues.is_empty()
                && candidate.source_cue_ids.first() == Some(&candidate.segment_id)
                && source_cues.iter().all(|cue| cue.media_id == candidate.media_id)
                && source_cues.iter().map(|cue| &cue.id).eq(candidate.source_cue_ids.iter()),
            "The candidate source subtitles do not match; refresh the candidates before continuing"
        );
        let current = db.card_source_cues(&SaveCard {
            media_id: candidate.media_id.clone(),
            segment_id: candidate.segment_id.clone(),
            source_cue_ids: candidate.source_cue_ids.clone(),
            source_range: None,
            term: candidate.term.clone(),
            meaning: candidate.meaning.clone(),
            example: candidate.example.clone(),
            translation: candidate.translation.clone(),
            explanation: Some(candidate.explanation.clone()),
        })?;
        let start = current[0].start_ms;
        let end = current.iter().map(|cue| cue.end_ms).max().unwrap();
        ensure!(
            serde_json::to_value(&current)? == serde_json::to_value(&source_cues)?
                && candidate.start_ms == start
                && candidate.end_ms == end,
            "The candidate source subtitles changed; refresh the candidates before continuing"
        );
        let source_key = serde_json::to_string(&candidate.source_cue_ids)?;
        ensure!(
            !db.list_editor_drafts(&candidate.media_id)?.iter().any(|view| {
                view.draft.kind == "phrase" && view.draft.source_key == source_key
            }),
            "This source already has unfinished phrase input. Resume or discard it before using another candidate"
        );
        let mut fields: std::collections::BTreeMap<String, String> = [
            ("term".into(), candidate.term.clone()),
            ("meaning".into(), candidate.meaning.clone()),
            ("example".into(), candidate.example.clone()),
            ("explanation".into(), candidate.explanation.clone()),
        ].into();
        if current.iter().any(|cue| cue.timing_precision == "source_block") {
            // This only opens an editor; the user confirms the bounded audio
            // range with its normal Save action before a card can be created.
            fields.insert("audioStart".into(), format!("{}.{:03}", start / 1000, start % 1000));
            let end = end.min(start.saturating_add(180_000));
            fields.insert("audioEnd".into(), format!("{}.{:03}", end / 1000, end % 1000));
        }
        db.save_editor_draft(&SaveEditorDraft {
            id: surtitle_core::id(),
            media_id: candidate.media_id.clone(),
            kind: "phrase".into(),
            source_key,
            expected_version: 0,
            fields,
            source_cues,
        })
    })().map_err(err)
}

pub fn list_editor_drafts(state: AppState, media_id: String) -> IpcResult<Vec<EditorDraftView>> {
    lock(&state.db)
        .and_then(|db| db.list_editor_drafts(&media_id))
        .map_err(err)
}

pub fn save_editor_draft(state: AppState, request: SaveEditorDraft) -> IpcResult<EditorDraftView> {
    lock(&state.db)
        .and_then(|db| db.save_editor_draft(&request))
        .map_err(err)
}

pub fn delete_editor_draft(state: AppState, reference: EditorDraftVersion) -> IpcResult<()> {
    lock(&state.db)
        .and_then(|db| db.delete_editor_draft(&reference))
        .map_err(err)
}

pub fn rebind_editor_draft(
    state: AppState,
    reference: EditorDraftVersion,
    source_cues: Vec<SubtitleSegment>,
) -> IpcResult<EditorDraftView> {
    lock(&state.db)
        .and_then(|db| db.rebind_editor_draft(&reference, &source_cues))
        .map_err(err)
}

pub fn commit_subtitle_editor_draft(
    state: AppState,
    reference: EditorDraftVersion,
    segment: SubtitleSegment,
) -> IpcResult<Option<String>> {
    (|| {
        let mut playback = state.playback.operation()?;
        lock(&state.db)?.commit_subtitle_editor_draft(&reference, &segment)?;
        // The database commit and draft consumption already succeeded. A player
        // refresh failure must not invite a second final-save attempt.
        Ok(super::playback::refresh_current_subtitles_locked(
            &state,
            &mut playback,
            &segment.media_id,
        )
        .err()
        .map(err))
    })()
    .map_err(err)
}

pub async fn save_phrase_editor_draft(
    state: AppState,
    reference: EditorDraftVersion,
    request: SaveCard,
    operation_id: Option<String>,
) -> IpcResult<()> {
    super::cards::save_card_with_editor_draft(state, request, Some(reference), operation_id).await
}

#[cfg(test)]
mod candidate_tests;
