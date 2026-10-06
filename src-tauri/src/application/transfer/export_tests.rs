use super::*;

fn seed(state: &AppState, id: &str, text: &str, translation: Option<&str>) {
    let media: surtitle_core::Media = serde_json::from_value(serde_json::json!({
        "id": id, "title": id, "path": state.root.join("video.mkv"), "kind": "video", "durationMs": 10000,
        "learningLanguage": "en", "explanationLanguage": "ja", "createdAt": surtitle_core::now(),
        "lastPositionMs": 0, "segmentCount": 1, "cardCount": 0, "status": "ready"
    }))
    .unwrap();
    let segment: surtitle_core::SubtitleSegment = serde_json::from_value(serde_json::json!({
        "id": format!("{id}-cue"), "mediaId": id, "startMs": 0, "endMs": 1000,
        "text": text, "translation": translation, "status": "confirmed"
    }))
    .unwrap();
    let mut db = lock(&state.db).unwrap();
    db.put_media(&media).unwrap();
    db.set_segments(id, &[segment]).unwrap();
}

#[test]
fn subtitle_export_returns_all_written_paths_for_only_the_selected_media() {
    let temporary = tempfile::tempdir().unwrap();
    let state = Services::open(temporary.path().join("data")).unwrap();
    seed(
        &state,
        "first",
        "Selected original.",
        Some("選択した翻訳。"),
    );
    seed(&state, "second", "Unrelated original.", None);
    for format in ["srt", "vtt"] {
        let path = temporary.path().join(format!("result.{format}"));
        let translated = temporary
            .path()
            .join(format!("result.translation.{format}"));
        let paths = export_to_path(&state, format, Some("first"), &path).unwrap();
        assert_eq!(
            paths,
            vec![
                path.to_string_lossy().into_owned(),
                translated.to_string_lossy().into_owned()
            ]
        );
        let original = std::fs::read_to_string(&path).unwrap();
        assert!(original.contains("Selected original."));
        assert!(!original.contains("Unrelated original."));
        assert!(
            std::fs::read_to_string(translated)
                .unwrap()
                .contains("選択した翻訳。")
        );
    }
}

#[test]
fn subtitle_translation_collision_does_not_replace_existing_original() {
    let temporary = tempfile::tempdir().unwrap();
    let state = Services::open(temporary.path().join("data")).unwrap();
    seed(&state, "first", "Selected original.", Some("翻訳"));
    let path = temporary.path().join("result.srt");
    std::fs::write(&path, "Keep original").unwrap();
    std::fs::write(
        temporary.path().join("result.translation.srt"),
        "Keep translation",
    )
    .unwrap();
    assert!(export_to_path(&state, "srt", Some("first"), &path).is_err());
    assert_eq!(std::fs::read_to_string(path).unwrap(), "Keep original");
}
