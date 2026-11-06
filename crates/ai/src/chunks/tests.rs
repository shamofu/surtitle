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

fn quality_options() -> ChunkOptions {
    ChunkOptions {
        minimum_ms: 15_000,
        target_ms: 25_000,
        search_end_ms: 30_000,
        hard_maximum_ms: 30_000,
        context_ms: 0,
        ..ChunkOptions::default()
    }
}

fn whole_recording_options() -> ChunkOptions {
    ChunkOptions {
        minimum_ms: 120_000,
        target_ms: 210_000,
        search_end_ms: 240_000,
        hard_maximum_ms: 240_000,
        context_ms: 0,
        ..ChunkOptions::default()
    }
}

#[test]
fn openai_file_plan_keeps_the_entire_selection_without_duration_cuts() {
    let profile = serde_json::from_str("\"openai_file\"").unwrap();
    let options = ChunkOptions::for_profile(profile);
    let start = sm(31) + 5;
    let end = start + sm(360_000) + 7;
    let chunks = plan_chunks(start, end, &[pause(179_500, 180_500)], options).unwrap();
    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0].request_start_sample, start);
    assert_eq!(chunks[0].request_end_sample, end);
    assert_eq!(chunks[0].boundary, BoundaryKind::EndOfSelection);
    chunks[0]
        .boundary_provenance
        .as_ref()
        .unwrap()
        .validate()
        .unwrap();
    assert_eq!(total_request_samples(&chunks).unwrap(), end - start);
    let restored = serde_json::from_slice(&serde_json::to_vec(&options).unwrap()).unwrap();
    assert_eq!(plan_chunks(start, end, &[], restored).unwrap(), chunks);
}

#[test]
fn openai_silence_file_profile_is_distinct_but_still_plans_the_whole_selection() {
    let profile: AudioChunkProfile = serde_json::from_str("\"openai_file_silence\"").unwrap();
    let options = ChunkOptions::for_profile(profile);
    assert_ne!(
        options,
        ChunkOptions::for_profile(AudioChunkProfile::OpenAiFile)
    );
    assert_eq!(options.profile(), Some(profile));
    let chunks = plan_chunks(123, 16_000 * 3600 + 7, &[], options).unwrap();
    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0].request_start_sample, 123);
    assert_eq!(chunks[0].request_end_sample, 16_000 * 3600 + 7);
    assert_eq!(chunks[0].boundary, BoundaryKind::EndOfSelection);
}

#[test]
fn quality_240_keeps_a_207_second_recording_in_one_complete_request() {
    let options = whole_recording_options();
    let start = sm(17) + 5;
    for duration_ms in [206_560, 207_000, 240_000] {
        let end = start + sm(duration_ms);
        let chunks = plan_chunks(start, end, &[pause(119_000, 121_000)], options).unwrap();
        assert_eq!(chunks.len(), 1);
        let chunk = &chunks[0];
        assert_eq!(chunk.request_start_sample, start);
        assert_eq!(chunk.request_end_sample, end);
        assert_eq!(chunk.request_duration_ms(), duration_ms);
        assert_eq!(chunk.boundary, BoundaryKind::EndOfSelection);
        chunk
            .boundary_provenance
            .as_ref()
            .unwrap()
            .validate()
            .unwrap();
        assert_eq!(total_request_samples(&chunks).unwrap(), end - start);
    }
    let profile = options.profile().unwrap();
    assert_eq!(
        serde_json::to_value(profile).unwrap(),
        "quality_240_seconds"
    );
    assert_eq!(ChunkOptions::for_profile(profile), options);
    assert_eq!(
        serde_json::from_str::<AudioChunkProfile>("\"quality_240_seconds\"").unwrap(),
        profile
    );
}

#[test]
fn quality_240_bounds_long_recordings_without_overlap_and_freezes_guarded_cuts() {
    let end = sm(480_000) + 1;
    for pauses in [
        vec![],
        vec![pause(209_500, 210_500)],
        vec![pause(239_950, 240_200)],
    ] {
        let chunks = plan_chunks(0, end, &pauses, whole_recording_options()).unwrap();
        assert_eq!(chunks.first().unwrap().request_start_sample, 0);
        assert_eq!(chunks.last().unwrap().request_end_sample, end);
        assert_eq!(total_request_samples(&chunks).unwrap(), end);
        assert!(chunks
            .windows(2)
            .all(|pair| pair[0].request_end_sample == pair[1].request_start_sample));
        for chunk in &chunks {
            assert!(chunk.request_duration_ms() <= 240_000);
            assert_eq!(chunk.request_start_sample, chunk.core_start_sample);
            assert_eq!(chunk.request_end_sample, chunk.core_end_sample);
            let evidence = chunk.boundary_provenance.as_ref().unwrap();
            evidence.validate().unwrap();
            assert_eq!(evidence.as_chunk(chunk.index), *chunk);
        }
        if pauses.first() == Some(&pause(209_500, 210_500)) {
            assert_eq!(chunks[0].boundary, BoundaryKind::StrongPause);
            assert_eq!(chunks[0].core_end_sample, sm(210_000));
        } else {
            assert_eq!(chunks[0].boundary, BoundaryKind::Forced);
            assert_eq!(chunks[0].core_end_sample, sm(240_000));
        }
    }
}

#[test]
fn quality_240_does_not_relax_legacy_or_arbitrary_chunk_limits() {
    let end = sm(206_560);
    let chunks = plan_chunks(0, end, &[], ChunkOptions::default()).unwrap();
    assert_eq!(chunks.len(), 2);
    assert_eq!(chunks[0].core_end_sample, sm(180_000));
    assert_eq!(chunks[0].request_end_sample, sm(183_000));
    assert_eq!(chunks[1].request_start_sample, sm(177_000));
    assert_eq!(total_request_samples(&chunks).unwrap(), end + sm(6000));
    assert!(chunks
        .iter()
        .all(|chunk| chunk.boundary_provenance.is_none()));
    for options in [
        ChunkOptions {
            hard_maximum_ms: 180_001,
            ..ChunkOptions::default()
        },
        ChunkOptions {
            hard_maximum_ms: 240_001,
            ..whole_recording_options()
        },
        ChunkOptions {
            context_ms: 1,
            ..whole_recording_options()
        },
        ChunkOptions {
            sample_rate: 8000,
            ..whole_recording_options()
        },
        ChunkOptions {
            target_ms: 209_999,
            ..whole_recording_options()
        },
        ChunkOptions {
            strong_pause_ms: 501,
            ..whole_recording_options()
        },
    ] {
        assert!(plan_chunks(0, end, &[], options).is_err());
    }
}

#[test]
fn quality_cuts_reject_pause_edges_without_one_hundred_ms_on_each_side() {
    for evidence in [pause(29_950, 30_600), pause(14_850, 15_050)] {
        let chunks = plan_chunks(0, sm(65_000), &[evidence], quality_options()).unwrap();
        assert_eq!(chunks[0].core_end_sample, sm(30_000));
        assert_eq!(chunks[0].boundary, BoundaryKind::Forced);
    }
}

#[test]
fn adjacent_sample_ranges_do_not_gain_overlap_from_millisecond_rounding() {
    let chunks = plan_chunks(0, sm(45_000), &[pause(24_900, 25_101)], quality_options()).unwrap();
    assert_eq!(chunks[0].request_end_sample, chunks[1].request_start_sample);
    let transcripts = chunks
        .into_iter()
        .enumerate()
        .map(|(index, chunk)| ChunkTranscript {
            chunk,
            segments: vec![TimedText {
                start_ms: if index == 0 { 24_000 } else { 25_000 },
                end_ms: if index == 0 { 25_001 } else { 26_000 },
                text: if index == 0 { "before" } else { "after" }.into(),
                ..Default::default()
            }],
        })
        .collect();
    let stitched = stitch_chunks(transcripts).unwrap();
    assert!(stitched.boundary_conflicts.is_empty());
    assert_eq!(stitched.segments.len(), 2);
}

#[test]
fn adjacent_sample_ranges_keep_distinct_cues_with_the_same_rounded_millisecond() {
    let chunks = plan_chunks(0, sm(45_000), &[pause(24_900, 25_101)], quality_options()).unwrap();
    let transcripts = chunks
        .into_iter()
        .map(|chunk| ChunkTranscript {
            chunk,
            segments: vec![TimedText {
                start_ms: 25_000,
                end_ms: 25_001,
                text: "a".into(),
                ..Default::default()
            }],
        })
        .collect();
    let stitched = stitch_chunks(transcripts).unwrap();
    assert!(stitched.boundary_conflicts.is_empty());
    assert_eq!(stitched.segments.len(), 2);
}

#[test]
fn quality_profiles_preserve_every_sample_once_with_guarded_pause_provenance() {
    let start = sm(17) + 5;
    let end = start + sm(65_000) + 7;
    for (profile, target_ms, max_ms) in [
        (AudioChunkProfile::Quality30Seconds, 25_000, 30_000),
        (AudioChunkProfile::Quality15Seconds, 12_000, 15_000),
    ] {
        let options = ChunkOptions::for_profile(profile);
        for pauses in [
            vec![],
            vec![Pause {
                start_sample: start,
                end_sample: end,
            }],
            vec![Pause {
                start_sample: start + sm(target_ms - 100),
                end_sample: start + sm(target_ms + 100),
            }],
        ] {
            let chunks = plan_chunks(start, end, &pauses, options).unwrap();
            assert_eq!(chunks.first().unwrap().request_start_sample, start);
            assert_eq!(chunks.last().unwrap().request_end_sample, end);
            assert_eq!(total_request_samples(&chunks).unwrap(), end - start);
            assert!(chunks
                .windows(2)
                .all(|pair| pair[0].request_end_sample == pair[1].request_start_sample));
            for chunk in &chunks {
                assert!(chunk.request_end_sample - chunk.request_start_sample <= sm(max_ms));
                assert_eq!(chunk.request_start_sample, chunk.core_start_sample);
                assert_eq!(chunk.request_end_sample, chunk.core_end_sample);
                let evidence = chunk.boundary_provenance.as_ref().unwrap();
                evidence.validate().unwrap();
                assert_eq!(evidence.as_chunk(chunk.index), *chunk);
                if let Some(pause) = evidence.supporting_pause {
                    assert!(chunk.core_end_sample - pause.start_sample >= 1600);
                    assert!(pause.end_sample - chunk.core_end_sample >= 1600);
                }
            }
            if !pauses.is_empty() {
                assert_eq!(chunks[0].core_end_sample, start + sm(target_ms));
            }
        }
    }
}

#[test]
fn legacy_chunk_json_round_trip_does_not_add_boundary_provenance() {
    assert!(serde_json::to_value(ChunkOptions::default())
        .unwrap()
        .get("maximum_file_bytes")
        .is_none());
    let legacy = r#"{"index":0,"sample_rate":16000,"core_start_sample":0,"core_end_sample":16000,"request_start_sample":0,"request_end_sample":16000,"boundary":"end_of_selection"}"#;
    let restored: AudioChunk = serde_json::from_str(legacy).unwrap();
    assert_eq!(serde_json::to_string(&restored).unwrap(), legacy);
    assert_eq!(
        plan_chunks(
            0,
            16000,
            &[],
            ChunkOptions::for_profile(AudioChunkProfile::Legacy)
        )
        .unwrap(),
        vec![restored]
    );
}

#[test]
fn openai_file_size_splits_preserve_every_sample_and_guarded_pause_evidence() {
    let start = sm(17) + 5;
    let end = start + sm(360_000) + 7;
    let whole = plan_chunks(
        start,
        end,
        &[],
        ChunkOptions::for_profile(AudioChunkProfile::OpenAiFile),
    )
    .unwrap()
    .remove(0);
    for pauses in [
        vec![],
        vec![pause(179_900, 180_100)],
        vec![pause(179_500, 180_500)],
        vec![pause(0, 1)],
    ] {
        let (left, right) = split_file_chunk(&whole, &pauses).unwrap();
        assert_eq!(left.request_start_sample, start);
        assert_eq!(left.request_end_sample, right.request_start_sample);
        assert_eq!(right.request_end_sample, end);
        assert_eq!(
            total_request_samples(&[left.clone(), right.clone()]).unwrap(),
            end - start
        );
        assert_eq!(right.boundary, BoundaryKind::EndOfSelection);
        for chunk in [&left, &right] {
            let evidence = chunk.boundary_provenance.as_ref().unwrap();
            evidence.validate().unwrap();
            let restored: AudioChunk =
                serde_json::from_slice(&serde_json::to_vec(chunk).unwrap()).unwrap();
            assert_eq!(&restored, chunk);
        }
        if let Some(pause) = left.boundary_provenance.as_ref().unwrap().supporting_pause {
            assert!(left.core_end_sample - pause.start_sample >= 1600);
            assert!(pause.end_sample - left.core_end_sample >= 1600);
        } else {
            assert_eq!(left.boundary, BoundaryKind::Forced);
        }
        let (a, b) = split_file_chunk(&left, &[]).unwrap();
        assert_eq!(b.boundary, left.boundary);
        assert_eq!(a.request_end_sample, b.request_start_sample);
        assert_eq!(b.request_end_sample, right.request_start_sample);
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
