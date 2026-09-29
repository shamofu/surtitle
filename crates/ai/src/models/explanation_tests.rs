use super::*;
fn task() -> RequestTask {
    RequestTask::Explanation {
        term: "look forward to".into(),
        learning_language: "en".into(),
        explanation_language: "ja".into(),
        proficiency: "B1".into(),
        cues: vec![
            SourceCue {
                id: "cue".into(),
                start_ms: 0,
                end_ms: 1000,
                text: "I look forward to it.".into(),
            },
            SourceCue {
                id: "other".into(),
                start_ms: 1000,
                end_ms: 2000,
                text: "Thanks.".into(),
            },
        ],
    }
}
fn output(term: &str, ids: Vec<&str>) -> String {
    json!({"items":[{"term":term,"meaning":"楽しみにする","explanation":"Contextual explanation","example":"I look forward to the trip.","sourceCueIds":ids}]}).to_string()
}
#[test]
fn term_and_proficiency_are_bound_to_request() {
    let t = task();
    t.validate().unwrap();
    let body = t.body(None).unwrap();
    let prompt = body["contents"][0]["parts"][0]["text"].as_str().unwrap();
    assert!(prompt.contains("B1"));
    assert!(parse_output(&t, &output("look forward to", vec!["cue"])).is_ok());
}
#[test]
fn invented_term_or_citation_is_rejected() {
    let t = task();
    for raw in [
        output("look after", vec!["cue"]),
        output("look forward to", vec!["invented"]),
        output("look forward to", vec!["other"]),
    ] {
        assert!(parse_output(&t, &raw).is_err());
    }
}
#[test]
fn absent_selected_term_cannot_be_quoted() {
    let mut t = task();
    if let RequestTask::Explanation { term, .. } = &mut t {
        *term = "unrelated".into();
    }
    assert!(t.estimate(0).is_err());
}
#[test]
fn split_expression_requires_every_contributing_cue_without_relaxing_citations() {
    let t = RequestTask::Explanation {
        term: "look forward to".into(),
        learning_language: "en".into(),
        explanation_language: "ja".into(),
        proficiency: "A2".into(),
        cues: vec![
            SourceCue {
                id: "T02-en-19".into(),
                start_ms: 0,
                end_ms: 1000,
                text: "We can still look".into(),
            },
            SourceCue {
                id: "T02-en-20".into(),
                start_ms: 1000,
                end_ms: 2000,
                text: "forward to the trip, even though it has been delayed.".into(),
            },
        ],
    };
    t.validate().unwrap();
    let body = t.body(None).unwrap();
    let request: Value =
        serde_json::from_str(body["contents"][0]["parts"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(request["term"], "look forward to");
    assert_eq!(request["proficiency"], "A2");
    assert_eq!(request["subtitles"][0]["text"], "We can still look");
    assert_eq!(
        request["subtitles"][1]["text"],
        "forward to the trip, even though it has been delayed."
    );
    assert!(parse_output(
        &t,
        &output("look forward to", vec!["T02-en-19", "T02-en-20"])
    )
    .is_ok());
    for citations in [
        vec!["T02-en-19"],
        vec!["T02-en-20"],
        vec!["T02-en-19", "unknown"],
    ] {
        assert!(parse_output(&t, &output("look forward to", citations)).is_err());
    }
}
