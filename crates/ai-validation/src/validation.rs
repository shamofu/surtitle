use arguments::Arguments;
use context::initialize;
use serde_json::{Value, json};
use std::ffi::OsString;
use surtitle_ai::{AiError, BudgetLimits};

type Result<T> = std::result::Result<T, String>;
const FORMAT: &str = "surtitle-isolated-ai-validation";
const MAX_DOCUMENT_BYTES: u64 = 2 * 1024 * 1024;
const MAX_AUDIO_SECONDS: u32 = 240;
mod arguments;
mod campaigns;
mod context;
mod credentials;
mod execution;
mod files;
mod inspection;
mod preparation;
mod review_audio;

const HELP: &str = "Windows Vertex qualification CLI. No command sends automatically.\n\
campaign-quote --data-root ABS_DIR --jobs-file ABS_JSON\n\
campaign-show --data-root ABS_DIR --campaign-id ID\n\
campaign-approve --data-root ABS_DIR --campaign-id ID --approval-file ABS_JSON\n\
init --data-root ABS_DIR --total-usd N --per-job-usd N --daily-usd N --monthly-usd N\n\
import-key --data-root ABS_DIR --key-file ABS_JSON\n\
check-key --data-root ABS_DIR --credential-id ID\n\
list-models --data-root ABS_DIR --credential-id ID --location LOCATION\n\
lookup-price --data-root ABS_DIR --credential-id ID --location LOCATION --model-id ID\n\
review-audio --review-manifest ABS_JSON --results ABS_REPORT --output ABS_JSON\n\
reparse-audio --results ABS_REPORT --request-id ID --attempt-id ID --audio-file ABS_WAV --output ABS_JSON\n\
prepare --data-root ABS_DIR --credential-id ID --case-id CASE --task-file ABS_JSON\n\
prepare --data-root ABS_DIR --credential-id ID --case-id CASE --audio-file ABS_WAV --adapter transcribe|transcribe-text|audio --language en-US --max-audio-seconds N\n\
show --data-root ABS_DIR --job-id ID\n\
run --data-root ABS_DIR --job-id ID --digest SHA256 --acknowledge-unqualified (--approve-charge-usd EXACT_ESTIMATE | --approve-unpriced) [--retry]\n\
acknowledge-unknown --data-root ABS_DIR --attempt-id ID\n\
refresh-quote --data-root ABS_DIR --job-id ID\n\
report --data-root ABS_DIR [--output ABS_JSON]\n\
Every prepare requires --model-id ID --location LOCATION --max-output-tokens N; optional --price-file ABS_JSON and --thinking-level LEVEL OR --thinking-budget N. No model is selected automatically. Text task files use the RequestTask JSON format. Audio requires an explicit --max-audio-seconds from 1 to 240 and complete 16 kHz mono PCM16 WAV within that limit. Each plan has one request; legacy ceilings remain 120 attempts and 90 minutes. Additional campaign scope is separately quoted and approved within the unchanged lifetime monetary cap; campaign run additionally requires --campaign-id ID --campaign-digest SHA256, forbids unpriced requests and retries.\n\
list-models and lookup-price perform Google metadata/OAuth requests only, never generation; permission or catalog failures do not select a fallback model or price.\n\
All budgets are explicit USD decimals (up to six fractional digits). Unknown priced reservations consume the lifetime total forever. Unpriced attempts are recorded separately and cannot be represented by a USD cap; explicit scope approval still bounds requests, audio and output settings.\n\
run requires a newly reviewed digest and exact reservation; --retry is separate from acknowledging unknown costs.\n\
Reports include bounded generated non-thought text and finish reasons for diagnosis; generated text may reproduce the supplied source. Credentials and arbitrary provider diagnostics are excluded.";

pub async fn run(mut values: Vec<OsString>) -> Result<Value> {
    if values.is_empty() || values[0] == "--help" || values[0] == "help" {
        return Ok(json!({"help": HELP}));
    }
    let command = values
        .remove(0)
        .into_string()
        .map_err(|_| "Invalid command")?;
    let mut args = Arguments::parse(values)?;
    if command == "reparse-audio" {
        let results = args.path("--results")?;
        let request = args.string("--request-id")?;
        let attempt = args.string("--attempt-id")?;
        let audio = args.path("--audio-file")?;
        let output = args.path("--output")?;
        args.finish()?;
        return review_audio::reparse(&results, &request, &attempt, &audio, &output);
    }
    if command == "review-audio" {
        let manifest = args.path("--review-manifest")?;
        let results = args.path("--results")?;
        let output = args.path("--output")?;
        args.finish()?;
        return review_audio::run(&manifest, &results, &output);
    }
    let root = args.path("--data-root")?;
    if command.starts_with("campaign-") {
        return campaigns::command(&command, &root, args);
    }
    if command == "init" {
        let total = args.money("--total-usd")?;
        let limits = BudgetLimits {
            per_job_microusd: args.money("--per-job-usd")?,
            daily_microusd: args.money("--daily-usd")?,
            monthly_microusd: args.money("--monthly-usd")?,
        };
        args.finish()?;
        if !(limits.per_job_microusd <= limits.daily_microusd
            && limits.daily_microusd <= limits.monthly_microusd
            && limits.monthly_microusd <= total)
        {
            return Err("Require per-job <= daily <= monthly <= lifetime total".into());
        }
        initialize(&root, total, limits)?;
        return Ok(
            json!({"dataRoot":root,"budget":limits,"validationTotalMicrousd":total,"networkRequests":0}),
        );
    }
    // Parse every command's sensitive approval arguments before opening the root.
    match command.as_str() {
        "import-key" => credentials::import_key(&root, args),
        "check-key" => credentials::check_key(&root, args),
        "list-models" => credentials::list_models(&root, args).await,
        "lookup-price" => credentials::lookup_price(&root, args).await,
        "prepare" => preparation::prepare(&root, args),
        "run" => execution::execute(&root, args).await,
        "acknowledge-unknown" => execution::acknowledge_unknown(&root, args),
        "refresh-quote" => execution::refresh_quote(&root, args),
        "show" => inspection::show(&root, args),
        "report" => inspection::report_command(&root, args),
        _ => Err("Unknown command; use --help".into()),
    }
}

fn ensure_windows() -> Result<()> {
    if cfg!(windows) {
        Ok(())
    } else {
        Err("Paid validation requires Windows and the DPAPI credential vault".into())
    }
}

fn ai_error(error: AiError) -> String {
    match error {
        AiError::Database(_) | AiError::Io(_) | AiError::Json(_) => {
            "Local validation data could not be processed; no automatic retry was made".into()
        }
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests;
