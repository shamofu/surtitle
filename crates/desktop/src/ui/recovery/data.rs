use super::super::session::Backend;
use crate::{
    application::{AppState, continuations::AiContinuation},
    commands,
};
use std::sync::atomic::Ordering;
use surtitle_core::{EditorDraftVersion, EditorDraftView, workspace::UiDraft};

#[derive(Clone, Debug)]
pub(crate) enum RecoveryItem {
    Ui(UiDraft),
    Source(EditorDraftView),
    Ai(AiContinuation),
}
impl RecoveryItem {
    pub fn id(&self) -> String {
        match self {
            Self::Ui(draft) => draft
                .archive_id
                .as_ref()
                .map(|id| format!("archive-{id}"))
                .unwrap_or_else(|| format!("ui-{}-{}", draft.kind, draft.entity_id)),
            Self::Source(draft) => format!("source-{}", draft.draft.id),
            Self::Ai(value) => format!("ai-{}", value.id),
        }
    }
    pub fn label(&self, ja: bool) -> String {
        let t = |ja_text, en_text| if ja { ja_text } else { en_text };
        let (kind, fields, time) = match self {
            Self::Ui(draft) => (
                draft.kind.as_str(),
                Some(&draft.fields),
                draft.updated_at.clone(),
            ),
            Self::Source(draft) => (
                draft.draft.kind.as_str(),
                Some(&draft.draft.fields),
                draft.draft.updated_at.clone(),
            ),
            Self::Ai(value) => (
                value.kind.as_str(),
                None,
                chrono::DateTime::from_timestamp_millis(value.updated_at_ms)
                    .map(|time| time.format("%Y-%m-%d %H:%M").to_string())
                    .unwrap_or_default(),
            ),
        };
        let title = fields
            .and_then(|fields| fields.get("term").or_else(|| fields.get("text")))
            .filter(|text| !text.trim().is_empty())
            .map(|text| text.chars().take(38).collect::<String>())
            .unwrap_or_else(|| {
                match kind {
                    "settings" => t("設定", "Settings"),
                    "import" => t("取り込み", "Imports"),
                    "card" | "draft_card" | "phrase" => t("フレーズ", "Phrase"),
                    "subtitle" => t("字幕", "Subtitle"),
                    "transcript_review" => t("字幕の確認", "Transcript review"),
                    _ => t("AI の依頼", "AI request"),
                }
                .into()
            });
        format!("{title} · {time}")
    }
    pub fn text(&self) -> String {
        match self {
            Self::Ui(draft) => {
                let mut fields = draft.fields.clone();
                fields.remove("baseRevision");
                let recovery = fields.remove("recovery");
                [
                    (!fields.is_empty()).then(|| serde_json::to_string_pretty(&fields).unwrap()),
                    recovery,
                ]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join("\n\n")
            }
            Self::Source(draft) => serde_json::to_string_pretty(&draft.draft.fields).unwrap(),
            Self::Ai(value) => serde_json::to_string_pretty(value).unwrap(),
        }
    }
    pub fn status(&self, ja: bool) -> &'static str {
        let t = |ja_text, en_text| if ja { ja_text } else { en_text };
        match self {
            Self::Ui(draft) if draft.archive_id.is_some() => t(
                "競合時に保存した記録です。内容をコピーできます。",
                "Archived conflicting input; copy the text you need.",
            ),
            Self::Ui(draft) if draft.stale || draft.fields.contains_key("recovery") => t(
                "以前の状態に対する入力です。現在の内容を確認してから続けてください。",
                "Earlier input; review the current content before recovering.",
            ),
            Self::Source(draft) if draft.stale => t(
                "出典が変更されています。再開後に現在の字幕を確認し、明示的に関連付け直してください。",
                "Source changed; review and explicitly rebind before saving.",
            ),
            Self::Ai(_) => t(
                "再開しても AI は自動実行されません。",
                "Resuming does not run AI automatically.",
            ),
            _ => t("保存済みの未完了入力です。", "Saved unfinished input."),
        }
    }
    pub fn can_open(&self) -> bool {
        !matches!(self,Self::Ui(draft) if draft.archive_id.is_some())
    }
    pub fn can_recover(&self) -> bool {
        matches!(self,Self::Ui(draft) if draft.archive_id.is_none() && matches!(draft.kind.as_str(),"settings"|"card"|"draft_card") && (draft.stale || draft.fields.contains_key("recovery")))
    }
    pub fn can_discard(&self) -> bool {
        matches!(self,Self::Ui(draft) if draft.archive_id.is_none())
            || matches!(self, Self::Source(_))
    }
}
pub(super) fn load(state: &AppState) -> Result<Vec<RecoveryItem>, String> {
    let mut rows: Vec<_> = commands::ui_drafts::list_ui_drafts(state)?
        .into_iter()
        .filter(|draft| draft.fields.keys().any(|key| key != "baseRevision"))
        .map(RecoveryItem::Ui)
        .collect();
    for media in commands::ai::get_app_snapshot(state)?.media {
        rows.extend(
            commands::editor_drafts::list_editor_drafts(state, media.id)?
                .into_iter()
                .map(RecoveryItem::Source),
        );
    }
    rows.extend(
        commands::continuations::list_ai_continuations(state)?
            .into_iter()
            .map(RecoveryItem::Ai),
    );
    Ok(rows)
}
/// Root retains its full flush/freeze gate through this future, then retires the
/// matching UI/source writer before resuming edits. The captured revision is CAS.
pub(crate) async fn discard(backend: Backend, item: RecoveryItem) -> Result<(), String> {
    if !backend.exclusive.load(Ordering::Acquire) {
        return Err("Save and freeze input before discarding a draft".into());
    }
    let generation = backend.generation.load(Ordering::Acquire);
    let runtime = backend.host.runtime().clone();
    runtime
        .spawn_blocking(move || {
            if !backend.exclusive.load(Ordering::Acquire)
                || backend.generation.load(Ordering::Acquire) != generation
            {
                return Err("The workspace changed before discarding".into());
            }
            match item {
                RecoveryItem::Ui(draft) if draft.archive_id.is_none() => {
                    commands::ui_drafts::delete_ui_draft(
                        &backend.state,
                        draft.kind,
                        draft.entity_id,
                        draft.revision,
                    )
                }
                RecoveryItem::Source(draft) => commands::editor_drafts::delete_editor_draft(
                    &backend.state,
                    EditorDraftVersion {
                        id: draft.draft.id,
                        version: draft.draft.version,
                    },
                ),
                _ => Err(
                    "Archived input is copy-only; manage AI requests in their own editor".into(),
                ),
            }
        })
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests;
