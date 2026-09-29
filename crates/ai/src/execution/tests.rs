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
        model_id: "gemini-unlisted-future-preview".into(),
        location: "asia-northeast1".into(),
        max_output_tokens: 2048,
        thinking: ThinkingConfig::Omit,
        price: None,
    }
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
    assert_eq!(job.execution.endpoint("fixture-project").unwrap(),
        "https://asia-northeast1-aiplatform.googleapis.com/v1/projects/fixture-project/locations/asia-northeast1/publishers/google/models/gemini-unlisted-future-preview:generateContent");
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
