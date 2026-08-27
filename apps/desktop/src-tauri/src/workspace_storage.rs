use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

const STORAGE_DIRECTORY: &str = "workspace";
const STATE_FILE: &str = "workspace-state-v1.json";
const BACKUP_ONE: &str = "workspace-state-v1.json.bak1";
const BACKUP_TWO: &str = "workspace-state-v1.json.bak2";
const SCHEMA_VERSION: u8 = 1;
const MAX_STATE_BYTES: u64 = 64 * 1024 * 1024;
static STORAGE_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageStatus {
    pub path: String,
    pub backup_paths: Vec<String>,
    pub byte_size: u64,
    pub checksum: String,
    pub recovered: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedWorkspace {
    pub payload: Value,
    pub source: String,
    pub schema_version: u8,
    pub checksum: String,
    pub recovered: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageHealth {
    pub directory: String,
    pub path: String,
    pub backup_paths: Vec<String>,
    pub current_exists: bool,
    pub backup_exists: Vec<bool>,
    pub current_valid: bool,
    pub diagnostic: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct Envelope {
    schema_version: u8,
    saved_at_ms: u64,
    checksum: String,
    payload: Value,
}

fn storage_directory(root: &Path) -> Result<PathBuf, String> {
    ensure_directory(root)?;
    let directory = root.join(STORAGE_DIRECTORY);
    ensure_directory(&directory)?;
    Ok(directory)
}

fn state_paths(root: &Path) -> Result<(PathBuf, PathBuf, PathBuf), String> {
    let directory = storage_directory(root)?;
    Ok((
        directory.join(STATE_FILE),
        directory.join(BACKUP_ONE),
        directory.join(BACKUP_TWO),
    ))
}

fn ensure_directory(path: &Path) -> Result<(), String> {
    if let Ok(metadata) = std::fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(format!("{} must be a private directory.", path.display()));
        }
    }
    std::fs::create_dir_all(path).map_err(|error| error.to_string())?;
    let metadata = std::fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!("{} must be a private directory.", path.display()));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
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
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|error| error.to_string())?;
    }
    Ok(file)
}

fn assert_regular_private_file(path: &Path) -> Result<std::fs::Metadata, String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!("{} must be a regular file.", path.display()));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(format!("{} has unsafe permissions.", path.display()));
        }
    }
    if metadata.len() == 0 || metadata.len() > MAX_STATE_BYTES {
        return Err(format!(
            "{} exceeds the workspace state size limit.",
            path.display()
        ));
    }
    Ok(metadata)
}

fn assert_import_file(path: &Path) -> Result<std::fs::Metadata, String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!("{} must be a regular file.", path.display()));
    }
    if metadata.len() == 0 || metadata.len() > MAX_STATE_BYTES {
        return Err(format!(
            "{} exceeds the workspace state size limit.",
            path.display()
        ));
    }
    Ok(metadata)
}

fn entry_exists(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok()
}

fn checksum(payload: &Value) -> Result<String, String> {
    let bytes = serde_json::to_vec(payload).map_err(|error| error.to_string())?;
    Ok(hex_encode(Sha256::digest(bytes)))
}

fn hex_encode(bytes: impl AsRef<[u8]>) -> String {
    bytes
        .as_ref()
        .iter()
        .map(|value| format!("{value:02x}"))
        .collect()
}

fn unix_time_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or_default()
}

fn temporary_path(parent: &Path, prefix: &str) -> PathBuf {
    let sequence = STORAGE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    parent.join(format!(".{prefix}-{}-{sequence}.tmp", std::process::id()))
}

fn sync_directory(path: &Path) {
    #[cfg(unix)]
    if let Ok(directory) = std::fs::File::open(path) {
        let _ = directory.sync_all();
    }
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if bytes.is_empty() || bytes.len() as u64 > MAX_STATE_BYTES {
        return Err("Workspace state exceeds the local safety limit.".into());
    }
    let parent = path
        .parent()
        .ok_or("Workspace state path has no parent directory.")?;
    let parent_metadata = std::fs::symlink_metadata(parent).map_err(|error| error.to_string())?;
    if parent_metadata.file_type().is_symlink() || !parent_metadata.is_dir() {
        return Err("Workspace state parent must be a directory.".into());
    }
    if std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err("Workspace state path may not be a symlink.".into());
    }
    let temporary = temporary_path(parent, "workspace-state");
    let result = (|| {
        let mut file = create_private_file(&temporary)?;
        file.write_all(bytes).map_err(|error| error.to_string())?;
        file.flush().map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        std::fs::rename(&temporary, path).map_err(|error| error.to_string())?;
        sync_directory(parent);
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

fn atomic_copy(source: &Path, destination: &Path) -> Result<(), String> {
    let metadata = assert_regular_private_file(source)?;
    if std::fs::symlink_metadata(destination).is_ok_and(|value| value.file_type().is_symlink()) {
        return Err("Workspace backup path may not be a symlink.".into());
    }
    let parent = destination
        .parent()
        .ok_or("Workspace backup path has no parent directory.")?;
    let parent_metadata = std::fs::symlink_metadata(parent).map_err(|error| error.to_string())?;
    if parent_metadata.file_type().is_symlink() || !parent_metadata.is_dir() {
        return Err("Workspace backup destination must be a directory child.".into());
    }
    let temporary = temporary_path(parent, "workspace-backup");
    let result = (|| {
        let input = std::fs::File::open(source).map_err(|error| error.to_string())?;
        let mut output = create_private_file(&temporary)?;
        let copied = std::io::copy(&mut input.take(MAX_STATE_BYTES + 1), &mut output)
            .map_err(|error| error.to_string())?;
        if copied > MAX_STATE_BYTES {
            return Err("Workspace state exceeds the local safety limit.".into());
        }
        output.flush().map_err(|error| error.to_string())?;
        output.sync_all().map_err(|error| error.to_string())?;
        if std::fs::metadata(&temporary)
            .map_err(|error| error.to_string())?
            .len()
            != metadata.len()
        {
            return Err("Workspace backup copy was incomplete.".into());
        }
        std::fs::rename(&temporary, destination).map_err(|error| error.to_string())?;
        sync_directory(parent);
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

fn envelope_bytes(payload: Value) -> Result<(Vec<u8>, String), String> {
    let checksum = checksum(&payload)?;
    let envelope = Envelope {
        schema_version: SCHEMA_VERSION,
        saved_at_ms: unix_time_ms(),
        checksum: checksum.clone(),
        payload,
    };
    let bytes = serde_json::to_vec(&envelope).map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_STATE_BYTES {
        return Err("Workspace state exceeds the local safety limit.".into());
    }
    Ok((bytes, checksum))
}

fn parse_file_with_metadata(
    path: &Path,
    metadata: std::fs::Metadata,
) -> Result<(LoadedWorkspace, u64), String> {
    let file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_STATE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_STATE_BYTES {
        return Err("Workspace state exceeds the local safety limit.".into());
    }
    let envelope: Envelope = serde_json::from_slice(&bytes)
        .map_err(|_| "Workspace state is not valid JSON.".to_string())?;
    if envelope.schema_version != SCHEMA_VERSION {
        return Err("Workspace state schema version is unsupported.".into());
    }
    let expected = checksum(&envelope.payload)?;
    if envelope.checksum != expected {
        return Err("Workspace state checksum does not match its payload.".into());
    }
    Ok((
        LoadedWorkspace {
            payload: envelope.payload,
            source: path.to_string_lossy().into_owned(),
            schema_version: envelope.schema_version,
            checksum: expected,
            recovered: false,
        },
        metadata.len(),
    ))
}

fn parse_file(path: &Path) -> Result<(LoadedWorkspace, u64), String> {
    parse_file_with_metadata(path, assert_regular_private_file(path)?)
}

fn parse_snapshot_bytes(path: &Path) -> Result<(LoadedWorkspace, Vec<u8>), String> {
    let metadata = assert_regular_private_file(path)?;
    let file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_STATE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_STATE_BYTES {
        return Err("Workspace state exceeds the local safety limit.".into());
    }
    let envelope: Envelope = serde_json::from_slice(&bytes)
        .map_err(|_| "Workspace state is not valid JSON.".to_string())?;
    if envelope.schema_version != SCHEMA_VERSION {
        return Err("Workspace state schema version is unsupported.".into());
    }
    let expected = checksum(&envelope.payload)?;
    if envelope.checksum != expected {
        return Err("Workspace state checksum does not match its payload.".into());
    }
    Ok((
        LoadedWorkspace {
            payload: envelope.payload,
            source: path.to_string_lossy().into_owned(),
            schema_version: envelope.schema_version,
            checksum: expected,
            recovered: false,
        },
        bytes,
    ))
}

fn snapshot_path<'a>(
    paths: &'a (PathBuf, PathBuf, PathBuf),
    source: &str,
) -> Result<&'a Path, String> {
    match source {
        "current" => Ok(&paths.0),
        "bak1" => Ok(&paths.1),
        "bak2" => Ok(&paths.2),
        _ => Err("Workspace snapshot must be current, bak1, or bak2.".into()),
    }
}

fn destination_for_export(downloads: &Path, name: Option<&str>) -> Result<PathBuf, String> {
    if let Ok(metadata) = std::fs::symlink_metadata(downloads) {
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(format!("{} must be a directory.", downloads.display()));
        }
    }
    std::fs::create_dir_all(downloads).map_err(|error| error.to_string())?;
    let requested = safe_export_name(name);
    let requested_path = downloads.join(&requested);
    let mut destination = requested_path.clone();
    if destination.exists() {
        let stem = Path::new(&requested)
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("fruit-truck-workspace");
        for suffix in 1u32.. {
            let candidate = downloads.join(format!("{stem} ({suffix}).json"));
            if !candidate.exists() {
                destination = candidate;
                break;
            }
        }
    }
    Ok(destination)
}

pub fn save(root: &Path, payload: Value) -> Result<StorageStatus, String> {
    let (path, backup_one, backup_two) = state_paths(root)?;
    let (bytes, checksum) = envelope_bytes(payload)?;
    if entry_exists(&path) {
        if entry_exists(&backup_one) {
            atomic_copy(&backup_one, &backup_two)?;
        }
        atomic_copy(&path, &backup_one)?;
    }
    atomic_write(&path, &bytes)?;
    Ok(StorageStatus {
        path: path.to_string_lossy().into_owned(),
        backup_paths: vec![
            backup_one.to_string_lossy().into_owned(),
            backup_two.to_string_lossy().into_owned(),
        ],
        byte_size: bytes.len() as u64,
        checksum,
        recovered: false,
    })
}

pub fn load(root: &Path) -> Result<Option<LoadedWorkspace>, String> {
    let (path, backup_one, backup_two) = state_paths(root)?;
    if !entry_exists(&path) && !entry_exists(&backup_one) && !entry_exists(&backup_two) {
        return Ok(None);
    }
    let mut diagnostics = Vec::new();
    for (index, candidate) in [path, backup_one, backup_two].into_iter().enumerate() {
        if !entry_exists(&candidate) {
            continue;
        }
        match parse_file(&candidate) {
            Ok((mut loaded, _)) => {
                loaded.recovered = index != 0;
                return Ok(Some(loaded));
            }
            Err(error) => diagnostics.push(format!("{}: {error}", candidate.display())),
        }
    }
    Err(format!(
        "No valid workspace state could be recovered. {}",
        diagnostics.join("; ")
    ))
}

/// Reconcile the native snapshots without modifying any of them. This is a
/// named entry point for startup recovery callers; it selects the newest valid
/// primary/backup candidate and marks whether a backup was used.
pub fn reconcile(root: &Path) -> Result<Option<LoadedWorkspace>, String> {
    load(root)
}

pub fn import_file(path: &Path) -> Result<LoadedWorkspace, String> {
    let metadata = assert_import_file(path)?;
    let (loaded, _) = parse_file_with_metadata(path, metadata)?;
    Ok(loaded)
}

fn safe_export_name(name: Option<&str>) -> String {
    let requested = name.unwrap_or("fruit-truck-workspace.json");
    let safe = Path::new(requested)
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("fruit-truck-workspace.json");
    if safe.to_ascii_lowercase().ends_with(".json") {
        safe.to_string()
    } else {
        format!("{safe}.json")
    }
}

pub fn export_file(downloads: &Path, payload: Value, name: Option<&str>) -> Result<String, String> {
    let (bytes, _) = envelope_bytes(payload)?;
    let destination = destination_for_export(downloads, name)?;
    atomic_write(&destination, &bytes)?;
    Ok(destination.to_string_lossy().into_owned())
}

/// Export the exact bytes of one of the private retained snapshots.
///
/// `source` is intentionally an allowlisted name instead of a path so callers
/// cannot use this recovery command to read arbitrary files.
pub fn export_snapshot(
    root: &Path,
    downloads: &Path,
    source: &str,
    name: Option<&str>,
) -> Result<String, String> {
    let paths = state_paths(root)?;
    let source_path = snapshot_path(&paths, source)?;
    let destination = destination_for_export(downloads, name)?;
    atomic_copy(source_path, &destination)?;
    Ok(destination.to_string_lossy().into_owned())
}

/// Validate and atomically accept a retained backup as the current state.
///
/// The selected backup is read and validated before any rotation. The current
/// and previous backup are then rolled forward, and the captured bytes are
/// installed with an fsync + rename. This preserves the exact validated backup
/// bytes and avoids reserializing the payload during recovery.
pub fn restore_backup(root: &Path, source: &str) -> Result<StorageStatus, String> {
    if source == "current" {
        return Err("Only bak1 or bak2 may be restored as a backup.".into());
    }
    let paths = state_paths(root)?;
    let source_path = snapshot_path(&paths, source)?;
    let (loaded, bytes) = parse_snapshot_bytes(source_path)?;
    let (current, backup_one, backup_two) = paths;

    // Read the selected backup before rotation because restoring bak2 rotates
    // bak1 over its path, and restoring bak1 replaces that path with current.
    if entry_exists(&backup_one) {
        atomic_copy(&backup_one, &backup_two)?;
    }
    if entry_exists(&current) {
        atomic_copy(&current, &backup_one)?;
    }
    atomic_write(&current, &bytes)?;

    Ok(StorageStatus {
        path: current.to_string_lossy().into_owned(),
        backup_paths: vec![
            backup_one.to_string_lossy().into_owned(),
            backup_two.to_string_lossy().into_owned(),
        ],
        byte_size: bytes.len() as u64,
        checksum: loaded.checksum,
        recovered: true,
    })
}

pub fn health(root: &Path) -> Result<StorageHealth, String> {
    let (path, backup_one, backup_two) = state_paths(root)?;
    let current_exists = entry_exists(&path);
    let backup_paths = vec![
        backup_one.to_string_lossy().into_owned(),
        backup_two.to_string_lossy().into_owned(),
    ];
    let backup_exists = vec![entry_exists(&backup_one), entry_exists(&backup_two)];
    let (current_valid, diagnostic) = if current_exists {
        match parse_file(&path) {
            Ok(_) => (true, None),
            Err(error) => (false, Some(error)),
        }
    } else {
        (false, None)
    };
    Ok(StorageHealth {
        directory: storage_directory(root)?.to_string_lossy().into_owned(),
        path: path.to_string_lossy().into_owned(),
        backup_paths,
        current_exists,
        backup_exists,
        current_valid,
        diagnostic,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> tempfile::TempDir {
        tempfile::tempdir().expect("temp root")
    }

    #[test]
    fn save_load_and_checksum_round_trip() {
        let root = temp_root();
        let payload = serde_json::json!({"schemaVersion": 6, "attempts": [1, 2]});
        let saved = save(root.path(), payload.clone()).expect("save");
        let loaded = load(root.path()).expect("load").expect("state");
        assert_eq!(loaded.payload, payload);
        assert_eq!(loaded.checksum, saved.checksum);
        assert!(!loaded.recovered);
    }

    #[test]
    fn corrupt_current_recovers_from_last_good_backup() {
        let root = temp_root();
        save(root.path(), serde_json::json!({"version": 1})).expect("first save");
        save(root.path(), serde_json::json!({"version": 2})).expect("second save");
        let current = state_paths(root.path()).expect("paths").0;
        std::fs::write(current, b"corrupt").expect("corrupt current");
        let loaded = load(root.path()).expect("load").expect("recovered");
        assert_eq!(loaded.payload, serde_json::json!({"version": 1}));
        assert!(loaded.recovered);
    }

    #[test]
    fn process_kill_temp_file_never_replaces_the_last_durable_state() {
        let root = temp_root();
        let payload = serde_json::json!({"version": 1, "attempt": "durable"});
        save(root.path(), payload.clone()).expect("initial save");
        let directory = storage_directory(root.path()).expect("storage directory");
        std::fs::write(
            directory.join(".workspace-state-killed-before-rename.tmp"),
            br#"{"version":2,"attempt":"partial"}"#,
        )
        .expect("interrupted temp write");
        let loaded = load(root.path()).expect("load").expect("state");
        assert_eq!(loaded.payload, payload);
        assert!(!loaded.recovered);
    }

    #[test]
    fn rejected_oversized_write_leaves_current_bytes_unchanged() {
        let root = temp_root();
        save(root.path(), serde_json::json!({"version": 1})).expect("initial save");
        let current = state_paths(root.path()).expect("paths").0;
        let retained = std::fs::read(&current).expect("read current");
        let oversized = vec![b'x'; (MAX_STATE_BYTES + 1) as usize];
        assert!(atomic_write(&current, &oversized).is_err());
        assert_eq!(std::fs::read(current).expect("retained current"), retained);
    }

    #[test]
    fn import_rejects_checksum_tampering() {
        let root = temp_root();
        save(root.path(), serde_json::json!({"version": 1})).expect("save");
        let current = state_paths(root.path()).expect("paths").0;
        let mut envelope: Value =
            serde_json::from_slice(&std::fs::read(&current).expect("read")).expect("json");
        envelope["payload"]["version"] = Value::from(2);
        let external = root.path().join("import.json");
        std::fs::write(&external, serde_json::to_vec(&envelope).expect("encode")).expect("write");
        assert!(import_file(&external).is_err());
    }

    #[test]
    fn export_snapshot_preserves_exact_retained_bytes() {
        let root = temp_root();
        save(root.path(), serde_json::json!({"version": 1})).expect("first save");
        save(root.path(), serde_json::json!({"version": 2})).expect("second save");
        let paths = state_paths(root.path()).expect("paths");
        let expected = std::fs::read(&paths.0).expect("read current");
        let downloads = root.path().join("Downloads");
        let exported = export_snapshot(root.path(), &downloads, "current", Some("recovery"))
            .expect("export current");
        assert_eq!(std::fs::read(exported).expect("read export"), expected);
        assert!(export_snapshot(root.path(), &downloads, "../credentials", None).is_err());
    }

    #[test]
    fn restore_backup_validates_and_rotates_without_reserializing() {
        let root = temp_root();
        save(root.path(), serde_json::json!({"version": 1})).expect("first save");
        save(root.path(), serde_json::json!({"version": 2})).expect("second save");
        let paths = state_paths(root.path()).expect("paths");
        let expected = std::fs::read(&paths.1).expect("read backup");
        let restored = restore_backup(root.path(), "bak1").expect("restore");
        assert!(restored.recovered);
        assert_eq!(std::fs::read(&paths.0).expect("read current"), expected);
        assert_eq!(
            load(root.path()).expect("load").expect("state").payload,
            serde_json::json!({"version": 1})
        );
        assert!(restore_backup(root.path(), "current").is_err());
        assert!(restore_backup(root.path(), "arbitrary-path").is_err());
    }
}
