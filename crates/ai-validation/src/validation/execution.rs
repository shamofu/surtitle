//! Explicit charge approval, paid dispatch, and manual recovery.
use super::arguments::{Arguments, usd};
use super::context::{Context, Manifest, manifest_path, read_manifest};
use super::{Result, ai_error, campaigns, ensure_windows};
use serde_json::{Value, json};
use std::path::Path;
use surtitle_ai::{AiError, ValidationApproval, VertexService};

pub(super) async fn execute(root: &Path, mut args: Arguments) -> Result<Value> {
    let id = args.string("--job-id")?;
    let digest = args.string("--digest")?;
    let approved = args
        .take("--approve-charge-usd")
        .map(|v| {
            v.into_string()
                .map_err(|_| "Invalid USD approval".to_owned())
                .and_then(|v| usd(&v))
        })
        .transpose()?;
    let unpriced = args.take("--approve-unpriced").is_some();
    let unqualified = args.take("--acknowledge-unqualified").is_some();
    if !unqualified || (approved.is_some() == unpriced) {
        return Err("Acknowledge the selected model trial and choose exactly one charge or unpriced-scope approval".into());
    }
    let retry = args.take("--retry").is_some();
    let campaign = campaigns::run_scope(&mut args, retry, unpriced)?;
    args.finish()?;
    ensure_windows()?;
    let context = Context::open(root)?;
    let manifest = context.manifest(&id)?;
    let quote = context.store.quote(&id).map_err(ai_error)?;
    validate_charge_approval(&manifest, &quote, &digest, approved, retry)?;
    let totals = context.store.validation_totals().map_err(ai_error)?;
    let approval = ValidationApproval {
        plan_digest: digest.clone(),
        model: manifest.prepared.execution.model_id.clone(),
        max_requests: 1,
        expires_at_ms: chrono::Utc::now().timestamp_millis() + 30 * 60 * 1000,
        max_reservation_microusd: approved,
        total_limit_microusd: totals.total_limit_microusd,
    };
    let scoped = if let Some((campaign_id, campaign_digest)) = campaign {
        context
            .store
            .with_development_campaign(&id, &campaign_id, &campaign_digest, approval)
    } else {
        context.store.with_development_validation(&id, approval)
    }
    .map_err(ai_error)?;
    if retry {
        scoped.reapprove_scope(&id, &digest, unpriced, unqualified)
    } else {
        scoped.approve_scope(&id, &digest, unpriced, unqualified)
    }
    .map_err(ai_error)?;
    let path = manifest_path(&context.root, &id)?;
    let service = VertexService::new(scoped.clone(), context.vault.clone()).map_err(ai_error)?;
    let output = service
        .execute_next_with_guard(&id, || {
            if read_manifest(&path).ok().as_ref() != Some(&manifest) {
                return Err(AiError::PreparationChanged);
            }
            Ok(())
        })
        .await
        .map_err(ai_error)?;
    Ok(
        json!({"execution":output,"quote":scoped.quote(&id).map_err(ai_error)?,"validation":scoped.validation_totals().map_err(ai_error)?}),
    )
}

pub(super) fn acknowledge_unknown(root: &Path, mut args: Arguments) -> Result<Value> {
    let id = args.string("--attempt-id")?;
    args.finish()?;
    let context = Context::open(root)?;
    context.store.acknowledge_unknown(&id).map_err(ai_error)?;
    Ok(
        json!({"acknowledged":id,"refund":false,"retryApproved":false,"validation":context.store.validation_totals().map_err(ai_error)?}),
    )
}

pub(super) fn refresh_quote(root: &Path, mut args: Arguments) -> Result<Value> {
    let id = args.string("--job-id")?;
    args.finish()?;
    let context = Context::open(root)?;
    context.manifest(&id)?;
    Ok(json!({"quote":context.store.refresh_quote(&id).map_err(ai_error)?,"chargeApproved":false}))
}

pub(super) fn validate_charge_approval(
    manifest: &Manifest,
    quote: &surtitle_ai::JobQuote,
    digest: &str,
    approved: Option<u64>,
    retry: bool,
) -> Result<()> {
    if digest != manifest.plan_digest
        || digest != quote.digest
        || manifest.prepared.requests.len() != 1
        || approved != quote.additional_reservation_microusd
        || quote.completed_requests != 0
        || (!retry && quote.state != "prepared")
        || (retry && !["paused", "needs_review"].contains(&quote.state.as_str()))
    {
        return Err("Review the current digest and exact reservation; retries require --retry and a separate charge approval".into());
    }
    Ok(())
}
