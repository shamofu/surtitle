mod archive;
mod cards;
pub(crate) mod editor_drafts;
mod media;
mod transcript;
pub(crate) mod transcript_issues;
use crate::*;
use anyhow::{Context, Result, ensure};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Serialize, de::DeserializeOwned};
use std::path::{Path, PathBuf};
pub(crate) mod draft_study;
mod management;
mod transcript_ranges;
pub use transcript_ranges::TranscriptRangeEdit;

/// Learning data only. Credentials, executable selections and charge ledgers live elsewhere.
pub struct Store {
    pub(crate) conn: Connection,
    pub path: PathBuf,
}
impl Store {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(&path)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS segments (id TEXT PRIMARY KEY, media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE, start_ms INTEGER NOT NULL, data TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS segments_media_time ON segments(media_id,start_ms);
            CREATE TABLE IF NOT EXISTS cards (id TEXT PRIMARY KEY, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS reviews (id TEXT PRIMARY KEY, card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS ai_result_applications (job_id TEXT NOT NULL, ordinal INTEGER NOT NULL, response_sha256 TEXT NOT NULL, applied_at TEXT NOT NULL, PRIMARY KEY(job_id,ordinal));
            CREATE TABLE IF NOT EXISTS transcript_drafts (job_id TEXT NOT NULL, job_digest TEXT NOT NULL, base_digest TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(job_id,job_digest,base_digest));
            CREATE TABLE IF NOT EXISTS transcript_draft_heads (job_id TEXT PRIMARY KEY, job_digest TEXT NOT NULL, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS transcript_adoptions (job_id TEXT PRIMARY KEY, job_digest TEXT NOT NULL, draft_digest TEXT NOT NULL, previous_segments_json TEXT NOT NULL, adopted_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS subtitle_versions (id TEXT PRIMARY KEY, media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE, data TEXT NOT NULL);
            PRAGMA user_version=1;")?;
        transcript_ranges::initialize(&conn)?;
        draft_study::initialize(&conn)?;
        editor_drafts::initialize(&conn)?;
        transcript_issues::initialize(&conn)?;
        Ok(Self { conn, path })
    }
    fn all<T: DeserializeOwned>(&self, sql: &str) -> Result<Vec<T>> {
        let mut stmt = self.conn.prepare(sql)?;
        let json = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        json.iter().map(|s| Ok(serde_json::from_str(s)?)).collect()
    }
    fn one<T: DeserializeOwned>(&self, sql: &str, id: &str) -> Result<T> {
        let json: String = self
            .conn
            .query_row(sql, [id], |r| r.get(0))
            .optional()?
            .context("item not found")?;
        Ok(serde_json::from_str(&json)?)
    }
}

pub fn subtitle_revision(segments: &[SubtitleSegment]) -> Result<String> {
    use sha2::{Digest, Sha256};
    let mut bytes = serde_json::to_vec(
        &segments
            .iter()
            .map(|s| (&s.id, &s.media_id, s.start_ms, s.end_ms, &s.text, &s.status))
            .collect::<Vec<_>>(),
    )?;
    // Preserve legacy revisions exactly while binding new review metadata to edits.
    if segments.iter().any(|s| !s.review_issues.is_empty()) {
        bytes.extend(serde_json::to_vec(
            &segments
                .iter()
                .map(|s| &s.review_issues)
                .collect::<Vec<_>>(),
        )?);
    }
    Ok(format!("{:x}", Sha256::digest(bytes)))
}
pub fn validate_transcript_range(
    current: &[SubtitleSegment],
    start_ms: u64,
    end_ms: u64,
    replacement: &[SubtitleSegment],
    media_id: &str,
) -> Result<()> {
    ensure!(start_ms < end_ms, "invalid transcript selection");
    for old in current
        .iter()
        .filter(|s| s.start_ms < end_ms && s.end_ms > start_ms)
    {
        ensure!(
            old.start_ms >= start_ms && old.end_ms <= end_ms,
            "selection cuts an existing subtitle; choose a range containing the whole cue"
        );
    }
    let mut ids = std::collections::HashSet::new();
    for segment in replacement {
        validate_segment(segment)?;
        ensure!(
            segment.media_id == media_id
                && crate::is_usable_subtitle_status(&segment.status)
                && segment.start_ms >= start_ms
                && segment.end_ms <= end_ms,
            "replacement subtitle lies outside the reviewed selection"
        );
        ensure!(ids.insert(&segment.id), "duplicate replacement subtitle ID");
    }
    Ok(())
}

pub fn validate_segment(s: &SubtitleSegment) -> Result<()> {
    ensure!(
        s.start_ms < s.end_ms && s.end_ms < 360_000_000_000,
        "invalid subtitle range"
    );
    ensure!(
        !s.text.trim().is_empty() && s.text.len() < 1024 * 1024,
        "invalid subtitle text"
    );
    ensure!(
        s.review_issues.len() <= 1000,
        "too many subtitle review issues"
    );
    for issue in &s.review_issues {
        ensure!(
            !issue.id.is_empty()
                && issue.id.len() <= 256
                && !issue.kind.is_empty()
                && issue.kind.len() <= 128
                && issue.start_ms < issue.end_ms
                && issue.end_ms < 360_000_000_000
                && issue.alternatives.len() <= 100_000,
            "invalid subtitle review issue"
        );
        for alternative in &issue.alternatives {
            ensure!(
                alternative.start_ms < alternative.end_ms
                    && alternative.end_ms < 360_000_000_000
                    && !alternative.text.trim().is_empty()
                    && alternative.text.len() < 1024 * 1024,
                "invalid subtitle review alternative"
            );
        }
    }
    Ok(())
}

pub fn write_json_atomic(path: &Path, value: &impl Serialize) -> Result<()> {
    let tmp = path.with_extension(format!("{}.tmp", id()));
    {
        use std::io::Write;
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(&serde_json::to_vec_pretty(value)?)?;
        file.sync_all()?;
    }
    // Rust uses replace-existing rename semantics on Windows too. Never delete
    // the old preferences first: a crash must not silently reset tool selections.
    std::fs::rename(tmp, path)?;
    Ok(())
}

#[cfg(test)]
#[path = "store/transcript_tests.rs"]
mod transcript_tests;
