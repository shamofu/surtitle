//! Additional evaluation scope is append-only and never renews the legacy pool.
use super::*;

fn unsigned(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<u64> {
    let value: i64 = row.get(index)?;
    u64::try_from(value).map_err(|_| rusqlite::Error::IntegralValueOutOfRange(index, value))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ValidationCampaignJob {
    pub job_id: String,
    pub plan_digest: String,
    pub request_body_sha256: String,
    pub execution: crate::ExecutionConfig,
    pub audio_duration_ms: u64,
    pub reservation_microusd: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ValidationCampaignQuote {
    pub id: String,
    pub digest: String,
    pub label: String,
    pub jobs: Vec<ValidationCampaignJob>,
    pub max_requests: u64,
    pub max_audio_duration_ms: u64,
    pub max_reservation_microusd: u64,
    pub total_limit_microusd: u64,
    pub created_at_ms: i64,
    pub expires_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ValidationCampaignApproval {
    pub digest: String,
    pub max_requests: u64,
    pub max_audio_duration_ms: u64,
    pub max_reservation_microusd: u64,
    pub total_limit_microusd: u64,
    pub expires_at_ms: i64,
}

impl ValidationCampaignQuote {
    fn computed_digest(&self) -> Result<String> {
        let mut value = self.clone();
        value.digest.clear();
        Ok(crate::sha256_bytes(&serde_json::to_vec(&value)?))
    }
    fn approval(&self) -> ValidationCampaignApproval {
        ValidationCampaignApproval {
            digest: self.digest.clone(),
            max_requests: self.max_requests,
            max_audio_duration_ms: self.max_audio_duration_ms,
            max_reservation_microusd: self.max_reservation_microusd,
            total_limit_microusd: self.total_limit_microusd,
            expires_at_ms: self.expires_at_ms,
        }
    }
}

fn exists(connection: &Connection) -> Result<bool> {
    Ok(connection.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='ai_validation_campaigns')", [], |row| row.get(0))?)
}
fn initialize(connection: &Connection) -> Result<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS ai_validation_campaigns (
        id TEXT PRIMARY KEY, digest TEXT NOT NULL UNIQUE, quote_json TEXT NOT NULL,
        approval_json TEXT, approved_at_ms INTEGER
    ); CREATE TABLE IF NOT EXISTS ai_validation_campaign_jobs (
        job_id TEXT PRIMARY KEY REFERENCES ai_jobs(id),
        campaign_id TEXT NOT NULL REFERENCES ai_validation_campaigns(id)
    );",
    )?;
    Ok(())
}
pub(super) fn job_campaign(connection: &Connection, job: &str) -> Result<Option<String>> {
    if !exists(connection)? {
        return Ok(None);
    }
    Ok(connection
        .query_row(
            "SELECT campaign_id FROM ai_validation_campaign_jobs WHERE job_id=?",
            [job],
            |row| row.get(0),
        )
        .optional()?)
}

fn job_binding(connection: &Connection, id: &str) -> Result<ValidationCampaignJob> {
    let (plan, digest, _, _) = read_job(connection, id)?;
    plan.validate()?;
    if plan.requests.len() != 1 || plan.digest()? != digest {
        return Err(AiError::PreparationChanged);
    }
    let estimate = &plan.estimates()?[0];
    if estimate.audio_duration_ms > 240_000 {
        return Err(AiError::ApprovalRequired);
    }
    Ok(ValidationCampaignJob {
        job_id: id.into(),
        plan_digest: digest,
        request_body_sha256: crate::sha256_bytes(&serde_json::to_vec(
            plan.request_body_snapshot(0)?,
        )?),
        execution: plan.execution.clone(),
        audio_duration_ms: estimate.audio_duration_ms,
        reservation_microusd: estimate
            .estimated_max_microusd
            .ok_or(AiError::ApprovalRequired)?,
    })
}

fn load(
    connection: &Connection,
    id: &str,
) -> Result<(ValidationCampaignQuote, Option<ValidationCampaignApproval>)> {
    let (digest, json, approval): (String, String, Option<String>) = connection.query_row(
        "SELECT digest,quote_json,approval_json FROM ai_validation_campaigns WHERE id=?",
        [id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    let quote: ValidationCampaignQuote = serde_json::from_str(&json)?;
    if quote.id != id || quote.digest != digest || quote.computed_digest()? != digest {
        return Err(AiError::PreparationChanged);
    }
    let approval = approval
        .map(|json| serde_json::from_str::<ValidationCampaignApproval>(&json))
        .transpose()?;
    if approval
        .as_ref()
        .is_some_and(|value| value != &quote.approval())
    {
        return Err(AiError::ApprovalRequired);
    }
    let members: u64 = connection.query_row(
        "SELECT COUNT(*) FROM ai_validation_campaign_jobs WHERE campaign_id=?",
        [id],
        |row| unsigned(row, 0),
    )?;
    if members != quote.jobs.len() as u64 {
        return Err(AiError::PreparationChanged);
    }
    for expected in &quote.jobs {
        if job_campaign(connection, &expected.job_id)?.as_deref() != Some(id)
            || job_binding(connection, &expected.job_id)? != *expected
        {
            return Err(AiError::PreparationChanged);
        }
    }
    Ok((quote, approval))
}

impl AiStore {
    /// Create a reviewable quote, without authorizing any request. Existing jobs
    /// and approvals are never moved between campaigns or returned to legacy scope.
    pub fn quote_validation_campaign(
        &self,
        label: &str,
        jobs: &[String],
        expires_at_ms: i64,
    ) -> Result<ValidationCampaignQuote> {
        let at = self.now_ms();
        if label.trim().is_empty()
            || label.len() > 200
            || jobs.is_empty()
            || jobs.len() > 1000
            || expires_at_ms <= at
            || expires_at_ms > at.saturating_add(24 * 60 * 60 * 1000)
        {
            return Err(AiError::Invalid(
                "A campaign needs 1–1000 jobs, a label and an expiry within 24 hours".into(),
            ));
        }
        let mut connection = self.connect()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        initialize(&tx)?;
        let total = validation_totals(&tx)?;
        if !total.monetary_totals_complete {
            return Err(AiError::ApprovalRequired);
        }
        let mut quote = ValidationCampaignQuote {
            id: uuid::Uuid::new_v4().to_string(),
            digest: String::new(),
            label: label.into(),
            jobs: vec![],
            max_requests: jobs.len() as u64,
            max_audio_duration_ms: 0,
            max_reservation_microusd: 0,
            total_limit_microusd: total.total_limit_microusd,
            created_at_ms: at,
            expires_at_ms,
        };
        let mut unique = std::collections::BTreeSet::new();
        for id in jobs {
            let attempted: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM ai_attempts WHERE job_id=?)",
                [id],
                |row| row.get(0),
            )?;
            if !unique.insert(id) || attempted || job_campaign(&tx, id)?.is_some() {
                return Err(AiError::ApprovalRequired);
            }
            let job = job_binding(&tx, id)?;
            quote.max_audio_duration_ms = quote
                .max_audio_duration_ms
                .checked_add(job.audio_duration_ms)
                .ok_or(AiError::PreparationChanged)?;
            quote.max_reservation_microusd = quote
                .max_reservation_microusd
                .checked_add(job.reservation_microusd)
                .ok_or(AiError::PreparationChanged)?;
            quote.jobs.push(job);
        }
        if total
            .charged_or_held_microusd
            .checked_add(quote.max_reservation_microusd)
            .is_none_or(|n| n > total.total_limit_microusd)
        {
            return Err(AiError::BudgetExceeded("validation lifetime"));
        }
        quote.digest = quote.computed_digest()?;
        tx.execute(
            "INSERT INTO ai_validation_campaigns(id,digest,quote_json) VALUES (?,?,?)",
            params![quote.id, quote.digest, serde_json::to_string(&quote)?],
        )?;
        for job in &quote.jobs {
            tx.execute(
                "INSERT INTO ai_validation_campaign_jobs VALUES (?,?)",
                params![job.job_id, quote.id],
            )?;
        }
        audit(&tx, at, "validation_campaign_quoted", None, &quote.digest)?;
        tx.commit()?;
        Ok(quote)
    }

    pub fn validation_campaign(&self, id: &str) -> Result<ValidationCampaignQuote> {
        Ok(load(&self.connect()?, id)?.0)
    }

    /// Audit every append-only scope, including unapproved or expired quotes.
    pub fn validation_campaigns(&self) -> Result<Vec<serde_json::Value>> {
        let connection = self.connect()?;
        if !exists(&connection)? {
            return Ok(vec![]);
        }
        let mut statement =
            connection.prepare("SELECT id FROM ai_validation_campaigns ORDER BY rowid")?;
        let ids = statement.query_map([], |row| row.get::<_, String>(0))?;
        let mut reports = vec![];
        for id in ids {
            let (quote, approval) = load(&connection, &id?)?;
            reports.push(serde_json::json!({"campaign":quote,"approved":approval.is_some(),"expired":self.now_ms() >= quote.expires_at_ms}));
        }
        Ok(reports)
    }

    /// This explicit operation records only the exact reviewed campaign. It does
    /// not replace the fresh per-request digest and price approval at execution.
    pub fn approve_validation_campaign(
        &self,
        id: &str,
        approval: ValidationCampaignApproval,
    ) -> Result<()> {
        let mut connection = self.connect()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (quote, previous) = load(&tx, id)?;
        let totals = validation_totals(&tx)?;
        if previous.is_some()
            || approval != quote.approval()
            || self.now_ms() >= quote.expires_at_ms
            || totals.total_limit_microusd != quote.total_limit_microusd
            || !totals.monetary_totals_complete
        {
            return Err(AiError::ApprovalRequired);
        }
        if totals
            .charged_or_held_microusd
            .checked_add(quote.max_reservation_microusd)
            .is_none_or(|n| n > totals.total_limit_microusd)
        {
            return Err(AiError::BudgetExceeded("validation lifetime"));
        }
        tx.execute("UPDATE ai_validation_campaigns SET approval_json=?,approved_at_ms=? WHERE id=? AND approval_json IS NULL", params![serde_json::to_string(&approval)?, self.now_ms(), id])?;
        audit(
            &tx,
            self.now_ms(),
            "validation_campaign_approved",
            None,
            &serde_json::to_string(&approval)?,
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn with_development_campaign(
        &self,
        job_id: &str,
        campaign_id: &str,
        campaign_digest: &str,
        approval: ValidationApproval,
    ) -> Result<Self> {
        let connection = self.connect()?;
        let (quote, accepted) = load(&connection, campaign_id)?;
        let attempts: u64 = connection.query_row(
            "SELECT COUNT(*) FROM ai_attempts WHERE job_id=?",
            [job_id],
            |row| unsigned(row, 0),
        )?;
        if accepted.is_none()
            || quote.digest != campaign_digest
            || attempts != 0
            || approval.expires_at_ms <= self.now_ms()
            || approval.expires_at_ms > self.now_ms().saturating_add(30 * 60 * 1000)
            || approval.max_reservation_microusd.is_none()
        {
            return Err(AiError::ApprovalRequired);
        }
        let prepared = self.prepared_job(job_id)?;
        let scope = DevelopmentScope {
            job_id: job_id.into(),
            approval,
            previous_attempts: 0,
            audio_duration_ms: prepared.estimates()?[0].audio_duration_ms,
            campaign: Some((campaign_id.into(), campaign_digest.into())),
        };
        scope.verify(&prepared, job_id, self.now_ms())?;
        check_campaign(
            &connection,
            &scope,
            campaign_id,
            campaign_digest,
            self.now_ms(),
            true,
        )?;
        let mut scoped = self.clone();
        scoped.development = Some(std::sync::Arc::new(scope));
        Ok(scoped)
    }
}

pub(super) fn check_campaign(
    connection: &Connection,
    scope: &DevelopmentScope,
    id: &str,
    digest: &str,
    at: i64,
    reserving: bool,
) -> Result<()> {
    let (quote, approval) = load(connection, id)?;
    if approval.is_none()
        || quote.digest != digest
        || at >= quote.expires_at_ms
        || quote.total_limit_microusd != scope.approval.total_limit_microusd
        || job_campaign(connection, &scope.job_id)?.as_deref() != Some(id)
    {
        return Err(AiError::ApprovalRequired);
    }
    let (mut count, mut audio, mut reserved) = (0u64, 0u64, 0u64);
    for job in &quote.jobs {
        let (attempts, amount): (u64, u64) = connection.query_row(
            "SELECT COUNT(*),COALESCE(SUM(reserve_microusd),0) FROM ai_attempts WHERE job_id=?",
            [&job.job_id],
            |row| Ok((unsigned(row, 0)?, unsigned(row, 1)?)),
        )?;
        if attempts > 1 {
            return Err(AiError::ApprovalRequired);
        }
        count = count.saturating_add(attempts);
        audio = audio.saturating_add(job.audio_duration_ms.saturating_mul(attempts));
        reserved = reserved.saturating_add(amount);
    }
    let extra = u64::from(reserving);
    if count + extra > quote.max_requests
        || audio.saturating_add(if reserving {
            scope.audio_duration_ms
        } else {
            0
        }) > quote.max_audio_duration_ms
        || reserved.saturating_add(if reserving {
            scope.approval.max_reservation_microusd.unwrap_or(u64::MAX)
        } else {
            0
        }) > quote.max_reservation_microusd
    {
        return Err(AiError::BudgetExceeded("validation campaign"));
    }
    Ok(())
}

pub(super) fn attempt_totals(connection: &Connection) -> Result<(u64, u64)> {
    if !exists(connection)? {
        return Ok((0, 0));
    }
    let mut statement = connection.prepare("SELECT a.job_id,COUNT(*) FROM ai_attempts a JOIN ai_validation_campaign_jobs c ON c.job_id=a.job_id GROUP BY a.job_id")?;
    let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, unsigned(row, 1)?)))?;
    let (mut count, mut audio) = (0u64, 0u64);
    for row in rows {
        let (id, attempts) = row?;
        count = count.saturating_add(attempts);
        audio = audio.saturating_add(
            job_binding(connection, &id)?
                .audio_duration_ms
                .saturating_mul(attempts),
        );
    }
    Ok((count, audio))
}

#[cfg(test)]
mod tests;
