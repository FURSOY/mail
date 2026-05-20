use serde::{Deserialize, Serialize};
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio::time::{timeout, Duration};

const REDIRECT_URI: &str = "http://127.0.0.1:8123/callback";

/// Read OAuth credentials from environment variables (loaded from .env)
fn read_credential(name: &str, embedded: Option<&str>) -> Result<String, String> {
    std::env::var(name)
        .ok()
        .or_else(|| embedded.map(str::to_string))
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("{name} bulunamadi. Release build almadan once src-tauri/.env dosyasini kontrol edin."))
}

fn get_client_id() -> Result<String, String> {
    read_credential("GOOGLE_CLIENT_ID", option_env!("GOOGLE_CLIENT_ID"))
}

fn get_client_secret() -> Result<String, String> {
    read_credential("GOOGLE_CLIENT_SECRET", option_env!("GOOGLE_CLIENT_SECRET"))
}

fn build_auth_url(client_id: &str) -> Result<String, String> {
    let mut url = reqwest::Url::parse("https://accounts.google.com/o/oauth2/v2/auth")
        .map_err(|e| e.to_string())?;
    url.query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", REDIRECT_URI)
        .append_pair("response_type", "code")
        .append_pair("access_type", "offline")
        .append_pair("prompt", "consent")
        .append_pair(
            "scope",
            "https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email",
        );
    Ok(url.to_string())
}

fn open_auth_url(app: &tauri::AppHandle, auth_url: String) -> Result<(), String> {
    match app.opener().open_url(auth_url.clone(), None::<&str>) {
        Ok(_) => Ok(()),
        Err(plugin_error) => {
            #[cfg(target_os = "windows")]
            {
                std::process::Command::new("cmd")
                    .args(["/C", "start", "", &auth_url])
                    .spawn()
                    .map_err(|fallback_error| {
                        format!("Tarayici acilamadi. Opener: {plugin_error}. Fallback: {fallback_error}")
                    })?;
                return Ok(());
            }

            #[cfg(not(target_os = "windows"))]
            {
                Err(format!("Tarayici acilamadi: {plugin_error}"))
            }
        }
    }
}

#[derive(Serialize, Deserialize, Debug)]
pub struct AuthResponse {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_in: i32,
    pub token_type: String,
    pub scope: String,
}

#[derive(Deserialize)]
struct UserInfo {
    email: String,
    picture: Option<String>,
}

#[tauri::command]
pub async fn start_google_oauth(app: tauri::AppHandle) -> Result<crate::db::AuthInfo, String> {
    let client_id = get_client_id()?;

    // Build the URL first, then start the local callback listener before opening the browser.
    let auth_url = build_auth_url(&client_id)?;

    let listener = TcpListener::bind("127.0.0.1:8123")
        .await
        .map_err(|_| "Port 8123 kullanimda. Lutfen arkada acik kalan uygulamalari kapatin.")?;

    open_auth_url(&app, auth_url)?;

    let code_result = timeout(Duration::from_secs(120), async {
        // Only accept connections until we get the code, then exit
        loop {
            if let Ok((mut stream, _)) = listener.accept().await {
                let mut reader = BufReader::new(&mut stream);
                let mut request_line = String::new();
                
                if reader.read_line(&mut request_line).await.is_ok() {
                    if request_line.starts_with("GET /callback") && request_line.contains("code=") {
                        let code_start = request_line.find("code=").unwrap() + 5;
                        let code_end = request_line.find(" HTTP").unwrap_or(request_line.len());
                        
                        let mut parsed_code = request_line[code_start..code_end].to_string();
                        
                        if let Some(amp) = parsed_code.find('&') {
                            parsed_code = parsed_code[..amp].to_string();
                        }
                        
                        parsed_code = parsed_code.replace("%2F", "/").replace("%2f", "/");

                        let response = "HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<html><body style='display:flex;justify-content:center;align-items:center;height:100vh;background:#09090b;color:#fff;font-family:sans-serif;'><h2>Giris basarili! Bu sekmeyi kapatabilirsiniz.</h2><script>window.close();</script></body></html>";
                        let _ = stream.write_all(response.as_bytes()).await;
                        let _ = stream.flush().await;

                        // Drop the listener explicitly — stop accepting connections
                        drop(listener);
                        return Some(parsed_code);
                    } else {
                        // Respond to non-callback requests (favicon, etc.) and continue
                        let response = "HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n";
                        let _ = stream.write_all(response.as_bytes()).await;
                    }
                }
            }
        }
    }).await;

    let code = match code_result {
        Ok(Some(c)) => c,
        _ => return Err("Giris islemi zaman asimina ugradi.".into()),
    };

    if code.is_empty() {
        return Err("Auth code bulunamadi".into());
    }

    // 4. Code'u Access Token ile takas et
    let auth_resp = exchange_code_for_token(&code).await?;

    // 5. Google'dan Kullanıcı Profilini Çek
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(30)).build().unwrap_or_default();
    let user_res = client
        .get("https://www.googleapis.com/oauth2/v2/userinfo")
        .bearer_auth(&auth_resp.access_token)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let user_info: UserInfo = user_res.json().await.map_err(|e| e.to_string())?;

    let existing_auth = crate::db::get_auth_info(app.clone()).ok().flatten();
    let refresh_token = auth_resp.refresh_token.unwrap_or_else(|| {
        existing_auth
            .as_ref()
            .filter(|auth| auth.email == user_info.email)
            .map(|auth| auth.refresh_token.clone())
            .unwrap_or_default()
    });

    let auth_info = crate::db::AuthInfo {
        access_token: auth_resp.access_token,
        refresh_token,
        email: user_info.email,
        picture: user_info.picture.unwrap_or_default(),
    };

    // 6. Veritabanına kaydet
    crate::db::save_auth(&app, auth_info.clone())?;

    Ok(auth_info)
}

async fn exchange_code_for_token(code: &str) -> Result<AuthResponse, String> {
    let client_id = get_client_id()?;
    let client_secret = get_client_secret()?;

    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(30)).build().unwrap_or_default();
    let params = [
        ("client_id", client_id.as_str()),
        ("client_secret", client_secret.as_str()),
        ("code", code),
        ("grant_type", "authorization_code"),
        ("redirect_uri", REDIRECT_URI),
    ];

    let res = client
        .post("https://oauth2.googleapis.com/token")
        .form(&params)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if res.status().is_success() {
        let auth_resp: AuthResponse = res.json().await.map_err(|e| e.to_string())?;
        Ok(auth_resp)
    } else {
        let text = res.text().await.unwrap_or_default();
        Err(format!("Token alinamadi: {}", text))
    }
}

#[tauri::command]
pub async fn refresh_access_token(app: tauri::AppHandle) -> Result<crate::db::AuthInfo, String> {
    let existing = crate::db::get_auth_info(app.clone())
        .map_err(|e| e.to_string())?
        .ok_or("No stored auth info found")?;

    if existing.refresh_token.is_empty() {
        return Err("No refresh token available. Please login again.".into());
    }

    let client_id = get_client_id()?;
    let client_secret = get_client_secret()?;

    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(30)).build().unwrap_or_default();
    let params = [
        ("client_id", client_id.as_str()),
        ("client_secret", client_secret.as_str()),
        ("refresh_token", existing.refresh_token.as_str()),
        ("grant_type", "refresh_token"),
    ];

    let res = client
        .post("https://oauth2.googleapis.com/token")
        .form(&params)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        let text = res.text().await.unwrap_or_default();
        return Err(format!("Token refresh failed: {}", text));
    }

    let token_resp: AuthResponse = res.json().await.map_err(|e| e.to_string())?;

    let updated = crate::db::AuthInfo {
        access_token: token_resp.access_token,
        refresh_token: token_resp.refresh_token.unwrap_or(existing.refresh_token),
        email: existing.email,
        picture: existing.picture,
    };

    crate::db::save_auth(&app, updated.clone())?;
    Ok(updated)
}
