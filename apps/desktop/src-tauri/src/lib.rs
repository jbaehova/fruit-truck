mod legacy_cleanup;

use legacy_cleanup::cleanup_legacy_installations;

use std::io::{Read, Seek, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

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
const MAX_ERROR_BYTES: usize = 2_000;
const MAX_IMAGE_BYTES: u64 = 30 * 1024 * 1024;
const MAX_VIDEO_BYTES: u64 = 700 * 1024 * 1024;
const MAX_AUDIO_BYTES: u64 = 50 * 1024 * 1024;
const MAX_REQUEST_MEDIA_BYTES: u64 = 30 * 1024 * 1024;
const MAX_OPENROUTER_JSON_BYTES: u64 = 48 * 1024 * 1024;
const LOCAL_MEDIA_MARKER: &str = "fruit-truck-local:";
static MEDIA_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static ALLOW_APP_EXIT: AtomicBool = AtomicBool::new(false);

const EVENT_QUIT_REQUESTED: &str = "app-quit-requested";

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
struct ManagedAssetInput {
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

#[derive(Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
struct ManagedAssetMetadata {
    width: Option<u32>,
    height: Option<u32>,
    duration: Option<f64>,
    fps: Option<f64>,
    codec: Option<String>,
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

fn generated_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(credentials_directory(app)?.join("generated"))
}

fn assets_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(credentials_directory(app)?.join("assets"))
}

fn inspect_media(
    bytes: &[u8],
    name: &str,
) -> Result<(&'static str, &'static str, &'static str), String> {
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
    } else if bytes.starts_with(b"fLaC") {
        ("audio", "audio/flac", "flac")
    } else if bytes.starts_with(b"ID3")
        || (bytes.len() >= 2 && bytes[0] == 0xff && bytes[1] & 0xe0 == 0xe0 && extension == "mp3")
    {
        ("audio", "audio/mpeg", "mp3")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WAVE" {
        ("audio", "audio/wav", "wav")
    } else if bytes.len() >= 2
        && bytes[0] == 0xff
        && matches!(bytes[1] & 0xf6, 0xf0 | 0xf4)
        && extension == "aac"
    {
        ("audio", "audio/aac", "aac")
    } else if bytes.starts_with(b"\x1a\x45\xdf\xa3") {
        ("video", "video/webm", "webm")
    } else if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        if extension == "m4a" {
            ("audio", "audio/mp4", "m4a")
        } else if extension == "mov" {
            ("video", "video/quicktime", "mov")
        } else {
            ("video", "video/mp4", "mp4")
        }
    } else {
        return Err("The selected file is not a supported image, video, or audio file.".into());
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
        root.canonicalize()
            .is_ok_and(|canonical_root| canonical.starts_with(canonical_root))
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
    Ok(root.join(format!(
        "{prefix}-{stamp}-{}-{sequence}.{extension}",
        std::process::id()
    )))
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
    let limit = if kind == "video" {
        MAX_VIDEO_BYTES
    } else if kind == "audio" {
        MAX_AUDIO_BYTES
    } else {
        MAX_IMAGE_BYTES
    };
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
    if metadata.len() == 0 {
        return Err("The selected media file is empty.".into());
    }
    if metadata.len() > MAX_VIDEO_BYTES {
        return Err("The selected media exceeds the local safety limit.".into());
    }
    let mut header = [0u8; 16];
    let read = input.read(&mut header).map_err(|error| error.to_string())?;
    let (kind, mime_type, extension) = inspect_media(&header[..read], name)?;
    let limit = if kind == "video" {
        MAX_VIDEO_BYTES
    } else if kind == "audio" {
        MAX_AUDIO_BYTES
    } else {
        MAX_IMAGE_BYTES
    };
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

fn validate_managed_asset_input(input: &ManagedAssetInput) -> Result<(), String> {
    if input.asset_id.is_empty()
        || input.asset_id.len() > 128
        || !input
            .asset_id
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || value == '-' || value == '_')
    {
        return Err("Managed asset ID is invalid.".into());
    }
    if !input.mime_type.starts_with("image/")
        && !input.mime_type.starts_with("video/")
        && !input.mime_type.starts_with("audio/")
    {
        return Err("Only image, video, and audio assets may be shared.".into());
    }
    Ok(())
}

fn upload_asset_root(app: &tauri::AppHandle, origin: Option<&str>) -> Result<PathBuf, String> {
    if origin == Some("upload") {
        assets_directory(app)
    } else {
        generated_directory(app)
    }
}

fn asset_upload_path(root: &Path, upload_id: &str) -> Result<PathBuf, String> {
    if upload_id.is_empty()
        || upload_id.len() > 128
        || !upload_id
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || value == '-' || value == '_')
    {
        return Err("Shared upload ID is invalid.".into());
    }
    secure_directory(root)?;
    Ok(root.join(format!(".upload-{upload_id}.part")))
}

fn append_asset_chunk_to_root(root: &Path, upload_id: &str, bytes: &[u8]) -> Result<(), String> {
    if bytes.is_empty() {
        return Err("Managed asset chunk is empty.".into());
    }
    let temporary = asset_upload_path(root, upload_id)?;
    let current_size = std::fs::metadata(&temporary)
        .map(|value| value.len())
        .unwrap_or(0);
    if current_size.saturating_add(bytes.len() as u64) > MAX_VIDEO_BYTES {
        let _ = std::fs::remove_file(&temporary);
        return Err("Managed asset exceeds the local safety limit.".into());
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

fn finish_asset_upload_to_root(
    root: &Path,
    upload_id: &str,
    input: &ManagedAssetInput,
) -> Result<CachedMedia, String> {
    validate_managed_asset_input(input)?;
    let temporary = asset_upload_path(root, upload_id)?;
    let result = (|| {
        let metadata = std::fs::metadata(&temporary)
            .map_err(|_| "Managed asset upload is missing.".to_string())?;
        let limit = if input.mime_type.starts_with("video/") {
            MAX_VIDEO_BYTES
        } else if input.mime_type.starts_with("audio/") {
            MAX_AUDIO_BYTES
        } else {
            MAX_IMAGE_BYTES
        };
        if metadata.len() == 0 || metadata.len() > limit {
            return Err("Managed asset exceeds the local safety limit.".into());
        }
        let mut source = std::fs::File::open(&temporary).map_err(|error| error.to_string())?;
        let mut header = [0u8; 16];
        let read = source
            .read(&mut header)
            .map_err(|error| error.to_string())?;
        let (_, detected_mime, extension) = inspect_media(&header[..read], &input.name)?;
        if detected_mime != input.mime_type {
            return Err("Managed asset MIME type does not match its contents.".into());
        }
        let path = unique_media_path(root, "legacy", extension)?;
        std::fs::rename(&temporary, &path).map_err(|error| error.to_string())?;
        set_private_file_permissions(&path)?;
        Ok(CachedMedia {
            path: path.to_string_lossy().into_owned(),
        })
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

#[tauri::command]
fn append_asset_chunk(
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
        tauri::ipc::InvokeBody::Json(_) => {
            return Err("Managed asset chunks must use raw IPC.".into())
        }
    };
    let root = upload_asset_root(&app, origin)?;
    append_asset_chunk_to_root(&root, upload_id, bytes)
}

#[tauri::command]
fn finish_asset_upload(
    app: tauri::AppHandle,
    upload_id: String,
    input: ManagedAssetInput,
) -> Result<CachedMedia, String> {
    validate_managed_asset_input(&input)?;
    let root = upload_asset_root(&app, input.origin.as_deref())?;
    finish_asset_upload_to_root(&root, &upload_id, &input)
}

#[tauri::command]
fn abort_asset_upload(
    app: tauri::AppHandle,
    upload_id: String,
    origin: Option<String>,
) -> Result<(), String> {
    let root = upload_asset_root(&app, origin.as_deref())?;
    let temporary = asset_upload_path(&root, &upload_id)?;
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
        .add_filter(
            "Images, videos, and audio",
            &[
                "png", "jpg", "jpeg", "webp", "gif", "mp4", "mov", "webm", "mp3", "wav", "flac",
                "m4a", "aac",
            ],
        )
        .blocking_pick_files();
    let Some(files) = selection else {
        return Ok(Vec::new());
    };
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
fn export_managed_asset(
    app: tauri::AppHandle,
    path: String,
    name: String,
) -> Result<String, String> {
    let source = validate_managed_media_path(&app, Path::new(&path))?;
    let downloads = app
        .path()
        .download_dir()
        .map_err(|error| error.to_string())?;
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
    let name = path
        .file_name()
        .and_then(|item| item.to_str())
        .unwrap_or("image.png");
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

fn requested_image_dimensions(
    width: u32,
    height: u32,
    resolution: Option<&str>,
    aspect_ratio: Option<&str>,
) -> Option<(u32, u32)> {
    let resolution_value = resolution.unwrap_or("").trim().to_ascii_lowercase();
    let long_side = match resolution_value.as_str() {
        "1k" => 1024,
        "2k" => 2048,
        "4k" => 4096,
        value => value
            .trim_end_matches("px")
            .trim_end_matches('p')
            .parse::<u32>()
            .unwrap_or(0),
    };
    let ratio = aspect_ratio
        .and_then(|value| value.split_once(':'))
        .and_then(|(left, right)| Some((left.parse::<f64>().ok()?, right.parse::<f64>().ok()?)))
        .filter(|(_, right)| *right > 0.0)
        .map(|(left, right)| left / right)
        .unwrap_or(width as f64 / height as f64);
    let target_long_side = if long_side > 0 {
        long_side
    } else {
        width.max(height)
    };
    if !ratio.is_finite() || ratio <= 0.0 || target_long_side == 0 {
        return None;
    }
    let target = if ratio >= 1.0 {
        (
            target_long_side,
            ((target_long_side as f64 / ratio).round() as u32).max(1),
        )
    } else {
        (
            ((target_long_side as f64 * ratio).round() as u32).max(1),
            target_long_side,
        )
    };
    (target != (width, height)).then_some(target)
}

#[tauri::command]
fn normalize_generated_image(
    app: tauri::AppHandle,
    path: String,
    resolution: Option<String>,
    aspect_ratio: Option<String>,
) -> Result<(), String> {
    let source = validate_managed_media_path(&app, Path::new(&path))?;
    if !source.starts_with(generated_directory(&app)?) {
        return Err("Only generated images may be normalized.".into());
    }
    let image = image::open(&source)
        .map_err(|error| format!("Could not decode generated image: {error}"))?;
    let Some((width, height)) = requested_image_dimensions(
        image.width(),
        image.height(),
        resolution.as_deref(),
        aspect_ratio.as_deref(),
    ) else {
        return Ok(());
    };
    if width > 4096 || height > 4096 {
        return Err("Requested image dimensions exceed the 4K local output limit.".into());
    }
    let format = image::ImageFormat::from_path(&source).map_err(|error| error.to_string())?;
    let normalized = image.resize_to_fill(width, height, image::imageops::FilterType::Lanczos3);
    let temporary = source.with_extension("normalize.tmp");
    normalized
        .save_with_format(&temporary, format)
        .map_err(|error| error.to_string())?;
    set_private_file_permissions(&temporary)?;
    std::fs::rename(&temporary, &source).map_err(|error| error.to_string())?;
    Ok(())
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
    let suffix = characters[characters.len() - 4..]
        .iter()
        .collect::<String>();
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
    let safe_endpoint_lookup =
        normalized_path
            .strip_prefix("/images/models/")
            .is_some_and(|value| {
                value.ends_with("/endpoints")
                    && value.len() > "/endpoints".len()
                    && !value.to_ascii_lowercase().contains("%2e")
            });
    let allowed_path = matches!(
        normalized_path,
        "/images/models"
            | "/videos/models"
            | "/models"
            | "/chat/completions"
            | "/images"
            | "/videos"
    ) || safe_job_id
        || safe_endpoint_lookup;
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
            let diagnostics = [
                payload.pointer("/error/metadata/error_type"),
                payload.pointer("/error/metadata/provider_code"),
                payload.pointer("/error/code"),
                payload.pointer("/error/metadata/provider_name"),
                payload.pointer("/error/metadata/provider_slug"),
                payload.pointer("/error/metadata/model_slug"),
                payload.pointer("/error/metadata/reasons"),
            ]
            .into_iter()
            .flatten()
            .filter_map(|value| {
                value
                    .as_str()
                    .map(str::to_owned)
                    .or_else(|| value.as_i64().map(|number| number.to_string()))
                    .or_else(|| (!value.is_null()).then(|| value.to_string()))
            })
            .fold(Vec::<String>::new(), |mut values, value| {
                if !values.contains(&value) {
                    values.push(value);
                }
                values
            });
            return if diagnostics.is_empty() {
                format!("OpenRouter {}: {}", status.as_u16(), message)
            } else {
                format!(
                    "OpenRouter {}: {} [{}]",
                    status.as_u16(),
                    message,
                    diagnostics.join(" · ")
                )
            };
        }
    }
    format!(
        "OpenRouter {}: {}",
        status.as_u16(),
        if bounded.is_empty() {
            "Request failed"
        } else {
            &bounded
        }
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
            let name = path
                .file_name()
                .and_then(|item| item.to_str())
                .unwrap_or("media.png");
            let (_, mime_type, _) = inspect_media(&bytes[..bytes.len().min(16)], name)?;
            if bytes.len() as u64 > MAX_REQUEST_MEDIA_BYTES {
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
        return Err(format!(
            "Generated image download failed with HTTP {}.",
            response.status().as_u16()
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_IMAGE_BYTES)
    {
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
        let Some(object) = item.as_object_mut() else {
            continue;
        };
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
            let retry_after = response
                .headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|value| value.to_str().ok());
            let delay = openrouter_retry_delay(retry_after, retry);
            tauri::async_runtime::spawn_blocking(move || std::thread::sleep(delay))
                .await
                .map_err(|error| format!("OpenRouter retry wait failed: {error}"))?;
            retry += 1;
        }
    };
    let bytes =
        read_bounded_response(response, MAX_OPENROUTER_JSON_BYTES, "OpenRouter response").await?;
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
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
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
    let mut bytes = Vec::with_capacity(response.content_length().unwrap_or(0).min(limit) as usize);
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
async fn cache_video_content(app: tauri::AppHandle, job_id: String) -> Result<CachedMedia, String> {
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
    if response
        .content_length()
        .is_some_and(|length| length > MAX_VIDEO_BYTES)
    {
        return Err("Generated video exceeds the 700 MB local safety limit.".into());
    }
    let bytes = read_bounded_response(response, MAX_VIDEO_BYTES, "Generated video").await?;
    let directory = generated_directory(&app)?;
    let extension = if content_type.contains("webm") {
        "webm"
    } else {
        "mp4"
    };
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
        app.shell()
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
    let overflow = buffer
        .len()
        .saturating_add(incoming)
        .saturating_sub(MAX_ERROR_BYTES);
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

fn json_f64(value: Option<&Value>) -> Option<f64> {
    let parsed = value.and_then(|item| {
        item.as_f64()
            .or_else(|| item.as_str().and_then(|text| text.parse::<f64>().ok()))
    });
    parsed.filter(|number| number.is_finite() && *number >= 0.0)
}

fn parse_frame_rate(value: Option<&Value>) -> Option<f64> {
    let raw = value?.as_str()?;
    let (numerator, denominator) = raw.split_once('/')?;
    let numerator = numerator.parse::<f64>().ok()?;
    let denominator = denominator.parse::<f64>().ok()?;
    let fps = numerator / denominator;
    (denominator > 0.0 && fps.is_finite() && fps > 0.0).then_some(fps)
}

fn parse_managed_asset_metadata(value: &str) -> Result<ManagedAssetMetadata, String> {
    let payload: Value =
        serde_json::from_str(value).map_err(|_| "FFprobe returned invalid media metadata.")?;
    let streams = payload
        .get("streams")
        .and_then(Value::as_array)
        .ok_or("FFprobe returned no media streams.")?;
    let video = streams
        .iter()
        .find(|stream| stream.get("codec_type").and_then(Value::as_str) == Some("video"));
    let primary = video.or_else(|| streams.first());
    let codec = primary
        .and_then(|stream| stream.get("codec_name"))
        .and_then(Value::as_str)
        .map(str::to_string);
    Ok(ManagedAssetMetadata {
        width: video
            .and_then(|stream| stream.get("width"))
            .and_then(Value::as_u64)
            .and_then(|number| u32::try_from(number).ok()),
        height: video
            .and_then(|stream| stream.get("height"))
            .and_then(Value::as_u64)
            .and_then(|number| u32::try_from(number).ok()),
        duration: json_f64(
            payload
                .get("format")
                .and_then(|format| format.get("duration")),
        ),
        fps: video.and_then(|stream| parse_frame_rate(stream.get("avg_frame_rate"))),
        codec,
    })
}

#[tauri::command]
async fn inspect_managed_asset(
    app: tauri::AppHandle,
    path: String,
) -> Result<ManagedAssetMetadata, String> {
    let canonical = validate_managed_media_path(&app, Path::new(&path))?;
    let command = media_command(&app, "ffprobe")?
        .args([
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type,codec_name,width,height,avg_frame_rate:format=duration",
            "-of",
            "json",
        ])
        .arg(canonical);
    let output = execute_media_command(command).await?;
    if !output.success {
        let diagnostic = bounded_diagnostic(&output.stderr);
        return Err(if diagnostic.is_empty() {
            "FFprobe could not inspect the managed asset.".into()
        } else {
            format!("FFprobe could not inspect the managed asset: {diagnostic}")
        });
    }
    parse_managed_asset_metadata(&String::from_utf8_lossy(&output.stdout))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .enable_macos_default_menu(false)
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                if let Err(error) = cleanup_legacy_installations(&app_handle) {
                    eprintln!("Fruit Truck could not finish legacy integration cleanup: {error}");
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = window.emit(EVENT_QUIT_REQUESTED, ());
            }
            tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) => {
                let app = window.app_handle().clone();
                let emitter = window.clone();
                let paths = paths.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let result = assets_directory(&app).and_then(|root| {
                        paths
                            .iter()
                            .map(|path| import_media_file(path, &root))
                            .collect::<Result<Vec<_>, _>>()
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
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            credential_status,
            save_api_key,
            remove_api_key,
            openrouter_request,
            cache_video_content,
            append_asset_chunk,
            finish_asset_upload,
            abort_asset_upload,
            pick_and_import_assets,
            inspect_managed_asset,
            delete_managed_asset,
            export_managed_asset,
            read_managed_image_data_url,
            normalize_generated_image,
            quit_app
        ])
        .build(tauri::generate_context!())
        .expect("error while building Fruit Truck");

    app.run(|app, event| {
        if let tauri::RunEvent::ExitRequested { code, api, .. } = event {
            if !exit_requires_confirmation(code) {
                return;
            }
            if ALLOW_APP_EXIT.swap(false, Ordering::SeqCst) {
                return;
            }
            api.prevent_exit();
            let _ = app.emit(EVENT_QUIT_REQUESTED, ());
        }
    });
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    ALLOW_APP_EXIT.store(true, Ordering::SeqCst);
    app.exit(0);
}

fn exit_requires_confirmation(code: Option<i32>) -> bool {
    code != Some(tauri::RESTART_EXIT_CODE)
}
