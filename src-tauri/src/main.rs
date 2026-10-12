#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    if let Err(error) = surtitle_app::run() {
        surtitle_app::report_startup_failure(error);
    }
}
