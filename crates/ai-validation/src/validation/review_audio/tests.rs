use super::*;

fn saved(id: &str, hash: &str, cues: Value) -> Value {
    json!({"id":id,"state":"completed","taskKind":"audio_transcription","sourceAudioSha256":hash,
        "output":{"kind":"transcript","cues":cues},"attempts":[{"id":format!("attempt-{id}"),"state":"settled","chargedMicrousd":99}]})
}

#[test]
fn saved_transcribe_reparse_is_explicit_derived_output_without_ledger_or_input_changes() {
    let directory = tempfile::tempdir().unwrap();
    let audio = directory.path().join("clip.wav");
    let pcm = super::super::tests::wav(16_000);
    fs::write(&audio, &pcm).unwrap();
    let mut request = saved("request", &sha256_bytes(&pcm), json!([]));
    request["taskKind"] = json!("transcribe_preview");
    request["state"] = json!("needs_review");
    request["output"] = Value::Null;
    request["attempts"][0]["evidence"] = json!({"evidenceTruncated":false,"candidateDiagnostics":[{"finishReason":"STOP"}],"audioTranscriptions":[{"text":"We are here.","words":[
        {"word":"We","startOffset":"0s","endOffset":"0.3s"},
        {"word":"are","startOffset":"0.3s","endOffset":"0.3s"},
        {"word":"here","startOffset":"0.4s","endOffset":"0.8s"}
    ]}]});
    let source = directory.path().join("report.json");
    write_json_new(
        &source,
        &json!({"schemaVersion":1,"evidenceKind":"authored-oracle","requests":[request.clone()]}),
    )
    .unwrap();
    let original = fs::read(&source).unwrap();
    let output = directory.path().join("derived.json");
    reparse(&source, "request", "attempt-request", &audio, &output).unwrap();
    let value: Value = serde_json::from_slice(&fs::read(&output).unwrap()).unwrap();
    assert_eq!(value["requests"][0]["state"], "needs_review");
    assert_eq!(value["requests"][0]["attempts"], request["attempts"]);
    assert_eq!(
        value["requests"][0]["output"]["cues"][0]["text"],
        "We are here."
    );
    assert_eq!(
        value["requests"][0]["outputProvenance"]["originalOutput"],
        Value::Null
    );
    assert_eq!(fs::read(&source).unwrap(), original);
    assert_eq!(fs::read(&audio).unwrap(), pcm);
    assert!(!directory.path().join("charges.sqlite").exists());
    request["attempts"][0]["evidence"]["evidenceTruncated"] = json!(true);
    fs::write(
        &source,
        serde_json::to_vec(&json!({"schemaVersion":1,"requests":[request]})).unwrap(),
    )
    .unwrap();
    let rejected = directory.path().join("rejected.json");
    assert!(reparse(&source, "request", "attempt-request", &audio, &rejected).is_err());
    assert!(!rejected.exists());
}

#[test]
fn rebase_preserves_repeated_text_and_missing_invalid_results_never_become_silence() {
    let good = saved(
        "one",
        &"a".repeat(64),
        json!([{"startMs":50,"endMs":900,"text":"No, no, no."}]),
    );
    let (Some(ParsedOutput::Transcript { cues }), _) = rebase(Some(&good), 120_000, 1000) else {
        panic!("expected received speech")
    };
    assert_eq!(cues[0].start_ms, 120_050);
    assert_eq!(cues[0].end_ms, 120_900);
    assert_eq!(cues[0].text, "No, no, no.");
    assert!(rebase(None, 0, 1000).0.is_none());
    for mutation in 0..5 {
        let mut bad = good.clone();
        match mutation {
            0 => bad["state"] = json!("needs_review"),
            1 => bad["output"] = Value::Null,
            2 => bad["attempts"][0]["state"] = json!("unknown"),
            3 => bad["output"]["cues"][0]["endMs"] = json!(1001),
            _ => bad["output"]["kind"] = json!("vocabulary"),
        }
        assert!(rebase(Some(&bad), 0, 1000).0.is_none());
    }
    let empty = saved("empty", &"a".repeat(64), json!([]));
    assert!(
        matches!(rebase(Some(&empty), 0, 1000).0, Some(ParsedOutput::Transcript { cues }) if cues.is_empty())
    );
}

#[test]
fn twenty_real_workflow_boundaries_use_shared_engine_without_mutating_input_or_costs() {
    let directory = tempfile::tempdir().unwrap();
    let audio = directory.path().join("source & clip.wav");
    let bytes = super::super::tests::wav(7 * 16_000);
    fs::write(&audio, &bytes).unwrap();
    let hash = sha256_bytes(&bytes);
    let mut cases = Vec::new();
    let mut requests = Vec::new();
    for index in 0..20 {
        let left = format!("{index}-left");
        let right = format!("{index}-right");
        cases.push(json!({"id":format!("boundary-{index}"),"mediaId":format!("media-{index}"),"sourceSha256":sha256_bytes(format!("source-{index}").as_bytes()),"sourceRevision":"one","chunks":[
            {"ordinal":0,"coreStartMs":0,"coreEndMs":4000,"requestStartMs":0,"requestEndMs":7000,"requestId":left,"audioPath":audio,"audioSha256":hash},
            {"ordinal":1,"coreStartMs":4000,"coreEndMs":8000,"requestStartMs":1000,"requestEndMs":8000,"requestId":right,"audioPath":audio,"audioSha256":hash}
        ]}));
        requests.push(saved(
            &left,
            &hash,
            json!([{"startMs":3600,"endMs":4200,"text":"No, no, no."}]),
        ));
        requests.push(saved(
            &right,
            &hash,
            json!([{"startMs":2600,"endMs":3200,"text":"No, no, no."}]),
        ));
    }
    let manifest_path = directory.path().join("manifest.json");
    let results_path = directory.path().join("results.json");
    let output = directory.path().join("review.json");
    write_json_new(&manifest_path, &json!({"schemaVersion":1,"cases":cases})).unwrap();
    write_json_new(
        &results_path,
        &json!({"schemaVersion":1,"evidenceKind":"authored-oracle","requests":requests}),
    )
    .unwrap();
    let before_manifest = fs::read(&manifest_path).unwrap();
    let before_results = fs::read(&results_path).unwrap();
    let result = run(&manifest_path, &results_path, &output).unwrap();
    assert_eq!(result["networkRequests"], 0);
    let report: Value = serde_json::from_slice(&fs::read(&output).unwrap()).unwrap();
    assert_eq!(report["cases"].as_array().unwrap().len(), 20);
    for case in report["cases"].as_array().unwrap() {
        assert_eq!(case["draft"]["segments"].as_array().unwrap().len(), 1);
        assert_eq!(case["draft"]["segments"][0]["text"], "No, no, no.");
        assert_eq!(case["draft"]["segments"][0]["startMs"], 3600);
        assert_eq!(
            case["inputEvidence"][1]["originalOutput"]["cues"][0]["startMs"],
            2600
        );
        assert_eq!(
            case["inputEvidence"][1]["rebasedOutput"]["cues"][0]["startMs"],
            3600
        );
    }
    assert_eq!(fs::read(&manifest_path).unwrap(), before_manifest);
    assert_eq!(fs::read(&results_path).unwrap(), before_results);
    assert_eq!(fs::read(&audio).unwrap(), bytes);
    assert!(!directory.path().join("charges.sqlite").exists());
    assert!(!directory.path().join("instance.lock").exists());
    assert!(run(&manifest_path, &results_path, &output).is_err());
}

#[test]
fn review_rejects_changed_audio_and_preserves_unreceived_chunk_and_vad_warning() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("clip.wav");
    let bytes = super::super::tests::wav(16_000);
    fs::write(&path, &bytes).unwrap();
    let hash = sha256_bytes(&bytes);
    let value = json!({"schemaVersion":1,"cases":[{"id":"silence","mediaId":"silence","sourceSha256":hash,"sourceRevision":"one","vadModelSha256":"f".repeat(64),"chunks":[
        {"ordinal":0,"coreStartMs":0,"coreEndMs":1000,"requestStartMs":0,"requestEndMs":1000,"requestId":"request","audioPath":path,"audioSha256":hash,"noSpeechDetected":true}
    ]}]});
    let manifest: ReviewManifest = serde_json::from_value(value).unwrap();
    let mut results = json!({"schemaVersion":1,"requests":[]});
    let pending = review(&manifest, &results).unwrap();
    assert_eq!(pending["cases"][0]["draft"]["canAdopt"], false);
    assert_eq!(
        pending["cases"][0]["draft"]["pendingRanges"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    results["requests"] = json!([saved(
        "request",
        &hash,
        json!([{"startMs":10,"endMs":900,"text":"hallucination?"}])
    )]);
    let warning = review(&manifest, &results).unwrap();
    assert_eq!(warning["cases"][0]["draft"]["canAdopt"], false);
    assert_eq!(
        warning["cases"][0]["draft"]["warnings"][0]["kind"],
        "speech_in_vad_no_speech_range"
    );
    results["requests"][0]["sourceAudioSha256"] = json!("e".repeat(64));
    assert!(review(&manifest, &results).is_err());
    fs::write(&path, super::super::tests::wav(16_001)).unwrap();
    assert!(review(&manifest, &results).is_err());
}
