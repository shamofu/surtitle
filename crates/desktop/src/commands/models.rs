//! Typed desktop facades; application services own all business logic.
use crate::application::AppState;
use crate::application::models::PriceLookup;

pub fn save_openai_api_key(state: &AppState, api_key: String) -> std::result::Result<(), String> {
    let result = crate::application::models::save_openai_api_key(state.clone(), api_key);
    if result.is_ok() {
        state
            .changes
            .publish(crate::application::changes::ChangeDomain::Settings, None);
        state
            .changes
            .publish(crate::application::changes::ChangeDomain::Jobs, None);
    }
    result
}

pub fn remove_openai_api_key(state: &AppState) -> std::result::Result<(), String> {
    let result = crate::application::models::remove_openai_api_key(state.clone());
    if result.is_ok() {
        state
            .changes
            .publish(crate::application::changes::ChangeDomain::Settings, None);
        state
            .changes
            .publish(crate::application::changes::ChangeDomain::Jobs, None);
    }
    result
}

pub async fn list_openai_models(
    state: &AppState,
) -> std::result::Result<Vec<surtitle_ai::DiscoveredModel>, String> {
    crate::application::models::list_openai_models(state.clone()).await
}

pub async fn list_vertex_models(
    state: &AppState,
    location: Option<String>,
) -> std::result::Result<Vec<surtitle_ai::DiscoveredModel>, String> {
    crate::application::models::list_vertex_models(state.clone(), location).await
}

pub async fn lookup_vertex_price(
    state: &AppState,
    model_id: String,
    location: Option<String>,
) -> std::result::Result<PriceLookup, String> {
    crate::application::models::lookup_vertex_price(state.clone(), model_id, location).await
}

type IpcResult<T> = std::result::Result<T, String>;
#[cfg(test)]
pub fn update_settings(state: &AppState, settings: surtitle_core::AppSettings) -> IpcResult<()> {
    let committed_changes = state.changes.clone();
    let changed_settings = None;
    let changed_budget = None;
    let changed_jobs = None;
    let result = crate::application::models::update_settings(state.clone(), settings);
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
pub fn get_settings_state(
    state: &AppState,
) -> IpcResult<crate::application::models::SettingsState> {
    crate::application::models::get_settings_state(state.clone())
}
pub fn update_settings_patch(
    state: &AppState,
    expected_revision: String,
    patch: crate::application::models::SettingsPatch,
) -> IpcResult<crate::application::models::SettingsState> {
    let committed_changes = state.changes.clone();
    let changed_settings = None;
    let changed_budget = None;
    let changed_jobs = None;
    let result =
        crate::application::models::update_settings_patch(state.clone(), expected_revision, patch);
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
