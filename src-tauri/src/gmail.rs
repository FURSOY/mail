use crate::db::{delete_emails_by_ids, get_history_id, set_history_id, upsert_emails, Email};
use base64::Engine;
use futures::stream::{self, StreamExt};
use reqwest::Client;
use serde::Deserialize;
use tauri::{AppHandle, Manager};

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
async fn do_incremental_sync(app: &AppHandle, access_token: &str, start_history_id: &str) -> Result<(), String> {
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .unwrap_or_default();

    let (fetch_ids, delete_ids, _, new_history_id) =
        fetch_history(&client, access_token, start_history_id).await?;

    eprintln!(
        "[SYNC] incremental: {} to fetch, {} to delete, new historyId={}",
        fetch_ids.len(),
        delete_ids.len(),
        new_history_id
    );

    // Delete removed messages from DB
    if !delete_ids.is_empty() {
        let app_clone = app.clone();
        let ids = delete_ids.clone();
        tokio::task::spawn_blocking(move || {
            delete_emails_by_ids(&app_clone, &ids)
        })
        .await
        .map_err(|e| format!("DB delete task failed: {}", e))??;
    }

    // Fetch details for new/changed messages
    if !fetch_ids.is_empty() {
        let parsed_emails: Vec<Email> = stream::iter(fetch_ids)
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

        if !parsed_emails.is_empty() {
            let app_clone = app.clone();
            tokio::task::spawn_blocking(move || {
                upsert_emails(&app_clone, parsed_emails).map_err(|e| e.to_string())
            })
            .await
            .map_err(|e| format!("DB upsert task failed: {}", e))??;
        }
    }

    // Save new history ID
    set_history_id(app, &new_history_id)?;

    Ok(())
}

// ── Full sync (existing logic, now saves historyId at the end) ──
async fn do_sync(app: &AppHandle, access_token: &str) -> Result<(), String> {
    let client = Client::builder().timeout(std::time::Duration::from_secs(30)).build().unwrap_or_default();

    // Get current historyId BEFORE fetching messages (to not miss anything)
    let profile_history_id = get_profile_history_id(&client, access_token).await.ok();

    let mut all_ids = Vec::new();
    let mut seen_ids = std::collections::HashSet::new();

    let queries = vec![
        ("in:inbox", 500u32),
        ("in:sent", 200),
        ("in:spam", 50),
        ("in:trash", 50),
        ("-in:inbox -in:sent -in:spam -in:trash -in:drafts", 100), // Archive
    ];

    // Collect all unique message IDs first
    for (query, max) in queries {
        if let Ok(ids) = fetch_message_ids(&client, access_token, query, max).await {
            for msg in ids {
                if seen_ids.insert(msg.id.clone()) {
                    all_ids.push(msg.id);
                }
            }
        }
    }

    eprintln!("[SYNC] full sync: {} messages to fetch", all_ids.len());

    // Fetch all message details in parallel (max 10 concurrent)
    let parsed_emails: Vec<Email> = stream::iter(all_ids)
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

    // Save to database (spawn_blocking to avoid blocking tokio)
    let app_clone = app.clone();
    tokio::task::spawn_blocking(move || {
        upsert_emails(&app_clone, parsed_emails).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("DB task failed: {}", e))??;

    // Save historyId for future incremental syncs
    if let Some(hid) = profile_history_id {
        eprintln!("[SYNC] full sync done, saving historyId={}", hid);
        set_history_id(app, &hid)?;
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
    headers: Option<Vec<Header>>,
    body: Option<MessageBody>,
    parts: Option<Vec<MessagePart>>,
}

#[derive(Deserialize, Debug)]
struct MessageBody {
    data: Option<String>,
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

/// Parse a single Gmail message detail into our Email struct
fn parse_message_detail(detail: MessageDetail) -> Email {
    let mut sender = "Unknown Sender".to_string();
    let mut recipient = String::new();
    let mut subject = "No Subject".to_string();

    for header in &detail.payload.headers {
        if header.name.eq_ignore_ascii_case("from") {
            sender = header.value.clone();
        } else if header.name.eq_ignore_ascii_case("to") {
            recipient = header.value.clone();
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

    Email {
        id: detail.id,
        sender,
        recipient,
        subject,
        snippet: detail.snippet,
        body_html,
        date: date_i64,
        unread: is_unread,
        label,
    }
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
pub async fn sync_emails(app: AppHandle, access_token: String) -> Result<(), String> {
    let state = app.state::<crate::SyncState>();

    {
        let mut syncing = state.is_syncing.lock().map_err(|_| "Sync lock poisoned")?;
        if *syncing {
            let mut pending = state
                .resync_requested
                .lock()
                .map_err(|_| "Sync lock poisoned")?;
            *pending = true;
            return Ok(());
        }
        *syncing = true;
    }

    let mut token = access_token;
    loop {
        // Try incremental sync first, fall back to full sync
        let result = {
            let history_id = get_history_id(&app);
            if let Some(hid) = history_id {
                eprintln!("[SYNC] attempting incremental sync from historyId={}", hid);
                match do_incremental_sync(&app, &token, &hid).await {
                    Ok(()) => Ok(()),
                    Err(e) if e == "HISTORY_EXPIRED" => {
                        eprintln!("[SYNC] history expired, falling back to full sync");
                        do_sync(&app, &token).await
                    }
                    Err(e) => Err(e),
                }
            } else {
                eprintln!("[SYNC] no historyId found, doing full sync");
                do_sync(&app, &token).await
            }
        };

        let run_again = {
            let mut pending = state
                .resync_requested
                .lock()
                .map_err(|_| "Sync lock poisoned")?;
            let v = *pending;
            *pending = false;
            v
        };

        if let Err(e) = result {
            let mut syncing = state.is_syncing.lock().map_err(|_| "Sync lock poisoned")?;
            *syncing = false;
            return Err(e);
        }

        if !run_again {
            break;
        }

        // Refresh token in case the previous run renewed it
        token = match crate::db::get_auth_info(app.clone()) {
            Ok(Some(info)) => info.access_token,
            _ => token,
        };
    }

    let mut syncing = state.is_syncing.lock().map_err(|_| "Sync lock poisoned")?;
    *syncing = false;
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

    client
        .post(&url)
        .bearer_auth(&access_token)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

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

#[tauri::command]
pub async fn send_reply(
    access_token: String,
    to: String,
    subject: String,
    body: String,
    thread_id: String,
    message_id: String,
) -> Result<(), String> {
    let client = Client::builder().timeout(std::time::Duration::from_secs(30)).build().unwrap_or_default();

    // Build RFC 2822 formatted email
    let raw_email = format!(
        "To: {}\r\nSubject: Re: {}\r\nIn-Reply-To: {}\r\nReferences: {}\r\nContent-Type: text/html; charset=\"UTF-8\"\r\n\r\n{}",
        to,
        subject.trim_start_matches("Re: "),
        message_id,
        message_id,
        body
    );

    // Encode to base64url
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

    Ok(())
}

#[tauri::command]
pub async fn send_email(
    access_token: String,
    to: String,
    subject: String,
    body: String,
) -> Result<(), String> {
    let client = Client::builder().timeout(std::time::Duration::from_secs(30)).build().unwrap_or_default();

    let raw_email = format!(
        "To: {}\r\nSubject: {}\r\nContent-Type: text/html; charset=\"UTF-8\"\r\n\r\n{}",
        to, subject, body
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
