use super::*;
use surtitle_ai::ValidationCampaignApproval;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Jobs {
    label: String,
    job_ids: Vec<String>,
    expires_at_ms: i64,
}

pub(super) fn command(command: &str, root: &Path, mut args: Arguments) -> Result<Value> {
    match command {
        "campaign-quote" => {
            let jobs: Jobs = read_document(&args.path("--jobs-file")?)?;
            args.finish()?;
            let context = Context::open(root)?;
            for id in &jobs.job_ids {
                context.manifest(id)?;
            }
            let quote = context
                .store
                .quote_validation_campaign(&jobs.label, &jobs.job_ids, jobs.expires_at_ms)
                .map_err(ai_error)?;
            Ok(
                json!({"campaign":quote,"approved":false,"networkRequests":0,
                "approvalTemplate":{"digest":quote.digest,"maxRequests":quote.max_requests,
                    "maxAudioDurationMs":quote.max_audio_duration_ms,"maxReservationMicrousd":quote.max_reservation_microusd,
                    "totalLimitMicrousd":quote.total_limit_microusd,"expiresAtMs":quote.expires_at_ms}}),
            )
        }
        "campaign-show" => {
            let id = args.string("--campaign-id")?;
            args.finish()?;
            let context = Context::open(root)?;
            let campaigns = context.store.validation_campaigns().map_err(ai_error)?;
            let campaign = campaigns
                .into_iter()
                .find(|item| item["campaign"]["id"] == id)
                .ok_or("Unknown campaign")?;
            Ok(
                json!({"campaignStatus":campaign,"validation":context.store.validation_totals().map_err(ai_error)?,"networkRequests":0}),
            )
        }
        "campaign-approve" => {
            let id = args.string("--campaign-id")?;
            let approval: ValidationCampaignApproval =
                read_document(&args.path("--approval-file")?)?;
            args.finish()?;
            let context = Context::open(root)?;
            context
                .store
                .approve_validation_campaign(&id, approval)
                .map_err(ai_error)?;
            Ok(json!({"campaignId":id,"approved":true,"requestApproved":false,"networkRequests":0}))
        }
        _ => Err("Unknown campaign command".into()),
    }
}

pub(super) fn run_scope(
    args: &mut Arguments,
    retry: bool,
    unpriced: bool,
) -> Result<Option<(String, String)>> {
    match (args.take("--campaign-id"), args.take("--campaign-digest")) {
        (None, None) => Ok(None),
        (Some(id), Some(digest)) if !retry && !unpriced => Ok(Some((
            id.into_string().map_err(|_| "Invalid campaign ID")?,
            digest.into_string().map_err(|_| "Invalid campaign digest")?,
        ))),
        _ => Err("Campaign execution requires its ID and digest; retries and unpriced requests are forbidden".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn campaign_run_requires_both_identifiers_and_disallows_retry_and_unpriced() {
        for (args, retry, unpriced, expected) in [
            (vec![], false, false, true),
            (vec!["--campaign-id", "c"], false, false, false),
            (
                vec!["--campaign-id", "c", "--campaign-digest", "d"],
                false,
                false,
                true,
            ),
            (
                vec!["--campaign-id", "c", "--campaign-digest", "d"],
                true,
                false,
                false,
            ),
            (
                vec!["--campaign-id", "c", "--campaign-digest", "d"],
                false,
                true,
                false,
            ),
        ] {
            let mut parsed =
                Arguments::parse(args.into_iter().map(OsString::from).collect()).unwrap();
            assert_eq!(run_scope(&mut parsed, retry, unpriced).is_ok(), expected);
        }
    }
}
