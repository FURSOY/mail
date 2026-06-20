use keyring::Entry;
use rusqlite::{params, Connection, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use tauri::{AppHandle, Manager};

// ── Per-account keyring ────────────────────────────────────────────────────────

const KEYRING_SERVICE: &str = "fursoy-mail";

fn account_key(email: &str) -> String {
    format!("oauth-{}", email)
}

pub fn save_tokens(email: &str, access_token: &str, refresh_token: &str) -> Result<(), String> {
    let data = serde_json::json!({
        "access_token": access_token,
        "refresh_token": refresh_token,
    })
    .to_string();
    Entry::new(KEYRING_SERVICE, &account_key(email))
        .and_then(|e| e.set_password(&data))
        .map_err(|e| format!("Token kaydedilemedi: {e}"))
}

pub fn load_tokens(email: &str) -> Option<(String, String)> {
    let json = Entry::new(KEYRING_SERVICE, &account_key(email))
        .ok()?
        .get_password()
        .ok()?;
    let val: serde_json::Value = serde_json::from_str(&json).ok()?;
    let access = val["access_token"].as_str()?.to_string();
    let refresh = val["refresh_token"].as_str()?.to_string();
    if access.is_empty() {
        return None;
    }
    Some((access, refresh))
}

pub fn delete_tokens(email: &str) {
    if let Ok(entry) = Entry::new(KEYRING_SERVICE, &account_key(email)) {
        let _ = entry.delete_credential();
    }
}

// Legacy single-account keyring (for one-time migration)
fn load_legacy_tokens() -> Option<(String, String)> {
    let json = Entry::new(KEYRING_SERVICE, "oauth-tokens")
        .ok()?
        .get_password()
        .ok()?;
    let val: serde_json::Value = serde_json::from_str(&json).ok()?;
    let access = val["access_token"].as_str()?.to_string();
    let refresh = val["refresh_token"].as_str()?.to_string();
    if access.is_empty() {
        return None;
    }
    Some((access, refresh))
}

fn delete_legacy_tokens() {
    if let Ok(entry) = Entry::new(KEYRING_SERVICE, "oauth-tokens") {
        let _ = entry.delete_credential();
    }
}

// ── Structs ────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Account {
    pub id: String, // same as email
    pub email: String,
    pub picture: String,
    pub display_order: i32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Attachment {
    pub id: String,
    pub email_id: String,
    pub account_id: String,
    pub filename: String,
    pub mime_type: String,
    pub size: i64,
    pub attachment_id: Option<String>, // Gmail attachment ID for on-demand fetch
    pub data: Option<String>,          // base64 data for small inline attachments
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Email {
    pub id: String,
    pub thread_id: String,
    pub sender: String,
    pub recipient: String,
    pub cc: String,
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
    pub thread_id: String,
    pub sender: String,
    pub recipient: String,
    pub cc: String,
    pub subject: String,
    pub snippet: String,
    pub date: i64,
    pub unread: bool,
    pub label: String,
    pub account_id: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AuthInfo {
    pub access_token: String,
    pub refresh_token: String,
    pub email: String,
    pub picture: String,
}

// ── DB path ────────────────────────────────────────────────────────────────────

pub fn get_db_path(app: &AppHandle) -> std::path::PathBuf {
    let app_dir = app.path().app_data_dir().unwrap();
    if !app_dir.exists() {
        fs::create_dir_all(&app_dir).unwrap();
    }
    app_dir.join("mailapp.db")
}

// ── init_db ────────────────────────────────────────────────────────────────────

pub fn init_db(app: &AppHandle) -> Result<()> {
    let db_path = get_db_path(app);
    let conn = Connection::open(db_path)?;

    // accounts table
    conn.execute(
        "CREATE TABLE IF NOT EXISTS accounts (
            id TEXT PRIMARY KEY,
            email TEXT NOT NULL UNIQUE,
            picture TEXT NOT NULL DEFAULT '',
            display_order INTEGER NOT NULL DEFAULT 0
        )",
        [],
    )?;

    // attachments table
    conn.execute(
        "CREATE TABLE IF NOT EXISTS attachments (
            id TEXT PRIMARY KEY,
            email_id TEXT NOT NULL,
            account_id TEXT NOT NULL,
            filename TEXT NOT NULL,
            mime_type TEXT NOT NULL,
            size INTEGER NOT NULL DEFAULT 0,
            attachment_id TEXT,
            data TEXT
        )",
        [],
    )?;

    // emails table
    conn.execute(
        "CREATE TABLE IF NOT EXISTS emails (
            id TEXT PRIMARY KEY,
            thread_id TEXT NOT NULL DEFAULT '',
            sender TEXT NOT NULL,
            recipient TEXT NOT NULL DEFAULT '',
            cc TEXT NOT NULL DEFAULT '',
            subject TEXT NOT NULL,
            snippet TEXT NOT NULL,
            body_html TEXT NOT NULL,
            date INTEGER NOT NULL,
            unread BOOLEAN NOT NULL,
            label TEXT NOT NULL DEFAULT 'inbox',
            account_id TEXT NOT NULL DEFAULT ''
        )",
        [],
    )?;

    // Migration: add missing columns to emails
    let mut thread_id_was_missing = false;
    for (col, ddl) in [
        ("label", "ALTER TABLE emails ADD COLUMN label TEXT NOT NULL DEFAULT 'inbox'"),
        ("recipient", "ALTER TABLE emails ADD COLUMN recipient TEXT NOT NULL DEFAULT ''"),
        ("thread_id", "ALTER TABLE emails ADD COLUMN thread_id TEXT NOT NULL DEFAULT ''"),
        ("cc", "ALTER TABLE emails ADD COLUMN cc TEXT NOT NULL DEFAULT ''"),
        ("account_id", "ALTER TABLE emails ADD COLUMN account_id TEXT NOT NULL DEFAULT ''"),
    ] {
        let exists: bool = conn
            .prepare(&format!(
                "SELECT COUNT(*) FROM pragma_table_info('emails') WHERE name='{}'",
                col
            ))
            .and_then(|mut s| s.query_row([], |r| r.get::<_, i64>(0)))
            .map(|c| c > 0)
            .unwrap_or(false);
        if !exists {
            conn.execute(ddl, [])?;
            if col == "thread_id" {
                thread_id_was_missing = true;
            }
        }
    }

    // If thread_id column was just added, all existing rows have thread_id=''.
    // Also handle the case where emails exist with empty thread_ids from old syncs.
    // Reset sync_state so the next startup does a full re-sync and re-fetches thread_ids.
    if thread_id_was_missing {
        conn.execute("DELETE FROM sync_state", []).ok();
    } else {
        let empty_thread_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM emails WHERE thread_id = ''",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        if empty_thread_count > 0 {
            conn.execute("DELETE FROM sync_state", []).ok();
        }
    }

    // sync_state: migrate to per-account schema
    let sync_has_account_id: bool = conn
        .prepare("SELECT COUNT(*) FROM pragma_table_info('sync_state') WHERE name='account_id'")
        .and_then(|mut s| s.query_row([], |r| r.get::<_, i64>(0)))
        .map(|c| c > 0)
        .unwrap_or(false);
    if !sync_has_account_id {
        conn.execute("DROP TABLE IF EXISTS sync_state", [])?;
    }
    conn.execute(
        "CREATE TABLE IF NOT EXISTS sync_state (
            account_id TEXT PRIMARY KEY,
            history_id TEXT
        )",
        [],
    )?;

    // Indexes for common queries
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_emails_label_date ON emails(label, date DESC)",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_emails_account_label_date ON emails(account_id, label, date DESC)",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_emails_inbox_unread ON emails(label, unread, account_id)",
        [],
    )?;

    // Legacy auth table (kept for migration only)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS auth (
            id INTEGER PRIMARY KEY,
            access_token TEXT NOT NULL DEFAULT '',
            refresh_token TEXT NOT NULL DEFAULT '',
            email TEXT NOT NULL DEFAULT '',
            picture TEXT NOT NULL DEFAULT ''
        )",
        [],
    )?;

    // One-time migration: auth row → accounts table
    let accounts_empty: bool = conn
        .query_row("SELECT COUNT(*) FROM accounts", [], |r| r.get::<_, i64>(0))
        .map(|c| c == 0)
        .unwrap_or(true);

    if accounts_empty {
        let legacy: Option<(String, String, String, String)> = {
            let mut stmt = conn
                .prepare(
                    "SELECT access_token, refresh_token, email, picture FROM auth WHERE id = 1",
                )
                .ok();
            stmt.as_mut().and_then(|s| {
                s.query_row([], |r| {
                    Ok((
                        r.get::<_, String>(0).unwrap_or_default(),
                        r.get::<_, String>(1).unwrap_or_default(),
                        r.get::<_, String>(2).unwrap_or_default(),
                        r.get::<_, String>(3).unwrap_or_default(),
                    ))
                })
                .ok()
            })
        };

        if let Some((sql_access, sql_refresh, email, picture)) = legacy {
            if !email.is_empty() {
                conn.execute(
                    "INSERT OR IGNORE INTO accounts (id, email, picture, display_order) VALUES (?1, ?2, ?3, 0)",
                    params![email, email, picture],
                )?;

                let (access, refresh) = if let Some(tokens) = load_legacy_tokens() {
                    delete_legacy_tokens();
                    tokens
                } else if !sql_access.is_empty() {
                    (sql_access, sql_refresh)
                } else {
                    (String::new(), String::new())
                };

                if !access.is_empty() {
                    let _ = save_tokens(&email, &access, &refresh);
                }

                conn.execute(
                    "UPDATE emails SET account_id = ?1 WHERE account_id = ''",
                    params![email],
                )?;
            }
        }
    }

    Ok(())
}

// ── Account CRUD ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_accounts(app: tauri::AppHandle) -> Result<Vec<Account>, String> {
    let db_path = get_db_path(&app);
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, email, picture, display_order \
             FROM accounts ORDER BY display_order ASC, id ASC",
        )
        .map_err(|e| e.to_string())?;
    let iter = stmt
        .query_map([], |row| {
            Ok(Account {
                id: row.get(0)?,
                email: row.get(1)?,
                picture: row.get(2)?,
                display_order: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(iter.filter_map(|r| r.ok()).collect())
}

pub fn upsert_account(app: &AppHandle, email: &str, picture: &str) -> Result<Account, String> {
    let db_path = get_db_path(app);
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;

    let max_order: i32 = conn
        .query_row(
            "SELECT COALESCE(MAX(display_order), -1) FROM accounts",
            [],
            |r| r.get(0),
        )
        .unwrap_or(-1);

    conn.execute(
        "INSERT INTO accounts (id, email, picture, display_order) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET picture = excluded.picture",
        params![email, email, picture, max_order + 1],
    )
    .map_err(|e| e.to_string())?;

    let display_order: i32 = conn
        .query_row(
            "SELECT display_order FROM accounts WHERE id = ?1",
            params![email],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;

    Ok(Account {
        id: email.to_string(),
        email: email.to_string(),
        picture: picture.to_string(),
        display_order,
    })
}

pub fn get_account_picture(app: &AppHandle, email: &str) -> String {
    let db_path = get_db_path(app);
    let conn = match Connection::open(db_path) {
        Ok(c) => c,
        Err(_) => return String::new(),
    };
    conn.query_row(
        "SELECT picture FROM accounts WHERE id = ?1",
        params![email],
        |r| r.get(0),
    )
    .unwrap_or_default()
}

#[tauri::command]
pub fn remove_account(app: tauri::AppHandle, account_id: String) -> Result<(), String> {
    delete_tokens(&account_id);

    let db_path = get_db_path(&app);
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;

    conn.execute(
        "DELETE FROM emails WHERE account_id = ?1",
        params![account_id],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM sync_state WHERE account_id = ?1",
        params![account_id],
    )
    .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM accounts WHERE id = ?1", params![account_id])
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub fn reorder_accounts(app: tauri::AppHandle, ordered_ids: Vec<String>) -> Result<(), String> {
    let db_path = get_db_path(&app);
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    for (i, id) in ordered_ids.iter().enumerate() {
        conn.execute(
            "UPDATE accounts SET display_order = ?1 WHERE id = ?2",
            params![i as i32, id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ── Contact autocomplete ───────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct ContactSuggestion {
    pub name: String,
    pub email: String,
}

fn parse_contact(raw: &str) -> (String, String) {
    let s = raw.trim();
    if let Some(lt) = s.find('<') {
        if let Some(gt) = s.rfind('>') {
            let name = s[..lt].trim().trim_matches('"').to_string();
            let email = s[lt + 1..gt].trim().to_string();
            return (name, email);
        }
    }
    if s.contains('@') {
        return (String::new(), s.to_string());
    }
    (String::new(), String::new())
}

#[tauri::command]
pub fn search_contacts(
    app: AppHandle,
    query: String,
) -> Result<Vec<ContactSuggestion>, String> {
    if query.trim().is_empty() {
        return Ok(vec![]);
    }
    let db_path = get_db_path(&app);
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    let like = format!("%{}%", query.to_lowercase());

    let mut raw_pairs: Vec<(String, i64)> = Vec::new();

    // Senders from received emails
    let mut stmt = conn
        .prepare(
            "SELECT sender, COUNT(*) FROM emails \
             WHERE label != 'sent' AND sender != '' AND LOWER(sender) LIKE ?1 \
             GROUP BY sender ORDER BY COUNT(*) DESC LIMIT 20",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![like], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
        .map_err(|e| e.to_string())?;
    for r in rows.flatten() {
        raw_pairs.push(r);
    }

    // Recipients from sent emails
    let mut stmt2 = conn
        .prepare(
            "SELECT recipient, COUNT(*) FROM emails \
             WHERE label = 'sent' AND recipient != '' AND LOWER(recipient) LIKE ?1 \
             GROUP BY recipient ORDER BY COUNT(*) DESC LIMIT 20",
        )
        .map_err(|e| e.to_string())?;
    let rows2 = stmt2
        .query_map(params![like], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
        .map_err(|e| e.to_string())?;
    for r in rows2.flatten() {
        raw_pairs.push(r);
    }

    // Parse, dedupe by email, sort by count
    let q = query.to_lowercase();
    let mut counts: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
    let mut best: std::collections::HashMap<String, ContactSuggestion> =
        std::collections::HashMap::new();

    for (raw, count) in raw_pairs {
        for part in raw.split(',') {
            let (name, email) = parse_contact(part.trim());
            if email.is_empty() || !email.contains('@') {
                continue;
            }
            let el = email.to_lowercase();
            if !el.contains(&q) && !name.to_lowercase().contains(&q) {
                continue;
            }
            *counts.entry(el.clone()).or_insert(0) += count;
            best.entry(el).or_insert(ContactSuggestion { name, email });
        }
    }

    let mut result: Vec<(i64, ContactSuggestion)> = counts
        .into_iter()
        .filter_map(|(k, c)| best.remove(&k).map(|s| (c, s)))
        .collect();
    result.sort_by(|a, b| b.0.cmp(&a.0));

    Ok(result.into_iter().take(8).map(|(_, s)| s).collect())
}

#[tauri::command]
pub fn get_account_auth(
    app: tauri::AppHandle,
    account_id: String,
) -> Result<Option<AuthInfo>, String> {
    let db_path = get_db_path(&app);
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;

    let row: Option<(String, String)> = conn
        .query_row(
            "SELECT email, picture FROM accounts WHERE id = ?1",
            params![account_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .ok();

    let Some((email, picture)) = row else {
        return Ok(None);
    };

    let Some((access_token, refresh_token)) = load_tokens(&email) else {
        return Ok(None);
    };

    Ok(Some(AuthInfo {
        access_token,
        refresh_token,
        email,
        picture,
    }))
}

// ── Email CRUD ────────────────────────────────────────────────────────────────

pub fn upsert_emails(app: &AppHandle, account_id: &str, emails: Vec<Email>) -> Result<()> {
    let db_path = get_db_path(app);
    let mut conn = Connection::open(db_path)?;
    let tx = conn.transaction()?;

    {
        let mut stmt = tx.prepare(
            "INSERT INTO emails (id, thread_id, sender, recipient, cc, subject, snippet, \
                                 body_html, date, unread, label, account_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT(id) DO UPDATE SET
                thread_id = excluded.thread_id,
                sender    = excluded.sender,
                recipient = excluded.recipient,
                cc        = excluded.cc,
                subject   = excluded.subject,
                snippet   = excluded.snippet,
                body_html = excluded.body_html,
                date      = excluded.date,
                unread    = excluded.unread,
                label     = excluded.label,
                account_id= excluded.account_id",
        )?;

        for email in emails {
            stmt.execute(params![
                email.id,
                email.thread_id,
                email.sender,
                email.recipient,
                email.cc,
                email.subject,
                email.snippet,
                email.body_html,
                email.date,
                email.unread,
                email.label,
                account_id,
            ])?;
        }
    }

    tx.commit()?;
    Ok(())
}

fn map_summary_row(row: &rusqlite::Row) -> rusqlite::Result<EmailSummary> {
    Ok(EmailSummary {
        id: row.get(0)?,
        thread_id: row.get(1)?,
        sender: row.get(2)?,
        recipient: row.get(3)?,
        cc: row.get(4)?,
        subject: row.get(5)?,
        snippet: row.get(6)?,
        date: row.get(7)?,
        unread: row.get(8)?,
        label: row.get(9)?,
        account_id: row.get(10)?,
    })
}

const SUMMARY_COLS: &str =
    "id, thread_id, sender, recipient, cc, subject, snippet, date, unread, label, account_id";

#[tauri::command]
pub fn get_emails_by_label(
    app: tauri::AppHandle,
    label: String,
    account_id: Option<String>,
) -> Result<Vec<EmailSummary>, String> {
    let db_path = get_db_path(&app);
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;

    match account_id {
        Some(id) => {
            let sql = format!(
                "SELECT {SUMMARY_COLS} FROM emails WHERE label = ?1 AND account_id = ?2 ORDER BY date DESC"
            );
            let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
            let rows: Vec<EmailSummary> = stmt
                .query_map(params![label, id], map_summary_row)
                .map_err(|e| e.to_string())?
                .filter_map(|r| r.ok())
                .collect();
            Ok(rows)
        }
        None => {
            let sql = format!(
                "SELECT {SUMMARY_COLS} FROM emails WHERE label = ?1 ORDER BY date DESC"
            );
            let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
            let rows: Vec<EmailSummary> = stmt
                .query_map(params![label], map_summary_row)
                .map_err(|e| e.to_string())?
                .filter_map(|r| r.ok())
                .collect();
            Ok(rows)
        }
    }
}

#[tauri::command]
pub fn get_local_emails(
    app: tauri::AppHandle,
    account_id: Option<String>,
) -> Result<Vec<EmailSummary>, String> {
    let db_path = get_db_path(&app);
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;

    match account_id {
        Some(id) => {
            let sql = format!(
                "SELECT {SUMMARY_COLS} FROM emails WHERE account_id = ?1 ORDER BY date DESC"
            );
            let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
            let rows: Vec<EmailSummary> = stmt
                .query_map(params![id], map_summary_row)
                .map_err(|e| e.to_string())?
                .filter_map(|r| r.ok())
                .collect();
            Ok(rows)
        }
        None => {
            let sql =
                format!("SELECT {SUMMARY_COLS} FROM emails ORDER BY date DESC");
            let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
            let rows: Vec<EmailSummary> = stmt
                .query_map([], map_summary_row)
                .map_err(|e| e.to_string())?
                .filter_map(|r| r.ok())
                .collect();
            Ok(rows)
        }
    }
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

pub fn mark_email_as_unread_local(app: &AppHandle, id: &str) -> Result<(), String> {
    let db_path = get_db_path(app);
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    conn.execute("UPDATE emails SET unread = 1 WHERE id = ?1", params![id])
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

#[tauri::command]
pub fn get_inbox_unread_count(
    app: tauri::AppHandle,
    account_id: Option<String>,
) -> Result<i64, String> {
    let db_path = get_db_path(&app);
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    let count: i64 = match account_id {
        Some(id) => conn.query_row(
            "SELECT COUNT(*) FROM emails WHERE label = 'inbox' AND unread = 1 AND account_id = ?1",
            params![id],
            |row| row.get(0),
        ),
        None => conn.query_row(
            "SELECT COUNT(*) FROM emails WHERE label = 'inbox' AND unread = 1",
            [],
            |row| row.get(0),
        ),
    }
    .map_err(|e| e.to_string())?;
    Ok(count)
}

// ── Sync state (per-account history ID) ────────────────────────────────────────

pub fn get_history_id(app: &AppHandle, account_id: &str) -> Option<String> {
    let db_path = get_db_path(app);
    let conn = Connection::open(db_path).ok()?;
    conn.query_row(
        "SELECT history_id FROM sync_state WHERE account_id = ?1",
        params![account_id],
        |row| row.get::<_, Option<String>>(0),
    )
    .ok()
    .flatten()
}

pub fn set_history_id(app: &AppHandle, account_id: &str, history_id: &str) -> Result<(), String> {
    let db_path = get_db_path(app);
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO sync_state (account_id, history_id) VALUES (?1, ?2)
         ON CONFLICT(account_id) DO UPDATE SET history_id = excluded.history_id",
        params![account_id, history_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_thread_emails(
    app: tauri::AppHandle,
    thread_id: String,
) -> Result<Vec<EmailSummary>, String> {
    if thread_id.is_empty() {
        return Ok(vec![]);
    }
    let db_path = get_db_path(&app);
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    let sql = format!(
        "SELECT {SUMMARY_COLS} FROM emails WHERE thread_id = ?1 ORDER BY date ASC"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows: Vec<EmailSummary> = stmt
        .query_map(params![thread_id], map_summary_row)
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

pub fn upsert_attachments(app: &AppHandle, attachments: Vec<Attachment>) -> Result<()> {
    if attachments.is_empty() {
        return Ok(());
    }
    let db_path = get_db_path(app);
    let mut conn = Connection::open(db_path)?;
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO attachments (id, email_id, account_id, filename, mime_type, size, attachment_id, data)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(id) DO UPDATE SET
                filename      = excluded.filename,
                mime_type     = excluded.mime_type,
                size          = excluded.size,
                attachment_id = excluded.attachment_id,
                data          = excluded.data",
        )?;
        for att in &attachments {
            stmt.execute(params![
                att.id, att.email_id, att.account_id,
                att.filename, att.mime_type, att.size,
                att.attachment_id, att.data,
            ])?;
        }
    }
    tx.commit()?;
    Ok(())
}

#[tauri::command]
pub fn get_email_attachments(
    app: tauri::AppHandle,
    email_id: String,
) -> Result<Vec<Attachment>, String> {
    let db_path = get_db_path(&app);
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, email_id, account_id, filename, mime_type, size, attachment_id, data
             FROM attachments WHERE email_id = ?1 ORDER BY rowid ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![email_id], |row| {
            Ok(Attachment {
                id: row.get(0)?,
                email_id: row.get(1)?,
                account_id: row.get(2)?,
                filename: row.get(3)?,
                mime_type: row.get(4)?,
                size: row.get(5)?,
                attachment_id: row.get(6)?,
                data: row.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

pub fn delete_emails_by_ids(app: &AppHandle, ids: &[String]) -> Result<(), String> {
    if ids.is_empty() {
        return Ok(());
    }
    let db_path = get_db_path(app);
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    let placeholders: Vec<String> = ids
        .iter()
        .enumerate()
        .map(|(i, _)| format!("?{}", i + 1))
        .collect();
    let sql = format!("DELETE FROM emails WHERE id IN ({})", placeholders.join(","));
    let params: Vec<&dyn rusqlite::types::ToSql> =
        ids.iter().map(|s| s as &dyn rusqlite::types::ToSql).collect();
    conn.execute(&sql, params.as_slice())
        .map_err(|e| e.to_string())?;
    Ok(())
}
