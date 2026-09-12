use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    ffi::OsString,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};
use surtitle_ai::{
    AiError, AiStore, AudioAttachment, BudgetLimits, CredentialVault, ExecutionConfig,
    PreparationBinding, PreparedJob, PriceSnapshot, RequestTask, ThinkingConfig,
    ValidationApproval, VertexDiscovery, VertexService, sha256_bytes,
};

type Result<T> = std::result::Result<T, String>;
const FORMAT: &str = "surtitle-isolated-ai-validation";
const MAX_DOCUMENT_BYTES: u64 = 2 * 1024 * 1024;
const MAX_AUDIO_SECONDS: u32 = 240;
mod campaigns;
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

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Marker {
    format: String,
    schema_version: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    schema_version: u32,
    job_id: String,
    case_id: String,
    plan_digest: String,
    prepared: PreparedJob,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    max_audio_seconds: Option<u32>,
}

struct Context {
    root: PathBuf,
    store: AiStore,
    vault: CredentialVault,
    _lock: fs::File,
}

impl Context {
    fn open(root: &Path) -> Result<Self> {
        absolute(root)?;
        reject_link(root)?;
        let marker: Marker = read_document(&root.join("validation-root.json"))?;
        if marker.format != FORMAT || marker.schema_version != 2 {
            return Err("This directory is not an isolated validation root".into());
        }
        let root = root
            .canonicalize()
            .map_err(|_| "Validation root is unavailable")?;
        for name in [
            "charges.sqlite",
            "credentials",
            "manifests",
            "inputs",
            "instance.lock",
        ] {
            reject_link(&root.join(name))?;
        }
        let lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(root.join("instance.lock"))
            .map_err(|_| "Cannot open validation instance lock")?;
        lock.try_lock()
            .map_err(|_| "Another validation command is using this data root")?;
        let store = AiStore::open(root.join("charges.sqlite")).map_err(ai_error)?;
        store.validation_totals().map_err(ai_error)?;
        store.recover_interrupted().map_err(ai_error)?;
        let vault = CredentialVault::new(root.join("credentials")).map_err(ai_error)?;
        Ok(Self {
            root,
            store,
            vault,
            _lock: lock,
        })
    }

    fn manifest(&self, job_id: &str) -> Result<Manifest> {
        let manifest = read_manifest(&manifest_path(&self.root, job_id)?)?;
        if manifest.job_id != job_id
            || manifest.prepared != self.store.prepared_job(job_id).map_err(ai_error)?
        {
            return Err(
                "The reviewed manifest differs from the immutable ledger preparation".into(),
            );
        }
        Ok(manifest)
    }
}

struct Arguments {
    values: BTreeMap<String, OsString>,
}
impl Arguments {
    fn parse(items: Vec<OsString>) -> Result<Self> {
        let mut values = BTreeMap::new();
        let mut iter = items.into_iter();
        while let Some(option) = iter.next() {
            let option = option.into_string().map_err(|_| "Invalid option name")?;
            if !option.starts_with("--") || option == "--" {
                return Err("Use named --options only".into());
            }
            let value = if ["--retry", "--approve-unpriced", "--acknowledge-unqualified"]
                .contains(&option.as_str())
            {
                OsString::from("true")
            } else {
                iter.next().ok_or("Option value missing")?
            };
            if value.is_empty() || values.insert(option, value).is_some() {
                return Err("Empty or duplicate option".into());
            }
        }
        Ok(Self { values })
    }
    fn take(&mut self, name: &str) -> Option<OsString> {
        self.values.remove(name)
    }
    fn required(&mut self, name: &str) -> Result<OsString> {
        self.take(name)
            .ok_or_else(|| format!("Required option: {name}"))
    }
    fn string(&mut self, name: &str) -> Result<String> {
        self.required(name)?
            .into_string()
            .map_err(|_| "Option must be UTF-8 text".into())
    }
    fn path(&mut self, name: &str) -> Result<PathBuf> {
        let path = PathBuf::from(self.required(name)?);
        absolute(&path)?;
        Ok(path)
    }
    fn money(&mut self, name: &str) -> Result<u64> {
        usd(&self.string(name)?)
    }
    fn finish(self) -> Result<()> {
        if self.values.is_empty() {
            Ok(())
        } else {
            Err("Unrecognized or incompatible option".into())
        }
    }
}

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
        "import-key" => {
            let key_file = args.path("--key-file")?;
            args.finish()?;
            let context = Context::open(&root)?;
            let metadata = context
                .vault
                .import_service_account(key_file)
                .map_err(ai_error)?;
            Ok(json!({"credential":metadata,"encryptedWith":"Windows DPAPI","networkRequests":0}))
        }
        "check-key" => {
            let id = args.string("--credential-id")?;
            args.finish()?;
            let context = Context::open(&root)?;
            let metadata = context
                .vault
                .list()
                .map_err(ai_error)?
                .into_iter()
                .find(|key| key.id == id)
                .ok_or("Credential cannot be unlocked in this Windows account")?;
            Ok(
                json!({"credential":metadata,"unlocked":true,"oauthVerified":false,"vertexPermissionsVerified":false,"networkRequests":0}),
            )
        }
        "list-models" => {
            let id = args.string("--credential-id")?;
            let location = args.string("--location")?;
            args.finish()?;
            let context = Context::open(&root)?;
            let discovery = VertexDiscovery::new(context.vault).map_err(ai_error)?;
            let models = discovery
                .list_models(&id, &location)
                .await
                .map_err(ai_error)?;
            Ok(json!({"models":models,"location":location,"generationRequests":0}))
        }
        "lookup-price" => {
            let id = args.string("--credential-id")?;
            let location = args.string("--location")?;
            let model = args.string("--model-id")?;
            args.finish()?;
            let context = Context::open(&root)?;
            let discovery = VertexDiscovery::new(context.vault).map_err(ai_error)?;
            let pricing = discovery
                .pricing(&id, &model, &location)
                .await
                .map_err(ai_error)?;
            Ok(
                json!({"pricing":pricing,"modelId":model,"location":location,"generationRequests":0}),
            )
        }
        "prepare" => {
            let id = args.string("--credential-id")?;
            let case_id = args.string("--case-id")?;
            valid_case_id(&case_id)?;
            let task_file = args.take("--task-file").map(PathBuf::from);
            let audio_file = args.take("--audio-file").map(PathBuf::from);
            let execution = parse_execution(&mut args)?;
            let max_audio_seconds = if audio_file.is_some() {
                Some(parse_audio_seconds(&args.string("--max-audio-seconds")?)?)
            } else {
                None
            };
            let audio_options = if audio_file.is_some() {
                Some((args.string("--adapter")?, args.string("--language")?))
            } else {
                None
            };
            args.finish()?;
            if task_file.is_some() == audio_file.is_some() {
                return Err("Choose exactly one task file or audio file".into());
            }
            let context = Context::open(&root)?;
            let metadata = context
                .vault
                .list()
                .map_err(ai_error)?
                .into_iter()
                .find(|key| key.id == id)
                .ok_or("Import and select an unlocked credential first")?;
            let task = if let Some(path) = task_file {
                absolute(&path)?;
                let task: RequestTask = read_document(&path)?;
                if matches!(
                    task,
                    RequestTask::AudioTranscription { .. }
                        | RequestTask::TranscribePreview { .. }
                        | RequestTask::TranscribeDiagnostic { .. }
                ) {
                    return Err(
                        "Audio tasks require --audio-file so duration is measured locally".into(),
                    );
                }
                task
            } else {
                let path = audio_file.ok_or("Audio file is required")?;
                absolute(&path)?;
                let (model, language) =
                    audio_options.ok_or("Audio model and language are required")?;
                let (bytes, duration) = read_wav(&path, max_audio_seconds.unwrap())?;
                let hash = sha256_bytes(&bytes);
                let prepared_path = context.root.join("inputs").join(format!("{hash}.wav"));
                if prepared_path.exists() {
                    reject_link(&prepared_path)?;
                    if surtitle_ai::hash_file(&prepared_path).map_err(ai_error)? != hash {
                        return Err("Prepared audio hash mismatch".into());
                    }
                } else {
                    write_new(&prepared_path, &bytes)?;
                }
                let audio = bind_measured_audio(prepared_path, &bytes, duration)?;
                match model.as_str() {
                    "transcribe" => RequestTask::TranscribePreview { language, audio },
                    "transcribe-text" => RequestTask::TranscribeDiagnostic { language, audio },
                    "audio" => RequestTask::AudioTranscription { language, audio },
                    _ => {
                        return Err(
                            "Audio adapter must be transcribe, transcribe-text or audio".into()
                        );
                    }
                }
            };
            let prepared = make_plan(
                case_id.clone(),
                metadata.project_id,
                id,
                task,
                execution,
                max_audio_seconds,
            )?;
            let quote = context.store.prepare(prepared.clone()).map_err(ai_error)?;
            let manifest = Manifest {
                schema_version: 2,
                job_id: quote.id.clone(),
                case_id,
                plan_digest: quote.digest.clone(),
                prepared,
                max_audio_seconds,
            };
            let path = manifest_path(&context.root, &quote.id)?;
            if path.exists() {
                if read_manifest(&path)? != manifest {
                    return Err("Existing preparation manifest differs".into());
                }
            } else {
                write_json_new(&path, &manifest)?;
            }
            Ok(
                json!({"manifest":manifest,"quote":quote,"approveChargeUsd":quote.additional_reservation_microusd.map(format_usd),"budget":context.store.budget().map_err(ai_error)?,"validation":context.store.validation_totals().map_err(ai_error)?,"networkRequests":0}),
            )
        }
        "show" => {
            let id = args.string("--job-id")?;
            args.finish()?;
            let context = Context::open(&root)?;
            let quote = context.store.quote(&id).map_err(ai_error)?;
            Ok(
                json!({"manifest":context.manifest(&id)?,"quote":quote,"approveChargeUsd":quote.additional_reservation_microusd.map(format_usd),"budget":context.store.summary().map_err(ai_error)?,"validation":context.store.validation_totals().map_err(ai_error)?,"networkRequests":0}),
            )
        }
        "run" => {
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
            let context = Context::open(&root)?;
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
                context.store.with_development_campaign(
                    &id,
                    &campaign_id,
                    &campaign_digest,
                    approval,
                )
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
            let service =
                VertexService::new(scoped.clone(), context.vault.clone()).map_err(ai_error)?;
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
        "acknowledge-unknown" => {
            let id = args.string("--attempt-id")?;
            args.finish()?;
            let context = Context::open(&root)?;
            context.store.acknowledge_unknown(&id).map_err(ai_error)?;
            Ok(
                json!({"acknowledged":id,"refund":false,"retryApproved":false,"validation":context.store.validation_totals().map_err(ai_error)?}),
            )
        }
        "refresh-quote" => {
            let id = args.string("--job-id")?;
            args.finish()?;
            let context = Context::open(&root)?;
            context.manifest(&id)?;
            Ok(
                json!({"quote":context.store.refresh_quote(&id).map_err(ai_error)?,"chargeApproved":false}),
            )
        }
        "report" => {
            let output = args.take("--output").map(PathBuf::from);
            args.finish()?;
            let context = Context::open(&root)?;
            let report = report(&context)?;
            if let Some(path) = output {
                absolute(&path)?;
                write_json_new(&path, &report)?;
            }
            Ok(report)
        }
        _ => Err("Unknown command; use --help".into()),
    }
}

fn parse_execution(args: &mut Arguments) -> Result<ExecutionConfig> {
    let model_id = args.string("--model-id")?;
    let location = args.string("--location")?;
    let max_output_tokens = args
        .string("--max-output-tokens")?
        .parse()
        .map_err(|_| "Invalid output token limit")?;
    let level = args.take("--thinking-level");
    let budget = args.take("--thinking-budget");
    let thinking = match (level, budget) {
        (None, None) => ThinkingConfig::Omit,
        (Some(level), None) => ThinkingConfig::Level {
            level: level.into_string().map_err(|_| "Invalid thinking level")?,
        },
        (None, Some(budget)) => ThinkingConfig::Budget {
            tokens: budget
                .into_string()
                .map_err(|_| "Invalid thinking budget")?
                .parse()
                .map_err(|_| "Invalid thinking budget")?,
        },
        _ => return Err("Thinking level and budget are mutually exclusive".into()),
    };
    let price = args
        .take("--price-file")
        .map(|path| {
            let path = PathBuf::from(path);
            absolute(&path)?;
            read_document::<PriceSnapshot>(&path)
        })
        .transpose()?;
    let config = ExecutionConfig {
        model_id,
        location,
        max_output_tokens,
        thinking,
        price,
    };
    config.validate().map_err(ai_error)?;
    Ok(config)
}

fn initialize(root: &Path, total: u64, limits: BudgetLimits) -> Result<()> {
    absolute(root)?;
    if root.exists() {
        return Err(
            "Initialization requires a new directory; existing totals are never reset".into(),
        );
    }
    fs::create_dir(root).map_err(|_| "Cannot create validation root; its parent must exist")?;
    let lock = fs::OpenOptions::new()
        .write(true)
        .read(true)
        .create_new(true)
        .open(root.join("instance.lock"))
        .map_err(|_| "Cannot create instance lock")?;
    lock.try_lock().map_err(|_| "Cannot lock validation root")?;
    for directory in ["credentials", "manifests", "inputs"] {
        fs::create_dir(root.join(directory)).map_err(|_| "Cannot create validation directory")?;
    }
    let store = AiStore::open(root.join("charges.sqlite")).map_err(ai_error)?;
    store.initialize_validation_total(total).map_err(ai_error)?;
    store.set_budget(limits).map_err(ai_error)?;
    write_json_new(
        &root.join("validation-root.json"),
        &Marker {
            format: FORMAT.into(),
            schema_version: 2,
        },
    )?;
    Ok(())
}

fn validate_charge_approval(
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

fn make_plan(
    case_id: String,
    project: String,
    credential: String,
    task: RequestTask,
    execution: ExecutionConfig,
    max_audio_seconds: Option<u32>,
) -> Result<PreparedJob> {
    task.validate().map_err(ai_error)?;
    let source = source_metadata(&task);
    let source_hash = source
        .1
        .unwrap_or_else(|| sha256_bytes(&serde_json::to_vec(&source.0).unwrap_or_default()));
    let settings = settings_digest(&task, max_audio_seconds)?;
    let plan = PreparedJob::new(
        format!("Validation / {case_id}"),
        project,
        credential,
        PreparationBinding {
            media_id: format!("validation:{case_id}"),
            transcript_revision: source_hash.clone(),
            source_sha256: source_hash,
            settings_sha256: settings,
        },
        vec![task],
        execution,
    )
    .map_err(ai_error)?;
    plan.validate().map_err(ai_error)?;
    Ok(plan)
}

fn settings_digest(task: &RequestTask, max_audio_seconds: Option<u32>) -> Result<String> {
    if max_audio_seconds.is_none() {
        return Ok(sha256_bytes(
            &serde_json::to_vec(task).map_err(|_| "Cannot encode preparation")?,
        ));
    }
    let value = if let Some(seconds) = max_audio_seconds {
        if seconds == 0 || seconds > MAX_AUDIO_SECONDS {
            return Err("Audio limit must be from 1 to 240 seconds".into());
        }
        let duration = match task {
            RequestTask::AudioTranscription { audio, .. }
            | RequestTask::TranscribePreview { audio, .. }
            | RequestTask::TranscribeDiagnostic { audio, .. } => audio.duration_ms,
            _ => return Err("Audio duration limits only apply to audio tasks".into()),
        };
        if duration > u64::from(seconds) * 1000 {
            return Err("Prepared audio exceeds the explicitly selected limit".into());
        }
        json!({"task":task,"maxAudioSeconds":seconds})
    } else {
        serde_json::to_value(task).map_err(|_| "Cannot encode preparation")?
    };
    Ok(sha256_bytes(
        &serde_json::to_vec(&value).map_err(|_| "Cannot encode preparation")?,
    ))
}

fn read_manifest(path: &Path) -> Result<Manifest> {
    let value: Value = read_document(path)?;
    let manifest: Manifest =
        serde_json::from_value(value.clone()).map_err(|_| "Invalid preparation manifest")?;
    if serde_json::to_value(&manifest).map_err(|_| "Invalid manifest")? != value
        || manifest.schema_version != 2
        || manifest.prepared.requests.len() != 1
        || manifest.prepared.digest().map_err(ai_error)? != manifest.plan_digest
        || manifest.prepared.binding.media_id != format!("validation:{}", manifest.case_id)
    {
        return Err("Preparation manifest was changed or is incompatible".into());
    }
    if manifest.prepared.binding.settings_sha256
        != settings_digest(&manifest.prepared.requests[0], manifest.max_audio_seconds)?
    {
        return Err("The explicit audio limit differs from the immutable preparation".into());
    }
    valid_case_id(&manifest.case_id)?;
    manifest.prepared.validate().map_err(ai_error)?;
    Ok(manifest)
}

fn report(context: &Context) -> Result<Value> {
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

fn source_metadata(task: &RequestTask) -> (Vec<surtitle_ai::SourceCue>, Option<String>) {
    match task {
        RequestTask::Vocabulary { cues, .. }
        | RequestTask::Explanation { cues, .. }
        | RequestTask::Translation { cues, .. } => (cues.clone(), None),
        RequestTask::AudioTranscription { audio, .. }
        | RequestTask::TranscribePreview { audio, .. }
        | RequestTask::TranscribeDiagnostic { audio, .. } => (vec![], Some(audio.sha256.clone())),
    }
}

fn bind_measured_audio(
    path: PathBuf,
    measured_bytes: &[u8],
    duration_ms: u64,
) -> Result<AudioAttachment> {
    let audio = AudioAttachment::from_file(path, 0, duration_ms).map_err(ai_error)?;
    // Duration and the quoted audio identity must describe the same snapshot.
    // The staged file may have been replaced after it was written or checked.
    if audio.sha256 != sha256_bytes(measured_bytes) || audio.byte_len != measured_bytes.len() as u64
    {
        return Err(
            "Prepared audio changed after its duration was measured; prepare a new input".into(),
        );
    }
    Ok(audio)
}

fn parse_audio_seconds(value: &str) -> Result<u32> {
    let seconds = value
        .parse::<u32>()
        .map_err(|_| "Audio limit must be an integer from 1 to 240 seconds")?;
    if seconds == 0 || seconds > MAX_AUDIO_SECONDS {
        return Err("Audio limit must be from 1 to 240 seconds".into());
    }
    Ok(seconds)
}

fn read_wav(path: &Path, max_audio_seconds: u32) -> Result<(Vec<u8>, u64)> {
    if max_audio_seconds == 0 || max_audio_seconds > MAX_AUDIO_SECONDS {
        return Err("Audio limit must be from 1 to 240 seconds".into());
    }
    // Bound metadata overhead as well as PCM bytes; do not read arbitrarily large files.
    let bytes = read_bounded(path, u64::from(max_audio_seconds) * 32_000 + 64 * 1024)?;
    if bytes.len() < 44
        || &bytes[..4] != b"RIFF"
        || &bytes[8..12] != b"WAVE"
        || u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize + 8 != bytes.len()
    {
        return Err("Use a complete RIFF WAV file".into());
    }
    let mut position = 12usize;
    let mut format = None;
    let mut data = None;
    while position + 8 <= bytes.len() {
        let length =
            u32::from_le_bytes(bytes[position + 4..position + 8].try_into().unwrap()) as usize;
        let start = position + 8;
        let end = start.checked_add(length).ok_or("WAV chunk overflow")?;
        if end > bytes.len() {
            return Err("Truncated WAV chunk".into());
        }
        match &bytes[position..position + 4] {
            b"fmt " => {
                if format.is_some() || length < 16 {
                    return Err("Invalid WAV format chunk".into());
                }
                format = Some(bytes[start..end].to_vec());
            }
            b"data" => {
                if data.is_some() {
                    return Err("Use one WAV data chunk".into());
                }
                data = Some(length);
            }
            _ => {}
        }
        position = end.checked_add(length % 2).ok_or("WAV chunk overflow")?;
    }
    if position != bytes.len() {
        return Err("Invalid trailing WAV bytes".into());
    }
    let format = format.ok_or("WAV format missing")?;
    let expected: [u8; 16] = [1, 0, 1, 0, 128, 62, 0, 0, 0, 125, 0, 0, 2, 0, 16, 0];
    if format[..16] != expected {
        return Err("Convert audio to 16 kHz mono PCM16 WAV before preparing it".into());
    }
    let length = data.ok_or("WAV audio data missing")?;
    if length == 0 || length % 2 != 0 || length as u64 > u64::from(max_audio_seconds) * 32_000 {
        return Err(
            "Validation audio must be nonempty and within the explicit duration limit".into(),
        );
    }
    let duration_ms = (length as u64 * 1000).div_ceil(32_000);
    Ok((bytes, duration_ms))
}

fn format_usd(value: u64) -> String {
    format!("{}.{:06}", value / 1_000_000, value % 1_000_000)
}

fn usd(value: &str) -> Result<u64> {
    let (whole, fractional) = value.split_once('.').unwrap_or((value, ""));
    if whole.is_empty()
        || !whole.bytes().all(|b| b.is_ascii_digit())
        || fractional.len() > 6
        || !fractional.bytes().all(|b| b.is_ascii_digit())
    {
        return Err("USD must be a positive decimal with at most six fractional digits".into());
    }
    let whole = whole
        .parse::<u64>()
        .map_err(|_| "USD amount is too large")?;
    let fraction = if fractional.is_empty() {
        0
    } else {
        fractional
            .parse::<u64>()
            .map_err(|_| "Invalid USD fraction")?
            * 10u64.pow(6 - fractional.len() as u32)
    };
    let amount = whole
        .checked_mul(1_000_000)
        .and_then(|n| n.checked_add(fraction))
        .ok_or("USD amount is too large")?;
    if amount == 0 || amount > 1_000_000_000_000 {
        return Err("USD amount is outside the supported positive range".into());
    }
    Ok(amount)
}
fn valid_case_id(id: &str) -> Result<()> {
    if id.is_empty()
        || id.len() > 100
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
    {
        Err("Case ID must contain 1-100 ASCII letters, digits, hyphens or underscores".into())
    } else {
        Ok(())
    }
}
fn manifest_path(root: &Path, id: &str) -> Result<PathBuf> {
    if id.len() != 36 || !id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') {
        return Err("Invalid job ID".into());
    }
    Ok(root.join("manifests").join(format!("{id}.json")))
}
fn absolute(path: &Path) -> Result<()> {
    if path.is_absolute() {
        Ok(())
    } else {
        Err("Use an explicit absolute path".into())
    }
}
fn reject_link(path: &Path) -> Result<()> {
    if fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
        Err("Validation files must not be symbolic links".into())
    } else {
        Ok(())
    }
}
fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>> {
    reject_link(path)?;
    let mut file = fs::File::open(path).map_err(|_| "Cannot read the requested local file")?;
    if file
        .metadata()
        .map_err(|_| "Cannot inspect local file")?
        .len()
        > limit
    {
        return Err("Local input exceeds size limit".into());
    }
    let mut bytes = vec![];
    Read::by_ref(&mut file)
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read local file")?;
    if bytes.len() as u64 > limit {
        return Err("Local input exceeds size limit".into());
    }
    Ok(bytes)
}
fn read_document<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T> {
    serde_json::from_slice(&read_bounded(path, MAX_DOCUMENT_BYTES)?)
        .map_err(|_| "Invalid local JSON document".into())
}
fn write_new(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|_| "Output already exists or cannot be created")?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "Cannot persist output".to_owned())
}
fn write_json_new(path: &Path, value: &impl Serialize) -> Result<()> {
    write_new(
        path,
        &serde_json::to_vec_pretty(value).map_err(|_| "Cannot encode JSON output")?,
    )
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
