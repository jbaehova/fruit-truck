mod legacy_cleanup;
mod workspace_storage;

use legacy_cleanup::cleanup_legacy_installations;

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, Cursor, Read, Seek, Write};
use std::net::ToSocketAddrs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use base64::Engine;
use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader as XmlReader;
use serde::de::{DeserializeSeed, MapAccess, SeqAccess, Visitor};
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
const MAX_REQUEST_MEDIA_TOTAL_BYTES: u64 = 120 * 1024 * 1024;
const MAX_REQUEST_ENCODED_MEDIA_BYTES: u64 = 168 * 1024 * 1024;
const MAX_REQUEST_MEDIA_COUNT: usize = 50;
const MAX_OPENROUTER_JSON_BYTES: u64 = 48 * 1024 * 1024;
const MAX_OPENROUTER_IMAGE_RESPONSE_BYTES: u64 = 448 * 1024 * 1024;
const MAX_IMAGE_DIMENSION: u32 = 16_384;
const MAX_IMAGE_PIXELS: u64 = 16_777_216;
const MAX_MEDIA_DURATION_SECONDS: f64 = 3_600.0;
const MAX_MEDIA_FPS: f64 = 240.0;
const MAX_SVG_NODES: usize = 10_000;
const MAX_SVG_DEPTH: usize = 64;
const MAX_SVG_HEADER_BYTES: usize = 4 * 1024;
const MAX_NETWORK_CONCURRENCY: usize = 4;
const MEDIA_RESPONSE_TIMEOUT_SECONDS: u64 = 180;
const DNS_TIMEOUT_SECONDS: u64 = 10;
const FFPROBE_TIMEOUT_SECONDS: u64 = 20;
const LOCAL_MEDIA_MARKER: &str = "fruit-truck-local:";
const KEYCHAIN_DISPLAY_PATH: &str = "macOS Keychain (Fruit Truck)";
#[cfg(target_os = "macos")]
const KEYCHAIN_SERVICE: &str = "ui.fruittruck.desktop";
#[cfg(target_os = "macos")]
const KEYCHAIN_ACCOUNT: &str = "openrouter-api-key";
static MEDIA_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static ALLOW_APP_EXIT: AtomicBool = AtomicBool::new(false);
static CREDENTIALS_LOCK: Mutex<()> = Mutex::new(());
static WORKSPACE_STORAGE_LOCK: Mutex<()> = Mutex::new(());
static NETWORK_SEMAPHORE: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
static OPENROUTER_CANCELLATIONS: OnceLock<
    Mutex<HashMap<String, tokio::sync::watch::Sender<bool>>>,
> = OnceLock::new();

const EVENT_QUIT_REQUESTED: &str = "app-quit-requested";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CredentialStatus {
    configured: bool,
    masked_key: Option<String>,
    path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiKeyValidation {
    valid: bool,
    state: &'static str,
    status_code: Option<u16>,
    message: Option<&'static str>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum CredentialStorage {
    #[cfg(target_os = "macos")]
    Keychain,
    File,
}

struct StoredApiKey {
    value: String,
    storage: CredentialStorage,
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

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenRouterRequestProgress {
    request_id: String,
    stage: &'static str,
    partial_image_index: Option<u64>,
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

#[derive(Debug)]
struct BoundedResponseFile {
    path: PathBuf,
}

struct RequestMediaBudget {
    raw_bytes: u64,
    encoded_bytes: u64,
    count: usize,
}

impl RequestMediaBudget {
    fn new() -> Self {
        Self {
            raw_bytes: 0,
            encoded_bytes: 0,
            count: 0,
        }
    }

    fn reserve(&mut self, raw_bytes: u64) -> Result<(), String> {
        self.count = self
            .count
            .checked_add(1)
            .ok_or("Too many managed request assets.")?;
        if self.count > MAX_REQUEST_MEDIA_COUNT {
            return Err(format!(
                "A request may contain at most {MAX_REQUEST_MEDIA_COUNT} managed assets."
            ));
        }
        let encoded_bytes = raw_bytes
            .checked_add(2)
            .and_then(|value| value.checked_div(3))
            .and_then(|value| value.checked_mul(4))
            .and_then(|value| value.checked_add(128))
            .ok_or("The managed request media size is too large.")?;
        let next_raw = self
            .raw_bytes
            .checked_add(raw_bytes)
            .ok_or("The managed request media size is too large.")?;
        let next_encoded = self
            .encoded_bytes
            .checked_add(encoded_bytes)
            .ok_or("The managed request media size is too large.")?;
        if next_raw > MAX_REQUEST_MEDIA_TOTAL_BYTES {
            return Err(format!(
                "Managed request media exceeds the {}/{} aggregate limit.",
                MAX_REQUEST_MEDIA_TOTAL_BYTES / (1024 * 1024),
                "MB"
            ));
        }
        if next_encoded > MAX_REQUEST_ENCODED_MEDIA_BYTES {
            return Err("Managed request media exceeds the encoded aggregate limit.".into());
        }
        self.raw_bytes = next_raw;
        self.encoded_bytes = next_encoded;
        Ok(())
    }
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

fn looks_like_svg(bytes: &[u8]) -> bool {
    let sample = &bytes[..bytes.len().min(MAX_SVG_HEADER_BYTES)];
    let Ok(text) = std::str::from_utf8(sample) else {
        return false;
    };
    let lower = text.to_ascii_lowercase();
    lower.contains("<svg")
}

fn svg_tag_allowed(name: &str) -> bool {
    matches!(
        name,
        "svg"
            | "g"
            | "path"
            | "rect"
            | "circle"
            | "ellipse"
            | "line"
            | "polyline"
            | "polygon"
            | "defs"
            | "lineargradient"
            | "radialgradient"
            | "stop"
            | "clippath"
            | "mask"
            | "symbol"
            | "use"
            | "image"
            | "title"
            | "desc"
            | "text"
            | "tspan"
            | "pattern"
            | "marker"
            | "filter"
            | "fegaussianblur"
            | "feoffset"
            | "feblend"
            | "fecolormatrix"
            | "fecomposite"
            | "fecomponenttransfer"
            | "feflood"
    )
}

fn svg_attribute_allowed(name: &str) -> bool {
    matches!(
        name,
        "xmlns"
            | "xmlns:xlink"
            | "version"
            | "width"
            | "height"
            | "viewbox"
            | "preserveaspectratio"
            | "fill"
            | "fill-opacity"
            | "fill-rule"
            | "stroke"
            | "stroke-width"
            | "stroke-linecap"
            | "stroke-linejoin"
            | "stroke-miterlimit"
            | "stroke-dasharray"
            | "stroke-dashoffset"
            | "stroke-opacity"
            | "opacity"
            | "transform"
            | "d"
            | "x"
            | "y"
            | "x1"
            | "y1"
            | "x2"
            | "y2"
            | "cx"
            | "cy"
            | "r"
            | "rx"
            | "ry"
            | "points"
            | "id"
            | "offset"
            | "stop-color"
            | "stop-opacity"
            | "clip-path"
            | "clip-rule"
            | "mask"
            | "href"
            | "xlink:href"
            | "gradientunits"
            | "gradienttransform"
            | "spreadmethod"
            | "font-family"
            | "font-size"
            | "font-style"
            | "font-weight"
            | "text-anchor"
            | "textlength"
            | "lengthadjust"
            | "dominant-baseline"
            | "color"
            | "filterunits"
            | "primitiveunits"
            | "marker-start"
            | "marker-mid"
            | "marker-end"
            | "markerwidth"
            | "markerheight"
            | "refx"
            | "refy"
            | "patternunits"
            | "patterncontentunits"
            | "patterntransform"
    )
}

fn svg_uri_is_local(value: &str) -> bool {
    let lower = value.trim().to_ascii_lowercase();
    if lower.starts_with('#') {
        return true;
    }
    let mut remainder = lower.as_str();
    while let Some(start) = remainder.find("url(") {
        let after = &remainder[start + 4..];
        let Some(end) = after.find(')') else {
            return false;
        };
        let uri = after[..end].trim().trim_matches(['\'', '"']);
        if !uri.starts_with('#') {
            return false;
        }
        remainder = &after[end + 1..];
    }
    true
}

fn svg_attribute_value_safe(name: &str, value: &str) -> bool {
    let lower_name = name.to_ascii_lowercase();
    if lower_name.starts_with("on")
        || lower_name == "style"
        || lower_name == "src"
        || lower_name == "action"
    {
        return false;
    }
    if matches!(
        lower_name.as_str(),
        "href" | "xlink:href" | "clip-path" | "mask"
    ) && !svg_uri_is_local(value)
    {
        return false;
    }
    if lower_name == "xmlns" {
        return value == "http://www.w3.org/2000/svg";
    }
    if lower_name == "xmlns:xlink" {
        return value == "http://www.w3.org/1999/xlink";
    }
    let lower = value.to_ascii_lowercase();
    if lower.contains("javascript:")
        || lower.contains("vbscript:")
        || lower.contains("data:")
        || lower.contains("http:")
        || lower.contains("https:")
        || lower.contains("//")
    {
        return false;
    }
    if lower.contains("url(") && !svg_uri_is_local(value) {
        return false;
    }
    true
}

fn xml_escape_attribute(value: &str, output: &mut Vec<u8>) {
    for character in value.chars() {
        match character {
            '&' => output.extend_from_slice(b"&amp;"),
            '<' => output.extend_from_slice(b"&lt;"),
            '>' => output.extend_from_slice(b"&gt;"),
            '"' => output.extend_from_slice(b"&quot;"),
            '\'' => output.extend_from_slice(b"&apos;"),
            value => {
                let mut encoded = [0; 4];
                output.extend_from_slice(value.encode_utf8(&mut encoded).as_bytes());
            }
        }
    }
}

fn parse_svg_dimension(value: &str) -> Option<f64> {
    let value = value.trim();
    if value.ends_with('%') {
        let percentage = value[..value.len().saturating_sub(1)]
            .trim()
            .parse::<f64>()
            .ok()?;
        return (percentage.is_finite() && (0.0..=100.0).contains(&percentage))
            .then_some(percentage);
    }
    let lower = value.to_ascii_lowercase();
    let (number, scale) = [
        ("px", 1.0),
        ("pt", 96.0 / 72.0),
        ("pc", 16.0),
        ("mm", 96.0 / 25.4),
        ("cm", 96.0 / 2.54),
        ("in", 96.0),
    ]
    .into_iter()
    .find_map(|(suffix, scale)| lower.strip_suffix(suffix).map(|number| (number, scale)))
    .unwrap_or((lower.as_str(), 1.0));
    let number = number.trim().parse::<f64>().ok()?;
    let pixels = number * scale;
    (pixels.is_finite() && pixels > 0.0).then_some(pixels)
}

fn validate_svg_root_dimensions(start: &BytesStart<'_>) -> Result<(), String> {
    let mut width = None;
    let mut height = None;
    let mut view_box = None;
    for attribute in start.attributes().with_checks(true) {
        let attribute =
            attribute.map_err(|_| "Generated SVG contains an invalid attribute.".to_string())?;
        let name = std::str::from_utf8(attribute.key.as_ref())
            .map_err(|_| "Generated SVG contains an invalid attribute name.".to_string())?
            .to_ascii_lowercase();
        let value = attribute
            .normalized_value(quick_xml::XmlVersion::Implicit1_0)
            .map_err(|_| "Generated SVG contains an invalid attribute value.".to_string())?;
        match name.as_str() {
            "width" => width = Some(value.into_owned()),
            "height" => height = Some(value.into_owned()),
            "viewbox" => view_box = Some(value.into_owned()),
            _ => {}
        }
    }
    let width = width
        .as_deref()
        .map(|value| {
            parse_svg_dimension(value).ok_or_else(|| "Generated SVG width is invalid.".to_string())
        })
        .transpose()?;
    let height = height
        .as_deref()
        .map(|value| {
            parse_svg_dimension(value).ok_or_else(|| "Generated SVG height is invalid.".to_string())
        })
        .transpose()?;
    if width.is_some_and(|value| value > f64::from(MAX_IMAGE_DIMENSION))
        || height.is_some_and(|value| value > f64::from(MAX_IMAGE_DIMENSION))
        || width
            .zip(height)
            .is_some_and(|(width, height)| width * height > MAX_IMAGE_PIXELS as f64)
    {
        return Err("Generated SVG dimensions exceed the local safety limit.".into());
    }
    if let Some(view_box) = view_box {
        let values = view_box
            .split_ascii_whitespace()
            .map(|value| value.parse::<f64>())
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| "Generated SVG viewBox is invalid.".to_string())?;
        if values.len() != 4
            || values[2] <= 0.0
            || values[3] <= 0.0
            || !values.iter().all(|value| value.is_finite())
            || values[2] > f64::from(MAX_IMAGE_DIMENSION)
            || values[3] > f64::from(MAX_IMAGE_DIMENSION)
            || values[2] * values[3] > MAX_IMAGE_PIXELS as f64
        {
            return Err("Generated SVG viewBox exceeds the local safety limit.".into());
        }
    }
    Ok(())
}

fn append_svg_start(
    start: &BytesStart<'_>,
    output: &mut Vec<u8>,
    stack: &mut Vec<String>,
) -> Result<(), String> {
    let name_bytes = start.name();
    let name = std::str::from_utf8(name_bytes.as_ref())
        .map_err(|_| "Generated SVG contains an invalid element name.".to_string())?;
    let lower_name = name.to_ascii_lowercase();
    if !svg_tag_allowed(&lower_name) {
        return Err(format!("Generated SVG element is not allowed: {name}."));
    }
    if stack.is_empty() && lower_name != "svg" {
        return Err("Generated SVG must have an svg root element.".into());
    }
    if stack.len() >= MAX_SVG_DEPTH {
        return Err("Generated SVG nesting exceeds the safety limit.".into());
    }
    if stack.is_empty() {
        validate_svg_root_dimensions(start)?;
    }
    output.extend_from_slice(b"<");
    // Emit canonical lowercase element names so mixed-case input cannot
    // produce a mismatched opening/closing pair in the retained SVG.
    output.extend_from_slice(lower_name.as_bytes());
    for attribute in start.attributes().with_checks(true) {
        let attribute =
            attribute.map_err(|_| "Generated SVG contains an invalid attribute.".to_string())?;
        let key = std::str::from_utf8(attribute.key.as_ref())
            .map_err(|_| "Generated SVG contains an invalid attribute name.".to_string())?;
        let lower_key = key.to_ascii_lowercase();
        if !svg_attribute_allowed(&lower_key) {
            return Err(format!("Generated SVG attribute is not allowed: {key}."));
        }
        let value = attribute
            .normalized_value(quick_xml::XmlVersion::Implicit1_0)
            .map_err(|_| "Generated SVG contains an invalid attribute value.".to_string())?;
        if !svg_attribute_value_safe(&lower_key, &value) {
            return Err(format!("Generated SVG attribute is unsafe: {key}."));
        }
        output.push(b' ');
        output.extend_from_slice(key.as_bytes());
        output.extend_from_slice(b"=\"");
        xml_escape_attribute(&value, output);
        output.push(b'\"');
    }
    output.push(b'>');
    stack.push(lower_name);
    Ok(())
}

fn sanitize_svg(bytes: &[u8]) -> Result<Vec<u8>, String> {
    if bytes.is_empty() || bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err("The generated SVG exceeds the local safety limit.".into());
    }
    let mut reader = XmlReader::from_reader(Cursor::new(bytes));
    reader.config_mut().trim_text(false);
    let mut buffer = Vec::new();
    let mut output = Vec::with_capacity(bytes.len().min(MAX_IMAGE_BYTES as usize));
    let mut stack = Vec::new();
    let mut node_count = 0usize;
    let mut root_seen = false;
    loop {
        let event = reader
            .read_event_into(&mut buffer)
            .map_err(|_| "Generated SVG is not valid XML.".to_string())?;
        match event {
            Event::Start(start) => {
                node_count = node_count.saturating_add(1);
                if node_count > MAX_SVG_NODES {
                    return Err("Generated SVG contains too many elements.".into());
                }
                if stack.is_empty() {
                    if root_seen {
                        return Err("Generated SVG has more than one root element.".into());
                    }
                    root_seen = true;
                }
                append_svg_start(&start, &mut output, &mut stack)?;
            }
            Event::Empty(start) => {
                node_count = node_count.saturating_add(1);
                if node_count > MAX_SVG_NODES {
                    return Err("Generated SVG contains too many elements.".into());
                }
                if stack.is_empty() {
                    if root_seen {
                        return Err("Generated SVG has more than one root element.".into());
                    }
                    root_seen = true;
                }
                append_svg_start(&start, &mut output, &mut stack)?;
                let name = stack
                    .pop()
                    .ok_or("Generated SVG has an invalid empty element.")?;
                output.extend_from_slice(b"</");
                output.extend_from_slice(name.as_bytes());
                output.push(b'>');
            }
            Event::End(end) => {
                let name = std::str::from_utf8(end.name().as_ref())
                    .map_err(|_| "Generated SVG contains an invalid closing element.".to_string())?
                    .to_ascii_lowercase();
                if stack.pop().as_deref() != Some(name.as_str()) {
                    return Err("Generated SVG has mismatched element nesting.".into());
                }
                output.extend_from_slice(b"</");
                output.extend_from_slice(name.as_bytes());
                output.push(b'>');
            }
            Event::Text(text) => {
                let text_bytes: &[u8] = text.as_ref();
                if stack.is_empty()
                    && !text_bytes
                        .iter()
                        .all(|value| matches!(value, b' ' | b'\t' | b'\r' | b'\n'))
                {
                    return Err("Generated SVG has text outside its root element.".into());
                }
                output.extend_from_slice(text_bytes);
            }
            Event::CData(_) | Event::Comment(_) | Event::GeneralRef(_) => {}
            Event::Decl(_) => {}
            Event::DocType(_) | Event::PI(_) => {
                return Err("Generated SVG may not contain document directives.".into())
            }
            Event::Eof => break,
        }
        if output.len() > MAX_IMAGE_BYTES as usize {
            return Err("Generated SVG exceeds the local safety limit.".into());
        }
        buffer.clear();
    }
    if stack.is_empty() && root_seen && node_count > 0 {
        Ok(output)
    } else {
        Err("Generated SVG has no valid svg root element.".into())
    }
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
    let detected = if extension == "svg" && looks_like_svg(bytes) {
        ("image", "image/svg+xml", "svg")
    } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
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

fn reject_symlink_path_components(path: &Path) -> Result<(), String> {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        let Ok(metadata) = std::fs::symlink_metadata(&current) else {
            continue;
        };
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "{} may not contain symlink components.",
                path.display()
            ));
        }
    }
    Ok(())
}

fn configure_runtime_asset_scope(app: &tauri::AppHandle) -> Result<(), String> {
    let root = credentials_directory(app)?;
    reject_symlink_path_components(&root)?;
    secure_directory(&root)?;
    for managed_root in managed_roots(app)? {
        reject_symlink_path_components(&managed_root)?;
        secure_directory(&managed_root)?;
        let canonical = managed_root
            .canonicalize()
            .map_err(|error| format!("Could not resolve managed asset root: {error}"))?;
        app.asset_protocol_scope()
            .allow_directory(canonical, true)
            .map_err(|error| format!("Could not allow managed asset root: {error}"))?;
    }
    Ok(())
}

fn reject_symlink_components(path: &Path, root: &Path) -> Result<(), String> {
    let Ok(relative) = path.strip_prefix(root) else {
        return Ok(());
    };
    let root_metadata = std::fs::symlink_metadata(root)
        .map_err(|_| "The managed media root is missing or unreadable.".to_string())?;
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return Err("Managed media roots may not contain symlink components.".into());
    }
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component.as_os_str());
        let metadata = std::fs::symlink_metadata(&current)
            .map_err(|_| "The managed media file is missing or unreadable.".to_string())?;
        if metadata.file_type().is_symlink() {
            return Err("Symlinked managed media paths are not supported.".into());
        }
    }
    Ok(())
}

fn validate_media_path_in_roots(path: &Path, roots: &[PathBuf]) -> Result<PathBuf, String> {
    let input_metadata = std::fs::symlink_metadata(path)
        .map_err(|_| "The managed media file is missing or unreadable.".to_string())?;
    if input_metadata.file_type().is_symlink() {
        return Err("Symlinked managed media paths are not supported.".into());
    }
    for root in roots {
        reject_symlink_components(path, root)?;
    }
    let canonical = path
        .canonicalize()
        .map_err(|_| "The managed media file is missing or unreadable.".to_string())?;
    if !canonical.is_file() {
        return Err("The managed media path is not a file.".into());
    }
    let allowed = roots.iter().any(|root| {
        let Ok(root_metadata) = std::fs::symlink_metadata(root) else {
            return false;
        };
        if root_metadata.file_type().is_symlink() {
            return false;
        }
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

fn secure_export_directory(path: &Path) -> Result<(), String> {
    if let Ok(metadata) = std::fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(format!("{} must be a directory.", path.display()));
        }
    }
    std::fs::create_dir_all(path).map_err(|error| error.to_string())?;
    let metadata = std::fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!("{} must be a directory.", path.display()));
    }
    Ok(())
}

fn atomic_export_copy(source: &Path, destination: &Path) -> Result<(), String> {
    let source_metadata = std::fs::symlink_metadata(source).map_err(|error| error.to_string())?;
    if source_metadata.file_type().is_symlink() || !source_metadata.is_file() {
        return Err("The managed export source must be a regular file.".into());
    }
    let parent = destination
        .parent()
        .ok_or("The export destination has no parent directory.")?;
    let parent_metadata = std::fs::symlink_metadata(parent).map_err(|error| error.to_string())?;
    if parent_metadata.file_type().is_symlink() || !parent_metadata.is_dir() {
        return Err("The export destination must be a directory child.".into());
    }
    if std::fs::symlink_metadata(destination)
        .is_ok_and(|metadata| metadata.file_type().is_symlink())
    {
        return Err("The export destination may not be a symlink.".into());
    }
    let temporary = parent.join(format!(
        ".fruit-truck-export-{}-{}.part",
        std::process::id(),
        MEDIA_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let input = std::fs::File::open(source).map_err(|error| error.to_string())?;
        let mut output = create_private_file(&temporary)?;
        let copied = std::io::copy(
            &mut input.take(source_metadata.len().saturating_add(1)),
            &mut output,
        )
        .map_err(|error| error.to_string())?;
        if copied != source_metadata.len() {
            return Err("The managed export copy was incomplete.".into());
        }
        output.flush().map_err(|error| error.to_string())?;
        output.sync_all().map_err(|error| error.to_string())?;
        std::fs::rename(&temporary, destination).map_err(|error| error.to_string())?;
        #[cfg(unix)]
        if let Ok(directory) = std::fs::File::open(parent) {
            let _ = directory.sync_all();
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
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

fn create_private_file(path: &Path) -> Result<std::fs::File, String> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(path).map_err(|error| error.to_string())?;
    set_private_file_permissions(path)?;
    Ok(file)
}

fn validate_image_dimensions(bytes: &[u8], name: &str) -> Result<(), String> {
    if Path::new(name)
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("svg"))
    {
        return Ok(());
    }
    let dimensions = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(image::ImageError::IoError)
        .and_then(|reader| reader.into_dimensions());
    let (width, height) = match dimensions {
        Ok(dimensions) => dimensions,
        Err(_)
            if bytes.len() >= 10
                && (bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a")) =>
        {
            (
                u16::from_le_bytes([bytes[6], bytes[7]]) as u32,
                u16::from_le_bytes([bytes[8], bytes[9]]) as u32,
            )
        }
        Err(_) => return Err("The image dimensions could not be inspected safely.".into()),
    };
    if width == 0
        || height == 0
        || width > MAX_IMAGE_DIMENSION
        || height > MAX_IMAGE_DIMENSION
        || u64::from(width).saturating_mul(u64::from(height)) > MAX_IMAGE_PIXELS
    {
        return Err("The image dimensions exceed the local safety limit.".into());
    }
    Ok(())
}

fn write_temp_file(
    root: &Path,
    prefix: &str,
    extension: &str,
) -> Result<(PathBuf, std::fs::File), String> {
    secure_directory(root)?;
    let path = unique_media_path(root, prefix, extension)?;
    let temporary = path.with_file_name(format!(
        ".{}-{}.part",
        prefix,
        MEDIA_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let file = create_private_file(&temporary)?;
    Ok((temporary, file))
}

fn finish_temp_file(
    mut temporary: PathBuf,
    final_path: &Path,
    file: &mut std::fs::File,
) -> Result<(), String> {
    file.flush().map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    set_private_file_permissions(&temporary)?;
    std::fs::rename(&temporary, final_path).map_err(|error| {
        let _ = std::fs::remove_file(&temporary);
        error.to_string()
    })?;
    temporary.clear();
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
    let bytes = if mime_type == "image/svg+xml" {
        sanitize_svg(bytes)?
    } else {
        bytes.to_vec()
    };
    if kind == "image" {
        validate_image_dimensions(&bytes, &format!("result.{extension}"))?;
    }
    if bytes.is_empty() || bytes.len() as u64 > limit {
        return Err("The media file exceeds the local safety limit.".into());
    }
    let path = unique_media_path(root, prefix, extension)?;
    let temporary = path.with_file_name(format!(
        ".{}.part",
        path.file_name().unwrap().to_string_lossy()
    ));
    let write_result = (|| {
        let mut output = create_private_file(&temporary)?;
        output
            .write_all(&bytes)
            .map_err(|error| error.to_string())?;
        finish_temp_file(temporary.clone(), &path, &mut output)
    })();
    if let Err(error) = write_result {
        let _ = std::fs::remove_file(&temporary);
        return Err(error);
    }
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

fn write_managed_media_from_temp(
    root: &Path,
    name: &str,
    temporary: &Path,
    prefix: &str,
) -> Result<ManagedAssetFile, String> {
    let metadata = std::fs::symlink_metadata(temporary).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("The downloaded media temporary file is invalid.".into());
    }
    if metadata.len() == 0 || metadata.len() > MAX_VIDEO_BYTES {
        return Err("The downloaded media exceeds the local safety limit.".into());
    }
    let mut source = std::fs::File::open(temporary).map_err(|error| error.to_string())?;
    let mut header = vec![0u8; MAX_SVG_HEADER_BYTES];
    let read = source
        .read(&mut header)
        .map_err(|error| error.to_string())?;
    let header = &header[..read];
    let (kind, mime_type, extension) = inspect_media(header, name)?;
    let limit = if kind == "video" {
        MAX_VIDEO_BYTES
    } else if kind == "audio" {
        MAX_AUDIO_BYTES
    } else {
        MAX_IMAGE_BYTES
    };
    if metadata.len() > limit {
        return Err("The downloaded media exceeds the local safety limit.".into());
    }
    if mime_type == "image/svg+xml" {
        source.rewind().map_err(|error| error.to_string())?;
        let mut bytes = Vec::new();
        source
            .take(limit + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        if bytes.len() as u64 > limit {
            return Err("The downloaded image exceeds the local safety limit.".into());
        }
        let managed = write_managed_media(root, name, &bytes, prefix);
        let _ = std::fs::remove_file(temporary);
        return managed;
    }
    if kind == "image" {
        source.rewind().map_err(|error| error.to_string())?;
        let mut bytes = Vec::new();
        source
            .take(limit + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        validate_image_dimensions(&bytes, &format!("result.{extension}"))?;
    }
    let path = unique_media_path(root, prefix, extension)?;
    let destination_temporary = path.with_file_name(format!(
        ".{}.part",
        path.file_name().unwrap().to_string_lossy()
    ));
    let result = (|| {
        let input = std::fs::File::open(temporary).map_err(|error| error.to_string())?;
        let mut output = create_private_file(&destination_temporary)?;
        let copied = std::io::copy(&mut input.take(limit + 1), &mut output)
            .map_err(|error| error.to_string())?;
        if copied == 0 || copied > limit {
            return Err("The downloaded media exceeds the local safety limit.".into());
        }
        finish_temp_file(destination_temporary.clone(), &path, &mut output)?;
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
            byte_size: copied,
        })
    })();
    let _ = std::fs::remove_file(temporary);
    if result.is_err() {
        let _ = std::fs::remove_file(destination_temporary);
    }
    result
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
    let mut header = [0u8; MAX_SVG_HEADER_BYTES];
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
    if kind == "image" {
        input.rewind().map_err(|error| error.to_string())?;
        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        input
            .take(limit + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        if bytes.len() as u64 > limit {
            return Err("The selected media exceeds the local safety limit.".into());
        }
        let managed = write_managed_media(root, name, &bytes, "asset")?;
        return Ok(managed);
    }
    input.rewind().map_err(|error| error.to_string())?;
    let path = unique_media_path(root, "asset", extension)?;
    let temporary = root.join(format!(
        ".asset-import-{}-{}.part",
        std::process::id(),
        MEDIA_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut output = create_private_file(&temporary)?;
        let copied = std::io::copy(&mut input.take(limit + 1), &mut output)
            .map_err(|error| error.to_string())?;
        output.flush().map_err(|error| error.to_string())?;
        output.sync_all().map_err(|error| error.to_string())?;
        if copied == 0 || copied > limit {
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
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
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
    if std::fs::symlink_metadata(&temporary).is_ok_and(|metadata| metadata.file_type().is_symlink())
    {
        return Err("Managed asset upload path may not be a symlink.".into());
    }
    let current_size = std::fs::metadata(&temporary)
        .map(|value| value.len())
        .unwrap_or(0);
    if current_size.saturating_add(bytes.len() as u64) > MAX_VIDEO_BYTES {
        let _ = std::fs::remove_file(&temporary);
        return Err("Managed asset exceeds the local safety limit.".into());
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).append(true);
    if current_size == 0 {
        options.create_new(true);
    }
    let mut output = options
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
        let metadata = std::fs::symlink_metadata(&temporary)
            .map_err(|_| "Managed asset upload is missing.".to_string())?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("Managed asset upload must be a regular file.".into());
        }
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
        let mut header = [0u8; MAX_SVG_HEADER_BYTES];
        let read = source
            .read(&mut header)
            .map_err(|error| error.to_string())?;
        let (_, detected_mime, extension) = inspect_media(&header[..read], &input.name)?;
        if detected_mime != input.mime_type {
            return Err("Managed asset MIME type does not match its contents.".into());
        }
        if input.mime_type.starts_with("image/") {
            source.rewind().map_err(|error| error.to_string())?;
            let mut bytes = Vec::with_capacity(metadata.len() as usize);
            source
                .take(limit + 1)
                .read_to_end(&mut bytes)
                .map_err(|error| error.to_string())?;
            if bytes.len() as u64 > limit {
                return Err("Managed asset exceeds the local safety limit.".into());
            }
            let managed = write_managed_media(root, &input.name, &bytes, "legacy")?;
            if let Err(error) = std::fs::remove_file(&temporary) {
                let _ = std::fs::remove_file(&managed.local_path);
                return Err(error.to_string());
            }
            return Ok(CachedMedia {
                path: managed.local_path,
            });
        }
        let path = unique_media_path(root, "legacy", extension)?;
        source.sync_all().map_err(|error| error.to_string())?;
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

fn import_media_files_preserving_successes(
    paths: &[PathBuf],
    root: &Path,
) -> (Vec<ManagedAssetFile>, Vec<String>) {
    let mut successes = Vec::with_capacity(paths.len());
    let mut errors = Vec::new();
    for path in paths {
        match import_media_file(path, root) {
            Ok(asset) => successes.push(asset),
            Err(error) => errors.push(format!("{}: {error}", path.display())),
        }
    }
    (successes, errors)
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
    let emitter = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut paths = Vec::with_capacity(files.len());
        let mut errors = Vec::new();
        for file in files {
            match file.into_path() {
                Ok(path) => paths.push(path),
                Err(error) => errors.push(format!("Could not read selected media path: {error}")),
            }
        }
        let (assets, import_errors) = import_media_files_preserving_successes(&paths, &root);
        errors.extend(import_errors);
        if !errors.is_empty() && !assets.is_empty() {
            let _ = emitter.emit("managed-assets-import-failed", errors.join("\n"));
        }
        if assets.is_empty() && !errors.is_empty() {
            Err(errors.join("\n"))
        } else {
            Ok(assets)
        }
    })
    .await
    .map_err(|error| format!("Managed asset import task failed: {error}"))?
}

#[tauri::command]
fn delete_managed_asset(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let roots = managed_roots(&app)?.to_vec();
    if let Some(canonical) = validate_managed_deletion_path(Path::new(&path), &roots)? {
        std::fs::remove_file(canonical).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn validate_managed_deletion_path(
    path: &Path,
    roots: &[PathBuf],
) -> Result<Option<PathBuf>, String> {
    match validate_media_path_in_roots(path, roots) {
        Ok(canonical) => Ok(Some(canonical)),
        Err(error) if !path.exists() => {
            let matching_root = roots.iter().find(|root| path.starts_with(root));
            if !path.is_absolute()
                || path
                    .components()
                    .any(|component| matches!(component, std::path::Component::ParentDir))
                || matching_root.is_none()
            {
                return Err(error);
            }
            let root = matching_root.expect("checked managed root");
            let parent = path
                .parent()
                .ok_or_else(|| "Managed deletion path has no parent directory.".to_string())?;
            reject_symlink_components(parent, root)?;
            let canonical_root = root.canonicalize().map_err(|value| value.to_string())?;
            let canonical_parent = parent.canonicalize().map_err(|value| value.to_string())?;
            if !canonical_parent.starts_with(canonical_root) {
                return Err("The media path is outside Fruit Truck managed storage.".into());
            }
            Ok(None)
        }
        Err(error) => Err(error),
    }
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
    secure_export_directory(&downloads)?;
    let destination = unique_export_path(&downloads, &name);
    atomic_export_copy(&source, &destination)?;
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
    let (kind, mime_type, _) =
        inspect_media(&bytes[..bytes.len().min(MAX_SVG_HEADER_BYTES)], name)?;
    if kind != "image" {
        return Err("The managed asset is not an image.".into());
    }
    let bytes = if mime_type == "image/svg+xml" {
        sanitize_svg(&bytes)?
    } else {
        validate_image_dimensions(&bytes, name)?;
        bytes
    };
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
) -> Result<String, String> {
    let source = validate_managed_media_path(&app, Path::new(&path))?;
    if !source.starts_with(generated_directory(&app)?) {
        return Err("Only generated images may be normalized.".into());
    }
    let source_metadata = std::fs::metadata(&source).map_err(|error| error.to_string())?;
    if source_metadata.len() == 0 || source_metadata.len() > MAX_IMAGE_BYTES {
        return Err("A generated image exceeds the local safety limit.".into());
    }
    let source_name = source
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("generated.png");
    if source_name.to_ascii_lowercase().ends_with(".svg") {
        // SVG is preserved as a vector original. A raster resize would destroy the
        // provider output and is intentionally not attempted by this command.
        return Ok(source.to_string_lossy().into_owned());
    }
    let (source_width, source_height) = image::image_dimensions(&source)
        .map_err(|error| format!("Could not inspect generated image dimensions: {error}"))?;
    if source_width == 0
        || source_height == 0
        || source_width > MAX_IMAGE_DIMENSION
        || source_height > MAX_IMAGE_DIMENSION
        || u64::from(source_width).saturating_mul(u64::from(source_height)) > MAX_IMAGE_PIXELS
    {
        return Err("The generated image dimensions exceed the local safety limit.".into());
    }
    let image = image::open(&source)
        .map_err(|error| format!("Could not decode generated image: {error}"))?;
    let Some((width, height)) = requested_image_dimensions(
        image.width(),
        image.height(),
        resolution.as_deref(),
        aspect_ratio.as_deref(),
    ) else {
        return Ok(source.to_string_lossy().into_owned());
    };
    if width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION {
        return Err("Requested image dimensions exceed the 4K local output limit.".into());
    }
    let format = image::ImageFormat::from_path(&source).map_err(|error| error.to_string())?;
    let normalized = image.resize_to_fill(width, height, image::imageops::FilterType::Lanczos3);
    if u64::from(width).saturating_mul(u64::from(height)) > MAX_IMAGE_PIXELS {
        return Err("Requested image dimensions exceed the local safety limit.".into());
    }
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("png");
    let derived = unique_media_path(&generated_directory(&app)?, "derived", extension)?;
    let temporary = derived.with_file_name(format!(
        ".{}.part",
        derived.file_name().unwrap().to_string_lossy()
    ));
    let result = (|| {
        let file = create_private_file(&temporary)?;
        drop(file);
        normalized
            .save_with_format(&temporary, format)
            .map_err(|error| error.to_string())?;
        set_private_file_permissions(&temporary)?;
        let file = std::fs::File::open(&temporary).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        std::fs::rename(&temporary, &derived).map_err(|error| error.to_string())
    })();
    if let Err(error) = result {
        let _ = std::fs::remove_file(&temporary);
        return Err(error);
    }
    Ok(derived.to_string_lossy().into_owned())
}

#[cfg(unix)]
fn secure_directory(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(metadata) = std::fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() {
            return Err(format!("{} may not be a symlink.", path.display()));
        }
        if !metadata.is_dir() {
            return Err(format!("{} must be a directory.", path.display()));
        }
    }
    std::fs::create_dir_all(path).map_err(|error| error.to_string())?;
    let metadata = std::fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!("{} must be a private directory.", path.display()));
    }
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(not(unix))]
fn secure_directory(path: &Path) -> Result<(), String> {
    if let Ok(metadata) = std::fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() {
            return Err(format!("{} may not be a symlink.", path.display()));
        }
        if !metadata.is_dir() {
            return Err(format!("{} must be a directory.", path.display()));
        }
    }
    std::fs::create_dir_all(path).map_err(|error| error.to_string())
}

const MAX_API_KEY_BYTES: usize = 4 * 1024;

fn validate_api_key(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.len() < 12
        || value.len() > MAX_API_KEY_BYTES
        || !value.is_ascii()
        || value.chars().any(char::is_whitespace)
    {
        return Err("Enter a valid OpenRouter API key.".into());
    }
    Ok(value.to_string())
}

fn read_file_api_key(path: &Path) -> Result<Option<String>, String> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("The Fruit Truck credentials path must be a regular file.".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err("The Fruit Truck credentials file permissions are too broad.".into());
        }
    }
    if metadata.len() == 0 || metadata.len() > 16 * 1024 {
        return Err("The Fruit Truck credentials file is outside the safety limit.".into());
    }
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(path).map_err(|error| error.to_string())?;
    let credentials: Credentials = serde_json::from_str(&raw)
        .map_err(|_| "The Fruit Truck credentials file is not valid JSON.".to_string())?;
    if credentials.schema_version != 1 {
        return Err("The Fruit Truck credentials file is invalid.".into());
    }
    validate_api_key(&credentials.openrouter_api_key)
        .map(Some)
        .map_err(|_| "The Fruit Truck credentials file is invalid.".into())
}

fn write_file_api_key(path: &Path, value: &str) -> Result<(), String> {
    let value = validate_api_key(value)?;
    if std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err("The Fruit Truck credentials path may not be a symlink.".into());
    }
    let parent = path
        .parent()
        .ok_or("The Fruit Truck credentials path has no parent directory.")?;
    let temporary = loop {
        let sequence = MEDIA_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let candidate = parent.join(format!(
            ".credentials-{}-{sequence}.tmp",
            std::process::id()
        ));
        if !candidate.exists() {
            break candidate;
        }
    };
    let payload = Credentials {
        schema_version: 1,
        openrouter_api_key: value,
    };
    let bytes = serde_json::to_vec(&payload).map_err(|error| error.to_string())?;
    let write_result = (|| {
        let mut output = create_private_file(&temporary)?;
        output
            .write_all(&bytes)
            .map_err(|error| error.to_string())?;
        output.flush().map_err(|error| error.to_string())?;
        output.sync_all().map_err(|error| error.to_string())?;
        if std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
            return Err("The Fruit Truck credentials path may not be a symlink.".into());
        }
        std::fs::rename(&temporary, path).map_err(|error| error.to_string())?;
        #[cfg(unix)]
        if let Ok(directory) = std::fs::File::open(parent) {
            let _ = directory.sync_all();
        }
        Ok(())
    })();
    if let Err(error) = write_result {
        let _ = std::fs::remove_file(&temporary);
        return Err(error);
    }
    Ok(())
}

fn remove_file_api_key(path: &Path) -> Result<(), String> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("The Fruit Truck credentials path must be a regular file.".into());
    }
    std::fs::remove_file(path).map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
fn keychain_get_api_key() -> Result<Option<String>, String> {
    use security_framework::passwords::get_generic_password;
    use security_framework_sys::base::errSecItemNotFound;

    match get_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT) {
        Ok(bytes) => {
            let value = String::from_utf8(bytes)
                .map_err(|_| "The macOS Keychain entry is not valid UTF-8.".to_string())?;
            validate_api_key(&value)
                .map(Some)
                .map_err(|_| "The macOS Keychain entry is invalid.".into())
        }
        Err(error) if error.code() == errSecItemNotFound => Ok(None),
        Err(error) => Err(format!(
            "Could not read the OpenRouter key from macOS Keychain: {error}"
        )),
    }
}

#[cfg(target_os = "macos")]
fn keychain_set_api_key(value: &str) -> Result<(), String> {
    use security_framework::passwords::set_generic_password;

    set_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, value.as_bytes())
        .map_err(|error| format!("Could not save the OpenRouter key to macOS Keychain: {error}"))
}

#[cfg(target_os = "macos")]
fn keychain_remove_api_key() -> Result<(), String> {
    use security_framework::passwords::delete_generic_password;
    use security_framework_sys::base::errSecItemNotFound;

    match delete_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT) {
        Ok(()) => Ok(()),
        Err(error) if error.code() == errSecItemNotFound => Ok(()),
        Err(error) => Err(format!(
            "Could not remove the OpenRouter key from macOS Keychain: {error}"
        )),
    }
}

fn read_api_key(app: &tauri::AppHandle) -> Result<Option<StoredApiKey>, String> {
    let directory = credentials_directory(app)?;
    secure_directory(&directory)?;
    let path = directory.join(CREDENTIALS_FILE);
    #[cfg(target_os = "macos")]
    match keychain_get_api_key() {
        Ok(Some(value)) => {
            return Ok(Some(StoredApiKey {
                value,
                storage: CredentialStorage::Keychain,
            }));
        }
        Ok(None) => {}
        Err(error) => {
            // A protected fallback remains usable when the Keychain is
            // temporarily unavailable (for example while it is locked), but
            // do not hide a Keychain error when no fallback exists.
            if let Some(value) = read_file_api_key(&path)? {
                return Ok(Some(StoredApiKey {
                    value,
                    storage: CredentialStorage::File,
                }));
            }
            return Err(error);
        }
    }
    let Some(value) = read_file_api_key(&path)? else {
        return Ok(None);
    };
    #[cfg(target_os = "macos")]
    {
        // A legacy file is accepted only as a migration source. Once the
        // Keychain write succeeds, remove the plaintext copy and report the
        // Keychain as the source of truth.
        match keychain_set_api_key(&value) {
            Ok(()) => {
                if let Err(error) = remove_file_api_key(&path) {
                    eprintln!(
                        "Fruit Truck migrated the API key to Keychain but could not remove the legacy file: {error}"
                    );
                }
                return Ok(Some(StoredApiKey {
                    value,
                    storage: CredentialStorage::Keychain,
                }));
            }
            Err(error) => {
                eprintln!(
                    "Fruit Truck could not migrate the API key to Keychain; using the protected file fallback: {error}"
                );
            }
        }
    }
    Ok(Some(StoredApiKey {
        value,
        storage: CredentialStorage::File,
    }))
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
    let key = read_api_key(&app)?;
    let path = match key.as_ref().map(|value| value.storage) {
        #[cfg(target_os = "macos")]
        Some(CredentialStorage::Keychain) | None => KEYCHAIN_DISPLAY_PATH.to_string(),
        Some(CredentialStorage::File) => credentials_path(&app)?.to_string_lossy().into_owned(),
    };
    Ok(CredentialStatus {
        configured: key.is_some(),
        masked_key: key.as_ref().map(|value| mask_key(&value.value)),
        path,
    })
}

fn key_validation_state(status: reqwest::StatusCode) -> (&'static str, bool, Option<&'static str>) {
    if status.is_success() {
        ("connected", true, None)
    } else if status == reqwest::StatusCode::UNAUTHORIZED
        || status == reqwest::StatusCode::FORBIDDEN
    {
        (
            "unauthorized",
            false,
            Some("OpenRouter rejected this API key."),
        )
    } else if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        (
            "rate_limited",
            false,
            Some("OpenRouter rate-limited key validation."),
        )
    } else if status.is_server_error() {
        (
            "server_error",
            false,
            Some("OpenRouter could not validate the API key."),
        )
    } else {
        ("invalid", false, Some("OpenRouter rejected this API key."))
    }
}

/// Validate a candidate key against OpenRouter without persisting it. The
/// renderer can use this before calling `save_api_key`, so an invalid
/// replacement never destroys the current credential.
#[tauri::command]
async fn validate_api_key_candidate(api_key: String) -> Result<ApiKeyValidation, String> {
    let candidate = validate_api_key(&api_key)?;
    let _network_permit = network_semaphore()
        .acquire()
        .await
        .map_err(|_| "The native network bridge is unavailable.".to_string())?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|error| error.to_string())?;
    let url = openrouter_url("/key")?;
    let response = match client
        .get(url)
        .bearer_auth(candidate)
        .header("Accept", "application/json")
        .send()
        .await
    {
        Ok(response) => response,
        Err(_) => {
            return Ok(ApiKeyValidation {
                valid: false,
                state: "offline",
                status_code: None,
                message: Some("Could not reach OpenRouter."),
            })
        }
    };
    let status = response.status();
    let status_code = status.as_u16();
    // Consume only a bounded body so the connection can be reused while never
    // exposing provider diagnostics or candidate credentials to the renderer.
    let _ = read_bounded_response(response, 32 * 1024, "API key validation response").await;
    let (state, valid, message) = key_validation_state(status);
    Ok(ApiKeyValidation {
        valid,
        state,
        status_code: Some(status_code),
        message,
    })
}

#[tauri::command]
fn save_api_key(app: tauri::AppHandle, api_key: String) -> Result<CredentialStatus, String> {
    let value = validate_api_key(&api_key)?;
    let _lock = CREDENTIALS_LOCK
        .lock()
        .map_err(|_| "The credentials store is unavailable.".to_string())?;
    let directory = credentials_directory(&app)?;
    secure_directory(&directory)?;
    let path = directory.join(CREDENTIALS_FILE);
    #[cfg(target_os = "macos")]
    {
        if std::fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.file_type().is_symlink())
        {
            return Err("The Fruit Truck credentials path may not be a symlink.".into());
        }
        match keychain_set_api_key(&value) {
            Ok(()) => remove_file_api_key(&path)?,
            Err(error) => {
                eprintln!(
                    "Fruit Truck could not save to Keychain; using the protected file fallback: {error}"
                );
                write_file_api_key(&path, &value)?;
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    write_file_api_key(&path, &value)?;
    credential_status(app)
}

#[tauri::command]
fn remove_api_key(app: tauri::AppHandle) -> Result<CredentialStatus, String> {
    let _lock = CREDENTIALS_LOCK
        .lock()
        .map_err(|_| "The credentials store is unavailable.".to_string())?;
    let path = credentials_path(&app)?;
    #[cfg(target_os = "macos")]
    keychain_remove_api_key()?;
    remove_file_api_key(&path)?;
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
                let Some(model_id) = value.strip_suffix("/endpoints") else {
                    return false;
                };
                !model_id.is_empty()
                    && !model_id.contains('/')
                    && !model_id.to_ascii_lowercase().contains("%2e")
            });
    let allowed_path = matches!(
        normalized_path,
        "/images/models"
            | "/videos/models"
            | "/models"
            | "/key"
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

fn read_managed_media_for_request(path: &Path) -> Result<(Vec<u8>, String), String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("A managed request asset must be a regular file.".into());
    }
    if metadata.len() == 0 || metadata.len() > MAX_REQUEST_MEDIA_BYTES {
        return Err("A managed request asset exceeds the local safety limit.".into());
    }
    let mut input = std::fs::File::open(path).map_err(|error| error.to_string())?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    let copied = std::io::Read::by_ref(&mut input)
        .take(MAX_REQUEST_MEDIA_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if copied == 0 || copied as u64 > MAX_REQUEST_MEDIA_BYTES {
        return Err("A managed request asset exceeds the local safety limit.".into());
    }
    let name = path
        .file_name()
        .and_then(|item| item.to_str())
        .unwrap_or("media.png");
    let (_, mime_type, _) = inspect_media(&bytes[..bytes.len().min(MAX_SVG_HEADER_BYTES)], name)?;
    Ok((bytes, mime_type.into()))
}

fn hydrate_local_media_references_with_budget(
    app: &tauri::AppHandle,
    value: &mut Value,
    budget: &mut RequestMediaBudget,
) -> Result<(), String> {
    match value {
        Value::String(source) if source.starts_with(LOCAL_MEDIA_MARKER) => {
            let path = PathBuf::from(&source[LOCAL_MEDIA_MARKER.len()..]);
            let path = validate_managed_media_path(app, &path)?;
            let (bytes, mime_type) = read_managed_media_for_request(&path)?;
            budget.reserve(bytes.len() as u64)?;
            *source = format!(
                "data:{mime_type};base64,{}",
                base64::engine::general_purpose::STANDARD.encode(bytes),
            );
        }
        Value::Array(items) => {
            for item in items {
                hydrate_local_media_references_with_budget(app, item, budget)?;
            }
        }
        Value::Object(object) => {
            for item in object.values_mut() {
                hydrate_local_media_references_with_budget(app, item, budget)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn hydrate_local_media_references(app: &tauri::AppHandle, value: &mut Value) -> Result<(), String> {
    hydrate_local_media_references_with_budget(app, value, &mut RequestMediaBudget::new())
}

fn media_name_for_mime(mime_type: &str) -> &'static str {
    match mime_type {
        "image/svg+xml" => "result.svg",
        "image/jpeg" => "result.jpg",
        "image/jpg" => "result.jpg",
        "image/webp" => "result.webp",
        "image/gif" => "result.gif",
        _ => "result.png",
    }
}

fn network_semaphore() -> &'static Arc<tokio::sync::Semaphore> {
    NETWORK_SEMAPHORE.get_or_init(|| Arc::new(tokio::sync::Semaphore::new(MAX_NETWORK_CONCURRENCY)))
}

fn openrouter_cancellations() -> &'static Mutex<HashMap<String, tokio::sync::watch::Sender<bool>>> {
    OPENROUTER_CANCELLATIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn valid_request_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

#[tauri::command]
fn cancel_openrouter_request(request_id: String) -> Result<bool, String> {
    if !valid_request_id(&request_id) {
        return Err("OpenRouter request ID is invalid.".into());
    }
    let sender = openrouter_cancellations()
        .lock()
        .map_err(|_| "OpenRouter cancellation registry is unavailable.".to_string())?
        .get(&request_id)
        .cloned();
    match sender {
        Some(sender) => {
            let _ = sender.send(true);
            Ok(true)
        }
        None => Ok(false),
    }
}

fn resolve_public_addresses_sync(
    host: &str,
    port: u16,
) -> Result<Vec<std::net::SocketAddr>, String> {
    let addresses = if let Ok(address) = host.parse::<std::net::IpAddr>() {
        vec![std::net::SocketAddr::new(address, port)]
    } else {
        (host, port)
            .to_socket_addrs()
            .map_err(|error| format!("Could not resolve generated image host: {error}"))?
            .collect::<Vec<_>>()
    };
    validate_public_addresses(addresses)
}

fn validate_public_addresses(
    addresses: Vec<std::net::SocketAddr>,
) -> Result<Vec<std::net::SocketAddr>, String> {
    if addresses.is_empty() {
        return Err("Generated image host has no usable addresses.".into());
    }
    let mut seen = HashSet::new();
    let mut unique = Vec::with_capacity(addresses.len());
    for address in addresses {
        if is_blocked_ip_address(address.ip()) {
            return Err("Generated image host resolves to a private or reserved network.".into());
        }
        if seen.insert(address.ip()) {
            unique.push(address);
        }
    }
    if unique.is_empty() {
        return Err("Generated image host has no public addresses.".into());
    }
    Ok(unique)
}

fn validate_remote_image_redirect(
    current: &reqwest::Url,
    location: &str,
) -> Result<reqwest::Url, String> {
    let next = current
        .join(location)
        .map_err(|_| "Generated image redirect URL is invalid.".to_string())?;
    validate_remote_image_url(next.as_str())
}

async fn resolve_public_addresses(url: &reqwest::Url) -> Result<Vec<std::net::SocketAddr>, String> {
    let host = url
        .host_str()
        .ok_or("The image URL has no host.")?
        .to_string();
    let port = url
        .port_or_known_default()
        .ok_or("The image URL has no valid port.")?;
    let lookup =
        tauri::async_runtime::spawn_blocking(move || resolve_public_addresses_sync(&host, port));
    tokio::time::timeout(std::time::Duration::from_secs(DNS_TIMEOUT_SECONDS), lookup)
        .await
        .map_err(|_| "Generated image DNS lookup timed out.".to_string())?
        .map_err(|error| format!("Generated image DNS lookup failed: {error}"))?
}

fn public_http_client(
    host: &str,
    addresses: &[std::net::SocketAddr],
) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(45))
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .resolve_to_addrs(host, addresses)
        .build()
        .map_err(|error| error.to_string())
}

async fn stream_response_to_temp(
    response: reqwest::Response,
    root: &Path,
    limit: u64,
    label: &str,
) -> Result<BoundedResponseFile, String> {
    stream_response_to_temp_controlled(response, root, limit, label, None, None, None, false).await
}

fn emit_image_sse_progress(app: &tauri::AppHandle, request_id: &str, line: &[u8]) {
    let Ok(line) = std::str::from_utf8(line) else {
        return;
    };
    let Some(data) = line.trim().strip_prefix("data:").map(str::trim) else {
        return;
    };
    if data.is_empty() || data == "[DONE]" {
        return;
    }
    let Ok(event) = serde_json::from_str::<Value>(data) else {
        return;
    };
    let Some(event_type) = event.get("type").and_then(Value::as_str) else {
        return;
    };
    let stage = match event_type {
        "image_generation.partial_image" => "partial_image",
        "image_generation.completed" => "completed",
        "image_generation.failed" | "error" => "failed",
        _ => return,
    };
    let _ = app.emit(
        "openrouter-request-progress",
        OpenRouterRequestProgress {
            request_id: request_id.to_string(),
            stage,
            partial_image_index: event.get("partial_image_index").and_then(Value::as_u64),
        },
    );
}

#[allow(clippy::too_many_arguments)]
async fn stream_response_to_temp_controlled(
    mut response: reqwest::Response,
    root: &Path,
    limit: u64,
    label: &str,
    app: Option<&tauri::AppHandle>,
    request_id: Option<&str>,
    mut cancellation: Option<&mut tokio::sync::watch::Receiver<bool>>,
    inspect_image_sse: bool,
) -> Result<BoundedResponseFile, String> {
    if response
        .content_length()
        .is_some_and(|length| length > limit)
    {
        return Err(format!("{label} exceeds the local safety limit."));
    }
    let (temporary, mut output) = write_temp_file(root, "response", "tmp")?;
    let mut size = 0u64;
    let mut event_buffer = Vec::new();
    loop {
        let chunk = if let Some(receiver) = cancellation.as_deref_mut() {
            tokio::select! {
                changed = receiver.changed() => {
                    if changed.is_ok() && *receiver.borrow() {
                        output.flush().ok();
                        output.sync_all().ok();
                        return Err(format!(
                            "Local response tracking stopped. The paid request may still complete and bill (partial response retained at {}).",
                            temporary.display()
                        ));
                    }
                    continue;
                }
                result = response.chunk() => result
            }
        } else {
            response.chunk().await
        }
        .map_err(|error| format!("Could not read {label}: {error}"))?;
        let Some(chunk) = chunk else {
            break;
        };
        size = size
            .checked_add(chunk.len() as u64)
            .ok_or_else(|| format!("{label} exceeds the local safety limit."))?;
        if size > limit {
            output.flush().ok();
            output.sync_all().ok();
            return Err(format!(
                "{label} exceeds the local safety limit (partial response retained at {}).",
                temporary.display()
            ));
        }
        output
            .write_all(&chunk)
            .map_err(|error| format!("Could not store {label}: {error}"))?;
        if inspect_image_sse {
            event_buffer.extend_from_slice(&chunk);
            while let Some(line_end) = event_buffer.iter().position(|byte| *byte == b'\n') {
                let line = event_buffer.drain(..=line_end).collect::<Vec<_>>();
                if let (Some(app), Some(request_id)) = (app, request_id) {
                    emit_image_sse_progress(app, request_id, &line);
                }
            }
        }
    }
    if inspect_image_sse && !event_buffer.is_empty() {
        if let (Some(app), Some(request_id)) = (app, request_id) {
            emit_image_sse_progress(app, request_id, &event_buffer);
        }
    }
    output.flush().map_err(|error| error.to_string())?;
    output.sync_all().map_err(|error| error.to_string())?;
    Ok(BoundedResponseFile { path: temporary })
}

async fn download_public_image(
    url: &str,
    root: &Path,
) -> Result<(BoundedResponseFile, String), String> {
    let mut current = validate_remote_image_url(url)?;
    for redirect_count in 0..=5 {
        let addresses = resolve_public_addresses(&current).await?;
        let host = current
            .host_str()
            .ok_or("The image URL has no host.")?
            .to_string();
        let client = public_http_client(&host, &addresses)?;
        let response = client
            .get(current.clone())
            .send()
            .await
            .map_err(|error| format!("Could not download the generated image: {error}"))?;
        if response.status().is_redirection() {
            if redirect_count == 5 {
                return Err("Generated image URL has too many redirects.".into());
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or("Generated image redirect has no valid location.")?;
            current = validate_remote_image_redirect(&current, location)?;
            continue;
        }
        if !response.status().is_success() {
            return Err(format!(
                "Generated image download failed with HTTP {}.",
                response.status().as_u16()
            ));
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
        let file =
            stream_response_to_temp(response, root, MAX_IMAGE_BYTES, "The generated image").await?;
        return Ok((file, mime_type));
    }
    Err("Generated image URL could not be resolved safely.".into())
}

fn mark_materialization_error(object: &mut serde_json::Map<String, Value>, error: String) {
    object.remove("b64_json");
    object.remove("url");
    object.insert(
        "_fruit_truck_materialization_error".into(),
        Value::String(error),
    );
}

fn materialize_b64_image_at_root(
    root: &Path,
    object: &mut serde_json::Map<String, Value>,
) -> Result<(), String> {
    let encoded = match object.remove("b64_json") {
        Some(Value::String(value)) => value,
        Some(_) => return Err("OpenRouter returned an invalid image base64 value.".into()),
        None => return Ok(()),
    };
    if encoded.len() as u64 > (MAX_IMAGE_BYTES * 4 / 3) + 8 {
        return Err("The generated image exceeds the 30 MB local safety limit.".into());
    }
    let declared_mime = object
        .get("media_type")
        .and_then(Value::as_str)
        .unwrap_or("image/png")
        .to_string();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| "OpenRouter returned invalid image base64.")?;
    let materialized =
        write_managed_media(root, media_name_for_mime(&declared_mime), &bytes, "image")?;
    object.insert("local_path".into(), Value::String(materialized.local_path));
    object.insert("media_type".into(), Value::String(materialized.mime_type));
    object.insert("byte_size".into(), Value::from(materialized.byte_size));
    Ok(())
}

struct ImageDataSeed<'a> {
    root: &'a Path,
}

impl<'de> DeserializeSeed<'de> for ImageDataSeed<'_> {
    type Value = Vec<Value>;

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        deserializer.deserialize_seq(ImageDataVisitor { root: self.root })
    }
}

struct ImageDataVisitor<'a> {
    root: &'a Path,
}

impl<'de> Visitor<'de> for ImageDataVisitor<'_> {
    type Value = Vec<Value>;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("an OpenRouter image data array")
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let mut values = Vec::new();
        while let Some(mut item) = sequence.next_element::<Value>()? {
            if let Some(object) = item.as_object_mut() {
                if object.contains_key("b64_json") {
                    if let Err(error) = materialize_b64_image_at_root(self.root, object) {
                        mark_materialization_error(object, error);
                    }
                }
            }
            values.push(item);
        }
        Ok(values)
    }
}

struct OpenRouterResponseSeed<'a> {
    root: &'a Path,
}

impl<'de> DeserializeSeed<'de> for OpenRouterResponseSeed<'_> {
    type Value = Value;

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        deserializer.deserialize_map(OpenRouterResponseVisitor { root: self.root })
    }
}

struct OpenRouterResponseVisitor<'a> {
    root: &'a Path,
}

impl<'de> Visitor<'de> for OpenRouterResponseVisitor<'_> {
    type Value = Value;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("an OpenRouter response object")
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut object = serde_json::Map::new();
        while let Some(key) = map.next_key::<String>()? {
            if key == "data" {
                let values = map.next_value_seed(ImageDataSeed { root: self.root })?;
                object.insert(key, Value::Array(values));
            } else {
                let value = map.next_value::<Value>()?;
                object.insert(key, value);
            }
        }
        Ok(Value::Object(object))
    }
}

fn parse_openrouter_image_response(path: &Path, root: &Path) -> Result<Value, String> {
    let file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    let mut deserializer = serde_json::Deserializer::from_reader(file);
    let payload = OpenRouterResponseSeed { root }
        .deserialize(&mut deserializer)
        .map_err(|error| format!("OpenRouter returned invalid JSON: {error}"))?;
    deserializer
        .end()
        .map_err(|error| format!("OpenRouter returned invalid trailing JSON: {error}"))?;
    Ok(payload)
}

fn parse_openrouter_image_sse_response(path: &Path, root: &Path) -> Result<Value, String> {
    let file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    let mut results = Vec::new();
    let mut usage = None;
    let mut created = None;
    for line in std::io::BufReader::new(file).lines() {
        let line = line.map_err(|error| format!("Could not read OpenRouter SSE: {error}"))?;
        let Some(data) = line.trim().strip_prefix("data:").map(str::trim) else {
            continue;
        };
        if data.is_empty() || data == "[DONE]" {
            continue;
        }
        let event: Value = serde_json::from_str(data)
            .map_err(|error| format!("OpenRouter returned invalid SSE JSON: {error}"))?;
        if let Some(error) = event.get("error") {
            return Err(format!("OpenRouter image stream failed: {error}"));
        }
        match event.get("type").and_then(Value::as_str) {
            Some("image_generation.partial_image") => {}
            Some("image_generation.completed") => {
                let mut object = event
                    .as_object()
                    .cloned()
                    .ok_or("OpenRouter returned an invalid completed image event.")?;
                object.remove("type");
                object.remove("partial_image_index");
                if let Some(value) = object.remove("usage") {
                    usage = Some(value);
                }
                if let Some(value) = object.remove("created") {
                    created = Some(value);
                }
                if object.contains_key("b64_json") {
                    if let Err(error) = materialize_b64_image_at_root(root, &mut object) {
                        mark_materialization_error(&mut object, error);
                    }
                }
                results.push(Value::Object(object));
            }
            Some("image_generation.failed") | Some("error") => {
                return Err(format!("OpenRouter image stream failed: {event}"));
            }
            _ => {}
        }
    }
    if results.is_empty() {
        return Err("OpenRouter image stream ended without a completed image.".into());
    }
    let mut payload = serde_json::Map::new();
    payload.insert("data".into(), Value::Array(results));
    if let Some(usage) = usage {
        payload.insert("usage".into(), usage);
    }
    if let Some(created) = created {
        payload.insert("created".into(), created);
    }
    Ok(Value::Object(payload))
}

fn collect_materialization_errors(payload: &Value) -> Vec<String> {
    payload
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            item.get("_fruit_truck_materialization_error")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect()
}

async fn materialize_openrouter_image_urls(app: &tauri::AppHandle, payload: &mut Value) {
    let Some(items) = payload.get_mut("data").and_then(Value::as_array_mut) else {
        return;
    };
    let root = match generated_directory(app) {
        Ok(root) => root,
        Err(error) => {
            for item in items {
                if let Some(object) = item.as_object_mut() {
                    if object.contains_key("url") {
                        mark_materialization_error(object, error.clone());
                    }
                }
            }
            return;
        }
    };
    for item in items {
        let Some(object) = item.as_object_mut() else {
            continue;
        };
        let Some(url) = object.remove("url") else {
            continue;
        };
        let Some(url) = url.as_str() else {
            mark_materialization_error(object, "OpenRouter returned an invalid image URL.".into());
            continue;
        };
        let declared_mime = object
            .get("media_type")
            .and_then(Value::as_str)
            .unwrap_or("image/png")
            .to_string();
        match download_public_image(url, &root).await {
            Ok((file, mime_type)) => {
                let materialized = write_managed_media_from_temp(
                    &root,
                    media_name_for_mime(&mime_type),
                    &file.path,
                    "image",
                );
                match materialized {
                    Ok(materialized) => {
                        object.insert("local_path".into(), Value::String(materialized.local_path));
                        object.insert("media_type".into(), Value::String(materialized.mime_type));
                        object.insert("byte_size".into(), Value::from(materialized.byte_size));
                    }
                    Err(error) => {
                        let _ = std::fs::remove_file(&file.path);
                        mark_materialization_error(object, error);
                    }
                }
            }
            Err(error) => mark_materialization_error(object, error),
        }
        if object.get("media_type").is_none() {
            object.insert("media_type".into(), Value::String(declared_mime));
        }
    }
}

fn openrouter_response_limit(path: &str, body: Option<&Value>) -> u64 {
    if path != "/images" {
        return MAX_OPENROUTER_JSON_BYTES;
    }
    let count = body
        .and_then(|value| value.get("n"))
        .and_then(Value::as_u64)
        .unwrap_or(1)
        .clamp(1, 10);
    let per_image = (MAX_IMAGE_BYTES.saturating_mul(4) / 3).saturating_add(2 * 1024 * 1024);
    MAX_OPENROUTER_JSON_BYTES
        .max(
            per_image
                .saturating_mul(count)
                .saturating_add(4 * 1024 * 1024),
        )
        .min(MAX_OPENROUTER_IMAGE_RESPONSE_BYTES)
}

#[tauri::command]
async fn openrouter_request(
    app: tauri::AppHandle,
    method: String,
    path: String,
    body: Option<Value>,
    request_id: Option<String>,
) -> Result<Value, String> {
    let mut cancellation = if let Some(request_id) = request_id.as_deref() {
        if !valid_request_id(request_id) {
            return Err("OpenRouter request ID is invalid.".into());
        }
        let (sender, receiver) = tokio::sync::watch::channel(false);
        let mut registry = openrouter_cancellations()
            .lock()
            .map_err(|_| "OpenRouter cancellation registry is unavailable.".to_string())?;
        if registry.contains_key(request_id) {
            return Err("An OpenRouter request with this ID is already active.".into());
        }
        registry.insert(request_id.to_string(), sender);
        Some(receiver)
    } else {
        None
    };
    let result = openrouter_request_inner(
        app,
        method,
        path,
        body,
        request_id.as_deref(),
        cancellation.as_mut(),
    )
    .await;
    if let Some(request_id) = request_id.as_deref() {
        if let Ok(mut registry) = openrouter_cancellations().lock() {
            registry.remove(request_id);
        }
    }
    result
}

async fn openrouter_request_inner(
    app: tauri::AppHandle,
    method: String,
    path: String,
    body: Option<Value>,
    request_id: Option<&str>,
    mut cancellation: Option<&mut tokio::sync::watch::Receiver<bool>>,
) -> Result<Value, String> {
    if !matches!(method.as_str(), "GET" | "POST") {
        return Err("Unsupported HTTP method.".into());
    }
    let url = openrouter_url(&path)?;
    let api_key = read_api_key(&app)?
        .map(|stored| stored.value)
        .ok_or("Add an OpenRouter API key in Settings first.")?;
    let _network_permit = network_semaphore()
        .acquire()
        .await
        .map_err(|_| "The native network bridge is unavailable.".to_string())?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(
            MEDIA_RESPONSE_TIMEOUT_SECONDS,
        ))
        .build()
        .map_err(|error| error.to_string())?;
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
            let send = if let Some(payload) = hydrated_body.as_ref() {
                request.json(payload).send()
            } else {
                request.send()
            };
            let response = if let Some(receiver) = cancellation.as_deref_mut() {
                if *receiver.borrow() {
                    return Err(
                        "Local request tracking stopped. A paid request may still complete and bill."
                            .into(),
                    );
                }
                tokio::select! {
                    changed = receiver.changed() => {
                        let _ = changed;
                        return Err(
                            "Local request tracking stopped. A paid request may still complete and bill."
                                .into(),
                        );
                    }
                    result = send => result
                }
            } else {
                send.await
            }
            .map_err(|error| {
                if method == "POST" {
                    "Could not confirm OpenRouter paid request delivery; it may have been accepted. Do not retry automatically."
                        .to_string()
                } else {
                    format!("Could not reach OpenRouter: {error}")
                }
            })?;
            if response.status().is_success() {
                break response;
            }
            let retryable = method == "GET" && matches!(response.status().as_u16(), 429 | 503);
            if !retryable || retry >= 3 {
                let error = response_error(response).await;
                if method == "POST" {
                    return Err(format!(
                        "{error} The paid request may have been accepted; it was not retried automatically."
                    ));
                }
                return Err(error);
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
    let is_image_sse = path == "/images"
        && response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.to_ascii_lowercase().contains("text/event-stream"));
    if let Some(request_id) = request_id {
        let _ = app.emit(
            "openrouter-request-progress",
            OpenRouterRequestProgress {
                request_id: request_id.to_string(),
                stage: "accepted",
                partial_image_index: None,
            },
        );
    }
    let response_root = generated_directory(&app)?;
    let response_limit = openrouter_response_limit(&path, hydrated_body.as_ref());
    let response_file = stream_response_to_temp_controlled(
        response,
        &response_root,
        response_limit,
        "OpenRouter response",
        Some(&app),
        request_id,
        cancellation,
        is_image_sse,
    )
    .await?;
    let response_path = response_file.path;
    let parsed = if path == "/images" {
        if is_image_sse {
            parse_openrouter_image_sse_response(&response_path, &response_root)
        } else {
            parse_openrouter_image_response(&response_path, &response_root)
        }
    } else {
        let file = std::fs::File::open(&response_path).map_err(|error| error.to_string())?;
        let mut deserializer = serde_json::Deserializer::from_reader(file);
        let payload = Value::deserialize(&mut deserializer)
            .map_err(|error| format!("OpenRouter returned invalid JSON: {error}"))?;
        deserializer
            .end()
            .map_err(|error| format!("OpenRouter returned invalid trailing JSON: {error}"))?;
        Ok(payload)
    };
    let mut payload = match parsed {
        Ok(payload) => payload,
        Err(error) => {
            return Err(format!(
                "{error} (recovery response retained at {}).",
                response_path.display()
            ));
        }
    };
    if path == "/images" {
        materialize_openrouter_image_urls(&app, &mut payload).await;
        let errors = collect_materialization_errors(&payload);
        if !errors.is_empty() {
            payload["_fruit_truck_recovery_path"] =
                Value::String(response_path.to_string_lossy().into_owned());
            payload["_fruit_truck_materialization_errors"] =
                Value::Array(errors.into_iter().map(Value::String).collect());
        } else {
            let _ = std::fs::remove_file(&response_path);
        }
    } else {
        let _ = std::fs::remove_file(&response_path);
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
            let octets = value.octets();
            value.is_private()
                || value.is_loopback()
                || value.is_link_local()
                || value.is_broadcast()
                || value.is_unspecified()
                || value.is_multicast()
                || octets[0] == 0
                || (octets[0] == 100 && (64..=127).contains(&octets[1]))
                || (octets[0] == 192 && octets[1] == 0 && octets[2] == 0)
                || (octets[0] == 192 && octets[1] == 0 && octets[2] == 2)
                || (octets[0] == 192 && octets[1] == 88 && octets[2] == 99)
                || (octets[0] == 198 && octets[1] == 18)
                || (octets[0] == 198 && octets[1] == 19)
                || (octets[0] == 198 && octets[1] == 51 && octets[2] == 100)
                || (octets[0] == 203 && octets[1] == 0 && octets[2] == 113)
                || octets[0] >= 240
        }
        std::net::IpAddr::V6(value) => {
            let segments = value.segments();
            value.is_loopback()
                || value.is_unspecified()
                || value.is_multicast()
                || (segments[0] & 0xfe00) == 0xfc00
                || (segments[0] & 0xffc0) == 0xfe80
                || (segments[0] == 0x2001 && segments[1] == 0x0db8)
                || (segments[0] & 0xffc0) == 0xfec0
                || value
                    .to_ipv4_mapped()
                    .is_some_and(|mapped| is_blocked_ip_address(std::net::IpAddr::V4(mapped)))
        }
    }
}

fn validate_remote_image_url(value: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(value).map_err(|_| "The image URL is invalid.".to_string())?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return Err("Only public HTTPS image URLs are supported.".into());
    }
    let host = url.host_str().ok_or("The image URL has no host.")?;
    if host.eq_ignore_ascii_case("localhost") || host.ends_with(".localhost") {
        return Err("Local image URLs are not supported.".into());
    }
    if host.eq_ignore_ascii_case("local")
        || host.ends_with(".local")
        || host.eq_ignore_ascii_case("internal")
        || host.ends_with(".internal")
    {
        return Err("Private network image URLs are not supported.".into());
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
    if response
        .content_length()
        .is_some_and(|length| length > limit)
    {
        return Err(format!("{label} exceeds the local safety limit."));
    }
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
    let api_key = read_api_key(&app)?
        .map(|stored| stored.value)
        .ok_or("Add an OpenRouter API key in Settings first.")?;
    let _network_permit = network_semaphore()
        .acquire()
        .await
        .map_err(|_| "The native network bridge is unavailable.".to_string())?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(
            MEDIA_RESPONSE_TIMEOUT_SECONDS,
        ))
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
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
        .and_then(|value| value.split(';').next())
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if !content_type.starts_with("video/") {
        return Err("Generated video content has an invalid media type.".into());
    }
    let directory = generated_directory(&app)?;
    let extension = if content_type.contains("webm") {
        "webm"
    } else if content_type.contains("quicktime") {
        "mov"
    } else {
        "mp4"
    };
    let temporary =
        stream_response_to_temp(response, &directory, MAX_VIDEO_BYTES, "Generated video").await?;
    let managed = match write_managed_media_from_temp(
        &directory,
        &format!("{job_id}.{extension}"),
        &temporary.path,
        "video",
    ) {
        Ok(managed) => managed,
        Err(error) => {
            let _ = std::fs::remove_file(&temporary.path);
            return Err(error);
        }
    };
    if let Err(error) = inspect_managed_asset(app.clone(), managed.local_path.clone()).await {
        let _ = std::fs::remove_file(&managed.local_path);
        return Err(format!(
            "Generated video metadata is outside the safety policy: {error}"
        ));
    }
    Ok(CachedMedia {
        path: managed.local_path,
    })
}

#[cfg(all(target_os = "macos", debug_assertions))]
const MACOS_MEDIA_SANDBOX_POLICY: &str = r#"
  (version 1)
  (deny default)
  (import "system.sb")
  (allow process-exec*)
  (allow file-read*
    (literal (param "INPUT"))
    (literal (param "EXECUTABLE"))
    (subpath "/opt/homebrew")
    (subpath "/usr/local"))
  (deny network*)
  (deny file-write*)
"#;

#[cfg(all(target_os = "macos", not(debug_assertions)))]
const MACOS_MEDIA_SANDBOX_POLICY: &str = r#"
  (version 1)
  (deny default)
  (import "system.sb")
  (allow process-exec*)
  (allow file-read*
    (literal (param "INPUT"))
    (literal (param "EXECUTABLE")))
  (deny network*)
  (deny file-write*)
"#;

#[cfg(all(target_os = "macos", debug_assertions))]
fn development_media_executable(name: &str) -> Result<PathBuf, String> {
    let path = std::env::var_os("PATH").ok_or("PATH is unavailable for the media tool.")?;
    std::env::split_paths(&path)
        .map(|directory| directory.join(name))
        .find(|candidate| candidate.is_file())
        .ok_or_else(|| format!("The {name} executable is unavailable on PATH."))?
        .canonicalize()
        .map_err(|error| format!("Could not resolve the {name} executable: {error}"))
}

#[cfg(all(target_os = "macos", not(debug_assertions)))]
fn bundled_media_executable(name: &str) -> Result<PathBuf, String> {
    let executable = std::env::current_exe()
        .map_err(|error| format!("Could not locate the app executable: {error}"))?;
    executable
        .parent()
        .ok_or("The app executable has no parent directory.")?
        .join(name)
        .canonicalize()
        .map_err(|error| format!("The bundled {name} executable is unavailable: {error}"))
}

#[cfg(target_os = "macos")]
fn media_command(app: &tauri::AppHandle, name: &str, input: &Path) -> Result<ShellCommand, String> {
    #[cfg(debug_assertions)]
    let executable = development_media_executable(name)?;
    #[cfg(not(debug_assertions))]
    let executable = bundled_media_executable(name)?;
    Ok(app
        .shell()
        .command("/usr/bin/sandbox-exec")
        .arg("-D")
        .arg(format!("INPUT={}", input.display()))
        .arg("-D")
        .arg(format!("EXECUTABLE={}", executable.display()))
        .arg("-p")
        .arg(MACOS_MEDIA_SANDBOX_POLICY)
        .arg(executable))
}

#[cfg(not(target_os = "macos"))]
fn media_command(
    app: &tauri::AppHandle,
    name: &str,
    _input: &Path,
) -> Result<ShellCommand, String> {
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
    let (mut events, child) = command
        .spawn()
        .map_err(|error| format!("Could not launch bundled media tool: {error}"))?;
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut exit_code = None;
    let timeout = std::time::Duration::from_secs(FFPROBE_TIMEOUT_SECONDS);
    let started = std::time::Instant::now();
    loop {
        let remaining = timeout.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            let _ = child.kill();
            return Err("FFprobe timed out while inspecting the managed asset.".into());
        }
        let event = match tokio::time::timeout(remaining, events.recv()).await {
            Ok(event) => event,
            Err(_) => {
                let _ = child.kill();
                return Err("FFprobe timed out while inspecting the managed asset.".into());
            }
        };
        let Some(event) = event else {
            break;
        };
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
    if value.len() > MAX_ERROR_BYTES * 16 {
        return Err("FFprobe metadata exceeds the local safety limit.".into());
    }
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
    let width = video
        .and_then(|stream| stream.get("width"))
        .and_then(Value::as_u64)
        .and_then(|number| u32::try_from(number).ok());
    let height = video
        .and_then(|stream| stream.get("height"))
        .and_then(Value::as_u64)
        .and_then(|number| u32::try_from(number).ok());
    if width.is_some_and(|value| value == 0 || value > MAX_IMAGE_DIMENSION)
        || height.is_some_and(|value| value == 0 || value > MAX_IMAGE_DIMENSION)
        || width.zip(height).is_some_and(|(width, height)| {
            u64::from(width).saturating_mul(u64::from(height)) > MAX_IMAGE_PIXELS
        })
    {
        return Err("Managed video dimensions exceed the local safety limit.".into());
    }
    let duration = json_f64(
        payload
            .get("format")
            .and_then(|format| format.get("duration")),
    );
    if duration.is_some_and(|value| value > MAX_MEDIA_DURATION_SECONDS) {
        return Err("Managed media duration exceeds the local safety limit.".into());
    }
    let fps = video.and_then(|stream| parse_frame_rate(stream.get("avg_frame_rate")));
    if fps.is_some_and(|value| value > MAX_MEDIA_FPS) {
        return Err("Managed video frame rate exceeds the local safety limit.".into());
    }
    Ok(ManagedAssetMetadata {
        width,
        height,
        duration,
        fps,
        codec,
    })
}

#[tauri::command]
async fn inspect_managed_asset(
    app: tauri::AppHandle,
    path: String,
) -> Result<ManagedAssetMetadata, String> {
    let canonical = validate_managed_media_path(&app, Path::new(&path))?;
    let metadata = std::fs::symlink_metadata(&canonical).map_err(|error| error.to_string())?;
    if metadata.len() == 0 || metadata.len() > MAX_VIDEO_BYTES {
        return Err("The managed asset exceeds the local safety limit.".into());
    }
    let mut input = std::fs::File::open(&canonical).map_err(|error| error.to_string())?;
    let mut header = vec![0u8; MAX_SVG_HEADER_BYTES];
    let read = input.read(&mut header).map_err(|error| error.to_string())?;
    let name = canonical
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("managed-media");
    let (kind, _mime_type, _extension) = inspect_media(&header[..read], name)?;
    let limit = match kind {
        "image" => MAX_IMAGE_BYTES,
        "audio" => MAX_AUDIO_BYTES,
        _ => MAX_VIDEO_BYTES,
    };
    if metadata.len() > limit {
        return Err("The managed asset exceeds the local safety limit.".into());
    }
    let command = media_command(&app, "ffprobe", &canonical)?
        .args([
            "-v",
            "error",
            "-threads",
            "1",
            "-probesize",
            "16777216",
            "-analyzeduration",
            "10000000",
            "-max_alloc",
            "67108864",
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

fn scan_managed_root(root: &Path, results: &mut Vec<ManagedAssetFile>) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(root).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!("{} must be a private directory.", root.display()));
    }
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in std::fs::read_dir(&directory).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let path = entry.path();
            let metadata = std::fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
            if metadata.file_type().is_symlink() {
                continue;
            }
            if metadata.is_dir() {
                pending.push(path);
                continue;
            }
            if !metadata.is_file() || metadata.len() == 0 {
                continue;
            }
            let name = path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or_default();
            if name.starts_with('.') || name.ends_with(".part") || name.ends_with(".tmp") {
                continue;
            }
            let mut input = std::fs::File::open(&path).map_err(|error| error.to_string())?;
            let mut header = vec![0u8; MAX_SVG_HEADER_BYTES];
            let read = input.read(&mut header).map_err(|error| error.to_string())?;
            let Ok((kind, mime_type, _extension)) = inspect_media(&header[..read], name) else {
                continue;
            };
            let limit = if kind == "video" {
                MAX_VIDEO_BYTES
            } else if kind == "audio" {
                MAX_AUDIO_BYTES
            } else {
                MAX_IMAGE_BYTES
            };
            if metadata.len() > limit {
                continue;
            }
            if kind == "image" {
                input.rewind().map_err(|error| error.to_string())?;
                let mut bytes = Vec::with_capacity(metadata.len() as usize);
                input
                    .take(limit + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|error| error.to_string())?;
                if bytes.len() as u64 > limit {
                    continue;
                }
                if mime_type == "image/svg+xml" {
                    if sanitize_svg(&bytes).is_err() {
                        continue;
                    }
                } else if validate_image_dimensions(&bytes, name).is_err() {
                    continue;
                }
            }
            results.push(ManagedAssetFile {
                name: name.to_string(),
                kind: kind.into(),
                mime_type: mime_type.into(),
                local_path: path.to_string_lossy().into_owned(),
                byte_size: metadata.len(),
            });
        }
    }
    Ok(())
}

#[tauri::command]
fn scan_managed_assets(app: tauri::AppHandle) -> Result<Vec<ManagedAssetFile>, String> {
    let roots = managed_roots(&app)?;
    for root in &roots {
        secure_directory(root)?;
    }
    let mut results = Vec::new();
    for root in roots {
        scan_managed_root(&root, &mut results)?;
    }
    Ok(results)
}

#[tauri::command]
fn save_workspace_state(
    app: tauri::AppHandle,
    payload: Value,
) -> Result<workspace_storage::StorageStatus, String> {
    let _lock = WORKSPACE_STORAGE_LOCK
        .lock()
        .map_err(|_| "The workspace store is unavailable.".to_string())?;
    workspace_storage::save(&credentials_directory(&app)?, payload)
}

#[tauri::command]
fn load_workspace_state(
    app: tauri::AppHandle,
) -> Result<Option<workspace_storage::LoadedWorkspace>, String> {
    let _lock = WORKSPACE_STORAGE_LOCK
        .lock()
        .map_err(|_| "The workspace store is unavailable.".to_string())?;
    workspace_storage::load(&credentials_directory(&app)?)
}

#[tauri::command]
fn reconcile_workspace_state(
    app: tauri::AppHandle,
) -> Result<Option<workspace_storage::LoadedWorkspace>, String> {
    let _lock = WORKSPACE_STORAGE_LOCK
        .lock()
        .map_err(|_| "The workspace store is unavailable.".to_string())?;
    workspace_storage::reconcile(&credentials_directory(&app)?)
}

#[tauri::command]
fn import_workspace_state(
    app: tauri::AppHandle,
    path: String,
) -> Result<workspace_storage::LoadedWorkspace, String> {
    let _lock = WORKSPACE_STORAGE_LOCK
        .lock()
        .map_err(|_| "The workspace store is unavailable.".to_string())?;
    let source = PathBuf::from(path);
    let _ = credentials_directory(&app)?;
    workspace_storage::import_file(&source)
}

#[tauri::command]
fn export_workspace_state(
    app: tauri::AppHandle,
    payload: Value,
    name: Option<String>,
) -> Result<String, String> {
    let _lock = WORKSPACE_STORAGE_LOCK
        .lock()
        .map_err(|_| "The workspace store is unavailable.".to_string())?;
    let downloads = app
        .path()
        .download_dir()
        .map_err(|error| error.to_string())?;
    workspace_storage::export_file(&downloads, payload, name.as_deref())
}

/// Export the exact retained bytes for the current workspace snapshot or one
/// of its private rolling backups. The source is an allowlisted name rather
/// than a caller-controlled path; the only destination is the OS Downloads
/// directory.
#[tauri::command]
fn export_workspace_snapshot(
    app: tauri::AppHandle,
    source: String,
    name: Option<String>,
) -> Result<String, String> {
    let _lock = WORKSPACE_STORAGE_LOCK
        .lock()
        .map_err(|_| "The workspace store is unavailable.".to_string())?;
    let downloads = app
        .path()
        .download_dir()
        .map_err(|error| error.to_string())?;
    workspace_storage::export_snapshot(
        &credentials_directory(&app)?,
        &downloads,
        &source,
        name.as_deref(),
    )
}

/// Validate and atomically accept `bak1` or `bak2` as the current workspace
/// snapshot. `current` and arbitrary paths are intentionally rejected.
#[tauri::command]
fn restore_workspace_backup(
    app: tauri::AppHandle,
    source: String,
) -> Result<workspace_storage::StorageStatus, String> {
    let _lock = WORKSPACE_STORAGE_LOCK
        .lock()
        .map_err(|_| "The workspace store is unavailable.".to_string())?;
    workspace_storage::restore_backup(&credentials_directory(&app)?, &source)
}

#[tauri::command]
fn workspace_storage_health(
    app: tauri::AppHandle,
) -> Result<workspace_storage::StorageHealth, String> {
    let _lock = WORKSPACE_STORAGE_LOCK
        .lock()
        .map_err(|_| "The workspace store is unavailable.".to_string())?;
    workspace_storage::health(&credentials_directory(&app)?)
}

fn cleanup_managed_temporary_files(app: &tauri::AppHandle) -> Result<(), String> {
    let mut roots = managed_roots(app)?.to_vec();
    roots.push(credentials_directory(app)?);
    roots.push(credentials_directory(app)?.join("workspace"));
    for root in roots {
        secure_directory(&root)?;
        let entries = std::fs::read_dir(&root).map_err(|error| error.to_string())?;
        for entry in entries {
            let entry = entry.map_err(|error| error.to_string())?;
            let path = entry.path();
            let metadata = std::fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
            if !metadata.file_type().is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if (name.ends_with(".part")
                && (name.starts_with(".upload-")
                    || name.starts_with(".response-")
                    || name.starts_with(".asset-")
                    || name.starts_with(".image-")
                    || name.starts_with(".video-")
                    || name.starts_with(".audio-")
                    || name.starts_with(".legacy-")))
                || (name.starts_with(".credentials-") && name.ends_with(".tmp"))
                || (name.starts_with(".derived-") && name.ends_with(".part"))
                || (name.starts_with(".workspace-state-") && name.ends_with(".tmp"))
                || (name.starts_with(".workspace-backup-") && name.ends_with(".tmp"))
            {
                std::fs::remove_file(path).map_err(|error| error.to_string())?;
            }
        }
    }
    Ok(())
}

fn cleanup_download_temporary_files(app: &tauri::AppHandle) -> Result<(), String> {
    let downloads = app
        .path()
        .download_dir()
        .map_err(|error| error.to_string())?;
    let metadata = match std::fs::symlink_metadata(&downloads) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!("{} must be a directory.", downloads.display()));
    }
    for entry in std::fs::read_dir(downloads).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let metadata = std::fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
        if metadata.file_type().is_file() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with(".fruit-truck-export-") && name.ends_with(".part") {
                std::fs::remove_file(path).map_err(|error| error.to_string())?;
            }
        }
    }
    Ok(())
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
            configure_runtime_asset_scope(&app_handle).map_err(
                |error| -> Box<dyn std::error::Error> { Box::new(std::io::Error::other(error)) },
            )?;
            if let Err(error) = cleanup_managed_temporary_files(&app_handle) {
                eprintln!("Fruit Truck could not clean managed temporary files: {error}");
            }
            if let Err(error) = cleanup_download_temporary_files(&app_handle) {
                eprintln!("Fruit Truck could not clean download temporary files: {error}");
            }
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
                    let result = assets_directory(&app)
                        .map(|root| import_media_files_preserving_successes(&paths, &root));
                    match result {
                        Ok((assets, errors)) => {
                            if !assets.is_empty() {
                                let _ = emitter.emit("managed-assets-imported", assets);
                            }
                            if !errors.is_empty() {
                                let _ =
                                    emitter.emit("managed-assets-import-failed", errors.join("\n"));
                            }
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
            validate_api_key_candidate,
            save_api_key,
            remove_api_key,
            openrouter_request,
            cancel_openrouter_request,
            cache_video_content,
            append_asset_chunk,
            finish_asset_upload,
            abort_asset_upload,
            pick_and_import_assets,
            scan_managed_assets,
            inspect_managed_asset,
            delete_managed_asset,
            export_managed_asset,
            read_managed_image_data_url,
            normalize_generated_image,
            save_workspace_state,
            load_workspace_state,
            reconcile_workspace_state,
            import_workspace_state,
            export_workspace_state,
            export_workspace_snapshot,
            restore_workspace_backup,
            workspace_storage_health,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn svg_results_are_sanitized_and_keep_their_mime_extension() {
        let svg = br##"<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path fill="url(#paint)" d="M0 0h10v10z"/><defs><linearGradient id="paint"><stop offset="0" stop-color="#fff"/></linearGradient></defs></svg>"##;
        let sanitized = sanitize_svg(svg).expect("safe SVG");
        assert!(!sanitized.is_empty());
        assert_eq!(
            inspect_media(&sanitized, "result.svg").expect("SVG MIME").1,
            "image/svg+xml"
        );
        assert!(sanitize_svg(
            br#"<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>"#
        )
        .is_err());
        assert!(sanitize_svg(
            br#"<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.example/x"/></svg>"#
        )
        .is_err());
        assert!(sanitize_svg(
            br#"<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><iframe src="https://evil.example"/></foreignObject></svg>"#
        )
        .is_err());
        assert!(sanitize_svg(
            br#"<svg xmlns="http://www.w3.org/2000/svg" width="20000" height="1"/>"#
        )
        .is_err());
        assert!(sanitize_svg(br#"oops<svg xmlns="http://www.w3.org/2000/svg"/>"#).is_err());
        let mixed_case = sanitize_svg(
            br#"<SVG xmlns="http://www.w3.org/2000/svg"><RECT width="1" height="1"/></SVG>"#,
        )
        .expect("mixed-case SVG");
        assert!(std::str::from_utf8(&mixed_case)
            .expect("UTF-8")
            .starts_with("<svg"));
    }

    #[test]
    fn remote_image_urls_require_https_and_public_addresses() {
        assert!(validate_remote_image_url("http://example.com/image.png").is_err());
        assert!(validate_remote_image_url("https://127.0.0.1/image.png").is_err());
        assert!(validate_remote_image_url("https://[::ffff:127.0.0.1]/image.png").is_err());
        assert!(validate_remote_image_url("https://user:pass@example.com/image.png").is_err());
        assert!(validate_remote_image_url("https://example.com/image.png").is_ok());
        assert!(is_blocked_ip_address("100.64.0.1".parse().unwrap()));
        assert!(is_blocked_ip_address("192.0.2.1".parse().unwrap()));
        assert!(is_blocked_ip_address("2001:db8::1".parse().unwrap()));
        assert!(!is_blocked_ip_address("8.8.8.8".parse().unwrap()));
        assert!(resolve_public_addresses_sync("127.0.0.1", 443).is_err());
        assert!(resolve_public_addresses_sync("::1", 443).is_err());
        assert!(validate_public_addresses(vec![
            "8.8.8.8:443".parse().unwrap(),
            "127.0.0.1:443".parse().unwrap(),
        ])
        .is_err());
        assert!(
            validate_public_addresses(vec!["[::ffff:127.0.0.1]:443".parse().unwrap()]).is_err()
        );

        let public = validate_remote_image_url("https://cdn.example/image.png").unwrap();
        assert!(validate_remote_image_redirect(&public, "http://cdn.example/result.png").is_err());
        assert!(validate_remote_image_redirect(&public, "https://127.0.0.1/result.png").is_err());
        assert!(validate_remote_image_redirect(&public, "https://cdn.example/result.png").is_ok());
    }

    #[test]
    fn streamed_response_enforces_incremental_limit_without_content_length() {
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").expect("listener");
        let address = listener.local_addr().expect("listener address");
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().expect("accept request");
            let mut request = [0u8; 1024];
            let _ = socket.read(&mut request).expect("read request");
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n800\r\n")
                .expect("write headers");
            socket.write_all(&vec![b'x'; 2048]).expect("write body");
            socket.write_all(b"\r\n0\r\n\r\n").expect("finish body");
        });
        let root = tempfile::tempdir().expect("stream root");
        let error = tauri::async_runtime::block_on(async {
            let response = reqwest::Client::new()
                .get(format!("http://{address}"))
                .send()
                .await
                .expect("response");
            stream_response_to_temp(response, root.path(), 1024, "fixture response")
                .await
                .expect_err("oversized streamed response")
        });
        server.join().expect("server join");
        assert!(error.contains("exceeds the local safety limit"));
        assert!(error.contains("partial response retained"));
    }

    #[test]
    fn aggregate_request_media_budget_rejects_large_payloads() {
        let mut budget = RequestMediaBudget::new();
        for _ in 0..4 {
            budget
                .reserve(30 * 1024 * 1024)
                .expect("within aggregate cap");
        }
        assert!(budget.reserve(1).is_err());
    }

    #[test]
    fn image_sse_completed_events_materialize_and_preserve_usage() {
        let root = tempfile::tempdir().expect("SSE root");
        let response_path = root.path().join("image-response.sse");
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
        std::fs::write(
            &response_path,
            format!(
                "data: {{\"type\":\"image_generation.partial_image\",\"partial_image_index\":0,\"b64_json\":\"{png}\"}}\n\ndata: {{\"type\":\"image_generation.completed\",\"b64_json\":\"{png}\",\"created\":42,\"usage\":{{\"cost\":0.031}}}}\n\ndata: [DONE]\n\n"
            ),
        )
        .expect("write SSE fixture");

        let payload = parse_openrouter_image_sse_response(&response_path, root.path())
            .expect("parse image SSE");
        let result = payload["data"][0].as_object().expect("completed image");
        assert!(result.get("b64_json").is_none());
        assert!(Path::new(result["local_path"].as_str().expect("local path")).is_file());
        assert_eq!(payload["created"].as_u64(), Some(42));
        assert_eq!(payload["usage"]["cost"].as_f64(), Some(0.031));
    }

    #[test]
    fn active_openrouter_request_can_be_stopped_by_exact_id() {
        let request_id = "test-cancel-request";
        let (sender, receiver) = tokio::sync::watch::channel(false);
        openrouter_cancellations()
            .lock()
            .expect("cancellation registry")
            .insert(request_id.into(), sender);
        assert!(cancel_openrouter_request(request_id.into()).expect("cancel command"));
        assert!(*receiver.borrow());
        openrouter_cancellations()
            .lock()
            .expect("cancellation registry")
            .remove(request_id);
        assert!(!cancel_openrouter_request(request_id.into()).expect("already removed"));
        assert!(cancel_openrouter_request("bad request id".into()).is_err());
    }

    #[test]
    fn image_response_over_legacy_48mb_limit_materializes_each_result() {
        let root = tempfile::tempdir().expect("response root");
        let response_path = root.path().join("large-image-response.json");
        let mut response = std::fs::File::create(&response_path).expect("response fixture");
        let png = base64::engine::general_purpose::STANDARD
            .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")
            .expect("PNG fixture");
        let mut padded_png = vec![0u8; 19 * 1024 * 1024];
        padded_png[..png.len()].copy_from_slice(&png);

        response.write_all(br#"{"data":["#).expect("JSON start");
        for index in 0..2 {
            if index > 0 {
                response.write_all(b",").expect("JSON separator");
            }
            response
                .write_all(br#"{"media_type":"image/png","b64_json":""#)
                .expect("image start");
            {
                let mut encoder = base64::write::EncoderWriter::new(
                    &mut response,
                    &base64::engine::general_purpose::STANDARD,
                );
                encoder.write_all(&padded_png).expect("encode fixture");
                encoder.finish().expect("finish fixture encoding");
            }
            response.write_all(br#""}"#).expect("image end");
        }
        response
            .write_all(br#"],"usage":{"cost":0.08}}"#)
            .expect("JSON end");
        response.flush().expect("flush fixture");
        assert!(
            response.metadata().expect("fixture metadata").len() > MAX_OPENROUTER_JSON_BYTES,
            "fixture must exceed the former aggregate response limit"
        );
        drop(response);

        let payload = parse_openrouter_image_response(&response_path, root.path())
            .expect("streamed materialization");
        let results = payload["data"].as_array().expect("data results");
        assert_eq!(results.len(), 2);
        for result in results {
            assert_eq!(result["byte_size"].as_u64(), Some(padded_png.len() as u64));
            assert!(result.get("b64_json").is_none());
            assert!(Path::new(result["local_path"].as_str().expect("local path")).is_file());
            assert!(result.get("_fruit_truck_materialization_error").is_none());
        }
        assert_eq!(payload["usage"]["cost"].as_f64(), Some(0.08));
    }

    #[test]
    fn ffprobe_metadata_limits_dimensions_duration_and_frame_rate() {
        let valid = r#"{"streams":[{"codec_type":"video","codec_name":"h264","width":1920,"height":1080,"avg_frame_rate":"30/1"}],"format":{"duration":"12.5"}}"#;
        let metadata = parse_managed_asset_metadata(valid).expect("valid metadata");
        assert_eq!(metadata.width, Some(1920));
        assert_eq!(metadata.fps, Some(30.0));
        let oversized =
            r#"{"streams":[{"codec_type":"video","width":16385,"height":1}],"format":{}}"#;
        assert!(parse_managed_asset_metadata(oversized).is_err());
        let too_long = r#"{"streams":[{"codec_type":"video","width":1,"height":1}],"format":{"duration":3601}}"#;
        assert!(parse_managed_asset_metadata(too_long).is_err());
        let too_fast = r#"{"streams":[{"codec_type":"video","width":1,"height":1,"avg_frame_rate":"241/1"}],"format":{}}"#;
        assert!(parse_managed_asset_metadata(too_fast).is_err());
    }

    #[test]
    fn compressed_image_dimension_bomb_is_rejected_from_its_header() {
        let mut gif_header = *b"GIF89a\0\0\0\0";
        gif_header[6..8].copy_from_slice(&u16::MAX.to_le_bytes());
        gif_header[8..10].copy_from_slice(&u16::MAX.to_le_bytes());
        assert!(validate_image_dimensions(&gif_header, "bomb.gif").is_err());
    }

    #[test]
    fn image_output_paths_are_immutable_and_svg_uses_svg_extension() {
        assert_eq!(media_name_for_mime("image/svg+xml"), "result.svg");
        assert_eq!(media_name_for_mime("image/jpeg"), "result.jpg");
        let root = tempfile::tempdir().expect("media root");
        let svg = br#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>"#;
        let managed = write_managed_media(root.path(), "result.svg", svg, "image").expect("write");
        let bytes = std::fs::read(&managed.local_path).expect("read");
        assert_eq!(
            inspect_media(&bytes, "result.svg").expect("inspect").1,
            "image/svg+xml"
        );
    }

    #[test]
    fn openrouter_key_endpoint_is_allowlisted_without_open_proxying() {
        assert!(openrouter_url("/key").is_ok());
        assert!(openrouter_url("/key?x=1").is_err());
        assert!(openrouter_url("/anything").is_err());
        assert!(openrouter_url("/images/models/openai%2Fgpt-image-1/endpoints").is_ok());
        assert!(openrouter_url("/images/models/a/b/endpoints").is_err());
    }

    #[test]
    fn candidate_key_validation_maps_http_states_without_persisting() {
        assert_eq!(
            key_validation_state(reqwest::StatusCode::OK),
            ("connected", true, None)
        );
        assert_eq!(
            key_validation_state(reqwest::StatusCode::UNAUTHORIZED),
            (
                "unauthorized",
                false,
                Some("OpenRouter rejected this API key.")
            )
        );
        assert_eq!(
            key_validation_state(reqwest::StatusCode::TOO_MANY_REQUESTS),
            (
                "rate_limited",
                false,
                Some("OpenRouter rate-limited key validation.")
            )
        );
    }

    #[test]
    fn file_credential_fallback_is_atomic_and_private() {
        let root = tempfile::tempdir().expect("credential root");
        secure_directory(root.path()).expect("private root");
        let path = root.path().join(CREDENTIALS_FILE);
        write_file_api_key(&path, "sk-test-credential-123").expect("write fallback");
        assert_eq!(
            read_file_api_key(&path).expect("read fallback"),
            Some("sk-test-credential-123".into())
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::symlink_metadata(&path)
                .expect("metadata")
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[cfg(unix)]
    #[test]
    fn credential_root_repairs_permissions_and_concurrent_writes_stay_valid() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().expect("credential root");
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o777))
            .expect("make root permissive");
        secure_directory(root.path()).expect("repair private root");
        assert_eq!(
            std::fs::symlink_metadata(root.path())
                .expect("root metadata")
                .permissions()
                .mode()
                & 0o777,
            0o700
        );

        let path = Arc::new(root.path().join(CREDENTIALS_FILE));
        let writers = (0..8)
            .map(|index| {
                let path = Arc::clone(&path);
                std::thread::spawn(move || {
                    write_file_api_key(&path, &format!("sk-test-concurrent-{index:02}-credential"))
                })
            })
            .collect::<Vec<_>>();
        for writer in writers {
            writer
                .join()
                .expect("writer join")
                .expect("atomic key write");
        }
        let stored = read_file_api_key(&path)
            .expect("read final credential")
            .expect("credential exists");
        assert!(stored.starts_with("sk-test-concurrent-"));
        assert_eq!(
            std::fs::symlink_metadata(path.as_ref())
                .expect("credential metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::read_dir(root.path())
                .expect("credential entries")
                .filter_map(Result::ok)
                .filter(|entry| entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".credentials-"))
                .count(),
            0
        );
    }

    #[test]
    fn file_credential_fallback_rejects_symlink() {
        let root = tempfile::tempdir().expect("credential root");
        let target = root.path().join("target");
        std::fs::write(&target, b"secret").expect("target");
        let path = root.path().join(CREDENTIALS_FILE);
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&target, &path).expect("symlink");
            assert!(write_file_api_key(&path, "sk-test-credential-123").is_err());
            assert!(remove_file_api_key(&path).is_err());
        }
    }

    #[test]
    fn managed_export_copy_is_atomic_and_rejects_symlink_destination() {
        let root = tempfile::tempdir().expect("export root");
        let source = root.path().join("source.png");
        let downloads = root.path().join("Downloads");
        let destination = downloads.join("source.png");
        std::fs::write(&source, b"managed bytes").expect("source");
        secure_export_directory(&downloads).expect("downloads");
        atomic_export_copy(&source, &destination).expect("atomic export");
        assert_eq!(
            std::fs::read(&destination).expect("destination"),
            b"managed bytes"
        );
        #[cfg(unix)]
        {
            let linked_destination = downloads.join("linked.png");
            std::os::unix::fs::symlink(&source, &linked_destination).expect("symlink");
            assert!(atomic_export_copy(&source, &linked_destination).is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn managed_root_scope_rejects_symlink_components() {
        let root = tempfile::tempdir().expect("root");
        let target = tempfile::tempdir().expect("target");
        let link = root.path().join("link");
        std::os::unix::fs::symlink(target.path(), &link).expect("symlink");
        assert!(reject_symlink_path_components(&link.join("assets")).is_err());
    }

    #[test]
    fn managed_asset_scanner_skips_symlinks_and_partial_files() {
        let root = tempfile::tempdir().expect("media root");
        let asset = root.path().join("asset.png");
        // 1x1 PNG, used only to exercise the scanner's magic/dimension checks.
        let png = base64::engine::general_purpose::STANDARD
            .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")
            .expect("fixture");
        std::fs::write(&asset, png).expect("asset");
        std::fs::write(root.path().join(".upload-stale.part"), b"partial").expect("partial");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&asset, root.path().join("linked.png")).expect("symlink");
        let mut results = Vec::new();
        scan_managed_root(root.path(), &mut results).expect("scan");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].name, "asset.png");
    }

    #[test]
    fn managed_deletion_is_idempotent_only_inside_a_managed_root() {
        let root = tempfile::tempdir().expect("managed root");
        let existing = root.path().join("existing.png");
        std::fs::write(&existing, b"bytes").expect("existing file");
        let roots = vec![root.path().to_path_buf()];
        assert_eq!(
            validate_managed_deletion_path(&existing, &roots).expect("existing"),
            Some(existing.canonicalize().expect("canonical existing"))
        );
        assert_eq!(
            validate_managed_deletion_path(&root.path().join("already-gone.png"), &roots)
                .expect("missing"),
            None
        );
        let outside = tempfile::tempdir().expect("outside");
        assert!(
            validate_managed_deletion_path(&outside.path().join("missing.png"), &roots).is_err()
        );
    }

    #[test]
    fn batch_import_preserves_successes_when_one_file_fails() {
        let source_root = tempfile::tempdir().expect("source root");
        let managed_root = tempfile::tempdir().expect("managed root");
        let png = base64::engine::general_purpose::STANDARD
            .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")
            .expect("fixture");
        let valid = source_root.path().join("valid.png");
        let invalid = source_root.path().join("invalid.png");
        std::fs::write(&valid, png).expect("valid");
        std::fs::write(&invalid, b"not-an-image").expect("invalid");
        let (assets, errors) =
            import_media_files_preserving_successes(&[valid, invalid], managed_root.path());
        assert_eq!(assets.len(), 1);
        assert_eq!(errors.len(), 1);
        assert!(Path::new(&assets[0].local_path).is_file());
    }
}
