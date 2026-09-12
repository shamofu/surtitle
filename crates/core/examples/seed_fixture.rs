//! Deterministic real SQLite fixture, generated outside the production application.
use anyhow::{Context, Result};
use surtitle_core::*;

fn main() -> Result<()> {
    let mut args = std::env::args_os().skip(1);
    let root = std::path::PathBuf::from(
        args.next()
            .context("usage: seed_fixture DATA_DIR MEDIA_PATH")?,
    );
    let media_path =
        std::path::PathBuf::from(args.next().context("missing media path")?).canonicalize()?;
    std::fs::create_dir_all(&root)?;
    let mut db = Store::open(root.join("learning.sqlite"))?;
    let media = Media {
        id: "fixture-media".into(),
        title: "日本語 & sample".into(),
        path: media_path.to_string_lossy().into_owned(),
        source_url: None,
        kind: "video".into(),
        duration_ms: 21_600_000,
        learning_language: "en".into(),
        explanation_language: "ja".into(),
        created_at: now(),
        last_position_ms: 0,
        audio_stream_index: None,
        subtitle_stream_index: None,
        segment_count: 20_000,
        card_count: 1,
        status: "ready".into(),
        error: None,
    };
    db.put_media(&media)?;
    let segments: Vec<_> = (0..20_000)
        .map(|i| SubtitleSegment {
            id: format!("fixture-{i}"),
            media_id: media.id.clone(),
            start_ms: i * 1000,
            end_ms: i * 1000 + 900,
            text: if i == 0 {
                "Make yourself at home.".into()
            } else {
                format!("Practice sentence {i}. Repeat repeat.")
            },
            translation: Some(if i == 0 {
                "くつろいでください。".into()
            } else {
                format!("練習用の文 {i}。")
            }),
            status: "confirmed".into(),
        })
        .collect();
    db.set_segments(&media.id, &segments)?;
    let card = StudyCard {
        id: "fixture-card".into(),
        media_id: media.id.clone(),
        segment_id: "fixture-0".into(),
        source_cues: vec![segments[0].clone()],
        term: "at home".into(),
        meaning: "くつろいで、気楽に".into(),
        example: segments[0].text.clone(),
        language: "en".into(),
        due_at: "2000-01-01T00:00:00Z".into(),
        created_at: now(),
        review_count: 0,
        audio_path: None,
        audio_clip_range: None,
        audio_stream_index: None,
        suspended: false,
        translation: segments[0].translation.clone(),
        explanation: Some("A welcoming expression.".into()),
        source_title: media.title,
        source_url: None,
        start_ms: 0,
        end_ms: 900,
        memory: None,
        last_review: None,
    };
    db.put_card(&card)?;
    std::fs::write(
        root.join("fixture.json"),
        serde_json::to_vec_pretty(
            &serde_json::json!({"mediaId":media.id,"cardId":card.id,"segmentCount":20000,"mediaPath":media.path}),
        )?,
    )?;
    println!("Created real SQLite fixture: {}", root.display());
    Ok(())
}
