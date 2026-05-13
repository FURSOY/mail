use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, Window};

const WINDOW_STATE_FILE: &str = "window-state.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistedWindowState {
    width: u32,
    height: u32,
    x: i32,
    y: i32,
}

fn state_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Pencere ayar klasoru bulunamadi: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("Pencere ayar klasoru olusturulamadi: {e}"))?;
    Ok(dir.join(WINDOW_STATE_FILE))
}

pub fn restore_window_state(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    let Ok(path) = state_path(app) else {
        return;
    };

    let Ok(text) = fs::read_to_string(path) else {
        return;
    };

    let Ok(state) = serde_json::from_str::<PersistedWindowState>(&text) else {
        return;
    };

    if state.width < 640 || state.height < 420 {
        return;
    }

    let _ = window.set_size(PhysicalSize::new(state.width, state.height));
    let _ = window.set_position(PhysicalPosition::new(state.x, state.y));
}

pub fn save_window_state(window: &Window) {
    if window.label() != "main" {
        return;
    }

    let Ok(is_minimized) = window.is_minimized() else {
        return;
    };
    if is_minimized {
        return;
    }

    let Ok(size) = window.outer_size() else {
        return;
    };
    let Ok(position) = window.outer_position() else {
        return;
    };

    if size.width < 640 || size.height < 420 {
        return;
    }

    let state = PersistedWindowState {
        width: size.width,
        height: size.height,
        x: position.x,
        y: position.y,
    };

    let app = window.app_handle();
    let Ok(path) = state_path(&app) else {
        return;
    };
    let Ok(json) = serde_json::to_string_pretty(&state) else {
        return;
    };

    let _ = fs::write(path, json);
}
