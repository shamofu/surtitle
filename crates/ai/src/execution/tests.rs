use super::*;
use crate::{sha256_bytes, AiStore, AudioAttachment, PreparationBinding, PreparedJob, SourceCue};

fn task() -> RequestTask {
    RequestTask::Translation {
        target_language: "ja".into(),
        cues: vec![SourceCue {
            id: "cue-1".into(),
            start_ms: 0,
            end_ms: 1000,
            text: "Hello.".into(),
        }],
    }
}
fn binding() -> PreparationBinding {
    PreparationBinding {
        media_id: "media".into(),
        transcript_revision: "one".into(),
        source_sha256: sha256_bytes(b"source"),
        settings_sha256: sha256_bytes(b"settings"),
    }
}
fn config() -> ExecutionConfig {
    ExecutionConfig {
        provider: crate::AiProvider::Vertex,
        model_id: "gemini-unlisted-future-preview".into(),
        location: "asia-northeast1".into(),
        max_output_tokens: 2048,
        thinking: ThinkingConfig::Omit,
        price: None,
        response_mode: ResponseMode::GenerateContent,
        openai_audio_chunking_strategy: None,
        openai_audio_language_hint_format: None,
        openai_audio_prompt: None,
        vertex_audio_policy: None,
    }
}

#[test]
fn vertex_whole_audio_policy_is_frozen_and_admits_long_attachments() {
    let legacy = openai_audio_job();
    let mut task = legacy.requests[0].clone();
    let RequestTask::AudioTranscription { audio, .. } = &mut task else {
        panic!()
    };
    audio.duration_ms = 360_001;
    audio.byte_len = 13_000_000;
    assert!(task.validate().is_err());
    let mut value = serde_json::to_value(config()).unwrap();
    value["vertex_audio_policy"] = json!("audio_understanding_file_v1");
    let execution: ExecutionConfig = serde_json::from_value(value).unwrap();
    let plan = PreparedJob::new(
        "Whole".into(),
        "fixture-project".into(),
        "credential".into(),
        binding(),
        vec![task],
        execution,
    )
    .unwrap();
    assert_eq!(plan.estimates().unwrap()[0].audio_duration_ms, 360_001);
    let encoded = serde_json::to_vec(&plan).unwrap();
    let restored: PreparedJob = serde_json::from_slice(&encoded).unwrap();
    restored.validate().unwrap();
    assert_eq!(serde_json::to_vec(&restored).unwrap(), encoded);
    assert_eq!(restored.digest().unwrap(), plan.digest().unwrap());
    let draft = PreparedJob::local_audio_draft_with_policy(
        "Whole".into(),
        binding(),
        plan.requests.clone(),
        AiProvider::Vertex,
        plan.execution.vertex_audio_policy,
    )
    .unwrap();
    assert_eq!(
        draft.execution.vertex_audio_policy,
        plan.execution.vertex_audio_policy
    );
    assert!(draft.validate().is_err());
    assert!(restored.with_execution(config()).is_err());
}

fn vertex_audio_task(policy: VertexAudioPolicy, byte_len: u64, duration_ms: u64) -> RequestTask {
    let audio = AudioAttachment {
        path: "frozen-audio.flac".into(),
        sha256: sha256_bytes(b"audio"),
        byte_len,
        mime_type: "audio/flac".into(),
        source_start_ms: 0,
        duration_ms,
    };
    match policy {
        VertexAudioPolicy::TranscribeFileV1 => RequestTask::TranscribePreview {
            language: "en".into(),
            audio,
        },
        VertexAudioPolicy::AudioUnderstandingFileV1 => RequestTask::AudioTranscription {
            language: "en".into(),
            audio,
        },
    }
}

#[test]
fn vertex_file_policy_enforces_duration_bytes_provider_and_task_before_quote() {
    for policy in [
        VertexAudioPolicy::TranscribeFileV1,
        VertexAudioPolicy::AudioUnderstandingFileV1,
    ] {
        let limits = policy.limits();
        let mut execution = config();
        execution.vertex_audio_policy = Some(policy);
        let audio = vertex_audio_task(policy, limits.maximum_bytes, limits.maximum_duration_ms);
        audio.validate_with_execution(&execution).unwrap();
        assert!(audio.validate().is_err());
        for invalid in [
            vertex_audio_task(policy, limits.maximum_bytes + 1, limits.maximum_duration_ms),
            vertex_audio_task(policy, limits.maximum_bytes, limits.maximum_duration_ms + 1),
            task(),
            vertex_audio_task(
                match policy {
                    VertexAudioPolicy::TranscribeFileV1 => {
                        VertexAudioPolicy::AudioUnderstandingFileV1
                    }
                    VertexAudioPolicy::AudioUnderstandingFileV1 => {
                        VertexAudioPolicy::TranscribeFileV1
                    }
                },
                5,
                1000,
            ),
        ] {
            assert!(PreparedJob::new(
                "Rejected".into(),
                "fixture-project".into(),
                "credential".into(),
                binding(),
                vec![invalid],
                execution.clone()
            )
            .is_err());
        }
        execution.provider = AiProvider::Openai;
        execution.location = "global".into();
        execution.response_mode = ResponseMode::AudioTranscriptions;
        assert!(execution.validate().is_err());
        assert!(audio.validate_with_execution(&execution).is_err());
    }
}

#[test]
fn vertex_file_policy_accounts_for_the_actual_frozen_json_envelope() {
    let policy = VertexAudioPolicy::AudioUnderstandingFileV1;
    let mut execution = config();
    execution.vertex_audio_policy = Some(policy);
    let plan = PreparedJob::new(
        "Envelope".into(),
        "fixture-project".into(),
        "credential".into(),
        binding(),
        vec![vertex_audio_task(
            policy,
            policy.limits().maximum_bytes,
            360_000,
        )],
        execution,
    )
    .unwrap();
    let mut value = serde_json::to_value(plan).unwrap();
    let body = &mut value["frozen_requests"][0];
    body["systemInstruction"]["parts"][0]["text"] = json!("");
    let envelope_bytes = serde_json::to_vec(body).unwrap().len() as u64;
    let pad = VertexAudioPolicy::REQUEST_ENVELOPE_RESERVE_BYTES - envelope_bytes;
    body["systemInstruction"]["parts"][0]["text"] = json!("x".repeat(pad as usize));
    let at_limit: PreparedJob = serde_json::from_value(value.clone()).unwrap();
    at_limit.validate().unwrap();
    value["frozen_requests"][0]["systemInstruction"]["parts"][0]["text"] =
        json!("x".repeat(pad as usize + 1));
    let oversized: PreparedJob = serde_json::from_value(value).unwrap();
    assert!(matches!(oversized.validate(), Err(AiError::Invalid(_))));
    let directory = tempfile::tempdir().unwrap();
    let store = AiStore::open(directory.path().join("envelope.sqlite")).unwrap();
    assert!(store.prepare(oversized).is_err());
}

#[test]
fn response_mode_preserves_legacy_digests_and_freezes_new_endpoint() {
    let legacy = job();
    let old_json = serde_json::to_string(&legacy).unwrap();
    assert!(!old_json.contains("response_mode"));
    assert!(!old_json.contains("vertex_audio_policy"));
    let restored: PreparedJob = serde_json::from_str(&old_json).unwrap();
    assert_eq!(restored.execution.vertex_audio_policy, None);
    assert_eq!(serde_json::to_string(&restored).unwrap(), old_json);
    assert_eq!(restored.digest().unwrap(), legacy.digest().unwrap());
    assert!(restored
        .execution
        .endpoint("fixture-project")
        .unwrap()
        .ends_with(":generateContent"));
    let mut streamed_config = config();
    streamed_config.response_mode = ResponseMode::StreamGenerateContent;
    let streamed = legacy.clone().with_execution(streamed_config).unwrap();
    assert_eq!(
        legacy.request_body_snapshot(0).unwrap(),
        streamed.request_body_snapshot(0).unwrap()
    );
    assert_ne!(legacy.digest().unwrap(), streamed.digest().unwrap());
    assert!(streamed
        .execution
        .endpoint("fixture-project")
        .unwrap()
        .ends_with(":streamGenerateContent?alt=sse"));
}
fn job() -> PreparedJob {
    PreparedJob::new(
        "Test".into(),
        "fixture-project".into(),
        "unused-key".into(),
        binding(),
        vec![task()],
        config(),
    )
    .unwrap()
}

#[test]
fn no_model_is_selected_implicitly_and_arbitrary_safe_ids_need_no_catalog() {
    let empty = ExecutionConfig::for_task(&task());
    assert!(empty.model_id.is_empty());
    assert!(empty.validate().is_err());
    let job = job();
    let body = job.request_body_snapshot(0).unwrap();
    assert_eq!(body["generationConfig"]["candidateCount"], 1);
    assert_eq!(body["generationConfig"]["maxOutputTokens"], 2048);
    for key in ["thinkingConfig", "temperature", "topP", "topK"] {
        assert!(body["generationConfig"].get(key).is_none());
    }
    let estimate = &job.estimates().unwrap()[0];
    assert_eq!(estimate.output_tokens_reserved, 2048);
    assert_eq!(estimate.estimated_max_microusd, None);
    assert_eq!(
        job.execution.endpoint("fixture-project").unwrap(),
        "https://asia-northeast1-aiplatform.googleapis.com/v1/projects/fixture-project/locations/asia-northeast1/publishers/google/models/gemini-unlisted-future-preview:generateContent"
    );
}

#[test]
fn endpoint_segments_and_mutually_exclusive_thinking_are_validated_without_model_lists() {
    for id in [
        "../evil",
        "gemini?key=secret",
        "https://evil.invalid",
        "gemini%2Fescape",
        "",
        "..",
    ] {
        let mut execution = config();
        execution.model_id = id.into();
        assert!(execution.validate().is_err());
    }
    for location in [
        "global/../x",
        "global.evil.invalid",
        "-global",
        "global?x=1",
    ] {
        let mut execution = config();
        execution.location = location.into();
        assert!(execution.validate().is_err());
    }
    assert!(serde_json::from_value::<ThinkingConfig>(
        json!({"kind":"level","level":"LOW","tokens":10})
    )
    .is_err());
    for thinking in [
        ThinkingConfig::Level {
            level: "LOW".into(),
        },
        ThinkingConfig::Budget { tokens: 512 },
    ] {
        let mut execution = config();
        execution.thinking = thinking.clone();
        let prepared = job().with_execution(execution).unwrap();
        let settings =
            &prepared.request_body_snapshot(0).unwrap()["generationConfig"]["thinkingConfig"];
        match thinking {
            ThinkingConfig::Level { .. } => {
                assert_eq!(settings["thinkingLevel"], "LOW");
                assert!(settings.get("thinkingBudget").is_none());
            }
            _ => {
                assert_eq!(settings["thinkingBudget"], 512);
                assert!(settings.get("thinkingLevel").is_none());
            }
        }
    }
}

#[test]
fn explicit_minimal_thinking_is_frozen_and_serialized_without_fallback() {
    let mut execution = config();
    execution.model_id = "gemini-3.1-flash-lite".into();
    execution.thinking = ThinkingConfig::Level {
        level: "MINIMAL".into(),
    };
    let minimal = job().with_execution(execution.clone()).unwrap();
    let body = minimal.request_body_snapshot(0).unwrap();
    assert_eq!(
        body["generationConfig"]["thinkingConfig"],
        json!({"thinkingLevel":"MINIMAL"})
    );
    let restored: PreparedJob =
        serde_json::from_value(serde_json::to_value(&minimal).unwrap()).unwrap();
    assert_eq!(restored.digest().unwrap(), minimal.digest().unwrap());
    assert_eq!(restored.request_body_snapshot(0).unwrap(), body);
    execution.thinking = ThinkingConfig::Omit;
    let default = minimal.clone().with_execution(execution).unwrap();
    assert_ne!(default.digest().unwrap(), minimal.digest().unwrap());
}

#[test]
fn frozen_input_prompt_schema_config_and_price_are_all_bound_to_digest() {
    let original = job();
    let digest = original.digest().unwrap();
    for field in ["model", "location", "cap", "thinking", "price"] {
        let mut execution = original.execution.clone();
        match field {
            "model" => execution.model_id = "gemini-another-unlisted".into(),
            "location" => execution.location = "global".into(),
            "cap" => execution.max_output_tokens += 1,
            "thinking" => {
                execution.thinking = ThinkingConfig::Level {
                    level: "HIGH".into(),
                }
            }
            _ => {
                execution.price = Some(PriceSnapshot {
                    id: "user-price".into(),
                    source: "user".into(),
                    observed_at_ms: 1,
                    input_microusd_per_million: 100,
                    output_microusd_per_million: 200,
                    audio_microusd_per_minute: None,
                })
            }
        }
        let changed = original.clone().with_execution(execution).unwrap();
        assert_ne!(changed.digest().unwrap(), digest, "{field}");
    }
    let mut changed = original.clone();
    if let RequestTask::Translation { cues, .. } = &mut changed.requests[0] {
        cues[0].text = "Changed".into();
    }
    assert!(changed.validate().is_err());
    for pointer in [
        "/frozen_requests/0/systemInstruction/parts/0/text",
        "/frozen_requests/0/generationConfig/responseSchema/type",
    ] {
        let mut value = serde_json::to_value(&original).unwrap();
        *value.pointer_mut(pointer).unwrap() = json!("changed");
        let changed: PreparedJob = serde_json::from_value(value).unwrap();
        assert_ne!(changed.digest().unwrap(), digest);
    }
    let mut value = serde_json::to_value(&original).unwrap();
    value["frozen_requests"][0]["generationConfig"]["maxOutputTokens"] = json!(999999);
    assert!(serde_json::from_value::<PreparedJob>(value)
        .unwrap()
        .validate()
        .is_err());
}

#[test]
fn free_audio_container_never_becomes_an_approved_request() {
    let audio = RequestTask::AudioTranscription {
        language: "en".into(),
        audio: AudioAttachment {
            path: "not-opened.flac".into(),
            sha256: sha256_bytes(b"audio"),
            byte_len: 5,
            mime_type: "audio/flac".into(),
            source_start_ms: 0,
            duration_ms: 1000,
        },
    };
    let draft = PreparedJob::local_audio_draft("Free".into(), binding(), vec![audio]).unwrap();
    assert!(draft.validate().is_err());
    let dir = tempfile::tempdir().unwrap();
    let store = AiStore::open(dir.path().join("new.sqlite")).unwrap();
    assert!(store.prepare(draft).is_err());
    assert!(store.list_jobs().unwrap().is_empty());
}

#[test]
fn old_database_is_rejected_before_any_database_or_wal_modification() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("old.sqlite");
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch(
        "CREATE TABLE old_evidence(cost INTEGER);INSERT INTO old_evidence VALUES(961717);",
    )
    .unwrap();
    drop(conn);
    let before = std::fs::read(&path).unwrap();
    assert!(AiStore::open(&path).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert!(!path.with_extension("sqlite-wal").exists());
}

#[test]
fn openai_settings_roundtrip_without_changing_legacy_serialization() {
    let legacy = config();
    let mut value = serde_json::to_value(&legacy).unwrap();
    assert!(value.get("provider").is_none());
    value["provider"] = json!("openai");
    value["response_mode"] = json!("responses");
    value["location"] = json!("global");
    let parsed: ExecutionConfig = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(
        parsed.endpoint("openai").unwrap(),
        "https://api.openai.com/v1/responses"
    );
    assert_eq!(serde_json::to_value(parsed).unwrap(), value);
}

#[test]
fn openai_plan_freezes_prompt_schema_endpoint_and_duration_price() {
    let mut execution = config();
    execution.provider = crate::AiProvider::Openai;
    execution.model_id = "gpt-future".into();
    execution.location = "global".into();
    execution.response_mode = ResponseMode::Responses;
    let original = PreparedJob::new(
        "openai".into(),
        "openai".into(),
        "credential".into(),
        binding(),
        vec![task()],
        execution,
    )
    .unwrap();
    let frozen = original.request_body_snapshot(0).unwrap().clone();
    assert_eq!(frozen["model"], "gpt-future");
    assert_eq!(frozen["store"], false);
    assert_eq!(
        frozen["text"]["format"]["schema"]["properties"]["translations"]["items"]
            ["additionalProperties"],
        false
    );
    let bytes = serde_json::to_vec(&original).unwrap();
    let restored: PreparedJob = serde_json::from_slice(&bytes).unwrap();
    restored.validate().unwrap();
    assert_eq!(restored.request_body_snapshot(0).unwrap(), &frozen);
    assert_eq!(restored.digest().unwrap(), original.digest().unwrap());
    assert_ne!(original.digest().unwrap(), job().digest().unwrap());
    let price = PriceSnapshot {
        id: "duration".into(),
        source: "explicit".into(),
        observed_at_ms: 1,
        input_microusd_per_million: 0,
        output_microusd_per_million: 0,
        audio_microusd_per_minute: Some(6000),
    };
    assert_eq!(price.audio_cost(1235).unwrap(), 124);
    assert_eq!(price.audio_cost(2000).unwrap(), 200);
}

#[test]
fn openai_fine_tuned_ids_are_json_values_while_vertex_keeps_path_constraints() {
    let model = "ft:gpt-4.1-2025-04-14:org:suffix:id";
    let mut execution = config();
    execution.model_id = model.into();
    assert!(execution.validate().is_err());
    execution.provider = crate::AiProvider::Openai;
    execution.location = "global".into();
    execution.response_mode = ResponseMode::Responses;
    let prepared = PreparedJob::new(
        "Fine tuned".into(),
        "openai".into(),
        "credential".into(),
        binding(),
        vec![task()],
        execution.clone(),
    )
    .unwrap();
    assert_eq!(prepared.request_body_snapshot(0).unwrap()["model"], model);
    assert_eq!(
        prepared.execution.endpoint("openai").unwrap(),
        "https://api.openai.com/v1/responses"
    );
    let restored: PreparedJob =
        serde_json::from_slice(&serde_json::to_vec(&prepared).unwrap()).unwrap();
    restored.validate().unwrap();
    assert_eq!(prepared.digest().unwrap(), restored.digest().unwrap());
    for invalid in [
        "ft:model\nAuthorization: secret",
        "ft:model/other",
        "https://evil.invalid/model",
        ".",
        "..",
        "",
    ] {
        execution.model_id = invalid.into();
        assert!(execution.validate().is_err(), "{invalid}");
    }
}

fn openai_audio_job() -> PreparedJob {
    let task = RequestTask::AudioTranscription {
        language: "en-US".into(),
        audio: AudioAttachment {
            path: "frozen-legacy.flac".into(),
            sha256: sha256_bytes(b"audio"),
            byte_len: 5,
            mime_type: "audio/flac".into(),
            source_start_ms: 0,
            duration_ms: 1000,
        },
    };
    let mut execution = config();
    execution.provider = crate::AiProvider::Openai;
    execution.model_id = "gpt-future-transcribe".into();
    execution.location = "global".into();
    execution.response_mode = ResponseMode::AudioTranscriptions;
    PreparedJob::new(
        "Frozen audio".into(),
        "openai".into(),
        "credential".into(),
        binding(),
        vec![task],
        execution,
    )
    .unwrap()
}

#[test]
fn openai_whole_audio_draft_quote_estimate_and_reopen_use_the_selected_provider() {
    let original = openai_audio_job();
    let mut task = original.requests[0].clone();
    let RequestTask::AudioTranscription { audio, .. } = &mut task else {
        panic!()
    };
    audio.duration_ms = 360_001;
    audio.byte_len = 16_000_000;
    assert!(task.validate().is_err());
    task.validate_for_provider(crate::AiProvider::Openai)
        .unwrap();
    assert!(PreparedJob::local_audio_draft("Whole".into(), binding(), vec![task.clone()]).is_err());
    let draft = PreparedJob::local_audio_draft_for_provider(
        "Whole".into(),
        binding(),
        vec![task.clone()],
        crate::AiProvider::Openai,
    )
    .unwrap();
    assert_eq!(draft.execution.provider, crate::AiProvider::Openai);
    assert!(draft.validate().is_err());
    let mut execution = original.execution.clone();
    execution.price = Some(PriceSnapshot {
        id: "duration".into(),
        source: "explicit".into(),
        observed_at_ms: 1,
        input_microusd_per_million: 0,
        output_microusd_per_million: 0,
        audio_microusd_per_minute: Some(6000),
    });
    let plan = PreparedJob::new(
        "Whole".into(),
        "openai".into(),
        "credential".into(),
        binding(),
        vec![task],
        execution,
    )
    .unwrap();
    let estimate = &plan.estimates().unwrap()[0];
    assert_eq!(estimate.audio_duration_ms, 360_001);
    assert_eq!(estimate.estimated_max_microusd, Some(36_100));
    let encoded = serde_json::to_vec(&plan).unwrap();
    let restored: PreparedJob = serde_json::from_slice(&encoded).unwrap();
    restored.validate().unwrap();
    assert_eq!(restored.digest().unwrap(), plan.digest().unwrap());
    assert_eq!(serde_json::to_vec(&restored).unwrap(), encoded);
    let mut vertex = restored.execution.clone();
    vertex.provider = crate::AiProvider::Vertex;
    vertex.response_mode = ResponseMode::GenerateContent;
    assert!(restored.with_execution(vertex).is_err());
}

#[test]
fn openai_whole_audio_rejects_duration_beyond_usage_accounting_limit_before_quote() {
    let original = openai_audio_job();
    let mut task = original.requests[0].clone();
    let RequestTask::AudioTranscription { audio, .. } = &mut task else {
        panic!()
    };
    audio.duration_ms = 86_400_000;
    assert_eq!(audio.duration_ms, AudioAttachment::MAX_OPENAI_DURATION_MS);
    task.validate_for_provider(crate::AiProvider::Openai)
        .unwrap();
    let plan = PreparedJob::new(
        "Day".into(),
        "openai".into(),
        "credential".into(),
        binding(),
        vec![task.clone()],
        original.execution.clone(),
    )
    .unwrap();
    assert_eq!(plan.estimates().unwrap()[0].audio_duration_ms, 86_400_000);
    let RequestTask::AudioTranscription { audio, .. } = &mut task else {
        panic!()
    };
    audio.duration_ms += 1;
    assert!(task
        .validate_for_provider(crate::AiProvider::Openai)
        .is_err());
    assert!(PreparedJob::new(
        "Too long".into(),
        "openai".into(),
        "credential".into(),
        binding(),
        vec![task],
        original.execution
    )
    .is_err());
}

#[test]
fn openai_audio_chunking_auto_is_frozen_only_when_explicitly_selected() {
    let legacy = openai_audio_job();
    let legacy_json = serde_json::to_string(&legacy).unwrap();
    assert!(!legacy_json.contains("chunking_strategy"));
    let restored: PreparedJob = serde_json::from_str(&legacy_json).unwrap();
    restored.validate().unwrap();
    assert_eq!(serde_json::to_string(&restored).unwrap(), legacy_json);
    assert_eq!(restored.digest().unwrap(), legacy.digest().unwrap());
    // Captured before adding the optional setting; old approved plans keep it.
    assert_eq!(
        legacy.digest().unwrap(),
        "acddb7010cfd071c74f010766d931e08d72f9e47f152391d71a94acd5065a33e"
    );

    let mut value = serde_json::to_value(&legacy.execution).unwrap();
    value["openai_audio_chunking_strategy"] = json!("auto");
    let execution: ExecutionConfig = serde_json::from_value(value).unwrap();
    let auto = legacy.clone().with_execution(execution).unwrap();
    assert_eq!(
        auto.request_body_snapshot(0).unwrap(),
        &json!({
            "model":"gpt-future-transcribe", "response_format":"json",
            "file":{"mime_type":"audio/flac","data":""}, "language":"en",
            "chunking_strategy":"auto"
        })
    );
    assert_ne!(auto.digest().unwrap(), legacy.digest().unwrap());
    let restored: PreparedJob =
        serde_json::from_slice(&serde_json::to_vec(&auto).unwrap()).unwrap();
    restored.validate().unwrap();
    assert_eq!(restored.digest().unwrap(), auto.digest().unwrap());
    assert_eq!(
        restored.request_body_snapshot(0).unwrap(),
        auto.request_body_snapshot(0).unwrap()
    );

    for invalid in [
        json!("none"),
        json!("Auto"),
        json!(false),
        json!({"type":"server_vad"}),
    ] {
        let mut value = serde_json::to_value(&auto).unwrap();
        value["frozen_requests"][0]["chunking_strategy"] = invalid;
        assert!(serde_json::from_value::<PreparedJob>(value)
            .unwrap()
            .validate()
            .is_err());
    }
    let mut missing = serde_json::to_value(&auto).unwrap();
    missing["frozen_requests"][0]
        .as_object_mut()
        .unwrap()
        .remove("chunking_strategy");
    assert!(serde_json::from_value::<PreparedJob>(missing)
        .unwrap()
        .validate()
        .is_err());
    let mut unexpected = serde_json::to_value(&legacy).unwrap();
    unexpected["frozen_requests"][0]["chunking_strategy"] = json!("auto");
    assert!(serde_json::from_value::<PreparedJob>(unexpected)
        .unwrap()
        .validate()
        .is_err());
}

#[test]
fn openai_audio_chunking_rejects_invalid_values_and_other_endpoints() {
    let legacy = openai_audio_job();
    for invalid in [
        json!("none"),
        json!("Auto"),
        json!(false),
        json!({"type":"server_vad"}),
    ] {
        let mut value = serde_json::to_value(&legacy.execution).unwrap();
        value["openai_audio_chunking_strategy"] = invalid;
        assert!(serde_json::from_value::<ExecutionConfig>(value).is_err());
    }
    for (provider, mode) in [
        (crate::AiProvider::Openai, ResponseMode::Responses),
        (crate::AiProvider::Openai, ResponseMode::StreamResponses),
        (crate::AiProvider::Vertex, ResponseMode::GenerateContent),
    ] {
        let mut value = serde_json::to_value(&legacy.execution).unwrap();
        value["provider"] = serde_json::to_value(provider).unwrap();
        value["response_mode"] = serde_json::to_value(mode).unwrap();
        value["openai_audio_chunking_strategy"] = json!("auto");
        let execution: ExecutionConfig = serde_json::from_value(value).unwrap();
        assert!(execution.validate().is_err());
    }
}

#[test]
fn openai_audio_languages_format_is_explicit_frozen_and_omitted_for_auto_language() {
    let legacy = openai_audio_job();
    let encoded = serde_json::to_string(&legacy).unwrap();
    assert!(!encoded.contains("language_hint_format"));
    assert_eq!(legacy.request_body_snapshot(0).unwrap()["language"], "en");
    assert_eq!(
        legacy.digest().unwrap(),
        "acddb7010cfd071c74f010766d931e08d72f9e47f152391d71a94acd5065a33e"
    );
    for automatic in [false, true] {
        for chunking in [false, true] {
            let mut source = legacy.clone();
            if let RequestTask::AudioTranscription { language, .. } = &mut source.requests[0] {
                *language = if automatic { "auto" } else { "en-US" }.into();
            }
            let mut value = serde_json::to_value(&source.execution).unwrap();
            value["openai_audio_language_hint_format"] = json!("languages");
            if chunking {
                value["openai_audio_chunking_strategy"] = json!("auto");
            }
            let execution: ExecutionConfig = serde_json::from_value(value).unwrap();
            let prepared = source.with_execution(execution).unwrap();
            let body = prepared.request_body_snapshot(0).unwrap();
            assert!(body.get("language").is_none());
            assert_eq!(
                body.get("languages"),
                (!automatic).then_some(&json!(["en"]))
            );
            assert_eq!(
                body.get("chunking_strategy"),
                chunking.then_some(&json!("auto"))
            );
            let restored: PreparedJob =
                serde_json::from_slice(&serde_json::to_vec(&prepared).unwrap()).unwrap();
            restored.validate().unwrap();
            assert_eq!(restored.digest().unwrap(), prepared.digest().unwrap());
            assert_ne!(restored.digest().unwrap(), legacy.digest().unwrap());

            for invalid in [
                json!("en"),
                json!([]),
                json!([null]),
                json!(["en-US"]),
                json!(["en", "fr"]),
                json!(["ja"]),
            ] {
                let mut malformed = serde_json::to_value(&prepared).unwrap();
                malformed["frozen_requests"][0]["languages"] = invalid;
                assert!(serde_json::from_value::<PreparedJob>(malformed)
                    .unwrap()
                    .validate()
                    .is_err());
            }
            let mut both = serde_json::to_value(&prepared).unwrap();
            both["frozen_requests"][0]["language"] = json!("en");
            assert!(serde_json::from_value::<PreparedJob>(both)
                .unwrap()
                .validate()
                .is_err());
            if !automatic {
                let mut missing = serde_json::to_value(&prepared).unwrap();
                missing["frozen_requests"][0]
                    .as_object_mut()
                    .unwrap()
                    .remove("languages");
                assert!(serde_json::from_value::<PreparedJob>(missing)
                    .unwrap()
                    .validate()
                    .is_err());
            }
        }
    }
    let mut unexpected = serde_json::to_value(&legacy).unwrap();
    unexpected["frozen_requests"][0]["languages"] = json!(["en"]);
    assert!(serde_json::from_value::<PreparedJob>(unexpected)
        .unwrap()
        .validate()
        .is_err());
}

#[test]
fn openai_audio_languages_format_rejects_invalid_modes_and_values() {
    let legacy = openai_audio_job();
    for invalid in [
        json!("language"),
        json!("Languages"),
        json!(false),
        json!(["en"]),
    ] {
        let mut value = serde_json::to_value(&legacy.execution).unwrap();
        value["openai_audio_language_hint_format"] = invalid;
        assert!(serde_json::from_value::<ExecutionConfig>(value).is_err());
    }
    for (provider, mode) in [
        (crate::AiProvider::Openai, ResponseMode::Responses),
        (crate::AiProvider::Openai, ResponseMode::StreamResponses),
        (crate::AiProvider::Vertex, ResponseMode::GenerateContent),
    ] {
        let mut value = serde_json::to_value(&legacy.execution).unwrap();
        value["provider"] = serde_json::to_value(provider).unwrap();
        value["response_mode"] = serde_json::to_value(mode).unwrap();
        value["openai_audio_language_hint_format"] = json!("languages");
        let execution: ExecutionConfig = serde_json::from_value(value).unwrap();
        assert!(execution.validate().is_err());
    }
}

#[test]
fn openai_audio_prompt_is_frozen_exactly_and_legacy_absence_keeps_its_hash() {
    let legacy = openai_audio_job();
    let encoded = serde_json::to_string(&legacy).unwrap();
    assert!(!encoded.contains("openai_audio_prompt"));
    assert!(legacy
        .request_body_snapshot(0)
        .unwrap()
        .get("prompt")
        .is_none());
    let restored: PreparedJob = serde_json::from_str(&encoded).unwrap();
    assert_eq!(serde_json::to_string(&restored).unwrap(), encoded);
    assert_eq!(
        restored.digest().unwrap(),
        "acddb7010cfd071c74f010766d931e08d72f9e47f152391d71a94acd5065a33e"
    );

    for prompt in [
        "This recording contains spoken language that may include deliberate repetition, false starts, and incomplete sentences.".to_owned(),
        "  Spoken language context.\n ".to_owned(),
        "é".repeat(1000),
    ] {
        let mut value = serde_json::to_value(&legacy.execution).unwrap();
        value["openai_audio_prompt"] = json!(prompt);
        let execution: ExecutionConfig = serde_json::from_value(value).unwrap();
        let prepared = legacy.clone().with_execution(execution).unwrap();
        assert_eq!(prepared.request_body_snapshot(0).unwrap()["prompt"], prompt);
        assert_ne!(prepared.digest().unwrap(), legacy.digest().unwrap());
        let restored: PreparedJob = serde_json::from_slice(&serde_json::to_vec(&prepared).unwrap()).unwrap();
        restored.validate().unwrap();
        assert_eq!(restored.digest().unwrap(), prepared.digest().unwrap());
        for invalid in [json!("changed"), json!(null), json!(false), json!(["context"])] {
            let mut value = serde_json::to_value(&prepared).unwrap();
            value["frozen_requests"][0]["prompt"] = invalid;
            assert!(serde_json::from_value::<PreparedJob>(value).unwrap().validate().is_err());
        }
        let mut missing = serde_json::to_value(&prepared).unwrap();
        missing["frozen_requests"][0].as_object_mut().unwrap().remove("prompt");
        assert!(serde_json::from_value::<PreparedJob>(missing).unwrap().validate().is_err());
    }
    let mut unexpected = serde_json::to_value(&legacy).unwrap();
    unexpected["frozen_requests"][0]["prompt"] = json!("context");
    assert!(serde_json::from_value::<PreparedJob>(unexpected)
        .unwrap()
        .validate()
        .is_err());
}

#[test]
fn openai_audio_prompt_is_bounded_nonempty_and_audio_only() {
    let legacy = openai_audio_job();
    for prompt in [
        "".to_owned(),
        " \n\t ".to_owned(),
        "x".repeat(2001),
        "é".repeat(1001),
    ] {
        let mut value = serde_json::to_value(&legacy.execution).unwrap();
        value["openai_audio_prompt"] = json!(prompt);
        let execution: ExecutionConfig = serde_json::from_value(value).unwrap();
        assert!(execution.validate().is_err());
    }
    for invalid in [json!(false), json!([]), json!({"text":"context"})] {
        let mut value = serde_json::to_value(&legacy.execution).unwrap();
        value["openai_audio_prompt"] = invalid;
        assert!(serde_json::from_value::<ExecutionConfig>(value).is_err());
    }
    for (provider, mode) in [
        (crate::AiProvider::Openai, ResponseMode::Responses),
        (crate::AiProvider::Openai, ResponseMode::StreamResponses),
        (crate::AiProvider::Vertex, ResponseMode::GenerateContent),
    ] {
        let mut value = serde_json::to_value(&legacy.execution).unwrap();
        value["provider"] = serde_json::to_value(provider).unwrap();
        value["response_mode"] = serde_json::to_value(mode).unwrap();
        value["openai_audio_prompt"] = json!("Recording context.");
        let execution: ExecutionConfig = serde_json::from_value(value).unwrap();
        assert!(execution.validate().is_err());
    }
}
