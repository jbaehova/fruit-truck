use std::io::{Read, Seek, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_shell::{
  process::{Command as ShellCommand, CommandEvent},
  ShellExt,
};

const API_BASE: &str = "https://openrouter.ai/api/v1";
const CREDENTIALS_FILE: &str = "credentials.json";
const AGENT_SESSIONS_FILE: &str = "agent-sessions.json";
const AGENT_SESSIONS_DIRECTORY: &str = "agent-sessions";
const DESKTOP_RUNTIME_FILE: &str = "desktop-runtime.json";
const AGENT_SESSIONS_LOCK: &str = ".agent-sessions.lock";
const MAX_ERROR_BYTES: usize = 2_000;
const MAX_IMAGE_BYTES: u64 = 30 * 1024 * 1024;
const MAX_VIDEO_BYTES: u64 = 700 * 1024 * 1024;
const MAX_OPENROUTER_JSON_BYTES: u64 = 48 * 1024 * 1024;
const MAX_AGENT_SESSION_BYTES: u64 = 50 * 1024 * 1024;
const LOCAL_MEDIA_MARKER: &str = "fruit-truck-local:";
static MEDIA_SEQUENCE: AtomicU64 = AtomicU64::new(1);

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
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SharedAssetInput {
  asset_id: String,
  name: String,
  mime_type: String,
  origin: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ManagedAssetFile {
  name: String,
  kind: String,
  mime_type: String,
  local_path: String,
  byte_size: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AssemblyClip {
  source: String,
  name: String,
  start_seconds: f64,
  end_seconds: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AssemblyResult {
  path: String,
  duration: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedCustomSkill {
  name: String,
  version: u64,
  markdown: String,
  path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CustomSkillSummary {
  name: String,
  version: u64,
  path: String,
  versions: Vec<u64>,
}

fn credentials_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
  if let Some(path) = std::env::var_os("FRUIT_TRUCK_HOME") {
    let path = PathBuf::from(path);
    if !path.is_absolute() {
      return Err("FRUIT_TRUCK_HOME must be an absolute path.".into());
    }
    return Ok(path);
  }
  Ok(app
    .path()
    .home_dir()
    .map_err(|error| error.to_string())?
    .join(".fruit-truck"))
}

fn credentials_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
  Ok(credentials_directory(app)?.join(CREDENTIALS_FILE))
}

fn agent_sessions_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
  Ok(credentials_directory(app)?.join(AGENT_SESSIONS_FILE))
}

fn agent_sessions_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
  Ok(credentials_directory(app)?.join(AGENT_SESSIONS_DIRECTORY))
}

fn desktop_runtime_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
  Ok(credentials_directory(app)?.join(DESKTOP_RUNTIME_FILE))
}

fn generated_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
  Ok(credentials_directory(app)?.join("generated"))
}

fn assets_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
  Ok(credentials_directory(app)?.join("assets"))
}

fn inspect_media(bytes: &[u8], name: &str) -> Result<(&'static str, &'static str, &'static str), String> {
  let extension = Path::new(name)
    .extension()
    .and_then(|value| value.to_str())
    .unwrap_or("")
    .to_ascii_lowercase();
  let detected = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
    ("image", "image/png", "png")
  } else if bytes.starts_with(b"\xff\xd8\xff") {
    ("image", "image/jpeg", "jpg")
  } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
    ("image", "image/gif", "gif")
  } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
    ("image", "image/webp", "webp")
  } else if bytes.starts_with(b"\x1a\x45\xdf\xa3") {
    ("video", "video/webm", "webm")
  } else if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
    if extension == "mov" {
      ("video", "video/quicktime", "mov")
    } else {
      ("video", "video/mp4", "mp4")
    }
  } else {
    return Err("The selected file is not a supported image or video.".into());
  };
  let extension_matches = match detected.2 {
    "jpg" => matches!(extension.as_str(), "jpg" | "jpeg"),
    value => extension == value,
  };
  if !extension_matches {
    return Err("The file extension does not match its media contents.".into());
  }
  Ok(detected)
}

fn managed_roots(app: &tauri::AppHandle) -> Result<[PathBuf; 2], String> {
  Ok([assets_directory(app)?, generated_directory(app)?])
}

fn validate_media_path_in_roots(path: &Path, roots: &[PathBuf]) -> Result<PathBuf, String> {
  let canonical = path
    .canonicalize()
    .map_err(|_| "The managed media file is missing or unreadable.".to_string())?;
  if !canonical.is_file() {
    return Err("The managed media path is not a file.".into());
  }
  let allowed = roots.iter().any(|root| {
    root.canonicalize().is_ok_and(|canonical_root| canonical.starts_with(canonical_root))
  });
  if !allowed {
    return Err("The media path is outside Fruit Truck managed storage.".into());
  }
  Ok(canonical)
}

fn validate_managed_media_path(app: &tauri::AppHandle, path: &Path) -> Result<PathBuf, String> {
  validate_media_path_in_roots(path, &managed_roots(app)?)
}

fn unique_export_path(root: &Path, requested_name: &str) -> PathBuf {
  let safe_name = Path::new(requested_name)
    .file_name()
    .and_then(|value| value.to_str())
    .filter(|value| !value.is_empty())
    .unwrap_or("fruit-truck-asset");
  let requested = Path::new(safe_name);
  let stem = requested
    .file_stem()
    .and_then(|value| value.to_str())
    .filter(|value| !value.is_empty())
    .unwrap_or("fruit-truck-asset");
  let extension = requested.extension().and_then(|value| value.to_str());
  for suffix in 0u32.. {
    let name = if suffix == 0 {
      safe_name.to_string()
    } else if let Some(extension) = extension {
      format!("{stem} ({suffix}).{extension}")
    } else {
      format!("{stem} ({suffix})")
    };
    let candidate = root.join(name);
    if !candidate.exists() {
      return candidate;
    }
  }
  unreachable!("u32 export suffix space was exhausted")
}

fn unique_media_path(root: &Path, prefix: &str, extension: &str) -> Result<PathBuf, String> {
  secure_directory(root)?;
  let stamp = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map_err(|error| error.to_string())?
    .as_millis();
  let sequence = MEDIA_SEQUENCE.fetch_add(1, Ordering::Relaxed);
  Ok(root.join(format!("{prefix}-{stamp}-{}-{sequence}.{extension}", std::process::id())))
}

fn set_private_file_permissions(path: &Path) -> Result<(), String> {
  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
      .map_err(|error| error.to_string())?;
  }
  Ok(())
}

fn write_managed_media(
  root: &Path,
  name: &str,
  bytes: &[u8],
  prefix: &str,
) -> Result<ManagedAssetFile, String> {
  let (kind, mime_type, extension) = inspect_media(bytes, name)?;
  let limit = if kind == "video" { MAX_VIDEO_BYTES } else { MAX_IMAGE_BYTES };
  if bytes.is_empty() || bytes.len() as u64 > limit {
    return Err("The media file exceeds the local safety limit.".into());
  }
  let path = unique_media_path(root, prefix, extension)?;
  let temporary = path.with_extension(format!("{extension}.tmp"));
  std::fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
  set_private_file_permissions(&temporary)?;
  std::fs::rename(&temporary, &path).map_err(|error| error.to_string())?;
  Ok(ManagedAssetFile {
    name: Path::new(name)
      .file_name()
      .and_then(|value| value.to_str())
      .filter(|value| !value.is_empty())
      .unwrap_or("media")
      .to_string(),
    kind: kind.into(),
    mime_type: mime_type.into(),
    local_path: path.to_string_lossy().into_owned(),
    byte_size: bytes.len() as u64,
  })
}

fn import_media_file(source: &Path, root: &Path) -> Result<ManagedAssetFile, String> {
  let canonical = source
    .canonicalize()
    .map_err(|_| "The selected media file is missing or unreadable.".to_string())?;
  if !canonical.is_file() {
    return Err("The selected media path is not a file.".into());
  }
  let name = canonical
    .file_name()
    .and_then(|value| value.to_str())
    .ok_or("The selected file name is invalid.")?;
  let mut input = std::fs::File::open(&canonical).map_err(|error| error.to_string())?;
  let metadata = input.metadata().map_err(|error| error.to_string())?;
  if metadata.len() == 0 || metadata.len() > MAX_VIDEO_BYTES {
    return Err("The selected media exceeds the local safety limit.".into());
  }
  let mut header = [0u8; 16];
  let read = input.read(&mut header).map_err(|error| error.to_string())?;
  let (kind, mime_type, extension) = inspect_media(&header[..read], name)?;
  let limit = if kind == "video" { MAX_VIDEO_BYTES } else { MAX_IMAGE_BYTES };
  if metadata.len() > limit {
    return Err("The selected media exceeds the local safety limit.".into());
  }
  input.rewind().map_err(|error| error.to_string())?;
  let path = unique_media_path(root, "asset", extension)?;
  let temporary = path.with_extension(format!("{extension}.tmp"));
  let mut output = std::fs::OpenOptions::new()
    .write(true)
    .create_new(true)
    .open(&temporary)
    .map_err(|error| error.to_string())?;
  let copied = std::io::copy(&mut input.take(limit + 1), &mut output)
    .map_err(|error| error.to_string())?;
  output.flush().map_err(|error| error.to_string())?;
  if copied == 0 || copied > limit {
    let _ = std::fs::remove_file(&temporary);
    return Err("The selected media exceeds the local safety limit.".into());
  }
  set_private_file_permissions(&temporary)?;
  std::fs::rename(&temporary, &path).map_err(|error| error.to_string())?;
  Ok(ManagedAssetFile {
    name: name.into(),
    kind: kind.into(),
    mime_type: mime_type.into(),
    local_path: path.to_string_lossy().into_owned(),
    byte_size: copied,
  })
}

fn validate_shared_asset_input(input: &SharedAssetInput) -> Result<(), String> {
  if input.asset_id.is_empty()
    || input.asset_id.len() > 128
    || !input.asset_id.chars().all(|value| value.is_ascii_alphanumeric() || value == '-' || value == '_')
  {
    return Err("Shared asset ID is invalid.".into());
  }
  if !input.mime_type.starts_with("image/") && !input.mime_type.starts_with("video/") {
    return Err("Only image and video assets may be shared.".into());
  }
  Ok(())
}

fn shared_asset_root(app: &tauri::AppHandle, origin: Option<&str>) -> Result<PathBuf, String> {
  if origin == Some("upload") {
    assets_directory(app)
  } else {
    generated_directory(app)
  }
}

fn shared_upload_path(root: &Path, upload_id: &str) -> Result<PathBuf, String> {
  if upload_id.is_empty()
    || upload_id.len() > 128
    || !upload_id.chars().all(|value| value.is_ascii_alphanumeric() || value == '-' || value == '_')
  {
    return Err("Shared upload ID is invalid.".into());
  }
  secure_directory(root)?;
  Ok(root.join(format!(".shared-{upload_id}.part")))
}

fn append_shared_asset_chunk_to_root(
  root: &Path,
  upload_id: &str,
  bytes: &[u8],
) -> Result<(), String> {
  if bytes.is_empty() {
    return Err("Shared asset chunk is empty.".into());
  }
  let temporary = shared_upload_path(root, upload_id)?;
  let current_size = std::fs::metadata(&temporary).map(|value| value.len()).unwrap_or(0);
  if current_size.saturating_add(bytes.len() as u64) > MAX_VIDEO_BYTES {
    let _ = std::fs::remove_file(&temporary);
    return Err("Shared asset exceeds the local safety limit.".into());
  }
  let mut output = std::fs::OpenOptions::new()
    .create(true)
    .append(true)
    .open(&temporary)
    .map_err(|error| error.to_string())?;
  output.write_all(bytes).map_err(|error| error.to_string())?;
  output.flush().map_err(|error| error.to_string())?;
  set_private_file_permissions(&temporary)
}

fn finish_shared_asset_to_root(
  root: &Path,
  upload_id: &str,
  input: &SharedAssetInput,
) -> Result<CachedMedia, String> {
  validate_shared_asset_input(input)?;
  let temporary = shared_upload_path(root, upload_id)?;
  let result = (|| {
    let metadata = std::fs::metadata(&temporary).map_err(|_| "Shared asset upload is missing.".to_string())?;
    let limit = if input.mime_type.starts_with("video/") { MAX_VIDEO_BYTES } else { MAX_IMAGE_BYTES };
    if metadata.len() == 0 || metadata.len() > limit {
      return Err("Shared asset exceeds the local safety limit.".into());
    }
    let mut source = std::fs::File::open(&temporary).map_err(|error| error.to_string())?;
    let mut header = [0u8; 16];
    let read = source.read(&mut header).map_err(|error| error.to_string())?;
    let (_, detected_mime, extension) = inspect_media(&header[..read], &input.name)?;
    if detected_mime != input.mime_type {
      return Err("Shared asset MIME type does not match its contents.".into());
    }
    let path = unique_media_path(root, "legacy", extension)?;
    std::fs::rename(&temporary, &path).map_err(|error| error.to_string())?;
    set_private_file_permissions(&path)?;
    Ok(CachedMedia { path: path.to_string_lossy().into_owned() })
  })();
  if result.is_err() {
    let _ = std::fs::remove_file(&temporary);
  }
  result
}

#[tauri::command]
fn append_shared_asset_chunk(
  app: tauri::AppHandle,
  request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
  let upload_id = request
    .headers()
    .get("x-fruit-truck-upload-id")
    .and_then(|value| value.to_str().ok())
    .ok_or("Shared upload ID header is required.")?;
  let origin = request
    .headers()
    .get("x-fruit-truck-origin")
    .and_then(|value| value.to_str().ok());
  let bytes = match request.body() {
    tauri::ipc::InvokeBody::Raw(bytes) => bytes,
    tauri::ipc::InvokeBody::Json(_) => return Err("Shared asset chunks must use raw IPC.".into()),
  };
  let root = shared_asset_root(&app, origin)?;
  append_shared_asset_chunk_to_root(&root, upload_id, bytes)
}

#[tauri::command]
fn finish_shared_asset(
  app: tauri::AppHandle,
  upload_id: String,
  input: SharedAssetInput,
) -> Result<CachedMedia, String> {
  validate_shared_asset_input(&input)?;
  let root = shared_asset_root(&app, input.origin.as_deref())?;
  finish_shared_asset_to_root(&root, &upload_id, &input)
}

#[tauri::command]
fn abort_shared_asset(
  app: tauri::AppHandle,
  upload_id: String,
  origin: Option<String>,
) -> Result<(), String> {
  let root = shared_asset_root(&app, origin.as_deref())?;
  let temporary = shared_upload_path(&root, &upload_id)?;
  match std::fs::remove_file(temporary) {
    Ok(()) => Ok(()),
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
    Err(error) => Err(error.to_string()),
  }
}

#[tauri::command]
async fn pick_and_import_assets(app: tauri::AppHandle) -> Result<Vec<ManagedAssetFile>, String> {
  let selection = app
    .dialog()
    .file()
    .add_filter("Images and videos", &["png", "jpg", "jpeg", "webp", "gif", "mp4", "mov", "webm"])
    .blocking_pick_files();
  let Some(files) = selection else { return Ok(Vec::new()) };
  let root = assets_directory(&app)?;
  tauri::async_runtime::spawn_blocking(move || {
    files
      .into_iter()
      .map(|file| file.into_path().map_err(|error| error.to_string()))
      .map(|path| path.and_then(|value| import_media_file(&value, &root)))
      .collect()
  })
  .await
  .map_err(|error| format!("Managed asset import task failed: {error}"))?
}

#[tauri::command]
fn delete_managed_asset(app: tauri::AppHandle, path: String) -> Result<(), String> {
  let canonical = validate_managed_media_path(&app, Path::new(&path))?;
  std::fs::remove_file(canonical).map_err(|error| error.to_string())
}

#[tauri::command]
fn export_managed_asset(app: tauri::AppHandle, path: String, name: String) -> Result<String, String> {
  let source = validate_managed_media_path(&app, Path::new(&path))?;
  let downloads = app.path().download_dir().map_err(|error| error.to_string())?;
  std::fs::create_dir_all(&downloads).map_err(|error| error.to_string())?;
  let destination = unique_export_path(&downloads, &name);
  std::fs::copy(source, &destination).map_err(|error| error.to_string())?;
  Ok(destination.to_string_lossy().into_owned())
}

fn image_data_url_from_file(path: &Path) -> Result<String, String> {
  let metadata = std::fs::metadata(path).map_err(|error| error.to_string())?;
  if metadata.len() == 0 || metadata.len() > MAX_IMAGE_BYTES {
    return Err("A managed image exceeds the local safety limit.".into());
  }
  let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
  let name = path.file_name().and_then(|item| item.to_str()).unwrap_or("image.png");
  let (kind, mime_type, _) = inspect_media(&bytes[..bytes.len().min(16)], name)?;
  if kind != "image" {
    return Err("The managed asset is not an image.".into());
  }
  Ok(format!(
    "data:{mime_type};base64,{}",
    base64::engine::general_purpose::STANDARD.encode(bytes),
  ))
}

#[tauri::command]
fn read_managed_image_data_url(app: tauri::AppHandle, path: String) -> Result<String, String> {
  let source = validate_managed_media_path(&app, Path::new(&path))?;
  image_data_url_from_file(&source)
}

struct AgentStoreLock(PathBuf);

impl Drop for AgentStoreLock {
  fn drop(&mut self) {
    let _ = std::fs::remove_file(&self.0);
  }
}

fn acquire_agent_store_lock(app: &tauri::AppHandle) -> Result<AgentStoreLock, String> {
  let directory = credentials_directory(app)?;
  secure_directory(&directory)?;
  let path = directory.join(AGENT_SESSIONS_LOCK);
  for _ in 0..200 {
    match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
      Ok(_) => return Ok(AgentStoreLock(path)),
      Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
        let stale = std::fs::metadata(&path)
          .and_then(|metadata| metadata.modified())
          .and_then(|modified| modified.elapsed().map_err(std::io::Error::other))
          .is_ok_and(|elapsed| elapsed.as_secs() > 30);
        if stale {
          let _ = std::fs::remove_file(&path);
        } else {
          std::thread::sleep(std::time::Duration::from_millis(10));
        }
      }
      Err(error) => return Err(error.to_string()),
    }
  }
  Err("The shared agent session store is busy. Reload the session and try again.".into())
}

#[cfg(unix)]
fn secure_directory(path: &Path) -> Result<(), String> {
  use std::os::unix::fs::PermissionsExt;
  let existed = path.exists();
  std::fs::create_dir_all(path).map_err(|error| error.to_string())?;
  if !existed {
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
      .map_err(|error| error.to_string())?;
  } else if !path.is_dir() {
    return Err(format!("{} must be a directory.", path.display()));
  }
  Ok(())
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
    .map_err(|_| "The Fruit Truck credentials file is not valid JSON.".to_string())?;
  let key = credentials.openrouter_api_key.trim().to_string();
  if credentials.schema_version != 1 || key.is_empty() {
    return Err("The Fruit Truck credentials file is invalid.".into());
  }
  Ok(Some(key))
}

fn mask_key(key: &str) -> String {
  let characters = key.chars().collect::<Vec<_>>();
  if characters.len() < 12 {
    return "••••••••".into();
  }
  let prefix = characters.iter().take(7).collect::<String>();
  let suffix = characters[characters.len() - 4..].iter().collect::<String>();
  format!("{prefix}…{suffix}")
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
  if value.len() < 12 || !value.is_ascii() || value.chars().any(char::is_whitespace) {
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

fn read_agent_sessions_file(app: &tauri::AppHandle) -> Result<Value, String> {
  let path = agent_sessions_path(app)?;
  if !path.exists() {
    return Ok(serde_json::json!({ "schemaVersion": 3, "revision": 0, "sessions": [] }));
  }
  let metadata = std::fs::metadata(&path).map_err(|error| error.to_string())?;
  if metadata.len() > 50 * 1024 * 1024 {
    return Err("The agent session bridge index exceeds the 50 MB recovery limit.".into());
  }
  let raw = std::fs::read(&path).map_err(|error| error.to_string())?;
  let value: Value = serde_json::from_slice(&raw).map_err(|_| "The agent session bridge file is invalid JSON.")?;
  if !matches!(value.get("schemaVersion").and_then(Value::as_u64), Some(1) | Some(2) | Some(3)) {
    return Err("The agent session bridge file has an unsupported schema.".into());
  }
  if value.get("sessions").is_some_and(Value::is_array) {
    let mut value = value;
    value["schemaVersion"] = Value::from(3);
    return Ok(value);
  }
  let files = value.get("sessionFiles").and_then(Value::as_array).ok_or("The agent session bridge index has no session files.")?;
  let root = agent_sessions_directory(app)?;
  let mut sessions = Vec::with_capacity(files.len());
  for entry in files {
    let id = entry.get("id").and_then(Value::as_str).ok_or("Agent session index entry has no ID.")?;
    let file = entry.get("file").and_then(Value::as_str).ok_or("Agent session index entry has no file.")?;
    if id.is_empty() || id.len() > 128 || !id.chars().all(|value| value.is_ascii_alphanumeric() || value == '-' || value == '_')
      || !file.ends_with(".json") || !file.chars().all(|value| value.is_ascii_alphanumeric() || matches!(value, '-' | '_' | '.'))
    {
      return Err("Agent session index contains an invalid file reference.".into());
    }
    let session_path = root.join(file);
    let metadata = std::fs::metadata(&session_path).map_err(|error| format!("Agent session {id} is missing: {error}"))?;
    if metadata.len() > MAX_AGENT_SESSION_BYTES {
      return Err(format!("Agent session {id} exceeds the 50 MB per-session limit."));
    }
    let session: Value = serde_json::from_slice(&std::fs::read(session_path).map_err(|error| error.to_string())?)
      .map_err(|_| format!("Agent session {id} contains invalid JSON."))?;
    if session.get("id").and_then(Value::as_str) != Some(id) {
      return Err(format!("Agent session file {file} does not match index ID {id}."));
    }
    sessions.push(session);
  }
  Ok(serde_json::json!({
    "schemaVersion": 3,
    "revision": value.get("revision").and_then(Value::as_u64).unwrap_or(0),
    "sessions": sessions,
  }))
}

#[tauri::command]
fn report_desktop_runtime(app: tauri::AppHandle, active_session_id: Option<String>) -> Result<Value, String> {
  let directory = credentials_directory(&app)?;
  secure_directory(&directory)?;
  let path = desktop_runtime_path(&app)?;
  let temporary = directory.join(format!(".desktop-runtime-{}.tmp", std::process::id()));
  let heartbeat_at_ms = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map_err(|error| error.to_string())?
    .as_millis() as u64;
  let value = serde_json::json!({
    "schemaVersion": 1,
    "pid": std::process::id(),
    "version": app.package_info().version.to_string(),
    "heartbeatAtMs": heartbeat_at_ms,
    "activeSessionId": active_session_id,
  });
  std::fs::write(&temporary, serde_json::to_vec(&value).map_err(|error| error.to_string())?)
    .map_err(|error| error.to_string())?;
  set_private_file_permissions(&temporary)?;
  std::fs::rename(&temporary, &path).map_err(|error| error.to_string())?;
  Ok(value)
}

fn write_agent_sessions_file(app: &tauri::AppHandle, value: &Value) -> Result<(), String> {
  let directory = credentials_directory(app)?;
  secure_directory(&directory)?;
  let path = agent_sessions_path(app)?;
  let session_root = agent_sessions_directory(app)?;
  secure_directory(&session_root)?;
  let sessions = value.get("sessions").and_then(Value::as_array).ok_or("Agent session list is invalid.")?;
  let revision = value.get("revision").and_then(Value::as_u64).unwrap_or(0);
  let mut session_files = Vec::with_capacity(sessions.len());
  let mut retained = std::collections::HashSet::new();
  for session in sessions {
    let id = session.get("id").and_then(Value::as_str).ok_or("Agent session ID is required.")?;
    if id.is_empty() || id.len() > 128 || !id.chars().all(|value| value.is_ascii_alphanumeric() || value == '-' || value == '_') {
      return Err("Agent session ID is invalid.".into());
    }
    let file = format!("{id}-{revision}.json");
    let session_path = session_root.join(&file);
    let temporary = session_root.join(format!(".{file}-{}.tmp", std::process::id()));
    let bytes = serde_json::to_vec_pretty(session).map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_AGENT_SESSION_BYTES {
      return Err(format!("Agent session {id} exceeds the 50 MB per-session limit."));
    }
    if contains_embedded_media(&bytes) {
      return Err("Agent session metadata cannot contain Base64 or data URL media.".into());
    }
    std::fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    set_private_file_permissions(&temporary)?;
    std::fs::rename(&temporary, &session_path).map_err(|error| error.to_string())?;
    retained.insert(file.clone());
    session_files.push(serde_json::json!({ "id": id, "file": file }));
  }
  let index = serde_json::json!({ "schemaVersion": 3, "revision": revision, "sessionFiles": session_files });
  let bytes = serde_json::to_vec_pretty(&index).map_err(|error| error.to_string())?;
  if bytes.len() > 10 * 1024 * 1024 { return Err("The agent session index exceeds 10 MB.".into()); }
  let temporary = directory.join(format!(".agent-sessions-{}.tmp", std::process::id()));
  std::fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
  set_private_file_permissions(&temporary)?;
  std::fs::rename(&temporary, &path).map_err(|error| error.to_string())?;
  if let Ok(entries) = std::fs::read_dir(&session_root) {
    for entry in entries.flatten() {
      let file = entry.file_name().to_string_lossy().into_owned();
      if file.ends_with(".json") && !retained.contains(&file) {
        let _ = std::fs::remove_file(entry.path());
      }
    }
  }
  Ok(())
}

fn contains_embedded_media(bytes: &[u8]) -> bool {
  bytes.windows(b"data:image/".len()).any(|window| window.eq_ignore_ascii_case(b"data:image/"))
    || bytes.windows(b"data:video/".len()).any(|window| window.eq_ignore_ascii_case(b"data:video/"))
    || bytes.windows(b";base64,".len()).any(|window| window.eq_ignore_ascii_case(b";base64,"))
}

#[tauri::command]
fn read_agent_sessions(app: tauri::AppHandle) -> Result<Value, String> {
  read_agent_sessions_file(&app)
}

#[tauri::command]
async fn wait_for_agent_sessions(
  app: tauri::AppHandle,
  after_revision: u64,
  timeout_ms: Option<u64>,
) -> Result<Value, String> {
  let timeout_ms = timeout_ms.unwrap_or(20_000).clamp(100, 25_000);
  tauri::async_runtime::spawn_blocking(move || {
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
    let path = agent_sessions_path(&app)?;
    let stamp = |path: &Path| {
      std::fs::metadata(path)
        .ok()
        .map(|metadata| (metadata.len(), metadata.modified().ok()))
    };
    let mut last_stamp = stamp(&path);
    let initial = read_agent_sessions_file(&app)?;
    if initial.get("revision").and_then(Value::as_u64).unwrap_or(0) > after_revision {
      return Ok(initial);
    }
    loop {
      if std::time::Instant::now() >= deadline {
        return read_agent_sessions_file(&app);
      }
      std::thread::sleep(std::time::Duration::from_millis(200));
      let next_stamp = stamp(&path);
      if next_stamp != last_stamp {
        last_stamp = next_stamp;
        let envelope = read_agent_sessions_file(&app)?;
        if envelope.get("revision").and_then(Value::as_u64).unwrap_or(0) > after_revision {
          return Ok(envelope);
        }
      }
    }
  })
  .await
  .map_err(|error| format!("Agent session wait task failed: {error}"))?
}

#[tauri::command]
fn upsert_agent_session(
  app: tauri::AppHandle,
  mut session: Value,
  expected_revision: Option<u64>,
) -> Result<Value, String> {
  let id = session.get("id").and_then(Value::as_str).ok_or("Agent session ID is required.")?;
  if id.is_empty() || id.len() > 128 || !id.chars().all(|value| value.is_ascii_alphanumeric() || value == '-' || value == '_') {
    return Err("Agent session ID is invalid.".into());
  }
  if !session.get("agent").is_some_and(Value::is_object) {
    return Err("Agent session state is required.".into());
  }
  let _lock = acquire_agent_store_lock(&app)?;
  let mut envelope = read_agent_sessions_file(&app)?;
  let sessions = envelope.get_mut("sessions").and_then(Value::as_array_mut).ok_or("Agent session list is invalid.")?;
  if let Some(index) = sessions.iter().position(|item| item.get("id").and_then(Value::as_str) == Some(id)) {
    let current_revision = sessions[index].pointer("/agent/revision").and_then(Value::as_u64).unwrap_or(0);
    if expected_revision != Some(current_revision) {
      return Err(format!(
        "AGENT_SESSION_CONFLICT: expected revision {}, but the shared session is at revision {}. Reload it before saving.",
        expected_revision.map_or_else(|| "none".into(), |value| value.to_string()),
        current_revision,
      ));
    }
    *session.pointer_mut("/agent/revision").ok_or("Agent session revision is required.")?
      = Value::from(current_revision + 1);
    sessions[index] = session;
  } else {
    if expected_revision.is_some_and(|value| value != 0) {
      return Err("AGENT_SESSION_CONFLICT: the shared session no longer exists. Reload before saving.".into());
    }
    *session.pointer_mut("/agent/revision").ok_or("Agent session revision is required.")?
      = Value::from(1);
    sessions.push(session);
  }
  let revision = envelope.get("revision").and_then(Value::as_u64).unwrap_or(0) + 1;
  envelope["revision"] = Value::from(revision);
  write_agent_sessions_file(&app, &envelope)?;
  Ok(envelope)
}

fn custom_skill_slug(name: &str) -> String {
  let mut slug = String::new();
  let mut separator = false;
  for value in name.to_ascii_lowercase().chars() {
    if value.is_ascii_alphanumeric() {
      slug.push(value);
      separator = false;
    } else if !separator && !slug.is_empty() {
      slug.push('-');
      separator = true;
    }
  }
  let slug = slug.trim_matches('-');
  if slug.is_empty() { "custom-production".into() } else { slug.into() }
}

fn validate_custom_skill_text(markdown: &str) -> Result<(), String> {
  if markdown.trim().is_empty() || markdown.len() > 200_000 {
    return Err("Custom Skill Markdown must be between 1 and 200,000 characters.".into());
  }
  let lower = markdown.to_ascii_lowercase();
  let contains_bound_id = lower
    .split(|value: char| !(value.is_ascii_alphanumeric() || value == '-'))
    .any(|value| {
      let uuid_like = value.len() == 36
        && value.chars().enumerate().all(|(index, character)| {
          if matches!(index, 8 | 13 | 18 | 23) { character == '-' } else { character.is_ascii_hexdigit() }
        });
      ((value.starts_with("asset-") || value.starts_with("session-")) && value.len() > 16) || uuid_like
    });
  if lower.contains("file://")
    || lower.contains("/users/")
    || lower.contains("/home/")
    || lower.contains("~/")
    || lower.contains("api_key")
    || lower.contains("api-key")
    || lower.contains("access_token")
    || contains_bound_id
    || lower.contains("begin rsa private key")
    || lower.contains("begin openssh private key")
    || lower.contains("begin ec private key")
    || lower.contains("sk-or-")
    || lower.contains("sk-proj-")
    || markdown.lines().any(|line| {
      let trimmed = line.trim();
      trimmed.len() > 3
        && trimmed.as_bytes()[1] == b':'
        && trimmed.as_bytes()[0].is_ascii_alphabetic()
        && matches!(trimmed.as_bytes()[2], b'\\' | b'/')
    })
  {
    return Err("Custom Skill text contains a local path or secret-like value.".into());
  }
  Ok(())
}

fn save_custom_skill_to_root(
  skills_root: &Path,
  name: &str,
  markdown: &str,
) -> Result<SavedCustomSkill, String> {
  let name = name.trim();
  if name.is_empty() || name.len() > 100 {
    return Err("Custom Skill name must be between 1 and 100 characters.".into());
  }
  validate_custom_skill_text(markdown)?;
  let directory = skills_root.join(custom_skill_slug(name));
  secure_directory(&directory)?;
  let path = directory.join("SKILL.md");
  let version = if path.exists() {
    let current = std::fs::read_to_string(&path).unwrap_or_default();
    current.lines()
      .find_map(|line| line.strip_prefix("version:").and_then(|value| value.trim().parse::<u64>().ok()))
      .unwrap_or(1) + 1
  } else {
    1
  };
  let mut replaced = false;
  let markdown = markdown.lines().map(|line| {
    if !replaced && line.starts_with("version:") {
      replaced = true;
      format!("version: {version}")
    } else {
      line.to_string()
    }
  }).collect::<Vec<_>>().join("\n");
  let temporary = directory.join(format!(".skill-{}.tmp", std::process::id()));
  std::fs::write(&temporary, &markdown).map_err(|error| error.to_string())?;
  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600))
      .map_err(|error| error.to_string())?;
  }
  std::fs::rename(&temporary, &path).map_err(|error| error.to_string())?;
  let versions = directory.join("versions");
  secure_directory(&versions)?;
  let version_path = versions.join(format!("{version}.md"));
  std::fs::write(&version_path, &markdown).map_err(|error| error.to_string())?;
  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&version_path, std::fs::Permissions::from_mode(0o600))
      .map_err(|error| error.to_string())?;
  }
  Ok(SavedCustomSkill {
    name: name.into(),
    version,
    markdown,
    path: path.to_string_lossy().into_owned(),
  })
}

fn list_custom_skills_from_root(skills_root: &Path) -> Result<Vec<CustomSkillSummary>, String> {
  if !skills_root.exists() {
    return Ok(Vec::new());
  }
  let mut summaries = Vec::new();
  for entry in std::fs::read_dir(skills_root).map_err(|error| error.to_string())? {
    let entry = entry.map_err(|error| error.to_string())?;
    if !entry.file_type().map_err(|error| error.to_string())?.is_dir() {
      continue;
    }
    let path = entry.path().join("SKILL.md");
    if !path.exists() {
      continue;
    }
    let markdown = std::fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let fallback_name = entry.file_name().to_string_lossy().into_owned();
    let name = markdown.lines()
      .find_map(|line| line.strip_prefix("name:").map(str::trim))
      .filter(|value| !value.is_empty())
      .unwrap_or(&fallback_name)
      .to_string();
    let version = markdown.lines()
      .find_map(|line| line.strip_prefix("version:").and_then(|value| value.trim().parse::<u64>().ok()))
      .unwrap_or(1);
    let versions_directory = entry.path().join("versions");
    let mut versions = if versions_directory.exists() {
      std::fs::read_dir(&versions_directory)
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .filter_map(|item| item.path().file_stem()?.to_str()?.parse::<u64>().ok())
        .collect::<Vec<_>>()
    } else {
      Vec::new()
    };
    if !versions.contains(&version) {
      versions.push(version);
    }
    versions.sort_unstable_by(|left, right| right.cmp(left));
    summaries.push(CustomSkillSummary {
      name,
      version,
      path: path.to_string_lossy().into_owned(),
      versions,
    });
  }
  summaries.sort_by_key(|item| item.name.to_ascii_lowercase());
  Ok(summaries)
}

fn read_custom_skill_from_root(
  skills_root: &Path,
  name: &str,
  version: Option<u64>,
) -> Result<SavedCustomSkill, String> {
  let directory = skills_root.join(custom_skill_slug(name));
  let path = version
    .map(|value| directory.join("versions").join(format!("{value}.md")))
    .unwrap_or_else(|| directory.join("SKILL.md"));
  if !path.exists() {
    return Err("Custom Skill version does not exist.".into());
  }
  let markdown = std::fs::read_to_string(&path).map_err(|error| error.to_string())?;
  let resolved_version = markdown.lines()
    .find_map(|line| line.strip_prefix("version:").and_then(|value| value.trim().parse::<u64>().ok()))
    .or(version)
    .unwrap_or(1);
  Ok(SavedCustomSkill {
    name: name.trim().into(),
    version: resolved_version,
    markdown,
    path: path.to_string_lossy().into_owned(),
  })
}

#[tauri::command]
fn list_custom_skills(app: tauri::AppHandle) -> Result<Vec<CustomSkillSummary>, String> {
  list_custom_skills_from_root(&credentials_directory(&app)?.join("skills"))
}

#[tauri::command]
fn read_custom_skill(
  app: tauri::AppHandle,
  name: String,
  version: Option<u64>,
) -> Result<SavedCustomSkill, String> {
  read_custom_skill_from_root(&credentials_directory(&app)?.join("skills"), &name, version)
}

#[tauri::command]
fn import_custom_skill_text(
  app: tauri::AppHandle,
  name: String,
  markdown: String,
) -> Result<SavedCustomSkill, String> {
  let skills_root = credentials_directory(&app)?.join("skills");
  secure_directory(&skills_root)?;
  save_custom_skill_to_root(&skills_root, &name, &markdown)
}

#[tauri::command]
fn rollback_custom_skill(
  app: tauri::AppHandle,
  name: String,
  version: u64,
) -> Result<SavedCustomSkill, String> {
  let skills_root = credentials_directory(&app)?.join("skills");
  let historical = read_custom_skill_from_root(&skills_root, &name, Some(version))?;
  save_custom_skill_to_root(&skills_root, &name, &historical.markdown)
}

fn openrouter_url(path: &str) -> Result<reqwest::Url, String> {
  let relative = path
    .strip_prefix('/')
    .filter(|value| !value.starts_with('/'))
    .ok_or("Unsupported OpenRouter API path.")?;
  let base = reqwest::Url::parse(&format!("{API_BASE}/"))
    .map_err(|_| "OpenRouter API base URL is invalid.")?;
  let url = base
    .join(relative)
    .map_err(|_| "Unsupported OpenRouter API path.")?;
  if url.scheme() != base.scheme()
    || url.host_str() != base.host_str()
    || url.port_or_known_default() != base.port_or_known_default()
    || !url.username().is_empty()
    || url.password().is_some()
    || url.fragment().is_some()
    || !url.path().starts_with("/api/v1/")
  {
    return Err("Unsupported OpenRouter API path.".into());
  }
  let normalized_path = url.path().strip_prefix("/api/v1").unwrap_or("");
  let safe_job_id = normalized_path
    .strip_prefix("/videos/")
    .is_some_and(|value| {
      !value.is_empty()
        && !value.contains('/')
        && value.chars().all(|character| {
          character.is_ascii_alphanumeric() || character == '-' || character == '_'
        })
    });
  let safe_endpoint_lookup = normalized_path
    .strip_prefix("/images/models/")
    .is_some_and(|value| {
      value.ends_with("/endpoints")
        && value.len() > "/endpoints".len()
        && !value.to_ascii_lowercase().contains("%2e")
    });
  let allowed_path = matches!(
    normalized_path,
    "/images/models" | "/videos/models" | "/models" | "/chat/completions" | "/images" | "/videos"
  ) || safe_job_id || safe_endpoint_lookup;
  let allowed_query = match normalized_path {
    "/models" => url.query() == Some("output_modalities=video"),
    _ => url.query().is_none(),
  };
  if !allowed_path || !allowed_query {
    return Err("Unsupported OpenRouter API path.".into());
  }
  Ok(url)
}

async fn response_error(response: reqwest::Response) -> String {
  let status = response.status();
  let bounded = read_bounded_response(response, MAX_ERROR_BYTES as u64, "OpenRouter error")
    .await
    .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
    .unwrap_or_default();
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

fn hydrate_local_media_references(app: &tauri::AppHandle, value: &mut Value) -> Result<(), String> {
  match value {
    Value::String(source) if source.starts_with(LOCAL_MEDIA_MARKER) => {
      let path = PathBuf::from(&source[LOCAL_MEDIA_MARKER.len()..]);
      let path = validate_managed_media_path(app, &path)?;
      let metadata = std::fs::metadata(&path).map_err(|error| error.to_string())?;
      if metadata.len() == 0 || metadata.len() > MAX_VIDEO_BYTES {
        return Err("A managed request asset exceeds the local safety limit.".into());
      }
      let bytes = std::fs::read(&path).map_err(|error| error.to_string())?;
      let name = path.file_name().and_then(|item| item.to_str()).unwrap_or("media.png");
      let (kind, mime_type, _) = inspect_media(&bytes[..bytes.len().min(16)], name)?;
      let limit = if kind == "video" { MAX_VIDEO_BYTES } else { MAX_IMAGE_BYTES };
      if bytes.len() as u64 > limit {
        return Err("A managed request asset exceeds the local safety limit.".into());
      }
      *source = format!(
        "data:{mime_type};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes),
      );
    }
    Value::Array(items) => {
      for item in items {
        hydrate_local_media_references(app, item)?;
      }
    }
    Value::Object(object) => {
      for item in object.values_mut() {
        hydrate_local_media_references(app, item)?;
      }
    }
    _ => {}
  }
  Ok(())
}

fn media_name_for_mime(mime_type: &str) -> &'static str {
  match mime_type {
    "image/jpeg" => "result.jpg",
    "image/webp" => "result.webp",
    "image/gif" => "result.gif",
    _ => "result.png",
  }
}

async fn download_public_image(url: &str) -> Result<(Vec<u8>, String), String> {
  let url = validate_remote_image_url(url)?;
  let client = reqwest::Client::builder()
    .timeout(std::time::Duration::from_secs(45))
    .redirect(reqwest::redirect::Policy::custom(|attempt| {
      if attempt.previous().len() >= 5 {
        return attempt.error("too many redirects");
      }
      if validate_remote_image_url(attempt.url().as_str()).is_ok() {
        attempt.follow()
      } else {
        attempt.stop()
      }
    }))
    .build()
    .map_err(|error| error.to_string())?;
  let response = client
    .get(url)
    .send()
    .await
    .map_err(|error| format!("Could not download the generated image: {error}"))?;
  if !response.status().is_success() {
    return Err(format!("Generated image download failed with HTTP {}.", response.status().as_u16()));
  }
  if response.content_length().is_some_and(|length| length > MAX_IMAGE_BYTES) {
    return Err("The generated image is larger than 30 MB.".into());
  }
  let mime_type = response
    .headers()
    .get(reqwest::header::CONTENT_TYPE)
    .and_then(|value| value.to_str().ok())
    .and_then(|value| value.split(';').next())
    .unwrap_or("")
    .trim()
    .to_ascii_lowercase();
  if !mime_type.starts_with("image/") {
    return Err("The generated result is not an image.".into());
  }
  let bytes = read_bounded_response(response, MAX_IMAGE_BYTES, "The generated image").await?;
  Ok((bytes, mime_type))
}

async fn materialize_openrouter_images(
  app: &tauri::AppHandle,
  payload: &mut Value,
) -> Result<(), String> {
  let Some(items) = payload.get_mut("data").and_then(Value::as_array_mut) else {
    return Ok(());
  };
  for item in items {
    let Some(object) = item.as_object_mut() else { continue };
    let declared_mime = object
      .get("media_type")
      .and_then(Value::as_str)
      .unwrap_or("image/png")
      .to_string();
    let materialized = if let Some(encoded) = object.get("b64_json").and_then(Value::as_str) {
      if encoded.len() as u64 > (MAX_IMAGE_BYTES * 4 / 3) + 8 {
        return Err("The generated image exceeds the 30 MB local safety limit.".into());
      }
      let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| "OpenRouter returned invalid image base64.")?;
      write_managed_media(
        &generated_directory(app)?,
        media_name_for_mime(&declared_mime),
        &bytes,
        "image",
      )?
    } else if let Some(url) = object.get("url").and_then(Value::as_str) {
      let (bytes, mime_type) = download_public_image(url).await?;
      write_managed_media(
        &generated_directory(app)?,
        media_name_for_mime(&mime_type),
        &bytes,
        "image",
      )?
    } else {
      continue;
    };
    object.remove("b64_json");
    object.remove("url");
    object.insert("local_path".into(), Value::String(materialized.local_path));
    object.insert("media_type".into(), Value::String(materialized.mime_type));
    object.insert("byte_size".into(), Value::from(materialized.byte_size));
  }
  Ok(())
}

#[tauri::command]
async fn openrouter_request(
  app: tauri::AppHandle,
  method: String,
  path: String,
  body: Option<Value>,
) -> Result<Value, String> {
  let url = openrouter_url(&path)?;
  let api_key = read_api_key(&app)?.ok_or("Add an OpenRouter API key in Settings first.")?;
  let client = reqwest::Client::builder()
    .timeout(std::time::Duration::from_secs(180))
    .build()
    .map_err(|error| error.to_string())?;
  if !matches!(method.as_str(), "GET" | "POST") {
    return Err("Unsupported HTTP method.".into());
  }
  let mut hydrated_body = body;
  if let Some(payload) = hydrated_body.as_mut() {
    hydrate_local_media_references(&app, payload)?;
  }
  let response = {
    let mut retry = 0u32;
    loop {
      let request = match method.as_str() {
        "GET" => client.get(url.clone()),
        "POST" => client.post(url.clone()),
        _ => unreachable!(),
      }
      .bearer_auth(&api_key)
      .header("Content-Type", "application/json")
      .header("HTTP-Referer", "https://fruit-truck.local")
      .header("X-Title", "Fruit Truck");
      let response = if let Some(payload) = hydrated_body.as_ref() {
        request.json(payload).send().await
      } else {
        request.send().await
      }
      .map_err(|error| format!("Could not reach OpenRouter: {error}"))?;
      if response.status().is_success() {
        break response;
      }
      let retryable = matches!(response.status().as_u16(), 429 | 503);
      if !retryable || retry >= 3 {
        return Err(response_error(response).await);
      }
      let retry_after = response.headers().get(reqwest::header::RETRY_AFTER).and_then(|value| value.to_str().ok());
      let delay = openrouter_retry_delay(retry_after, retry);
      tauri::async_runtime::spawn_blocking(move || std::thread::sleep(delay))
        .await
        .map_err(|error| format!("OpenRouter retry wait failed: {error}"))?;
      retry += 1;
    }
  };
  let bytes = read_bounded_response(response, MAX_OPENROUTER_JSON_BYTES, "OpenRouter response").await?;
  let mut payload = serde_json::from_slice::<Value>(&bytes)
    .map_err(|error| format!("OpenRouter returned invalid JSON: {error}"))?;
  if path == "/images" {
    materialize_openrouter_images(&app, &mut payload).await?;
  }
  Ok(payload)
}

fn openrouter_retry_delay(retry_after: Option<&str>, retry: u32) -> std::time::Duration {
  let milliseconds = retry_after
    .and_then(|value| value.trim().parse::<f64>().ok())
    .filter(|value| value.is_finite() && *value >= 0.0)
    .map(|seconds| (seconds * 1_000.0) as u64)
    .unwrap_or_else(|| 500u64.saturating_mul(2u64.saturating_pow(retry.min(6))));
  std::time::Duration::from_millis(milliseconds.min(30_000))
}

fn is_blocked_ip_address(address: std::net::IpAddr) -> bool {
  match address {
    std::net::IpAddr::V4(value) => {
      value.is_private()
        || value.is_loopback()
        || value.is_link_local()
        || value.is_broadcast()
        || value.is_unspecified()
        || value.is_multicast()
        || value.octets()[0] == 0
    }
    std::net::IpAddr::V6(value) => {
      let segments = value.segments();
      value.is_loopback()
        || value.is_unspecified()
        || value.is_multicast()
        || (segments[0] & 0xfe00) == 0xfc00
        || (segments[0] & 0xffc0) == 0xfe80
        || value
          .to_ipv4_mapped()
          .is_some_and(|mapped| is_blocked_ip_address(std::net::IpAddr::V4(mapped)))
    }
  }
}

fn validate_remote_image_url(value: &str) -> Result<reqwest::Url, String> {
  let url = reqwest::Url::parse(value).map_err(|_| "The image URL is invalid.".to_string())?;
  if !matches!(url.scheme(), "http" | "https") || !url.username().is_empty() || url.password().is_some() {
    return Err("Only public HTTP image URLs are supported.".into());
  }
  let host = url.host_str().ok_or("The image URL has no host.")?;
  if host.eq_ignore_ascii_case("localhost") || host.ends_with(".localhost") {
    return Err("Local image URLs are not supported.".into());
  }
  if let Ok(address) = host.trim_matches(['[', ']']).parse::<std::net::IpAddr>() {
    if is_blocked_ip_address(address) {
      return Err("Private network image URLs are not supported.".into());
    }
  }
  Ok(url)
}

async fn read_bounded_response(
  mut response: reqwest::Response,
  limit: u64,
  label: &str,
) -> Result<Vec<u8>, String> {
  let mut bytes = Vec::with_capacity(
    response.content_length().unwrap_or(0).min(limit) as usize,
  );
  while let Some(chunk) = response
    .chunk()
    .await
    .map_err(|error| format!("Could not read {label}: {error}"))?
  {
    if bytes.len() as u64 + chunk.len() as u64 > limit {
      return Err(format!("{label} exceeds the local safety limit."));
    }
    bytes.extend_from_slice(&chunk);
  }
  Ok(bytes)
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
    .timeout(std::time::Duration::from_secs(180))
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
  if !content_type.starts_with("video/") {
    return Err("Generated video content has an invalid media type.".into());
  }
  if response.content_length().is_some_and(|length| length > MAX_VIDEO_BYTES) {
    return Err("Generated video exceeds the 700 MB local safety limit.".into());
  }
  let bytes = read_bounded_response(response, MAX_VIDEO_BYTES, "Generated video").await?;
  let directory = generated_directory(&app)?;
  let extension = if content_type.contains("webm") { "webm" } else { "mp4" };
  let managed = write_managed_media(
    &directory,
    &format!("{job_id}.{extension}"),
    &bytes,
    "video",
  )?;
  Ok(CachedMedia {
    path: managed.local_path,
  })
}

fn media_command(app: &tauri::AppHandle, name: &str) -> Result<ShellCommand, String> {
  #[cfg(debug_assertions)]
  {
    Ok(app.shell().command(name))
  }
  #[cfg(not(debug_assertions))]
  {
    app
      .shell()
      .sidecar(name)
      .map_err(|error| format!("The bundled {name} executable is unavailable: {error}"))
  }
}

fn bounded_diagnostic(bytes: &[u8]) -> String {
  let start = bytes.len().saturating_sub(MAX_ERROR_BYTES);
  String::from_utf8_lossy(&bytes[start..]).trim().to_string()
}

struct MediaCommandOutput {
  success: bool,
  stdout: Vec<u8>,
  stderr: Vec<u8>,
}

fn append_bounded(buffer: &mut Vec<u8>, bytes: &[u8]) {
  let incoming = bytes.len().min(MAX_ERROR_BYTES);
  let overflow = buffer.len().saturating_add(incoming).saturating_sub(MAX_ERROR_BYTES);
  if overflow > 0 {
    buffer.drain(..overflow.min(buffer.len()));
  }
  buffer.extend_from_slice(&bytes[bytes.len() - incoming..]);
}

async fn execute_media_command(command: ShellCommand) -> Result<MediaCommandOutput, String> {
  let (mut events, _child) = command
    .spawn()
    .map_err(|error| format!("Could not launch bundled media tool: {error}"))?;
  let mut stdout = Vec::new();
  let mut stderr = Vec::new();
  let mut exit_code = None;
  while let Some(event) = events.recv().await {
    match event {
      CommandEvent::Stdout(bytes) => {
        append_bounded(&mut stdout, &bytes);
        append_bounded(&mut stdout, b"\n");
      }
      CommandEvent::Stderr(bytes) => {
        append_bounded(&mut stderr, &bytes);
        append_bounded(&mut stderr, b"\n");
      }
      CommandEvent::Error(error) => append_bounded(&mut stderr, error.as_bytes()),
      CommandEvent::Terminated(payload) => exit_code = payload.code,
      _ => {}
    }
  }
  Ok(MediaCommandOutput {
    success: exit_code == Some(0),
    stdout,
    stderr,
  })
}

fn parse_video_dimensions(value: &str) -> Result<(u32, u32), String> {
  let (width, height) = value
    .trim()
    .split_once('x')
    .ok_or("FFprobe returned an invalid video size.")?;
  let width = width.parse::<u32>().map_err(|_| "Invalid video width.")?;
  let height = height.parse::<u32>().map_err(|_| "Invalid video height.")?;
  let width = width - width % 2;
  let height = height - height % 2;
  if width < 2 || height < 2 || width > 8192 || height > 8192 {
    return Err("The assembly video size is unsupported.".into());
  }
  Ok((width, height))
}

async fn video_dimensions(app: &tauri::AppHandle, path: &Path) -> Result<(u32, u32), String> {
  let command = media_command(app, "ffprobe")?
    .args([
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "csv=s=x:p=0",
    ])
    .arg(path);
  let output = execute_media_command(command).await?;
  if !output.success {
    let diagnostic = bounded_diagnostic(&output.stderr);
    return Err(if diagnostic.is_empty() {
      "FFprobe could not inspect the first assembly clip.".into()
    } else {
      format!("FFprobe could not inspect the first assembly clip: {diagnostic}")
    });
  }
  parse_video_dimensions(&String::from_utf8_lossy(&output.stdout))
}

fn target_video_bitrate(width: u32, height: u32) -> u64 {
  let estimated = (width as f64 * height as f64 * 30.0 * 0.16).round() as u64;
  estimated.clamp(4_000_000, 40_000_000)
}

fn assembly_filter_graph(clips: &[AssemblyClip], width: u32, height: u32) -> String {
  let mut filters = clips
    .iter()
    .enumerate()
    .map(|(index, clip)| {
      format!(
        "[{index}:v]trim=start={:.3}:end={:.3},setpts=PTS-STARTPTS,\
scale={width}:{height}:force_original_aspect_ratio=decrease,\
pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30[v{index}]",
        clip.start_seconds, clip.end_seconds,
      )
    })
    .collect::<Vec<_>>();
  let inputs = (0..clips.len())
    .map(|index| format!("[v{index}]"))
    .collect::<String>();
  filters.push(format!("{inputs}concat=n={}:v=1:a=0[outv]", clips.len()));
  filters.join(";")
}

fn write_assembly_source(
  source: &str,
  _target: &Path,
  safe_roots: &[PathBuf],
  total_bytes: &mut usize,
) -> Result<PathBuf, String> {
  let path = PathBuf::from(source);
  let canonical = path.canonicalize().map_err(|_| "An assembly source is not a readable local file.")?;
  let allowed = safe_roots.iter().any(|root| {
    root.canonicalize().is_ok_and(|safe_root| canonical.starts_with(safe_root))
  });
  if !allowed {
    return Err("Only videos in Fruit Truck managed storage may be assembled.".into());
  }
  let size = std::fs::metadata(&canonical).map_err(|error| error.to_string())?.len() as usize;
  *total_bytes = total_bytes.saturating_add(size);
  if *total_bytes > MAX_VIDEO_BYTES as usize {
    return Err("Assembly inputs exceed the 700 MB local safety limit.".into());
  }
  Ok(canonical)
}

#[tauri::command]
async fn assemble_video(
  app: tauri::AppHandle,
  clips: Vec<AssemblyClip>,
  expected_duration: Option<f64>,
) -> Result<AssemblyResult, String> {
  if clips.is_empty() || clips.len() > 24 {
    return Err("Choose between 1 and 24 clips for an assembly.".into());
  }
  let duration = clips.iter().try_fold(0.0, |total, clip| {
    let clip_duration = clip.end_seconds - clip.start_seconds;
    if !clip.start_seconds.is_finite()
      || !clip.end_seconds.is_finite()
      || clip.start_seconds < 0.0
      || clip_duration <= 0.0
      || clip_duration > 120.0
    {
      return Err(format!("{} has an invalid crop range.", clip.name));
    }
    if total + clip_duration > 600.0 {
      return Err("Final video duration may not exceed 10 minutes.".into());
    }
    Ok(total + clip_duration)
  })?;
  if let Some(expected) = expected_duration {
    let tolerance = (expected * 0.01).clamp(0.1, 0.25);
    if !expected.is_finite() || expected <= 0.0 || (duration - expected).abs() > tolerance {
      return Err(format!(
        "The final assembly is {:.2} seconds, but the confirmed output length is {:.2} seconds.",
        duration, expected,
      ));
    }
  }
  let cache = app.path().app_cache_dir().map_err(|error| error.to_string())?;
  let assets = assets_directory(&app)?;
  let generated = generated_directory(&app)?;
  std::fs::create_dir_all(&cache).map_err(|error| error.to_string())?;
  secure_directory(&generated)?;
  let stamp = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map_err(|error| error.to_string())?
    .as_millis();
  let work = cache.join(format!("assembly-{}-{stamp}", std::process::id()));
  let output_directory = generated;
  std::fs::create_dir_all(&work).map_err(|error| error.to_string())?;
  std::fs::create_dir_all(&output_directory).map_err(|error| error.to_string())?;

  let result = async {
    let mut total_bytes = 0usize;
    let mut sources = Vec::with_capacity(clips.len());
    for (index, clip) in clips.iter().enumerate() {
      let staged = work.join(format!("input-{index}.mp4"));
      sources.push(write_assembly_source(
        &clip.source,
        &staged,
        &[assets.clone(), output_directory.clone()],
        &mut total_bytes,
      )?);
    }
    let (width, height) = video_dimensions(&app, &sources[0]).await?;
    let filter = assembly_filter_graph(&clips, width, height);
    let bitrate = target_video_bitrate(width, height).to_string();
    let temporary_output = work.join("final.mp4");
    let output = output_directory.join(format!("final-{stamp}.mp4"));

    let mut command = media_command(&app, "ffmpeg")?
      .args(["-hide_banner", "-loglevel", "error", "-nostdin", "-y"]);
    for source in &sources {
      command = command.arg("-i").arg(source);
    }
    let command = command
      .args([
        "-filter_complex",
        &filter,
        "-map",
        "[outv]",
        "-an",
        "-c:v",
        "h264_videotoolbox",
        "-profile:v",
        "high",
        "-allow_sw",
        "1",
        "-prio_speed",
        "0",
        "-b:v",
        &bitrate,
        "-pix_fmt",
        "yuv420p",
        "-fps_mode",
        "cfr",
        "-movflags",
        "+faststart",
        "-f",
        "mp4",
      ])
      .arg(&temporary_output);
    let rendered = execute_media_command(command).await?;
    if !rendered.success {
      let diagnostic = bounded_diagnostic(&rendered.stderr);
      return Err(if diagnostic.is_empty() {
        "FFmpeg could not render the final video.".into()
      } else {
        format!("FFmpeg could not render the final video: {diagnostic}")
      });
    }
    std::fs::rename(&temporary_output, &output).map_err(|error| error.to_string())?;
    set_private_file_permissions(&output)?;
    Ok(AssemblyResult { path: output.to_string_lossy().into_owned(), duration })
  }
  .await;
  let _ = std::fs::remove_dir_all(&work);
  result
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_process::init())
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_updater::Builder::new().build())
    .on_window_event(|window, event| {
      let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event else {
        return;
      };
      let app = window.app_handle().clone();
      let emitter = window.clone();
      let paths = paths.clone();
      tauri::async_runtime::spawn_blocking(move || {
        let result = assets_directory(&app).and_then(|root| {
          paths.iter().map(|path| import_media_file(path, &root)).collect::<Result<Vec<_>, _>>()
        });
        match result {
          Ok(assets) => {
            let _ = emitter.emit("managed-assets-imported", assets);
          }
          Err(error) => {
            let _ = emitter.emit("managed-assets-import-failed", error);
          }
        }
      });
    })
    .invoke_handler(tauri::generate_handler![
      credential_status,
      save_api_key,
      remove_api_key,
      openrouter_request,
      cache_video_content,
      append_shared_asset_chunk,
      finish_shared_asset,
      abort_shared_asset,
      pick_and_import_assets,
      delete_managed_asset,
      export_managed_asset,
      read_managed_image_data_url,
      assemble_video,
      read_agent_sessions,
      wait_for_agent_sessions,
      upsert_agent_session,
      report_desktop_runtime,
      list_custom_skills,
      read_custom_skill,
      import_custom_skill_text,
      rollback_custom_skill
    ])
    .run(tauri::generate_context!())
    .expect("error while running Fruit Truck");
}

#[cfg(test)]
mod tests {
  use base64::Engine;
  use super::{
    assembly_filter_graph,
    list_custom_skills_from_root,
    mask_key,
    parse_video_dimensions,
    read_custom_skill_from_root,
    save_custom_skill_to_root,
    target_video_bitrate,
    validate_custom_skill_text,
    validate_media_path_in_roots,
    unique_export_path,
    import_media_file,
    image_data_url_from_file,
    append_shared_asset_chunk_to_root,
    finish_shared_asset_to_root,
    openrouter_url,
    openrouter_retry_delay,
    contains_embedded_media,
    validate_remote_image_url,
    write_assembly_source,
  };

  #[test]
  fn api_paths_are_strictly_scoped() {
    assert_eq!(openrouter_url("/images/models").unwrap().path(), "/api/v1/images/models");
    assert!(openrouter_url("/chat/completions").is_ok());
    assert!(openrouter_url("/models?output_modalities=video").is_ok());
    assert!(openrouter_url("/videos/job-1").is_ok());
    assert!(openrouter_url("https://example.com").is_err());
    assert!(openrouter_url("/models").is_err());
    assert!(openrouter_url("/videos/%2e%2e/%2e%2e/keys").is_err());
    assert!(openrouter_url("/videos/%2E%2E/%2E%2E/credits").is_err());
    assert!(openrouter_url("//example.com/api/v1/images").is_err());
  }

  #[test]
  fn openrouter_retries_honor_seconds_and_bound_backoff() {
    assert_eq!(openrouter_retry_delay(Some("2"), 0), std::time::Duration::from_secs(2));
    assert_eq!(openrouter_retry_delay(None, 0), std::time::Duration::from_millis(500));
    assert_eq!(openrouter_retry_delay(None, 3), std::time::Duration::from_secs(4));
    assert_eq!(openrouter_retry_delay(Some("999"), 0), std::time::Duration::from_secs(30));
  }

  #[test]
  fn agent_session_snapshots_reject_embedded_media() {
    assert!(contains_embedded_media(br#"{"request":"data:image/png;base64,AAAA"}"#));
    assert!(contains_embedded_media(br#"{"payload":";base64,AAAA"}"#));
    assert!(!contains_embedded_media(br#"{"assetId":"asset-1","localPath":"/managed/reference.png"}"#));
  }

  #[test]
  fn api_keys_are_masked() {
    assert_eq!(mask_key("sk-or-v1-1234567890"), "sk-or-v…7890");
    assert_eq!(mask_key("가나다라마바사아자차카타"), "가나다라마바사…자차카타");
  }

  #[test]
  fn remote_image_urls_reject_local_targets() {
    assert!(validate_remote_image_url("https://images.example.com/output.png").is_ok());
    assert!(validate_remote_image_url("file:///tmp/output.png").is_err());
    assert!(validate_remote_image_url("http://localhost/output.png").is_err());
    assert!(validate_remote_image_url("http://127.0.0.1/output.png").is_err());
    assert!(validate_remote_image_url("http://192.168.1.2/output.png").is_err());
    assert!(validate_remote_image_url("http://[::1]/output.png").is_err());
    assert!(validate_remote_image_url("http://[fc00::1]/output.png").is_err());
    assert!(validate_remote_image_url("http://[fe80::1]/output.png").is_err());
    assert!(validate_remote_image_url("http://[::ffff:169.254.169.254]/output.png").is_err());
  }

  #[test]
  fn assembly_video_dimensions_are_even_and_bounded() {
    assert_eq!(parse_video_dimensions("1921x1081").unwrap(), (1920, 1080));
    assert!(parse_video_dimensions("1x1080").is_err());
    assert!(parse_video_dimensions("9000x1080").is_err());
    assert!(parse_video_dimensions("not-a-size").is_err());
  }

  #[test]
  fn assembly_bitrate_scales_and_clamps() {
    assert_eq!(target_video_bitrate(640, 360), 4_000_000);
    assert_eq!(target_video_bitrate(1920, 1080), 9_953_280);
    assert_eq!(target_video_bitrate(8192, 8192), 40_000_000);
  }

  #[test]
  fn assembly_filter_trims_normalizes_and_concatenates_once() {
    let clips = vec![
      super::AssemblyClip {
        source: "/managed/one.webm".into(),
        name: "one".into(),
        start_seconds: 1.25,
        end_seconds: 3.5,
      },
      super::AssemblyClip {
        source: "/managed/two.mp4".into(),
        name: "two".into(),
        start_seconds: 0.0,
        end_seconds: 2.0,
      },
    ];
    let filter = assembly_filter_graph(&clips, 1920, 1080);
    assert!(filter.contains("[0:v]trim=start=1.250:end=3.500"));
    assert!(filter.contains("scale=1920:1080:force_original_aspect_ratio=decrease"));
    assert!(filter.contains("[v0][v1]concat=n=2:v=1:a=0[outv]"));
    assert_eq!(filter.matches("concat=").count(), 1);
  }

  #[test]
  fn custom_skill_approval_writes_and_versions_skill_markdown() {
    let root = std::env::temp_dir().join(format!(
      "fruit-truck-skill-test-{}-{}",
      std::process::id(),
      std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(),
    ));
    std::fs::create_dir_all(&root).unwrap();
    let markdown = "---\nname: Test workflow\nversion: 1\n---\n\n# Test workflow";
    let first = save_custom_skill_to_root(&root, "Test workflow", markdown).unwrap();
    let second = save_custom_skill_to_root(&root, "Test workflow", markdown).unwrap();
    assert!(std::path::Path::new(&first.path).exists());
    assert_eq!(first.version, 1);
    assert_eq!(second.version, 2);
    assert!(second.markdown.contains("version: 2"));
    let listed = list_custom_skills_from_root(&root).unwrap();
    assert_eq!(listed[0].versions, vec![2, 1]);
    let historical = read_custom_skill_from_root(&root, "Test workflow", Some(1)).unwrap();
    assert!(historical.markdown.contains("version: 1"));
    let _ = std::fs::remove_dir_all(root);
  }

  #[test]
  fn custom_skills_reject_session_bound_ids_paths_and_secrets() {
    assert!(validate_custom_skill_text("# Safe\nUse a restrained visual direction.").is_ok());
    assert!(validate_custom_skill_text("# Unsafe\nasset-1234567890abcdef").is_err());
    assert!(validate_custom_skill_text("# Unsafe\n123e4567-e89b-12d3-a456-426614174000").is_err());
    assert!(validate_custom_skill_text("# Unsafe\nC:\\Users\\creator\\clip.mp4").is_err());
    assert!(validate_custom_skill_text("# Unsafe\napi_key = secret-value-123").is_err());
  }

  #[test]
  fn assembly_sources_accept_only_declared_generated_roots() {
    let root = std::env::temp_dir().join(format!(
      "fruit-truck-assembly-test-{}-{}",
      std::process::id(),
      std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(),
    ));
    let generated = root.join("generated");
    let outside = root.join("outside");
    std::fs::create_dir_all(&generated).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    let allowed = generated.join("clip.mp4");
    let rejected = outside.join("clip.mp4");
    std::fs::write(&allowed, b"video").unwrap();
    std::fs::write(&rejected, b"video").unwrap();
    let mut bytes = 0;
    assert!(write_assembly_source(
      allowed.to_str().unwrap(),
      &root.join("staged.mp4"),
      std::slice::from_ref(&generated),
      &mut bytes,
    ).is_ok());
    assert!(write_assembly_source(
      rejected.to_str().unwrap(),
      &root.join("staged.mp4"),
      &[generated],
      &mut bytes,
    ).is_err());
    let _ = std::fs::remove_dir_all(root);
  }

  #[test]
  fn legacy_asset_bytes_are_materialized_outside_session_json() {
    let root = std::env::temp_dir().join(format!(
      "fruit-truck-shared-asset-test-{}-{}",
      std::process::id(),
      std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(),
    ));
    let png = b"\x89PNG\r\n\x1a\nlegacy";
    let input = super::SharedAssetInput {
      asset_id: "asset_123".into(),
      name: "reference.png".into(),
      mime_type: "image/png".into(),
      origin: Some("upload".into()),
    };
    append_shared_asset_chunk_to_root(&root, "upload_123", &png[..8]).unwrap();
    append_shared_asset_chunk_to_root(&root, "upload_123", &png[8..]).unwrap();
    let result = finish_shared_asset_to_root(&root, "upload_123", &input).unwrap();
    assert!(std::path::Path::new(&result.path).exists());
    assert_eq!(std::fs::read(&result.path).unwrap(), png);
    let _ = std::fs::remove_dir_all(root);
  }

  #[test]
  fn imported_media_is_copied_and_only_managed_roots_are_readable() {
    let root = std::env::temp_dir().join(format!(
      "fruit-truck-managed-media-test-{}-{}",
      std::process::id(),
      std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(),
    ));
    let source_directory = root.join("source");
    let assets = root.join("assets");
    let outside = root.join("outside");
    std::fs::create_dir_all(&source_directory).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    let source = source_directory.join("reference.png");
    let outside_file = outside.join("private.png");
    let png = b"\x89PNG\r\n\x1a\nmanaged";
    std::fs::write(&source, png).unwrap();
    std::fs::write(&outside_file, png).unwrap();

    let imported = import_media_file(&source, &assets).unwrap();
    let imported_path = std::path::PathBuf::from(imported.local_path);
    assert_eq!(std::fs::read(&imported_path).unwrap(), png);
    assert!(validate_media_path_in_roots(&imported_path, std::slice::from_ref(&assets)).is_ok());
    assert!(validate_media_path_in_roots(&outside_file, &[assets]).is_err());

    let disguised = source_directory.join("disguised.png");
    std::fs::write(&disguised, b"not an image").unwrap();
    assert!(import_media_file(&disguised, &root.join("assets")).is_err());
    let _ = std::fs::remove_dir_all(root);
  }

  #[test]
  fn managed_image_bytes_are_exposed_as_a_canvas_safe_data_url() {
    let root = std::env::temp_dir().join(format!(
      "fruit-truck-image-data-url-test-{}-{}",
      std::process::id(),
      std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(),
    ));
    std::fs::create_dir_all(&root).unwrap();
    let image = root.join("reference.png");
    let png = b"\x89PNG\r\n\x1a\ncanvas-safe";
    std::fs::write(&image, png).unwrap();

    let data_url = image_data_url_from_file(&image).unwrap();
    assert_eq!(
      data_url,
      format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(png),
      ),
    );
    let _ = std::fs::remove_dir_all(root);
  }

  #[test]
  fn exports_use_safe_names_without_overwriting_existing_downloads() {
    let root = std::env::temp_dir().join(format!(
      "fruit-truck-export-test-{}-{}",
      std::process::id(),
      std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(),
    ));
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("result.png"), b"existing").unwrap();

    assert_eq!(unique_export_path(&root, "../result.png"), root.join("result (1).png"));
    assert_eq!(unique_export_path(&root, "../../"), root.join("fruit-truck-asset"));
    let _ = std::fs::remove_dir_all(root);
  }
}
