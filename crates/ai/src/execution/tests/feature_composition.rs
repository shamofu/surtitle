//! These contracts also run with GPUI's unified serde_json/preserve_order feature.
use super::*;

const LEGACY_AUDIO_DIGEST: &str =
    "acddb7010cfd071c74f010766d931e08d72f9e47f152391d71a94acd5065a33e";
const LEGACY_AUDIO_BODY: &str = r#"{"file":{"data":"","mime_type":"audio/flac"},"language":"en","model":"gpt-future-transcribe","response_format":"json"}"#;

#[test]
fn frozen_audio_bytes_and_quote_identity_survive_json_feature_composition() {
    let plan = openai_audio_job();
    assert_eq!(
        serde_json::to_string(plan.request_body_snapshot(0).unwrap()).unwrap(),
        LEGACY_AUDIO_BODY
    );
    assert_eq!(plan.digest().unwrap(), LEGACY_AUDIO_DIGEST);

    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("ai.sqlite");
    let store = AiStore::open(&path).unwrap();
    let quote = store.prepare(plan).unwrap();
    assert_eq!(quote.digest, LEGACY_AUDIO_DIGEST);
    drop(store);

    let store = AiStore::open(path).unwrap();
    let reopened = store.prepared_job(&quote.id).unwrap();
    assert_eq!(reopened.digest().unwrap(), LEGACY_AUDIO_DIGEST);
    assert_eq!(store.prepare(openai_audio_job()).unwrap().id, quote.id);
}

#[test]
fn restored_frozen_requests_ignore_object_order_but_preserve_content() {
    let mut wire = serde_json::to_value(openai_audio_job()).unwrap();
    wire["frozen_requests"][0] = serde_json::from_str(
        r#"{"response_format":"json","model":"gpt-future-transcribe","language":"en","file":{"mime_type":"audio/flac","data":""}}"#,
    )
    .unwrap();
    let restored: PreparedJob = serde_json::from_value(wire.clone()).unwrap();
    restored.validate().unwrap();
    assert_eq!(
        serde_json::to_string(restored.request_body_snapshot(0).unwrap()).unwrap(),
        LEGACY_AUDIO_BODY
    );
    assert_eq!(restored.digest().unwrap(), LEGACY_AUDIO_DIGEST);

    wire["frozen_requests"][0]["language"] = json!("ja");
    let changed: PreparedJob = serde_json::from_value(wire).unwrap();
    assert_ne!(changed.digest().unwrap(), LEGACY_AUDIO_DIGEST);
    assert_eq!(changed.request_body_snapshot(0).unwrap()["language"], "ja");
}

#[test]
fn text_request_json_keeps_legacy_bytes_inside_prompt_strings_and_arrays() {
    let tasks = [
        (
            task(),
            r#"{"subtitles":[{"end_ms":1000,"id":"cue-1","start_ms":0,"text":"Hello."}],"targetLanguage":"ja"}"#,
        ),
        (
            RequestTask::Vocabulary {
                learning_language: "en".into(),
                explanation_language: "ja".into(),
                cues: vec![SourceCue {
                    id: "cue-1".into(),
                    start_ms: 0,
                    end_ms: 1000,
                    text: "Hello.".into(),
                }],
                max_items: 2,
            },
            r#"{"explanationLanguage":"ja","learningLanguage":"en","maximumItems":2,"subtitles":[{"end_ms":1000,"id":"cue-1","start_ms":0,"text":"Hello."}]}"#,
        ),
        (
            RequestTask::Explanation {
                term: "Hello".into(),
                learning_language: "en".into(),
                explanation_language: "ja".into(),
                proficiency: "intermediate".into(),
                cues: vec![SourceCue {
                    id: "cue-1".into(),
                    start_ms: 0,
                    end_ms: 1000,
                    text: "Hello.".into(),
                }],
            },
            r#"{"explanationLanguage":"ja","learningLanguage":"en","proficiency":"intermediate","subtitles":[{"end_ms":1000,"id":"cue-1","start_ms":0,"text":"Hello."}],"term":"Hello"}"#,
        ),
    ];
    for (task, expected_input) in tasks {
        for provider in [crate::AiProvider::Vertex, crate::AiProvider::Openai] {
            let mut execution = config();
            execution.provider = provider;
            let (project, input_pointer) = if provider == crate::AiProvider::Openai {
                execution.location = "global".into();
                execution.response_mode = ResponseMode::Responses;
                ("openai", "/input/0/content/0/text")
            } else {
                ("fixture-project", "/contents/0/parts/0/text")
            };
            let plan = PreparedJob::new(
                "Text".into(),
                project.into(),
                "credential".into(),
                binding(),
                vec![task.clone()],
                execution,
            )
            .unwrap();
            let body = plan.request_body_snapshot(0).unwrap();
            assert_eq!(body.pointer(input_pointer).unwrap(), expected_input);
            assert_object_keys_sorted(body);
        }
    }
}

fn assert_object_keys_sorted(value: &serde_json::Value) {
    match value {
        serde_json::Value::Object(object) => {
            let keys: Vec<_> = object.keys().collect();
            assert!(keys.windows(2).all(|pair| pair[0] < pair[1]), "{keys:?}");
            object.values().for_each(assert_object_keys_sorted);
        }
        serde_json::Value::Array(values) => values.iter().for_each(assert_object_keys_sorted),
        _ => {}
    }
}
