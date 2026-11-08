use crate::application::AppState;
type IpcResult<T> = std::result::Result<T, String>;
pub fn rate_card(state: &AppState, card_id: String, rating: String) -> IpcResult<()> {
    let committed_changes = state.changes.clone();
    let changed_cards = Some(card_id.clone());
    let result = crate::application::cards::rate_card(state.clone(), card_id, rating);
    if result.is_ok() {
        committed_changes.publish(
            crate::application::changes::ChangeDomain::Cards,
            changed_cards,
        );
    }
    result
}
pub fn get_card_edit_state(
    state: &AppState,
    card_id: String,
) -> IpcResult<surtitle_core::store::CardEditState> {
    crate::application::cards::get_card_edit_state(state.clone(), card_id)
}
pub fn save_card_edit(
    state: &AppState,
    request: surtitle_core::EditCard,
    expected_revision: String,
) -> IpcResult<surtitle_core::store::CardEditState> {
    let committed_changes = state.changes.clone();
    let changed_cards = None;
    let result =
        crate::application::cards::save_card_edit(state.clone(), request, expected_revision);
    if result.is_ok() {
        committed_changes.publish(
            crate::application::changes::ChangeDomain::Cards,
            changed_cards,
        );
    }
    result
}
pub fn suspend_card(state: &AppState, card_id: String, suspended: bool) -> IpcResult<()> {
    let committed_changes = state.changes.clone();
    let changed_cards = Some(card_id.clone());
    let result = crate::application::cards::suspend_card(state.clone(), card_id, suspended);
    if result.is_ok() {
        committed_changes.publish(
            crate::application::changes::ChangeDomain::Cards,
            changed_cards,
        );
    }
    result
}
pub fn delete_card(state: &AppState, card_id: String) -> IpcResult<()> {
    let committed_changes = state.changes.clone();
    let changed_cards = Some(card_id.clone());
    let result = crate::application::cards::delete_card(state.clone(), card_id);
    if result.is_ok() {
        committed_changes.publish(
            crate::application::changes::ChangeDomain::Cards,
            changed_cards,
        );
    }
    result
}
