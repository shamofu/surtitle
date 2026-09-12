mod ai_commands;
mod commands;
mod model_commands;
mod player;
mod restore_snapshot;
mod service;
mod tool_commands;
mod tool_updates;
mod transcript_commands;

use service::{Services, lock};
use tauri::{Emitter, Manager};

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let root = app.path().app_local_data_dir()?;
            #[cfg(feature = "e2e-test")]
            let root = std::env::var_os("SURTITLE_E2E_DATA_DIR")
                .map(std::path::PathBuf::from)
                .unwrap_or(root);
            let services = Services::open(root)?;
            #[cfg(feature = "e2e-test")]
            ai_commands::seed_ai_recovery_fixture(&services)?;
            #[cfg(feature = "e2e-test")]
            transcript_commands::seed_transcript_review_fixture(&services)?;
            let window = app
                .get_webview_window("main")
                .ok_or("main window missing")?;
            #[cfg(windows)]
            let parent = window.hwnd()?.0 as isize;
            #[cfg(not(windows))]
            let parent = 0;
            let resources = app.path().resource_dir()?;
            #[cfg(debug_assertions)]
            let resources = if std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("resources/native/mpv-2.dll")
                .is_file()
            {
                std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources")
            } else {
                resources
            };
            *lock(&services.runtime_dir)? = resources.join("native");
            match player::Player::new(&resources, parent) {
                Ok(player) => *lock(&services.player)? = Some(player),
                Err(error) => *lock(&services.player_error)? = Some(error.to_string()),
            }
            app.manage(services.clone());
            let update_state = services.clone();
            tauri::async_runtime::spawn(async move {
                tool_updates::run(update_state).await;
            });
            let handle = app.handle().clone();
            let alive = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
            let close_alive = alive.clone();
            let close_state = services.clone();
            window.on_window_event(move |event| {
                if matches!(event, tauri::WindowEvent::Destroyed) {
                    close_alive.store(false, std::sync::atomic::Ordering::Relaxed);
                    close_state.tool_update_shutdown.cancel();
                    if let Ok(mut player) = close_state.player.lock() {
                        player.take();
                    }
                }
            });
            std::thread::Builder::new()
                .name("surtitle-playback".into())
                .spawn(move || {
                    let mut ticks = 0u64;
                    while alive.load(std::sync::atomic::Ordering::Relaxed) {
                        if let Ok(state) = services.playback_tick(ticks.is_multiple_of(10)) {
                            let _ = handle.emit("player-state", &state);
                        }
                        if ticks.is_multiple_of(50) {
                            let _ = handle.emit("app-changed", ());
                        }
                        ticks += 1;
                        std::thread::sleep(std::time::Duration::from_millis(100));
                    }
                })?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ai_commands::get_app_snapshot,
            model_commands::list_vertex_models,
            model_commands::update_appearance,
            model_commands::lookup_vertex_price,
            ai_commands::import_credential,
            ai_commands::create_quote,
            ai_commands::approve_quote,
            ai_commands::list_vocabulary_candidates,
            ai_commands::list_saved_ai_results,
            ai_commands::apply_saved_ai_result,
            ai_commands::prepare_transcription,
            ai_commands::cancel_preparation,
            transcript_commands::list_transcription_preparations,
            transcript_commands::create_transcription_quote,
            transcript_commands::get_transcript_review,
            transcript_commands::study::list_draft_selections,
            transcript_commands::study::prepare_draft_selection,
            transcript_commands::study::update_draft_selection,
            transcript_commands::study::remove_draft_selection,
            transcript_commands::study::save_draft_selection_card,
            transcript_commands::study::create_draft_selection_quote,
            transcript_commands::study::list_draft_selection_candidates,
            transcript_commands::study::export_draft_selection,
            transcript_commands::save_manual_transcript_range,
            transcript_commands::select_transcript_range_source,
            transcript_commands::get_transcript_result_detail,
            transcript_commands::reparse_transcript_evidence,
            transcript_commands::select_transcript_reparse,
            transcript_commands::resolve_transcript_boundary,
            transcript_commands::apply_transcript_review,
            transcript_commands::acknowledge_transcript_warning,
            transcript_commands::prepare_boundary_repair,
            ai_commands::create_retry_quote,
            ai_commands::reapprove_quote,
            ai_commands::pause_ai_job,
            ai_commands::cancel_ai_job,
            ai_commands::resolve_unknown_attempt,
            commands::list_segments,
            commands::select_media_files,
            commands::import_media,
            commands::relink_media,
            commands::load_media,
            commands::get_player_state,
            commands::player_control,
            commands::play_source_range,
            commands::import_subtitles,
            commands::edit_segment,
            commands::save_card,
            commands::edit_card,
            commands::suspend_card,
            commands::delete_card,
            commands::remove_media,
            commands::list_subtitle_versions,
            commands::restore_subtitle_version,
            commands::start_url_import,
            commands::rate_card,
            commands::play_card_audio,
            commands::update_settings,
            commands::export_learning,
            commands::preview_restore,
            commands::discard_restore_preview,
            commands::restore_learning,
            tool_commands::scan_external_tools,
            tool_updates::check_tool_updates,
            tool_commands::list_media_streams,
            tool_commands::select_audio_stream,
            tool_commands::list_download_jobs,
            tool_commands::cancel_download,
            tool_commands::set_tool_provider,
            tool_commands::install_tool,
            tool_commands::update_tool,
            tool_commands::rollback_tool,
            tool_commands::extract_embedded_subtitles
        ])
        .run(tauri::generate_context!())
        .expect("error while running Surtitle");
}
