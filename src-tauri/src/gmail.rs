use reqwest::Client;
use serde::Deserialize;
use base64::Engine;
use crate::db::{upsert_emails, Email};
use tauri::AppHandle;
use futures::stream::{self, StreamExt};

#[derive(Deserialize, Debug)]
struct MessageListResponse {
    messages: Option<Vec<MessageId>>,
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

/// Fetch a list of message IDs from Gmail
async fn fetch_message_ids(client: &Client, access_token: &str, query: &str, max_results: u32) -> Result<Vec<MessageId>, String> {
    let url = format!(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults={}&q={}",
        max_results, query
    );
    
    let res = client
        .get(&url)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| format!("List fetch error: {}", e))?;

    if !res.status().is_success() {
        return Err(format!("Gmail API Error: {}", res.text().await.unwrap_or_default()));
    }

    let list_data: MessageListResponse = res.json().await.map_err(|e| e.to_string())?;
    Ok(list_data.messages.unwrap_or_default())
}

/// Fetch full details of a single message
async fn fetch_message_detail(client: &Client, access_token: &str, msg_id: &str) -> Result<MessageDetail, String> {
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
    let client = Client::new();
    let mut all_ids = Vec::new();
    let mut seen_ids = std::collections::HashSet::new();

    let queries = vec![
        ("in:inbox", 50u32),
        ("in:sent", 30),
        ("in:spam", 20),
        ("in:trash", 20),
    ];

    // Collect all unique message IDs first
    for (query, max) in queries {
        if let Ok(ids) = fetch_message_ids(&client, &access_token, query, max).await {
            for msg in ids {
                if seen_ids.insert(msg.id.clone()) {
                    all_ids.push(msg.id);
                }
            }
        }
    }

    // Fetch all message details in parallel (max 10 concurrent)
    let parsed_emails: Vec<Email> = stream::iter(all_ids)
        .map(|id| {
            let client = &client;
            let token = &access_token;
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

    // Save to database
    upsert_emails(&app, parsed_emails).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn archive_email(app: AppHandle, access_token: String, message_id: String) -> Result<(), String> {
    // 1. Update local DB
    crate::db::update_email_label(&app, &message_id, "archive")?;

    // 2. Remove INBOX label from Gmail
    let client = Client::new();
    let url = format!("https://gmail.googleapis.com/gmail/v1/users/me/messages/{}/modify", message_id);
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
pub async fn trash_email(app: AppHandle, access_token: String, message_id: String) -> Result<(), String> {
    // 1. Update local DB label to 'trash' (keep it visible in Trash tab)
    crate::db::update_email_label(&app, &message_id, "trash")?;

    // 2. Trash on Gmail
    let client = Client::new();
    let url = format!("https://gmail.googleapis.com/gmail/v1/users/me/messages/{}/trash", message_id);

    let res = client
        .post(&url)
        .bearer_auth(&access_token)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        return Err(format!("Gmail trash error: {}", res.text().await.unwrap_or_default()));
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
    let client = Client::new();
    
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
        return Err(format!("Gmail send error: {}", res.text().await.unwrap_or_default()));
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
    let client = Client::new();
    
    let raw_email = format!(
        "To: {}\r\nSubject: {}\r\nContent-Type: text/html; charset=\"UTF-8\"\r\n\r\n{}",
        to,
        subject,
        body
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
        return Err(format!("Gmail send error: {}", res.text().await.unwrap_or_default()));
    }

    Ok(())
}

#[tauri::command]
pub async fn mark_as_read(app: AppHandle, access_token: String, message_id: String) -> Result<(), String> {
    // 1. Update local database instantly
    crate::db::mark_email_as_read_local(&app, &message_id)?;

    // 2. Notify Google API to remove UNREAD label
    let client = Client::new();
    let url = format!("https://gmail.googleapis.com/gmail/v1/users/me/messages/{}/modify", message_id);
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

fn collect_inline_images(parts: &[MessagePart], cids: &mut std::collections::HashMap<String, String>) {
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
                            let data_uri = format!("data:{};base64,{}", part.mime_type, standard_b64);
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
