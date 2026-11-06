use super::*;
use crate::application::ai::VocabularyCandidate;
use surtitle_core::Media;

struct Fixture {
    _directory: tempfile::TempDir,
    state: AppState,
    media: Media,
    cues: Vec<SubtitleSegment>,
    candidate: VocabularyCandidate,
}

impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let state = Services::open(directory.path().to_path_buf()).unwrap();
        let media = Media {
            id: "candidate-media".into(),
            title: "Candidate source".into(),
            path: directory
                .path()
                .join("unused.mp4")
                .to_string_lossy()
                .into_owned(),
            kind: "video".into(),
            duration_ms: 400_000,
            learning_language: "en".into(),
            explanation_language: "ja".into(),
            created_at: surtitle_core::now(),
            last_position_ms: 0,
            segment_count: 2,
            card_count: 0,
            status: "ready".into(),
            error: None,
            audio_stream_index: Some(0),
            subtitle_stream_index: None,
        };
        let cues = (0..2)
            .map(|index| SubtitleSegment {
                id: format!("candidate-cue-{index}"),
                media_id: media.id.clone(),
                start_ms: index * 1000 + 234,
                end_ms: (index + 1) * 1000 + 234,
                text: format!("Source {index}."),
                translation: Some(format!("Translation {index}.")),
                status: "confirmed".into(),
                timing_precision: "cue".into(),
                review_issues: vec![],
            })
            .collect::<Vec<_>>();
        let candidate = VocabularyCandidate {
            id: "candidate".into(),
            media_id: media.id.clone(),
            segment_id: cues[0].id.clone(),
            term: "  original term  ".into(),
            meaning: " meaning\n".into(),
            example: "Source 0. Source 1.".into(),
            explanation: " explanation\n".into(),
            translation: Some("Translation 0. Translation 1.".into()),
            source_cue_ids: cues.iter().map(|cue| cue.id.clone()).collect(),
            start_ms: cues[0].start_ms,
            end_ms: cues[1].end_ms,
        };
        {
            let mut db = lock(&state.db).unwrap();
            db.put_media(&media).unwrap();
            db.set_segments(&media.id, &cues).unwrap();
        }
        Self {
            _directory: directory,
            state,
            media,
            cues,
            candidate,
        }
    }
    fn signature(&self) -> String {
        serde_json::to_string(&(
            &self.media.path,
            self.media.audio_stream_index,
            &self.media.learning_language,
            &self.media.explanation_language,
        ))
        .unwrap()
    }
    fn prepare(&self) -> IpcResult<EditorDraftView> {
        prepare_candidate_editor_draft(
            &self.state,
            &self.candidate,
            self.cues.clone(),
            self.signature(),
        )
    }
    fn assert_empty(&self) {
        assert!(
            lock(&self.state.db)
                .unwrap()
                .list_editor_drafts(&self.media.id)
                .unwrap()
                .is_empty()
        );
    }
}

#[test]
fn candidate_opens_durable_raw_phrase_input_without_saving_a_card() {
    let fixture = Fixture::new();
    let prepared = fixture.prepare().unwrap();
    assert!(!prepared.stale);
    assert_eq!(prepared.draft.kind, "phrase");
    assert_eq!(prepared.draft.fields["term"], fixture.candidate.term);
    assert_eq!(prepared.draft.fields["meaning"], fixture.candidate.meaning);
    assert_eq!(prepared.draft.fields["example"], fixture.candidate.example);
    assert_eq!(
        prepared.draft.fields["explanation"],
        fixture.candidate.explanation
    );
    assert_eq!(prepared.draft.fields.len(), 4);
    let path = lock(&fixture.state.db).unwrap().path.clone();
    let reopened = surtitle_core::Store::open(path).unwrap();
    let persisted = reopened.editor_draft(&prepared.draft.id).unwrap();
    assert_eq!(persisted.fields, prepared.draft.fields);
    assert_eq!(
        serde_json::to_value(&persisted.source_cues).unwrap(),
        serde_json::to_value(&fixture.cues).unwrap()
    );
    assert!(reopened.list_cards().unwrap().is_empty());
}

#[test]
fn candidate_rejects_changed_media_and_subtitle_sources_without_creating_a_draft() {
    let fixture = Fixture::new();
    for field in ["path", "audio", "learning", "explanation"] {
        let mut changed = fixture.media.clone();
        match field {
            "path" => changed.path.push_str(".replacement"),
            "audio" => changed.audio_stream_index = Some(1),
            "learning" => changed.learning_language = "fr".into(),
            _ => changed.explanation_language = "de".into(),
        }
        lock(&fixture.state.db)
            .unwrap()
            .put_media(&changed)
            .unwrap();
        assert!(fixture.prepare().unwrap_err().contains("source"), "{field}");
        fixture.assert_empty();
    }
    lock(&fixture.state.db)
        .unwrap()
        .put_media(&fixture.media)
        .unwrap();
    for field in ["text", "time", "translation", "status"] {
        let mut changed = fixture.cues.clone();
        match field {
            "text" => changed[0].text = "Replaced subtitle".into(),
            "time" => changed[0].end_ms += 1,
            "translation" => changed[0].translation = Some("Replaced translation".into()),
            _ => changed[0].status = "draft".into(),
        }
        lock(&fixture.state.db)
            .unwrap()
            .set_segments(&fixture.media.id, &changed)
            .unwrap();
        assert!(fixture.prepare().is_err(), "{field}");
        fixture.assert_empty();
    }
}

#[test]
fn candidate_never_replaces_existing_unfinished_phrase_input() {
    let mut fixture = Fixture::new();
    let original = fixture.prepare().unwrap();
    fixture.candidate.term = "another generated term".into();
    let error = fixture.prepare().unwrap_err();
    assert!(error.contains("Resume or discard"), "{error}");
    let saved = lock(&fixture.state.db)
        .unwrap()
        .list_editor_drafts(&fixture.media.id)
        .unwrap();
    assert_eq!(saved.len(), 1);
    assert_eq!(saved[0].draft.id, original.draft.id);
    assert_eq!(saved[0].draft.version, original.draft.version);
    assert_eq!(saved[0].draft.fields, original.draft.fields);
}

#[test]
fn candidate_requires_exact_ordered_source_identity() {
    let mut fixture = Fixture::new();
    fixture.cues.reverse();
    assert!(fixture.prepare().is_err());
    fixture.cues.reverse();
    fixture.candidate.segment_id = fixture.cues[1].id.clone();
    assert!(fixture.prepare().is_err());
    fixture.candidate.segment_id = fixture.cues[0].id.clone();
    fixture.cues[0].media_id = "another-media".into();
    assert!(fixture.prepare().is_err());
    fixture.cues[0].media_id = fixture.media.id.clone();
    let mut inserted = fixture.cues[0].clone();
    inserted.id = "inserted-cue".into();
    inserted.start_ms += 100;
    let current = vec![fixture.cues[0].clone(), inserted, fixture.cues[1].clone()];
    lock(&fixture.state.db)
        .unwrap()
        .set_segments(&fixture.media.id, &current)
        .unwrap();
    assert!(fixture.prepare().is_err());
    fixture.assert_empty();
}

#[test]
fn candidate_source_block_seeds_explicit_audio_range_bounded_to_three_minutes() {
    let mut fixture = Fixture::new();
    fixture.cues.truncate(1);
    fixture.cues[0].timing_precision = "source_block".into();
    fixture.cues[0].end_ms = 300_234;
    fixture.candidate.source_cue_ids.truncate(1);
    fixture.candidate.end_ms = 300_234;
    lock(&fixture.state.db)
        .unwrap()
        .set_segments(&fixture.media.id, &fixture.cues)
        .unwrap();
    let draft = fixture.prepare().unwrap();
    assert_eq!(draft.draft.fields["audioStart"], "0.234");
    assert_eq!(draft.draft.fields["audioEnd"], "180.234");
    assert_eq!(draft.draft.source_cues[0].end_ms, 300_234);
    assert!(
        lock(&fixture.state.db)
            .unwrap()
            .list_cards()
            .unwrap()
            .is_empty()
    );
}
