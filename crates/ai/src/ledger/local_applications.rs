//! Operational completion receipts survive a learning-data restore. A restore
//! must never make a previously applied automatic job pending again.
use super::*;
use rusqlite::OptionalExtension;

impl AiStore {
    pub fn recoverable_transcript_applications(&self) -> Result<Vec<String>> {
        let conn = self.connect()?;
        let mut query = conn.prepare(
            "SELECT j.id FROM ai_jobs j
            WHERE json_extract(j.plan_json,'$.apply_policy')='auto'
            AND j.state IN ('completed','needs_review','paused')
            AND NOT EXISTS(SELECT 1 FROM ai_requests r WHERE r.job_id=j.id AND r.state!='completed')
            AND (NOT EXISTS(SELECT 1 FROM ai_local_applications a WHERE a.job_id=j.id)
                OR EXISTS(SELECT 1 FROM ai_job_issues i WHERE i.job_id=j.id AND i.active=1))",
        )?;
        let ids = query
            .query_map([], |row| row.get(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(ids)
    }

    pub fn transcript_application_recorded(&self, job_id: &str, digest: &str) -> Result<bool> {
        let saved: Option<String> = self
            .connect()?
            .query_row(
                "SELECT job_digest FROM ai_local_applications WHERE job_id=?",
                [job_id],
                |row| row.get(0),
            )
            .optional()?;
        if saved.as_ref().is_some_and(|saved| saved != digest) {
            return Err(AiError::PreparationChanged);
        }
        Ok(saved.is_some())
    }

    /// Called only after the canonical adoption transaction has committed. If a
    /// crash interrupts these two commits, the canonical adoption marker repairs it.
    pub fn record_transcript_application(&self, job_id: &str, digest: &str) -> Result<()> {
        if self.prepared_job(job_id)?.digest()? != digest {
            return Err(AiError::PreparationChanged);
        }
        self.connect()?.execute(
            "INSERT OR IGNORE INTO ai_local_applications(job_id,job_digest,applied_at_ms) VALUES(?,?,?)",
            params![job_id, digest, self.now_ms()],
        )?;
        self.transcript_application_recorded(job_id, digest)?;
        Ok(())
    }
}
