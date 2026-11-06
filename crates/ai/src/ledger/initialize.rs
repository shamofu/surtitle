//! SQLite schema and connection configuration.
#[cfg(test)]
use super::TEST_NOW_MS;
use super::{transcript_evidence, AiStore};
use crate::{AiError, Result};
use rusqlite::{Connection, OpenFlags, TransactionBehavior};
use std::path::Path;
use std::time::Duration;

impl AiStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        // Inspect the SQLite header before opening writable SQLite/WAL handles.
        // Older evaluation databases are evidence and are never migrated in place.
        if path.exists() && path.metadata()?.len() != 0 {
            use std::io::Read;
            let mut header = [0u8; 100];
            std::fs::File::open(&path)?.read_exact(&mut header)?;
            if &header[..16] != b"SQLite format 3\0"
                || ![2, 3].contains(&u32::from_be_bytes(header[60..64].try_into().unwrap()))
            {
                return Err(AiError::Invalid("Existing AI database has a different schema; preserve it and use a new data root".into()));
            }
            // A v2 evaluation database has distinct lifetime/campaign authority.
            // Inspect it read-only before any writable connection or WAL migration.
            let existing = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
            let version: u32 =
                existing.pragma_query_value(None, "user_version", |row| row.get(0))?;
            let evaluation: bool = existing.query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name IN ('ai_validation_settings','ai_validation_campaigns','ai_validation_campaign_jobs'))",
                [], |row| row.get(0),
            )?;
            if version == 2 && evaluation {
                return Err(AiError::Invalid(
                    "Preserve the v2 evaluation database and use a new evaluation data root".into(),
                ));
            }
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let store = Self {
            path,
            #[cfg(feature = "development-validation")]
            development: None,
            #[cfg(test)]
            clock: std::sync::Arc::new(std::sync::atomic::AtomicI64::new(TEST_NOW_MS)),
            // Dependency builds remain on real time until a test explicitly
            // freezes this store. Unit tests above retain their fixed epoch.
            #[cfg(all(not(test), feature = "test-support"))]
            clock: std::sync::Arc::new(std::sync::atomic::AtomicI64::new(i64::MIN)),
        };
        let mut conn = store.connect()?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;")?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute_batch("
            CREATE TABLE IF NOT EXISTS ai_jobs (
                id TEXT PRIMARY KEY, digest TEXT NOT NULL UNIQUE, plan_json TEXT NOT NULL,
                state TEXT NOT NULL DEFAULT 'prepared', created_at_ms INTEGER NOT NULL,
                quote_expires_at_ms INTEGER NOT NULL, approved_at_ms INTEGER, approval_json TEXT);
            CREATE TABLE IF NOT EXISTS ai_requests (
                job_id TEXT NOT NULL REFERENCES ai_jobs(id), ordinal INTEGER NOT NULL,
                state TEXT NOT NULL DEFAULT 'pending', response_json TEXT, error_code TEXT,
                PRIMARY KEY(job_id,ordinal));
            CREATE TABLE IF NOT EXISTS ai_attempts (
                id TEXT PRIMARY KEY, job_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
                state TEXT NOT NULL, reserve_microusd INTEGER CHECK(reserve_microusd>=0),
                charged_microusd INTEGER CHECK(charged_microusd>=0), created_at_ms INTEGER NOT NULL,
                dispatched_at_ms INTEGER, settled_at_ms INTEGER, usage_json TEXT, model_version TEXT,
                FOREIGN KEY(job_id,ordinal) REFERENCES ai_requests(job_id,ordinal));
            CREATE UNIQUE INDEX IF NOT EXISTS ai_one_outbound_request ON ai_attempts((1)) WHERE state='reserved';
            CREATE INDEX IF NOT EXISTS ai_spend_period ON ai_attempts(created_at_ms);
            CREATE TABLE IF NOT EXISTS ai_audit (id INTEGER PRIMARY KEY, at_ms INTEGER NOT NULL, event TEXT NOT NULL, job_id TEXT, detail TEXT);
            CREATE TABLE IF NOT EXISTS ai_job_issues (id INTEGER PRIMARY KEY, job_id TEXT NOT NULL REFERENCES ai_jobs(id), data TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
            CREATE TABLE IF NOT EXISTS ai_local_applications (job_id TEXT PRIMARY KEY REFERENCES ai_jobs(id), job_digest TEXT NOT NULL, applied_at_ms INTEGER NOT NULL);
        ")?;
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS ai_provider_settings (
                provider TEXT PRIMARY KEY CHECK(provider IN ('vertex','openai')), limits_json TEXT NOT NULL);
             INSERT OR IGNORE INTO ai_provider_settings VALUES ('vertex','{\"per_job_microusd\":0,\"daily_microusd\":0,\"monthly_microusd\":0}');
             INSERT OR IGNORE INTO ai_provider_settings VALUES ('openai','{\"per_job_microusd\":0,\"daily_microusd\":0,\"monthly_microusd\":0}');
             CREATE INDEX IF NOT EXISTS ai_jobs_provider ON ai_jobs(COALESCE(json_extract(plan_json,'$.execution.provider'),'vertex'));",
        )?;
        let legacy_settings: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='ai_settings')",
            [],
            |row| row.get(0),
        )?;
        if legacy_settings {
            // No runtime consumer remains: move the legacy Vertex limit once,
            // then retain one authoritative budget row per provider.
            tx.execute_batch(
                "UPDATE ai_provider_settings SET limits_json=(SELECT limits_json FROM ai_settings WHERE id=1) WHERE provider='vertex';
                 DROP TABLE ai_settings;",
            )?;
        }
        transcript_evidence::initialize(&tx)?;
        super::retries::initialize(&tx)?;
        super::pacing::initialize(&tx)?;
        tx.execute_batch("PRAGMA user_version=3;")?;
        tx.commit()?;
        Ok(store)
    }

    pub(super) fn connect(&self) -> Result<Connection> {
        let conn = Connection::open(&self.path)?;
        conn.busy_timeout(Duration::from_secs(5))?;
        conn.execute_batch("PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;")?;
        Ok(conn)
    }
}
