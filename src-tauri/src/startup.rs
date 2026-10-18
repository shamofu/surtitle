//! Startup can fail before a WebView exists, including in console-free releases.
pub fn report_startup_failure(error: impl std::fmt::Display) -> ! {
    // Keep a locked or damaged profile actionable without resetting or deleting
    // the user's data as an error recovery step.
    eprintln!("Could not start Surtitle: {error}");
    rfd::MessageDialog::new()
        .set_title("Surtitle")
        .set_level(rfd::MessageLevel::Error)
        .set_description(format!(
            "Surtitle を起動できませんでした / Surtitle could not start\n\n{error}\n\n\
             別の Surtitle が動作中の場合は、そのウィンドウを閉じて再試行してください。\n\
             データを開けない場合は、上記の場所へのアクセス権と空き容量を確認してください。\n\n\
             Close any other Surtitle window and try again. If the data cannot be opened, \
             check access to the location above and available disk space."
        ))
        .set_buttons(rfd::MessageButtons::Ok)
        .show();
    std::process::exit(1);
}
