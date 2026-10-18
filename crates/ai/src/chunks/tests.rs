use super::reconcile::same_spoken_interval;

use super::*;
fn sm(ms: u64) -> u64 {
    ms * 16
}
fn pause(start_ms: u64, end_ms: u64) -> Pause {
    Pause {
        start_sample: sm(start_ms),
        end_sample: sm(end_ms),
    }
}
#[test]
fn silence_near_target_wins_over_fixed_cut() {
    let p = plan_chunks(
        0,
        sm(400_000),
        &[pause(123_000, 124_000)],
        ChunkOptions::default(),
    )
    .unwrap();
    assert_eq!(p[0].core_end_sample, sm(123_500));
    assert_eq!(p[0].boundary, BoundaryKind::StrongPause);
}
#[test]
fn long_silence_offers_target_boundaries_instead_of_distant_midpoint() {
    let duration = 6 * 3600 * 1000;
    let chunks = plan_chunks(
        0,
        sm(duration),
        &[pause(0, duration)],
        ChunkOptions::default(),
    )
    .unwrap();
    assert_eq!(chunks[0].core_end_sample, sm(120_000));
    assert_eq!(chunks[0].boundary, BoundaryKind::StrongPause);
    assert!(chunks[..chunks.len() - 1]
        .iter()
        .all(|c| c.boundary == BoundaryKind::StrongPause));
    assert_eq!(chunks.last().unwrap().core_end_sample, sm(duration));
}
#[test]
fn extends_then_uses_weak_then_forces() {
    let a = plan_chunks(
        0,
        sm(400_000),
        &[pause(166_000, 167_000)],
        ChunkOptions::default(),
    )
    .unwrap();
    assert_eq!(a[0].core_end_sample, sm(166_500));
    let b = plan_chunks(
        0,
        sm(400_000),
        &[pause(125_000, 125_250)],
        ChunkOptions::default(),
    )
    .unwrap();
    assert_eq!(b[0].boundary, BoundaryKind::WeakPause);
    let c = plan_chunks(0, sm(400_000), &[], ChunkOptions::default()).unwrap();
    assert_eq!(c[0].core_end_sample, sm(180_000));
    assert_eq!(c[0].boundary, BoundaryKind::Forced);
}
#[test]
fn six_hours_preserves_every_sample_and_accounts_for_overlap() {
    let start = sm(37_345);
    let end = start + sm(6 * 3600 * 1000);
    let chunks = plan_chunks(start, end, &[], ChunkOptions::default()).unwrap();
    assert_eq!(chunks.first().unwrap().core_start_sample, start);
    assert_eq!(chunks.last().unwrap().core_end_sample, end);
    for p in chunks.windows(2) {
        assert_eq!(p[0].core_end_sample, p[1].core_start_sample);
    }
    assert!(chunks.iter().all(|c| c.request_duration_ms() <= 186_000));
    assert_eq!(
        total_request_samples(&chunks).unwrap(),
        end - start + sm(6000) * (chunks.len() as u64 - 1)
    );
}
#[test]
fn no_frame_padding_or_resets_shift_time() {
    let mut d = PauseDetector::new(16000).unwrap();
    for _ in 0..10 {
        d.push(0.9, 512).unwrap();
    }
    for _ in 0..10 {
        d.push(0.1, 512).unwrap();
    }
    d.push(0.9, 111).unwrap();
    assert_eq!(
        d.finish(),
        vec![Pause {
            start_sample: 5120,
            end_sample: 10240
        }]
    );
}
#[test]
fn invalid_nan_posterior_does_not_create_fake_silence() {
    let mut d = PauseDetector::new(16000).unwrap();
    assert!(d.push(f32::NAN, 512).is_err());
}
#[test]
fn short_selection_is_one_bounded_request() {
    let c = plan_chunks(sm(5000), sm(6000), &[], ChunkOptions::default()).unwrap();
    assert_eq!(c.len(), 1);
    assert_eq!(c[0].request_start_sample, sm(5000));
    assert_eq!(c[0].request_end_sample, sm(6000));
}
fn transcript_pair() -> Vec<ChunkTranscript> {
    let chunks = plan_chunks(
        0,
        sm(300_000),
        &[pause(119_500, 120_500)],
        ChunkOptions::default(),
    )
    .unwrap();
    chunks
        .into_iter()
        .map(|chunk| ChunkTranscript {
            chunk,
            segments: vec![],
        })
        .collect()
}
#[test]
fn natural_repeated_words_are_not_deleted() {
    let mut ts = transcript_pair();
    ts[0].segments = vec![
        TimedText {
            start_ms: 119_000,
            end_ms: 119_200,
            text: "no".into(),
            ..Default::default()
        },
        TimedText {
            start_ms: 119_300,
            end_ms: 119_500,
            text: "no".into(),
            ..Default::default()
        },
    ];
    ts[1].segments = vec![TimedText {
        start_ms: 120_100,
        end_ms: 120_300,
        text: "no".into(),
        ..Default::default()
    }];
    let out = stitch_chunks(ts).unwrap();
    assert_eq!(out.segments.len(), 3);
}
#[test]
fn duplicate_context_not_duplicate_sentence() {
    let mut ts = transcript_pair();
    let s = TimedText {
        start_ms: 119_000,
        end_ms: 121_000,
        text: "続けて説明します。".into(),
        ..Default::default()
    };
    ts[0].segments = vec![s.clone()];
    ts[1].segments = vec![s];
    let out = stitch_chunks(ts).unwrap();
    assert_eq!(out.segments.len(), 1);
    assert!(out.boundary_conflicts.is_empty());
}
#[test]
fn exact_overlap_preserves_word_boundaries_numbers_and_meaningful_symbols() {
    for (left, right) in [
        ("We are now here.", "We are nowhere."),
        ("Un café noir.", "Un cafénoir."),
        ("ré sumé", "résumé"),
        ("α β", "αβ"),
        ("시 험", "시험"),
        ("The value is 3.5.", "The value is 35."),
        ("The value is 3.5.", "The value is 3 5."),
        ("٣.٥", "٣ ٥"),
        ("３．５", "３ ５"),
        ("Pay $5.", "Pay 5."),
        ("It increased 20%.", "It increased 20."),
        ("The value is +2.", "The value is -2."),
        ("I can't leave.", "I cant leave."),
        ("They re-sign today.", "They resign today."),
    ] {
        let mut ts = transcript_pair();
        ts[0].segments = vec![cue(119_000, 121_000, left)];
        ts[1].segments = vec![cue(119_000, 121_000, right)];
        let expected: Vec<_> = ts.iter().flat_map(|t| t.segments.clone()).collect();
        let out = stitch_chunks(ts).unwrap();
        assert_eq!(out.boundary_conflicts.len(), 1, "{left} / {right}");
        assert_eq!(out.segments, expected[1..]);
        assert_eq!(out.boundary_conflicts[0].left_alternative, expected[..1]);
        assert_eq!(out.boundary_conflicts[0].right_alternative, expected[1..]);
    }
}
#[test]
fn presentation_punctuation_and_spacing_still_match_without_losing_repetitions() {
    let mut ts = transcript_pair();
    ts[0].segments = vec![cue(119_000, 121_000, "No,  no! It is 3.5%.")];
    ts[1].segments = vec![cue(119_000, 121_000, "no no; it is 3.5%")];
    let out = stitch_chunks(ts).unwrap();
    assert!(out.boundary_conflicts.is_empty());
    assert_eq!(out.segments.len(), 1);
    assert_eq!(out.segments[0].text, "no no; it is 3.5%");
    assert!(same_spoken_interval(
        &cue(1, 10, "Un CAFÉ noir."),
        &cue(1, 10, "un cafe\u{301} noir")
    ));
}
fn cue(start_ms: u64, end_ms: u64, text: &str) -> TimedText {
    TimedText {
        start_ms,
        end_ms,
        text: text.into(),
        ..Default::default()
    }
}
#[test]
fn request_edge_fragments_keep_complete_counterparts_and_original_times() {
    let mut ts = transcript_pair();
    ts[0].segments = vec![
        cue(115_000, 118_020, "They waited for the train."),
        cue(119_000, 121_000, "No, no, no."),
        cue(122_000, 122_900, "After early"),
    ];
    ts[1].segments = vec![
        cue(117_100, 118_000, "the train."),
        cue(119_050, 121_050, "No, no, no."),
        cue(122_020, 126_000, "After early nightfall, we left."),
    ];
    let originals = ts.clone();
    let out = stitch_chunks(ts).unwrap();
    assert!(out.boundary_conflicts.is_empty());
    assert_eq!(out.segments.len(), 3);
    assert_eq!(out.segments[0], originals[0].segments[0]);
    assert_eq!(out.segments[2], originals[1].segments[2]);
    assert_eq!(out.segments[1].text, "No, no, no.");
}
#[test]
fn fragment_matching_requires_transport_edge_lexical_boundary_and_intact_time() {
    for (fragment, full) in [
        (
            cue(120_000, 121_000, "we can"),
            cue(120_000, 126_000, "we can leave"),
        ),
        (
            cue(122_000, 122_900, "we can"),
            cue(122_000, 126_000, "we cannot leave"),
        ),
        (
            cue(120_000, 122_900, "we can"),
            cue(122_000, 126_000, "we can leave"),
        ),
        (
            cue(122_000, 122_900, "it increased 20%"),
            cue(122_000, 126_000, "it increased 20 yesterday"),
        ),
        (
            cue(122_000, 122_900, "the value is 3.5"),
            cue(122_000, 126_000, "the value is 3 5 today"),
        ),
    ] {
        let mut ts = transcript_pair();
        ts[0].segments = vec![fragment.clone()];
        ts[1].segments = vec![full.clone()];
        let out = stitch_chunks(ts).unwrap();
        assert_eq!(out.boundary_conflicts.len(), 1);
        assert_eq!(out.segments, vec![fragment, full]);
    }
}
#[test]
fn matched_fragment_does_not_hide_a_separate_contradiction_or_lose_repeats() {
    let mut ts = transcript_pair();
    ts[0].segments = vec![
        cue(119_000, 120_000, "a cat"),
        cue(122_000, 122_900, "no no"),
    ];
    ts[1].segments = vec![
        cue(119_000, 120_000, "a cap"),
        cue(122_000, 126_000, "no no no"),
    ];
    let out = stitch_chunks(ts).unwrap();
    assert_eq!(out.boundary_conflicts.len(), 1);
    assert_eq!(out.segments.len(), 3);
    assert!(out.segments.iter().any(|cue| cue.text == "a cat"));
    assert!(!out.segments.iter().any(|cue| cue.text == "a cap"));
    assert_eq!(out.boundary_conflicts[0].left_alternative[1].text, "no no");
    assert_eq!(
        out.boundary_conflicts[0].right_alternative[1].text,
        "no no no"
    );
}
#[test]
fn japanese_punctuation_does_not_hide_particle_changes() {
    assert!(same_spoken_interval(
        &cue(1, 10, "大声で、泣いた。"),
        &cue(1, 10, "大声で泣いた。")
    ));
    let mut ts = transcript_pair();
    ts[0].segments = vec![cue(115_000, 118_000, "血圧は重要である。")];
    ts[1].segments = vec![cue(117_100, 118_000, "が重要である。")];
    assert_eq!(stitch_chunks(ts).unwrap().boundary_conflicts.len(), 1);
}
const SHARED: &str = "alpha beta gamma delta epsilon zeta eta theta";
fn group_pair() -> Vec<ChunkTranscript> {
    let mut ts = transcript_pair();
    ts[0].segments = vec![cue(115_000, 122_800, &format!("Before we paused {SHARED}"))];
    ts[1].segments = vec![cue(
        117_100,
        126_000,
        &format!("{SHARED} after we continued."),
    )];
    ts
}
#[test]
fn complementary_groups_preserve_observed_endpoints_and_join_provenance() {
    for split_left in [false, true] {
        let mut ts = group_pair();
        if split_left {
            ts[0].segments = vec![
                cue(115_000, 119_000, "Before we paused alpha beta gamma"),
                cue(119_300, 122_800, "delta epsilon zeta eta theta"),
            ];
        } else {
            ts[1].segments = vec![
                cue(117_100, 120_000, "alpha beta gamma delta"),
                cue(
                    120_300,
                    126_000,
                    "epsilon zeta eta theta after we continued.",
                ),
            ];
        }
        let originals = ts.clone();
        let out = stitch_chunks(ts).unwrap();
        assert!(out.boundary_conflicts.is_empty());
        assert_eq!(
            out.segments,
            vec![cue(
                115_000,
                126_000,
                &format!("Before we paused {SHARED} after we continued.")
            )]
        );
        assert_eq!(out.group_joins.len(), 1);
        let proof = &out.group_joins[0];
        assert_eq!(
            proof.left_segment_indices.len(),
            originals[0].segments.len()
        );
        assert_eq!(
            proof.right_segment_indices.len(),
            originals[1].segments.len()
        );
        assert_eq!(proof.overlap_units, 8);
        assert_eq!(proof.joined, out.segments[0]);
    }
}
#[test]
fn group_join_retains_natural_repetitions_but_rejects_ambiguous_overlap() {
    let phrase = "the words the words of a story bring us hope";
    let mut ts = group_pair();
    ts[0].segments[0].text = format!("Before we paused {phrase}");
    ts[1].segments[0].text = format!("{phrase} after we continued.");
    let out = stitch_chunks(ts).unwrap();
    assert_eq!(out.group_joins.len(), 1);
    assert_eq!(out.segments[0].text.matches("the words").count(), 2);
    let mut repeated = group_pair();
    repeated[0].segments[0].text = format!("Before {SHARED} then {SHARED}");
    assert_eq!(stitch_chunks(repeated).unwrap().boundary_conflicts.len(), 1);
    let mut ambiguous = group_pair();
    ambiguous[0].segments[0].text = "Before alpha beta gamma delta alpha beta gamma delta".into();
    ambiguous[1].segments[0].text = "alpha beta gamma delta alpha beta gamma delta after".into();
    assert_eq!(
        stitch_chunks(ambiguous).unwrap().boundary_conflicts.len(),
        1
    );
}
#[test]
fn group_join_rejects_short_nonedge_contradictory_and_inconsistent_evidence() {
    let mut cases = Vec::new();
    let mut short = group_pair();
    short[0].segments[0].text = "Before one two three".into();
    short[1].segments[0].text = "one two three after".into();
    cases.push(short);
    let mut edge = group_pair();
    edge[0].segments[0].end_ms = 121_000;
    cases.push(edge);
    let mut changed = group_pair();
    changed[1].segments[0].text = "alpha beta wrong delta epsilon zeta eta theta after".into();
    cases.push(changed);
    let mut extra = group_pair();
    extra[0]
        .segments
        .insert(0, cue(114_000, 117_200, "Unmatched claim."));
    cases.push(extra);
    let mut timing = group_pair();
    timing[1].segments = vec![
        cue(117_100, 123_900, "alpha beta gamma delta"),
        cue(124_000, 126_000, "epsilon zeta eta theta after"),
    ];
    cases.push(timing);
    for ts in cases {
        let count = ts.iter().map(|c| c.segments.len()).sum::<usize>();
        let out = stitch_chunks(ts).unwrap();
        assert_eq!(out.boundary_conflicts.len(), 1);
        assert!(out.group_joins.is_empty());
        assert_eq!(out.segments.len(), count);
    }
}
#[test]
fn group_join_uses_the_same_number_and_symbol_evidence_as_exact_matching() {
    let shared = "alpha beta gamma delta epsilon zeta eta theta costs $3.5";
    let mut original = group_pair();
    original[0].segments[0].text = format!("Before {shared}");
    original[1].segments[0].text = format!("{shared} after we continued.");
    let matched = stitch_chunks(original.clone()).unwrap();
    assert!(matched.boundary_conflicts.is_empty());
    assert_eq!(matched.group_joins.len(), 1);
    assert_eq!(
        matched.segments[0],
        cue(
            115_000,
            126_000,
            &format!("Before {shared} after we continued.")
        )
    );
    for altered in ["costs 3.5", "costs $3 5", "costs $35"] {
        let mut changed = original.clone();
        changed[1].segments[0].text = changed[1].segments[0].text.replace("costs $3.5", altered);
        let expected: Vec<_> = changed.iter().flat_map(|t| t.segments.clone()).collect();
        let out = stitch_chunks(changed).unwrap();
        assert_eq!(out.boundary_conflicts.len(), 1);
        assert!(out.group_joins.is_empty());
        assert_eq!(out.segments, expected);
    }
    let mut short = group_pair();
    short[0].segments[0].text = "Before alpha beta + $3.5 % gamma".into();
    short[1].segments[0].text = "alpha beta + $3.5 % gamma after".into();
    let out = stitch_chunks(short).unwrap();
    assert_eq!(out.boundary_conflicts.len(), 1);
    assert!(out.group_joins.is_empty());
}
#[test]
fn brief_unmatched_context_is_retained_without_inferring_silence() {
    let mut ts = transcript_pair();
    let omitted = cue(115_000, 117_060, "Keep the earlier sentence.");
    let common = cue(119_000, 121_000, "They agreed on this sentence.");
    ts[0].segments = vec![omitted.clone(), common.clone()];
    ts[1].segments = vec![common];
    let out = stitch_chunks(ts).unwrap();
    assert_eq!(out.boundary_conflicts.len(), 1);
    assert_eq!(out.boundary_conflicts[0].left_alternative[0], omitted);
    assert!(out.segments.contains(&omitted));
}
#[test]
fn conflicts_retain_both_source_versions() {
    let mut ts = transcript_pair();
    ts[0].segments = vec![TimedText {
        start_ms: 119_000,
        end_ms: 120_000,
        text: "a cat".into(),
        ..Default::default()
    }];
    ts[1].segments = vec![TimedText {
        start_ms: 119_000,
        end_ms: 120_000,
        text: "a cap".into(),
        ..Default::default()
    }];
    let out = stitch_chunks(ts).unwrap();
    assert_eq!(out.boundary_conflicts.len(), 1);
    assert_eq!(out.boundary_conflicts[0].right_alternative[0].text, "a cap");
}
#[test]
fn gaps_in_input_timeline_are_rejected() {
    let mut ts = transcript_pair();
    ts[1].chunk.core_start_sample += 100;
    assert!(stitch_chunks(ts).is_err());
}
