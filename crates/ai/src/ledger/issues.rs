//! Bounded local diagnostics. Provider text and credentials never enter this table.
use super::*;
use rusqlite::OptionalExtension;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobIssue {
    pub code: String,
    pub phase: String,
    pub occurred_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ordinal: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http_status: Option<u16>,
    pub next_action: String,
}

impl AiStore {
    pub fn record_job_issue(
        &self,
        job_id: &str,
        code: &str,
        phase: &str,
        http_status: Option<u16>,
        next_action: &str,
    ) -> Result<()> {
        self.record_job_issue_inner(job_id, None, code, phase, http_status, next_action)
            .map(|_| ())
    }

    pub fn record_job_issue_scoped(
        &self,
        job_id: &str,
        approval_id: &str,
        code: &str,
        phase: &str,
        http_status: Option<u16>,
        next_action: &str,
    ) -> Result<bool> {
        self.record_job_issue_inner(
            job_id,
            Some(approval_id),
            code,
            phase,
            http_status,
            next_action,
        )
    }

    fn record_job_issue_inner(
        &self,
        job_id: &str,
        approval_id: Option<&str>,
        code: &str,
        phase: &str,
        http_status: Option<u16>,
        next_action: &str,
    ) -> Result<bool> {
        if ![
            "credentials",
            "budget",
            "provider",
            "unknown_outcome",
            "source_changed",
            "invalid_output",
            "local_apply",
            "local_io",
            "interrupted",
            "execution",
            "rate_limited",
        ]
        .contains(&code)
            || !["prepare", "source", "execute", "apply", "recovery"].contains(&phase)
            || ![
                "settings",
                "review_unknown",
                "prepare_again",
                "review_result",
                "retry_local",
                "resume",
            ]
            .contains(&next_action)
            || http_status.is_some_and(|status| !(100..=599).contains(&status))
        {
            return Err(AiError::Invalid("Invalid job diagnostic".into()));
        }
        let mut conn = self.connect()?;
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        if let Some(expected) = approval_id {
            if super::retries::current_approval(&tx, job_id)?.as_deref() != Some(expected) {
                return Ok(false);
            }
        }
        // Only a matching durable request/attempt state identifies the stopped
        // request. Pending order is not evidence: failure can precede dispatch
        // or occur after a response was already marked complete.
        let ordinal = if phase == "execute" {
            let mut query = tx.prepare(
                "SELECT DISTINCT r.ordinal FROM ai_requests r JOIN ai_attempts a
                 ON a.job_id=r.job_id AND a.ordinal=r.ordinal
                 WHERE r.job_id=? AND (
                   (r.state='unknown' AND a.state='unknown') OR
                   (r.state='reserved' AND a.state='reserved' AND ?='unknown_outcome') OR
                   (r.state='failed' AND a.state IN ('released','settled','rejected_429')))
                 ORDER BY r.ordinal LIMIT 2",
            )?;
            let candidates = query
                .query_map(params![job_id, code], |row| row.get::<_, u32>(0))?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            match candidates.as_slice() {
                [only] => Some(*only),
                _ => None,
            }
        } else {
            None
        };
        let issue = JobIssue {
            code: code.into(),
            phase: phase.into(),
            occurred_at: chrono::DateTime::from_timestamp_millis(self.now_ms())
                .unwrap_or_default()
                .to_rfc3339(),
            ordinal,
            http_status,
            next_action: next_action.into(),
        };
        tx.execute("UPDATE ai_job_issues SET active=0 WHERE job_id=?", [job_id])?;
        tx.execute(
            "INSERT INTO ai_job_issues(job_id,data,active) VALUES(?,?,1)",
            params![job_id, serde_json::to_string(&issue)?],
        )?;
        tx.commit()?;
        Ok(true)
    }
    pub fn job_issue(&self, job_id: &str) -> Result<Option<JobIssue>> {
        let conn = self.connect()?;
        let value: Option<String> = conn.query_row("SELECT data FROM ai_job_issues WHERE job_id=? AND active=1 ORDER BY id DESC LIMIT 1",
            [job_id], |row| row.get(0)).optional()?;
        value
            .map(|value| serde_json::from_str(&value).map_err(Into::into))
            .transpose()
    }
    pub fn clear_job_issue(&self, job_id: &str) -> Result<()> {
        self.connect()?
            .execute("UPDATE ai_job_issues SET active=0 WHERE job_id=?", [job_id])?;
        Ok(())
    }

    pub fn clear_job_issue_scoped(&self, job_id: &str, approval_id: &str) -> Result<bool> {
        let mut conn = self.connect()?;
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        if super::retries::current_approval(&tx, job_id)?.as_deref() != Some(approval_id) {
            return Ok(false);
        }
        tx.execute("UPDATE ai_job_issues SET active=0 WHERE job_id=?", [job_id])?;
        tx.commit()?;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn two_request_plan() -> PreparedJob {
        let plan = super::super::tests::plan();
        PreparedJob::fixture(
            plan.title,
            plan.project_id,
            plan.credential_id,
            plan.binding,
            vec![plan.requests[0].clone(), plan.requests[0].clone()],
        )
    }
    #[test]
    fn classified_diagnostics_survive_restart_and_reject_free_form_content() {
        let (directory, store) = super::super::tests::store();
        let quote = store.prepare(super::super::tests::plan()).unwrap();
        store
            .record_job_issue(&quote.id, "provider", "execute", Some(403), "settings")
            .unwrap();
        assert!(store
            .record_job_issue(
                &quote.id,
                "secret provider response",
                "execute",
                None,
                "settings"
            )
            .is_err());
        drop(store);
        let store = AiStore::open(directory.path().join("ai.db")).unwrap();
        let issue = store.job_issue(&quote.id).unwrap().unwrap();
        assert_eq!(issue.code, "provider");
        assert_eq!(issue.http_status, Some(403));
        assert_eq!(issue.ordinal, None); // A prepared request has not failed merely because it is first.
        store.clear_job_issue(&quote.id).unwrap();
        assert!(store.job_issue(&quote.id).unwrap().is_none());
        let count: i64 = store
            .connect()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM ai_job_issues WHERE job_id=?",
                [&quote.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn diagnostics_record_the_unique_failed_attempt_after_completed_requests_and_survive_restart() {
        let (directory, store) = super::super::tests::store();
        let quote = store.prepare(two_request_plan()).unwrap();
        store.approve(&quote.id, &quote.digest).unwrap();
        let first = store.reserve_next(&quote.id).unwrap().unwrap();
        store
            .settle(
                &first.attempt_id,
                0,
                &serde_json::json!({}),
                Some(&ParsedOutput::Vocabulary { items: vec![] }),
                None,
            )
            .unwrap();
        // A later execute-phase failure can happen before request 1 dispatch;
        // neither a completed attempt nor the next pending ordinal is its proof.
        store
            .record_job_issue(&quote.id, "execution", "execute", None, "resume")
            .unwrap();
        assert_eq!(store.job_issue(&quote.id).unwrap().unwrap().ordinal, None);
        let failed = store.reserve_next(&quote.id).unwrap().unwrap();
        assert_eq!(failed.ordinal, 1);
        store.mark_unknown(&failed.attempt_id).unwrap();
        store
            .record_job_issue(&quote.id, "provider", "execute", Some(503), "settings")
            .unwrap();
        drop(store);
        let store = AiStore::open(directory.path().join("ai.db")).unwrap();
        let issue = store.job_issue(&quote.id).unwrap().unwrap();
        assert_eq!(issue.ordinal, Some(1));
        assert_eq!(issue.http_status, Some(503));
        store.acknowledge_unknown(&failed.attempt_id).unwrap();
        store.reapprove(&quote.id, &quote.digest).unwrap();
        store
            .record_job_issue(&quote.id, "credentials", "execute", None, "settings")
            .unwrap();
        assert_eq!(store.job_issue(&quote.id).unwrap().unwrap().ordinal, None);
    }

    #[test]
    fn diagnostic_ordinals_require_unambiguous_attempts_and_do_not_leak_into_local_phases() {
        let (_directory, store) = super::super::tests::store();
        let quote = store.prepare(two_request_plan()).unwrap();
        store.approve(&quote.id, &quote.digest).unwrap();
        let attempt = store.reserve_next(&quote.id).unwrap().unwrap();
        store
            .record_job_issue(&quote.id, "execution", "execute", None, "resume")
            .unwrap();
        assert_eq!(store.job_issue(&quote.id).unwrap().unwrap().ordinal, None);
        store
            .record_job_issue(
                &quote.id,
                "unknown_outcome",
                "execute",
                None,
                "review_unknown",
            )
            .unwrap();
        assert_eq!(
            store.job_issue(&quote.id).unwrap().unwrap().ordinal,
            Some(0)
        );
        store
            .release_unsent(&attempt.attempt_id, "preflight_failed")
            .unwrap();
        store
            .record_job_issue(&quote.id, "credentials", "execute", None, "settings")
            .unwrap();
        assert_eq!(
            store.job_issue(&quote.id).unwrap().unwrap().ordinal,
            Some(0)
        );
        for phase in ["source", "apply", "prepare"] {
            store
                .record_job_issue(&quote.id, "source_changed", phase, None, "prepare_again")
                .unwrap();
            let issue = store.job_issue(&quote.id).unwrap().unwrap();
            assert_eq!(issue.ordinal, None);
            assert_eq!(issue.code, "source_changed");
        }
        let connection = store.connect().unwrap();
        connection
            .execute(
                "UPDATE ai_requests SET state='failed' WHERE job_id=? AND ordinal=1",
                [&quote.id],
            )
            .unwrap();
        connection.execute("INSERT INTO ai_attempts(id,job_id,ordinal,state,created_at_ms) VALUES('second-failed',?,1,'released',0)", [&quote.id]).unwrap();
        store
            .record_job_issue(&quote.id, "execution", "execute", None, "resume")
            .unwrap();
        assert_eq!(store.job_issue(&quote.id).unwrap().unwrap().ordinal, None);
    }
}
