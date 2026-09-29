use super::*;

pub(super) fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T> {
    ensure!(
        !fs::symlink_metadata(path)?.file_type().is_symlink(),
        "transcript metadata must be an app-owned file"
    );
    let mut file = fs::File::open(path)?;
    ensure!(
        file.metadata()?.len() <= 32 * 1024 * 1024,
        "transcript metadata exceeds its size limit"
    );
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(32 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() <= 32 * 1024 * 1024,
        "transcript metadata exceeds its size limit"
    );
    Ok(serde_json::from_slice(&bytes)?)
}
pub(super) fn uuid_id(id: &str) -> Result<()> {
    ensure!(
        uuid::Uuid::parse_str(id).is_ok(),
        "invalid transcript preparation or job ID"
    );
    Ok(())
}
pub(super) fn bindings_root(state: &AppState) -> Result<PathBuf> {
    let root = state.root.join("transcript-jobs");
    fs::create_dir_all(&root)?;
    Ok(root)
}
pub(super) fn binding_path(state: &AppState, id: &str) -> Result<PathBuf> {
    uuid_id(id)?;
    Ok(bindings_root(state)?.join(format!("{id}.json")))
}
pub(super) fn save_binding(state: &AppState, binding: &TranscriptJob) -> Result<()> {
    surtitle_core::store::write_json_atomic(&binding_path(state, &binding.job_id)?, binding)
}
pub(super) fn job_bindings(state: &AppState) -> Result<Vec<TranscriptJob>> {
    let mut bindings = Vec::new();
    for entry in fs::read_dir(bindings_root(state)?)? {
        let path = entry?.path();
        if path.extension().is_some_and(|s| s == "json")
            && let Ok(binding) = read_json::<TranscriptJob>(&path)
        {
            bindings.push(binding);
        }
    }
    Ok(bindings)
}
pub(super) fn load_binding(state: &AppState, job_id: &str) -> Result<TranscriptJob> {
    let binding: TranscriptJob = read_json(&binding_path(state, job_id)?)?;
    ensure!(
        binding.job_id == job_id && state.ai.quote(job_id)?.digest == binding.job_digest,
        "transcript job binding changed"
    );
    Ok(binding)
}
pub(super) fn receipts(state: &AppState) -> Result<Vec<AudioPreparationReceipt>> {
    let directory = state.root.join("prepared");
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let root = directory.canonicalize()?;
    let mut out = Vec::new();
    for entry in fs::read_dir(&root)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() || entry.file_type()?.is_symlink() {
            continue;
        }
        let path = entry.path().join("receipt.json");
        if !path.is_file() {
            continue;
        }
        let loaded = (|| -> Result<AudioPreparationReceipt> {
            let receipt: AudioPreparationReceipt = read_json(&path)?;
            uuid_id(&receipt.id)?;
            ensure!(
                receipt.directory.canonicalize()? == entry.path().canonicalize()?
                    && receipt.directory.canonicalize()?.starts_with(&root),
                "preparation directory changed"
            );
            ensure!(
                receipt.source_sha256 == receipt.prepared_job.binding.source_sha256,
                "preparation source hash changed"
            );
            build_transcript_draft(&receipt, &[])?;
            for task in &receipt.prepared_job.requests {
                let audio =
                    audio_attachment(task).context("preparation contains a non-audio request")?;
                task.validate()?;
                ensure!(
                    audio.path.is_absolute()
                        && audio
                            .path
                            .parent()
                            .context("audio parent missing")?
                            .canonicalize()?
                            == receipt.directory.canonicalize()?,
                    "prepared audio escaped its owned directory"
                );
            }
            Ok(receipt)
        })();
        if let Ok(receipt) = loaded {
            out.push(receipt);
        }
    }
    out.sort_by_key(|receipt| std::cmp::Reverse(receipt.created_at_ms));
    Ok(out)
}
pub(super) fn load_receipt(state: &AppState, id: &str) -> Result<AudioPreparationReceipt> {
    uuid_id(id)?;
    let mut found = receipts(state)?
        .into_iter()
        .filter(|receipt| receipt.id == id)
        .collect::<Vec<_>>();
    ensure!(
        found.len() == 1,
        "audio preparation is missing or its ID is duplicated"
    );
    Ok(found.remove(0))
}
pub(super) fn audio_attachment(task: &RequestTask) -> Option<&AudioAttachment> {
    match task {
        RequestTask::AudioTranscription { audio, .. }
        | RequestTask::TranscribePreview { audio, .. } => Some(audio),
        _ => None,
    }
}
pub(super) fn repair_parent(receipt: &AudioPreparationReceipt) -> Result<Option<RepairParent>> {
    let path = receipt.directory.join("repair-parent.json");
    if path.exists() {
        Ok(Some(read_json(&path)?))
    } else {
        Ok(None)
    }
}
pub(super) fn receipt_for_job(
    state: &AppState,
    binding: &TranscriptJob,
) -> Result<AudioPreparationReceipt> {
    let mut receipt = load_receipt(state, &binding.preparation_id)?;
    ensure!(
        hash_file(&receipt.directory.join("receipt.json"))? == binding.receipt_sha256,
        "prepared receipt changed after the quote"
    );
    let plan = state.ai.prepared_job(&binding.job_id)?;
    ensure!(
        plan.requests.len() == receipt.prepared_job.requests.len()
            && plan
                .requests
                .iter()
                .zip(&receipt.prepared_job.requests)
                .all(|(left, right)| {
                    audio_attachment(left) == audio_attachment(right)
                        && match (left, right) {
                            (
                                RequestTask::AudioTranscription { language: a, .. }
                                | RequestTask::TranscribePreview { language: a, .. },
                                RequestTask::AudioTranscription { language: b, .. }
                                | RequestTask::TranscribePreview { language: b, .. },
                            ) => a == b,
                            _ => false,
                        }
                })
            && plan.binding.media_id == receipt.prepared_job.binding.media_id
            && plan.binding.source_sha256 == receipt.source_sha256
            && plan.binding.transcript_revision == receipt.prepared_job.binding.transcript_revision,
        "quoted audio differs from its local preparation"
    );
    receipt.prepared_job = plan;
    Ok(receipt)
}
pub(super) struct SourceIdentity {
    pub(super) path: String,
    pub(super) language: String,
}
pub(super) fn verify_source_identity(
    state: &AppState,
    receipt: &AudioPreparationReceipt,
    hash: bool,
) -> Result<SourceIdentity> {
    let db = lock(&state.db)?;
    let media = db.media(&receipt.prepared_job.binding.media_id)?;
    ensure!(
        surtitle_core::store::subtitle_revision(&db.list_segments(&media.id)?)?
            == receipt.prepared_job.binding.transcript_revision,
        "元字幕が変わっています。新しい準備を確認してください。"
    );
    for task in &receipt.prepared_job.requests {
        let language = match task {
            RequestTask::AudioTranscription { language, .. }
            | RequestTask::TranscribePreview { language, .. } => language,
            _ => anyhow::bail!("preparation task changed"),
        };
        ensure!(
            *language == media.learning_language,
            "学習言語が変わっています。"
        );
    }
    ensure!(
        media.audio_stream_index == receipt.audio_stream_index,
        "Selected audio track changed; review a new preparation"
    );
    drop(db);
    ensure!(
        Path::new(&media.path).canonicalize()? == receipt.source_path.canonicalize()?,
        "教材ファイルの場所が変わっています。"
    );
    if hash {
        ensure!(
            hash_file(&receipt.source_path)? == receipt.source_sha256,
            "教材ファイルの内容が変わっています。"
        );
    }
    Ok(SourceIdentity {
        path: media.path,
        language: media.learning_language,
    })
}
pub(super) fn verify_source(
    state: &AppState,
    receipt: &AudioPreparationReceipt,
    hash: bool,
) -> Result<()> {
    verify_source_identity(state, receipt, hash).map(|_| ())
}
pub(crate) fn verify_audio_plan(state: &AppState, plan: &PreparedJob) -> Result<()> {
    verify_audio_plan_inner(state, plan, false)
}
pub(crate) fn verify_audio_source_content(state: &AppState, plan: &PreparedJob) -> Result<()> {
    verify_audio_plan_inner(state, plan, true)
}
pub(super) fn verify_audio_plan_inner(
    state: &AppState,
    plan: &PreparedJob,
    hash: bool,
) -> Result<()> {
    let digest = plan.digest()?;
    let binding = job_bindings(state)?
        .into_iter()
        .find(|binding| binding.job_digest == digest)
        .context("audio quote has no registered preparation")?;
    let receipt = receipt_for_job(state, &binding)?;
    if let Some(parent) = &binding.repair_parent {
        validate_repair_parent(state, &receipt, parent)?;
    }
    verify_source(state, &receipt, hash)
}
