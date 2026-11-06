use super::*;
fn fixture() -> (tempfile::TempDir, AppState) {
    let directory = tempfile::tempdir().unwrap();
    let state = Services::open(directory.path().to_path_buf()).unwrap();
    seed_fixture_data(&state).unwrap();
    (directory, state)
}
fn job(state: &AppState, preparation: &str) -> String {
    job_bindings(state)
        .unwrap()
        .into_iter()
        .find(|b| b.preparation_id == preparation)
        .unwrap()
        .job_id
}
const COMPLETE: &str = "11111111-1111-4111-8111-111111111111";
const PENDING: &str = "22222222-2222-4222-8222-222222222222";
const REPAIR: &str = "33333333-3333-4333-8333-333333333333";

fn whole_openai_receipt(state: &AppState) -> AudioPreparationReceipt {
    let mut receipt = load_receipt(state, COMPLETE).unwrap();
    let mut media = lock(&state.db)
        .unwrap()
        .media(&receipt.prepared_job.binding.media_id)
        .unwrap();
    media.id = "whole-openai-file".into();
    media.duration_ms = 450_000;
    let source = state.root.join("media/whole-openai-file.wav");
    // Source metadata uses real PCM; encoded bytes are opaque identity fixtures,
    // as in the offline transport tests. Codec encoding is tested in surtitle-ai.
    let bytes = fixture_wav(450);
    fs::write(&source, &bytes).unwrap();
    media.path = source.to_string_lossy().into_owned();
    lock(&state.db).unwrap().put_media(&media).unwrap();
    state
        .preferences
        .update(|p| {
            p.settings.active_provider = surtitle_core::AiProvider::Openai;
            p.settings.ai_configuration_generation += 1;
            p.openai_credential_id = Some("unused-whole-file-fixture".into());
            p.settings.openai.credential_configured = true;
            let mut model = crate::application::models::preference_for(
                &crate::application::models::fixture_execution(),
                true,
            );
            model.model_id = "gpt-transcribe".into();
            model.price.as_mut().unwrap().audio_microusd_per_minute = Some(6000);
            p.settings
                .openai
                .ai_models
                .insert("transcription".into(), model);
            Ok(())
        })
        .unwrap();
    receipt.id = uuid::Uuid::new_v4().to_string();
    receipt.directory = state.root.join("prepared").join(&receipt.id);
    fs::create_dir(&receipt.directory).unwrap();
    receipt.directory = receipt.directory.canonicalize().unwrap();
    let path = receipt.directory.join("whole.flac");
    let mut encoded_fixture = bytes;
    encoded_fixture[..4].copy_from_slice(b"fLaC");
    fs::write(&path, encoded_fixture).unwrap();
    let audio = AudioAttachment::from_file_for_provider(
        path,
        0,
        media.duration_ms,
        surtitle_core::AiProvider::Openai,
    )
    .unwrap();
    assert!(audio.byte_len > 12 * 1024 * 1024 && audio.byte_len <= 25_000_000);
    receipt.source_path = source.canonicalize().unwrap();
    receipt.source_sha256 = hash_file(&receipt.source_path).unwrap();
    receipt.chunk_profile = Some(policy::OPENAI_AUDIO_PROFILE);
    receipt.preparation_context = Some(AudioPreparationContext {
        provider: surtitle_core::AiProvider::Openai,
        configuration_generation: state
            .preferences
            .read()
            .unwrap()
            .settings
            .ai_configuration_generation,
    });
    receipt.chunks = vec![AudioChunk {
        index: 0,
        sample_rate: 16_000,
        core_start_sample: 0,
        core_end_sample: media.duration_ms * 16,
        request_start_sample: 0,
        request_end_sample: media.duration_ms * 16,
        boundary: BoundaryKind::EndOfSelection,
        boundary_provenance: None,
    }];
    receipt.prepared_job = PreparedJob::local_audio_draft_for_provider(
        "Whole OpenAI file".into(),
        PreparationBinding {
            media_id: media.id.clone(),
            transcript_revision: surtitle_core::store::subtitle_revision(
                &lock(&state.db).unwrap().list_segments(&media.id).unwrap(),
            )
            .unwrap(),
            source_sha256: receipt.source_sha256.clone(),
            settings_sha256: crate::application::ai::bindings::settings_fingerprint(
                &state.preferences.read().unwrap().settings,
            )
            .unwrap(),
        },
        vec![RequestTask::TranscribePreview {
            language: "en".into(),
            audio,
        }],
        surtitle_core::AiProvider::Openai,
    )
    .unwrap();
    surtitle_core::store::write_json_atomic(&receipt.directory.join("receipt.json"), &receipt)
        .unwrap();
    receipt
}

fn whole_vertex_receipt(state: &AppState, mode: &str, duration_ms: u64) -> AudioPreparationReceipt {
    let mut receipt = whole_openai_receipt(state);
    state
        .preferences
        .update(|p| {
            p.settings.active_provider = surtitle_core::AiProvider::Vertex;
            p.settings.ai_configuration_generation += 1;
            p.settings.vertex_project = "fixture-project".into();
            p.credential_id = Some("unused-vertex-fixture".into());
            p.settings
                .ai_models
                .get_mut("transcription")
                .unwrap()
                .transcription_mode = mode.into();
            Ok(())
        })
        .unwrap();
    let mut media = lock(&state.db)
        .unwrap()
        .media(&receipt.prepared_job.binding.media_id)
        .unwrap();
    media.duration_ms = duration_ms;
    lock(&state.db).unwrap().put_media(&media).unwrap();
    let selected_policy = policy::vertex_policy(mode, false);
    let mut requests = receipt.prepared_job.requests.clone();
    let audio = match &mut requests[0] {
        RequestTask::TranscribePreview { audio, .. } => {
            audio.duration_ms = duration_ms;
            audio.clone()
        }
        _ => unreachable!(),
    };
    if mode != "transcribe" {
        requests[0] = RequestTask::AudioTranscription {
            language: "en".into(),
            audio,
        };
    }
    receipt.chunk_profile = Some(policy::profile(
        surtitle_core::AiProvider::Vertex,
        false,
        mode,
    ));
    receipt.preparation_context = Some(AudioPreparationContext {
        provider: surtitle_core::AiProvider::Vertex,
        configuration_generation: state
            .preferences
            .read()
            .unwrap()
            .settings
            .ai_configuration_generation,
    });
    receipt.chunks[0].core_end_sample = duration_ms * 16;
    receipt.chunks[0].request_end_sample = duration_ms * 16;
    receipt.prepared_job = PreparedJob::local_audio_draft_with_policy(
        "Whole Vertex file".into(),
        receipt.prepared_job.binding.clone(),
        requests,
        surtitle_core::AiProvider::Vertex,
        selected_policy,
    )
    .unwrap();
    surtitle_core::store::write_json_atomic(&receipt.directory.join("receipt.json"), &receipt)
        .unwrap();
    receipt
}

#[test]
fn whole_vertex_preparation_over_four_minutes_lists_quotes_and_reloads_with_frozen_policy() {
    let (_directory, state) = fixture();
    let receipt = whole_vertex_receipt(&state, "transcribe", 450_000);
    let path = receipt.directory.join("receipt.json");
    let original = fs::read(&path).unwrap();
    let listed = list_transcription_preparations(
        state.clone(),
        receipt.prepared_job.binding.media_id.clone(),
    )
    .unwrap();
    assert!(
        listed
            .iter()
            .find(|item| item.id == receipt.id)
            .unwrap()
            .compatible
    );
    let quote = serde_json::to_value(create_audio_quote(&state, &receipt.id).unwrap()).unwrap();
    assert_eq!(quote["requestCount"], 1);
    assert_eq!(quote["sendDurationMs"], 450_000);
    let binding = load_binding(&state, quote["id"].as_str().unwrap()).unwrap();
    let frozen = receipt_for_job(&state, &binding).unwrap();
    assert_eq!(
        frozen.prepared_job.execution.vertex_audio_policy,
        Some(VertexAudioPolicy::TranscribeFileV1)
    );
    assert!(load_draft(&state, &binding).is_ok());
    let mut selected =
        state.preferences.read().unwrap().settings.ai_models["transcription"].clone();
    selected.model_id = "another-model-with-same-transcription-mode".into();
    assert!(create_audio_quote_selected(&state, &receipt.id, Some(selected)).is_ok());
    assert_eq!(fs::read(path).unwrap(), original);
}

#[test]
fn whole_vertex_audio_understanding_requires_repreparation_for_transcribe_mode() {
    let (_directory, state) = fixture();
    let receipt = whole_vertex_receipt(&state, "subtitles", 901_000);
    let original = fs::read(receipt.directory.join("receipt.json")).unwrap();
    assert!(create_audio_quote(&state, &receipt.id).is_ok());
    let mut selected =
        state.preferences.read().unwrap().settings.ai_models["transcription"].clone();
    selected.transcription_mode = "transcribe".into();
    let error = create_audio_quote_selected(&state, &receipt.id, Some(selected))
        .err()
        .unwrap();
    assert!(error.to_string().contains("Prepare audio again"), "{error}");
    // Listing is independent of a dialog override; the selected-mode quote performs the final check.
    state
        .preferences
        .update(|p| {
            p.settings
                .ai_models
                .get_mut("transcription")
                .unwrap()
                .transcription_mode = "transcribe".into();
            Ok(())
        })
        .unwrap();
    assert!(
        list_transcription_preparations(
            state.clone(),
            receipt.prepared_job.binding.media_id.clone()
        )
        .unwrap()
        .iter()
        .find(|item| item.id == receipt.id)
        .unwrap()
        .compatible
    );
    assert_eq!(
        fs::read(receipt.directory.join("receipt.json")).unwrap(),
        original
    );
}

#[test]
fn legacy_vertex_preparation_remains_readable_but_cannot_create_a_new_quote() {
    let (_directory, state) = fixture();
    let receipt = load_receipt(&state, COMPLETE).unwrap();
    let path = receipt.directory.join("receipt.json");
    let original = fs::read(&path).unwrap();
    let listed = list_transcription_preparations(
        state.clone(),
        receipt.prepared_job.binding.media_id.clone(),
    )
    .unwrap();
    assert!(
        !listed
            .iter()
            .find(|item| item.id == COMPLETE)
            .unwrap()
            .compatible
    );
    assert!(
        create_audio_quote(&state, COMPLETE)
            .err()
            .unwrap()
            .to_string()
            .contains("Prepare audio again")
    );
    assert!(
        load_draft(
            &state,
            &load_binding(&state, &job(&state, COMPLETE)).unwrap()
        )
        .is_ok()
    );
    assert_eq!(fs::read(path).unwrap(), original);
}

#[test]
fn whole_openai_old_split_policy_requires_new_preparation_without_rewriting_receipt() {
    let (_directory, state) = fixture();
    let mut receipt = whole_openai_receipt(&state);
    receipt.chunk_profile = Some(AudioChunkProfile::OpenAiFile);
    let path = receipt.directory.join("receipt.json");
    surtitle_core::store::write_json_atomic(&path, &receipt).unwrap();
    let before = fs::read(&path).unwrap();
    let listed = list_transcription_preparations(
        state.clone(),
        receipt.prepared_job.binding.media_id.clone(),
    )
    .unwrap();
    let old = serde_json::to_value(listed.iter().find(|p| p.id == receipt.id).unwrap()).unwrap();
    assert_eq!(old["provider"], "openai");
    assert_eq!(old["compatible"], false);
    let Err(error) = create_audio_quote(&state, &receipt.id) else {
        panic!("old midpoint policy must require fresh preparation")
    };
    assert!(error.to_string().contains("Prepare audio again"), "{error}");
    assert_eq!(fs::read(path).unwrap(), before);
    assert!(load_receipt(&state, &receipt.id).is_ok());
}

#[test]
fn whole_openai_preparation_lists_quotes_and_keeps_original_provider_after_switch() {
    let (_directory, state) = fixture();
    let receipt = whole_openai_receipt(&state);
    let media_id = &receipt.prepared_job.binding.media_id;
    let listed = list_transcription_preparations(state.clone(), media_id.clone()).unwrap();
    let summary =
        serde_json::to_value(listed.iter().find(|p| p.id == receipt.id).unwrap()).unwrap();
    assert_eq!(summary["provider"], "openai");
    assert_eq!(summary["compatible"], true);
    let quote = serde_json::to_value(create_audio_quote(&state, &receipt.id).unwrap()).unwrap();
    assert_eq!(quote["provider"], "openai");
    assert_eq!(quote["requestCount"], 1);
    assert_eq!(quote["sendDurationMs"], 450_000);
    let job_id = quote["id"].as_str().unwrap();
    let plan = state.ai.prepared_job(job_id).unwrap();
    assert_eq!(
        plan.execution.response_mode,
        ResponseMode::AudioTranscriptions
    );
    assert_eq!(
        plan.estimates().unwrap()[0].estimated_max_microusd,
        Some(45_000)
    );
    let frozen = serde_json::to_value(&plan).unwrap();
    state
        .preferences
        .update(|p| {
            p.settings.active_provider = surtitle_core::AiProvider::Vertex;
            p.settings.ai_configuration_generation += 1;
            Ok(())
        })
        .unwrap();
    let listed = list_transcription_preparations(state.clone(), media_id.clone()).unwrap();
    let summary =
        serde_json::to_value(listed.iter().find(|p| p.id == receipt.id).unwrap()).unwrap();
    assert_eq!(summary["provider"], "openai");
    assert_eq!(summary["compatible"], false);
    let Err(error) = create_audio_quote(&state, &receipt.id) else {
        panic!("provider switch must require fresh preparation")
    };
    assert!(error.to_string().contains("Prepare audio again"), "{error}");
    assert_eq!(
        serde_json::to_value(state.ai.prepared_job(job_id).unwrap()).unwrap(),
        frozen
    );
    assert!(load_draft(&state, &load_binding(&state, job_id).unwrap()).is_ok());
}

#[test]
fn whole_openai_preparation_still_checks_media_bounds_and_both_file_identities() {
    use std::io::{Seek, SeekFrom, Write};
    let (_directory, state) = fixture();
    let receipt = whole_openai_receipt(&state);
    let media_id = &receipt.prepared_job.binding.media_id;
    let mut media = lock(&state.db).unwrap().media(media_id).unwrap();
    media.duration_ms -= 1;
    lock(&state.db).unwrap().put_media(&media).unwrap();
    assert!(create_audio_quote(&state, &receipt.id).is_err());
    media.duration_ms += 1;
    lock(&state.db).unwrap().put_media(&media).unwrap();
    let audio = audio_attachment(&receipt.prepared_job.requests[0]).unwrap();
    for path in [&audio.path, &receipt.source_path] {
        let mut file = fs::OpenOptions::new().write(true).open(path).unwrap();
        file.seek(SeekFrom::Start(100)).unwrap();
        file.write_all(&[1]).unwrap();
        file.sync_all().unwrap();
        assert!(
            create_audio_quote(&state, &receipt.id).is_err(),
            "changed file: {path:?}"
        );
        file.seek(SeekFrom::Start(100)).unwrap();
        file.write_all(&[0]).unwrap();
        file.sync_all().unwrap();
    }
    assert!(create_audio_quote(&state, &receipt.id).is_ok());
    let mut oversized = receipt.clone();
    if let RequestTask::TranscribePreview { audio, .. } = &mut oversized.prepared_job.requests[0] {
        audio.byte_len = 25_000_001;
    }
    surtitle_core::store::write_json_atomic(&receipt.directory.join("receipt.json"), &oversized)
        .unwrap();
    let listed = list_transcription_preparations(state.clone(), media_id.clone()).unwrap();
    assert!(!listed.iter().any(|p| p.id == receipt.id));
    assert!(create_audio_quote(&state, &receipt.id).is_err());
}

#[test]
fn stale_boundary_repair_receipts_do_not_prevent_a_fresh_preparation() {
    let (_directory, state) = fixture();
    let receipt = load_receipt(&state, REPAIR).unwrap();
    let parent = repair_parent(&receipt).unwrap().unwrap();
    state
        .preferences
        .update(|p| {
            p.settings.ai_configuration_generation += 1;
            Ok(())
        })
        .unwrap();
    assert!(reusable_repair_quote(&state, &parent).unwrap().is_none());
    assert!(state.ai.prepared_job(&job(&state, REPAIR)).is_ok());
}

#[test]
fn boundary_repair_quote_inherits_original_model_after_the_default_is_removed() {
    let (_directory, state) = fixture();
    let receipt = load_receipt(&state, REPAIR).unwrap();
    let parent = repair_parent(&receipt).unwrap().unwrap();
    let original = state.ai.prepared_job(&parent.job_id).unwrap();
    state
        .preferences
        .update(|p| {
            p.settings.ai_models.remove("transcription");
            Ok(())
        })
        .unwrap();
    let quote = serde_json::to_value(create_audio_quote(&state, REPAIR).unwrap()).unwrap();
    let plan = state
        .ai
        .prepared_job(quote["id"].as_str().unwrap())
        .unwrap();
    assert_eq!(plan.execution.model_id, original.execution.model_id);
    assert_eq!(plan.execution.vertex_audio_policy, None);
    assert!(audio_attachment(&plan.requests[0]).unwrap().duration_ms <= 30_000);
}

#[test]
fn new_quotes_do_not_reuse_vertex_audio_preparations_for_openai() {
    let (_directory, state) = fixture();
    let media_id = load_receipt(&state, COMPLETE)
        .unwrap()
        .prepared_job
        .binding
        .media_id;
    let old = list_transcription_preparations(state.clone(), media_id.clone()).unwrap();
    let vertex = serde_json::to_value(old.iter().find(|p| p.id == COMPLETE).unwrap()).unwrap();
    assert_eq!(vertex["provider"], "vertex");
    assert_eq!(vertex["compatible"], false);
    state
        .preferences
        .update(|p| {
            p.settings.active_provider = surtitle_core::AiProvider::Openai;
            p.settings.ai_configuration_generation += 1;
            Ok(())
        })
        .unwrap();
    let changed = list_transcription_preparations(state.clone(), media_id).unwrap();
    let old = serde_json::to_value(changed.iter().find(|p| p.id == COMPLETE).unwrap()).unwrap();
    assert_eq!(old["provider"], "vertex");
    assert_eq!(old["compatible"], false);
    let Err(error) = create_audio_quote(&state, COMPLETE) else {
        panic!("old preparation must require fresh audio");
    };
    assert!(error.to_string().contains("Prepare audio again"), "{error}");
    // History remains readable using its original frozen plan.
    assert!(
        load_draft(
            &state,
            &load_binding(&state, &job(&state, COMPLETE)).unwrap()
        )
        .is_ok()
    );
}

#[test]
fn startup_preserves_orphan_transcript_metadata_without_recovering_it() {
    let directory = tempfile::tempdir().unwrap();
    let binding = TranscriptJob {
        job_id: uuid::Uuid::new_v4().to_string(),
        job_digest: "orphan-digest".into(),
        preparation_id: uuid::Uuid::new_v4().to_string(),
        receipt_sha256: "orphan-receipt".into(),
        repair_parent: None,
        progressive: true,
        publication_detached: false,
    };
    let bindings = directory.path().join("transcript-jobs");
    fs::create_dir(&bindings).unwrap();
    let path = bindings.join(format!("{}.json", binding.job_id));
    let original = serde_json::to_vec(&binding).unwrap();
    fs::write(&path, &original).unwrap();

    let state = Services::open(directory.path().to_path_buf()).unwrap();
    assert!(job_bindings(&state).unwrap().is_empty());
    assert!(state.ai.list_jobs().unwrap().is_empty());
    assert!(state.ai.job_issue(&binding.job_id).unwrap().is_none());
    assert!(lock(&state.db).unwrap().list_media().unwrap().is_empty());
    assert_eq!(fs::read(&path).unwrap(), original);
    drop(state);
    assert!(Services::open(directory.path().to_path_buf()).is_ok());
    assert_eq!(fs::read(path).unwrap(), original);
}

#[test]
fn transcript_bindings_keep_ledger_jobs_and_report_ledger_query_failures() {
    let (directory, state) = fixture();
    let mut expected: Vec<_> = job_bindings(&state)
        .unwrap()
        .into_iter()
        .map(|binding| binding.job_id)
        .collect();
    expected.sort();
    assert!(!expected.is_empty());
    let mut orphan = load_binding(&state, &expected[0]).unwrap();
    orphan.job_id = uuid::Uuid::new_v4().to_string();
    save_binding(&state, &orphan).unwrap();
    let path = binding_path(&state, &orphan.job_id).unwrap();
    let original = fs::read(&path).unwrap();

    let mut actual: Vec<_> = job_bindings(&state)
        .unwrap()
        .into_iter()
        .map(|binding| binding.job_id)
        .collect();
    actual.sort();
    assert_eq!(actual, expected);
    assert_eq!(fs::read(path).unwrap(), original);

    let charges = rusqlite::Connection::open(directory.path().join("charges.sqlite")).unwrap();
    charges
        .execute("ALTER TABLE ai_jobs RENAME TO unavailable_jobs", [])
        .unwrap();
    assert!(job_bindings(&state).is_err());
}

#[test]
fn preparation_summaries_identify_the_recorded_audio_stream_not_current_selection() {
    let (_directory, state) = fixture();
    let receipt = load_receipt(&state, COMPLETE).unwrap();
    let media_id = receipt.prepared_job.binding.media_id;
    {
        let db = lock(&state.db).unwrap();
        let mut media = db.media(&media_id).unwrap();
        media.audio_stream_index = Some(99);
        db.put_media(&media).unwrap();
    }
    let summaries = list_transcription_preparations(state, media_id).unwrap();
    let summary = summaries
        .iter()
        .find(|summary| summary.id == COMPLETE)
        .unwrap();
    assert_eq!(summary.audio_stream_index, Some(0));
    assert_eq!(
        serde_json::to_value(summary).unwrap()["audioStreamIndex"],
        0
    );
}

fn automatic_job(state: &AppState) -> JobQuote {
    let mut receipt = load_receipt(state, COMPLETE).unwrap();
    receipt.prepared_job = receipt
        .prepared_job
        .with_apply_policy(TranscriptApplyPolicy::Auto)
        .unwrap();
    surtitle_core::store::write_json_atomic(&receipt.directory.join("receipt.json"), &receipt)
        .unwrap();
    let quote = state
        .ai
        .seed_transcript_review_fixture(receipt.prepared_job.clone(), false)
        .unwrap();
    register_fixture_job(state, &receipt, &quote, None).unwrap();
    let mut binding = load_binding(state, &quote.id).unwrap();
    binding.progressive = true;
    save_binding(state, &binding).unwrap();
    let range = build_transcript_draft(&receipt, &[]).unwrap();
    let mut db = lock(&state.db).unwrap();
    db.begin_transcript_publication(
        &quote.id,
        &quote.digest,
        &range.media_id,
        &range.source_revision,
        range.start_ms,
        range.end_ms,
    )
    .unwrap();
    db.activate_transcript_publication(&quote.id, &quote.digest)
        .unwrap();
    quote
}

#[test]
fn legacy_policy_stays_manual_and_auto_policy_is_frozen_in_the_digest() {
    let (_directory, state) = fixture();
    let plan = load_receipt(&state, COMPLETE).unwrap().prepared_job;
    let old_json = serde_json::to_value(&plan).unwrap();
    assert!(old_json.get("apply_policy").is_none());
    let legacy: PreparedJob = serde_json::from_value(old_json).unwrap();
    assert_eq!(legacy.apply_policy, TranscriptApplyPolicy::Manual);
    assert_eq!(legacy.digest().unwrap(), plan.digest().unwrap());
    assert!(!automatic::apply_completed(&state, &job(&state, COMPLETE)).unwrap());
    let auto = plan
        .clone()
        .with_apply_policy(TranscriptApplyPolicy::Auto)
        .unwrap();
    assert_ne!(auto.digest().unwrap(), plan.digest().unwrap());
    let execution = auto.execution.clone();
    assert_eq!(
        auto.with_execution(execution).unwrap().apply_policy,
        TranscriptApplyPolicy::Auto
    );
}

#[test]
fn completed_auto_transcript_recovers_once_with_portable_conflicts_and_preserves_later_edits() {
    let (directory, state) = fixture();
    let quote = automatic_job(&state);
    let connection = rusqlite::Connection::open(directory.path().join("charges.sqlite")).unwrap();
    let before = charge_snapshot(&connection);
    drop(state);
    let state = Services::open(directory.path().to_path_buf()).unwrap();
    let mut cues = lock(&state.db)
        .unwrap()
        .list_segments("e2e-transcript-review")
        .unwrap();
    assert!(!cues.is_empty());
    assert!(
        cues.iter()
            .all(|cue| surtitle_core::is_usable_subtitle_status(&cue.status)
                && cue.status != "confirmed")
    );
    let marked = cues
        .iter()
        .find(|cue| !cue.review_issues.is_empty())
        .unwrap();
    assert!(
        marked
            .review_issues
            .iter()
            .any(|issue| issue.alternatives.len() >= 2)
    );
    assert_eq!(
        lock(&state.db)
            .unwrap()
            .subtitle_versions("e2e-transcript-review")
            .unwrap()
            .len(),
        1
    );
    assert_eq!(before, charge_snapshot(&connection));
    let snapshot = serde_json::to_value(
        crate::application::ai::snapshot::get_app_snapshot(state.clone()).unwrap(),
    )
    .unwrap();
    let summary = snapshot["jobs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|j| j["id"] == quote.id)
        .unwrap();
    assert_eq!(summary["resultState"], "applied_with_warnings");
    assert_eq!(summary["needsAttention"], false);
    assert_eq!(summary["transcriptReview"], false);
    let archive = lock(&state.db).unwrap().archive().unwrap();
    assert!(
        archive
            .segments
            .iter()
            .any(|cue| !cue.review_issues.is_empty())
    );
    cues[0].text = "Later correction".into();
    cues[0].status = "confirmed".into();
    lock(&state.db).unwrap().edit_segment(&cues[0]).unwrap();
    drop(state);
    let state = Services::open(directory.path().to_path_buf()).unwrap();
    assert_eq!(
        lock(&state.db).unwrap().segment(&cues[0].id).unwrap().text,
        "Later correction"
    );
    assert!(!automatic::apply_completed(&state, &quote.id).unwrap());
    assert_eq!(before, charge_snapshot(&connection));
}

#[test]
fn automatic_application_preserves_subtitle_edits_without_losing_received_candidates() {
    let (_directory, state) = fixture();
    let quote = automatic_job(&state);
    let mut old = lock(&state.db)
        .unwrap()
        .segment("e2e-transcript-review-old")
        .unwrap();
    old.text = "Changed while transcription was running".into();
    lock(&state.db).unwrap().edit_segment(&old).unwrap();
    automatic::apply_completed(&state, &quote.id).unwrap();
    assert_eq!(
        lock(&state.db).unwrap().segment(&old.id).unwrap().text,
        old.text
    );
    assert!(state.ai.response(&quote.id, 0).unwrap().is_some());
    assert!(state.ai.response(&quote.id, 1).unwrap().is_some());
    assert!(
        lock(&state.db)
            .unwrap()
            .transcript_adopted(&quote.id, &quote.digest)
            .unwrap()
            .is_none()
    );
}

#[test]
fn restoring_pre_application_learning_data_does_not_reactivate_completed_auto_jobs() {
    let (directory, state) = fixture();
    let original = lock(&state.db).unwrap().archive().unwrap();
    let quote = automatic_job(&state);
    assert!(automatic::apply_completed(&state, &quote.id).unwrap());
    assert!(
        state
            .ai
            .transcript_application_recorded(&quote.id, &quote.digest)
            .unwrap()
    );
    lock(&state.db)
        .unwrap()
        .restore(&original, &directory.path().join("before-restore.sqlite"))
        .unwrap();
    assert!(
        lock(&state.db)
            .unwrap()
            .transcript_adopted(&quote.id, &quote.digest)
            .unwrap()
            .is_none()
    );
    drop(state);
    let state = Services::open(directory.path().to_path_buf()).unwrap();
    assert_eq!(
        lock(&state.db)
            .unwrap()
            .segment("e2e-transcript-review-old")
            .unwrap()
            .text,
        "Original subtitle"
    );
    assert!(!automatic::apply_completed(&state, &quote.id).unwrap());
}

#[test]
fn complete_silence_is_applied_without_fabricating_subtitles_or_review_gates() {
    let (directory, state) = fixture();
    let quote = automatic_job(&state);
    let connection = rusqlite::Connection::open(directory.path().join("charges.sqlite")).unwrap();
    connection
        .execute(
            "UPDATE ai_requests SET response_json=? WHERE job_id=?",
            rusqlite::params![
                serde_json::to_string(&ParsedOutput::Transcript { cues: vec![] }).unwrap(),
                &quote.id
            ],
        )
        .unwrap();
    assert!(automatic::apply_completed(&state, &quote.id).unwrap());
    let db = lock(&state.db).unwrap();
    assert!(
        db.list_segments("e2e-transcript-review")
            .unwrap()
            .is_empty()
    );
    let issues = db.list_transcript_issues("e2e-transcript-review").unwrap();
    assert!(issues.is_empty());
    let archive = db.archive().unwrap();
    assert!(archive.transcript_issues.is_empty());
    drop(db);
    let (_, draft, _) = load_draft(&state, &load_binding(&state, &quote.id).unwrap()).unwrap();
    assert!(draft.segments.is_empty());
}

#[test]
fn retry_after_committed_adoption_refreshes_the_player_before_clearing_the_failure() {
    let (_directory, state) = fixture();
    let quote = automatic_job(&state);
    state
        .playback
        .operation()
        .unwrap()
        .attach("e2e-transcript-review".into());
    let failure = automatic::apply_completed(&state, &quote.id).unwrap_err();
    assert!(
        !state
            .ai
            .transcript_application_recorded(&quote.id, &quote.digest)
            .unwrap()
    );
    crate::application::ai::jobs::record_failure(&state, &quote.id, "apply", &failure).unwrap();
    assert!(
        crate::application::ai::jobs::retry_ai_application(state.clone(), quote.id.clone())
            .is_err()
    );
    assert_eq!(
        state.ai.job_issue(&quote.id).unwrap().unwrap().code,
        "local_apply"
    );
    state.playback.shutdown().unwrap();
    crate::application::ai::jobs::retry_ai_application(state.clone(), quote.id.clone()).unwrap();
    assert!(state.ai.job_issue(&quote.id).unwrap().is_none());
    assert_eq!(
        lock(&state.db)
            .unwrap()
            .subtitle_versions("e2e-transcript-review")
            .unwrap()
            .len(),
        1
    );
}
fn authored_range() -> ManualTranscriptContent {
    ManualTranscriptContent::Subtitles {
        segments: vec![
            ReviewText {
                timing_precision: "cue".into(),
                word_anchors: vec![],
                start_ms: 3500,
                end_ms: 4500,
                text: "No, no.".into(),
            },
            ReviewText {
                timing_precision: "cue".into(),
                word_anchors: vec![],
                start_ms: 7500,
                end_ms: 7900,
                text: "Locally corrected.".into(),
            },
        ],
    }
}
fn charge_snapshot(conn: &rusqlite::Connection) -> Vec<String> {
    [
            "SELECT json_group_array(json_array(id,job_id,ordinal,state,reserve_microusd,charged_microusd,created_at_ms,dispatched_at_ms,settled_at_ms,usage_json,model_version)) FROM (SELECT * FROM ai_attempts ORDER BY id)",
            "SELECT json_group_array(json_array(job_id,ordinal,state,response_json,error_code)) FROM (SELECT * FROM ai_requests ORDER BY job_id,ordinal)",
            "SELECT json_group_array(json_array(id,digest,state,approved_at_ms,approval_json)) FROM (SELECT * FROM ai_jobs ORDER BY id)",
            "SELECT json_group_array(json_array(attempt_id,evidence_json,evidence_sha256)) FROM (SELECT * FROM ai_transcript_evidence ORDER BY attempt_id)",
        ].iter().map(|sql| conn.query_row(sql, [], |r| r.get(0)).unwrap()).collect()
}
#[test]
fn manual_missing_range_is_versioned_reversible_persistent_and_locally_adoptable() {
    let (directory, state) = fixture();
    let pending = job(&state, PENDING);
    let initial = view(&state, &pending).unwrap();
    assert_eq!(initial.range_edits.len(), 2);
    assert_eq!(initial.range_edits[1].version, 0);
    let charges = rusqlite::Connection::open(directory.path().join("charges.sqlite")).unwrap();
    let snapshot = charge_snapshot(&charges);
    let saved = save_manual_range(
        &state,
        &pending,
        &initial.draft.digest,
        1,
        0,
        authored_range(),
    )
    .unwrap();
    assert!(
        saved.can_apply,
        "{:?}; conflicts={:?}",
        saved.blocked_reason, saved.draft.conflicts
    );
    assert_eq!(saved.results[1].state, TranscriptResultState::Pending);
    assert_eq!(saved.draft.chunks[1].source, TranscriptRangeSource::Manual);
    assert!(saved.draft.chunks[1].original_segments.is_empty());
    assert_eq!(saved.range_edits[1].version, 1);
    assert!(
        save_manual_range(
            &state,
            &pending,
            &initial.draft.digest,
            1,
            1,
            authored_range()
        )
        .is_err()
    );
    assert!(
        save_manual_range(
            &state,
            &pending,
            &saved.draft.digest,
            1,
            0,
            authored_range()
        )
        .is_err()
    );
    let id = saved.range_edits[1].selected_revision_id.clone().unwrap();
    let original = select_range_source(
        &state,
        &pending,
        &saved.draft.digest,
        1,
        1,
        TranscriptRangeSelection::Original,
    )
    .unwrap();
    assert!(!original.can_apply);
    assert_eq!(
        original.draft.chunks[1].source,
        TranscriptRangeSource::Unresolved
    );
    let selected = select_range_source(
        &state,
        &pending,
        &original.draft.digest,
        1,
        2,
        TranscriptRangeSelection::Manual { revision_id: id },
    )
    .unwrap();
    assert_eq!(selected.range_edits[1].version, 3);
    assert!(selected.can_apply);
    assert_ne!(
        selected.draft.digest, saved.draft.digest,
        "Returning to an old revision must not revive an old adoption digest"
    );
    assert!(apply_review(&state, &pending, &saved.draft.digest).is_err());
    assert_eq!(charge_snapshot(&charges), snapshot);
    drop(state);
    let state = Services::open(directory.path().to_path_buf()).unwrap();
    let reloaded = view(&state, &pending).unwrap();
    assert_eq!(reloaded.draft, selected.draft);
    assert!(
        apply_review(&state, &pending, &reloaded.draft.digest)
            .unwrap()
            .applied
    );
    assert_eq!(state.ai.quote(&pending).unwrap().completed_requests, 1);
    assert_eq!(state.ai.quote(&pending).unwrap().state, "needs_review");
    assert_eq!(charge_snapshot(&charges), snapshot);
    assert!(
        save_manual_range(
            &state,
            &pending,
            &reloaded.draft.digest,
            1,
            3,
            authored_range()
        )
        .is_err()
    );
}
#[test]
fn invalid_unknown_range_can_be_edited_and_adopted_without_settling_or_refunding() {
    let (directory, state) = fixture();
    let pending = job(&state, PENDING);
    let charges = rusqlite::Connection::open(directory.path().join("charges.sqlite")).unwrap();
    let attempt = uuid::Uuid::new_v4().to_string();
    charges.execute("INSERT INTO ai_attempts(id,job_id,ordinal,state,reserve_microusd,created_at_ms,dispatched_at_ms) VALUES(?,?,1,'unknown',12345,1,2)", rusqlite::params![attempt,pending]).unwrap();
    charges.execute("UPDATE ai_requests SET state='unknown',error_code='invalid_response' WHERE job_id=? AND ordinal=1", [&pending]).unwrap();
    let binding = load_binding(&state, &pending).unwrap();
    let receipt = receipt_for_job(&state, &binding).unwrap();
    let range = range_binding(&binding, &receipt, 1).unwrap();
    let evidence = TranscriptEvidence {
        attempt_id: attempt.clone(),
        job_id: pending.clone(),
        ordinal: 1,
        input_sha256: range.input_sha256,
        request_sha256: range.request_sha256,
        task_sha256: sha256_bytes(&serde_json::to_vec(&receipt.prepared_job.requests[1]).unwrap()),
        model_id: receipt.prepared_job.execution.model_id.clone(),
        parser_revision: "transcript-response-v1".into(),
        response: serde_json::json!({"candidates":[{"finishReason":"STOP","content":{"parts":[{"audioTranscription":{"text":"Authored invalid fixture.","words":[{"word":"Authored","startOffset":"2s","endOffset":"1s"}]}}]}}]}),
        complete: true,
        state: TranscriptResultState::Invalid,
        reason: Some(TranscriptResultReason::ReversedTime),
    };
    let evidence_json = serde_json::to_string(&evidence).unwrap();
    charges
        .execute(
            "INSERT INTO ai_transcript_evidence VALUES(?,?,?)",
            rusqlite::params![
                attempt,
                evidence_json,
                sha256_bytes(evidence_json.as_bytes())
            ],
        )
        .unwrap();
    let before = charge_snapshot(&charges);
    let original = view(&state, &pending).unwrap();
    assert_eq!(original.results[1].state, TranscriptResultState::Invalid);
    assert_eq!(
        original.results[1].reason,
        Some(TranscriptResultReason::SettlementPending)
    );
    assert!(original.manual_editing_blocked_reason.is_none());
    let provider = serde_json::to_value(&original.results).unwrap();
    let saved = save_manual_range(
        &state,
        &pending,
        &original.draft.digest,
        1,
        0,
        authored_range(),
    )
    .unwrap();
    assert_eq!(serde_json::to_value(&saved.results).unwrap(), provider);
    assert!(
        saved.can_apply,
        "{:?}; conflicts={:?}",
        saved.blocked_reason, saved.draft.conflicts
    );
    assert!(
        apply_review(&state, &pending, &saved.draft.digest)
            .unwrap()
            .applied
    );
    assert_eq!(charge_snapshot(&charges), before);
    assert_eq!(
        state
            .ai
            .summary()
            .unwrap()
            .unknown_attempts
            .iter()
            .find(|a| a.id == attempt)
            .unwrap()
            .held_or_charged_microusd,
        Some(12345)
    );
}
#[test]
fn manual_edits_require_pause_and_inflight_completion_but_survive_later_results() {
    let (directory, state) = fixture();
    let pending = job(&state, PENDING);
    let charges = rusqlite::Connection::open(directory.path().join("charges.sqlite")).unwrap();
    charges
        .execute("UPDATE ai_jobs SET state='approved' WHERE id=?", [&pending])
        .unwrap();
    let original = view(&state, &pending).unwrap();
    assert!(original.manual_editing_blocked_reason.is_some());
    assert!(
        save_manual_range(
            &state,
            &pending,
            &original.draft.digest,
            1,
            0,
            authored_range()
        )
        .is_err()
    );
    state.ai.pause(&pending).unwrap();
    let attempt = uuid::Uuid::new_v4().to_string();
    charges.execute("INSERT INTO ai_attempts(id,job_id,ordinal,state,reserve_microusd,created_at_ms,dispatched_at_ms) VALUES(?,?,1,'reserved',999,1,2)", rusqlite::params![attempt,pending]).unwrap();
    assert!(
        save_manual_range(
            &state,
            &pending,
            &original.draft.digest,
            1,
            0,
            authored_range()
        )
        .is_err()
    );
    state.ai.mark_unknown(&attempt).unwrap();
    let saved = save_manual_range(
        &state,
        &pending,
        &original.draft.digest,
        1,
        0,
        authored_range(),
    )
    .unwrap();
    assert!(
        saved.can_apply,
        "{:?}; conflicts={:?}",
        saved.blocked_reason, saved.draft.conflicts
    );
    // Simulate a separately recorded late result without changing the local
    // selection. No production recovery path automatically performs this.
    let output = serde_json::to_string(&ParsedOutput::Transcript {
        cues: vec![GeneratedCue {
            timing_precision: "cue".into(),
            word_anchors: vec![],
            start_ms: 6000,
            end_ms: 6500,
            text: "Later provider result.".into(),
        }],
    })
    .unwrap();
    charges
        .execute(
            "UPDATE ai_requests SET state='completed',response_json=? WHERE job_id=? AND ordinal=1",
            rusqlite::params![output, pending],
        )
        .unwrap();
    let after_provider = charge_snapshot(&charges);
    let updated = view(&state, &pending).unwrap();
    assert_eq!(
        updated.range_edits[1].selected_revision_id,
        saved.range_edits[1].selected_revision_id
    );
    assert!(
        updated
            .draft
            .segments
            .iter()
            .any(|s| s.text == "Locally corrected.")
    );
    assert_eq!(
        updated.draft.chunks[1].original_segments[0].text,
        "Later provider result."
    );
    assert_ne!(updated.draft.digest, saved.draft.digest);
    assert_eq!(charge_snapshot(&charges), after_provider);
}

#[test]
fn openai_manual_editing_waits_for_its_inflight_request_after_pause() {
    let (_directory, state) = fixture();
    let original = state.ai.prepared_job(&job(&state, PENDING)).unwrap();
    let mut execution = original.execution.clone();
    execution.provider = surtitle_core::AiProvider::Openai;
    execution.response_mode = ResponseMode::AudioTranscriptions;
    execution.price = None;
    let mut requests = original.requests;
    for task in &mut requests {
        if let RequestTask::TranscribePreview { audio, .. }
        | RequestTask::AudioTranscription { audio, .. } = task
        {
            // This test stops at reservation; it never decodes or uploads fixture bytes.
            audio.mime_type = "audio/flac".into();
        }
    }
    let plan = PreparedJob::new(
        "OpenAI range editing".into(),
        "openai".into(),
        "offline-key".into(),
        original.binding,
        requests,
        execution,
    )
    .unwrap();
    let quote = state.ai.prepare(plan).unwrap();
    state
        .ai
        .approve_scope(&quote.id, &quote.digest, true, true)
        .unwrap();
    let attempt = state.ai.reserve_next(&quote.id).unwrap().unwrap();
    state.ai.pause(&quote.id).unwrap();
    let binding = TranscriptJob {
        job_id: quote.id.clone(),
        job_digest: quote.digest,
        preparation_id: PENDING.into(),
        receipt_sha256: "unused".into(),
        repair_parent: None,
        progressive: false,
        publication_detached: false,
    };
    assert!(super::ranges::manual_editing_allowed(&state, &binding).is_err());
    state.ai.mark_unknown(&attempt.attempt_id).unwrap();
    super::ranges::manual_editing_allowed(&state, &binding).unwrap();
}
#[test]
fn valid_empty_provider_results_are_locally_usable_without_extra_confirmation() {
    let (directory, state) = fixture();
    let pending = job(&state, PENDING);
    let charges = rusqlite::Connection::open(directory.path().join("charges.sqlite")).unwrap();
    let output = serde_json::to_string(&ParsedOutput::Transcript { cues: vec![] }).unwrap();
    charges
        .execute(
            "UPDATE ai_requests SET state='completed',response_json=? WHERE job_id=?",
            rusqlite::params![output, pending],
        )
        .unwrap();
    let before = charge_snapshot(&charges);
    let original = view(&state, &pending).unwrap();
    assert!(original.draft.can_adopt);
    assert!(original.can_apply, "{:?}", original.blocked_reason);
    assert!(
        apply_review(&state, &pending, &original.draft.digest)
            .unwrap()
            .applied
    );
    assert_eq!(charge_snapshot(&charges), before);
}
#[test]
fn manual_empty_requires_explicit_silence_and_rejects_stale_source() {
    let (_directory, state) = fixture();
    let pending = job(&state, PENDING);
    let original = view(&state, &pending).unwrap();
    assert!(
        save_manual_range(
            &state,
            &pending,
            &original.draft.digest,
            1,
            0,
            ManualTranscriptContent::Subtitles { segments: vec![] }
        )
        .is_err()
    );
    assert_eq!(view(&state, &pending).unwrap().range_edits[1].version, 0);
    let silent = save_manual_range(
        &state,
        &pending,
        &original.draft.digest,
        1,
        0,
        ManualTranscriptContent::ConfirmedNoSpeech,
    )
    .unwrap();
    assert_eq!(
        silent.range_edits[1]
            .selected_revision
            .as_ref()
            .unwrap()
            .content,
        ManualTranscriptContent::ConfirmedNoSpeech
    );
    let mut segment = lock(&state.db)
        .unwrap()
        .list_segments(&silent.media_id)
        .unwrap()
        .remove(0);
    segment.text = "Independently edited original".into();
    lock(&state.db).unwrap().edit_segment(&segment).unwrap();
    assert!(
        save_manual_range(
            &state,
            &pending,
            &silent.draft.digest,
            1,
            1,
            authored_range()
        )
        .is_err()
    );
    assert!(apply_review(&state, &pending, &silent.draft.digest).is_err());
}
#[test]
fn vad_warning_acknowledgement_survives_restart_and_requires_current_digest_for_adoption() {
    let (directory, state) = fixture();
    let complete = job(&state, COMPLETE);
    // Add authored VAD evidence to this private fixture and rebind its receipt
    // before any decisions exist. No model call or ledger mutation is made.
    let mut receipt = load_receipt(&state, COMPLETE).unwrap();
    receipt.vad_no_speech_ordinals = vec![0];
    surtitle_core::store::write_json_atomic(&receipt.directory.join("receipt.json"), &receipt)
        .unwrap();
    register_fixture_job(&state, &receipt, &state.ai.quote(&complete).unwrap(), None).unwrap();
    let original = view(&state, &complete).unwrap();
    assert_eq!(original.draft.warnings.len(), 1);
    assert!(original.can_apply);
    let warning_id = original.draft.warnings[0].id.clone();
    assert!(!original.draft.warnings[0].acknowledged);
    assert!(acknowledge_review_warning(&state, &complete, "stale", &warning_id).is_err());
    assert_eq!(view(&state, &complete).unwrap().draft, original.draft);

    let boundary = resolve_review(
        &state,
        &complete,
        &original.draft.digest,
        &original.draft.conflicts[0].id,
        BoundaryChoice::Left,
    )
    .unwrap();
    assert!(boundary.can_apply);
    assert!(!boundary.draft.warnings[0].acknowledged);
    assert!(
        acknowledge_review_warning(&state, &complete, &original.draft.digest, &warning_id).is_err()
    );
    let checked =
        acknowledge_review_warning(&state, &complete, &boundary.draft.digest, &warning_id).unwrap();
    assert!(checked.can_apply && checked.draft.warnings[0].acknowledged);
    assert_eq!(checked.draft.chunks, original.draft.chunks);
    let acknowledged_digest = checked.draft.digest.clone();
    assert_ne!(acknowledged_digest, boundary.draft.digest);

    drop(state);
    let state = Services::open(directory.path().to_path_buf()).unwrap();
    let reloaded = view(&state, &complete).unwrap();
    assert_eq!(reloaded.draft, checked.draft);
    assert!(reloaded.can_apply);
    assert!(
        acknowledge_review_warning(&state, &complete, &boundary.draft.digest, &warning_id).is_err()
    );
    assert!(apply_review(&state, &complete, &boundary.draft.digest).is_err());
    assert!(
        apply_review(&state, &complete, &acknowledged_digest)
            .unwrap()
            .applied
    );
    assert!(
        acknowledge_review_warning(&state, &complete, &acknowledged_digest, &warning_id).is_err()
    );

    drop(state);
    let state = Services::open(directory.path().to_path_buf()).unwrap();
    let adopted = view(&state, &complete).unwrap();
    assert!(adopted.applied && !adopted.can_apply);
    assert_eq!(adopted.draft, checked.draft);
    assert_eq!(
        state.ai.summary().unwrap().monthly_actual_charged_microusd,
        0
    );
    assert_eq!(state.ai.quote(&complete).unwrap().completed_requests, 2);
}
#[test]
fn local_review_requires_all_chunks_but_optional_resolution_preserves_edits_after_restart() {
    let (directory, state) = fixture();
    let complete = job(&state, COMPLETE);
    let pending = job(&state, PENDING);
    let original = view(&state, &complete).unwrap();
    assert!(original.can_apply);
    assert_eq!(original.draft.conflicts.len(), 1);
    let partial = view(&state, &pending).unwrap();
    assert!(!partial.can_apply);
    assert_eq!(partial.draft.pending_ranges.len(), 1);
    assert!(apply_review(&state, &pending, &partial.draft.digest).is_err());
    let reviewed = resolve_review(
        &state,
        &complete,
        &original.draft.digest,
        &original.draft.conflicts[0].id,
        BoundaryChoice::Left,
    )
    .unwrap();
    assert!(reviewed.can_apply);
    assert_eq!(reviewed.draft.chunks, original.draft.chunks);
    let digest = reviewed.draft.digest.clone();
    drop(state);
    let state = Services::open(directory.path().to_path_buf()).unwrap();
    assert_eq!(view(&state, &complete).unwrap().draft.digest, digest);
    assert!(apply_review(&state, &complete, &digest).unwrap().applied);
    let mut segment = lock(&state.db)
        .unwrap()
        .list_segments("e2e-transcript-review")
        .unwrap()
        .remove(0);
    segment.text = "A later manual correction.".into();
    segment.translation = Some("後の訳".into());
    lock(&state.db).unwrap().edit_segment(&segment).unwrap();
    drop(state);
    let state = Services::open(directory.path().to_path_buf()).unwrap();
    assert!(apply_review(&state, &complete, &digest).unwrap().applied);
    assert_eq!(
        lock(&state.db).unwrap().segment(&segment.id).unwrap().text,
        "A later manual correction."
    );
    assert_eq!(
        state.ai.summary().unwrap().monthly_actual_charged_microusd,
        0
    );
}
#[test]
fn concurrent_decisions_using_one_digest_have_exactly_one_winner() {
    let (_directory, state) = fixture();
    let complete = job(&state, COMPLETE);
    let original = view(&state, &complete).unwrap();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let handles = [BoundaryChoice::Left, BoundaryChoice::Right]
        .into_iter()
        .map(|choice| {
            let state = state.clone();
            let id = complete.clone();
            let digest = original.draft.digest.clone();
            let boundary = original.draft.conflicts[0].id.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                resolve_review(&state, &id, &digest, &boundary, choice).is_ok()
            })
        })
        .collect::<Vec<_>>();
    assert_eq!(
        handles
            .into_iter()
            .filter(|handle| handle.thread().id() != std::thread::current().id())
            .map(|handle| u32::from(handle.join().unwrap()))
            .sum::<u32>(),
        1
    );
}
#[test]
fn repair_quote_is_separate_blocked_and_cannot_replace_parent_or_survive_changed_decisions() {
    let (_directory, state) = fixture();
    let complete = job(&state, COMPLETE);
    let repair = job(&state, REPAIR);
    let quoted = serde_json::to_value(create_audio_quote(&state, REPAIR).unwrap()).unwrap();
    assert_eq!(quoted["canApprove"], false);
    assert!(quoted["maximumUsd"].as_f64().unwrap() > 0.0);
    assert_eq!(state.ai.quote(&repair).unwrap().state, "prepared");
    assert!(
        apply_review(
            &state,
            &repair,
            &view(&state, &repair).unwrap().draft.digest
        )
        .is_err()
    );
    let original = view(&state, &complete).unwrap();
    resolve_review(
        &state,
        &complete,
        &original.draft.digest,
        &original.draft.conflicts[0].id,
        BoundaryChoice::Left,
    )
    .unwrap();
    assert!(create_audio_quote(&state, REPAIR).is_err());
    assert!(verify_audio_plan(&state, &state.ai.prepared_job(&repair).unwrap()).is_err());
    assert_eq!(
        state.ai.summary().unwrap().monthly_actual_charged_microusd,
        0
    );
}
#[test]
fn unavailable_unrelated_preparation_and_deleted_audio_do_not_hide_received_results() {
    let (_directory, state) = fixture();
    let complete = job(&state, COMPLETE);
    let directory = state.root.join("prepared").join("broken-unrelated");
    fs::create_dir(&directory).unwrap();
    fs::write(directory.join("receipt.json"), b"broken json").unwrap();
    let receipt = load_receipt(&state, COMPLETE).unwrap();
    fs::remove_file(
        &audio_attachment(&receipt.prepared_job.requests[0])
            .unwrap()
            .path,
    )
    .unwrap();
    assert_eq!(
        view(&state, &complete).unwrap().draft.chunks[0].status,
        "received"
    );
    assert!(create_audio_quote(&state, COMPLETE).is_err());
}
#[test]
fn credential_rotation_requotes_the_same_immutable_audio_without_regeneration() {
    let (_directory, state) = fixture();
    let receipt = whole_vertex_receipt(&state, "transcribe", 450_000);
    let previous_quote =
        serde_json::to_value(create_audio_quote(&state, &receipt.id).unwrap()).unwrap();
    let previous = previous_quote["id"].as_str().unwrap();
    {
        let mut preferences = state.preferences.test_value().unwrap();
        preferences.settings.vertex_project = "another-project".into();
        preferences.credential_id = Some("c".repeat(64));
    }
    let quote = serde_json::to_value(create_audio_quote(&state, &receipt.id).unwrap()).unwrap();
    let new_id = quote["id"].as_str().unwrap();
    assert_ne!(new_id, previous);
    assert_eq!(
        state.ai.prepared_job(new_id).unwrap().requests,
        state.ai.prepared_job(previous).unwrap().requests
    );
    assert_eq!(quote["canApprove"], false);
    assert_eq!(state.ai.quote(new_id).unwrap().completed_requests, 0);
}
