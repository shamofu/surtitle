//! Device-local unfinished input. Never part of learning exports or execution authority.
use anyhow::{Context, Result, ensure};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::Path};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UiDraft {
    pub kind: String,
    pub entity_id: String,
    pub revision: u64,
    pub fields: BTreeMap<String, String>,
    pub updated_at: String,
    pub stale: bool,
    /// Immutable detached input. This record can only be listed/read, never resumed automatically.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archive_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveUiDraft {
    pub kind: String,
    pub entity_id: String,
    pub expected_revision: u64,
    pub fields: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArchiveUiDraft {
    pub kind: String,
    pub entity_id: String,
    pub fields: BTreeMap<String, String>,
}

pub struct WorkspaceStore {
    conn: Connection,
}

fn validate_identity(kind: &str, entity_id: &str) -> Result<()> {
    ensure!(
        ["settings", "card", "draft_card", "import"].contains(&kind),
        "Unknown draft kind"
    );
    ensure!(
        !entity_id.is_empty() && entity_id.len() <= 128,
        "Invalid draft identity"
    );
    ensure!(
        ["card", "draft_card"].contains(&kind) || entity_id == "default",
        "Invalid singleton draft identity"
    );
    Ok(())
}

fn validate_fields(kind: &str, fields: &BTreeMap<String, String>) -> Result<()> {
    let allowed: &[&str] = match kind {
        "settings" => &[
            "locale",
            "theme",
            "motionPreference",
            "captionGapMode",
            "learningLanguage",
            "explanationLanguage",
            "retention",
            "retentionInput",
            "sentencePause",
            "replayContextMs",
            "proficiency",
            "vertexLocation",
            "dailyBudgetUsd",
            "monthlyBudgetUsd",
            "perJobBudgetUsd",
            "aiModels",
            "modelInputs",
            "baseRevision",
            "recovery",
        ],
        "card" => &[
            "term",
            "meaning",
            "example",
            "translation",
            "explanation",
            "baseRevision",
            "recovery",
        ],
        "draft_card" => &[
            "term",
            "meaning",
            "translation",
            "explanation",
            "baseRevision",
            "recovery",
        ],
        "import" => &["learningLanguage", "explanationLanguage", "paths", "rows"],
        _ => anyhow::bail!("Unknown draft kind"),
    };
    ensure!(
        fields.keys().all(|key| allowed.contains(&key.as_str())),
        "Unknown or private draft field"
    );
    ensure!(
        fields.values().all(|value| value.len() <= 256 * 1024)
            && serde_json::to_vec(fields)?.len() <= 512 * 1024,
        "Draft input is too large"
    );
    if let Some(value) = fields.get("recovery") {
        let recovered: BTreeMap<String, String> =
            serde_json::from_str(value).context("Invalid recovered input")?;
        ensure!(
            !recovered.contains_key("recovery"),
            "Nested recovery is not supported"
        );
        validate_fields(kind, &recovered)?;
    }
    // These fields contain structured, non-secret model form values. Reject
    // credential-shaped properties rather than accepting arbitrary nested JSON.
    for name in ["aiModels", "modelInputs"] {
        if let Some(value) = fields.get(name) {
            let json: serde_json::Value =
                serde_json::from_str(value).context("Invalid model draft data")?;
            validate_model_fields(&json, true)?;
        }
    }
    Ok(())
}

fn validate_model_fields(value: &serde_json::Value, purposes: bool) -> Result<()> {
    let object = value.as_object().context("Invalid model draft object")?;
    for (key, value) in object {
        if purposes {
            ensure!(
                ["transcription", "translation", "vocabulary", "explanation"]
                    .contains(&key.as_str()),
                "Unknown model draft purpose"
            );
            if !value.is_null() {
                validate_model_fields(value, false)?;
            }
        } else {
            ensure!(
                [
                    "modelId",
                    "transcriptionMode",
                    "maxOutputTokens",
                    "thinkingLevel",
                    "thinkingBudget",
                    "price",
                    "manual",
                    "input",
                    "output",
                    "inputRate",
                    "outputRate"
                ]
                .contains(&key.as_str()),
                "Unknown or private model draft field"
            );
            if key == "price" && !value.is_null() {
                let price = value.as_object().context("Invalid price draft")?;
                ensure!(
                    price.keys().all(|key| [
                        "id",
                        "source",
                        "observedAtMs",
                        "inputMicrousdPerMillion",
                        "outputMicrousdPerMillion"
                    ]
                    .contains(&key.as_str()))
                        && price
                            .values()
                            .all(|value| !value.is_object() && !value.is_array()),
                    "Invalid price draft field"
                );
            } else {
                ensure!(
                    !value.is_object() && !value.is_array(),
                    "Invalid model draft value"
                );
            }
        }
    }
    Ok(())
}

impl WorkspaceStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let conn = Connection::open(path)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        let version: u32 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        ensure!(
            version <= 1,
            "Workspace data was created by a newer application"
        );
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS ui_drafts (
                kind TEXT NOT NULL, entity_id TEXT NOT NULL,
                revision INTEGER NOT NULL CHECK(revision > 0), fields TEXT NOT NULL,
                updated_at TEXT NOT NULL, learning_generation TEXT,
                PRIMARY KEY(kind,entity_id));
            CREATE TABLE IF NOT EXISTS workspace_metadata (key TEXT PRIMARY KEY,value INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS ui_draft_recovery (
                id TEXT PRIMARY KEY, kind TEXT NOT NULL, entity_id TEXT NOT NULL,
                revision INTEGER NOT NULL, fields TEXT NOT NULL, updated_at TEXT NOT NULL);
            INSERT OR IGNORE INTO workspace_metadata VALUES('revision',0);
            PRAGMA user_version=1;")?;
        Ok(Self { conn })
    }

    pub fn get(&self, kind: &str, entity_id: &str, generation: &str) -> Result<Option<UiDraft>> {
        validate_identity(kind, entity_id)?;
        let row: Option<(i64, String, String, Option<String>)> = self.conn.query_row(
            "SELECT revision,fields,updated_at,learning_generation FROM ui_drafts WHERE kind=? AND entity_id=?",
            params![kind, entity_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ).optional()?;
        row.map(|(revision, fields, updated_at, bound)| {
            Ok(UiDraft {
                kind: kind.into(),
                entity_id: entity_id.into(),
                revision: revision as u64,
                fields: serde_json::from_str(&fields)?,
                updated_at,
                stale: ["card", "draft_card"].contains(&kind)
                    && bound.as_deref() != Some(generation),
                archive_id: None,
            })
        })
        .transpose()
    }

    pub fn list(&self, generation: &str) -> Result<Vec<UiDraft>> {
        let mut statement = self
            .conn
            .prepare("SELECT kind,entity_id FROM ui_drafts ORDER BY updated_at DESC")?;
        let identities = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut drafts = Vec::new();
        for (kind, entity_id) in identities {
            if let Some(draft) = self.get(&kind, &entity_id, generation)? {
                drafts.push(draft);
            }
        }
        let mut archives = self.conn.prepare("SELECT id,kind,entity_id,revision,fields,updated_at FROM ui_draft_recovery ORDER BY updated_at DESC")?;
        let records = archives
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (id, kind, entity_id, revision, fields, updated_at) in records {
            drafts.push(UiDraft {
                kind,
                entity_id,
                revision: revision as u64,
                fields: serde_json::from_str(&fields)?,
                updated_at,
                stale: true,
                archive_id: Some(id),
            });
        }
        drafts.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(drafts)
    }

    /// Preserve a competing writer's complete input without changing its active draft.
    pub fn archive(&mut self, request: &ArchiveUiDraft) -> Result<UiDraft> {
        validate_identity(&request.kind, &request.entity_id)?;
        validate_fields(&request.kind, &request.fields)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let count: u32 = tx.query_row("SELECT COUNT(*) FROM ui_draft_recovery", [], |row| {
            row.get(0)
        })?;
        ensure!(count < 1000, "Too many recovered drafts");
        let revision: i64 = tx.query_row(
            "UPDATE workspace_metadata SET value=value+1 WHERE key='revision' RETURNING value",
            [],
            |row| row.get(0),
        )?;
        let id = uuid::Uuid::new_v4().to_string();
        let updated_at = crate::now();
        tx.execute("INSERT INTO ui_draft_recovery(id,kind,entity_id,revision,fields,updated_at) VALUES(?,?,?,?,?,?)",
            params![id,request.kind,request.entity_id,revision,serde_json::to_string(&request.fields)?,updated_at])?;
        tx.commit()?;
        Ok(UiDraft {
            kind: request.kind.clone(),
            entity_id: request.entity_id.clone(),
            revision: revision as u64,
            fields: request.fields.clone(),
            updated_at,
            stale: true,
            archive_id: Some(id),
        })
    }

    pub fn save(&mut self, request: &SaveUiDraft, generation: &str) -> Result<UiDraft> {
        validate_identity(&request.kind, &request.entity_id)?;
        validate_fields(&request.kind, &request.fields)?;
        ensure!(
            request.expected_revision < i64::MAX as u64,
            "Invalid draft revision"
        );
        let fields = serde_json::to_string(&request.fields)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let actual: Option<i64> = tx
            .query_row(
                "SELECT revision FROM ui_drafts WHERE kind=? AND entity_id=?",
                params![request.kind, request.entity_id],
                |row| row.get(0),
            )
            .optional()?;
        ensure!(
            actual.unwrap_or(0) as u64 == request.expected_revision,
            "Draft changed; reload before saving"
        );
        if actual.is_none() {
            let count: u32 =
                tx.query_row("SELECT COUNT(*) FROM ui_drafts", [], |row| row.get(0))?;
            ensure!(count < 1000, "Too many unfinished drafts");
        }
        // A global monotonic token also prevents an old writer from matching a
        // deleted-and-recreated draft's revision (the ABA problem).
        let revision: i64 = tx.query_row(
            "UPDATE workspace_metadata SET value=value+1 WHERE key='revision' RETURNING value",
            [],
            |row| row.get(0),
        )?;
        let updated_at = crate::now();
        tx.execute("INSERT INTO ui_drafts(kind,entity_id,revision,fields,updated_at,learning_generation) VALUES(?,?,?,?,?,?)
            ON CONFLICT(kind,entity_id) DO UPDATE SET revision=excluded.revision,fields=excluded.fields,updated_at=excluded.updated_at,learning_generation=excluded.learning_generation",
            params![request.kind,request.entity_id,revision,fields,updated_at,if ["card", "draft_card"].contains(&request.kind.as_str()) { Some(generation) } else { None }])?;
        tx.commit()?;
        Ok(UiDraft {
            kind: request.kind.clone(),
            entity_id: request.entity_id.clone(),
            revision: revision as u64,
            fields: request.fields.clone(),
            updated_at,
            stale: false,
            archive_id: None,
        })
    }

    pub fn delete(&self, kind: &str, entity_id: &str, expected_revision: u64) -> Result<()> {
        validate_identity(kind, entity_id)?;
        let expected_revision =
            i64::try_from(expected_revision).context("Invalid draft revision")?;
        let changed = self.conn.execute(
            "DELETE FROM ui_drafts WHERE kind=? AND entity_id=? AND revision=?",
            params![kind, entity_id, expected_revision],
        )?;
        ensure!(changed == 1, "Draft changed; reload before discarding");
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(kind: &str, key: &str, value: &str) -> SaveUiDraft {
        SaveUiDraft {
            kind: kind.into(),
            entity_id: if kind == "card" { "card-1" } else { "default" }.into(),
            expected_revision: 0,
            fields: [(key.into(), value.into())].into(),
        }
    }
    #[test]
    fn caption_gap_mode_draft_survives_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.sqlite");
        let mut store = WorkspaceStore::open(&path).unwrap();
        let saved = store
            .save(&request("settings", "captionGapMode", "preview"), "a")
            .unwrap();
        drop(store);
        let reopened = WorkspaceStore::open(path).unwrap();
        assert_eq!(
            reopened.get("settings", "default", "b").unwrap(),
            Some(saved)
        );
    }
    #[test]
    fn raw_invalid_input_survives_restart_and_cas_protects_newer_writes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.sqlite");
        let mut store = WorkspaceStore::open(&path).unwrap();
        let mut input = request("settings", "retention", "-");
        let first = store.save(&input, "a").unwrap();
        assert_eq!(first.revision, 1);
        assert!(store.save(&input, "a").is_err());
        input.expected_revision = 1;
        input.fields.insert("retention".into(), "".into());
        let second = store.save(&input, "a").unwrap();
        assert!(store.delete("settings", "default", 1).is_err());
        drop(store);
        let reopened = WorkspaceStore::open(path).unwrap();
        assert_eq!(
            reopened.get("settings", "default", "b").unwrap(),
            Some(second)
        );
    }
    #[test]
    fn restoration_detaches_card_drafts_without_losing_text() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = WorkspaceStore::open(dir.path().join("workspace.sqlite")).unwrap();
        store
            .save(&request("card", "meaning", "unfinished"), "before")
            .unwrap();
        let draft = store.get("card", "card-1", "after").unwrap().unwrap();
        assert!(draft.stale);
        assert_eq!(draft.fields["meaning"], "unfinished");
    }
    #[test]
    fn restoration_detaches_unfinished_draft_cards_and_rejects_private_fields() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = WorkspaceStore::open(dir.path().join("workspace.sqlite")).unwrap();
        let input = SaveUiDraft {
            kind: "draft_card".into(),
            entity_id: "selection".into(),
            expected_revision: 0,
            fields: [
                ("term".into(), " raw ".into()),
                ("meaning".into(), "".into()),
                ("baseRevision".into(), "2".into()),
            ]
            .into(),
        };
        let saved = store.save(&input, "before").unwrap();
        let stale = store
            .get("draft_card", "selection", "after")
            .unwrap()
            .unwrap();
        assert!(stale.stale);
        assert_eq!(stale.fields, saved.fields);
        let mut private = input;
        private.expected_revision = saved.revision;
        private
            .fields
            .insert("credentialId".into(), "private".into());
        assert!(store.save(&private, "after").is_err());
    }
    #[test]
    fn private_fields_and_unknown_payloads_never_enter_workspace_storage() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = WorkspaceStore::open(dir.path().join("workspace.sqlite")).unwrap();
        for (key, value) in [
            ("credentialId", "key"),
            ("vertexProject", "project"),
            ("payload", "{}"),
            ("aiModels", r#"{"translation":{"private_key":"secret"}}"#),
        ] {
            assert!(store.save(&request("settings", key, value), "a").is_err());
        }
        assert!(store.get("settings", "default", "a").unwrap().is_none());
    }
    #[test]
    fn rejected_storage_write_keeps_previous_raw_fields_and_revision() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = WorkspaceStore::open(dir.path().join("workspace.sqlite")).unwrap();
        let mut input = request("import", "paths", "[\"C:/media/video.mp4\"]");
        let first = store.save(&input, "a").unwrap();
        store.conn.execute_batch("CREATE TRIGGER reject_draft BEFORE UPDATE ON ui_drafts BEGIN SELECT RAISE(ABORT,'no space'); END;").unwrap();
        input.expected_revision = 1;
        input.fields.insert("paths".into(), "[]".into());
        assert!(store.save(&input, "a").is_err());
        assert_eq!(store.get("import", "default", "a").unwrap(), Some(first));
    }
    #[test]
    fn deleted_and_recreated_drafts_do_not_accept_an_old_writer() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = WorkspaceStore::open(dir.path().join("workspace.sqlite")).unwrap();
        let mut input = request("card", "meaning", "old");
        let first = store.save(&input, "a").unwrap();
        store.delete("card", "card-1", first.revision).unwrap();
        let replacement = store.save(&input, "a").unwrap();
        assert!(replacement.revision > first.revision);
        input.expected_revision = first.revision;
        assert!(store.save(&input, "a").is_err());
    }
    #[test]
    fn conflict_archives_survive_restart_without_replacing_or_resuming_active_input() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.sqlite");
        let mut store = WorkspaceStore::open(&path).unwrap();
        let first = store
            .save(&request("settings", "retention", "-"), "a")
            .unwrap();
        let archived = store
            .archive(&ArchiveUiDraft {
                kind: "settings".into(),
                entity_id: "default".into(),
                fields: [("retention".into(), "89.".into())].into(),
            })
            .unwrap();
        let third = store
            .archive(&ArchiveUiDraft {
                kind: "settings".into(),
                entity_id: "default".into(),
                fields: [("retention".into(), "90.".into())].into(),
            })
            .unwrap();
        assert_ne!(archived.archive_id, third.archive_id);
        assert!(archived.stale);
        // Normal saves and deletes have no archive identity to target.
        store.delete("settings", "default", first.revision).unwrap();
        drop(store);
        let reopened = WorkspaceStore::open(path).unwrap();
        assert!(reopened.get("settings", "default", "b").unwrap().is_none());
        let recovered = reopened.list("b").unwrap();
        assert_eq!(recovered.len(), 2);
        assert!(recovered.contains(&archived));
        assert!(recovered.contains(&third));
    }
    #[test]
    fn archive_validates_original_kind_and_failed_archives_preserve_active_draft() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = WorkspaceStore::open(dir.path().join("workspace.sqlite")).unwrap();
        let first = store
            .save(&request("card", "meaning", "active input"), "a")
            .unwrap();
        assert!(
            store
                .archive(&ArchiveUiDraft {
                    kind: "card".into(),
                    entity_id: "card-1".into(),
                    fields: [("credentialId".into(), "private".into())].into()
                })
                .is_err()
        );
        store.conn.execute_batch("CREATE TRIGGER reject_archive BEFORE INSERT ON ui_draft_recovery BEGIN SELECT RAISE(ABORT,'no space'); END;").unwrap();
        assert!(
            store
                .archive(&ArchiveUiDraft {
                    kind: "card".into(),
                    entity_id: "card-1".into(),
                    fields: [("meaning".into(), "competing input".into())].into()
                })
                .is_err()
        );
        assert_eq!(store.list("a").unwrap(), vec![first]);
    }
    #[test]
    fn unfinished_model_integer_inputs_are_validated_and_survive_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.sqlite");
        let mut store = WorkspaceStore::open(&path).unwrap();
        let first = store
            .save(
                &request(
                    "settings",
                    "modelInputs",
                    r#"{"translation":{"maxOutputTokens":"-","thinkingBudget":"8192."}}"#,
                ),
                "a",
            )
            .unwrap();
        drop(store);
        let reopened = WorkspaceStore::open(path).unwrap();
        assert_eq!(
            reopened.get("settings", "default", "b").unwrap(),
            Some(first)
        );
    }
}
