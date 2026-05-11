use rusqlite::{params, Connection, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use tauri::{AppHandle, Manager};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Email {
    pub id: String,
    pub sender: String,
    pub recipient: String,
    pub subject: String,
    pub snippet: String,
    pub body_html: String,
    pub date: i64,
    pub unread: bool,
    pub label: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct EmailSummary {
    pub id: String,
    pub sender: String,
    pub recipient: String,
    pub subject: String,
    pub snippet: String,
    pub date: i64,
    pub unread: bool,
    pub label: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AuthInfo {
    pub access_token: String,
    pub refresh_token: String,
    pub email: String,
    pub picture: String,
}

pub fn get_db_path(app: &AppHandle) -> std::path::PathBuf {
    let app_dir = app.path().app_data_dir().unwrap();
    if !app_dir.exists() {
        fs::create_dir_all(&app_dir).unwrap();
    }
    app_dir.join("mailapp.db")
}

pub fn init_db(app: &AppHandle) -> Result<()> {
    let db_path = get_db_path(app);
    let conn = Connection::open(db_path)?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS emails (
            id TEXT PRIMARY KEY,
            sender TEXT NOT NULL,
            recipient TEXT NOT NULL DEFAULT '',
            subject TEXT NOT NULL,
            snippet TEXT NOT NULL,
            body_html TEXT NOT NULL,
            date INTEGER NOT NULL,
            unread BOOLEAN NOT NULL,
            label TEXT NOT NULL DEFAULT 'inbox'
        )",
        [],
    )?;

    // Migration: add columns if they don't exist (for existing databases)
    let has_label: bool = conn
        .prepare("SELECT COUNT(*) FROM pragma_table_info('emails') WHERE name='label'")
        .and_then(|mut s| s.query_row([], |r| r.get::<_, i64>(0)))
        .map(|c| c > 0)
        .unwrap_or(false);
    if !has_label {
        conn.execute(
            "ALTER TABLE emails ADD COLUMN label TEXT NOT NULL DEFAULT 'inbox'",
            [],
        )?;
    }

    let has_recipient: bool = conn
        .prepare("SELECT COUNT(*) FROM pragma_table_info('emails') WHERE name='recipient'")
        .and_then(|mut s| s.query_row([], |r| r.get::<_, i64>(0)))
        .map(|c| c > 0)
        .unwrap_or(false);
    if !has_recipient {
        conn.execute(
            "ALTER TABLE emails ADD COLUMN recipient TEXT NOT NULL DEFAULT ''",
            [],
        )?;
    }

    conn.execute(
        "CREATE TABLE IF NOT EXISTS auth (
            id INTEGER PRIMARY KEY,
            access_token TEXT NOT NULL,
            refresh_token TEXT NOT NULL,
            email TEXT NOT NULL,
            picture TEXT NOT NULL
        )",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS sync_state (
            id INTEGER PRIMARY KEY DEFAULT 1,
            history_id TEXT
        )",
        [],
    )?;

    Ok(())
}

pub fn upsert_emails(app: &AppHandle, emails: Vec<Email>) -> Result<()> {
    let db_path = get_db_path(app);
    let mut conn = Connection::open(db_path)?;
    let tx = conn.transaction()?;

    {
        let mut stmt = tx.prepare(
            "INSERT INTO emails (id, sender, recipient, subject, snippet, body_html, date, unread, label)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(id) DO UPDATE SET
                sender=excluded.sender,
                recipient=excluded.recipient,
                subject=excluded.subject,
                snippet=excluded.snippet,
                body_html=excluded.body_html,
                date=excluded.date,
                unread=excluded.unread,
                label=excluded.label",
        )?;

        for email in emails {
            stmt.execute(params![
                email.id,
                email.sender,
                email.recipient,
                email.subject,
                email.snippet,
                email.body_html,
                email.date,
                email.unread,
                email.label,
            ])?;
        }
    }

    tx.commit()?;
    Ok(())
}

#[tauri::command]
pub fn get_emails_by_label(app: tauri::AppHandle, label: String) -> Result<Vec<EmailSummary>, String> {
    let db_path = get_db_path(&app);
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare("SELECT id, sender, recipient, subject, snippet, date, unread, label FROM emails WHERE label = ?1 ORDER BY date DESC")
        .map_err(|e| e.to_string())?;

    let email_iter = stmt
        .query_map(params![label], |row| {
            Ok(EmailSummary {
                id: row.get(0)?,
                sender: row.get(1)?,
                recipient: row.get(2)?,
                subject: row.get(3)?,
                snippet: row.get(4)?,
                date: row.get(5)?,
                unread: row.get(6)?,
                label: row.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut emails = Vec::new();
    for email in email_iter {
        if let Ok(e) = email {
            emails.push(e);
        }
    }

    Ok(emails)
}

#[tauri::command]
pub fn get_local_emails(app: tauri::AppHandle) -> Result<Vec<EmailSummary>, String> {
    let db_path = get_db_path(&app);
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare("SELECT id, sender, recipient, subject, snippet, date, unread, label FROM emails ORDER BY date DESC")
        .map_err(|e| e.to_string())?;

    let email_iter = stmt
        .query_map([], |row| {
            Ok(EmailSummary {
                id: row.get(0)?,
                sender: row.get(1)?,
                recipient: row.get(2)?,
                subject: row.get(3)?,
                snippet: row.get(4)?,
                date: row.get(5)?,
                unread: row.get(6)?,
                label: row.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut emails = Vec::new();
    for email in email_iter {
        if let Ok(e) = email {
            emails.push(e);
        }
    }

    Ok(emails)
}

#[tauri::command]
pub fn get_email_body(app: tauri::AppHandle, id: String) -> Result<String, String> {
    let db_path = get_db_path(&app);
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;

    conn.query_row(
        "SELECT body_html FROM emails WHERE id = ?1",
        params![id],
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())
}

pub fn mark_email_as_read_local(app: &AppHandle, id: &str) -> Result<(), String> {
    let db_path = get_db_path(app);
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;

    conn.execute("UPDATE emails SET unread = 0 WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;

    Ok(())
}

pub fn update_email_label(app: &AppHandle, id: &str, label: &str) -> Result<(), String> {
    let db_path = get_db_path(app);
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;

    conn.execute(
        "UPDATE emails SET label = ?1 WHERE id = ?2",
        params![label, id],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

pub fn delete_email_from_db(app: &AppHandle, id: &str) -> Result<(), String> {
    let db_path = get_db_path(app);
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;

    conn.execute("DELETE FROM emails WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;

    Ok(())
}

pub fn save_auth(app: &AppHandle, auth: AuthInfo) -> Result<(), String> {
    let db_path = get_db_path(app);
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;

    conn.execute(
        "INSERT INTO auth (id, access_token, refresh_token, email, picture) 
         VALUES (1, ?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET 
            access_token=excluded.access_token,
            refresh_token=excluded.refresh_token,
            email=excluded.email,
            picture=excluded.picture",
        params![
            auth.access_token,
            auth.refresh_token,
            auth.email,
            auth.picture
        ],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub fn get_auth_info(app: tauri::AppHandle) -> Result<Option<AuthInfo>, String> {
    let db_path = get_db_path(&app);
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare("SELECT access_token, refresh_token, email, picture FROM auth WHERE id = 1")
        .map_err(|e| e.to_string())?;

    let mut rows = stmt.query([]).map_err(|e| e.to_string())?;

    if let Some(row) = rows.next().map_err(|e| e.to_string())? {
        Ok(Some(AuthInfo {
            access_token: row.get(0).unwrap_or_default(),
            refresh_token: row.get(1).unwrap_or_default(),
            email: row.get(2).unwrap_or_default(),
            picture: row.get(3).unwrap_or_default(),
        }))
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub fn logout(app: tauri::AppHandle) -> Result<(), String> {
    let db_path = get_db_path(&app);
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;

    conn.execute("DELETE FROM auth WHERE id = 1", [])
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub fn get_inbox_unread_count(app: tauri::AppHandle) -> Result<i64, String> {
    let db_path = get_db_path(&app);
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;

    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM emails WHERE label = 'inbox' AND unread = 1",
            [],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    Ok(count)
}

// ── Sync state (history ID) ──

pub fn get_history_id(app: &AppHandle) -> Option<String> {
    let db_path = get_db_path(app);
    let conn = Connection::open(db_path).ok()?;
    conn.query_row(
        "SELECT history_id FROM sync_state WHERE id = 1",
        [],
        |row| row.get::<_, Option<String>>(0),
    )
    .ok()
    .flatten()
}

pub fn set_history_id(app: &AppHandle, history_id: &str) -> Result<(), String> {
    let db_path = get_db_path(app);
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO sync_state (id, history_id) VALUES (1, ?1)
         ON CONFLICT(id) DO UPDATE SET history_id = excluded.history_id",
        params![history_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn delete_emails_by_ids(app: &AppHandle, ids: &[String]) -> Result<(), String> {
    if ids.is_empty() {
        return Ok(());
    }
    let db_path = get_db_path(app);
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    let placeholders: Vec<String> = ids.iter().enumerate().map(|(i, _)| format!("?{}", i + 1)).collect();
    let sql = format!("DELETE FROM emails WHERE id IN ({})", placeholders.join(","));
    let params: Vec<&dyn rusqlite::types::ToSql> = ids.iter().map(|s| s as &dyn rusqlite::types::ToSql).collect();
    conn.execute(&sql, params.as_slice()).map_err(|e| e.to_string())?;
    Ok(())
}
