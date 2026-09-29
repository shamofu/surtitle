//! SQLite schema and connection configuration.
#[cfg(test)]
use super::TEST_NOW_MS;
use super::{transcript_evidence, AiStore};
use crate::{AiError, Result};
use rusqlite::Connection;
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
                || u32::from_be_bytes(header[60..64].try_into().unwrap()) != 2
            {
                return Err(AiError::Invalid("Existing AI database has a different schema; preserve it and use a new data root".into()));
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
        };
        let conn = store.connect()?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS ai_settings (id INTEGER PRIMARY KEY CHECK(id=1), limits_json TEXT NOT NULL);
            INSERT OR IGNORE INTO ai_settings VALUES (1, '{\"per_job_microusd\":0,\"daily_microusd\":0,\"monthly_microusd\":0}');
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
            PRAGMA user_version=2;
        ")?;
        transcript_evidence::initialize(&conn)?;
        Ok(store)
    }

    pub(super) fn connect(&self) -> Result<Connection> {
        let conn = Connection::open(&self.path)?;
        conn.busy_timeout(Duration::from_secs(5))?;
        conn.execute_batch("PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;")?;
        Ok(conn)
    }
}
