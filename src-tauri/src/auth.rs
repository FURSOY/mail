use serde::{Deserialize, Serialize};
use tokio::net::TcpListener;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::time::{timeout, Duration};
use tauri_plugin_opener::OpenerExt;

const REDIRECT_URI: &str = "http://127.0.0.1:8123/callback";

/// Read OAuth credentials from environment variables (loaded from .env)
fn get_client_id() -> String {
    std::env::var("GOOGLE_CLIENT_ID")
        .expect("GOOGLE_CLIENT_ID environment variable not set. Create src-tauri/.env file.")
}

fn get_client_secret() -> String {
    std::env::var("GOOGLE_CLIENT_SECRET")
        .expect("GOOGLE_CLIENT_SECRET environment variable not set. Create src-tauri/.env file.")
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
    picture: String,
}

#[tauri::command]
pub async fn start_google_oauth(app: tauri::AppHandle) -> Result<crate::db::AuthInfo, String> {
    let client_id = get_client_id();

    // 1. Oauth URL'ini oluştur
    let auth_url = format!(
        "https://accounts.google.com/o/oauth2/v2/auth?client_id={}&redirect_uri={}&response_type=code&access_type=offline&prompt=consent&scope=https://www.googleapis.com/auth/gmail.modify%20https://www.googleapis.com/auth/gmail.send%20https://www.googleapis.com/auth/userinfo.profile%20https://www.googleapis.com/auth/userinfo.email",
        client_id, REDIRECT_URI
    );

    // 2. Tarayıcıda aç
    app.opener().open_url(auth_url, None::<&str>).map_err(|e| e.to_string())?;

    // 3. Lokal sunucuyu başlat — tek bağlantı al, sonra kapat
    let listener = TcpListener::bind("127.0.0.1:8123")
        .await
        .map_err(|_| "Port 8123 kullanimda. Lutfen arkada acik kalan uygulamalari kapatin.")?;

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
    let client = reqwest::Client::new();
    let user_res = client
        .get("https://www.googleapis.com/oauth2/v2/userinfo")
        .bearer_auth(&auth_resp.access_token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
        
    let user_info: UserInfo = user_res.json().await.map_err(|e| e.to_string())?;
    
    let auth_info = crate::db::AuthInfo {
        access_token: auth_resp.access_token,
        refresh_token: auth_resp.refresh_token.unwrap_or_default(),
        email: user_info.email,
        picture: user_info.picture,
    };
    
    // 6. Veritabanına kaydet
    crate::db::save_auth(&app, auth_info.clone())?;
    
    Ok(auth_info)
}

async fn exchange_code_for_token(code: &str) -> Result<AuthResponse, String> {
    let client_id = get_client_id();
    let client_secret = get_client_secret();

    let client = reqwest::Client::new();
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

    let client_id = get_client_id();
    let client_secret = get_client_secret();

    let client = reqwest::Client::new();
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
