mod auth;
mod db;
mod gmail;

use std::sync::Mutex;

/// Global sync lock — prevents concurrent syncs from corrupting the database
pub struct SyncState {
    pub is_syncing: Mutex<bool>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(SyncState {
            is_syncing: Mutex::new(false),
        })
        .setup(|app| {
            // Load .env file for OAuth credentials
            let _ = dotenvy::dotenv();

            // Initialize database on startup
            db::init_db(app.handle()).expect("Failed to initialize database");
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            auth::start_google_oauth,
            auth::refresh_access_token,
            db::get_local_emails,
            db::get_emails_by_label,
            db::get_inbox_unread_count,
            db::get_auth_info,
            db::logout,
            gmail::sync_emails,
            gmail::mark_as_read,
            gmail::archive_email,
            gmail::trash_email,
            gmail::send_reply,
            gmail::send_email
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
