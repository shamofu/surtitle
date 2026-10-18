#![cfg_attr(
    any(not(debug_assertions), feature = "e2e-test"),
    windows_subsystem = "windows"
)]
fn main() {
    if let Err(error) = surtitle_app::run() {
        surtitle_app::report_startup_failure(error);
    }
}
