use crate::application::AppState;
use crate::application::media_tools::MediaStream;
use crate::application::tool_runtime::ExternalCandidate;
use crate::application::tool_runtime::ProviderRequest;

pub fn list_operation_progress(
    state: &AppState,
) -> std::result::Result<Vec<crate::application::operations::OperationProgress>, String> {
    crate::application::operations::list_operation_progress(state.clone())
}

pub async fn list_media_streams(
    state: &AppState,
    media_id: String,
    operation_id: Option<String>,
) -> std::result::Result<Vec<MediaStream>, String> {
    crate::application::media_tools::list_media_streams(state.clone(), media_id, operation_id).await
}

pub async fn select_audio_stream(
    app: crate::runtime::DesktopHost,
    state: &AppState,
    media_id: String,
    stream_index: u32,
    operation_id: Option<String>,
) -> std::result::Result<(), String> {
    let committed_changes = state.changes.clone();
    let changed_media = Some(media_id.clone());
    let result = crate::application::media_tools::select_audio_stream(
        app,
        state.clone(),
        media_id,
        stream_index,
        operation_id,
    )
    .await;
    if result.is_ok() {
        committed_changes.publish(
            crate::application::changes::ChangeDomain::Media,
            changed_media,
        );
    }
    result
}

pub async fn extract_embedded_subtitles(
    state: &AppState,
    media_id: String,
    stream_index: u32,
    replace_existing: Option<bool>,
    operation_id: Option<String>,
) -> std::result::Result<(), String> {
    let committed_changes = state.changes.clone();
    let changed_subtitles = Some(media_id.clone());
    let changed_media = Some(media_id.clone());
    let result = crate::application::media_tools::extract_embedded_subtitles(
        state.clone(),
        media_id,
        stream_index,
        replace_existing,
        operation_id,
    )
    .await;
    if result.is_ok() {
        committed_changes.publish(
            crate::application::changes::ChangeDomain::Subtitles,
            changed_subtitles,
        );
        committed_changes.publish(
            crate::application::changes::ChangeDomain::Media,
            changed_media,
        );
    }
    result
}

pub fn scan_external_tools(
    state: &AppState,
    rescan: Option<bool>,
) -> std::result::Result<Vec<ExternalCandidate>, String> {
    let committed_changes = state.changes.clone();
    let changed_tools = None;
    let result = crate::application::tool_runtime::scan_external_tools(state.clone(), rescan);
    if result.is_ok() {
        committed_changes.publish(
            crate::application::changes::ChangeDomain::Tools,
            changed_tools,
        );
    }
    result
}

pub async fn set_tool_provider(
    state: &AppState,
    request: ProviderRequest,
) -> std::result::Result<(), String> {
    let committed_changes = state.changes.clone();
    let changed_tools = None;
    let result = crate::application::tool_runtime::set_tool_provider(state.clone(), request).await;
    if result.is_ok() {
        committed_changes.publish(
            crate::application::changes::ChangeDomain::Tools,
            changed_tools,
        );
    }
    result
}

pub async fn install_tool(state: &AppState, tool_id: String) -> std::result::Result<(), String> {
    let committed_changes = state.changes.clone();
    let changed_tools = None;
    let result = crate::application::tool_runtime::install_tool(state.clone(), tool_id).await;
    if result.is_ok() {
        committed_changes.publish(
            crate::application::changes::ChangeDomain::Tools,
            changed_tools,
        );
    }
    result
}

pub async fn update_tool(state: &AppState, tool_id: String) -> std::result::Result<(), String> {
    let committed_changes = state.changes.clone();
    let changed_tools = None;
    let result = crate::application::tool_runtime::update_tool(state.clone(), tool_id).await;
    if result.is_ok() {
        committed_changes.publish(
            crate::application::changes::ChangeDomain::Tools,
            changed_tools,
        );
    }
    result
}

pub fn rollback_tool(state: &AppState, tool_id: String) -> std::result::Result<(), String> {
    let committed_changes = state.changes.clone();
    let changed_tools = None;
    let result = crate::application::tool_runtime::rollback_tool(state.clone(), tool_id);
    if result.is_ok() {
        committed_changes.publish(
            crate::application::changes::ChangeDomain::Tools,
            changed_tools,
        );
    }
    result
}
