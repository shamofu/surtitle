//! Device-local review history. Learning exports and restores never carry this state.
use super::*;
use rusqlite::TransactionBehavior;
use serde::Deserialize;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptRangeEdit<T> {
    pub ordinal: u32,
    pub version: u64,
    pub binding_sha256: String,
    pub selected_revision_id: Option<String>,
    pub latest_revision: Option<T>,
    pub selected_revision: Option<T>,
}

pub(super) fn initialize(conn: &Connection) -> Result<()> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS transcript_range_revisions (
        id TEXT PRIMARY KEY, job_id TEXT NOT NULL, job_digest TEXT NOT NULL, ordinal INTEGER NOT NULL,
        binding_sha256 TEXT NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS transcript_range_selections (
        job_id TEXT NOT NULL, job_digest TEXT NOT NULL, ordinal INTEGER NOT NULL,
        binding_sha256 TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>0),
        selected_revision_id TEXT REFERENCES transcript_range_revisions(id),
        latest_revision_id TEXT NOT NULL REFERENCES transcript_range_revisions(id),
        PRIMARY KEY(job_id,job_digest,ordinal));")?;
    Ok(())
}

impl Store {
    pub fn transcript_range_revision<T: DeserializeOwned>(
        &self,
        job_id: &str,
        job_digest: &str,
        ordinal: u32,
        binding_sha256: &str,
        revision_id: &str,
    ) -> Result<T> {
        let json: String = self.conn.query_row("SELECT data FROM transcript_range_revisions WHERE id=? AND job_id=? AND job_digest=? AND ordinal=? AND binding_sha256=?", params![revision_id,job_id,job_digest,ordinal,binding_sha256], |r| r.get(0)).optional()?.context("revision belongs to another prepared range")?;
        Ok(serde_json::from_str(&json)?)
    }
    pub fn transcript_range_edits<T: DeserializeOwned>(
        &self,
        job_id: &str,
        job_digest: &str,
    ) -> Result<Vec<TranscriptRangeEdit<T>>> {
        let mut statement = self.conn.prepare("SELECT s.ordinal,s.version,s.binding_sha256,s.selected_revision_id,r.data,m.data FROM transcript_range_selections s JOIN transcript_range_revisions r ON r.id=s.latest_revision_id LEFT JOIN transcript_range_revisions m ON m.id=s.selected_revision_id WHERE s.job_id=? AND s.job_digest=? ORDER BY s.ordinal")?;
        let rows = statement
            .query_map(params![job_id, job_digest], |r| {
                Ok((
                    r.get::<_, u32>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, Option<String>>(5)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter()
            .map(
                |(ordinal, version, binding_sha256, selected_revision_id, latest, selected)| {
                    Ok(TranscriptRangeEdit {
                        ordinal,
                        version: u64::try_from(version)?,
                        binding_sha256,
                        selected_revision_id,
                        latest_revision: Some(serde_json::from_str(&latest)?),
                        selected_revision: selected
                            .map(|s| serde_json::from_str(&s))
                            .transpose()?,
                    })
                },
            )
            .collect()
    }

    #[allow(clippy::too_many_arguments)]
    pub fn save_transcript_range_revision(
        &mut self,
        job_id: &str,
        job_digest: &str,
        ordinal: u32,
        binding_sha256: &str,
        expected_version: u64,
        revision_id: &str,
        revision: &impl Serialize,
    ) -> Result<()> {
        ensure!(
            uuid::Uuid::parse_str(revision_id).is_ok(),
            "invalid manual revision ID"
        );
        let json = serde_json::to_string(revision)?;
        ensure!(
            json.len() <= 2 * 1024 * 1024,
            "manual revision exceeds size limit"
        );
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        validate_change(
            &tx,
            job_id,
            job_digest,
            ordinal,
            binding_sha256,
            expected_version,
        )?;
        tx.execute("INSERT INTO transcript_range_revisions(id,job_id,job_digest,ordinal,binding_sha256,data) VALUES(?,?,?,?,?,?)", params![revision_id,job_id,job_digest,ordinal,binding_sha256,json])?;
        tx.execute("INSERT INTO transcript_range_selections(job_id,job_digest,ordinal,binding_sha256,version,selected_revision_id,latest_revision_id) VALUES(?,?,?,?,?,?,?) ON CONFLICT(job_id,job_digest,ordinal) DO UPDATE SET version=excluded.version,selected_revision_id=excluded.selected_revision_id,latest_revision_id=excluded.latest_revision_id", params![job_id,job_digest,ordinal,binding_sha256,(expected_version+1) as i64,revision_id,revision_id])?;
        tx.commit()?;
        Ok(())
    }

    pub fn select_transcript_range_revision(
        &mut self,
        job_id: &str,
        job_digest: &str,
        ordinal: u32,
        binding_sha256: &str,
        expected_version: u64,
        revision_id: Option<&str>,
    ) -> Result<()> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        validate_change(
            &tx,
            job_id,
            job_digest,
            ordinal,
            binding_sha256,
            expected_version,
        )?;
        ensure!(expected_version > 0, "range has no manual revision history");
        if let Some(id) = revision_id {
            ensure!(tx.query_row("SELECT EXISTS(SELECT 1 FROM transcript_range_revisions WHERE id=? AND job_id=? AND job_digest=? AND ordinal=? AND binding_sha256=?)", params![id,job_id,job_digest,ordinal,binding_sha256], |r| r.get::<_,bool>(0))?, "revision belongs to another prepared range");
        }
        ensure!(tx.execute("UPDATE transcript_range_selections SET version=version+1,selected_revision_id=? WHERE job_id=? AND job_digest=? AND ordinal=? AND version=?", params![revision_id,job_id,job_digest,ordinal,expected_version as i64])? == 1, "manual range version changed");
        tx.commit()?;
        Ok(())
    }
}

fn validate_change(
    tx: &rusqlite::Transaction<'_>,
    job_id: &str,
    job_digest: &str,
    ordinal: u32,
    binding_sha256: &str,
    expected_version: u64,
) -> Result<()> {
    ensure!(
        expected_version < i64::MAX as u64
            && ordinal < 5000
            && !job_id.is_empty()
            && [job_digest, binding_sha256]
                .iter()
                .all(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())),
        "invalid manual range binding"
    );
    ensure!(
        !tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM transcript_adoptions WHERE job_id=?)",
            [job_id],
            |r| r.get::<_, bool>(0)
        )?,
        "adopted transcript ranges cannot be changed"
    );
    let current: Option<(String,i64)> = tx.query_row("SELECT binding_sha256,version FROM transcript_range_selections WHERE job_id=? AND job_digest=? AND ordinal=?", params![job_id,job_digest,ordinal], |r| Ok((r.get(0)?,r.get(1)?))).optional()?;
    match current {
        Some((binding, version)) => ensure!(
            binding == binding_sha256 && version == expected_version as i64,
            "manual range version or binding changed"
        ),
        None => ensure!(expected_version == 0, "manual range version changed"),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn revisions_are_immutable_scoped_and_versioned_across_reopen() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("learning.sqlite");
        let mut db = Store::open(&path).unwrap();
        let digest = "a".repeat(64);
        let binding = "b".repeat(64);
        let id = uuid::Uuid::new_v4().to_string();
        db.save_transcript_range_revision("job", &digest, 1, &binding, 0, &id, &"first")
            .unwrap();
        assert!(
            db.save_transcript_range_revision(
                "job",
                &digest,
                1,
                &binding,
                0,
                &uuid::Uuid::new_v4().to_string(),
                &"stale"
            )
            .is_err()
        );
        assert!(
            db.save_transcript_range_revision("job", &digest, 1, &binding, 1, &id, &"overwrite")
                .is_err()
        );
        assert!(
            db.select_transcript_range_revision("job", &digest, 2, &binding, 0, Some(&id))
                .is_err()
        );
        assert!(
            db.select_transcript_range_revision("job", &digest, 1, &"c".repeat(64), 1, None)
                .is_err()
        );
        db.select_transcript_range_revision("job", &digest, 1, &binding, 1, None)
            .unwrap();
        drop(db);
        let mut db = Store::open(&path).unwrap();
        let edits: Vec<TranscriptRangeEdit<String>> =
            db.transcript_range_edits("job", &digest).unwrap();
        assert_eq!(edits[0].version, 2);
        assert_eq!(edits[0].latest_revision.as_deref(), Some("first"));
        assert!(edits[0].selected_revision.is_none());
        db.select_transcript_range_revision("job", &digest, 1, &binding, 2, Some(&id))
            .unwrap();
        assert_eq!(
            db.transcript_range_edits::<String>("job", &digest).unwrap()[0]
                .selected_revision
                .as_deref(),
            Some("first")
        );
        db.conn
            .execute(
                "INSERT INTO transcript_adoptions VALUES(?,?,?,?,?)",
                params!["job", digest, "draft", "[]", "now"],
            )
            .unwrap();
        assert!(
            db.select_transcript_range_revision("job", &digest, 1, &binding, 3, None)
                .is_err()
        );
    }
    #[test]
    fn portable_restore_excludes_operational_range_revisions_and_review_heads() {
        let root = tempfile::tempdir().unwrap();
        let mut db = Store::open(root.path().join("learning.sqlite")).unwrap();
        let digest = "a".repeat(64);
        db.save_transcript_range_revision(
            "job",
            &digest,
            0,
            &"b".repeat(64),
            0,
            &uuid::Uuid::new_v4().to_string(),
            &"local-only",
        )
        .unwrap();
        db.save_transcript_draft("job", &digest, "base", &"local-draft")
            .unwrap();
        let archive = db.archive().unwrap();
        assert!(
            !serde_json::to_string(&archive)
                .unwrap()
                .contains("local-only")
        );
        db.restore(&archive, &root.path().join("before.sqlite"))
            .unwrap();
        assert!(
            db.transcript_range_edits::<String>("job", &digest)
                .unwrap()
                .is_empty()
        );
        assert!(
            db.latest_transcript_draft::<String>("job", &digest)
                .unwrap()
                .is_none()
        );
        assert_eq!(
            db.conn
                .query_row("SELECT COUNT(*) FROM transcript_range_revisions", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    #[test]
    fn competing_connections_cannot_save_two_revisions_with_one_version() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("learning.sqlite");
        let stores = [Store::open(&path).unwrap(), Store::open(&path).unwrap()];
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let workers = stores
            .into_iter()
            .map(|mut db| {
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    db.save_transcript_range_revision(
                        "job",
                        &"a".repeat(64),
                        0,
                        &"b".repeat(64),
                        0,
                        &uuid::Uuid::new_v4().to_string(),
                        &"authored",
                    )
                    .is_ok()
                })
            })
            .collect::<Vec<_>>();
        assert_eq!(
            workers
                .into_iter()
                .map(|w| w.join().unwrap())
                .filter(|success| *success)
                .count(),
            1
        );
        let db = Store::open(&path).unwrap();
        assert_eq!(
            db.conn
                .query_row("SELECT COUNT(*) FROM transcript_range_revisions", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            db.transcript_range_edits::<String>("job", &"a".repeat(64))
                .unwrap()[0]
                .version,
            1
        );
    }
}
