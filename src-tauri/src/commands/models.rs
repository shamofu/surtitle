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
    crate::application::models::update_appearance(state.inner().clone(), locale, theme)
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
    crate::application::models::update_settings(state.inner().clone(), settings)
}
