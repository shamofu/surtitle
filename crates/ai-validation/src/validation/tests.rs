use super::*;

fn task() -> RequestTask {
    RequestTask::Translation {
        target_language: "ja".into(),
        cues: vec![surtitle_ai::SourceCue {
            id: "cue-one".into(),
            start_ms: 0,
            end_ms: 1000,
            text: "Hello.".into(),
        }],
    }
}

#[test]
fn execution_requires_explicit_model_location_limit_and_keeps_price_optional() {
    for options in [
        vec![],
        vec!["--model-id", "gemini-future"],
        vec!["--model-id", "gemini-future", "--location", "global"],
    ] {
        let mut args = Arguments::parse(options.into_iter().map(OsString::from).collect()).unwrap();
        assert!(parse_execution(&mut args).is_err());
    }
    let mut args = Arguments::parse(
        [
            "--model-id",
            "gemini-future",
            "--location",
            "europe-west4",
            "--max-output-tokens",
            "2048",
        ]
        .into_iter()
        .map(OsString::from)
        .collect(),
    )
    .unwrap();
    let execution = parse_execution(&mut args).unwrap();
    args.finish().unwrap();
    assert_eq!(execution.model_id, "gemini-future");
    assert_eq!(execution.price, None);
    assert_eq!(execution.thinking, ThinkingConfig::Omit);
    let mut args = Arguments::parse(
        [
            "--model-id",
            "gemini-future",
            "--location",
            "global",
            "--max-output-tokens",
            "2048",
            "--thinking-level",
            "LOW",
            "--thinking-budget",
            "100",
        ]
        .into_iter()
        .map(OsString::from)
        .collect(),
    )
    .unwrap();
    assert!(parse_execution(&mut args).is_err());
}

#[test]
fn unpriced_approval_is_not_a_zero_dollar_approval_and_remains_bound_to_exact_scope() {
    let directory = tempfile::tempdir().unwrap();
    let store = AiStore::open(directory.path().join("new.sqlite")).unwrap();
    let mut manifest = manifest();
    let mut execution = manifest.prepared.execution.clone();
    execution.price = None;
    manifest.prepared = manifest.prepared.with_execution(execution).unwrap();
    manifest.plan_digest = manifest.prepared.digest().unwrap();
    let quote = store.prepare(manifest.prepared.clone()).unwrap();
    manifest.job_id = quote.id.clone();
    assert_eq!(quote.additional_reservation_microusd, None);
    assert!(validate_charge_approval(&manifest, &quote, &quote.digest, Some(0), false).is_err());
    assert!(validate_charge_approval(&manifest, &quote, &quote.digest, None, false).is_ok());
    assert!(
        store
            .approve_scope(&quote.id, &quote.digest, false, true)
            .is_err()
    );
    store
        .approve_scope(&quote.id, &quote.digest, true, true)
        .unwrap();
}

#[test]
fn old_root_marker_is_rejected_before_opening_or_creating_a_lock() {
    let directory = tempfile::tempdir().unwrap();
    write_json_new(
        &directory.path().join("validation-root.json"),
        &Marker {
            format: FORMAT.into(),
            schema_version: 1,
        },
    )
    .unwrap();
    assert!(Context::open(directory.path()).is_err());
    assert!(!directory.path().join("instance.lock").exists());
    assert!(!directory.path().join("charges.sqlite").exists());
}
fn manifest() -> Manifest {
    let prepared = make_plan(
        "text-one".into(),
        "fixture-project".into(),
        "fixture-credential".into(),
        task(),
        ExecutionConfig {
            model_id: "gemini-unlisted-fixture".into(),
            location: "global".into(),
            max_output_tokens: 1024,
            thinking: ThinkingConfig::Omit,
            price: Some(PriceSnapshot {
                id: "fixture".into(),
                source: "user".into(),
                observed_at_ms: 1,
                input_microusd_per_million: 300_000,
                output_microusd_per_million: 2_500_000,
            }),
        },
        None,
    )
    .unwrap();
    Manifest {
        schema_version: 2,
        job_id: "00000000-0000-0000-0000-000000000001".into(),
        case_id: "text-one".into(),
        plan_digest: prepared.digest().unwrap(),
        prepared,
        max_audio_seconds: None,
    }
}
pub(super) fn wav(samples: usize) -> Vec<u8> {
    let mut bytes = b"RIFF".to_vec();
    bytes.extend_from_slice(&(36 + samples as u32 * 2).to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt ");
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&[1, 0, 1, 0, 128, 62, 0, 0, 0, 125, 0, 0, 2, 0, 16, 0]);
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&(samples as u32 * 2).to_le_bytes());
    bytes.resize(44 + samples * 2, 0);
    bytes
}

#[test]
fn money_is_exact_and_has_no_implicit_or_negative_allowance() {
    assert_eq!(usd("0.190001").unwrap(), 190001);
    assert_eq!(usd("1.25").unwrap(), 1_250_000);
    for invalid in [
        "",
        "0",
        "-1",
        "+1",
        "NaN",
        "1e3",
        ".5",
        "0.1234567",
        "1.2.3",
        "999999999999999999999999",
    ] {
        assert!(usd(invalid).is_err());
    }
}
#[test]
fn duplicate_unknown_and_incompatible_arguments_fail_closed() {
    assert!(
        Arguments::parse(vec![
            "--digest".into(),
            "a".into(),
            "--digest".into(),
            "b".into()
        ])
        .is_err()
    );
    assert!(
        Arguments::parse(vec!["--token".into(), "secret-sentinel".into()])
            .unwrap()
            .finish()
            .is_err()
    );
    assert!(
        Arguments::parse(vec!["--endpoint".into(), "http://evil.invalid".into()])
            .unwrap()
            .finish()
            .is_err()
    );
    assert!(absolute(Path::new("relative/key.json")).is_err());
}
#[test]
fn changed_manifest_content_digest_model_or_unknown_fields_are_rejected() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("manifest.json");
    let expected = manifest();
    write_json_new(&path, &expected).unwrap();
    assert_eq!(read_manifest(&path).unwrap(), expected);
    for mutation in 0..4 {
        let mut value = serde_json::to_value(&expected).unwrap();
        match mutation {
            0 => value["prepared"]["requests"][0]["cues"][0]["text"] = json!("Changed."),
            1 => value["planDigest"] = json!(sha256_bytes(b"different")),
            2 => {
                value["prepared"]["requests"][0]["unexpectedEndpoint"] =
                    json!("http://evil.invalid")
            }
            _ => value["caseId"] = json!("another-case"),
        }
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(read_manifest(&path).is_err());
    }
}
#[test]
fn init_cannot_reset_a_validation_root_and_report_contains_no_credentials() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("validation");
    let limits = BudgetLimits {
        per_job_microusd: 1_000_000,
        daily_microusd: 1_000_000,
        monthly_microusd: 2_000_000,
    };
    initialize(&root, 3_000_000, limits).unwrap();
    assert!(initialize(&root, 9_000_000, limits).is_err());
    let context = Context::open(&root).unwrap();
    assert!(Context::open(&root).is_err());
    let report = report(&context).unwrap();
    assert_eq!(report["validation"]["totalLimitMicrousd"], 3_000_000);
    let encoded = serde_json::to_string(&report).unwrap();
    for forbidden in [
        "private_key",
        "access_token",
        "client_email",
        "credential_id",
        "key-file",
    ] {
        assert!(!encoded.contains(forbidden));
    }
}

#[test]
fn report_binds_selected_term_proficiency_and_frozen_request_body_without_key_access() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("validation");
    initialize(
        &root,
        3_000_000,
        BudgetLimits {
            per_job_microusd: 1_000_000,
            daily_microusd: 1_000_000,
            monthly_microusd: 2_000_000,
        },
    )
    .unwrap();
    let context = Context::open(&root).unwrap();
    let task = RequestTask::Explanation {
        term: "Hello".into(),
        learning_language: "en".into(),
        explanation_language: "ja".into(),
        proficiency: "A2".into(),
        cues: vec![surtitle_ai::SourceCue {
            id: "cue-one".into(),
            start_ms: 0,
            end_ms: 1000,
            text: "Hello.".into(),
        }],
    };
    let prepared = make_plan(
        "text-quality".into(),
        "fixture-project".into(),
        "fixture-key-never-opened".into(),
        task,
        manifest().prepared.execution,
        None,
    )
    .unwrap();
    let expected_hash =
        sha256_bytes(&serde_json::to_vec(prepared.request_body_snapshot(0).unwrap()).unwrap());
    let quote = context.store.prepare(prepared.clone()).unwrap();
    let manifest = Manifest {
        schema_version: 2,
        job_id: quote.id.clone(),
        case_id: "text-quality".into(),
        plan_digest: quote.digest,
        prepared,
        max_audio_seconds: None,
    };
    write_json_new(&manifest_path(&root, &quote.id).unwrap(), &manifest).unwrap();
    let report = report(&context).unwrap();
    assert_eq!(report["requests"][0]["term"], "Hello");
    assert_eq!(report["requests"][0]["proficiency"], "A2");
    assert_eq!(report["requests"][0]["requestBodySha256"], expected_hash);
    assert_eq!(report["validation"]["attemptedRequests"], 0);
    assert!(!report.to_string().contains("fixture-key-never-opened"));
    assert!(context.vault.list().unwrap().is_empty());
}
#[test]
fn exact_new_charge_approval_and_explicit_retry_are_required() {
    let directory = tempfile::tempdir().unwrap();
    let store = AiStore::open(directory.path().join("charges.sqlite")).unwrap();
    let mut manifest = manifest();
    let quote = store.prepare(manifest.prepared.clone()).unwrap();
    manifest.job_id = quote.id.clone();
    let cost = quote.additional_reservation_microusd;
    assert!(validate_charge_approval(&manifest, &quote, &quote.digest, cost, false).is_ok());
    assert!(
        validate_charge_approval(&manifest, &quote, &quote.digest, cost.map(|n| n + 1), false)
            .is_err()
    );
    assert!(validate_charge_approval(&manifest, &quote, "wrong-digest", cost, false).is_err());
    let mut retry_quote = quote.clone();
    retry_quote.state = "needs_review".into();
    assert!(validate_charge_approval(&manifest, &retry_quote, &quote.digest, cost, false).is_err());
    assert!(validate_charge_approval(&manifest, &retry_quote, &quote.digest, cost, true).is_ok());
    retry_quote.completed_requests = 1;
    assert!(validate_charge_approval(&manifest, &retry_quote, &quote.digest, cost, true).is_err());
}
#[test]
fn audio_duration_comes_from_pcm_data_and_cannot_be_declared_by_caller() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("日本語 & clip.wav");
    fs::write(&path, wav(16001)).unwrap();
    assert_eq!(read_wav(&path, 30).unwrap().1, 1001);
    fs::write(&path, wav(30 * 16000)).unwrap();
    assert_eq!(read_wav(&path, 30).unwrap().1, 30_000);
    fs::write(&path, wav(30 * 16000 + 1)).unwrap();
    assert!(read_wav(&path, 30).is_err());
    let mut wrong_format = wav(1000);
    wrong_format[22] = 2;
    fs::write(&path, wrong_format).unwrap();
    assert!(read_wav(&path, 30).is_err());
    let mut truncated = wav(1000);
    truncated.pop();
    fs::write(&path, truncated).unwrap();
    assert!(read_wav(&path, 30).is_err());
}

#[test]
fn replaced_staged_audio_cannot_pair_a_new_identity_with_the_measured_duration() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("staged.wav");
    let store = AiStore::open(directory.path().join("charges.sqlite")).unwrap();
    fs::write(&path, wav(16000)).unwrap();
    let (measured, duration) = read_wav(&path, 30).unwrap();
    assert_eq!(duration, 1000);
    let expected = bind_measured_audio(path.clone(), &measured, duration).unwrap();
    assert_eq!(expected.sha256, sha256_bytes(&measured));
    let mut same_size_replacement = measured.clone();
    *same_size_replacement.last_mut().unwrap() = 1;
    for replacement in [wav(30 * 16000), same_size_replacement] {
        // Simulate a replacement after staging but before attachment creation.
        fs::write(&path, replacement).unwrap();
        let admission = bind_measured_audio(path.clone(), &measured, duration)
            .and_then(|audio| {
                make_plan(
                    "replaced-audio".into(),
                    "fixture-project".into(),
                    "fixture-key".into(),
                    RequestTask::TranscribePreview {
                        language: "en-US".into(),
                        audio,
                    },
                    manifest().prepared.execution,
                    Some(30),
                )
            })
            .and_then(|plan| store.prepare(plan).map_err(ai_error));
        assert!(admission.is_err());
        assert!(store.list_jobs().unwrap().is_empty());
        assert_eq!(store.summary().unwrap().monthly_actual_charged_microusd, 0);
    }
}

#[test]
fn measured_long_audio_and_explicit_ceiling_are_bound_to_manifest_and_quote() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("long.wav");
    for seconds in [90, 120, 180, 240] {
        fs::write(&path, wav(seconds * 16000)).unwrap();
        let (bytes, duration) = read_wav(&path, seconds as u32).unwrap();
        assert_eq!(duration, seconds as u64 * 1000);
        assert!(read_wav(&path, seconds as u32 - 1).is_err());
        assert!(bind_measured_audio(path.clone(), &bytes, duration).is_ok());
    }
    let (bytes, duration) = read_wav(&path, 240).unwrap();
    let task = RequestTask::AudioTranscription {
        language: "en".into(),
        audio: bind_measured_audio(path.clone(), &bytes, duration).unwrap(),
    };
    let prepared = make_plan(
        "long".into(),
        "project".into(),
        "key".into(),
        task.clone(),
        manifest().prepared.execution,
        Some(240),
    )
    .unwrap();
    assert_eq!(prepared.estimates().unwrap()[0].audio_duration_ms, 240_000);
    assert!(settings_digest(&task, Some(239)).is_err());
    let manifest = Manifest {
        schema_version: 2,
        job_id: "job".into(),
        case_id: "long".into(),
        plan_digest: prepared.digest().unwrap(),
        prepared,
        max_audio_seconds: Some(240),
    };
    let manifest_path = directory.path().join("manifest.json");
    write_json_new(&manifest_path, &manifest).unwrap();
    assert_eq!(read_manifest(&manifest_path).unwrap(), manifest);
    let mut changed = serde_json::to_value(&manifest).unwrap();
    changed.as_object_mut().unwrap().remove("maxAudioSeconds");
    fs::write(&manifest_path, serde_json::to_vec(&changed).unwrap()).unwrap();
    assert!(read_manifest(&manifest_path).is_err());
    fs::write(&path, wav(240 * 16000 + 1)).unwrap();
    assert!(read_wav(&path, 240).is_err());
    for invalid in ["0", "241", "-1", "1.5", "", "999999999999"] {
        assert!(parse_audio_seconds(invalid).is_err());
    }
}

#[tokio::test]
async fn metadata_commands_reject_transport_override_before_opening_any_data() {
    let directory = tempfile::tempdir().unwrap();
    for command in ["list-models", "lookup-price"] {
        let mut arguments: Vec<OsString> = vec![
            command.into(),
            "--data-root".into(),
            directory.path().as_os_str().into(),
            "--credential-id".into(),
            "unused".into(),
            "--location".into(),
            "global".into(),
        ];
        if command == "lookup-price" {
            arguments.extend(["--model-id".into(), "gemini-explicit".into()]);
        }
        arguments.extend(["--endpoint".into(), "http://invalid.example".into()]);
        assert!(run(arguments).await.unwrap_err().contains("Unrecognized"));
        assert!(!directory.path().join("instance.lock").exists());
    }
}
