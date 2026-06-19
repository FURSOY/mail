// Remote email image proxy.
//
// Email servers frequently send `Cross-Origin-Resource-Policy: same-origin` (or rely on
// being loaded same-origin), which makes the webview block them with
// `ERR_BLOCKED_BY_RESPONSE.NotSameOrigin` when an email is rendered inside our app. Gmail
// solves this by proxying every image through its own servers; we do the same here.
//
// The frontend rewrites `<img src="https://…">` to `http://mailimg.localhost/?url=<encoded>`,
// the custom URI scheme handler (registered in lib.rs) calls `fetch_remote_image`, and we
// re-serve the bytes with permissive cross-origin headers.

/// Maximum image size we are willing to buffer (guards against pathological payloads).
const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;

/// Fetch a remote image referenced by a `mailimg://` request URI.
/// Returns the raw bytes and the resolved content type.
pub async fn fetch_remote_image(request_uri: String) -> Result<(Vec<u8>, String), String> {
    let parsed = reqwest::Url::parse(&request_uri).map_err(|e| format!("bad proxy uri: {e}"))?;

    let target = parsed
        .query_pairs()
        .find(|(key, _)| key == "url")
        .map(|(_, value)| value.into_owned())
        .ok_or_else(|| "missing url parameter".to_string())?;

    if !(target.starts_with("http://") || target.starts_with("https://")) {
        return Err("unsupported scheme".to_string());
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) FURSOYMail/1.0")
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .get(&target)
        .header(reqwest::header::ACCEPT, "image/*,*/*")
        .send()
        .await
        .map_err(|e| format!("fetch error: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("upstream status {}", response.status()));
    }

    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_string())
        .unwrap_or_else(|| "application/octet-stream".to_string());

    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err("image too large".to_string());
    }

    Ok((bytes.to_vec(), content_type))
}
