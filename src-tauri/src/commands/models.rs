//! Tauri IPC adapters; application services own all business logic.
use crate::application::AppState;
use crate::application::models::PriceLookup;
use tauri::State;

#[tauri::command]
pub fn update_appearance(
    state: State<'_, AppState>,
    locale: Option<String>,
    theme: Option<String>,
) -> std::result::Result<(), String> {
    let committed_changes = state.changes.clone();
    let changed_settings = None;
    let changed_jobs = None;
    let result =
        crate::application::models::update_appearance(state.inner().clone(), locale, theme);
    if result.is_ok() {
        committed_changes.publish(
            crate::application::changes::ChangeDomain::Settings,
            changed_settings,
        );
        committed_changes.publish(
            crate::application::changes::ChangeDomain::Jobs,
            changed_jobs,
        );
    }
    result
}

#[tauri::command]
pub async fn list_vertex_models(
    state: State<'_, AppState>,
    location: Option<String>,
) -> std::result::Result<Vec<surtitle_ai::DiscoveredModel>, String> {
    crate::application::models::list_vertex_models(state.inner().clone(), location).await
}

#[tauri::command]
pub async fn lookup_vertex_price(
    state: State<'_, AppState>,
    model_id: String,
    location: Option<String>,
) -> std::result::Result<PriceLookup, String> {
    crate::application::models::lookup_vertex_price(state.inner().clone(), model_id, location).await
}

use surtitle_core::AppSettings;
type IpcResult<T> = std::result::Result<T, String>;
#[tauri::command]
pub fn update_settings(state: State<'_, AppState>, settings: AppSettings) -> IpcResult<()> {
    let committed_changes = state.changes.clone();
    let changed_settings = None;
    let changed_budget = None;
    let changed_jobs = None;
    let result = crate::application::models::update_settings(state.inner().clone(), settings);
    if result.is_ok() {
        committed_changes.publish(
            crate::application::changes::ChangeDomain::Settings,
            changed_settings,
        );
        committed_changes.publish(
            crate::application::changes::ChangeDomain::Budget,
            changed_budget,
        );
        committed_changes.publish(
            crate::application::changes::ChangeDomain::Jobs,
            changed_jobs,
        );
    }
    result
}
#[tauri::command]
pub fn get_settings_state(
    state: State<'_, AppState>,
) -> IpcResult<crate::application::models::SettingsState> {
    crate::application::models::get_settings_state(state.inner().clone())
}
#[tauri::command]
pub fn update_settings_patch(
    state: State<'_, AppState>,
    expected_revision: String,
    patch: crate::application::models::SettingsPatch,
) -> IpcResult<crate::application::models::SettingsState> {
    let committed_changes = state.changes.clone();
    let changed_settings = None;
    let changed_budget = None;
    let changed_jobs = None;
    let result = crate::application::models::update_settings_patch(
        state.inner().clone(),
        expected_revision,
        patch,
    );
    if result.is_ok() {
        committed_changes.publish(
            crate::application::changes::ChangeDomain::Settings,
            changed_settings,
        );
        committed_changes.publish(
            crate::application::changes::ChangeDomain::Budget,
            changed_budget,
        );
        committed_changes.publish(
            crate::application::changes::ChangeDomain::Jobs,
            changed_jobs,
        );
    }
    result
}
