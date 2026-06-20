mod auth;
mod db;
mod gmail;
mod img_proxy;
mod notify;
mod settings;
mod window_state;

use std::collections::HashSet;
use std::sync::Mutex;
use tauri::Emitter;

/// Per-account sync lock — prevents concurrent syncs for the same account
pub struct SyncState {
    pub is_syncing: Mutex<HashSet<String>>,
    pub resync_requested: Mutex<HashSet<String>>,
}

fn is_background_launch() -> bool {
    std::env::args().any(|arg| arg == "--background" || arg == "--hidden" || arg == "--minimized")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .register_asynchronous_uri_scheme_protocol("mailimg", |_app, request, responder| {
            let uri = request.uri().to_string();
            tauri::async_runtime::spawn(async move {
                let response = match img_proxy::fetch_remote_image(uri).await {
                    Ok((bytes, content_type)) => tauri::http::Response::builder()
                        .status(200)
                        .header("Content-Type", content_type)
                        .header("Access-Control-Allow-Origin", "*")
                        .header("Cross-Origin-Resource-Policy", "cross-origin")
                        .header("Cache-Control", "max-age=86400")
                        .body(bytes)
                        .unwrap_or_else(|_| {
                            tauri::http::Response::builder()
                                .status(500)
                                .body(Vec::new())
                                .unwrap()
                        }),
                    Err(_) => tauri::http::Response::builder()
                        .status(404)
                        .body(Vec::new())
                        .unwrap(),
                };
                responder.respond(response);
            });
        })
        .manage(SyncState {
            is_syncing: Mutex::new(HashSet::new()),
            resync_requested: Mutex::new(HashSet::new()),
        })
        .manage(notify::PendingNotification(Mutex::new(None)))
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
                window_state::save_window_state(window);
            }
            tauri::WindowEvent::CloseRequested { api, .. } => {
                if window.label() == "main" {
                    window_state::save_window_state(window);
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
            _ => {}
        })
        .setup(|app| {
            let background_launch = is_background_launch();

            let _ = dotenvy::dotenv();

            db::init_db(app.handle()).expect("Failed to initialize database");
            window_state::restore_window_state(app.handle());
            if let Some(window) = app.get_webview_window("main") {
                if background_launch {
                    let _ = window.hide();
                } else {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }

            use tauri::{
                menu::{CheckMenuItem, Menu, MenuItem},
                tray::TrayIconBuilder,
                Manager,
            };
            let controls = settings::read_app_controls(app.handle());
            let mute_i = CheckMenuItem::with_id(
                app,
                "toggle_mute_notifications",
                "Bildirimleri sessize al",
                true,
                controls.notifications_muted,
                None::<&str>,
            )?;
            let pause_i = CheckMenuItem::with_id(
                app,
                "toggle_pause_sync",
                "Mail çekmeyi durdur",
                true,
                controls.mail_sync_paused,
                None::<&str>,
            )?;
            let quit_i = MenuItem::with_id(app, "quit", "Kapat", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&mute_i, &pause_i, &quit_i])?;
            let mute_item = mute_i.clone();
            let pause_item = pause_i.clone();

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .menu_on_left_click(false)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "toggle_mute_notifications" => {
                        let mut controls = settings::read_app_controls(app);
                        controls.notifications_muted = !controls.notifications_muted;
                        let _ = settings::write_app_controls(app, &controls);
                        let _ = mute_item.set_checked(controls.notifications_muted);
                        let _ = app.emit("app-controls-changed", controls);
                    }
                    "toggle_pause_sync" => {
                        let mut controls = settings::read_app_controls(app);
                        controls.mail_sync_paused = !controls.mail_sync_paused;
                        let _ = settings::write_app_controls(app, &controls);
                        let _ = pause_item.set_checked(controls.mail_sync_paused);
                        let _ = app.emit("app-controls-changed", controls);
                    }
                    "quit" => app.exit(0),
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
                            notify::show_main_window(&window);
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
            db::get_accounts,
            db::get_account_auth,
            db::remove_account,
            db::reorder_accounts,
            db::search_contacts,
            db::get_local_emails,
            db::get_emails_by_label,
            db::get_email_body,
            db::get_inbox_unread_count,
            db::get_thread_emails,
            gmail::sync_emails,
            gmail::mark_as_read,
            gmail::mark_as_unread,
            gmail::archive_email,
            gmail::trash_email,
            gmail::move_to_inbox,
            gmail::permanently_delete,
            gmail::send_reply,
            gmail::send_email,
            gmail::fetch_attachment_data,
            gmail::save_and_reveal_attachment,
            db::get_email_attachments,
            notify::show_custom_notification,
            notify::get_pending_notification,
            notify::get_screen_info,
            notify::is_system_fullscreen,
            notify::focus_main_window,
            settings::get_launch_at_startup,
            settings::set_launch_at_startup,
            settings::get_app_controls,
            settings::set_app_controls,
            settings::set_notifications_muted,
            settings::set_mail_sync_paused
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
