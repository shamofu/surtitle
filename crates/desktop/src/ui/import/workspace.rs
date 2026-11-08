//! Durable import work outlives its dialog. No restored draft grants import authority.
use super::languages;
use crate::application::library::{ImportRequest, LocalMediaImportResult, MediaFileValidation};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    future::Future,
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};
use surtitle_core::workspace::UiDraft;
use tokio::sync::Notify;

pub(super) type Task<T> = Pin<Box<dyn Future<Output = Result<T, String>> + Send + 'static>>;
pub(super) trait ImportStore: Send + Sync + 'static {
    fn load(&self) -> Task<(Option<UiDraft>, String, String)>;
    fn save(&self, revision: u64, fields: BTreeMap<String, String>) -> Task<UiDraft>;
    fn archive(&self, fields: BTreeMap<String, String>) -> Task<()>;
    fn validate(
        &self,
        paths: Vec<String>,
        learning: String,
        explanation: String,
    ) -> Task<Vec<MediaFileValidation>>;
    fn import(&self, request: ImportRequest) -> Task<LocalMediaImportResult>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Status {
    Checking,
    Validating,
    Ready,
    Queued,
    Invalid,
    Existing,
    Importing,
    Imported,
    Failed,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Row {
    pub id: u64,
    pub input_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub canonical_path: Option<String>,
    pub status: Status,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_id: Option<String>,
    #[serde(default)]
    pub language_pair: String,
    #[serde(default)]
    pub title: String,
    #[serde(skip)]
    automatic: bool,
}
impl Row {
    pub fn editable(&self) -> bool {
        !matches!(
            self.status,
            Status::Queued | Status::Importing | Status::Imported | Status::Existing
        )
    }
    pub fn path(&self) -> &str {
        self.canonical_path.as_deref().unwrap_or(&self.input_path)
    }
}
#[derive(Clone, Debug)]
pub(crate) struct View {
    pub ready: bool,
    pub learning: String,
    pub explanation: String,
    pub rows: Vec<Row>,
    pub frozen: bool,
    pub picking: bool,
    pub busy: bool,
    pub retryable: bool,
    pub error: Option<String>,
    pub change: u64,
}
struct Model {
    view: View,
    revision: u64,
    version: u64,
    persisted: u64,
    next_id: u64,
    generation: u64,
    language_epoch: u64,
    early_learning: bool,
    early_explanation: bool,
    active: bool,
    load_failed: bool,
    persistence_error: Option<String>,
    foreign: Option<UiDraft>,
    pending_paths: Vec<(Vec<String>, bool)>,
    retired: bool,
    restored: bool,
}
impl Model {
    fn changed(&mut self, persist: bool) {
        self.view.change = self.view.change.wrapping_add(1);
        if persist {
            self.version = self.version.wrapping_add(1);
            self.persistence_error = None;
        }
        self.view.busy = self.active
            || self.view.picking
            || self.view.rows.iter().any(|row| {
                matches!(
                    row.status,
                    Status::Checking | Status::Validating | Status::Queued | Status::Importing
                )
            });
        self.view.retryable =
            !self.view.frozen
                && !self.active
                && !self.view.picking
                && (self.persistence_error.is_some()
                    || (!self.view.busy
                        && (self.view.error.is_some()
                            || self.view.rows.iter().any(|row| {
                                matches!(row.status, Status::Invalid | Status::Failed)
                            }))));
    }
    fn fields(&self) -> Result<BTreeMap<String, String>, String> {
        Ok(BTreeMap::from([
            ("learningLanguage".into(), self.view.learning.clone()),
            ("explanationLanguage".into(), self.view.explanation.clone()),
            (
                "rows".into(),
                serde_json::to_string(&self.view.rows).map_err(|e| e.to_string())?,
            ),
        ]))
    }
    fn pair(&self) -> String {
        language_pair(&self.view.learning, &self.view.explanation)
    }
    fn valid_languages(&self) -> bool {
        [&self.view.learning, &self.view.explanation]
            .into_iter()
            .all(|value| !value.trim().is_empty() && value.len() <= 100)
    }
    fn add(&mut self, paths: Vec<String>, automatic: bool) {
        if !self.view.ready {
            self.pending_paths.push((paths, automatic));
            return;
        }
        let pair = self.pair();
        let valid_languages = self.valid_languages();
        for path in paths {
            if self
                .view
                .rows
                .iter()
                .any(|row| row.language_pair == pair && path_key(row.path()) == path_key(&path))
            {
                continue;
            }
            self.next_id = self.next_id.saturating_add(1);
            self.view.rows.push(Row {
                id: self.next_id,
                input_path: path,
                canonical_path: None,
                status: if valid_languages {
                    Status::Checking
                } else {
                    Status::Failed
                },
                reason: None,
                error: (!valid_languages)
                    .then(|| "Enter both languages before retrying this file".into()),
                media_id: None,
                language_pair: pair.clone(),
                title: String::new(),
                automatic: automatic && valid_languages,
            });
        }
        self.changed(true);
    }
    fn idle(&self) -> bool {
        !self.active
            && !self.view.picking
            && self.pending_paths.is_empty()
            && !self.view.rows.iter().any(|row| {
                matches!(
                    row.status,
                    Status::Checking | Status::Validating | Status::Queued | Status::Importing
                )
            })
    }
    fn retire(&mut self) {
        if self.retired {
            return;
        }
        self.retired = true;
        self.view.frozen = true;
        self.persistence_error = Some(
            "The workspace changed while import work was still running. Reopen imports.".into(),
        );
        for row in &mut self.view.rows {
            row.automatic = false;
            if matches!(
                row.status,
                Status::Checking
                    | Status::Validating
                    | Status::Ready
                    | Status::Queued
                    | Status::Importing
            ) {
                row.status = Status::Failed;
                row.error = Some("Workspace changed; validate again".into());
            }
        }
        self.changed(false);
    }
    fn next_work(&mut self) -> Option<Work> {
        if self.active || self.retired {
            return None;
        }
        let work = if !self.view.ready {
            if self.load_failed {
                return None;
            }
            Work::Load
        } else if self.persisted < self.version {
            if self.persistence_error.is_some() {
                return None;
            }
            match self.fields() {
                Ok(fields) => Work::Save {
                    version: self.version,
                    revision: self.revision,
                    fields,
                    foreign: self.foreign.clone(),
                },
                Err(error) => {
                    self.persistence_error = Some(error.clone());
                    self.view.error = Some(error);
                    return None;
                }
            }
        } else if self.valid_languages() {
            if self
                .view
                .rows
                .iter()
                .any(|row| row.status == Status::Checking)
            {
                let ids = self
                    .view
                    .rows
                    .iter()
                    .filter(|row| row.status == Status::Checking)
                    .map(|row| row.id)
                    .collect::<Vec<_>>();
                let paths = self
                    .view
                    .rows
                    .iter_mut()
                    .filter(|row| ids.contains(&row.id))
                    .map(|row| {
                        row.status = Status::Validating;
                        row.input_path.clone()
                    })
                    .collect();
                Work::Validate {
                    ids,
                    paths,
                    learning: languages::resolve(&self.view.learning),
                    explanation: languages::resolve(&self.view.explanation),
                    epoch: self.language_epoch,
                    generation: self.generation,
                }
            } else {
                let row = self.view.rows.iter_mut().find(|row| {
                    row.status == Status::Queued || (row.status == Status::Ready && row.automatic)
                })?;
                if row.language_pair != language_pair(&self.view.learning, &self.view.explanation) {
                    row.status = Status::Checking;
                    self.changed(true);
                    return self.next_work();
                }
                row.status = Status::Importing;
                Work::Import {
                    id: row.id,
                    generation: self.generation,
                    request: ImportRequest {
                        path: row.path().into(),
                        title: Some(row.title.clone()),
                        learning_language: languages::resolve(&self.view.learning),
                        explanation_language: languages::resolve(&self.view.explanation),
                    },
                }
            }
        } else {
            return None;
        };
        self.active = true;
        self.changed(false);
        Some(work)
    }
}
enum Work {
    Load,
    Save {
        version: u64,
        revision: u64,
        fields: BTreeMap<String, String>,
        foreign: Option<UiDraft>,
    },
    Validate {
        ids: Vec<u64>,
        paths: Vec<String>,
        learning: String,
        explanation: String,
        epoch: u64,
        generation: u64,
    },
    Import {
        id: u64,
        generation: u64,
        request: ImportRequest,
    },
}

pub(super) struct Workspace {
    model: Mutex<Model>,
    wake: Notify,
    changed: Notify,
    generation: Arc<AtomicU64>,
}
impl Workspace {
    pub fn new(generation: Arc<AtomicU64>) -> Arc<Self> {
        Arc::new(Self {
            model: Mutex::new(Model {
                view: View {
                    ready: false,
                    learning: "en".into(),
                    explanation: "ja".into(),
                    rows: vec![],
                    frozen: false,
                    picking: false,
                    busy: false,
                    retryable: false,
                    error: None,
                    change: 0,
                },
                revision: 0,
                version: 0,
                persisted: 0,
                next_id: 0,
                generation: generation.load(Ordering::Acquire),
                language_epoch: 0,
                early_learning: false,
                early_explanation: false,
                active: false,
                load_failed: false,
                persistence_error: None,
                foreign: None,
                pending_paths: vec![],
                retired: false,
                restored: false,
            }),
            wake: Notify::new(),
            changed: Notify::new(),
            generation,
        })
    }
    pub fn view(&self) -> View {
        self.model.lock().unwrap().view.clone()
    }
    fn update(&self, f: impl FnOnce(&mut Model)) {
        f(&mut self.model.lock().unwrap());
        self.wake.notify_one();
        self.changed.notify_waiters();
    }
    pub fn freeze(&self, frozen: bool) {
        self.update(|model| {
            model.view.frozen = frozen || model.retired;
            model.changed(false);
        });
    }
    pub fn languages(&self, learning: Option<String>, explanation: Option<String>) {
        self.update(|model| {
            if model.view.frozen {
                return;
            }
            if let Some(value) = learning {
                model.view.learning = value;
                model.early_learning = !model.view.ready;
            }
            if let Some(value) = explanation {
                model.view.explanation = value;
                model.early_explanation = !model.view.ready;
            }
            model.language_epoch = model.language_epoch.wrapping_add(1);
            let pair = model.pair();
            let valid_languages = model.valid_languages();
            for row in &mut model.view.rows {
                if !matches!(
                    row.status,
                    Status::Importing | Status::Imported | Status::Existing
                ) {
                    row.language_pair = pair.clone();
                    row.status = if valid_languages {
                        Status::Checking
                    } else {
                        Status::Failed
                    };
                    row.canonical_path = None;
                    row.media_id = None;
                    row.error = (!valid_languages)
                        .then(|| "Enter both languages before retrying this file".into());
                    if !valid_languages {
                        row.automatic = false;
                    }
                }
            }
            model.changed(true);
        });
    }
    pub fn add(&self, paths: Vec<String>, automatic: bool) {
        self.update(|model| {
            if !model.view.frozen {
                model.add(paths, automatic);
            }
        });
    }
    pub fn title(&self, id: u64, value: String) {
        self.update(|model| {
            if model.view.frozen {
                return;
            }
            if let Some(row) = model
                .view
                .rows
                .iter_mut()
                .find(|row| row.id == id && row.editable())
            {
                row.title = value;
                model.changed(true);
            }
        });
    }
    pub fn remove(&self, id: u64) {
        self.update(|model| {
            if model.view.frozen || model.active {
                return;
            }
            model.view.rows.retain(|row| row.id != id);
            model.changed(true);
        });
    }
    pub fn clear(&self) {
        self.update(|model| {
            if !model.view.frozen && model.idle() {
                model.view.rows.clear();
                model.changed(true);
            }
        });
    }
    pub fn retry(&self, ids: Option<Vec<u64>>, automatic: bool) {
        self.update(|model| {
            if model.view.frozen {
                return;
            }
            model.load_failed = false;
            model.persistence_error = None;
            model.view.error = None;
            let pair = model.pair();
            let valid_languages = model.valid_languages();
            for row in &mut model.view.rows {
                if ids.as_ref().is_none_or(|ids| ids.contains(&row.id))
                    && matches!(row.status, Status::Invalid | Status::Failed | Status::Ready)
                {
                    row.status = if valid_languages {
                        Status::Checking
                    } else {
                        Status::Failed
                    };
                    row.automatic = automatic && valid_languages;
                    row.error = (!valid_languages)
                        .then(|| "Enter both languages before retrying this file".into());
                    row.reason = None;
                    row.media_id = None;
                    row.language_pair = pair.clone();
                }
            }
            model.changed(true);
        });
    }
    pub fn submit(&self) {
        self.update(|model| {
            if model.view.frozen || !model.view.ready || !model.valid_languages() {
                return;
            }
            for row in &mut model.view.rows {
                if row.status == Status::Ready {
                    row.status = Status::Queued;
                    row.automatic = true;
                }
            }
            model.changed(true);
        });
    }
    pub fn begin_picker(&self) -> bool {
        let mut accepted = false;
        self.update(|model| {
            if !model.view.frozen && !model.view.picking {
                model.view.picking = true;
                model.changed(false);
                accepted = true;
            }
        });
        accepted
    }
    pub fn end_picker(&self, result: Result<Vec<String>, String>, automatic: bool) {
        self.update(|model| {
            model.view.picking = false;
            match result {
                Ok(paths) => {
                    if !paths.is_empty() {
                        model.add(paths, automatic);
                    }
                }
                Err(error) => model.view.error = Some(error),
            }
            model.changed(false);
        });
    }
    pub fn flush(self: &Arc<Self>) -> Task<()> {
        let this = self.clone();
        Box::pin(async move {
            this.wake.notify_one();
            loop {
                let changed = this.changed.notified();
                tokio::pin!(changed);
                changed.as_mut().enable();
                {
                    let model = this.model.lock().unwrap();
                    if let Some(error) = &model.persistence_error {
                        return Err(error.clone());
                    }
                    if model.load_failed {
                        return Err(model
                            .view
                            .error
                            .clone()
                            .unwrap_or_else(|| "Could not load unfinished imports".into()));
                    }
                    if model.view.ready && model.idle() && model.persisted >= model.version {
                        return Ok(());
                    }
                }
                changed.await;
            }
        })
    }
    pub fn invalidate_after_restore(&self) -> Result<(), String> {
        let mut result = Ok(());
        self.update(|model| {
            if !model.view.frozen || !model.idle() || model.persisted < model.version {
                result = Err("Restore requires imports to be frozen and fully saved".into());
                return;
            }
            model.generation = self.generation.load(Ordering::Acquire);
            model.retired = false;
            model.restored = true;
            model.view.ready = false;
            model.view.error = None;
            model.load_failed = false;
            model.persistence_error = None;
            model.foreign = None;
            model.early_learning = false;
            model.early_explanation = false;
            model.changed(false);
        });
        result
    }
    pub fn reload_after_discard(&self) -> Result<(), String> {
        let mut result = Ok(());
        self.update(|model| {
            if !model.view.frozen
                || !model.idle()
                || model.persisted < model.version
                || model.generation != self.generation.load(Ordering::Acquire)
            {
                result = Err("Flush and freeze imports before discarding their draft".into());
                return;
            }
            model.view.ready = false;
            model.view.rows.clear();
            model.view.error = None;
            model.load_failed = false;
            model.persistence_error = None;
            model.foreign = None;
            model.early_learning = false;
            model.early_explanation = false;
            model.restored = false;
            model.changed(false);
        });
        result
    }
    pub async fn run(self: Arc<Self>, store: Arc<dyn ImportStore>) {
        loop {
            let notified = self.wake.notified();
            let work = {
                let mut model = self.model.lock().unwrap();
                if self.generation.load(Ordering::Acquire) != model.generation {
                    model.retire();
                }
                model.next_work()
            };
            let Some(work) = work else {
                self.changed.notify_waiters();
                notified.await;
                continue;
            };
            match work {
                Work::Load => {
                    let result = store.load().await;
                    self.update(|model| {
                        model.active = false;
                        match result {
                            Ok((draft, learning, explanation)) => {
                                let parsed = parse_draft(draft.as_ref());
                                match parsed {
                                    Ok(mut rows) => {
                                        // Core intentionally treats import drafts as raw
                                        // device-local input, so it does not mark them
                                        // stale on learning restore. Detach their old
                                        // media links explicitly under this restore gate.
                                        let restored = model.restored;
                                        if restored {
                                            for row in &mut rows {
                                                row.status = Status::Failed;
                                                row.media_id = None;
                                                row.automatic = false;
                                                row.error = Some("A backup was restored; validate the original file again".into());
                                            }
                                            model.restored = false;
                                        }
                                        let fields = draft.as_ref().map(|draft| &draft.fields);
                                        if !model.early_learning {
                                            model.view.learning = fields
                                                .and_then(|fields| fields.get("learningLanguage"))
                                                .cloned()
                                                .unwrap_or(learning);
                                        }
                                        if !model.early_explanation {
                                            model.view.explanation = fields
                                                .and_then(|fields| {
                                                    fields.get("explanationLanguage")
                                                })
                                                .cloned()
                                                .unwrap_or(explanation);
                                        }
                                        model.next_id =
                                            rows.iter().map(|row| row.id).max().unwrap_or(0);
                                        model.view.rows = rows;
                                        model.revision =
                                            draft.as_ref().map_or(0, |draft| draft.revision);
                                        model.view.ready = true;
                                        model.view.error = None;
                                        model.load_failed = false;
                                        let pending = std::mem::take(&mut model.pending_paths);
                                        for (paths, automatic) in pending {
                                            model.add(paths, automatic);
                                        }
                                        if restored || model.early_learning || model.early_explanation {
                                            model.changed(true);
                                        } else {
                                            model.changed(false);
                                        }
                                    }
                                    Err(error) => {
                                        model.load_failed = true;
                                        model.view.error = Some(error);
                                        model.changed(false);
                                    }
                                }
                            }
                            Err(error) => {
                                model.load_failed = true;
                                model.view.error = Some(error);
                                model.changed(false);
                            }
                        }
                    });
                }
                Work::Save {
                    version,
                    revision,
                    fields,
                    foreign,
                } => {
                    let result =
                        save_preserving_conflicts(&*store, revision, fields, foreign).await;
                    self.update(|model| {
                        model.active = false;
                        match result {
                            Ok((revision, foreign)) => {
                                model.revision = revision;
                                model.persisted = version;
                                model.foreign = foreign;
                                if model.foreign.is_some() {
                                    model.view.error = Some("Another window changed unfinished imports. This input was kept as a recovered draft.".into());
                                    for row in &mut model.view.rows {
                                        row.automatic = false;
                                        if matches!(row.status, Status::Checking | Status::Validating | Status::Queued) {
                                            row.status = Status::Failed;
                                            row.error = Some("Unfinished input changed in another window; retry explicitly".into());
                                        }
                                    }
                                } else {
                                    model.view.error = None;
                                }
                            }
                            Err(error) => {
                                model.persistence_error = Some(error.clone());
                                model.view.error = Some(error);
                            }
                        }
                        model.changed(false);
                    });
                }
                Work::Validate {
                    ids,
                    paths,
                    learning,
                    explanation,
                    epoch,
                    generation,
                } => {
                    let result = store.validate(paths, learning, explanation).await;
                    self.update(|model| {
                        model.active = false;
                        if generation != self.generation.load(Ordering::Acquire) {
                            model.retire();
                            return;
                        }
                        if epoch != model.language_epoch {
                            model.changed(false);
                            return;
                        }
                        let mut seen = model
                            .view
                            .rows
                            .iter()
                            .filter(|row| !ids.contains(&row.id))
                            .map(|row| (row.language_pair.clone(), path_key(row.path())))
                            .collect::<Vec<_>>();
                        match result {
                            Ok(results) => {
                                for (id, result) in ids.into_iter().zip(results) {
                                    if let Some(row) = model.view.rows.iter_mut().find(|row| {
                                        row.id == id && row.status == Status::Validating
                                    }) {
                                        match result {
                                            MediaFileValidation::Ready {
                                                canonical_path, ..
                                            } => {
                                                row.canonical_path = Some(canonical_path);
                                                row.status = Status::Ready;
                                            }
                                            MediaFileValidation::Existing {
                                                canonical_path,
                                                media_id,
                                                ..
                                            } => {
                                                row.canonical_path = Some(canonical_path);
                                                row.media_id = Some(media_id);
                                                row.status = Status::Existing;
                                                row.automatic = false;
                                            }
                                            MediaFileValidation::Invalid { reason, .. } => {
                                                row.reason =
                                                    serde_json::to_value(reason).ok().and_then(
                                                        |value| value.as_str().map(str::to_owned),
                                                    );
                                                row.status = Status::Invalid;
                                                row.automatic = false;
                                            }
                                        }
                                        let key = (row.language_pair.clone(), path_key(row.path()));
                                        if seen.contains(&key) {
                                            row.id = 0;
                                        } else {
                                            seen.push(key);
                                        }
                                    }
                                }
                                model.view.rows.retain(|row| row.id != 0);
                            }
                            Err(error) => {
                                model.view.error = Some(error.clone());
                                for row in &mut model.view.rows {
                                    if ids.contains(&row.id) && row.status == Status::Validating {
                                        row.status = Status::Failed;
                                        row.error = Some(error.clone());
                                        row.automatic = false;
                                    }
                                }
                            }
                        }
                        model.changed(true);
                    });
                }
                Work::Import {
                    id,
                    generation,
                    request,
                } => {
                    let result = store.import(request).await;
                    self.update(|model| {
                        model.active = false;
                        if generation != self.generation.load(Ordering::Acquire) {
                            model.retire();
                            return;
                        }
                        if let Some(row) = model.view.rows.iter_mut().find(|row| row.id == id) {
                            row.automatic = false;
                            match result {
                                Ok(result) => {
                                    row.media_id = Some(result.media_id);
                                    row.status = if result.created {
                                        Status::Imported
                                    } else {
                                        Status::Existing
                                    };
                                    row.error = None;
                                }
                                Err(error) => {
                                    row.status = Status::Failed;
                                    row.error = Some(error);
                                }
                            }
                        }
                        model.changed(true);
                    });
                }
            }
        }
    }
}
fn parse_draft(draft: Option<&UiDraft>) -> Result<Vec<Row>, String> {
    let Some(draft) = draft else {
        return Ok(vec![]);
    };
    let mut rows: Vec<Row> = if let Some(rows) = draft.fields.get("rows") {
        serde_json::from_str(rows)
            .map_err(|error| format!("Could not read unfinished import files: {error}"))?
    } else {
        vec![]
    };
    if rows.is_empty()
        && let Some(paths) = draft.fields.get("paths")
    {
        let paths: Vec<String> = serde_json::from_str(paths).map_err(|error| error.to_string())?;
        rows = paths
            .into_iter()
            .enumerate()
            .map(|(index, path)| Row {
                id: index as u64 + 1,
                input_path: path,
                canonical_path: None,
                status: Status::Failed,
                reason: None,
                error: Some("Interrupted; retry to continue".into()),
                media_id: None,
                language_pair: String::new(),
                title: String::new(),
                automatic: false,
            })
            .collect();
    }
    for row in &mut rows {
        row.automatic = false;
        if draft.stale
            || matches!(
                row.status,
                Status::Checking
                    | Status::Validating
                    | Status::Ready
                    | Status::Queued
                    | Status::Importing
            )
        {
            row.status = Status::Failed;
            row.error = Some(
                if draft.stale {
                    "A backup was restored; validate the original file again"
                } else {
                    "Interrupted; retry to continue"
                }
                .into(),
            );
            if draft.stale {
                row.media_id = None;
            }
        }
    }
    Ok(rows)
}
async fn save_preserving_conflicts(
    store: &dyn ImportStore,
    revision: u64,
    fields: BTreeMap<String, String>,
    foreign: Option<UiDraft>,
) -> Result<(u64, Option<UiDraft>), String> {
    if let Some(foreign) = foreign {
        store.archive(foreign.fields).await?;
    }
    match store.save(revision, fields.clone()).await {
        Ok(saved) => Ok((saved.revision, None)),
        Err(error) => {
            let (latest, _, _) = store.load().await?;
            if latest.as_ref().map_or(0, |draft| draft.revision) == revision {
                return Err(error);
            }
            store.archive(fields).await?;
            Ok((latest.as_ref().map_or(0, |draft| draft.revision), latest))
        }
    }
}
pub(super) fn language_pair(learning: &str, explanation: &str) -> String {
    serde_json::to_string(&[
        languages::resolve(learning).to_ascii_lowercase(),
        languages::resolve(explanation).to_ascii_lowercase(),
    ])
    .unwrap()
}
fn path_key(path: &str) -> String {
    path.replace('\\', "/").to_lowercase()
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
