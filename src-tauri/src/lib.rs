mod application;
mod commands;
mod player;
mod restore_snapshot;

use application::Services;
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
            application::ai::fixtures::seed_ai_recovery_fixture(&services)?;
            #[cfg(feature = "e2e-test")]
            application::transcript::fixtures::seed_transcript_review_fixture(&services)?;
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
            services.initialize_player(&resources, parent)?;
            app.manage(services.clone());
            let update_state = services.clone();
            tauri::async_runtime::spawn(async move {
                application::tool_updates::run(update_state).await;
            });
            let handle = app.handle().clone();
            let alive = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
            let close_alive = alive.clone();
            let close_state = services.clone();
            window.on_window_event(move |event| {
                if matches!(event, tauri::WindowEvent::Destroyed) {
                    close_alive.store(false, std::sync::atomic::Ordering::Relaxed);
                    close_state.shutdown();
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
            commands::continuations::save_ai_continuation,
            commands::continuations::list_ai_continuations,
            commands::continuations::discard_ai_continuation,
            commands::editor_drafts::list_editor_drafts,
            commands::editor_drafts::save_editor_draft,
            commands::editor_drafts::delete_editor_draft,
            commands::editor_drafts::rebind_editor_draft,
            commands::editor_drafts::commit_subtitle_editor_draft,
            commands::editor_drafts::save_phrase_editor_draft,
            commands::transfer::reveal_export_file,
            commands::ai::get_app_snapshot,
            commands::models::list_vertex_models,
            commands::models::update_appearance,
            commands::models::lookup_vertex_price,
            commands::ai::import_credential,
            commands::ai::create_quote,
            commands::ai::approve_quote,
            commands::ai::list_vocabulary_candidates,
            commands::ai::list_saved_ai_results,
            commands::ai::apply_saved_ai_result,
            commands::ai::prepare_transcription,
            commands::ai::cancel_preparation,
            commands::transcript::list_transcription_preparations,
            commands::transcript::create_transcription_quote,
            commands::transcript::get_transcript_review,
            commands::transcript_study::list_draft_selections,
            commands::transcript_study::prepare_draft_selection,
            commands::transcript_study::update_draft_selection,
            commands::transcript_study::remove_draft_selection,
            commands::transcript_study::save_draft_selection_card,
            commands::transcript_study::create_draft_selection_quote,
            commands::transcript_study::list_draft_selection_candidates,
            commands::transcript_study::export_draft_selection,
            commands::transcript::save_manual_transcript_range,
            commands::transcript::select_transcript_range_source,
            commands::transcript::get_transcript_result_detail,
            commands::transcript::reparse_transcript_evidence,
            commands::transcript::select_transcript_reparse,
            commands::transcript::resolve_transcript_boundary,
            commands::transcript::apply_transcript_review,
            commands::transcript::acknowledge_transcript_warning,
            commands::transcript::prepare_boundary_repair,
            commands::ai::create_retry_quote,
            commands::ai::review_ai_job,
            commands::ai::retry_ai_application,
            commands::ai::list_transcript_issues,
            commands::ai::reapprove_quote,
            commands::ai::pause_ai_job,
            commands::ai::cancel_ai_job,
            commands::ai::resolve_unknown_attempt,
            commands::subtitles::list_segments,
            commands::library::select_media_files,
            commands::library::validate_media_files,
            commands::library::import_local_media,
            commands::library::import_media,
            commands::library::relink_media,
            commands::playback::load_media,
            commands::playback::get_player_state,
            commands::playback::player_control,
            commands::playback::play_source_range,
            commands::subtitles::import_subtitles,
            commands::subtitles::edit_segment,
            commands::cards::save_card,
            commands::cards::edit_card,
            commands::cards::suspend_card,
            commands::cards::delete_card,
            commands::library::remove_media,
            commands::subtitles::list_subtitle_versions,
            commands::subtitles::restore_subtitle_version,
            commands::library::start_url_import,
            commands::cards::rate_card,
            commands::playback::play_card_audio,
            commands::models::update_settings,
            commands::transfer::export_learning,
            commands::transfer::preview_restore,
            commands::transfer::discard_restore_preview,
            commands::transfer::restore_learning,
            commands::media_tools::scan_external_tools,
            commands::tool_updates::check_tool_updates,
            commands::media_tools::list_media_streams,
            commands::media_tools::select_audio_stream,
            commands::media_tools::list_download_jobs,
            commands::media_tools::cancel_download,
            commands::media_tools::set_tool_provider,
            commands::media_tools::install_tool,
            commands::media_tools::update_tool,
            commands::media_tools::rollback_tool,
            commands::media_tools::extract_embedded_subtitles
        ])
        .run(tauri::generate_context!())
        .expect("error while running Surtitle");
}
