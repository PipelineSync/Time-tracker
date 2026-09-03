//! PipelineSync Work Tracker — desktop shell.
//!
//! The entire UI is the same React bundle that powers the web app and the
//! iOS/Android apps; Tauri only provides the native window, the system
//! webview (WebView2 on Windows, WKWebView on macOS) and the installer
//! packaging. No Rust-side business logic is required.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Single-instance: focusing the running window instead of opening a
        // second one matches what users expect from a desktop app.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
                let _ = window.unminimize();
            }
        }))
        .run(tauri::generate_context!())
        .expect("error while running the PipelineSync Work Tracker desktop app");
}
