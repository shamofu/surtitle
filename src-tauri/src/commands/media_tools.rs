use crate::application::AppState;
use crate::application::download::DownloadJobSnapshot;
use crate::application::media_tools::MediaStream;
use crate::application::tool_runtime::ExternalCandidate;
use crate::application::tool_runtime::ProviderRequest;
use tauri::State;

#[tauri::command]
pub fn list_operation_progress(
    state: State<'_, AppState>,
) -> std::result::Result<Vec<crate::application::operations::OperationProgress>, String> {
    crate::application::operations::list_operation_progress(state.inner().clone())
}

#[tauri::command]
pub fn list_download_jobs(
    state: State<'_, AppState>,
) -> std::result::Result<Vec<DownloadJobSnapshot>, String> {
    crate::application::download::list_download_jobs(state.inner().clone())
}

#[tauri::command]
pub fn cancel_download(
    state: State<'_, AppState>,
    job_id: String,
) -> std::result::Result<(), String> {
    crate::application::download::cancel_download(state.inner().clone(), job_id)
}

#[tauri::command]
pub async fn list_media_streams(
    state: State<'_, AppState>,
    media_id: String,
    operation_id: Option<String>,
) -> std::result::Result<Vec<MediaStream>, String> {
    crate::application::media_tools::list_media_streams(
        state.inner().clone(),
        media_id,
        operation_id,
    )
    .await
}

#[tauri::command]
pub async fn select_audio_stream(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    media_id: String,
    stream_index: u32,
    operation_id: Option<String>,
) -> std::result::Result<(), String> {
    crate::application::media_tools::select_audio_stream(
        app,
        state.inner().clone(),
        media_id,
        stream_index,
        operation_id,
    )
    .await
}

#[tauri::command]
pub async fn extract_embedded_subtitles(
    state: State<'_, AppState>,
    media_id: String,
    stream_index: u32,
    replace_existing: Option<bool>,
    operation_id: Option<String>,
) -> std::result::Result<(), String> {
    crate::application::media_tools::extract_embedded_subtitles(
        state.inner().clone(),
        media_id,
        stream_index,
        replace_existing,
        operation_id,
    )
    .await
}

#[tauri::command]
pub fn scan_external_tools(
    state: State<'_, AppState>,
    rescan: Option<bool>,
) -> std::result::Result<Vec<ExternalCandidate>, String> {
    crate::application::tool_runtime::scan_external_tools(state.inner().clone(), rescan)
}

#[tauri::command]
pub async fn set_tool_provider(
    state: State<'_, AppState>,
    request: ProviderRequest,
) -> std::result::Result<(), String> {
    crate::application::tool_runtime::set_tool_provider(state.inner().clone(), request).await
}

#[tauri::command]
pub async fn install_tool(
    state: State<'_, AppState>,
    tool_id: String,
) -> std::result::Result<(), String> {
    crate::application::tool_runtime::install_tool(state.inner().clone(), tool_id).await
}

#[tauri::command]
pub async fn update_tool(
    state: State<'_, AppState>,
    tool_id: String,
) -> std::result::Result<(), String> {
    crate::application::tool_runtime::update_tool(state.inner().clone(), tool_id).await
}

#[tauri::command]
pub fn rollback_tool(
    state: State<'_, AppState>,
    tool_id: String,
) -> std::result::Result<(), String> {
    crate::application::tool_runtime::rollback_tool(state.inner().clone(), tool_id)
}
