use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Emitter};
use windows::Win32::Foundation::RECT;
use windows::Win32::UI::WindowsAndMessaging::{
    GetClassNameW, GetDesktopWindow, GetForegroundWindow, GetWindowRect,
};

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct NotificationPayload {
    pub title: String,
    pub body: String,
    pub kind: Option<String>,
    pub code: Option<String>,
    #[serde(rename = "emailId")]
    pub email_id: Option<String>,
    pub duration: Option<u32>,
    #[serde(rename = "accountId")]
    pub account_id: Option<String>,
    #[serde(rename = "accountPicture")]
    pub account_picture: Option<String>,
}

pub struct PendingNotification(pub Mutex<Option<NotificationPayload>>);

#[tauri::command]
pub fn is_system_fullscreen() -> bool {
    is_fullscreen()
}

pub fn is_fullscreen() -> bool {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0 == std::ptr::null_mut() {
            return false;
        }

        let desktop = GetDesktopWindow();
        let mut desktop_rect = RECT::default();
        let mut window_rect = RECT::default();

        let _ = GetWindowRect(desktop, &mut desktop_rect);
        let _ = GetWindowRect(hwnd, &mut window_rect);

        let is_covering = window_rect.left <= 0
            && window_rect.top <= 0
            && window_rect.right >= desktop_rect.right
            && window_rect.bottom >= desktop_rect.bottom;

        if !is_covering {
            return false;
        }

        let mut class_name = [0u16; 256];
        let len = GetClassNameW(hwnd, &mut class_name) as usize;
        if len > 0 {
            let class_string = String::from_utf16_lossy(&class_name[..len]);
            if class_string == "WorkerW"
                || class_string == "Progman"
                || class_string == "Shell_TrayWnd"
            {
                return false;
            }
        }

        true
    }
}

const NOTIF_W: f64 = 340.0;
const MARGIN: f64 = 16.0;
const TASKBAR_H: f64 = 48.0;

#[tauri::command]
pub async fn show_custom_notification(
    app: AppHandle,
    title: String,
    body: String,
    kind: Option<String>,
    code: Option<String>,
    email_id: Option<String>,
    duration: Option<u32>,
    account_id: Option<String>,
    account_picture: Option<String>,
) {
    if crate::settings::read_app_controls(&app).notifications_muted {
        return;
    }

    if is_fullscreen() {
        return;
    }

    let payload = NotificationPayload { title, body, kind, code, email_id, duration, account_id, account_picture };

    // If window already exists (hidden or visible), just send new notification
    if let Some(window) = app.get_webview_window("notification") {
        let _ = window.emit("new-notification", payload);
        let _ = window.show();
        return;
    }

    // Store payload for first load
    if let Some(state) = app.try_state::<PendingNotification>() {
        *state.0.lock().unwrap() = Some(payload.clone());
    }

    let monitor_result = app.primary_monitor();
    let (screen_w, screen_h) = if let Ok(Some(monitor)) = monitor_result {
        let size = monitor.size();
        let scale = monitor.scale_factor();
        (size.width as f64 / scale, size.height as f64 / scale)
    } else {
        (1920.0, 1080.0)
    };

    let initial_h = 90.0; // fits one card; JS will resize after mount
    let x = screen_w - NOTIF_W - MARGIN;
    let y = screen_h - initial_h - MARGIN - TASKBAR_H;

    let app_clone = app.clone();
    let _ = app.run_on_main_thread(move || {
        let result = tauri::WebviewWindowBuilder::new(
            &app_clone,
            "notification",
            tauri::WebviewUrl::App("notification.html".into()),
        )
        .title("Notification")
        .inner_size(NOTIF_W, initial_h)
        .position(x, y)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .visible(false)
        .build();

        if let Err(e) = result {
            eprintln!("[NOTIFY] window build error: {:?}", e);
        }
    });
}

/// Called by notification window to get the initial payload
#[tauri::command]
pub fn get_pending_notification(app: AppHandle) -> Option<NotificationPayload> {
    if let Some(state) = app.try_state::<PendingNotification>() {
        state.0.lock().unwrap().take()
    } else {
        None
    }
}

/// Called by notification window to get screen info for repositioning
#[tauri::command]
pub fn get_screen_info(app: AppHandle) -> (f64, f64) {
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let size = monitor.size();
        let scale = monitor.scale_factor();
        (size.width as f64 / scale, size.height as f64 / scale)
    } else {
        (1920.0, 1080.0)
    }
}

/// Called by notification window to focus the main window reliably via Rust
#[tauri::command]
pub fn focus_main_window(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}
