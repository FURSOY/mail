use crate::db::{delete_emails_by_ids, get_history_id, load_tokens, set_history_id, upsert_emails, Email};
use base64::Engine;
use futures::stream::{self, StreamExt};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Deserialize, Serialize, Debug, Clone)]
pub struct AttachmentPayload {
    pub filename: String,
    #[serde(rename = "mimeType")]
    pub mime_type: String,
    pub data: String, // base64-encoded file content
}

// ── History API types ──

#[derive(Deserialize, Debug)]
struct HistoryListResponse {
    history: Option<Vec<HistoryRecord>>,
    #[serde(rename = "nextPageToken")]
    next_page_token: Option<String>,
    #[serde(rename = "historyId")]
    history_id: Option<String>,
}

#[derive(Deserialize, Debug)]
struct HistoryRecord {
    #[serde(rename = "messagesAdded")]
    messages_added: Option<Vec<HistoryMessage>>,
    #[serde(rename = "messagesDeleted")]
    messages_deleted: Option<Vec<HistoryMessage>>,
    #[serde(rename = "labelsAdded")]
    labels_added: Option<Vec<HistoryLabelChange>>,
    #[serde(rename = "labelsRemoved")]
    labels_removed: Option<Vec<HistoryLabelChange>>,
}

#[derive(Deserialize, Debug)]
struct HistoryMessage {
    message: HistoryMessageRef,
}

#[derive(Deserialize, Debug)]
struct HistoryMessageRef {
    id: String,
    #[serde(rename = "labelIds")]
    label_ids: Option<Vec<String>>,
}

#[derive(Deserialize, Debug)]
struct HistoryLabelChange {
    message: HistoryMessageRef,
    #[serde(rename = "labelIds")]
    label_ids: Option<Vec<String>>,
}

#[derive(Deserialize, Debug)]
struct ProfileResponse {
    #[serde(rename = "historyId")]
    history_id: String,
}

// ── Get current historyId from Gmail profile ──
async fn get_profile_history_id(client: &Client, access_token: &str) -> Result<String, String> {
    let res = client
        .get("https://gmail.googleapis.com/gmail/v1/users/me/profile")
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| format!("Profile fetch error: {}", e))?;

    if !res.status().is_success() {
        return Err(format!("Profile API error: {}", res.status()));
    }

    let profile: ProfileResponse = res.json().await.map_err(|e| e.to_string())?;
    Ok(profile.history_id)
}

// ── Fetch history changes since a given historyId ──
async fn fetch_history(
    client: &Client,
    access_token: &str,
    start_history_id: &str,
) -> Result<(Vec<String>, Vec<String>, Vec<String>, String), String> {
    // Returns: (added_ids, deleted_ids, changed_ids, new_history_id)
    let mut added_ids = std::collections::HashSet::new();
    let mut deleted_ids = std::collections::HashSet::new();
    let mut changed_ids = std::collections::HashSet::new();
    let mut latest_history_id = start_history_id.to_string();
    let mut page_token: Option<String> = None;

    loop {
        let mut url = format!(
            "https://gmail.googleapis.com/gmail/v1/users/me/history?startHistoryId={}&maxResults=500",
            start_history_id
        );
        if let Some(ref token) = page_token {
            url.push_str(&format!("&pageToken={}", token));
        }

        let res = client
            .get(&url)
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(|e| format!("History fetch error: {}", e))?;

        let status = res.status();
        if status.as_u16() == 404 {
            return Err("HISTORY_EXPIRED".to_string());
        }
        if !status.is_success() {
            let body = res.text().await.unwrap_or_default();
            if body.contains("notFound") || body.contains("Start history id is too old") {
                return Err("HISTORY_EXPIRED".to_string());
            }
            return Err(format!("History API error {}: {}", status, body));
        }

        let data: HistoryListResponse = res.json().await.map_err(|e| e.to_string())?;

        if let Some(hid) = &data.history_id {
            latest_history_id = hid.clone();
        }

        if let Some(records) = data.history {
            for record in records {
                if let Some(added) = record.messages_added {
                    for msg in added {
                        added_ids.insert(msg.message.id);
                    }
                }
                if let Some(deleted) = record.messages_deleted {
                    for msg in deleted {
                        deleted_ids.insert(msg.message.id);
                    }
                }
                if let Some(label_adds) = record.labels_added {
                    for change in label_adds {
                        changed_ids.insert(change.message.id);
                    }
                }
                if let Some(label_removes) = record.labels_removed {
                    for change in label_removes {
                        changed_ids.insert(change.message.id);
                    }
                }
            }
        }

        if data.next_page_token.is_none() {
            break;
        }
        page_token = data.next_page_token;
    }

    // Remove deleted from added/changed (if a message was added then deleted)
    for did in &deleted_ids {
        added_ids.remove(did);
        changed_ids.remove(did);
    }

    // Merge added + changed (both need a full fetch)
    let mut fetch_ids: Vec<String> = added_ids.into_iter().collect();
    for cid in changed_ids {
        if !fetch_ids.contains(&cid) {
            fetch_ids.push(cid);
        }
    }

    Ok((
        fetch_ids,
        deleted_ids.into_iter().collect(),
        vec![], // unused
        latest_history_id,
    ))
}

// ── Incremental sync using History API ──
async fn do_incremental_sync(
    app: &AppHandle,
    account_id: &str,
    access_token: &str,
    start_history_id: &str,
) -> Result<(), String> {
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .unwrap_or_default();

    let (fetch_ids, delete_ids, _, new_history_id) =
        fetch_history(&client, access_token, start_history_id).await?;

    eprintln!(
        "[SYNC:{}] incremental: {} to fetch, {} to delete, new historyId={}",
        account_id,
        fetch_ids.len(),
        delete_ids.len(),
        new_history_id
    );

    // Delete removed messages from DB
    if !delete_ids.is_empty() {
        let app_clone = app.clone();
        let ids = delete_ids.clone();
        tokio::task::spawn_blocking(move || delete_emails_by_ids(&app_clone, &ids))
            .await
            .map_err(|e| format!("DB delete task failed: {}", e))??;
    }

    // Fetch details for new/changed messages
    if !fetch_ids.is_empty() {
        let parsed: Vec<(Email, Vec<crate::db::Attachment>)> = stream::iter(fetch_ids)
            .map(|id| {
                let client = &client;
                let token = access_token;
                async move {
                    fetch_message_detail(client, token, &id)
                        .await
                        .ok()
                        .map(parse_message_detail)
                }
            })
            .buffer_unordered(10)
            .filter_map(|x| async { x })
            .collect()
            .await;

        if !parsed.is_empty() {
            let acct = account_id.to_string();
            let (emails, mut all_attachments): (Vec<Email>, Vec<Vec<crate::db::Attachment>>) =
                parsed.into_iter().unzip();
            // Backfill account_id into attachments (parse_message_detail doesn't know it)
            let atts_flat: Vec<crate::db::Attachment> = all_attachments
                .iter_mut()
                .flat_map(|v| v.iter_mut().map(|a| { a.account_id = acct.clone(); a.clone() }))
                .collect();
            let app_clone = app.clone();
            let acct2 = acct.clone();
            tokio::task::spawn_blocking(move || {
                upsert_emails(&app_clone, &acct2, emails).map_err(|e| e.to_string())?;
                crate::db::upsert_attachments(&app_clone, atts_flat).map_err(|e| e.to_string())
            })
            .await
            .map_err(|e| format!("DB upsert task failed: {}", e))??;
        }
    }

    set_history_id(app, account_id, &new_history_id)?;

    Ok(())
}

// ── Full sync ──
async fn do_sync(app: &AppHandle, account_id: &str, access_token: &str) -> Result<(), String> {
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .unwrap_or_default();

    let profile_history_id = get_profile_history_id(&client, access_token).await.ok();

    let mut all_ids = Vec::new();
    let mut seen_ids = std::collections::HashSet::new();

    let queries = vec![
        ("in:inbox", 500u32),
        ("in:sent", 200),
        ("in:spam", 50),
        ("in:trash", 50),
        ("-in:inbox -in:sent -in:spam -in:trash -in:drafts", 100),
    ];

    for (query, max) in queries {
        if let Ok(ids) = fetch_message_ids(&client, access_token, query, max).await {
            for msg in ids {
                if seen_ids.insert(msg.id.clone()) {
                    all_ids.push(msg.id);
                }
            }
        }
    }

    eprintln!("[SYNC:{}] full sync: {} messages to fetch", account_id, all_ids.len());

    let parsed: Vec<(Email, Vec<crate::db::Attachment>)> = stream::iter(all_ids)
        .map(|id| {
            let client = &client;
            let token = access_token;
            async move {
                fetch_message_detail(client, token, &id)
                    .await
                    .ok()
                    .map(parse_message_detail)
            }
        })
        .buffer_unordered(10)
        .filter_map(|x| async { x })
        .collect()
        .await;

    let acct = account_id.to_string();
    let (emails, mut all_attachments): (Vec<Email>, Vec<Vec<crate::db::Attachment>>) =
        parsed.into_iter().unzip();
    let atts_flat: Vec<crate::db::Attachment> = all_attachments
        .iter_mut()
        .flat_map(|v| v.iter_mut().map(|a| { a.account_id = acct.clone(); a.clone() }))
        .collect();
    let app_clone = app.clone();
    let acct2 = acct.clone();
    tokio::task::spawn_blocking(move || {
        upsert_emails(&app_clone, &acct2, emails).map_err(|e| e.to_string())?;
        crate::db::upsert_attachments(&app_clone, atts_flat).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("DB task failed: {}", e))??;

    if let Some(hid) = profile_history_id {
        eprintln!("[SYNC:{}] full sync done, historyId={}", account_id, hid);
        set_history_id(app, account_id, &hid)?;
    }

    Ok(())
}


#[derive(Deserialize, Debug)]
struct MessageListResponse {
    messages: Option<Vec<MessageId>>,
    #[serde(rename = "nextPageToken")]
    next_page_token: Option<String>,
}

#[derive(Deserialize, Debug)]
struct MessageId {
    id: String,
}

#[derive(Deserialize, Debug)]
struct MessageDetail {
    id: String,
    #[serde(rename = "threadId")]
    thread_id: Option<String>,
    snippet: String,
    payload: Payload,
    #[serde(rename = "internalDate")]
    internal_date: String,
    #[serde(rename = "labelIds")]
    label_ids: Option<Vec<String>>,
}

#[derive(Deserialize, Debug)]
struct Payload {
    headers: Vec<Header>,
    parts: Option<Vec<MessagePart>>,
    body: Option<MessageBody>,
}

#[derive(Deserialize, Debug)]
struct Header {
    name: String,
    value: String,
}

#[derive(Deserialize, Debug)]
struct MessagePart {
    #[serde(rename = "mimeType")]
    mime_type: String,
    #[serde(rename = "partId")]
    part_id: Option<String>,
    filename: Option<String>,
    headers: Option<Vec<Header>>,
    body: Option<MessageBody>,
    parts: Option<Vec<MessagePart>>,
}

#[derive(Deserialize, Debug)]
struct MessageBody {
    data: Option<String>,
    #[serde(rename = "attachmentId")]
    attachment_id: Option<String>,
    size: Option<i64>,
}

/// Determine the label for an email based on Gmail label IDs
fn determine_label(label_ids: &[String]) -> String {
    if label_ids.contains(&"SPAM".to_string()) {
        "spam".to_string()
    } else if label_ids.contains(&"TRASH".to_string()) {
        "trash".to_string()
    } else if label_ids.contains(&"SENT".to_string()) && !label_ids.contains(&"INBOX".to_string()) {
        "sent".to_string()
    } else if label_ids.contains(&"INBOX".to_string()) {
        "inbox".to_string()
    } else {
        "archive".to_string()
    }
}

/// Parse a single Gmail message detail into our Email struct + attachment list
fn parse_message_detail(detail: MessageDetail) -> (Email, Vec<crate::db::Attachment>) {
    let mut sender = "Unknown Sender".to_string();
    let mut recipient = String::new();
    let mut cc = String::new();
    let mut subject = "No Subject".to_string();

    for header in &detail.payload.headers {
        if header.name.eq_ignore_ascii_case("from") {
            sender = header.value.clone();
        } else if header.name.eq_ignore_ascii_case("to") {
            recipient = header.value.clone();
        } else if header.name.eq_ignore_ascii_case("cc") {
            cc = header.value.clone();
        } else if header.name.eq_ignore_ascii_case("subject") {
            subject = header.value.clone();
        }
    }

    // Parse HTML/Text body (base64url encoded)
    let mut body_html = String::new();

    if let Some(parts) = &detail.payload.parts {
        if let Some(data) = find_part_data(parts, "text/html") {
            body_html = decode_base64_url(data);
        }
    }

    if body_html.is_empty() {
        if let Some(parts) = &detail.payload.parts {
            if let Some(data) = find_part_data(parts, "text/plain") {
                body_html = decode_base64_url(data);
            }
        }
    }

    if body_html.is_empty() {
        if let Some(body) = &detail.payload.body {
            if let Some(data) = &body.data {
                body_html = decode_base64_url(data);
            }
        }
    }

    // Resolve Inline Images (CID)
    if let Some(parts) = &detail.payload.parts {
        let mut cids = std::collections::HashMap::new();
        collect_inline_images(parts, &mut cids);

        for (cid, data_uri) in cids {
            let cid_target = format!("cid:{}", cid);
            body_html = body_html.replace(&cid_target, &data_uri);
        }
    }

    let labels = detail.label_ids.unwrap_or_default();
    let is_unread = labels.contains(&"UNREAD".to_string());
    let label = determine_label(&labels);
    let date_i64 = detail.internal_date.parse::<i64>().unwrap_or(0);

    let attachments = if let Some(parts) = &detail.payload.parts {
        collect_attachments(parts, &detail.id, "")
    } else {
        vec![]
    };

    let email = Email {
        id: detail.id,
        thread_id: detail.thread_id.unwrap_or_default(),
        sender,
        recipient,
        cc,
        subject,
        snippet: detail.snippet,
        body_html,
        date: date_i64,
        unread: is_unread,
        label,
    };

    (email, attachments)
}

/// Fetch a list of message IDs from Gmail (with pagination support)
async fn fetch_message_ids(
    client: &Client,
    access_token: &str,
    query: &str,
    max_results: u32,
) -> Result<Vec<MessageId>, String> {
    let mut all_messages = Vec::new();
    let mut page_token: Option<String> = None;
    let page_size = std::cmp::min(max_results, 100); // Gmail max per page is 100

    loop {
        let mut url = format!(
            "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults={}&q={}",
            page_size, query
        );
        if let Some(ref token) = page_token {
            url.push_str(&format!("&pageToken={}", token));
        }

        let res = client
            .get(&url)
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(|e| format!("List fetch error: {}", e))?;

        if !res.status().is_success() {
            return Err(format!(
                "Gmail API Error: {}",
                res.text().await.unwrap_or_default()
            ));
        }

        let list_data: MessageListResponse = res.json().await.map_err(|e| e.to_string())?;

        if let Some(msgs) = list_data.messages {
            all_messages.extend(msgs);
        }

        // Stop if we have enough or no more pages
        if all_messages.len() >= max_results as usize || list_data.next_page_token.is_none() {
            break;
        }
        page_token = list_data.next_page_token;
    }

    // Trim to exact max
    all_messages.truncate(max_results as usize);
    Ok(all_messages)
}

/// Fetch full details of a single message
async fn fetch_message_detail(
    client: &Client,
    access_token: &str,
    msg_id: &str,
) -> Result<MessageDetail, String> {
    let url = format!(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/{}?format=full",
        msg_id
    );
    let res = client
        .get(&url)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| format!("Detail fetch error: {}", e))?;

    res.json::<MessageDetail>().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sync_emails(
    app: AppHandle,
    account_id: String,
    access_token: String,
) -> Result<(), String> {
    let state = app.state::<crate::SyncState>();

    {
        let mut syncing = state.is_syncing.lock().map_err(|_| "Sync lock poisoned")?;
        if syncing.contains(&account_id) {
            let mut pending = state
                .resync_requested
                .lock()
                .map_err(|_| "Sync lock poisoned")?;
            pending.insert(account_id);
            return Ok(());
        }
        syncing.insert(account_id.clone());
    }

    let mut token = access_token;
    loop {
        let result = {
            let history_id = get_history_id(&app, &account_id);
            if let Some(hid) = history_id {
                match do_incremental_sync(&app, &account_id, &token, &hid).await {
                    Ok(()) => Ok(()),
                    Err(e) if e == "HISTORY_EXPIRED" => {
                        eprintln!("[SYNC:{}] history expired, full sync", account_id);
                        do_sync(&app, &account_id, &token).await
                    }
                    Err(e) => Err(e),
                }
            } else {
                do_sync(&app, &account_id, &token).await
            }
        };

        let run_again = {
            let mut pending = state
                .resync_requested
                .lock()
                .map_err(|_| "Sync lock poisoned")?;
            let had = pending.contains(&account_id);
            pending.remove(&account_id);
            had
        };

        if let Err(e) = result {
            let mut syncing = state.is_syncing.lock().map_err(|_| "Sync lock poisoned")?;
            syncing.remove(&account_id);
            return Err(e);
        }

        if !run_again {
            break;
        }

        // Use latest stored token in case it was refreshed
        if let Some((fresh_access, _)) = load_tokens(&account_id) {
            token = fresh_access;
        }
    }

    let mut syncing = state.is_syncing.lock().map_err(|_| "Sync lock poisoned")?;
    syncing.remove(&account_id);
    Ok(())
}

#[tauri::command]
pub async fn archive_email(
    app: AppHandle,
    access_token: String,
    message_id: String,
) -> Result<(), String> {
    // 1. Update local DB
    crate::db::update_email_label(&app, &message_id, "archive")?;

    // 2. Remove INBOX label from Gmail
    let client = Client::builder().timeout(std::time::Duration::from_secs(30)).build().unwrap_or_default();
    let url = format!(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/{}/modify",
        message_id
    );
    let body = serde_json::json!({
        "removeLabelIds": ["INBOX"]
    });

    let res = client
        .post(&url)
        .bearer_auth(&access_token)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        return Err(format!(
            "Gmail archive error: {}",
            res.text().await.unwrap_or_default()
        ));
    }

    Ok(())
}

#[tauri::command]
pub async fn trash_email(
    app: AppHandle,
    access_token: String,
    message_id: String,
) -> Result<(), String> {
    // 1. Update local DB label to 'trash' (keep it visible in Trash tab)
    crate::db::update_email_label(&app, &message_id, "trash")?;

    // 2. Trash on Gmail
    let client = Client::builder().timeout(std::time::Duration::from_secs(30)).build().unwrap_or_default();
    let url = format!(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/{}/trash",
        message_id
    );

    let res = client
        .post(&url)
        .bearer_auth(&access_token)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        return Err(format!(
            "Gmail trash error: {}",
            res.text().await.unwrap_or_default()
        ));
    }

    Ok(())
}

#[tauri::command]
pub async fn move_to_inbox(
    app: AppHandle,
    access_token: String,
    message_id: String,
) -> Result<(), String> {
    // 1. Update local DB
    crate::db::update_email_label(&app, &message_id, "inbox")?;

    // 2. Add INBOX, remove SPAM/TRASH labels
    let client = Client::builder().timeout(std::time::Duration::from_secs(30)).build().unwrap_or_default();
    let url = format!(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/{}/modify",
        message_id
    );
    let body = serde_json::json!({
        "addLabelIds": ["INBOX"],
        "removeLabelIds": ["SPAM", "TRASH"]
    });

    let res = client
        .post(&url)
        .bearer_auth(&access_token)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        return Err(format!(
            "Gmail move error: {}",
            res.text().await.unwrap_or_default()
        ));
    }

    Ok(())
}

#[tauri::command]
pub async fn permanently_delete(
    app: AppHandle,
    access_token: String,
    message_id: String,
) -> Result<(), String> {
    // 1. Remove from local DB
    crate::db::delete_email_from_db(&app, &message_id)?;

    // 2. Permanently delete from Gmail
    let client = Client::builder().timeout(std::time::Duration::from_secs(30)).build().unwrap_or_default();
    let url = format!(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/{}",
        message_id
    );

    let res = client
        .delete(&url)
        .bearer_auth(&access_token)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        return Err(format!(
            "Gmail delete error: {}",
            res.text().await.unwrap_or_default()
        ));
    }

    Ok(())
}

/// RFC 2047 encodes a header value containing non-ASCII characters.
/// Uses UTF-8 base64 encoded-word format: =?UTF-8?B?<base64>?=
fn mime_encode_header(value: &str) -> String {
    if value.is_ascii() {
        return value.to_string();
    }
    let encoded = base64::engine::general_purpose::STANDARD.encode(value.as_bytes());
    format!("=?UTF-8?B?{}?=", encoded)
}

/// Base64-encodes a string body per RFC 2045 (wraps at 76 chars).
fn mime_body_base64(body: &str) -> String {
    let encoded = base64::engine::general_purpose::STANDARD.encode(body.as_bytes());
    encoded
        .as_bytes()
        .chunks(76)
        .map(|c| std::str::from_utf8(c).unwrap_or(""))
        .collect::<Vec<_>>()
        .join("\r\n")
}

/// Builds a RFC 2822 raw email. Without attachments: simple text/html.
/// With attachments: multipart/mixed with HTML part + attachment parts.
fn build_raw_mime(headers: &[(&str, String)], body: &str, attachments: &[AttachmentPayload]) -> String {
    let mut lines = String::from("MIME-Version: 1.0\r\n");
    for (name, value) in headers {
        lines.push_str(&format!("{}: {}\r\n", name, value));
    }

    if attachments.is_empty() {
        lines.push_str("Content-Type: text/html; charset=\"UTF-8\"\r\n");
        lines.push_str("Content-Transfer-Encoding: base64\r\n");
        lines.push_str("\r\n");
        lines.push_str(&mime_body_base64(body));
    } else {
        let boundary = "----=_NextPart_fursoymail_001";
        lines.push_str(&format!("Content-Type: multipart/mixed; boundary=\"{}\"\r\n", boundary));
        lines.push_str("\r\n");

        // HTML body part
        lines.push_str(&format!("--{}\r\n", boundary));
        lines.push_str("Content-Type: text/html; charset=\"UTF-8\"\r\n");
        lines.push_str("Content-Transfer-Encoding: base64\r\n");
        lines.push_str("\r\n");
        lines.push_str(&mime_body_base64(body));
        lines.push_str("\r\n");

        // Attachment parts
        for att in attachments {
            let encoded_name = mime_encode_header(&att.filename);
            lines.push_str(&format!("--{}\r\n", boundary));
            lines.push_str(&format!("Content-Type: {}; name=\"{}\"\r\n", att.mime_type, encoded_name));
            lines.push_str("Content-Transfer-Encoding: base64\r\n");
            lines.push_str(&format!("Content-Disposition: attachment; filename=\"{}\"\r\n", encoded_name));
            lines.push_str("\r\n");
            // Wrap attachment data at 76 chars
            let wrapped = att.data.as_bytes().chunks(76)
                .map(|c| std::str::from_utf8(c).unwrap_or(""))
                .collect::<Vec<_>>()
                .join("\r\n");
            lines.push_str(&wrapped);
            lines.push_str("\r\n");
        }

        lines.push_str(&format!("--{}--\r\n", boundary));
    }

    lines
}

#[tauri::command]
pub async fn send_reply(
    app: tauri::AppHandle,
    account_id: String,
    access_token: String,
    to: String,
    subject: String,
    body: String,
    thread_id: String,
    message_id: String,
    attachments: Option<Vec<AttachmentPayload>>,
) -> Result<(), String> {
    let client = Client::builder().timeout(std::time::Duration::from_secs(30)).build().unwrap_or_default();
    let atts = attachments.unwrap_or_default();

    let clean_subject = subject.trim_start_matches("Re: ").trim_start_matches("re: ");
    let raw_email = build_raw_mime(
        &[
            ("To", to),
            ("Subject", format!("Re: {}", mime_encode_header(clean_subject))),
            ("In-Reply-To", message_id.clone()),
            ("References", message_id),
        ],
        &body,
        &atts,
    );

    let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw_email.as_bytes());

    let send_body = serde_json::json!({
        "raw": encoded,
        "threadId": thread_id
    });

    let url = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

    let res = client
        .post(url)
        .bearer_auth(&access_token)
        .json(&send_body)
        .send()
        .await
        .map_err(|e| format!("Send error: {}", e))?;

    if !res.status().is_success() {
        return Err(format!(
            "Gmail send error: {}",
            res.text().await.unwrap_or_default()
        ));
    }

    // Parse the response to get the sent message ID, then fetch and save to local DB
    let sent_msg: serde_json::Value = res.json().await.unwrap_or_default();
    let sent_id = sent_msg["id"].as_str().unwrap_or("").to_string();
    if !sent_id.is_empty() {
        if let Ok(detail) = fetch_message_detail(&client, &access_token, &sent_id).await {
            let (email, _) = parse_message_detail(detail);
            let app_clone = app.clone();
            let acct = account_id.clone();
            let _ = tokio::task::spawn_blocking(move || {
                crate::db::upsert_emails(&app_clone, &acct, vec![email])
            })
            .await;
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn send_email(
    access_token: String,
    to: String,
    subject: String,
    body: String,
    attachments: Option<Vec<AttachmentPayload>>,
) -> Result<(), String> {
    let client = Client::builder().timeout(std::time::Duration::from_secs(30)).build().unwrap_or_default();
    let atts = attachments.unwrap_or_default();

    let raw_email = build_raw_mime(
        &[
            ("To", to),
            ("Subject", mime_encode_header(&subject)),
        ],
        &body,
        &atts,
    );

    let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw_email.as_bytes());

    let send_body = serde_json::json!({
        "raw": encoded
    });

    let url = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

    let res = client
        .post(url)
        .bearer_auth(&access_token)
        .json(&send_body)
        .send()
        .await
        .map_err(|e| format!("Send error: {}", e))?;

    if !res.status().is_success() {
        return Err(format!(
            "Gmail send error: {}",
            res.text().await.unwrap_or_default()
        ));
    }

    Ok(())
}

#[tauri::command]
pub async fn mark_as_read(
    app: AppHandle,
    access_token: String,
    message_id: String,
) -> Result<(), String> {
    // 1. Update local database instantly
    crate::db::mark_email_as_read_local(&app, &message_id)?;

    // 2. Notify Google API to remove UNREAD label
    let client = Client::builder().timeout(std::time::Duration::from_secs(30)).build().unwrap_or_default();
    let url = format!(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/{}/modify",
        message_id
    );
    let body = serde_json::json!({
        "removeLabelIds": ["UNREAD"]
    });

    let _res = client
        .post(&url)
        .bearer_auth(&access_token)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn mark_as_unread(
    app: AppHandle,
    access_token: String,
    message_id: String,
) -> Result<(), String> {
    crate::db::mark_email_as_unread_local(&app, &message_id)?;

    let client = Client::builder().timeout(std::time::Duration::from_secs(30)).build().unwrap_or_default();
    let url = format!(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/{}/modify",
        message_id
    );
    let body = serde_json::json!({
        "addLabelIds": ["UNREAD"]
    });

    let _res = client
        .post(&url)
        .bearer_auth(&access_token)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

fn is_inline_part(part: &MessagePart) -> bool {
    part.headers.as_ref().map_or(false, |hdrs| {
        hdrs.iter().any(|h| {
            h.name.eq_ignore_ascii_case("Content-Disposition")
                && h.value.to_lowercase().starts_with("inline")
        })
    })
}

fn collect_attachments(
    parts: &[MessagePart],
    email_id: &str,
    account_id: &str,
) -> Vec<crate::db::Attachment> {
    let mut result = Vec::new();
    for part in parts {
        let filename = part.filename.as_deref().unwrap_or("").trim().to_string();
        if !filename.is_empty() && !is_inline_part(part) {
            if let Some(body) = &part.body {
                let size = body.size.unwrap_or(0);
                let part_key = part.part_id.as_deref().unwrap_or(&filename);
                let id = format!("{}_{}", email_id, part_key);
                result.push(crate::db::Attachment {
                    id,
                    email_id: email_id.to_string(),
                    account_id: account_id.to_string(),
                    filename,
                    mime_type: part.mime_type.clone(),
                    size,
                    attachment_id: body.attachment_id.clone(),
                    data: body.data.clone(),
                });
            }
        }
        if let Some(subparts) = &part.parts {
            result.extend(collect_attachments(subparts, email_id, account_id));
        }
    }
    result
}

fn collect_inline_images(
    parts: &[MessagePart],
    cids: &mut std::collections::HashMap<String, String>,
) {
    for part in parts {
        if part.mime_type.starts_with("image/") {
            if let Some(headers) = &part.headers {
                let mut content_id = String::new();
                for header in headers {
                    if header.name.eq_ignore_ascii_case("Content-ID") {
                        content_id = header.value.replace("<", "").replace(">", "");
                        break;
                    }
                }

                if !content_id.is_empty() {
                    if let Some(body) = &part.body {
                        if let Some(data) = &body.data {
                            let standard_b64 = data.replace("-", "+").replace("_", "/");
                            let data_uri =
                                format!("data:{};base64,{}", part.mime_type, standard_b64);
                            cids.insert(content_id, data_uri);
                        }
                    }
                }
            }
        }

        if let Some(subparts) = &part.parts {
            collect_inline_images(subparts, cids);
        }
    }
}

fn find_part_data<'a>(parts: &'a [MessagePart], mime_type: &str) -> Option<&'a String> {
    for part in parts {
        if part.mime_type == mime_type {
            if let Some(body) = &part.body {
                if let Some(data) = &body.data {
                    return Some(data);
                }
            }
        }
        if let Some(subparts) = &part.parts {
            if let Some(data) = find_part_data(subparts, mime_type) {
                return Some(data);
            }
        }
    }
    None
}

fn decode_base64_url(data: &str) -> String {
    let engine = base64::engine::general_purpose::URL_SAFE;
    if let Ok(decoded) = engine.decode(data) {
        String::from_utf8(decoded).unwrap_or_else(|_| "Decode Error".to_string())
    } else {
        "Base64 Error".to_string()
    }
}

/// Fetches attachment data (from DB for small files, Gmail API for large ones).
async fn get_attachment_bytes(
    app: &tauri::AppHandle,
    email_id: &str,
    attachment_db_id: &str,
    access_token: &str,
) -> Result<(Vec<u8>, String, String), String> {
    let atts = crate::db::get_email_attachments(app.clone(), email_id.to_string())
        .map_err(|e| e.to_string())?;
    let att = atts.into_iter().find(|a| a.id == attachment_db_id)
        .ok_or_else(|| "Attachment not found".to_string())?;

    let b64 = if let Some(data) = att.data.filter(|d| !d.is_empty()) {
        data
    } else {
        let gmail_att_id = att.attachment_id
            .ok_or_else(|| "No attachment ID".to_string())?;
        let client = Client::builder()
            .timeout(std::time::Duration::from_secs(60))
            .build()
            .unwrap_or_default();
        let url = format!(
            "https://gmail.googleapis.com/gmail/v1/users/me/messages/{}/attachments/{}",
            email_id, gmail_att_id
        );
        let res = client.get(&url).bearer_auth(access_token).send().await
            .map_err(|e| format!("Fetch error: {}", e))?;
        if !res.status().is_success() {
            return Err(format!("Gmail API error: {}", res.text().await.unwrap_or_default()));
        }
        #[derive(serde::Deserialize)]
        struct AttachmentResponse { data: String }
        let body: AttachmentResponse = res.json().await.map_err(|e| e.to_string())?;
        body.data
    };

    // Gmail uses URL-safe base64
    let bytes = base64::engine::general_purpose::URL_SAFE
        .decode(b64.replace(['\n', '\r'], "").as_str())
        .map_err(|e| format!("Base64 decode error: {}", e))?;

    Ok((bytes, att.filename, att.mime_type))
}

/// Saves attachment to Downloads folder and reveals it in Windows Explorer.
#[tauri::command]
pub async fn save_and_reveal_attachment(
    app: tauri::AppHandle,
    email_id: String,
    attachment_db_id: String,
    access_token: String,
) -> Result<String, String> {
    let (bytes, filename, _mime) =
        get_attachment_bytes(&app, &email_id, &attachment_db_id, &access_token).await?;

    let downloads = app
        .path()
        .download_dir()
        .map_err(|e| format!("Cannot find Downloads folder: {}", e))?;

    // Avoid overwriting existing files by appending a counter
    let mut dest = downloads.join(&filename);
    if dest.exists() {
        let stem = std::path::Path::new(&filename)
            .file_stem().and_then(|s| s.to_str()).unwrap_or("file");
        let ext = std::path::Path::new(&filename)
            .extension().and_then(|s| s.to_str()).unwrap_or("");
        let mut i = 2u32;
        loop {
            let candidate = if ext.is_empty() {
                format!("{} ({})", stem, i)
            } else {
                format!("{} ({}).{}", stem, i, ext)
            };
            dest = downloads.join(&candidate);
            if !dest.exists() { break; }
            i += 1;
        }
    }

    std::fs::write(&dest, &bytes)
        .map_err(|e| format!("Write error: {}", e))?;

    // Reveal file selected in Windows Explorer
    let _ = std::process::Command::new("explorer")
        .arg(format!("/select,{}", dest.display()))
        .spawn();

    Ok(dest.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(&filename)
        .to_string())
}

/// Returns raw base64 data — used for image thumbnail preview in the frontend.
#[tauri::command]
pub async fn fetch_attachment_data(
    app: tauri::AppHandle,
    email_id: String,
    attachment_db_id: String,
    access_token: String,
) -> Result<String, String> {
    let (bytes, _filename, _mime) =
        get_attachment_bytes(&app, &email_id, &attachment_db_id, &access_token).await?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}
