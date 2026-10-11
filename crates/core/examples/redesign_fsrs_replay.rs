//! Offline comparison of the persisted application scheduler and latest-stable
//! FSRS API. Writes only an explicitly supplied evaluation directory.
use anyhow::{Context, Result, ensure};
use chrono::{Duration, TimeZone, Utc};
use surtitle_core::{Store, StudyCard};

fn main() -> Result<()> {
    let output = std::path::PathBuf::from(
        std::env::args_os()
            .nth(1)
            .context("evaluation output directory required")?,
    );
    std::fs::create_dir_all(&output)?;
    let temp = tempfile::tempdir_in(&output)?;
    let mut app = Store::open(temp.path().join("learning.sqlite"))?;
    let mut rows = Vec::new();
    let began = std::time::Instant::now();
    for (case, intervals, ratings) in [
        ("steady", vec![0, 1, 3, 7, 14, 30, 60, 120], vec!["good"; 8]),
        (
            "lapse",
            vec![0, 1, 2, 0, 1, 4, 30, 90],
            vec![
                "good", "hard", "again", "good", "good", "easy", "again", "good",
            ],
        ),
        (
            "overdue",
            vec![0, 14, 90, 365, 700],
            vec!["easy", "good", "hard", "again", "good"],
        ),
    ] {
        for retention in [0.7_f32, 0.9, 0.97] {
            let id = format!("{case}-{retention}");
            let card: StudyCard = serde_json::from_value(serde_json::json!({
                "id":id,"mediaId":"fixture","segmentId":"fixture-cue","term":"phrase","meaning":"fixture meaning",
                "example":"Fixture example.","language":"en","dueAt":"2026-01-01T00:00:00Z","createdAt":"2026-01-01T00:00:00Z",
                "reviewCount":0,"audioPath":"fixture-audio.wav","suspended":false,
            }))?;
            app.put_card(&card)?;
            let mut at = Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap();
            let mut candidate_memory = None;
            for (ordinal, (&days, &rating)) in intervals.iter().zip(&ratings).enumerate() {
                at += if days == 0 && ordinal > 0 {
                    Duration::minutes(1)
                } else {
                    Duration::days(days)
                };
                let states =
                    fsrs::FSRS::default().next_states(candidate_memory, retention, days as u32)?;
                let candidate = match rating {
                    "again" => states.again,
                    "hard" => states.hard,
                    "easy" => states.easy,
                    _ => states.good,
                };
                let due = at
                    + if rating == "again" {
                        Duration::minutes(1)
                    } else {
                        Duration::days(candidate.interval.round().clamp(1., 36500.) as i64)
                    };
                let actual = app.rate_card(&id, rating, retention, at)?;
                let memory = actual.memory.unwrap();
                ensure!(actual.due_at == due.to_rfc3339(), "due date mismatch");
                ensure!(
                    memory.stability == candidate.memory.stability
                        && memory.difficulty == candidate.memory.difficulty,
                    "memory mismatch"
                );
                ensure!(actual.audio_path == card.audio_path, "review lost audio");
                candidate_memory = Some(candidate.memory);
                rows.push(serde_json::json!({"case":case,"retention":retention,"ordinal":ordinal,"rating":rating,"elapsedDays":days,
                    "dueAt":actual.due_at,"stability":memory.stability,"difficulty":memory.difficulty,"match":true}));
            }
        }
    }
    let before = app.archive()?;
    let expected_reviews = serde_json::to_value(&before.reviews)?;
    let expected_cards = serde_json::to_value(&before.cards)?;
    let path = app.path.clone();
    drop(app);
    let reopened = Store::open(path)?;
    let after = reopened.archive()?;
    ensure!(
        serde_json::to_value(&after.reviews)? == expected_reviews,
        "reopen changed review history"
    );
    ensure!(
        serde_json::to_value(&after.cards)? == expected_cards,
        "reopen changed card memory"
    );
    let report = serde_json::json!({"baseline":"app Store::rate_card, fsrs 6.6.2","candidate":"latest-stable fsrs 6.6.2 direct API",
        "latestVerifiedAt":"2026-10-11","latestSource":"https://docs.rs/fsrs/latest/fsrs/","sameVersion":true,
        "input":"synthetic fixtures; no user review history loaded","cards":after.cards.len(),
        "reviewRows":after.reviews.len(),"matchedTransitions":rows.len(),"mismatches":0,"historyPreservedAfterReopen":true,
        "elapsedMs":began.elapsed().as_secs_f64()*1000.,"rows":rows,
        "conclusion":"No newer stable candidate exists. Preserve FSRS and review history; this proves wrapper parity, not improved retention."});
    std::fs::write(
        output.join("fsrs.json"),
        serde_json::to_vec_pretty(&report)?,
    )?;
    println!(
        "{}",
        serde_json::json!({"cards":after.cards.len(),"reviewRows":after.reviews.len(),"matchedTransitions":rows.len(),"mismatches":0})
    );
    Ok(())
}
