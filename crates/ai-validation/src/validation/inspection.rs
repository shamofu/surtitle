//! Read prepared jobs and produce bounded validation evidence reports.
use super::arguments::{Arguments, format_usd};
use super::context::Context;
use super::files::{absolute, write_json_new};
use super::preparation::source_metadata;
use super::{Result, ai_error};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use surtitle_ai::{RequestTask, sha256_bytes};

pub(super) fn show(root: &Path, mut args: Arguments) -> Result<Value> {
    let id = args.string("--job-id")?;
    args.finish()?;
    let context = Context::open(root)?;
    let quote = context.store.quote(&id).map_err(ai_error)?;
    Ok(
        json!({"manifest":context.manifest(&id)?,"quote":quote,"approveChargeUsd":quote.additional_reservation_microusd.map(format_usd),"budget":context.store.summary().map_err(ai_error)?,"validation":context.store.validation_totals().map_err(ai_error)?,"networkRequests":0}),
    )
}

pub(super) fn report_command(root: &Path, mut args: Arguments) -> Result<Value> {
    let output = args.take("--output").map(PathBuf::from);
    args.finish()?;
    let context = Context::open(root)?;
    let report = report(&context)?;
    if let Some(path) = output {
        absolute(&path)?;
        write_json_new(&path, &report)?;
    }
    Ok(report)
}

pub(super) fn report(context: &Context) -> Result<Value> {
    let mut requests = Vec::new();
    let attempts = context.store.validation_attempts().map_err(ai_error)?;
    for quote in context.store.list_jobs().map_err(ai_error)? {
        let manifest = context.manifest(&quote.id)?;
        let task = &manifest.prepared.requests[0];
        let (cues, hash) = source_metadata(task);
        let (term, proficiency) = match task {
            RequestTask::Explanation {
                term, proficiency, ..
            } => (Some(term), Some(proficiency)),
            _ => (None, None),
        };
        let request_body_sha256 = sha256_bytes(
            &serde_json::to_vec(
                manifest
                    .prepared
                    .request_body_snapshot(0)
                    .map_err(ai_error)?,
            )
            .map_err(|_| "Cannot encode request snapshot")?,
        );
        let task_kind =
            serde_json::to_value(task).map_err(|_| "Cannot encode report")?["kind"].clone();
        let job_attempts: Vec<_> = attempts
            .iter()
            .filter(|attempt| attempt.job_id == quote.id)
            .collect();
        requests.push(json!({"id":quote.id,"caseId":manifest.case_id,"taskKind":task_kind,"model":manifest.prepared.execution.model_id,"execution":manifest.prepared.execution,
            "digest":quote.digest,"requestBodySha256":request_body_sha256,"term":term,"proficiency":proficiency,"state":quote.state,"estimatedMaxMicrousd":quote.estimated_max_microusd,
            "sourceCues":cues,"sourceAudioSha256":hash,"maxAudioSeconds":manifest.max_audio_seconds,"attempts":job_attempts,"output":context.store.response(&quote.id,0).map_err(ai_error)?}));
    }
    Ok(
        json!({"schemaVersion":1,"evidenceKind":"provider-validation","generatedAtMs":chrono::Utc::now().timestamp_millis(),
        "validation":context.store.validation_totals().map_err(ai_error)?,"campaigns":context.store.validation_campaigns().map_err(ai_error)?,"budget":context.store.summary().map_err(ai_error)?,"requests":requests}),
    )
}
