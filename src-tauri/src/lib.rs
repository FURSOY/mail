mod auth;
mod db;
mod gmail;
mod notify;
mod settings;
mod window_state;

use std::sync::Mutex;

/// Global sync lock — prevents concurrent syncs; coalesces overlapping requests into one follow-up sync
pub struct SyncState {
    pub is_syncing: Mutex<bool>,
    pub resync_requested: Mutex<bool>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(SyncState {
            is_syncing: Mutex::new(false),
            resync_requested: Mutex::new(false),
        })
        .manage(notify::PendingNotification(Mutex::new(None)))
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
                window_state::save_window_state(window);
            }
            tauri::WindowEvent::CloseRequested { api, .. } => {
                // Only intercept close on main window; let notification window close normally
                if window.label() == "main" {
                    window_state::save_window_state(window);
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
            _ => {}
        })
        .setup(|app| {
            // Load .env file for OAuth credentials
            let _ = dotenvy::dotenv();

            // Initialize database on startup
            db::init_db(app.handle()).expect("Failed to initialize database");
            window_state::restore_window_state(app.handle());

            // Setup System Tray
            use tauri::{menu::{Menu, MenuItem}, tray::TrayIconBuilder, Manager};
            let quit_i = MenuItem::with_id(app, "quit", "Kapat", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&quit_i])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            auth::start_google_oauth,
            auth::refresh_access_token,
            db::get_local_emails,
            db::get_emails_by_label,
            db::get_email_body,
            db::get_inbox_unread_count,
            db::get_auth_info,
            db::logout,
            gmail::sync_emails,
            gmail::mark_as_read,
            gmail::archive_email,
            gmail::trash_email,
            gmail::move_to_inbox,
            gmail::permanently_delete,
            gmail::send_reply,
            gmail::send_email,
            notify::show_custom_notification,
            notify::get_pending_notification,
            notify::get_screen_info,
            notify::is_system_fullscreen,
            notify::focus_main_window,
            settings::get_launch_at_startup,
            settings::set_launch_at_startup
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
