use super::*;
use std::sync::atomic::{AtomicBool, AtomicUsize};
use tokio::sync::Semaphore;

#[derive(Default)]
struct Db {
    active: Option<UiDraft>,
    archives: Vec<BTreeMap<String, String>>,
    saved: Vec<u64>,
    imports: Vec<ImportRequest>,
    validations: Vec<(Vec<String>, String, String)>,
}
#[derive(Default)]
struct Mock {
    db: Arc<Mutex<Db>>,
    load_gate: Arc<Mutex<Option<Arc<Semaphore>>>>,
    validate_gate: Arc<Mutex<Option<Arc<Semaphore>>>>,
    import_gate: Arc<Mutex<Option<Arc<Semaphore>>>>,
    loads: Arc<AtomicUsize>,
    fail_load: Arc<AtomicBool>,
    fail_save: Arc<AtomicBool>,
    fail_import: Arc<AtomicBool>,
}
impl ImportStore for Mock {
    fn load(&self) -> Task<(Option<UiDraft>, String, String)> {
        let db = self.db.clone();
        let gate = self.load_gate.lock().unwrap().clone();
        let loads = self.loads.clone();
        let fail = self.fail_load.clone();
        Box::pin(async move {
            loads.fetch_add(1, Ordering::AcqRel);
            if let Some(gate) = gate {
                gate.acquire().await.unwrap().forget();
            }
            if fail.load(Ordering::Acquire) {
                return Err("read unavailable".into());
            }
            Ok((db.lock().unwrap().active.clone(), "en".into(), "ja".into()))
        })
    }
    fn save(&self, revision: u64, fields: BTreeMap<String, String>) -> Task<UiDraft> {
        let db = self.db.clone();
        let fail = self.fail_save.clone();
        Box::pin(async move {
            if fail.load(Ordering::Acquire) {
                return Err("draft storage unavailable".into());
            }
            let mut db = db.lock().unwrap();
            if db.active.as_ref().map_or(0, |draft| draft.revision) != revision {
                return Err("Draft changed".into());
            }
            db.saved.push(revision);
            let draft = UiDraft {
                kind: "import".into(),
                entity_id: "default".into(),
                revision: revision + 1,
                fields,
                updated_at: String::new(),
                stale: false,
                archive_id: None,
            };
            db.active = Some(draft.clone());
            Ok(draft)
        })
    }
    fn archive(&self, fields: BTreeMap<String, String>) -> Task<()> {
        let db = self.db.clone();
        Box::pin(async move {
            db.lock().unwrap().archives.push(fields);
            Ok(())
        })
    }
    fn validate(
        &self,
        paths: Vec<String>,
        learning: String,
        explanation: String,
    ) -> Task<Vec<MediaFileValidation>> {
        self.db
            .lock()
            .unwrap()
            .validations
            .push((paths.clone(), learning, explanation));
        let gate = self.validate_gate.lock().unwrap().clone();
        Box::pin(async move {
            if let Some(gate) = gate {
                gate.acquire().await.unwrap().forget();
            }
            Ok(paths
                .into_iter()
                .map(|input_path| MediaFileValidation::Ready {
                    canonical_path: input_path.to_lowercase(),
                    input_path,
                })
                .collect())
        })
    }
    fn import(&self, request: ImportRequest) -> Task<LocalMediaImportResult> {
        self.db.lock().unwrap().imports.push(request.clone());
        let gate = self.import_gate.lock().unwrap().clone();
        let fail = self.fail_import.clone();
        Box::pin(async move {
            if let Some(gate) = gate {
                gate.acquire().await.unwrap().forget();
            }
            if fail.swap(false, Ordering::AcqRel) {
                return Err("temporary import failure".into());
            }
            Ok(LocalMediaImportResult {
                media_id: request.path,
                created: true,
            })
        })
    }
}
fn saved(revision: u64, learning: &str) -> UiDraft {
    UiDraft {
        kind: "import".into(),
        entity_id: "default".into(),
        revision,
        fields: BTreeMap::from([
            ("learningLanguage".into(), learning.into()),
            ("explanationLanguage".into(), "ja".into()),
            ("rows".into(), "[]".into()),
        ]),
        updated_at: String::new(),
        stale: false,
        archive_id: None,
    }
}
fn start(store: Arc<Mock>) -> (Arc<Workspace>, tokio::task::JoinHandle<()>) {
    let workspace = Workspace::new(Arc::new(AtomicU64::new(0)));
    let worker = tokio::spawn(workspace.clone().run(store));
    (workspace, worker)
}
#[tokio::test]
async fn discarded_import_draft_reloads_without_recreating_deleted_input() {
    let store = Arc::new(Mock::default());
    let (workspace, worker) = start(store.clone());
    workspace.flush().await.unwrap();
    workspace.add(vec!["C:/a.mp4".into()], false);
    workspace.flush().await.unwrap();
    assert!(workspace.reload_after_discard().is_err());
    workspace.freeze(true);
    workspace.flush().await.unwrap();
    let saves = {
        let mut db = store.db.lock().unwrap();
        db.active = None;
        db.saved.len()
    };
    workspace.reload_after_discard().unwrap();
    workspace.flush().await.unwrap();
    assert!(workspace.view().rows.is_empty());
    assert_eq!(store.db.lock().unwrap().saved.len(), saves);
    assert!(store.db.lock().unwrap().active.is_none());
    workspace.freeze(false);
    workspace.add(vec!["C:/new.mp4".into()], false);
    workspace.flush().await.unwrap();
    assert_eq!(workspace.view().rows.len(), 1);
    assert_eq!(workspace.view().rows[0].input_path, "C:/new.mp4");
    worker.abort();
}
async fn wait(mut condition: impl FnMut() -> bool) {
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while !condition() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn initialization_keeps_early_language_input_and_uses_the_loaded_cas_revision() {
    let store = Arc::new(Mock::default());
    store.db.lock().unwrap().active = Some(saved(7, "fr"));
    let gate = Arc::new(Semaphore::new(0));
    *store.load_gate.lock().unwrap() = Some(gate.clone());
    let (workspace, worker) = start(store.clone());
    wait(|| store.loads.load(Ordering::Acquire) > 0).await;
    workspace.languages(Some("de raw".into()), None);
    assert!(store.db.lock().unwrap().saved.is_empty());
    gate.add_permits(1);
    workspace.flush().await.unwrap();
    assert_eq!(workspace.view().learning, "de raw");
    assert_eq!(store.db.lock().unwrap().saved, vec![7]);
    worker.abort();
}
#[tokio::test]
async fn failed_initial_load_never_invents_revision_zero_or_loses_early_input() {
    let store = Arc::new(Mock::default());
    store.db.lock().unwrap().active = Some(saved(9, "fr"));
    store.fail_load.store(true, Ordering::Release);
    let (workspace, worker) = start(store.clone());
    workspace.languages(Some("es".into()), None);
    assert_eq!(workspace.flush().await.unwrap_err(), "read unavailable");
    assert!(store.db.lock().unwrap().saved.is_empty());
    store.fail_load.store(false, Ordering::Release);
    workspace.retry(Some(vec![]), false);
    workspace.flush().await.unwrap();
    assert_eq!(workspace.view().learning, "es");
    assert_eq!(store.db.lock().unwrap().saved, vec![9]);
    worker.abort();
}
#[tokio::test]
async fn validation_from_an_old_language_never_dispatches_old_language_imports() {
    let store = Arc::new(Mock::default());
    let gate = Arc::new(Semaphore::new(0));
    *store.validate_gate.lock().unwrap() = Some(gate.clone());
    let (workspace, worker) = start(store.clone());
    workspace.flush().await.unwrap();
    workspace.add(vec!["C:/a.mp4".into()], true);
    wait(|| store.db.lock().unwrap().validations.len() == 1).await;
    workspace.languages(Some("fr".into()), None);
    gate.add_permits(1);
    wait(|| store.db.lock().unwrap().validations.len() == 2).await;
    assert!(store.db.lock().unwrap().imports.is_empty());
    gate.add_permits(1);
    workspace.flush().await.unwrap();
    let db = store.db.lock().unwrap();
    assert_eq!(db.imports.len(), 1);
    assert_eq!(db.imports[0].learning_language, "fr");
    worker.abort();
}
#[tokio::test]
async fn canonical_duplicates_import_once_but_another_language_pair_is_independent() {
    let store = Arc::new(Mock::default());
    let (workspace, worker) = start(store.clone());
    workspace.flush().await.unwrap();
    workspace.add(vec!["C:/VIDEO.MP4".into(), "c:/video.mp4".into()], true);
    workspace.flush().await.unwrap();
    assert_eq!(store.db.lock().unwrap().imports.len(), 1);
    workspace.languages(Some("fr".into()), None);
    workspace.add(vec!["C:/VIDEO.MP4".into()], true);
    workspace.flush().await.unwrap();
    assert_eq!(store.db.lock().unwrap().imports.len(), 2);
    worker.abort();
}
#[tokio::test]
async fn review_titles_are_raw_durable_and_submission_uses_the_latest_title() {
    let store = Arc::new(Mock::default());
    let (workspace, worker) = start(store.clone());
    workspace.flush().await.unwrap();
    workspace.add(vec!["C:/a.mp4".into()], false);
    workspace.flush().await.unwrap();
    let id = workspace.view().rows[0].id;
    workspace.title(id, "  raw title 日本語  ".into());
    workspace.flush().await.unwrap();
    assert!(store.db.lock().unwrap().imports.is_empty());
    assert!(
        store.db.lock().unwrap().active.as_ref().unwrap().fields["rows"]
            .contains("raw title 日本語")
    );
    workspace.submit();
    workspace.flush().await.unwrap();
    assert_eq!(
        store.db.lock().unwrap().imports[0].title.as_deref(),
        Some("  raw title 日本語  ")
    );
    worker.abort();
}

#[tokio::test]
async fn persistence_failure_can_be_retried_with_checking_or_queued_rows() {
    let store = Arc::new(Mock::default());
    let (workspace, worker) = start(store.clone());
    workspace.flush().await.unwrap();
    store.fail_save.store(true, Ordering::Release);
    workspace.add(vec!["C:/a.mp4".into()], false);
    assert_eq!(
        workspace.flush().await.unwrap_err(),
        "draft storage unavailable"
    );
    assert_eq!(workspace.view().rows[0].status, Status::Checking);
    assert!(workspace.view().busy);
    assert!(workspace.view().retryable);
    workspace.freeze(true);
    assert!(!workspace.view().retryable);
    workspace.freeze(false);
    store.fail_save.store(false, Ordering::Release);
    workspace.retry(Some(vec![]), false);
    workspace.flush().await.unwrap();
    assert_eq!(workspace.view().rows[0].status, Status::Ready);
    assert!(store.db.lock().unwrap().imports.is_empty());

    store.fail_save.store(true, Ordering::Release);
    workspace.submit();
    assert_eq!(
        workspace.flush().await.unwrap_err(),
        "draft storage unavailable"
    );
    assert_eq!(workspace.view().rows[0].status, Status::Queued);
    assert!(workspace.view().retryable);
    let gate = Arc::new(Semaphore::new(0));
    *store.import_gate.lock().unwrap() = Some(gate.clone());
    store.fail_save.store(false, Ordering::Release);
    workspace.retry(Some(vec![]), false);
    wait(|| workspace.view().rows[0].status == Status::Importing).await;
    assert!(!workspace.view().retryable);
    gate.add_permits(1);
    workspace.flush().await.unwrap();
    assert_eq!(workspace.view().rows[0].status, Status::Imported);
    worker.abort();
}

#[tokio::test]
async fn raw_language_drafts_reopen_while_validation_and_import_resolve_known_names() {
    let store = Arc::new(Mock::default());
    let (workspace, worker) = start(store.clone());
    workspace.flush().await.unwrap();
    workspace.languages(Some(" English ".into()), Some(" 日本語 ".into()));
    workspace.add(vec!["C:/a.mp4".into()], false);
    workspace.flush().await.unwrap();
    {
        let db = store.db.lock().unwrap();
        let fields = &db.active.as_ref().unwrap().fields;
        assert_eq!(fields["learningLanguage"], " English ");
        assert_eq!(fields["explanationLanguage"], " 日本語 ");
        assert_eq!(db.validations[0].1, "en");
        assert_eq!(db.validations[0].2, "ja");
    }
    assert_eq!(workspace.view().rows[0].language_pair, r#"["en","ja"]"#);
    worker.abort();
    let (reopened, worker) = start(store.clone());
    reopened.flush().await.unwrap();
    assert_eq!(reopened.view().learning, " English ");
    assert_eq!(reopened.view().explanation, " 日本語 ");
    assert!(store.db.lock().unwrap().imports.is_empty());
    reopened.retry(None, true);
    reopened.flush().await.unwrap();
    let db = store.db.lock().unwrap();
    assert_eq!(db.imports.len(), 1);
    assert_eq!(db.imports[0].learning_language, "en");
    assert_eq!(db.imports[0].explanation_language, "ja");
    worker.abort();
}
#[tokio::test]
async fn failed_file_does_not_stop_later_imports_and_retry_only_targets_failures() {
    let store = Arc::new(Mock::default());
    store.fail_import.store(true, Ordering::Release);
    let (workspace, worker) = start(store.clone());
    workspace.flush().await.unwrap();
    workspace.add(vec!["C:/a.mp4".into(), "C:/b.mp4".into()], true);
    workspace.flush().await.unwrap();
    let failed = workspace
        .view()
        .rows
        .iter()
        .filter(|row| row.status == Status::Failed)
        .map(|row| row.id)
        .collect::<Vec<_>>();
    assert_eq!(failed.len(), 1);
    assert_eq!(store.db.lock().unwrap().imports.len(), 2);
    workspace.retry(Some(failed), true);
    workspace.flush().await.unwrap();
    assert_eq!(store.db.lock().unwrap().imports.len(), 3);
    assert!(
        workspace
            .view()
            .rows
            .iter()
            .all(|row| row.status == Status::Imported)
    );
    worker.abort();
}
#[tokio::test]
async fn conflicting_input_is_archived_without_overwriting_or_authorizing_imports() {
    let store = Arc::new(Mock::default());
    store.db.lock().unwrap().active = Some(saved(7, "fr"));
    let (workspace, worker) = start(store.clone());
    workspace.flush().await.unwrap();
    store.db.lock().unwrap().active = Some(saved(8, "it"));
    workspace.languages(Some("es".into()), None);
    workspace.flush().await.unwrap();
    {
        let db = store.db.lock().unwrap();
        assert_eq!(db.active.as_ref().unwrap().fields["learningLanguage"], "it");
        assert_eq!(db.archives[0]["learningLanguage"], "es");
        assert!(db.imports.is_empty());
    }
    workspace.languages(Some("de".into()), None);
    workspace.flush().await.unwrap();
    let db = store.db.lock().unwrap();
    assert_eq!(db.archives[1]["learningLanguage"], "it");
    assert_eq!(db.active.as_ref().unwrap().fields["learningLanguage"], "de");
    worker.abort();
}
#[tokio::test]
async fn freeze_blocks_new_work_and_restore_waits_for_real_import_completion() {
    let store = Arc::new(Mock::default());
    let gate = Arc::new(Semaphore::new(0));
    *store.import_gate.lock().unwrap() = Some(gate.clone());
    let (workspace, worker) = start(store.clone());
    workspace.flush().await.unwrap();
    workspace.add(vec!["C:/a.mp4".into()], true);
    wait(|| store.db.lock().unwrap().imports.len() == 1).await;
    workspace.freeze(true);
    workspace.add(vec!["C:/ignored.mp4".into()], true);
    workspace.languages(Some("ignored".into()), None);
    assert!(workspace.invalidate_after_restore().is_err());
    let flush = workspace.flush();
    tokio::pin!(flush);
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(20), flush.as_mut())
            .await
            .is_err()
    );
    gate.add_permits(1);
    flush.await.unwrap();
    assert_eq!(workspace.view().rows.len(), 1);
    assert_eq!(workspace.view().learning, "en");
    workspace.generation.fetch_add(1, Ordering::AcqRel);
    workspace.invalidate_after_restore().unwrap();
    workspace.flush().await.unwrap();
    assert!(workspace.view().rows[0].media_id.is_none());
    assert_eq!(workspace.view().rows[0].status, Status::Failed);
    assert_eq!(store.db.lock().unwrap().imports.len(), 1);
    worker.abort();
}
#[tokio::test]
async fn reopening_interrupted_rows_keeps_titles_but_never_restarts_imports() {
    let store = Arc::new(Mock::default());
    let mut draft = saved(4, "en");
    draft.fields.insert("rows".into(),r#"[{"id":1,"inputPath":"C:/a.mp4","status":"importing","title":"unfinished title","languagePair":"[\"en\",\"ja\"]"}]"#.into());
    store.db.lock().unwrap().active = Some(draft);
    let (workspace, worker) = start(store.clone());
    workspace.flush().await.unwrap();
    assert_eq!(workspace.view().rows[0].status, Status::Failed);
    assert_eq!(workspace.view().rows[0].title, "unfinished title");
    assert!(store.db.lock().unwrap().imports.is_empty());
    worker.abort();
}

#[tokio::test]
async fn incomplete_languages_and_pending_picker_are_saved_by_the_close_barrier() {
    let store = Arc::new(Mock::default());
    let (workspace, worker) = start(store.clone());
    workspace.flush().await.unwrap();
    assert!(workspace.begin_picker());
    workspace.freeze(true);
    let flush = workspace.flush();
    tokio::pin!(flush);
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(20), flush.as_mut())
            .await
            .is_err()
    );
    workspace.end_picker(Ok(vec!["C:/picked.mp4".into()]), false);
    flush.await.unwrap();
    assert_eq!(workspace.view().rows.len(), 1);
    assert!(store.db.lock().unwrap().imports.is_empty());
    workspace.freeze(false);
    workspace.languages(Some(String::new()), None);
    workspace.freeze(true);
    workspace.flush().await.unwrap();
    assert_eq!(workspace.view().learning, "");
    assert_eq!(workspace.view().rows[0].status, Status::Failed);
    assert_eq!(
        store.db.lock().unwrap().active.as_ref().unwrap().fields["learningLanguage"],
        ""
    );
    worker.abort();
}

#[tokio::test]
async fn external_generation_change_collects_inflight_result_and_never_starts_the_next_file() {
    let store = Arc::new(Mock::default());
    let gate = Arc::new(Semaphore::new(0));
    *store.import_gate.lock().unwrap() = Some(gate.clone());
    let (workspace, worker) = start(store.clone());
    workspace.flush().await.unwrap();
    workspace.add(vec!["C:/a.mp4".into(), "C:/b.mp4".into()], true);
    wait(|| store.db.lock().unwrap().imports.len() == 1).await;
    workspace.generation.fetch_add(1, Ordering::AcqRel);
    let flush = workspace.flush();
    tokio::pin!(flush);
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(20), flush.as_mut())
            .await
            .is_err()
    );
    gate.add_permits(1);
    assert!(flush.await.is_err());
    assert_eq!(store.db.lock().unwrap().imports.len(), 1);
    workspace.freeze(false);
    assert!(workspace.view().frozen);
    worker.abort();
}

#[tokio::test]
async fn actual_services_preserve_existing_media_and_reopen_raw_titles_without_automatic_writes() {
    use crate::{
        application::Services,
        runtime::DesktopHost,
        ui::{import::Store, session::Backend},
    };
    let directory = tempfile::tempdir().unwrap();
    let original = directory.path().join("original.mp4");
    let reviewed = directory.path().join("reviewed.mp4");
    let invalid = directory.path().join("unsupported.txt");
    for file in [&original, &reviewed, &invalid] {
        std::fs::write(file, b"local media fixture").unwrap();
    }
    let state = Services::open(directory.path().join("profile")).unwrap();
    let existing = crate::commands::library::import_local_media(
        &state,
        ImportRequest {
            path: original.to_string_lossy().into_owned(),
            title: Some("Original title".into()),
            learning_language: "en".into(),
            explanation_language: "ja".into(),
        },
    )
    .await
    .unwrap();
    let host = DesktopHost::new(
        tokio::runtime::Handle::current(),
        |work| {
            work();
            Ok(())
        },
        |_| Ok(()),
        |_| {},
    );
    let backend = Backend::new(state.clone(), host);
    let workspace = Workspace::new(backend.generation.clone());
    let worker = tokio::spawn(workspace.clone().run(Arc::new(Store(backend.clone()))));
    workspace.flush().await.unwrap();
    workspace.add(
        vec![
            original.to_string_lossy().into_owned(),
            reviewed.to_string_lossy().into_owned(),
            invalid.to_string_lossy().into_owned(),
        ],
        false,
    );
    workspace.flush().await.unwrap();
    let view = workspace.view();
    assert_eq!(
        view.rows
            .iter()
            .filter(|row| row.status == Status::Existing)
            .count(),
        1
    );
    assert_eq!(
        view.rows
            .iter()
            .filter(|row| row.status == Status::Invalid)
            .count(),
        1
    );
    assert_eq!(
        view.rows
            .iter()
            .find(|row| row.status == Status::Existing)
            .unwrap()
            .media_id
            .as_deref(),
        Some(existing.media_id.as_str())
    );
    let id = view
        .rows
        .iter()
        .find(|row| row.status == Status::Ready)
        .unwrap()
        .id;
    workspace.title(id, "未確定のタイトル raw".into());
    workspace.freeze(true);
    workspace.flush().await.unwrap();
    worker.abort();
    worker.await.unwrap_err();
    let reopened = Workspace::new(backend.generation.clone());
    let worker = tokio::spawn(reopened.clone().run(Arc::new(Store(backend))));
    reopened.flush().await.unwrap();
    assert_eq!(
        reopened
            .view()
            .rows
            .iter()
            .find(|row| row.id == id)
            .unwrap()
            .title,
        "未確定のタイトル raw"
    );
    let snapshot = crate::commands::ai::get_app_snapshot(&state).unwrap();
    assert_eq!(snapshot.media.len(), 1);
    assert_eq!(snapshot.media[0].title, "Original title");
    worker.abort();
}
