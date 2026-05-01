mod auth;
mod db;
mod gmail;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // Load .env file for OAuth credentials
            let _ = dotenvy::dotenv();

            // Initialize database on startup
            db::init_db(app.handle()).expect("Failed to initialize database");
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            greet, 
            auth::start_google_oauth,
            auth::refresh_access_token,
            db::get_local_emails,
            db::get_emails_by_label,
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
