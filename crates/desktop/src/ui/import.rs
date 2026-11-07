//! GPUI lifetime owner for the durable import workspace and owned import dialog.
use super::{
    editors::FlushFuture,
    session::{Backend, Session},
};
use crate::{
    application::library::{ImportRequest, LocalMediaImportResult, MediaFileValidation},
    commands,
};
use gpui_kit::{AppContext, Context, Entity};
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use surtitle_core::workspace::{ArchiveUiDraft, SaveUiDraft, UiDraft};

mod dialog;
mod languages;
mod workspace;
pub(super) use dialog::ImportDialog;
use workspace::{ImportStore, Task, Workspace};
pub(super) use workspace::{Status, View};

struct Store(Backend);
impl ImportStore for Store {
    fn load(&self) -> Task<(Option<UiDraft>, String, String)> {
        let backend = self.0.clone();
        Box::pin(async move {
            let state = backend.state;
            backend
                .host
                .runtime()
                .spawn_blocking(move || {
                    let draft = commands::ui_drafts::get_ui_draft(
                        &state,
                        "import".into(),
                        "default".into(),
                    )?;
                    let settings = state.settings().map_err(|error| error.to_string())?;
                    Ok((
                        draft,
                        settings.learning_language,
                        settings.explanation_language,
                    ))
                })
                .await
                .map_err(|error| error.to_string())?
        })
    }
    fn save(&self, revision: u64, fields: BTreeMap<String, String>) -> Task<UiDraft> {
        let backend = self.0.clone();
        Box::pin(async move {
            let state = backend.state;
            backend
                .host
                .runtime()
                .spawn_blocking(move || {
                    commands::ui_drafts::save_ui_draft(
                        &state,
                        SaveUiDraft {
                            kind: "import".into(),
                            entity_id: "default".into(),
                            expected_revision: revision,
                            fields,
                        },
                    )
                })
                .await
                .map_err(|error| error.to_string())?
        })
    }
    fn archive(&self, fields: BTreeMap<String, String>) -> Task<()> {
        let backend = self.0.clone();
        Box::pin(async move {
            let state = backend.state;
            backend
                .host
                .runtime()
                .spawn_blocking(move || {
                    commands::ui_drafts::archive_ui_draft(
                        &state,
                        ArchiveUiDraft {
                            kind: "import".into(),
                            entity_id: "default".into(),
                            fields,
                        },
                    )
                    .map(|_| ())
                })
                .await
                .map_err(|error| error.to_string())?
        })
    }
    fn validate(
        &self,
        paths: Vec<String>,
        learning: String,
        explanation: String,
    ) -> Task<Vec<MediaFileValidation>> {
        let backend = self.0.clone();
        Box::pin(async move {
            let state = backend.state;
            backend
                .host
                .runtime()
                .spawn_blocking(move || {
                    crate::application::library::validate_media_files(
                        state,
                        paths,
                        learning,
                        explanation,
                    )
                })
                .await
                .map_err(|error| error.to_string())?
        })
    }
    fn import(&self, request: ImportRequest) -> Task<LocalMediaImportResult> {
        let state = self.0.state.clone();
        Box::pin(async move { commands::library::import_local_media(&state, request).await })
    }
}

pub(super) struct ImportWorkspace {
    pub(super) backend: Backend,
    shared: Arc<Workspace>,
}
impl ImportWorkspace {
    pub fn new(backend: Backend, cx: &mut Context<Self>) -> Self {
        let shared = Workspace::new(backend.generation.clone());
        backend
            .host
            .runtime()
            .spawn(shared.clone().run(Arc::new(Store(backend.clone()))));
        cx.spawn(async move |workspace, cx| {
            let mut previous = 0;
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(40))
                    .await;
                if workspace
                    .update(cx, |workspace, cx| {
                        let changed = workspace.shared.view().change;
                        if previous != changed {
                            previous = changed;
                            cx.notify();
                        }
                    })
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
        Self { backend, shared }
    }
    pub fn view(&self) -> View {
        self.shared.view()
    }
    pub fn flush(&self) -> FlushFuture {
        self.shared.flush()
    }
    pub fn freeze(&self, frozen: bool, cx: &mut Context<Self>) {
        self.shared.freeze(frozen);
        cx.notify();
    }
    pub fn invalidate_after_restore(&self, cx: &mut Context<Self>) -> Result<(), String> {
        let result = self.shared.invalidate_after_restore();
        cx.notify();
        result
    }
    pub fn reload_after_discard(&self, cx: &mut Context<Self>) -> Result<(), String> {
        let result = self.shared.reload_after_discard();
        cx.notify();
        result
    }
    pub fn add(&self, paths: Vec<String>, automatic: bool, cx: &mut Context<Self>) {
        self.shared.add(paths, automatic);
        cx.notify();
    }
    pub fn languages(
        &self,
        learning: Option<String>,
        explanation: Option<String>,
        cx: &mut Context<Self>,
    ) {
        self.shared.languages(learning, explanation);
        cx.notify();
    }
    pub fn title(&self, id: u64, value: String, cx: &mut Context<Self>) {
        self.shared.title(id, value);
        cx.notify();
    }
    pub fn remove(&self, id: u64, cx: &mut Context<Self>) {
        self.shared.remove(id);
        cx.notify();
    }
    pub fn clear(&self, cx: &mut Context<Self>) {
        self.shared.clear();
        cx.notify();
    }
    pub fn retry(&self, ids: Option<Vec<u64>>, automatic: bool, cx: &mut Context<Self>) {
        self.shared.retry(ids, automatic);
        cx.notify();
    }
    pub fn submit(&self, cx: &mut Context<Self>) {
        self.shared.submit();
        cx.notify();
    }
    pub fn pick(&self, automatic: bool, cx: &mut Context<Self>) {
        if !self.shared.begin_picker() {
            return;
        }
        let shared = self.shared.clone();
        // No display-generation filter: a picker already opened remains part of
        // the import close/restore barrier until its actual result is collected.
        self.backend.host.runtime().spawn(async move {
            let result = commands::library::select_media_files().await;
            shared.end_picker(result, automatic);
        });
        cx.notify();
    }
}

pub(super) fn open(
    session: Entity<Session>,
    workspace: Entity<ImportWorkspace>,
    cx: &mut gpui_kit::App,
) -> anyhow::Result<gpui_kit::AnyWindowHandle> {
    gpui_kit::open_window(
        gpui_kit::WindowOptions {
            titlebar: Some(gpui_kit::TitlebarOptions {
                title: Some("Surtitle · 作品を追加 / Add media".into()),
                ..Default::default()
            }),
            ..crate::desktop::dialog::options(
                gpui_kit::size(gpui_kit::px(850.), gpui_kit::px(720.)),
                None,
                cx,
            )
        },
        cx,
        move |window, cx| cx.new(|cx| ImportDialog::new(session, workspace, window, cx)),
    )
    .map(|(window, _)| window)
}
