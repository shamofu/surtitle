use super::*;
use surtitle_core::{
    DraftStudyCardFields, DraftStudySelection, EditorDraftVersion, Media, SaveCard,
    SaveEditorDraft, Store, StudyCard, SubtitleSegment, store::CardSourceSnapshot,
};

struct Fixture {
    directory: tempfile::TempDir,
    db: Store,
    request: SaveCard,
    source: CardSourceSnapshot,
    existing: StudyCard,
    existing_audio: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let source_path = directory.path().join("source.wav");
        std::fs::write(&source_path, b"source fixture").unwrap();
        let mut db = Store::open(directory.path().join("learning.sqlite")).unwrap();
        let media: Media = serde_json::from_value(serde_json::json!({
            "id":"media", "title":"Source", "path":source_path, "kind":"audio",
            "durationMs":10000, "learningLanguage":"en", "explanationLanguage":"ja",
            "createdAt":surtitle_core::now(), "lastPositionMs":0, "segmentCount":1,
            "cardCount":0, "status":"ready", "audioStreamIndex":1
        }))
        .unwrap();
        db.put_media(&media).unwrap();
        let cue: SubtitleSegment = serde_json::from_value(serde_json::json!({
            "id":"cue", "mediaId":"media", "startMs":1000, "endMs":2000,
            "text":"A source excerpt.", "translation":null, "status":"confirmed"
        }))
        .unwrap();
        db.set_segments("media", &[cue]).unwrap();
        let request: SaveCard = serde_json::from_value(serde_json::json!({
            "mediaId":"media", "segmentId":"cue", "term":"source",
            "meaning":"origin", "example":"A source excerpt."
        }))
        .unwrap();
        let source = db.card_source_snapshot(&request).unwrap();
        let existing_audio = directory.path().join("existing.wav");
        std::fs::write(&existing_audio, b"existing saved audio").unwrap();
        let existing = db
            .save_card(
                &request,
                Some(existing_audio.to_string_lossy().into_owned()),
            )
            .unwrap();
        Self {
            directory,
            db,
            request,
            source,
            existing,
            existing_audio,
        }
    }

    fn pending(&self, name: &str) -> (PathBuf, PendingCardAudio) {
        let path = self.directory.path().join(name);
        std::fs::write(&path, b"new extracted audio").unwrap();
        (path.clone(), PendingCardAudio::new(path))
    }

    fn phrase_draft(&self) -> EditorDraftVersion {
        let saved = self
            .db
            .save_editor_draft(&SaveEditorDraft {
                id: "phrase".into(),
                media_id: "media".into(),
                kind: "phrase".into(),
                source_key: "selected-cue".into(),
                expected_version: 0,
                source_cues: self.source.cues().to_vec(),
                fields: [
                    ("term", "source"),
                    ("meaning", "origin"),
                    ("example", "A source excerpt."),
                    ("explanation", ""),
                ]
                .into_iter()
                .map(|(key, value)| (key.into(), value.into()))
                .collect(),
            })
            .unwrap();
        EditorDraftVersion {
            id: saved.draft.id,
            version: saved.draft.version,
        }
    }

    fn save(&self, audio: PendingCardAudio, draft: &EditorDraftVersion) -> Result<StudyCard> {
        audio.commit_with(|path| {
            self.db.save_card_with_source_snapshot(
                &self.request,
                &self.source,
                Some(path.to_string_lossy().into_owned()),
                Some(self.source.range()),
                Some(draft),
            )
        })
    }

    fn assert_existing_audio(&self) {
        assert_eq!(
            std::fs::read(&self.existing_audio).unwrap(),
            b"existing saved audio"
        );
        assert_eq!(
            self.db.card(&self.existing.id).unwrap().audio_path,
            self.existing.audio_path
        );
    }
}

#[test]
fn source_and_transaction_failures_remove_only_new_audio_and_keep_the_phrase_draft() {
    for failure in ["source", "insert", "draft-delete"] {
        let fixture = Fixture::new();
        let draft = fixture.phrase_draft();
        let connection = rusqlite::Connection::open(&fixture.db.path).unwrap();
        let message = match failure {
            "source" => {
                let mut changed = fixture.source.media().clone();
                changed.audio_stream_index = Some(2);
                fixture.db.put_media(&changed).unwrap();
                "The subtitle or media changed while preparing card audio"
            }
            "insert" => {
                connection.execute_batch("CREATE TRIGGER reject_card BEFORE INSERT ON cards BEGIN SELECT RAISE(ABORT,'fixture rejects card insert'); END;").unwrap();
                "fixture rejects card insert"
            }
            "draft-delete" => {
                connection.execute_batch("CREATE TRIGGER reject_draft BEFORE DELETE ON editor_drafts BEGIN SELECT RAISE(ABORT,'fixture rejects draft deletion'); END;").unwrap();
                "fixture rejects draft deletion"
            }
            _ => unreachable!(),
        };
        let (path, audio) = fixture.pending("failed.wav");
        let error = fixture.save(audio, &draft).unwrap_err();
        assert!(error.to_string().contains(message), "{failure}: {error:#}");
        assert!(!path.exists(), "{failure}");
        assert_eq!(fixture.db.list_cards().unwrap().len(), 1, "{failure}");
        assert_eq!(
            fixture.db.editor_draft(&draft.id).unwrap().version,
            draft.version,
            "{failure}"
        );
        fixture.assert_existing_audio();
        let reopened = Store::open(&fixture.db.path).unwrap();
        assert_eq!(reopened.list_cards().unwrap().len(), 1, "{failure}");
        assert_eq!(
            reopened.editor_draft(&draft.id).unwrap().version,
            draft.version,
            "{failure}"
        );
    }
}

#[test]
fn committed_card_keeps_audio_and_consumes_its_draft_after_reopening() {
    let fixture = Fixture::new();
    let draft = fixture.phrase_draft();
    let (path, audio) = fixture.pending("committed.wav");
    let card = fixture.save(audio, &draft).unwrap();
    fixture.assert_existing_audio();
    let database_path = fixture.db.path.clone();
    drop(fixture.db);
    let reopened = Store::open(database_path).unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), b"new extracted audio");
    assert_eq!(reopened.card(&card.id).unwrap().audio_path, card.audio_path);
    assert_eq!(card.audio_path.as_deref(), path.to_str());
    assert!(reopened.list_editor_drafts("media").unwrap().is_empty());
    assert_eq!(reopened.list_cards().unwrap().len(), 2);
}

#[test]
fn draft_selection_save_rolls_back_failed_insert_and_keeps_committed_audio() {
    let fixture = Fixture::new();
    let selected = fixture
        .db
        .insert_draft_study_selection(&DraftStudySelection {
            id: "selection".into(),
            media_id: "media".into(),
            job_id: Some("job".into()),
            version: 1,
            text: "A source excerpt.".into(),
            start_ms: 1000,
            end_ms: 2000,
            source_start_ms: 0,
            source_end_ms: 10000,
            cue_ids: vec!["cue".into()],
            ordinal: Some(1),
            origin: "ai".into(),
            timing: "cue".into(),
            confirmed: true,
            created_at: String::new(),
            updated_at: String::new(),
            source_snapshot: serde_json::json!({"path":fixture.source.media().path}),
        })
        .unwrap();
    let fields = DraftStudyCardFields {
        term: "source".into(),
        meaning: "origin".into(),
        example: selected.text.clone(),
        explanation: None,
        translation: None,
    };
    let save = |audio: PendingCardAudio| {
        audio.commit_with(|path| {
            fixture.db.save_draft_selection_card(
                &selected.id,
                selected.version,
                &fields,
                Some(path.to_string_lossy().into_owned()),
                Some(fixture.source.range()),
            )
        })
    };
    let connection = rusqlite::Connection::open(&fixture.db.path).unwrap();
    connection.execute_batch("CREATE TRIGGER reject_card BEFORE INSERT ON cards BEGIN SELECT RAISE(ABORT,'fixture rejects selected card'); END;").unwrap();
    let (failed_path, audio) = fixture.pending("failed-selection.wav");
    assert!(
        save(audio)
            .unwrap_err()
            .to_string()
            .contains("fixture rejects selected card")
    );
    assert!(!failed_path.exists());
    assert_eq!(fixture.db.list_cards().unwrap().len(), 1);
    assert_eq!(
        fixture.db.draft_study_selection(&selected.id).unwrap(),
        selected
    );
    connection
        .execute_batch("DROP TRIGGER reject_card;")
        .unwrap();
    let (path, audio) = fixture.pending("committed-selection.wav");
    let card = save(audio).unwrap();
    fixture.assert_existing_audio();
    let database_path = fixture.db.path.clone();
    drop(connection);
    drop(fixture.db);
    let reopened = Store::open(database_path).unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), b"new extracted audio");
    assert_eq!(
        reopened.card(&card.id).unwrap().audio_path.as_deref(),
        path.to_str()
    );
    assert_eq!(
        reopened.draft_study_selection(&selected.id).unwrap(),
        selected
    );
    assert_eq!(reopened.list_cards().unwrap().len(), 2);
}

#[test]
fn unfinished_saves_clean_up_on_return_and_unwind_without_masking_errors() {
    let fixture = Fixture::new();
    let (path, audio) = fixture.pending("early-error.wav");
    let fail_before_save =
        |_audio: PendingCardAudio| -> Result<()> { anyhow::bail!("database lock unavailable") };
    assert_eq!(
        fail_before_save(audio).unwrap_err().to_string(),
        "database lock unavailable"
    );
    assert!(!path.exists());
    let (path, audio) = fixture.pending("unwinding.wav");
    assert!(
        std::panic::catch_unwind(|| audio.commit_with(|_| -> Result<()> {
            panic!("save unwound")
        }))
        .is_err()
    );
    assert!(!path.exists());
    let directory_path = fixture.directory.path().join("cannot-remove-as-file");
    std::fs::create_dir(&directory_path).unwrap();
    let error = PendingCardAudio::new(directory_path.clone())
        .commit_with(|_| -> Result<()> { anyhow::bail!("save failed first") })
        .unwrap_err();
    assert_eq!(error.to_string(), "save failed first");
    assert!(directory_path.is_dir());
    fixture.assert_existing_audio();
}
