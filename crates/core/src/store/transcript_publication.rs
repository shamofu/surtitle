//! Device-local ownership for gradual publication. Provider responses remain immutable.
use super::*;
use rusqlite::TransactionBehavior;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptPublicationRange {
    pub start_ms: u64,
    pub end_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptPublicationReport {
    pub changed: bool,
    pub detached: bool,
    pub protected_ranges: Vec<TranscriptPublicationRange>,
    pub deferred_segment_ids: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PublicationSession {
    start_ms: u64,
    end_ms: u64,
    baseline: Vec<SubtitleSegment>,
    expected: Vec<SubtitleSegment>,
    owned: Vec<SubtitleSegment>,
    protected_ranges: Vec<TranscriptPublicationRange>,
    received_ranges: Vec<TranscriptPublicationRange>,
    latest_projection: Vec<SubtitleSegment>,
    deferred_segment_ids: Vec<String>,
    projection_sha256: String,
    version_saved: bool,
}

pub(super) fn initialize(connection: &Connection) -> Result<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS transcript_publications (
            job_id TEXT PRIMARY KEY, job_digest TEXT NOT NULL,
            media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
            detached INTEGER NOT NULL DEFAULT 0, finished INTEGER NOT NULL DEFAULT 0,
            activated INTEGER NOT NULL DEFAULT 0,
            data TEXT NOT NULL);
         CREATE INDEX IF NOT EXISTS transcript_publications_media ON transcript_publications(media_id);",
    )?;
    Ok(())
}

fn hash(segment: &SubtitleSegment) -> Result<String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(segment)?)
    ))
}

fn range(segment: &SubtitleSegment) -> TranscriptPublicationRange {
    TranscriptPublicationRange {
        start_ms: segment.start_ms,
        end_ms: segment.end_ms,
    }
}

fn overlaps(a: TranscriptPublicationRange, b: TranscriptPublicationRange) -> bool {
    a.start_ms < b.end_ms && a.end_ms > b.start_ms
}

fn normalize(mut ranges: Vec<TranscriptPublicationRange>) -> Vec<TranscriptPublicationRange> {
    ranges.sort_by_key(|range| (range.start_ms, range.end_ms));
    let mut merged: Vec<TranscriptPublicationRange> = Vec::new();
    for range in ranges {
        if let Some(previous) = merged.last_mut()
            && range.start_ms <= previous.end_ms
        {
            previous.end_ms = previous.end_ms.max(range.end_ms);
        } else {
            merged.push(range);
        }
    }
    merged
}

fn covered(whole: TranscriptPublicationRange, ranges: &[TranscriptPublicationRange]) -> bool {
    ranges
        .iter()
        .any(|range| range.start_ms <= whole.start_ms && range.end_ms >= whole.end_ms)
}

fn read_segments(connection: &Connection, media_id: &str) -> Result<Vec<SubtitleSegment>> {
    let mut statement =
        connection.prepare("SELECT data FROM segments WHERE media_id=? ORDER BY start_ms,id")?;
    let json = statement
        .query_map([media_id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    json.iter()
        .map(|value| Ok(serde_json::from_str(value)?))
        .collect()
}

/// Retire a previous issue only when its complete interval has been received
/// and no locally protected or retained pending cue still owns that interval.
fn deactivate_replaced_issues(
    connection: &Connection,
    media_id: &str,
    received: &[TranscriptPublicationRange],
    protected: &[TranscriptPublicationRange],
    retained_pending: &[TranscriptPublicationRange],
    current_issues: &[TranscriptIssueRecord],
) -> Result<bool> {
    let current_ids = current_issues
        .iter()
        .map(|issue| issue.id.as_str())
        .collect::<HashSet<_>>();
    let records = {
        let mut statement =
            connection.prepare("SELECT data FROM transcript_issues WHERE media_id=?")?;
        statement
            .query_map([media_id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    let mut changed = false;
    for json in records {
        let mut issue: TranscriptIssueRecord = serde_json::from_str(&json)?;
        let interval = TranscriptPublicationRange {
            start_ms: issue.start_ms,
            end_ms: issue.end_ms,
        };
        if issue.active
            && !current_ids.contains(issue.id.as_str())
            && covered(interval, received)
            && !protected
                .iter()
                .chain(retained_pending)
                .any(|range| overlaps(interval, *range))
        {
            issue.active = false;
            connection.execute(
                "UPDATE transcript_issues SET data=? WHERE id=?",
                params![serde_json::to_string(&issue)?, issue.id],
            )?;
            changed = true;
        }
    }
    Ok(changed)
}

fn record_changes(session: &mut PublicationSession, current: &[SubtitleSegment]) -> Result<()> {
    let expected = session
        .expected
        .iter()
        .map(|row| (row.id.as_str(), row))
        .collect::<BTreeMap<_, _>>();
    let actual = current
        .iter()
        .map(|row| (row.id.as_str(), row))
        .collect::<BTreeMap<_, _>>();
    for (&id, old) in &expected {
        match actual.get(id) {
            Some(new) if hash(old)? == hash(new)? => {}
            Some(new) => {
                session.protected_ranges.push(range(old));
                session.protected_ranges.push(range(new));
            }
            None => session.protected_ranges.push(range(old)),
        }
    }
    for (&id, added) in &actual {
        if !expected.contains_key(id) {
            session.protected_ranges.push(range(added));
        }
    }
    session.protected_ranges = normalize(std::mem::take(&mut session.protected_ranges));
    Ok(())
}

/// Persist explicit edits immediately, including both sides of a moved cue.
pub(super) fn protect_changes_on(
    connection: &Connection,
    media_id: &str,
    changed: &[&SubtitleSegment],
) -> Result<()> {
    protect_ranges_on(
        connection,
        media_id,
        &changed.iter().map(|row| range(row)).collect::<Vec<_>>(),
    )
}

pub(super) fn protect_ranges_on(
    connection: &Connection,
    media_id: &str,
    changed: &[TranscriptPublicationRange],
) -> Result<()> {
    let rows = {
        let mut statement = connection.prepare("SELECT job_id,data FROM transcript_publications WHERE media_id=? AND detached=0 AND finished=0")?;
        statement
            .query_map([media_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    for (job_id, json) in rows {
        let mut session: PublicationSession = serde_json::from_str(&json)?;
        session.protected_ranges.extend_from_slice(changed);
        session.protected_ranges = normalize(session.protected_ranges);
        connection.execute(
            "UPDATE transcript_publications SET data=? WHERE job_id=?",
            params![serde_json::to_string(&session)?, job_id],
        )?;
    }
    Ok(())
}

pub(super) fn detach_on(connection: &Connection, media_id: &str) -> Result<()> {
    connection.execute(
        "UPDATE transcript_publications SET detached=1 WHERE media_id=?",
        [media_id],
    )?;
    Ok(())
}

impl Store {
    #[allow(clippy::too_many_arguments)]
    pub fn begin_transcript_publication(
        &mut self,
        job_id: &str,
        job_digest: &str,
        media_id: &str,
        expected_revision: &str,
        start_ms: u64,
        end_ms: u64,
    ) -> Result<bool> {
        ensure!(
            !job_id.is_empty()
                && job_id.len() <= 128
                && job_digest.len() == 64
                && job_digest.bytes().all(|b| b.is_ascii_hexdigit()),
            "invalid transcript publication binding"
        );
        ensure!(start_ms < end_ms, "invalid transcript publication range");
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing: Option<(String, String, String)> = tx
            .query_row(
                "SELECT job_digest,media_id,data FROM transcript_publications WHERE job_id=?",
                [job_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        if let Some((digest, media, json)) = existing {
            let session: PublicationSession = serde_json::from_str(&json)?;
            ensure!(
                digest == job_digest
                    && media == media_id
                    && session.start_ms == start_ms
                    && session.end_ms == end_ms,
                "transcript publication binding changed"
            );
            return Ok(false);
        }
        let media: Media = serde_json::from_str(&tx.query_row(
            "SELECT data FROM media WHERE id=?",
            [media_id],
            |row| row.get::<_, String>(0),
        )?)?;
        ensure!(
            end_ms <= media.duration_ms,
            "publication exceeds media duration"
        );
        let baseline = read_segments(&tx, media_id)?;
        ensure!(
            subtitle_revision(&baseline)? == expected_revision,
            "source subtitles changed before publication began"
        );
        // A newer request owns its requested interval over any older pending job.
        let session = PublicationSession {
            start_ms,
            end_ms,
            expected: baseline.clone(),
            baseline,
            owned: vec![],
            protected_ranges: vec![],
            received_ranges: vec![],
            latest_projection: vec![],
            deferred_segment_ids: vec![],
            projection_sha256: String::new(),
            version_saved: false,
        };
        tx.execute(
            "INSERT INTO transcript_publications(job_id,job_digest,media_id,data) VALUES(?,?,?,?)",
            params![
                job_id,
                job_digest,
                media_id,
                serde_json::to_string(&session)?
            ],
        )?;
        tx.commit()?;
        Ok(true)
    }

    /// Claim replacement ownership only after the user approves this request.
    pub fn activate_transcript_publication(
        &mut self,
        job_id: &str,
        job_digest: &str,
    ) -> Result<()> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (media_id, detached, finished, activated, json): (String,bool,bool,bool,String) = tx.query_row("SELECT media_id,detached,finished,activated,data FROM transcript_publications WHERE job_id=? AND job_digest=?", params![job_id,job_digest], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?))).optional()?.context("transcript publication is missing")?;
        ensure!(
            !detached && !finished,
            "transcript publication is detached or finished"
        );
        if activated {
            return Ok(());
        }
        let session: PublicationSession = serde_json::from_str(&json)?;
        let selection = TranscriptPublicationRange {
            start_ms: session.start_ms,
            end_ms: session.end_ms,
        };
        let prior = {
            let mut statement = tx.prepare("SELECT job_id,data FROM transcript_publications WHERE media_id=? AND job_id<>? AND detached=0 AND finished=0 AND activated=1")?;
            statement
                .query_map(params![media_id, job_id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?
        };
        for (prior_id, json) in prior {
            let mut prior: PublicationSession = serde_json::from_str(&json)?;
            if overlaps(
                selection,
                TranscriptPublicationRange {
                    start_ms: prior.start_ms,
                    end_ms: prior.end_ms,
                },
            ) {
                prior.protected_ranges.push(selection);
                prior.protected_ranges = normalize(prior.protected_ranges);
                tx.execute(
                    "UPDATE transcript_publications SET data=? WHERE job_id=?",
                    params![serde_json::to_string(&prior)?, prior_id],
                )?;
            }
        }
        tx.execute(
            "UPDATE transcript_publications SET activated=1 WHERE job_id=?",
            [job_id],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn transcript_publication_exists(&self, job_id: &str, job_digest: &str) -> Result<bool> {
        Ok(self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM transcript_publications WHERE job_id=? AND job_digest=?)",
            params![job_id, job_digest],
            |row| row.get(0),
        )?)
    }

    pub fn transcript_publication_active(&self, job_id: &str, job_digest: &str) -> Result<bool> {
        Ok(self.conn.query_row("SELECT EXISTS(SELECT 1 FROM transcript_publications WHERE job_id=? AND job_digest=? AND detached=0)", params![job_id,job_digest], |row| row.get(0))?)
    }

    pub fn finish_transcript_publication(&self, job_id: &str, job_digest: &str) -> Result<()> {
        ensure!(
            self.conn.execute(
                "UPDATE transcript_publications SET finished=1 WHERE job_id=? AND job_digest=?",
                params![job_id, job_digest]
            )? == 1,
            "transcript publication is missing"
        );
        Ok(())
    }

    /// Seal an explicitly adopted legacy result without reapplying canonical rows.
    pub fn record_published_transcript_adoption(
        &mut self,
        job_id: &str,
        job_digest: &str,
        draft_digest: &str,
    ) -> Result<()> {
        ensure!(
            draft_digest.len() == 64 && draft_digest.bytes().all(|b| b.is_ascii_hexdigit()),
            "invalid transcript adoption digest"
        );
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let saved: Option<(String, String)> = tx
            .query_row(
                "SELECT job_digest,draft_digest FROM transcript_adoptions WHERE job_id=?",
                [job_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if let Some((job, draft)) = saved {
            ensure!(
                job == job_digest && draft == draft_digest,
                "transcript was already adopted with another digest"
            );
            return Ok(());
        }
        let (activated, detached, json): (bool,bool,String) = tx.query_row("SELECT activated,detached,data FROM transcript_publications WHERE job_id=? AND job_digest=?", params![job_id,job_digest], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional()?.context("transcript publication is missing")?;
        ensure!(
            activated && !detached,
            "transcript publication has not been approved or is detached"
        );
        let session: PublicationSession = serde_json::from_str(&json)?;
        tx.execute("INSERT INTO transcript_adoptions(job_id,job_digest,draft_digest,previous_segments_json,adopted_at) VALUES(?,?,?,?,?)", params![job_id,job_digest,draft_digest,serde_json::to_string(&session.baseline)?,now()])?;
        tx.execute(
            "UPDATE transcript_publications SET finished=1 WHERE job_id=?",
            [job_id],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn detach_transcript_publications(&self, media_id: &str) -> Result<()> {
        detach_on(&self.conn, media_id)
    }

    pub fn transcript_publication_candidates(
        &self,
        job_id: &str,
        job_digest: &str,
    ) -> Result<Vec<SubtitleSegment>> {
        let json: String = self.conn.query_row(
            "SELECT data FROM transcript_publications WHERE job_id=? AND job_digest=?",
            params![job_id, job_digest],
            |row| row.get(0),
        )?;
        let session: PublicationSession = serde_json::from_str(&json)?;
        Ok(session
            .latest_projection
            .into_iter()
            .filter(|row| session.deferred_segment_ids.contains(&row.id))
            .collect())
    }

    pub fn publish_transcript_progress(
        &mut self,
        job_id: &str,
        job_digest: &str,
        received_ranges: &[TranscriptPublicationRange],
        projection: &[SubtitleSegment],
        issues: &[TranscriptIssueRecord],
    ) -> Result<TranscriptPublicationReport> {
        ensure!(
            received_ranges.len() <= 10_000 && projection.len() <= 100_000,
            "transcript publication exceeds limits"
        );
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (media_id, detached, finished, activated, json): (String, bool, bool, bool, String) = tx.query_row("SELECT media_id,detached,finished,activated,data FROM transcript_publications WHERE job_id=? AND job_digest=?", params![job_id,job_digest], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?))).optional()?.context("transcript publication is missing")?;
        let mut session: PublicationSession = serde_json::from_str(&json)?;
        if detached || finished {
            return Ok(TranscriptPublicationReport {
                changed: false,
                detached,
                protected_ranges: session.protected_ranges,
                deferred_segment_ids: session.deferred_segment_ids,
            });
        }
        ensure!(activated, "transcript publication has not been approved");
        let selection = TranscriptPublicationRange {
            start_ms: session.start_ms,
            end_ms: session.end_ms,
        };
        let media: Media = serde_json::from_str(&tx.query_row(
            "SELECT data FROM media WHERE id=?",
            [&media_id],
            |row| row.get::<_, String>(0),
        )?)?;
        ensure!(
            selection.end_ms <= media.duration_ms,
            "publication exceeds current media duration"
        );
        for range in received_ranges {
            ensure!(
                range.start_ms < range.end_ms
                    && range.start_ms >= selection.start_ms
                    && range.end_ms <= selection.end_ms,
                "received transcript range lies outside publication"
            );
        }
        session.received_ranges.extend_from_slice(received_ranges);
        session.received_ranges = normalize(session.received_ranges);
        let mut ids = HashSet::new();
        for cue in projection {
            validate_segment(cue)?;
            let block = cue.timing_precision == "source_block";
            ensure!(
                cue.media_id == media_id
                    && (block && overlaps(range(cue), selection)
                        || cue.start_ms >= selection.start_ms && cue.end_ms <= selection.end_ms)
                    && is_usable_subtitle_status(&cue.status)
                    && ids.insert(&cue.id),
                "invalid published transcript cue"
            );
            if block {
                ensure!(
                    cue.end_ms <= media.duration_ms,
                    "audio source block exceeds media duration"
                );
            }
        }
        ensure!(
            issues.iter().all(|issue| issue.media_id == media_id
                && issue.start_ms >= selection.start_ms
                && issue.end_ms <= selection.end_ms),
            "transcript issue lies outside publication"
        );
        let current = read_segments(&tx, &media_id)?;
        record_changes(&mut session, &current)?;
        let mut kept = Vec::new();
        let mut removed = Vec::new();
        for cue in &current {
            let cue_range = range(cue);
            let protected = session
                .protected_ranges
                .iter()
                .any(|protected| overlaps(cue_range, *protected));
            let owned_block = cue.timing_precision == "source_block"
                && session.owned.iter().any(|owned| owned.id == cue.id);
            if (owned_block
                || cue.start_ms >= selection.start_ms
                    && cue.end_ms <= selection.end_ms
                    && covered(cue_range, &session.received_ranges))
                && !protected
            {
                removed.push(cue);
            } else {
                kept.push(cue.clone());
            }
        }
        let mut deferred = Vec::new();
        let mut published = Vec::new();
        for cue in projection {
            let cue_range = range(cue);
            let block = cue.timing_precision == "source_block";
            let owned_range = if block {
                TranscriptPublicationRange {
                    start_ms: cue.start_ms.max(selection.start_ms),
                    end_ms: cue.end_ms.min(selection.end_ms),
                }
            } else {
                cue_range
            };
            let received = if block {
                session
                    .received_ranges
                    .iter()
                    .any(|received| overlaps(*received, owned_range))
            } else {
                covered(owned_range, &session.received_ranges)
            };
            if !received
                || session
                    .protected_ranges
                    .iter()
                    .any(|protected| overlaps(owned_range, *protected))
                || kept.iter().any(|old| {
                    old.id == cue.id
                        || !block
                            && old.timing_precision == "cue"
                            && overlaps(range(old), cue_range)
                })
            {
                deferred.push(cue.id.clone());
            } else {
                published.push(cue.clone());
            }
        }
        let retained_pending = kept
            .iter()
            .map(range)
            .filter(|range| !covered(*range, &session.received_ranges))
            .collect::<Vec<_>>();
        let mut next = kept;
        next.extend(published.iter().cloned());
        next.sort_by(|a, b| (a.start_ms, &a.id).cmp(&(b.start_ms, &b.id)));
        let changed = serde_json::to_vec(&current)? != serde_json::to_vec(&next)?;
        if changed {
            if !session.version_saved {
                if !session.baseline.is_empty() {
                    let media: Media = serde_json::from_str(&tx.query_row(
                        "SELECT data FROM media WHERE id=?",
                        [&media_id],
                        |row| row.get::<_, String>(0),
                    )?)?;
                    let version = SubtitleVersion {
                        id: id(),
                        media_id: media_id.clone(),
                        created_at: now(),
                        label: "Before applying generated subtitles".into(),
                        stream_index: media.subtitle_stream_index,
                        segments: session.baseline.clone(),
                    };
                    tx.execute(
                        "INSERT INTO subtitle_versions(id,media_id,data) VALUES(?,?,?)",
                        params![version.id, media_id, serde_json::to_string(&version)?],
                    )?;
                }
                session.version_saved = true;
            }
            for old in removed {
                tx.execute("DELETE FROM segments WHERE id=?", [&old.id])?;
            }
            for cue in &published {
                tx.execute(
                    "INSERT INTO segments(id,media_id,start_ms,data) VALUES(?,?,?,?)",
                    params![
                        cue.id,
                        media_id,
                        cue.start_ms as i64,
                        serde_json::to_string(cue)?
                    ],
                )?;
            }
        }
        let active_issues = issues
            .iter()
            .filter(|issue| {
                !session.protected_ranges.iter().any(|protected| {
                    overlaps(
                        TranscriptPublicationRange {
                            start_ms: issue.start_ms,
                            end_ms: issue.end_ms,
                        },
                        *protected,
                    )
                })
            })
            .cloned()
            .collect::<Vec<_>>();
        let issues_changed = deactivate_replaced_issues(
            &tx,
            &media_id,
            &session.received_ranges,
            &session.protected_ranges,
            &retained_pending,
            &active_issues,
        )?;
        super::transcript_issues::upsert_transcript_issues_on(&tx, &active_issues)?;
        session.expected = next;
        session.owned = published;
        session.latest_projection = projection.to_vec();
        session.deferred_segment_ids = deferred;
        session.projection_sha256 =
            format!("{:x}", Sha256::digest(serde_json::to_vec(projection)?));
        if changed {
            // Automatic writes are not manual edits in other pending sessions.
            // Record their pre-existing local changes before rebasing expected rows.
            let others = {
                let mut statement = tx.prepare("SELECT job_id,data FROM transcript_publications WHERE media_id=? AND job_id<>? AND detached=0 AND finished=0")?;
                statement
                    .query_map(params![media_id, job_id], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?
            };
            for (other_id, json) in others {
                let mut other: PublicationSession = serde_json::from_str(&json)?;
                record_changes(&mut other, &current)?;
                other.expected = session.expected.clone();
                tx.execute(
                    "UPDATE transcript_publications SET data=? WHERE job_id=?",
                    params![serde_json::to_string(&other)?, other_id],
                )?;
            }
        }
        tx.execute(
            "UPDATE transcript_publications SET data=? WHERE job_id=?",
            params![serde_json::to_string(&session)?, job_id],
        )?;
        tx.commit()?;
        Ok(TranscriptPublicationReport {
            changed: changed || issues_changed,
            detached: false,
            protected_ranges: session.protected_ranges,
            deferred_segment_ids: session.deferred_segment_ids,
        })
    }
}

#[cfg(test)]
#[path = "transcript_publication_tests.rs"]
mod tests;
