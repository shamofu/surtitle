use super::*;
use surtitle_core::LearningArchive;

fn seed(state: &AppState, source: &Path) -> LearningArchive {
    let mut db = lock(&state.db).unwrap();
    db.put_media(&Media {
        id: "restore-media".into(),
        title: "Restore fixture".into(),
        path: source.to_string_lossy().into_owned(),
        source_url: None,
        kind: "video".into(),
        duration_ms: 3000,
        learning_language: "en".into(),
        explanation_language: "ja".into(),
        created_at: surtitle_core::now(),
        last_position_ms: 600,
        segment_count: 2,
        card_count: 0,
        status: "ready".into(),
        error: None,
        audio_stream_index: Some(1),
        subtitle_stream_index: None,
    })
    .unwrap();
    db.set_segments(
        "restore-media",
        &[
            SubtitleSegment {
                id: "restore-a".into(),
                media_id: "restore-media".into(),
                start_ms: 0,
                end_ms: 1000,
                text: "Restored original.".into(),
                translation: None,
                status: "confirmed".into(),
            },
            SubtitleSegment {
                id: "restore-b".into(),
                media_id: "restore-media".into(),
                start_ms: 1100,
                end_ms: 2800,
                text: "Restored next sentence.".into(),
                translation: None,
                status: "confirmed".into(),
            },
        ],
    )
    .unwrap();
    db.archive().unwrap()
}

#[test]
fn restore_preserves_operational_files_and_backs_up_replaced_learning() {
    let temporary = tempfile::tempdir().unwrap();
    let state = Services::open(temporary.path().to_path_buf()).unwrap();
    let source = temporary.path().join("source.wav");
    std::fs::write(&source, b"local fixture").unwrap();
    let archive = seed(&state, &source);
    let credential_marker = state.root.join("credentials/untouched.fixture");
    let tool_marker = state.root.join("tools/untouched.fixture");
    std::fs::write(&credential_marker, b"test marker, not a credential").unwrap();
    std::fs::write(&tool_marker, b"test marker, not an executable").unwrap();
    {
        let mut preferences = lock(&state.preferences).unwrap();
        preferences.settings.vertex_project = "untouched-project".into();
        preferences.credential_id = Some("untouched-placeholder".into());
        preferences.tools.ffmpeg = surtitle_tools::ToolSelection::External {
            path: tool_marker.clone(),
        };
        state.save_preferences(&preferences).unwrap();
    }
    let preferences = std::fs::read(state.root.join("preferences.json")).unwrap();
    let costs = surtitle_tools::sha256_file(&state.root.join("charges.sqlite")).unwrap();
    let summary = serde_json::to_value(state.ai.summary().unwrap()).unwrap();
    {
        let db = lock(&state.db).unwrap();
        let mut media = db.media("restore-media").unwrap();
        media.last_position_ms = 2300;
        db.put_media(&media).unwrap();
    }
    restore_learning_archive(&state, &archive).unwrap();
    assert_eq!(
        lock(&state.db)
            .unwrap()
            .media("restore-media")
            .unwrap()
            .last_position_ms,
        600
    );
    let backups = std::fs::read_dir(state.root.join("backups"))
        .unwrap()
        .collect::<std::io::Result<Vec<_>>>()
        .unwrap();
    assert_eq!(backups.len(), 1);
    assert_eq!(
        surtitle_core::Store::open(backups[0].path())
            .unwrap()
            .media("restore-media")
            .unwrap()
            .last_position_ms,
        2300
    );
    assert_eq!(
        std::fs::read(state.root.join("preferences.json")).unwrap(),
        preferences
    );
    assert_eq!(
        surtitle_tools::sha256_file(&state.root.join("charges.sqlite")).unwrap(),
        costs
    );
    assert_eq!(
        serde_json::to_value(state.ai.summary().unwrap()).unwrap(),
        summary
    );
    assert_eq!(
        std::fs::read(credential_marker).unwrap(),
        b"test marker, not a credential"
    );
    assert_eq!(
        std::fs::read(tool_marker).unwrap(),
        b"test marker, not an executable"
    );
}

#[test]
fn zip_preview_tokens_are_single_use_and_restore_independent_audio_and_reviews() {
    let temporary = tempfile::tempdir().unwrap();
    let state = Services::open(temporary.path().join("data")).unwrap();
    let source = temporary.path().join("source.wav");
    std::fs::write(&source, b"local source fixture").unwrap();
    seed(&state, &source);
    let audio = state.root.join("card-audio/saved.wav");
    let mut wave = b"RIFF".to_vec();
    wave.extend_from_slice(&32036u32.to_le_bytes());
    wave.extend_from_slice(b"WAVEfmt \x10\0\0\0\x01\0\x01\0\x80\x3e\0\0\0\x7d\0\0\x02\0\x10\0data");
    wave.extend_from_slice(&32000u32.to_le_bytes());
    wave.resize(32044, 0);
    std::fs::write(&audio, &wave).unwrap();
    let card = lock(&state.db)
        .unwrap()
        .save_card_with_audio_range(
            &SaveCard {
                media_id: "restore-media".into(),
                segment_id: "restore-a".into(),
                source_cue_ids: vec!["restore-a".into()],
                term: "restored".into(),
                meaning: "Kept definition".into(),
                example: "Restored original.".into(),
                translation: None,
                explanation: None,
            },
            Some(audio.to_string_lossy().into_owned()),
            Some(surtitle_core::AudioClipRange {
                start_ms: 0,
                end_ms: 1000,
            }),
        )
        .unwrap();
    lock(&state.db)
        .unwrap()
        .rate_card(&card.id, "good", 0.9, chrono::Utc::now())
        .unwrap();
    let archived = lock(&state.db).unwrap().archive().unwrap();
    let zip = temporary.path().join("日本語 & portable.zip");
    surtitle_core::transfer::export_zip(&archived, &state.root.join("card-audio"), &zip).unwrap();
    let original_zip = std::fs::read(&zip).unwrap();
    let stale = preview_restore_at(&state, &zip).unwrap();
    assert_eq!(
        (
            stale.media_count,
            stale.card_count,
            stale.review_count,
            stale.audio_count
        ),
        (1, 1, 1, 1)
    );
    let mut changed = original_zip.clone();
    changed.push(0);
    std::fs::write(&zip, changed).unwrap();
    assert!(
        take_restore_archive(&state, &stale.token)
            .unwrap_err()
            .to_string()
            .contains("changed after preview")
    );
    std::fs::write(&zip, &original_zip).unwrap();
    assert!(
        take_restore_archive(&state, &stale.token)
            .unwrap_err()
            .to_string()
            .contains("expired")
    );
    assert_eq!(
        std::fs::read_dir(state.root.join("card-audio"))
            .unwrap()
            .count(),
        1
    );
    let mut edited = archived.segments[0].clone();
    edited.text = "Changed after export.".into();
    lock(&state.db).unwrap().edit_segment(&edited).unwrap();
    let preview = preview_restore_at(&state, &zip).unwrap();
    let plan = take_restore_plan(&state, &preview.token).unwrap();
    // Deterministically replace the selected ZIP after its confirmation hash check.
    // Both ZIPs use the same audio entry name, so reopening the original
    // pathname here would silently import the wrong audio into the approved card.
    let mut replacement_wave = wave.clone();
    replacement_wave[44..].fill(1);
    let mut replacement = surtitle_core::transfer::read_archive(&zip).unwrap();
    replacement.cards[0].meaning = "Unapproved replacement".into();
    let replacement_zip = temporary.path().join("replacement.zip");
    {
        use std::io::Write;
        let mut writer = zip::ZipWriter::new(std::fs::File::create(&replacement_zip).unwrap());
        let options = zip::write::SimpleFileOptions::default();
        writer
            .start_file(replacement.cards[0].audio_path.as_ref().unwrap(), options)
            .unwrap();
        writer.write_all(&replacement_wave).unwrap();
        writer.start_file("learning.json", options).unwrap();
        serde_json::to_writer(&mut writer, &replacement).unwrap();
        writer.finish().unwrap();
    }
    std::fs::write(&zip, std::fs::read(replacement_zip).unwrap()).unwrap();
    let ready = materialize_restore_plan(&state, plan).unwrap();
    assert!(
        take_restore_archive(&state, &preview.token)
            .unwrap_err()
            .to_string()
            .contains("expired")
    );
    restore_learning_archive(&state, &ready).unwrap();
    let restored = lock(&state.db).unwrap().archive().unwrap();
    assert_eq!(
        serde_json::to_value(&restored.segments).unwrap(),
        serde_json::to_value(&archived.segments).unwrap()
    );
    assert_eq!(
        serde_json::to_value(&restored.reviews).unwrap(),
        serde_json::to_value(&archived.reviews).unwrap()
    );
    let mut restored_card = restored.cards[0].clone();
    let restored_audio = std::path::PathBuf::from(restored_card.audio_path.take().unwrap());
    assert!(restored_audio.starts_with(state.root.join("card-audio")) && restored_audio != audio);
    let mut original_card = archived.cards[0].clone();
    original_card.audio_path = None;
    assert_eq!(
        serde_json::to_value(restored_card).unwrap(),
        serde_json::to_value(original_card).unwrap()
    );
    assert_eq!(std::fs::read(&restored_audio).unwrap(), wave);
    assert_eq!(std::fs::read(&audio).unwrap(), wave);
    assert_eq!(
        std::fs::read_dir(state.root.join("restore-previews"))
            .unwrap()
            .count(),
        0
    );
    let backup = std::fs::read_dir(state.root.join("backups"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    assert_eq!(
        surtitle_core::Store::open(backup)
            .unwrap()
            .segment("restore-a")
            .unwrap()
            .text,
        edited.text
    );
}

#[cfg(all(windows, feature = "e2e-test"))]
#[test]
#[ignore = "explicit Windows libmpv restore regression; set SURTITLE_TEST_FFMPEG; requires prepared native DLLs"]
fn real_mpv_restore_reconciles_resume_audio_subtitles_and_stale_ticks() {
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    use std::time::{Duration, Instant};
    use windows_sys::Win32::UI::WindowsAndMessaging::*;
    fn pump() {
        unsafe {
            let mut message = std::mem::zeroed();
            while PeekMessageW(&mut message, std::ptr::null_mut(), 0, 0, PM_REMOVE) != 0 {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
    }
    fn wait(state: &AppState, predicate: impl Fn(&PlayerState) -> bool) -> PlayerState {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            pump();
            let current = state.player_state().unwrap();
            assert!(current.error.is_none(), "{:?}", current.error);
            if predicate(&current) {
                return current;
            }
            assert!(
                Instant::now() < deadline,
                "player did not reach expected state: {current:?}"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    fn action(state: &AppState, action: &str) {
        let _playback = lock(&state.playback).unwrap();
        lock(&state.player)
            .unwrap()
            .as_mut()
            .unwrap()
            .control(&Control {
                action: action.into(),
                value: None,
                start_ms: None,
                end_ms: None,
                bounds: None,
                track_kind: None,
            })
            .unwrap();
    }
    struct Window(windows_sys::Win32::Foundation::HWND);
    impl Drop for Window {
        fn drop(&mut self) {
            unsafe {
                DestroyWindow(self.0);
            }
        }
    }
    struct Ticker {
        stop: Arc<AtomicBool>,
        handle: Option<std::thread::JoinHandle<()>>,
    }
    impl Drop for Ticker {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Release);
            self.handle.take().unwrap().join().unwrap();
        }
    }
    let temporary = tempfile::tempdir().unwrap();
    let source = temporary.path().join("日本語 & restore.mkv");
    let executable = std::path::PathBuf::from(
        std::env::var_os("SURTITLE_TEST_FFMPEG").expect("explicit FFmpeg path"),
    );
    let snapshot = surtitle_tools::ToolSnapshot::capture(
        surtitle_tools::resolve_external(surtitle_tools::ToolKind::FfmpegPair, &executable)
            .unwrap(),
    )
    .unwrap();
    snapshot.verify().unwrap();
    let output = std::process::Command::new(&snapshot.tool.executable)
        .args([
            "-nostdin",
            "-v",
            "error",
            "-n",
            "-f",
            "lavfi",
            "-i",
            "color=c=black:s=32x32:r=10",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=16000",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=880:sample_rate=16000",
            "-t",
            "3",
            "-map",
            "0:v",
            "-map",
            "1:a",
            "-map",
            "2:a",
            "-c:v",
            "ffv1",
            "-c:a",
            "pcm_s16le",
        ])
        .arg(&source)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let class = "STATIC\0".encode_utf16().collect::<Vec<_>>();
    let parent = Window(unsafe {
        CreateWindowExW(
            0,
            class.as_ptr(),
            std::ptr::null(),
            WS_POPUP,
            0,
            0,
            32,
            32,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null(),
        )
    });
    assert!(!parent.0.is_null());
    let state = Services::open(temporary.path().join("data")).unwrap();
    let archive = seed(&state, &source.canonicalize().unwrap());
    {
        let mut preferences = lock(&state.preferences).unwrap();
        preferences.settings.sentence_pause = true;
        state.save_preferences(&preferences).unwrap();
    }
    let preferences_before = std::fs::read(state.root.join("preferences.json")).unwrap();
    let costs_before = serde_json::to_value(state.ai.summary().unwrap()).unwrap();
    *lock(&state.player).unwrap() = Some(
        crate::player::Player::new(
            &Path::new(env!("CARGO_MANIFEST_DIR")).join("resources"),
            parent.0 as isize,
        )
        .unwrap(),
    );
    {
        let _playback = lock(&state.playback).unwrap();
        let db = lock(&state.db).unwrap();
        let mut media = db.media("restore-media").unwrap();
        media.last_position_ms = 2200;
        media.audio_stream_index = Some(2);
        db.put_media(&media).unwrap();
        let mut subtitle = db.segment("restore-a").unwrap();
        subtitle.text = "Old unpunctuated caption".into();
        subtitle.end_ms = 2600;
        db.edit_segment(&subtitle).unwrap();
        drop(db);
        load_media_locked(&state, "restore-media").unwrap();
    }
    let old = wait(&state, |current| {
        current.ready && current.position_ms >= 2100
    });
    assert_eq!(
        old.tracks
            .iter()
            .find(|track| track.kind == "audio" && track.selected)
            .and_then(|track| track.ff_index),
        Some(2)
    );
    let stop = Arc::new(AtomicBool::new(false));
    let worker_stop = stop.clone();
    let worker_state = state.clone();
    let ticker = Ticker {
        stop,
        handle: Some(std::thread::spawn(move || {
            while !worker_stop.load(Ordering::Acquire) {
                worker_state.playback_tick(true).unwrap();
                std::thread::sleep(Duration::from_millis(1));
            }
        })),
    };
    restore_learning_archive(&state, &archive).unwrap();
    let restored = wait(&state, |current| {
        current.ready && (500..=800).contains(&current.position_ms)
    });
    assert!(restored.paused);
    assert_eq!(
        restored
            .tracks
            .iter()
            .find(|track| track.kind == "audio" && track.selected)
            .and_then(|track| track.ff_index),
        Some(1)
    );
    wait(&state, |_| {
        lock(&state.player)
            .unwrap()
            .as_ref()
            .unwrap()
            .subtitle_text()
            .as_deref()
            == Some("Restored original.")
    });
    for _ in 0..40 {
        pump();
        state.playback_tick(true).unwrap();
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(
        (500..=800).contains(
            &lock(&state.db)
                .unwrap()
                .media("restore-media")
                .unwrap()
                .last_position_ms
        )
    );
    action(&state, "play");
    wait(&state, |current| {
        current.paused && (1000..=1300).contains(&current.position_ms)
    });
    assert_eq!(
        std::fs::read(state.root.join("preferences.json")).unwrap(),
        preferences_before
    );
    assert_eq!(
        serde_json::to_value(state.ai.summary().unwrap()).unwrap(),
        costs_before
    );

    let mut missing = archive.clone();
    missing.media[0].path = temporary
        .path()
        .join("missing.mkv")
        .to_string_lossy()
        .into_owned();
    restore_learning_archive(&state, &missing).unwrap();
    let stopped = state.playback_tick(true).unwrap();
    assert!(!stopped.ready && stopped.paused && !stopped.surface_visible);
    assert!(lock(&state.playing).unwrap().is_none());
    assert_eq!(
        lock(&state.db)
            .unwrap()
            .media("restore-media")
            .unwrap()
            .last_position_ms,
        600
    );
    restore_learning_archive(&state, &archive).unwrap();
    {
        let _playback = lock(&state.playback).unwrap();
        load_media_locked(&state, "restore-media").unwrap();
    }
    wait(&state, |current| current.ready);
    let mut removed = archive;
    removed.media.clear();
    removed.segments.clear();
    restore_learning_archive(&state, &removed).unwrap();
    assert!(lock(&state.playing).unwrap().is_none());
    assert!(!state.playback_tick(true).unwrap().ready);
    assert!(lock(&state.db).unwrap().list_media().unwrap().is_empty());
    drop(ticker);
    lock(&state.player).unwrap().take();
}
