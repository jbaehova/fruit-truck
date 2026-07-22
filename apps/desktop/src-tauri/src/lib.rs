use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::Manager;

const API_BASE: &str = "https://openrouter.ai/api/v1";
const CREDENTIALS_FILE: &str = "credentials.json";
const MAX_ERROR_BYTES: usize = 2_000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CredentialStatus {
  configured: bool,
  masked_key: Option<String>,
  path: String,
}

#[derive(Deserialize, Serialize)]
struct Credentials {
  schema_version: u8,
  openrouter_api_key: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CachedMedia {
  path: String,
  content_type: String,
}

fn credentials_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
  Ok(app
    .path()
    .home_dir()
    .map_err(|error| error.to_string())?
    .join(".open-gen-ui"))
}

fn credentials_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
  Ok(credentials_directory(app)?.join(CREDENTIALS_FILE))
}

#[cfg(unix)]
fn secure_directory(path: &Path) -> Result<(), String> {
  use std::os::unix::fs::PermissionsExt;
  std::fs::create_dir_all(path).map_err(|error| error.to_string())?;
  std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
    .map_err(|error| error.to_string())
}

#[cfg(not(unix))]
fn secure_directory(path: &Path) -> Result<(), String> {
  std::fs::create_dir_all(path).map_err(|error| error.to_string())
}

fn read_api_key(app: &tauri::AppHandle) -> Result<Option<String>, String> {
  let path = credentials_path(app)?;
  if !path.exists() {
    return Ok(None);
  }
  let raw = std::fs::read_to_string(&path).map_err(|error| error.to_string())?;
  let credentials: Credentials = serde_json::from_str(&raw)
    .map_err(|_| "The OpenGen UI credentials file is not valid JSON.".to_string())?;
  let key = credentials.openrouter_api_key.trim().to_string();
  if credentials.schema_version != 1 || key.is_empty() {
    return Err("The OpenGen UI credentials file is invalid.".into());
  }
  Ok(Some(key))
}

fn mask_key(key: &str) -> String {
  if key.len() < 12 {
    return "••••••••".into();
  }
  format!("{}…{}", &key[..7], &key[key.len() - 4..])
}

#[tauri::command]
fn credential_status(app: tauri::AppHandle) -> Result<CredentialStatus, String> {
  let path = credentials_path(&app)?;
  let key = read_api_key(&app)?;
  Ok(CredentialStatus {
    configured: key.is_some(),
    masked_key: key.as_deref().map(mask_key),
    path: path.to_string_lossy().into_owned(),
  })
}

#[tauri::command]
fn save_api_key(app: tauri::AppHandle, api_key: String) -> Result<CredentialStatus, String> {
  let value = api_key.trim();
  if value.len() < 12 {
    return Err("Enter a valid OpenRouter API key.".into());
  }
  let directory = credentials_directory(&app)?;
  secure_directory(&directory)?;
  let path = directory.join(CREDENTIALS_FILE);
  let temporary = directory.join(format!(".credentials-{}.tmp", std::process::id()));
  let payload = Credentials {
    schema_version: 1,
    openrouter_api_key: value.into(),
  };
  let bytes = serde_json::to_vec(&payload).map_err(|error| error.to_string())?;
  std::fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600))
      .map_err(|error| error.to_string())?;
  }
  std::fs::rename(&temporary, &path).map_err(|error| error.to_string())?;
  credential_status(app)
}

#[tauri::command]
fn remove_api_key(app: tauri::AppHandle) -> Result<CredentialStatus, String> {
  let path = credentials_path(&app)?;
  if path.exists() {
    std::fs::remove_file(path).map_err(|error| error.to_string())?;
  }
  credential_status(app)
}

fn validate_api_path(path: &str) -> Result<(), String> {
  let allowed = path == "/images/models"
    || path == "/videos/models"
    || path == "/images"
    || path == "/videos"
    || path.starts_with("/videos/")
    || (path.starts_with("/images/models/") && path.ends_with("/endpoints"));
  if !allowed || path.contains("://") || path.contains("..") {
    return Err("Unsupported OpenRouter API path.".into());
  }
  Ok(())
}

async fn response_error(response: reqwest::Response) -> String {
  let status = response.status();
  let text = response.text().await.unwrap_or_default();
  let bounded = text.chars().take(MAX_ERROR_BYTES).collect::<String>();
  if let Ok(payload) = serde_json::from_str::<Value>(&bounded) {
    let message = payload
      .pointer("/error/message")
      .or_else(|| payload.get("message"))
      .or_else(|| payload.get("detail"))
      .and_then(Value::as_str);
    if let Some(message) = message {
      return format!("OpenRouter {}: {}", status.as_u16(), message);
    }
  }
  format!(
    "OpenRouter {}: {}",
    status.as_u16(),
    if bounded.is_empty() { "Request failed" } else { &bounded }
  )
}

#[tauri::command]
async fn openrouter_request(
  app: tauri::AppHandle,
  method: String,
  path: String,
  body: Option<Value>,
) -> Result<Value, String> {
  validate_api_path(&path)?;
  let api_key = read_api_key(&app)?.ok_or("Add an OpenRouter API key in Settings first.")?;
  let client = reqwest::Client::builder()
    .timeout(std::time::Duration::from_secs(180))
    .build()
    .map_err(|error| error.to_string())?;
  let request = match method.as_str() {
    "GET" => client.get(format!("{API_BASE}{path}")),
    "POST" => client.post(format!("{API_BASE}{path}")),
    _ => return Err("Unsupported HTTP method.".into()),
  }
  .bearer_auth(api_key)
  .header("Content-Type", "application/json")
  .header("HTTP-Referer", "https://open-gen-ui.local")
  .header("X-Title", "OpenGen UI");
  let response = if let Some(payload) = body {
    request.json(&payload).send().await
  } else {
    request.send().await
  }
  .map_err(|error| format!("Could not reach OpenRouter: {error}"))?;
  if !response.status().is_success() {
    return Err(response_error(response).await);
  }
  response
    .json::<Value>()
    .await
    .map_err(|error| format!("OpenRouter returned invalid JSON: {error}"))
}

#[tauri::command]
async fn cache_video_content(
  app: tauri::AppHandle,
  job_id: String,
) -> Result<CachedMedia, String> {
  if job_id.is_empty()
    || !job_id
      .chars()
      .all(|value| value.is_ascii_alphanumeric() || value == '-' || value == '_')
  {
    return Err("Invalid video job id.".into());
  }
  let api_key = read_api_key(&app)?.ok_or("Add an OpenRouter API key in Settings first.")?;
  let response = reqwest::Client::new()
    .get(format!("{API_BASE}/videos/{job_id}/content?index=0"))
    .bearer_auth(api_key)
    .send()
    .await
    .map_err(|error| format!("Could not download generated video: {error}"))?;
  if !response.status().is_success() {
    return Err(response_error(response).await);
  }
  let content_type = response
    .headers()
    .get(reqwest::header::CONTENT_TYPE)
    .and_then(|value| value.to_str().ok())
    .unwrap_or("video/mp4")
    .to_string();
  let bytes = response
    .bytes()
    .await
    .map_err(|error| format!("Could not read generated video: {error}"))?;
  let directory = app
    .path()
    .app_cache_dir()
    .map_err(|error| error.to_string())?
    .join("generated");
  std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
  let extension = if content_type.contains("webm") { "webm" } else { "mp4" };
  let path = directory.join(format!("{job_id}.{extension}"));
  std::fs::write(&path, bytes).map_err(|error| error.to_string())?;
  Ok(CachedMedia {
    path: path.to_string_lossy().into_owned(),
    content_type,
  })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_process::init())
    .plugin(tauri_plugin_updater::Builder::new().build())
    .invoke_handler(tauri::generate_handler![
      credential_status,
      save_api_key,
      remove_api_key,
      openrouter_request,
      cache_video_content
    ])
    .run(tauri::generate_context!())
    .expect("error while running OpenGen UI");
}

#[cfg(test)]
mod tests {
  use super::{mask_key, validate_api_path};

  #[test]
  fn api_paths_are_strictly_scoped() {
    assert!(validate_api_path("/images/models").is_ok());
    assert!(validate_api_path("/videos/job-1").is_ok());
    assert!(validate_api_path("https://example.com").is_err());
    assert!(validate_api_path("/models").is_err());
  }

  #[test]
  fn api_keys_are_masked() {
    assert_eq!(mask_key("sk-or-v1-1234567890"), "sk-or-v…7890");
  }
}
