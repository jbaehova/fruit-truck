use std::collections::HashMap;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::workspace_storage::{self, LoadedWorkspace, StorageStatus};

const TRANSACTION_SCHEMA_VERSION: u8 = 1;
const MANIFEST_SCHEMA_VERSION: u8 = 1;
const TRANSACTIONS_DIRECTORY: &str = "update-transactions";
const TRANSACTION_HISTORY_DIRECTORY: &str = "history";
const CURRENT_TRANSACTION_FILE: &str = "current.json";
const SNAPSHOTS_DIRECTORY: &str = "update-snapshots";
const WORKSPACE_SNAPSHOT_FILE: &str = "workspace-envelope.json";
const ASSET_MANIFEST_FILE: &str = "asset-manifest.json";
const TRANSACTION_METADATA_FILE: &str = "transaction.json";
const DIAGNOSTIC_WORKSPACE_FILE: &str = "pre-restore-current.json";
const ASSETS_DIRECTORY: &str = "assets";
const GENERATED_DIRECTORY: &str = "generated";
const MAX_METADATA_BYTES: u64 = 64 * 1024 * 1024;
const HASH_BUFFER_BYTES: usize = 1024 * 1024;
const COMPLETED_SNAPSHOT_RETENTION: usize = 2;
const COMPLETED_SNAPSHOT_MIN_AGE_MS: u64 = 30 * 24 * 60 * 60 * 1000;
pub const PREPARATION_CANCELLED_ERROR: &str = "Update snapshot preparation was cancelled.";
static TRANSACTION_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateTransactionPhase {
    Preparing,
    SnapshotReady,
    Downloading,
    Installing,
    AwaitingRestart,
    Verifying,
    Complete,
    RecoveryRequired,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTransactionFailure {
    pub code: String,
    pub message: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigratedWorkspaceReceipt {
    pub studio_schema: u64,
    pub payload_checksum: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTransaction {
    pub schema_version: u8,
    pub id: String,
    pub from_app_version: String,
    pub to_app_version: String,
    pub from_studio_schema: u64,
    pub target_studio_schema: u64,
    pub phase: UpdateTransactionPhase,
    pub created_at: String,
    pub updated_at: String,
    pub snapshot_path: String,
    pub snapshot_checksum: String,
    pub asset_manifest_path: String,
    pub asset_manifest_checksum: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub installing_process_id: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub migrated_workspace: Option<MigratedWorkspaceReceipt>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<UpdateTransactionFailure>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetManifestEntry {
    pub asset_id: String,
    pub kind: String,
    pub origin: String,
    pub relative_path: String,
    pub byte_size: u64,
    pub sha256: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetManifest {
    pub schema_version: u8,
    pub created_at_ms: u64,
    pub entries: Vec<AssetManifestEntry>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetVerificationIssue {
    pub asset_id: String,
    pub relative_path: String,
    pub code: String,
    pub message: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetVerificationReport {
    pub schema_version: u8,
    pub transaction_id: String,
    pub valid: bool,
    pub total_entries: usize,
    pub verified_entries: usize,
    pub missing_entries: usize,
    pub changed_entries: usize,
    pub issues: Vec<AssetVerificationIssue>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePreparationProgress {
    pub schema_version: u8,
    pub transaction_id: String,
    pub stage: String,
    pub asset_id: Option<String>,
    pub relative_path: Option<String>,
    pub asset_index: usize,
    pub asset_count: usize,
    pub asset_bytes_hashed: u64,
    pub asset_byte_size: u64,
    pub total_bytes_hashed: u64,
    pub total_byte_size: u64,
}

fn unix_time_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or_default()
}

fn timestamp_string(now_ms: u64) -> String {
    let seconds = (now_ms / 1000) as i64;
    let days = seconds.div_euclid(86_400);
    let second_of_day = seconds.rem_euclid(86_400);
    let shifted_days = days + 719_468;
    let era = if shifted_days >= 0 {
        shifted_days
    } else {
        shifted_days - 146_096
    } / 146_097;
    let day_of_era = shifted_days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    if month <= 2 {
        year += 1;
    }
    let hour = second_of_day / 3_600;
    let minute = second_of_day % 3_600 / 60;
    let second = second_of_day % 60;
    let millisecond = now_ms % 1000;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millisecond:03}Z")
}

fn sha256(bytes: impl AsRef<[u8]>) -> String {
    hex_encode(Sha256::digest(bytes.as_ref()))
}

fn hex_encode(bytes: impl AsRef<[u8]>) -> String {
    bytes
        .as_ref()
        .iter()
        .map(|value| format!("{value:02x}"))
        .collect()
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn validate_version(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || value.chars().any(|character| character.is_control())
    {
        return Err(format!("{label} is invalid."));
    }
    Ok(())
}

fn validate_transaction_id(transaction_id: &str) -> Result<(), String> {
    if transaction_id.is_empty()
        || transaction_id.len() > 128
        || transaction_id.starts_with('.')
        || !transaction_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("The update transaction ID is invalid.".into());
    }
    Ok(())
}

fn new_transaction_id(now_ms: u64) -> String {
    let sequence = TRANSACTION_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("{now_ms:016x}-{:08x}-{sequence:016x}", std::process::id())
}

fn unique_transaction_id(root: &Path, now_ms: u64) -> Result<String, String> {
    for _ in 0..1024 {
        let candidate = new_transaction_id(now_ms);
        if std::fs::symlink_metadata(transaction_snapshot_directory(root, &candidate)?).is_err()
            && std::fs::symlink_metadata(history_transaction_path(root, &candidate)?).is_err()
        {
            return Ok(candidate);
        }
    }
    Err("A unique update transaction ID could not be allocated.".into())
}

fn transactions_directory(root: &Path) -> PathBuf {
    root.join(TRANSACTIONS_DIRECTORY)
}

fn transaction_history_directory(root: &Path) -> PathBuf {
    transactions_directory(root).join(TRANSACTION_HISTORY_DIRECTORY)
}

fn current_transaction_path(root: &Path) -> PathBuf {
    transactions_directory(root).join(CURRENT_TRANSACTION_FILE)
}

fn history_transaction_path(root: &Path, transaction_id: &str) -> Result<PathBuf, String> {
    validate_transaction_id(transaction_id)?;
    Ok(transaction_history_directory(root).join(format!("{transaction_id}.json")))
}

fn snapshots_directory(root: &Path) -> PathBuf {
    root.join(SNAPSHOTS_DIRECTORY)
}

fn transaction_snapshot_directory(root: &Path, transaction_id: &str) -> Result<PathBuf, String> {
    validate_transaction_id(transaction_id)?;
    Ok(snapshots_directory(root).join(transaction_id))
}

fn workspace_snapshot_path(root: &Path, transaction_id: &str) -> Result<PathBuf, String> {
    Ok(transaction_snapshot_directory(root, transaction_id)?.join(WORKSPACE_SNAPSHOT_FILE))
}

fn asset_manifest_path(root: &Path, transaction_id: &str) -> Result<PathBuf, String> {
    Ok(transaction_snapshot_directory(root, transaction_id)?.join(ASSET_MANIFEST_FILE))
}

fn snapshot_relative_path(transaction_id: &str, file_name: &str) -> String {
    format!("{SNAPSHOTS_DIRECTORY}/{transaction_id}/{file_name}")
}

fn prepare_directories(root: &Path) -> Result<(), String> {
    workspace_storage::ensure_private_directory(root)?;
    workspace_storage::ensure_private_directory(&transactions_directory(root))?;
    workspace_storage::ensure_private_directory(&transaction_history_directory(root))?;
    workspace_storage::ensure_private_directory(&snapshots_directory(root))?;
    workspace_storage::sync_private_directory(&transactions_directory(root))?;
    workspace_storage::sync_private_directory(root)?;
    Ok(())
}

/// Return the validated managed upload directory for recovery UI actions.
pub fn asset_root(root: &Path) -> Result<String, String> {
    workspace_storage::ensure_private_directory(root)?;
    let assets = root.join(ASSETS_DIRECTORY);
    workspace_storage::ensure_private_directory(&assets)?;
    Ok(assets.to_string_lossy().into_owned())
}

fn read_private_bytes(path: &Path) -> Result<Vec<u8>, String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!(
            "{} must be a regular private file.",
            path.display()
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(format!("{} has unsafe permissions.", path.display()));
        }
    }
    if metadata.len() == 0 || metadata.len() > MAX_METADATA_BYTES {
        return Err(format!(
            "{} exceeds the metadata size limit.",
            path.display()
        ));
    }
    let file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_METADATA_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_METADATA_BYTES {
        return Err(format!(
            "{} exceeds the metadata size limit.",
            path.display()
        ));
    }
    Ok(bytes)
}

fn read_private_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<(T, Vec<u8>), String> {
    let bytes = read_private_bytes(path)?;
    let value = serde_json::from_slice(&bytes)
        .map_err(|_| format!("{} is not valid update metadata JSON.", path.display()))?;
    Ok((value, bytes))
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<Vec<u8>, String> {
    let bytes = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    workspace_storage::atomic_write_private(path, &bytes)?;
    Ok(bytes)
}

fn validate_transaction(transaction: &UpdateTransaction) -> Result<(), String> {
    if transaction.schema_version != TRANSACTION_SCHEMA_VERSION {
        return Err("The update transaction schema version is unsupported.".into());
    }
    validate_transaction_id(&transaction.id)?;
    validate_version(&transaction.from_app_version, "The source app version")?;
    validate_version(&transaction.to_app_version, "The target app version")?;
    if transaction.target_studio_schema < transaction.from_studio_schema {
        return Err("The target Studio schema may not precede the source schema.".into());
    }
    if transaction.snapshot_path != snapshot_relative_path(&transaction.id, WORKSPACE_SNAPSHOT_FILE)
        || transaction.asset_manifest_path
            != snapshot_relative_path(&transaction.id, ASSET_MANIFEST_FILE)
    {
        return Err("The update transaction contains an unsafe snapshot path.".into());
    }
    if !valid_sha256(&transaction.snapshot_checksum)
        || !valid_sha256(&transaction.asset_manifest_checksum)
    {
        return Err("The update transaction contains an invalid checksum.".into());
    }
    if transaction.installing_process_id == Some(0) {
        return Err("The update transaction contains an invalid installing process ID.".into());
    }
    if let Some(receipt) = &transaction.migrated_workspace {
        if receipt.studio_schema != transaction.target_studio_schema
            || !valid_sha256(&receipt.payload_checksum)
            || !matches!(
                transaction.phase,
                UpdateTransactionPhase::Verifying
                    | UpdateTransactionPhase::RecoveryRequired
                    | UpdateTransactionPhase::Complete
            )
        {
            return Err(
                "The update transaction contains an invalid migrated workspace receipt.".into(),
            );
        }
    }
    Ok(())
}

fn read_transaction(path: &Path) -> Result<UpdateTransaction, String> {
    let (transaction, _) = read_private_json(path)?;
    validate_transaction(&transaction)?;
    Ok(transaction)
}

fn read_current_transaction(root: &Path) -> Result<Option<UpdateTransaction>, String> {
    prepare_directories(root)?;
    let path = current_transaction_path(root);
    if std::fs::symlink_metadata(&path).is_err() {
        return Ok(None);
    }
    read_transaction(&path).map(Some)
}

fn current_transaction_for_id(
    root: &Path,
    transaction_id: &str,
) -> Result<UpdateTransaction, String> {
    validate_transaction_id(transaction_id)?;
    let transaction =
        read_current_transaction(root)?.ok_or("No current update transaction exists.")?;
    if transaction.id != transaction_id {
        return Err("The update transaction is not current.".into());
    }
    Ok(transaction)
}

fn transaction_for_recovery(
    root: &Path,
    transaction_id: &str,
) -> Result<UpdateTransaction, String> {
    validate_transaction_id(transaction_id)?;
    if let Some(transaction) = read_current_transaction(root)? {
        if transaction.id == transaction_id {
            return Ok(transaction);
        }
    }
    read_transaction(&history_transaction_path(root, transaction_id)?)
}

fn persist_transaction(root: &Path, transaction: &UpdateTransaction) -> Result<(), String> {
    validate_transaction(transaction)?;
    prepare_directories(root)?;
    let snapshot_dir = transaction_snapshot_directory(root, &transaction.id)?;
    workspace_storage::ensure_private_directory(&snapshot_dir)?;
    write_json(&snapshot_dir.join(TRANSACTION_METADATA_FILE), transaction)?;
    write_json(
        &history_transaction_path(root, &transaction.id)?,
        transaction,
    )?;
    write_json(&current_transaction_path(root), transaction)?;
    Ok(())
}

fn remove_current_transaction(root: &Path) -> Result<(), String> {
    let path = current_transaction_path(root);
    let metadata = std::fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("The current update transaction must be a regular file.".into());
    }
    std::fs::remove_file(&path).map_err(|error| error.to_string())?;
    workspace_storage::sync_private_directory(&transactions_directory(root))
}

fn studio_schema(payload: &Value) -> Result<u64, String> {
    payload
        .get("schemaVersion")
        .and_then(Value::as_u64)
        .ok_or("The workspace payload has no valid Studio schema version.".into())
}

fn canonical_payload_checksum(payload: &Value) -> Result<String, String> {
    serde_json::to_vec(payload)
        .map(sha256)
        .map_err(|error| error.to_string())
}

fn current_workspace(root: &Path) -> Result<(LoadedWorkspace, Vec<u8>), String> {
    let path = workspace_storage::current_state_file(root)?;
    workspace_storage::read_validated_envelope(&path)
        .map_err(|error| format!("The primary workspace is unavailable or invalid: {error}"))
}

fn current_storage_status(
    root: &Path,
    loaded: &LoadedWorkspace,
    exact_bytes: &[u8],
) -> Result<StorageStatus, String> {
    let health = workspace_storage::health(root)?;
    Ok(StorageStatus {
        path: health.path,
        backup_paths: health.backup_paths,
        byte_size: exact_bytes.len() as u64,
        checksum: loaded.checksum.clone(),
        recovered: false,
    })
}

fn path_has_only_normal_components(path: &Path) -> bool {
    path.components()
        .all(|component| matches!(component, Component::Normal(_)))
}

fn is_temporary_asset(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".part")
        || lower.ends_with(".tmp")
        || lower.starts_with(".upload-")
        || lower.starts_with(".response-")
        || lower.starts_with(".asset-")
        || lower.starts_with(".derived-")
}

fn managed_relative_path(root: &Path, path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("Managed asset paths must be absolute.".into());
    }
    for directory in [ASSETS_DIRECTORY, GENERATED_DIRECTORY] {
        let managed_root = root.join(directory);
        if let Ok(relative) = path.strip_prefix(&managed_root) {
            if relative.as_os_str().is_empty() || !path_has_only_normal_components(relative) {
                return Err("A managed asset path attempted to escape its storage root.".into());
            }
            return Ok(PathBuf::from(directory).join(relative));
        }
    }
    Err("A workspace asset path is outside managed storage.".into())
}

fn resolve_manifest_path(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let relative = Path::new(relative_path);
    if relative.is_absolute() || !path_has_only_normal_components(relative) {
        return Err("The asset manifest contains a path traversal.".into());
    }
    let mut components = relative.components();
    let Some(Component::Normal(storage_root)) = components.next() else {
        return Err("The asset manifest path is invalid.".into());
    };
    if storage_root != ASSETS_DIRECTORY && storage_root != GENERATED_DIRECTORY {
        return Err("The asset manifest path is outside managed storage.".into());
    }
    if components.next().is_none() {
        return Err("The asset manifest path does not name a file.".into());
    }
    Ok(root.join(relative))
}

fn assert_no_symlink_components(root: &Path, relative_path: &Path) -> Result<(), String> {
    let mut current = root.to_path_buf();
    for component in relative_path.components() {
        let Component::Normal(component) = component else {
            return Err("The managed asset path is invalid.".into());
        };
        current.push(component);
        let metadata = std::fs::symlink_metadata(&current).map_err(|error| error.to_string())?;
        if metadata.file_type().is_symlink() {
            return Err(format!("{} may not be a symlink.", current.display()));
        }
    }
    Ok(())
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct FileState {
    length: u64,
    modified: Option<std::time::SystemTime>,
}

fn regular_file_state(path: &Path) -> Result<FileState, String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!("{} must be a regular asset file.", path.display()));
    }
    Ok(FileState {
        length: metadata.len(),
        modified: metadata.modified().ok(),
    })
}

fn hash_regular_file_controlled<F, P, C>(
    path: &Path,
    mut after_hash: F,
    mut on_progress: P,
    is_cancelled: &C,
) -> Result<(u64, String), String>
where
    F: FnMut(usize, &Path) -> Result<(), String>,
    P: FnMut(u64, u64) -> Result<(), String>,
    C: Fn() -> bool,
{
    for attempt in 0..2 {
        if is_cancelled() {
            return Err(PREPARATION_CANCELLED_ERROR.into());
        }
        let before = regular_file_state(path)?;
        let mut file = std::fs::File::open(path).map_err(|error| error.to_string())?;
        let mut digest = Sha256::new();
        let mut buffer = vec![0u8; HASH_BUFFER_BYTES];
        let mut total = 0u64;
        on_progress(0, before.length)?;
        loop {
            if is_cancelled() {
                return Err(PREPARATION_CANCELLED_ERROR.into());
            }
            let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
            if read == 0 {
                break;
            }
            total = total
                .checked_add(read as u64)
                .ok_or("The managed asset is too large to hash.")?;
            digest.update(&buffer[..read]);
            on_progress(total, before.length)?;
        }
        after_hash(attempt, path)?;
        if is_cancelled() {
            return Err(PREPARATION_CANCELLED_ERROR.into());
        }
        let after = regular_file_state(path)?;
        if before == after && before.length == total {
            return Ok((total, hex_encode(digest.finalize())));
        }
    }
    Err(format!(
        "{} changed while its update checksum was being calculated.",
        path.display()
    ))
}

fn hash_regular_file_with_hook<F>(path: &Path, after_hash: F) -> Result<(u64, String), String>
where
    F: FnMut(usize, &Path) -> Result<(), String>,
{
    hash_regular_file_controlled(path, after_hash, |_, _| Ok(()), &|| false)
}

fn hash_regular_file(path: &Path) -> Result<(u64, String), String> {
    hash_regular_file_with_hook(path, |_, _| Ok(()))
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct AssetManifestCandidate {
    asset_id: String,
    kind: String,
    origin: String,
    source_path: PathBuf,
    relative_path: String,
    byte_size: u64,
}

fn manifest_candidate(
    root: &Path,
    asset: &serde_json::Map<String, Value>,
) -> Result<Option<AssetManifestCandidate>, String> {
    let asset_id = asset
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or("A managed workspace asset has no valid ID.")?;
    let Some(local_path) = asset.get("localPath") else {
        return Ok(None);
    };
    let local_path = local_path
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("Managed asset {asset_id} has an invalid local path."))?;
    let source_path = Path::new(local_path);
    let relative_path = managed_relative_path(root, source_path)
        .map_err(|error| format!("Managed asset {asset_id}: {error}"))?;
    if is_temporary_asset(source_path) {
        return Ok(None);
    }
    assert_no_symlink_components(root, &relative_path)
        .map_err(|error| format!("Managed asset {asset_id}: {error}"))?;
    let byte_size = regular_file_state(source_path)
        .map_err(|error| format!("Managed asset {asset_id}: {error}"))?
        .length;
    let kind = asset
        .get("kind")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("Managed asset {asset_id} has no valid kind."))?;
    let origin = asset
        .get("origin")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("Managed asset {asset_id} has no valid origin."))?;
    Ok(Some(AssetManifestCandidate {
        asset_id: asset_id.to_string(),
        kind: kind.to_string(),
        origin: origin.to_string(),
        source_path: source_path.to_path_buf(),
        relative_path: relative_path.to_string_lossy().into_owned(),
        byte_size,
    }))
}

fn collect_manifest_candidates(
    root: &Path,
    payload: &Value,
) -> Result<Vec<AssetManifestCandidate>, String> {
    let sessions = payload
        .get("sessions")
        .and_then(Value::as_array)
        .ok_or("The workspace payload has no valid sessions array.")?;
    let mut candidates_by_id: HashMap<String, AssetManifestCandidate> = HashMap::new();
    for session in sessions {
        let assets = session
            .get("assets")
            .and_then(Value::as_array)
            .ok_or("A workspace session has no valid assets array.")?;
        for asset in assets {
            let asset = asset
                .as_object()
                .ok_or("A workspace session contains an invalid asset record.")?;
            let Some(candidate) = manifest_candidate(root, asset)? else {
                continue;
            };
            if let Some(previous) = candidates_by_id.get(&candidate.asset_id) {
                if previous != &candidate {
                    return Err(format!(
                        "Managed asset ID {} resolves to conflicting files.",
                        candidate.asset_id
                    ));
                }
                continue;
            }
            candidates_by_id.insert(candidate.asset_id.clone(), candidate);
        }
    }
    let mut candidates: Vec<_> = candidates_by_id.into_values().collect();
    candidates.sort_by(|left, right| {
        left.asset_id
            .cmp(&right.asset_id)
            .then(left.relative_path.cmp(&right.relative_path))
    });
    Ok(candidates)
}

fn build_asset_manifest_with_observer<P, C>(
    root: &Path,
    payload: &Value,
    transaction_id: &str,
    now_ms: u64,
    on_progress: &mut P,
    is_cancelled: &C,
) -> Result<AssetManifest, String>
where
    P: FnMut(UpdatePreparationProgress) -> Result<(), String>,
    C: Fn() -> bool,
{
    let candidates = collect_manifest_candidates(root, payload)?;
    let total_byte_size = candidates.iter().try_fold(0u64, |total, candidate| {
        total
            .checked_add(candidate.byte_size)
            .ok_or("The managed asset collection is too large to hash.")
    })?;
    let asset_count = candidates.len();
    on_progress(UpdatePreparationProgress {
        schema_version: TRANSACTION_SCHEMA_VERSION,
        transaction_id: transaction_id.to_string(),
        stage: "hashing_assets".into(),
        asset_id: None,
        relative_path: None,
        asset_index: 0,
        asset_count,
        asset_bytes_hashed: 0,
        asset_byte_size: 0,
        total_bytes_hashed: 0,
        total_byte_size,
    })?;
    let mut completed_bytes = 0u64;
    let mut entries = Vec::with_capacity(asset_count);
    for (index, candidate) in candidates.into_iter().enumerate() {
        if is_cancelled() {
            return Err(PREPARATION_CANCELLED_ERROR.into());
        }
        let asset_id = candidate.asset_id.clone();
        let relative_path = candidate.relative_path.clone();
        let byte_size = candidate.byte_size;
        let (hashed_size, file_sha256) = hash_regular_file_controlled(
            &candidate.source_path,
            |_, _| Ok(()),
            |asset_bytes_hashed, current_size| {
                on_progress(UpdatePreparationProgress {
                    schema_version: TRANSACTION_SCHEMA_VERSION,
                    transaction_id: transaction_id.to_string(),
                    stage: "hashing_assets".into(),
                    asset_id: Some(asset_id.clone()),
                    relative_path: Some(relative_path.clone()),
                    asset_index: index + 1,
                    asset_count,
                    asset_bytes_hashed,
                    asset_byte_size: current_size,
                    total_bytes_hashed: completed_bytes.saturating_add(asset_bytes_hashed),
                    total_byte_size,
                })
            },
            is_cancelled,
        )
        .map_err(|error| {
            if error == PREPARATION_CANCELLED_ERROR {
                error
            } else {
                format!("Managed asset {asset_id}: {error}")
            }
        })?;
        completed_bytes = completed_bytes
            .checked_add(hashed_size)
            .ok_or("The managed asset collection is too large to hash.")?;
        entries.push(AssetManifestEntry {
            asset_id: candidate.asset_id,
            kind: candidate.kind,
            origin: candidate.origin,
            relative_path: candidate.relative_path,
            byte_size: hashed_size,
            sha256: file_sha256,
        });
        if hashed_size != byte_size {
            return Err(format!(
                "Managed asset {asset_id} changed while its manifest was being prepared."
            ));
        }
    }
    Ok(AssetManifest {
        schema_version: MANIFEST_SCHEMA_VERSION,
        created_at_ms: now_ms,
        entries,
    })
}

fn load_verified_manifest(
    root: &Path,
    transaction: &UpdateTransaction,
) -> Result<AssetManifest, String> {
    prepare_directories(root)?;
    workspace_storage::ensure_private_directory(&transaction_snapshot_directory(
        root,
        &transaction.id,
    )?)?;
    let path = asset_manifest_path(root, &transaction.id)?;
    let (manifest, bytes): (AssetManifest, Vec<u8>) = read_private_json(&path)?;
    if sha256(&bytes) != transaction.asset_manifest_checksum {
        return Err("The asset manifest checksum does not match the transaction.".into());
    }
    if manifest.schema_version != MANIFEST_SCHEMA_VERSION {
        return Err("The asset manifest schema version is unsupported.".into());
    }
    for entry in &manifest.entries {
        if entry.asset_id.is_empty()
            || entry.kind.is_empty()
            || entry.origin.is_empty()
            || !valid_sha256(&entry.sha256)
        {
            return Err("The asset manifest contains an invalid entry.".into());
        }
        resolve_manifest_path(root, &entry.relative_path)?;
    }
    Ok(manifest)
}

fn verify_snapshot_checksum(
    root: &Path,
    transaction: &UpdateTransaction,
) -> Result<(LoadedWorkspace, Vec<u8>), String> {
    prepare_directories(root)?;
    workspace_storage::ensure_private_directory(&transaction_snapshot_directory(
        root,
        &transaction.id,
    )?)?;
    let path = workspace_snapshot_path(root, &transaction.id)?;
    let (loaded, bytes) = workspace_storage::read_validated_envelope(&path)?;
    if sha256(&bytes) != transaction.snapshot_checksum {
        return Err("The pre-update workspace snapshot checksum does not match.".into());
    }
    Ok((loaded, bytes))
}

fn transition_allowed(from: UpdateTransactionPhase, to: UpdateTransactionPhase) -> bool {
    if from == to {
        return true;
    }
    if to == UpdateTransactionPhase::RecoveryRequired {
        return from != UpdateTransactionPhase::Complete;
    }
    matches!(
        (from, to),
        (
            UpdateTransactionPhase::Preparing,
            UpdateTransactionPhase::SnapshotReady
        ) | (
            UpdateTransactionPhase::SnapshotReady,
            UpdateTransactionPhase::Downloading
        ) | (
            UpdateTransactionPhase::Downloading,
            UpdateTransactionPhase::Installing
        ) | (
            UpdateTransactionPhase::Downloading,
            UpdateTransactionPhase::AwaitingRestart
        ) | (
            UpdateTransactionPhase::Installing,
            UpdateTransactionPhase::AwaitingRestart
        ) | (
            UpdateTransactionPhase::SnapshotReady,
            UpdateTransactionPhase::AwaitingRestart
        ) | (
            UpdateTransactionPhase::AwaitingRestart,
            UpdateTransactionPhase::Verifying
        ) | (
            UpdateTransactionPhase::SnapshotReady,
            UpdateTransactionPhase::Verifying
        ) | (
            UpdateTransactionPhase::RecoveryRequired,
            UpdateTransactionPhase::Verifying
        )
    )
}

/// Create a durable exact-byte workspace snapshot and managed asset manifest.
///
/// The caller supplies the already allowlisted Fruit Truck data root. The
/// returned transaction is persisted only after both artifacts have been read
/// back and checksum-verified.
#[allow(dead_code)]
pub fn create_pre_update_snapshot(
    root: &Path,
    from_version: String,
    to_version: String,
) -> Result<UpdateTransaction, String> {
    create_pre_update_snapshot_with_observer(root, from_version, to_version, |_| Ok(()), || false)
}

fn cleanup_unpublished_snapshot(root: &Path, transaction_id: &str) {
    let Ok(directory) = transaction_snapshot_directory(root, transaction_id) else {
        return;
    };
    for file in [
        WORKSPACE_SNAPSHOT_FILE,
        ASSET_MANIFEST_FILE,
        TRANSACTION_METADATA_FILE,
    ] {
        let path = directory.join(file);
        if std::fs::symlink_metadata(&path).is_ok_and(|metadata| !metadata.is_dir()) {
            let _ = std::fs::remove_file(path);
        }
    }
    if std::fs::read_dir(&directory).is_ok_and(|mut entries| entries.next().is_none()) {
        let _ = std::fs::remove_dir(&directory);
    }
    let _ = workspace_storage::sync_private_directory(&snapshots_directory(root));
}

/// Create a pre-update snapshot with streaming managed-asset progress and
/// cooperative cancellation checks between hash chunks.
pub fn create_pre_update_snapshot_with_observer<P, C>(
    root: &Path,
    from_version: String,
    to_version: String,
    mut on_progress: P,
    is_cancelled: C,
) -> Result<UpdateTransaction, String>
where
    P: FnMut(UpdatePreparationProgress) -> Result<(), String>,
    C: Fn() -> bool,
{
    validate_version(&from_version, "The source app version")?;
    validate_version(&to_version, "The target app version")?;
    prepare_directories(root)?;
    if is_cancelled() {
        return Err(PREPARATION_CANCELLED_ERROR.into());
    }
    let transaction_to_supersede = read_current_transaction(root)?
        .filter(|current| current.phase != UpdateTransactionPhase::Complete);

    let current_path = workspace_storage::current_state_file(root)?;
    let (loaded, source_bytes) = workspace_storage::read_validated_envelope(&current_path)?;
    if is_cancelled() {
        return Err(PREPARATION_CANCELLED_ERROR.into());
    }
    let source_checksum = sha256(&source_bytes);
    let from_studio_schema = studio_schema(&loaded.payload)?;
    let now_ms = unix_time_ms();
    let transaction_id = unique_transaction_id(root, now_ms)?;
    let snapshot_directory = transaction_snapshot_directory(root, &transaction_id)?;
    workspace_storage::ensure_private_directory(&snapshot_directory)?;
    workspace_storage::sync_private_directory(&snapshots_directory(root))?;

    let prepared = (|| {
        if is_cancelled() {
            return Err(PREPARATION_CANCELLED_ERROR.into());
        }
        let snapshot_path = workspace_snapshot_path(root, &transaction_id)?;
        workspace_storage::atomic_write_private(&snapshot_path, &source_bytes)?;
        let (_, copied_bytes) = workspace_storage::read_validated_envelope(&snapshot_path)?;
        if copied_bytes != source_bytes || sha256(&copied_bytes) != source_checksum {
            return Err("The copied workspace snapshot failed exact-byte verification.".into());
        }
        if is_cancelled() {
            return Err(PREPARATION_CANCELLED_ERROR.into());
        }

        let manifest = build_asset_manifest_with_observer(
            root,
            &loaded.payload,
            &transaction_id,
            now_ms,
            &mut on_progress,
            &is_cancelled,
        )?;
        if is_cancelled() {
            return Err(PREPARATION_CANCELLED_ERROR.into());
        }
        let manifest_path = asset_manifest_path(root, &transaction_id)?;
        let manifest_bytes = write_json(&manifest_path, &manifest)?;
        let (verified_manifest, verified_manifest_bytes): (AssetManifest, Vec<u8>) =
            read_private_json(&manifest_path)?;
        if verified_manifest != manifest || verified_manifest_bytes != manifest_bytes {
            return Err("The copied asset manifest failed exact-byte verification.".into());
        }
        for entry in &verified_manifest.entries {
            resolve_manifest_path(root, &entry.relative_path)?;
        }
        let (_, current_bytes_after_manifest) =
            workspace_storage::read_validated_envelope(&current_path)?;
        if current_bytes_after_manifest != source_bytes {
            return Err(
                "The workspace changed while its update snapshot was being prepared.".into(),
            );
        }
        if is_cancelled() {
            return Err(PREPARATION_CANCELLED_ERROR.into());
        }
        workspace_storage::sync_private_directory(&snapshot_directory)?;

        Ok(UpdateTransaction {
            schema_version: TRANSACTION_SCHEMA_VERSION,
            id: transaction_id.clone(),
            from_app_version: from_version,
            to_app_version: to_version,
            from_studio_schema,
            target_studio_schema: 8,
            phase: UpdateTransactionPhase::SnapshotReady,
            created_at: timestamp_string(now_ms),
            updated_at: timestamp_string(now_ms),
            snapshot_path: snapshot_relative_path(&transaction_id, WORKSPACE_SNAPSHOT_FILE),
            snapshot_checksum: source_checksum,
            asset_manifest_path: snapshot_relative_path(&transaction_id, ASSET_MANIFEST_FILE),
            asset_manifest_checksum: sha256(&manifest_bytes),
            installing_process_id: None,
            migrated_workspace: None,
            failure: None,
        })
    })();
    let transaction = match prepared {
        Ok(transaction) => transaction,
        Err(error) => {
            cleanup_unpublished_snapshot(root, &transaction_id);
            return Err(error);
        }
    };
    if let Some(mut superseded) = transaction_to_supersede {
        superseded.phase = UpdateTransactionPhase::RecoveryRequired;
        superseded.updated_at = timestamp_string(unix_time_ms());
        superseded.failure = Some(UpdateTransactionFailure {
            code: "transaction_superseded".into(),
            message: "A fresh snapshot superseded this transaction after its update attempt ended. Its recovery artifacts were retained.".into(),
        });
        persist_transaction(root, &superseded)?;
    }
    persist_transaction(root, &transaction)?;
    Ok(transaction)
}

/// Load the non-complete current transaction, if one exists.
pub fn load_pending_update_transaction(root: &Path) -> Result<Option<UpdateTransaction>, String> {
    let Some(transaction) = read_current_transaction(root)? else {
        return Ok(None);
    };
    if transaction.phase == UpdateTransactionPhase::Complete {
        return Ok(None);
    }
    Ok(Some(transaction))
}

/// Return whether the durable current transaction requires native workspace
/// mutation and managed-asset cleanup to remain blocked.
pub fn update_transaction_blocks_mutation(root: &Path) -> Result<bool, String> {
    Ok(read_current_transaction(root)?
        .is_some_and(|transaction| transaction.phase != UpdateTransactionPhase::Complete))
}

/// Abort only a pre-relaunch transaction while retaining its snapshot and
/// archived metadata for explicit recovery.
///
/// Installing, awaiting-restart, and all boot-verification phases are
/// intentionally non-abortable because the installed app version may already
/// have changed.
pub fn abort_update_transaction(
    root: &Path,
    transaction_id: &str,
) -> Result<UpdateTransaction, String> {
    let mut transaction = current_transaction_for_id(root, transaction_id)?;
    if !matches!(
        transaction.phase,
        UpdateTransactionPhase::Preparing
            | UpdateTransactionPhase::SnapshotReady
            | UpdateTransactionPhase::Downloading
    ) {
        return Err("Only a pre-relaunch update transaction may be aborted.".into());
    }
    transaction.phase = UpdateTransactionPhase::RecoveryRequired;
    transaction.updated_at = timestamp_string(unix_time_ms());
    transaction.failure = Some(UpdateTransactionFailure {
        code: "transaction_cancelled".into(),
        message: "The update attempt was cancelled before relaunch. Its recovery artifacts were retained.".into(),
    });
    // Persist the archived diagnostic first. If removing current.json fails,
    // startup remains conservatively blocked in recovery mode.
    persist_transaction(root, &transaction)?;
    remove_current_transaction(root)?;
    Ok(transaction)
}

/// Abandon an install only after a fresh process has relaunched the original
/// app version. The archived metadata and recovery snapshot are retained, but
/// current.json is removed so normal source-version workspace mutation can
/// resume. A process that initiated the install cannot use this path.
pub fn abandon_update_transaction_after_source_relaunch(
    root: &Path,
    transaction_id: &str,
    running_app_version: &str,
    current_process_id: u32,
) -> Result<UpdateTransaction, String> {
    validate_version(running_app_version, "The running app version")?;
    if current_process_id == 0 {
        return Err("The current process ID is invalid.".into());
    }
    let mut transaction = current_transaction_for_id(root, transaction_id)?;
    if running_app_version != transaction.from_app_version {
        return Err("Only the transaction source app version may abandon this update.".into());
    }
    if !matches!(
        transaction.phase,
        UpdateTransactionPhase::Installing
            | UpdateTransactionPhase::AwaitingRestart
            | UpdateTransactionPhase::RecoveryRequired
    ) {
        return Err(
            "This update transaction is not eligible for source-version abandonment.".into(),
        );
    }
    let Some(installing_process_id) = transaction.installing_process_id else {
        return Err("The update transaction has no durable installing-process marker.".into());
    };
    if installing_process_id == current_process_id {
        return Err("The process performing the install may not abandon its transaction.".into());
    }
    transaction.phase = UpdateTransactionPhase::RecoveryRequired;
    transaction.updated_at = timestamp_string(unix_time_ms());
    transaction.failure = Some(UpdateTransactionFailure {
        code: "source_version_relaunched".into(),
        message: "A fresh source-version process relaunched after the update attempt. The transaction was archived and its recovery artifacts were retained."
            .into(),
    });
    // Archive first. If current.json removal fails, mutation remains blocked.
    persist_transaction(root, &transaction)?;
    remove_current_transaction(root)?;
    Ok(transaction)
}

/// Load and checksum-verify the exact pre-update workspace payload for boot
/// migration and invariant comparison.
pub fn load_pre_update_snapshot(
    root: &Path,
    transaction_id: &str,
) -> Result<LoadedWorkspace, String> {
    let transaction = current_transaction_for_id(root, transaction_id)?;
    verify_snapshot_checksum(root, &transaction).map(|(loaded, _)| loaded)
}

/// Load the checksum-verified managed asset manifest for diagnostics.
pub fn load_update_asset_manifest(
    root: &Path,
    transaction_id: &str,
) -> Result<AssetManifest, String> {
    let transaction = current_transaction_for_id(root, transaction_id)?;
    load_verified_manifest(root, &transaction)
}

/// Require boot verification to run from the app version that the durable
/// transaction targeted. This prevents a still-running source app from
/// advancing an interrupted install into post-update verification.
pub fn assert_update_transaction_target_version(
    root: &Path,
    transaction_id: &str,
    running_app_version: &str,
) -> Result<(), String> {
    validate_version(running_app_version, "The running app version")?;
    let transaction = current_transaction_for_id(root, transaction_id)?;
    if transaction.to_app_version != running_app_version {
        return Err(format!(
            "Update verification requires app version {}, but version {} is running.",
            transaction.to_app_version, running_app_version
        ));
    }
    Ok(())
}

/// Enter post-update verification from any durable phase that may remain
/// after the target bundle has relaunched. The running version check is the
/// authority for recovering interrupted downloading or installing markers.
pub fn begin_update_verification(
    root: &Path,
    transaction_id: &str,
    running_app_version: &str,
) -> Result<UpdateTransaction, String> {
    assert_update_transaction_target_version(root, transaction_id, running_app_version)?;
    let mut transaction = current_transaction_for_id(root, transaction_id)?;
    if transaction.phase == UpdateTransactionPhase::Verifying {
        return Ok(transaction);
    }
    if !matches!(
        transaction.phase,
        UpdateTransactionPhase::SnapshotReady
            | UpdateTransactionPhase::Downloading
            | UpdateTransactionPhase::Installing
            | UpdateTransactionPhase::AwaitingRestart
            | UpdateTransactionPhase::RecoveryRequired
    ) {
        return Err("The update transaction is not ready for boot verification.".into());
    }
    transaction.phase = UpdateTransactionPhase::Verifying;
    transaction.updated_at = timestamp_string(unix_time_ms());
    transaction.failure = None;
    persist_transaction(root, &transaction)?;
    Ok(transaction)
}

/// Move a transaction through an allowlisted forward state transition.
pub fn set_update_transaction_phase(
    root: &Path,
    transaction_id: &str,
    phase: UpdateTransactionPhase,
) -> Result<UpdateTransaction, String> {
    set_update_transaction_phase_inner(root, transaction_id, phase, None)
}

/// Move a transaction through an allowlisted phase while durably binding the
/// install attempt to its source process. Production command wrappers use this
/// entry point so a later source-version process can prove that it is a fresh
/// relaunch rather than the process still performing the install.
pub fn set_update_transaction_phase_for_process(
    root: &Path,
    transaction_id: &str,
    phase: UpdateTransactionPhase,
    process_id: u32,
) -> Result<UpdateTransaction, String> {
    if process_id == 0 {
        return Err("The installing process ID is invalid.".into());
    }
    set_update_transaction_phase_inner(root, transaction_id, phase, Some(process_id))
}

fn set_update_transaction_phase_inner(
    root: &Path,
    transaction_id: &str,
    phase: UpdateTransactionPhase,
    process_id: Option<u32>,
) -> Result<UpdateTransaction, String> {
    let mut transaction = current_transaction_for_id(root, transaction_id)?;
    if !transition_allowed(transaction.phase, phase) {
        return Err(format!(
            "The update transaction cannot move from {:?} to {:?}.",
            transaction.phase, phase
        ));
    }
    if matches!(
        phase,
        UpdateTransactionPhase::Installing | UpdateTransactionPhase::AwaitingRestart
    ) && transaction.installing_process_id.is_none()
    {
        transaction.installing_process_id = process_id;
    }
    transaction.phase = phase;
    transaction.updated_at = timestamp_string(unix_time_ms());
    if phase != UpdateTransactionPhase::RecoveryRequired {
        transaction.failure = None;
    }
    persist_transaction(root, &transaction)?;
    Ok(transaction)
}

/// Record a boot, migration, or verification failure without modifying the
/// primary workspace or any managed asset.
pub fn fail_update_transaction(
    root: &Path,
    transaction_id: &str,
    code: String,
    message: String,
) -> Result<UpdateTransaction, String> {
    if code.is_empty() || code.len() > 128 || message.is_empty() || message.len() > 4096 {
        return Err("The update failure diagnostic is invalid.".into());
    }
    let mut transaction = current_transaction_for_id(root, transaction_id)?;
    if transaction.phase == UpdateTransactionPhase::Complete {
        return Err("A completed update transaction cannot fail.".into());
    }
    transaction.phase = UpdateTransactionPhase::RecoveryRequired;
    transaction.updated_at = timestamp_string(unix_time_ms());
    transaction.failure = Some(UpdateTransactionFailure { code, message });
    persist_transaction(root, &transaction)?;
    Ok(transaction)
}

/// Compare every manifest entry with its managed file without changing asset
/// metadata. A mismatch is returned as a report and durably marks the current
/// transaction as recovery-required.
pub fn verify_update_assets(
    root: &Path,
    transaction_id: String,
) -> Result<AssetVerificationReport, String> {
    let mut transaction = current_transaction_for_id(root, &transaction_id)?;
    if transition_allowed(transaction.phase, UpdateTransactionPhase::Verifying) {
        transaction.phase = UpdateTransactionPhase::Verifying;
        transaction.updated_at = timestamp_string(unix_time_ms());
        transaction.failure = None;
        persist_transaction(root, &transaction)?;
    } else if transaction.phase != UpdateTransactionPhase::Verifying {
        return Err("The update transaction is not ready for asset verification.".into());
    }

    let manifest = match load_update_asset_manifest(root, &transaction_id) {
        Ok(manifest) => manifest,
        Err(error) => {
            let _ = fail_update_transaction(
                root,
                &transaction_id,
                "asset_manifest_invalid".into(),
                error.clone(),
            );
            return Err(error);
        }
    };
    let mut report = AssetVerificationReport {
        schema_version: MANIFEST_SCHEMA_VERSION,
        transaction_id: transaction_id.clone(),
        valid: true,
        total_entries: manifest.entries.len(),
        verified_entries: 0,
        missing_entries: 0,
        changed_entries: 0,
        issues: Vec::new(),
    };
    for entry in manifest.entries {
        let path = match resolve_manifest_path(root, &entry.relative_path) {
            Ok(path) => path,
            Err(message) => {
                report.changed_entries += 1;
                report.issues.push(AssetVerificationIssue {
                    asset_id: entry.asset_id,
                    relative_path: entry.relative_path,
                    code: "unsafe_path".into(),
                    message,
                });
                continue;
            }
        };
        if std::fs::symlink_metadata(&path).is_err() {
            report.missing_entries += 1;
            report.issues.push(AssetVerificationIssue {
                asset_id: entry.asset_id,
                relative_path: entry.relative_path,
                code: "missing".into(),
                message: "The managed asset file is missing.".into(),
            });
            continue;
        }
        let relative = Path::new(&entry.relative_path);
        if let Err(message) = assert_no_symlink_components(root, relative) {
            report.changed_entries += 1;
            report.issues.push(AssetVerificationIssue {
                asset_id: entry.asset_id,
                relative_path: entry.relative_path,
                code: "symlink".into(),
                message,
            });
            continue;
        }
        match regular_file_state(&path) {
            Ok(state) if state.length != entry.byte_size => {
                report.changed_entries += 1;
                report.issues.push(AssetVerificationIssue {
                    asset_id: entry.asset_id,
                    relative_path: entry.relative_path,
                    code: "size_changed".into(),
                    message: format!(
                        "Expected {} bytes, found {} bytes.",
                        entry.byte_size, state.length
                    ),
                });
                continue;
            }
            Ok(_) => {}
            Err(message) => {
                report.changed_entries += 1;
                report.issues.push(AssetVerificationIssue {
                    asset_id: entry.asset_id,
                    relative_path: entry.relative_path,
                    code: "unreadable".into(),
                    message,
                });
                continue;
            }
        }
        match hash_regular_file(&path) {
            Ok((byte_size, actual_sha256))
                if byte_size == entry.byte_size && actual_sha256 == entry.sha256 =>
            {
                report.verified_entries += 1;
            }
            Ok((byte_size, actual_sha256)) => {
                report.changed_entries += 1;
                report.issues.push(AssetVerificationIssue {
                    asset_id: entry.asset_id,
                    relative_path: entry.relative_path,
                    code: if byte_size != entry.byte_size {
                        "size_changed".into()
                    } else {
                        "checksum_changed".into()
                    },
                    message: format!(
                        "Expected {} bytes with SHA-256 {}, found {} bytes with SHA-256 {}.",
                        entry.byte_size, entry.sha256, byte_size, actual_sha256
                    ),
                });
            }
            Err(message) => {
                report.changed_entries += 1;
                report.issues.push(AssetVerificationIssue {
                    asset_id: entry.asset_id,
                    relative_path: entry.relative_path,
                    code: "unreadable_or_changing".into(),
                    message,
                });
            }
        }
    }
    report.valid = report.issues.is_empty() && report.verified_entries == report.total_entries;
    if !report.valid {
        let message = format!(
            "Managed asset verification failed for {} of {} files.",
            report.issues.len(),
            report.total_entries
        );
        fail_update_transaction(
            root,
            &transaction_id,
            "asset_verification_failed".into(),
            message,
        )?;
    }
    Ok(report)
}

/// Remove only expired completed transaction artifacts while retaining the
/// newest successful snapshots and every current or pending transaction.
/// Managed asset roots are never traversed by this cleanup.
pub fn cleanup_completed_update_snapshots(root: &Path) -> Result<usize, String> {
    prepare_directories(root)?;
    let current = read_current_transaction(root)?;
    if current
        .as_ref()
        .is_some_and(|transaction| transaction.phase != UpdateTransactionPhase::Complete)
    {
        return Err(
            "Completed update snapshots cannot be cleaned while an update is pending.".into(),
        );
    }
    let current_id = current.as_ref().map(|transaction| transaction.id.as_str());
    let history_directory = transaction_history_directory(root);
    let now = unix_time_ms();
    let mut completed = Vec::new();
    for entry in std::fs::read_dir(&history_directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let metadata =
            std::fs::symlink_metadata(entry.path()).map_err(|error| error.to_string())?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            continue;
        }
        if let Ok(transaction) = read_transaction(&entry.path()) {
            if transaction.phase == UpdateTransactionPhase::Complete {
                let modified_at_ms = metadata
                    .modified()
                    .ok()
                    .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
                    .unwrap_or_default();
                completed.push((transaction, modified_at_ms));
            }
        }
    }
    completed.sort_by_key(|entry| std::cmp::Reverse(entry.1));
    let mut removed = 0;
    for (transaction, modified_at_ms) in completed.into_iter().skip(COMPLETED_SNAPSHOT_RETENTION) {
        if current_id == Some(transaction.id.as_str())
            || now.saturating_sub(modified_at_ms) < COMPLETED_SNAPSHOT_MIN_AGE_MS
        {
            continue;
        }
        let directory = transaction_snapshot_directory(root, &transaction.id)?;
        let metadata = match std::fs::symlink_metadata(&directory) {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            continue;
        }
        let known_files = [
            WORKSPACE_SNAPSHOT_FILE,
            ASSET_MANIFEST_FILE,
            TRANSACTION_METADATA_FILE,
        ];
        let mut directory_is_removable = true;
        for entry in std::fs::read_dir(&directory).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let entry_metadata =
                std::fs::symlink_metadata(entry.path()).map_err(|error| error.to_string())?;
            let known_name = entry
                .file_name()
                .to_str()
                .is_some_and(|name| known_files.contains(&name));
            if !known_name || entry_metadata.file_type().is_symlink() || !entry_metadata.is_file() {
                directory_is_removable = false;
                break;
            }
        }
        if !directory_is_removable {
            continue;
        }
        for file in known_files {
            let path = directory.join(file);
            if std::fs::symlink_metadata(&path).is_ok_and(|value| value.is_file()) {
                std::fs::remove_file(path).map_err(|error| error.to_string())?;
            }
        }
        if std::fs::read_dir(&directory)
            .map_err(|error| error.to_string())?
            .next()
            .is_none()
        {
            std::fs::remove_dir(&directory).map_err(|error| error.to_string())?;
        } else {
            // A concurrent or unexpected artifact appeared after the
            // preflight. Keep history as an index to what remains.
            continue;
        }
        let history = history_transaction_path(root, &transaction.id)?;
        if std::fs::symlink_metadata(&history).is_ok_and(|value| value.is_file()) {
            std::fs::remove_file(history).map_err(|error| error.to_string())?;
        }
        workspace_storage::sync_private_directory(&snapshots_directory(root))?;
        workspace_storage::sync_private_directory(&history_directory)?;
        removed += 1;
    }
    Ok(removed)
}

fn record_workspace_transaction_failure(
    root: &Path,
    transaction_id: &str,
    code: &str,
    message: String,
) -> String {
    let _ = fail_update_transaction(root, transaction_id, code.to_string(), message.clone());
    message
}

/// Persist one final migrated workspace for the exact transaction currently
/// in verification, after rechecking its snapshot and every managed asset.
///
/// The canonical payload checksum is durably recorded before the primary
/// workspace is replaced. A retry with the same payload is a no-op when the
/// primary already matches the receipt, so rolling backups are not rotated a
/// second time. A different candidate or an unrelated current workspace is
/// rejected without replacing the primary.
pub fn save_verified_update_workspace(
    root: &Path,
    transaction_id: &str,
    payload: Value,
) -> Result<StorageStatus, String> {
    let mut transaction = current_transaction_for_id(root, transaction_id)?;
    if transaction.phase != UpdateTransactionPhase::Verifying {
        return Err("The update transaction is not in workspace verification.".into());
    }
    let candidate_schema = studio_schema(&payload)?;
    if candidate_schema != transaction.target_studio_schema {
        return Err("The migrated workspace does not match the transaction target schema.".into());
    }
    let candidate_checksum = canonical_payload_checksum(&payload)?;
    let (_, snapshot_bytes) = verify_snapshot_checksum(root, &transaction)?;
    let asset_report = verify_update_assets(root, transaction_id.to_string())?;
    if !asset_report.valid {
        return Err(
            "Managed assets must pass verification before the migrated workspace is saved.".into(),
        );
    }
    transaction = current_transaction_for_id(root, transaction_id)?;
    let (current, current_bytes) = current_workspace(root).map_err(|error| {
        record_workspace_transaction_failure(
            root,
            transaction_id,
            "primary_workspace_invalid",
            error,
        )
    })?;
    let current_schema = studio_schema(&current.payload).map_err(|error| {
        record_workspace_transaction_failure(
            root,
            transaction_id,
            "primary_workspace_invalid",
            error,
        )
    })?;
    let current_matches_candidate =
        current.checksum == candidate_checksum && current_schema == candidate_schema;
    let current_matches_snapshot = current_bytes == snapshot_bytes;

    let receipt = match transaction.migrated_workspace.clone() {
        Some(receipt)
            if receipt.payload_checksum == candidate_checksum
                && receipt.studio_schema == candidate_schema =>
        {
            receipt
        }
        Some(_) => {
            let message =
                "The migrated workspace candidate differs from the durable update receipt."
                    .to_string();
            return Err(record_workspace_transaction_failure(
                root,
                transaction_id,
                "migrated_workspace_candidate_changed",
                message,
            ));
        }
        None if current_matches_snapshot || current_matches_candidate => {
            let receipt = MigratedWorkspaceReceipt {
                studio_schema: candidate_schema,
                payload_checksum: candidate_checksum.clone(),
            };
            transaction.migrated_workspace = Some(receipt.clone());
            transaction.updated_at = timestamp_string(unix_time_ms());
            transaction.failure = None;
            // This receipt is the write-ahead commit intent. The primary must
            // not be replaced unless all three durable transaction copies have
            // been updated successfully.
            persist_transaction(root, &transaction)?;
            receipt
        }
        None => {
            let message = "The primary workspace differs from both the pre-update snapshot and the migrated candidate."
                .to_string();
            return Err(record_workspace_transaction_failure(
                root,
                transaction_id,
                "primary_workspace_diverged",
                message,
            ));
        }
    };

    if current.checksum == receipt.payload_checksum && current_schema == receipt.studio_schema {
        return current_storage_status(root, &current, &current_bytes);
    }
    if !current_matches_snapshot {
        let message =
            "The primary workspace no longer matches the pre-update snapshot or migrated receipt."
                .to_string();
        return Err(record_workspace_transaction_failure(
            root,
            transaction_id,
            "primary_workspace_diverged",
            message,
        ));
    }

    let status = workspace_storage::save(root, payload).map_err(|error| {
        record_workspace_transaction_failure(
            root,
            transaction_id,
            "migrated_workspace_write_failed",
            error,
        )
    })?;
    let (saved, _) = current_workspace(root).map_err(|error| {
        record_workspace_transaction_failure(
            root,
            transaction_id,
            "migrated_workspace_readback_failed",
            error,
        )
    })?;
    if status.checksum != receipt.payload_checksum
        || saved.checksum != receipt.payload_checksum
        || studio_schema(&saved.payload)? != receipt.studio_schema
    {
        let message =
            "The migrated workspace did not match its durable receipt after saving.".to_string();
        return Err(record_workspace_transaction_failure(
            root,
            transaction_id,
            "migrated_workspace_readback_failed",
            message,
        ));
    }
    Ok(status)
}

/// Mark a transaction complete only when the primary workspace matches the
/// durable migrated-workspace receipt. Cleanup never traverses or targets
/// managed asset roots.
pub fn complete_update_transaction(root: &Path, transaction_id: String) -> Result<(), String> {
    let transaction = current_transaction_for_id(root, &transaction_id)?;
    if transaction.phase != UpdateTransactionPhase::Verifying {
        return Err("The update transaction must be verified before completion.".into());
    }
    verify_snapshot_checksum(root, &transaction)?;
    let report = verify_update_assets(root, transaction_id.clone())?;
    if !report.valid {
        return Err("Managed assets must pass verification before update completion.".into());
    }
    let mut transaction = current_transaction_for_id(root, &transaction_id)?;
    let Some(receipt) = transaction.migrated_workspace.clone() else {
        let message =
            "The update transaction has no durable migrated workspace receipt.".to_string();
        return Err(record_workspace_transaction_failure(
            root,
            &transaction_id,
            "migrated_workspace_receipt_missing",
            message,
        ));
    };
    let (current, _) = current_workspace(root).map_err(|error| {
        record_workspace_transaction_failure(
            root,
            &transaction_id,
            "primary_workspace_invalid",
            error,
        )
    })?;
    let current_schema = studio_schema(&current.payload).map_err(|error| {
        record_workspace_transaction_failure(
            root,
            &transaction_id,
            "primary_workspace_invalid",
            error,
        )
    })?;
    if current.checksum != receipt.payload_checksum
        || current_schema != receipt.studio_schema
        || current_schema != transaction.target_studio_schema
    {
        let message =
            "The primary workspace does not match the durable migrated workspace receipt."
                .to_string();
        return Err(record_workspace_transaction_failure(
            root,
            &transaction_id,
            "primary_workspace_diverged",
            message,
        ));
    }
    transaction.phase = UpdateTransactionPhase::Complete;
    transaction.updated_at = timestamp_string(unix_time_ms());
    transaction.failure = None;
    persist_transaction(root, &transaction)?;
    Ok(())
}

/// Restore exact pre-update envelope bytes after preserving the current bytes
/// as a transaction-local diagnostic snapshot.
pub fn restore_pre_update_snapshot(
    root: &Path,
    transaction_id: String,
) -> Result<StorageStatus, String> {
    let transaction = transaction_for_recovery(root, &transaction_id)?;
    verify_snapshot_checksum(root, &transaction)?;
    let snapshot_directory = transaction_snapshot_directory(root, &transaction.id)?;
    let current = workspace_storage::current_state_file(root)?;
    if std::fs::symlink_metadata(&current).is_ok() {
        workspace_storage::atomic_copy_private(
            &current,
            &snapshot_directory.join(DIAGNOSTIC_WORKSPACE_FILE),
        )?;
    }
    let status = workspace_storage::restore_exact_snapshot(
        root,
        &workspace_snapshot_path(root, &transaction.id)?,
    )?;
    if read_current_transaction(root)?
        .as_ref()
        .map(|value| value.id.as_str())
        == Some(transaction.id.as_str())
        && transaction.phase != UpdateTransactionPhase::Complete
    {
        let _ = fail_update_transaction(
            root,
            &transaction.id,
            "workspace_restored".into(),
            "The exact pre-update workspace was restored. Migration must be verified before normal mode resumes.".into(),
        );
    }
    Ok(status)
}

fn export_destination(downloads: &Path, transaction_id: &str) -> Result<PathBuf, String> {
    if let Ok(metadata) = std::fs::symlink_metadata(downloads) {
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(format!("{} must be a directory.", downloads.display()));
        }
    }
    std::fs::create_dir_all(downloads).map_err(|error| error.to_string())?;
    let base = format!("fruit-truck-pre-update-{transaction_id}");
    for suffix in 0u32.. {
        let name = if suffix == 0 {
            format!("{base}.json")
        } else {
            format!("{base} ({suffix}).json")
        };
        let destination = downloads.join(name);
        if std::fs::symlink_metadata(&destination).is_err() {
            return Ok(destination);
        }
    }
    unreachable!("the export suffix space is finite only after filesystem exhaustion")
}

/// Export exact pre-update workspace bytes to an allowlisted Downloads root.
pub fn export_pre_update_snapshot(
    root: &Path,
    downloads: &Path,
    transaction_id: String,
) -> Result<String, String> {
    let transaction = transaction_for_recovery(root, &transaction_id)?;
    verify_snapshot_checksum(root, &transaction)?;
    let destination = export_destination(downloads, &transaction.id)?;
    workspace_storage::atomic_copy_private(
        &workspace_snapshot_path(root, &transaction.id)?,
        &destination,
    )?;
    Ok(destination.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::atomic::{AtomicBool, Ordering};

    fn temp_root() -> tempfile::TempDir {
        tempfile::tempdir().expect("temporary root")
    }

    fn test_payload(root: &Path) -> Value {
        let upload = root.join("assets/reference.png");
        let generated = root.join("generated/result.mp4");
        serde_json::json!({
            "schemaVersion": 6,
            "activeSessionId": "session-one",
            "sessions": [{
                "id": "session-one",
                "assets": [
                    {"id": "upload-one", "kind": "image", "origin": "upload", "localPath": upload},
                    {"id": "result-one", "kind": "video", "origin": "generated", "localPath": generated},
                    {"id": "remote-one", "kind": "image", "origin": "upload", "externalUrl": "https://example.invalid/image.png"}
                ]
            }]
        })
    }

    fn prepare_workspace(root: &Path) -> Vec<u8> {
        workspace_storage::ensure_private_directory(&root.join("assets"))
            .expect("assets directory");
        workspace_storage::ensure_private_directory(&root.join("generated"))
            .expect("generated directory");
        std::fs::write(root.join("assets/reference.png"), b"reference-bytes").expect("upload");
        std::fs::write(root.join("generated/result.mp4"), b"generated-bytes").expect("generated");
        workspace_storage::save(root, test_payload(root)).expect("save workspace");
        let current = workspace_storage::current_state_file(root).expect("current path");
        std::fs::read(current).expect("current bytes")
    }

    fn create_transaction(root: &Path) -> UpdateTransaction {
        create_pre_update_snapshot(root, "0.6.7".into(), "0.8.0".into())
            .expect("create transaction")
    }

    fn migrated_payload() -> Value {
        serde_json::json!({"schemaVersion": 8, "sessions": []})
    }

    fn enter_verifying(root: &Path, transaction_id: &str) {
        set_update_transaction_phase(root, transaction_id, UpdateTransactionPhase::Verifying)
            .expect("verifying");
    }

    fn save_migrated_workspace(root: &Path, transaction_id: &str) -> Value {
        let migrated = migrated_payload();
        save_verified_update_workspace(root, transaction_id, migrated.clone())
            .expect("verified save");
        migrated
    }

    fn optional_file_bytes(path: &Path) -> Option<Vec<u8>> {
        std::fs::symlink_metadata(path)
            .ok()
            .map(|_| std::fs::read(path).expect("file bytes"))
    }

    fn set_file_age(path: &Path, age: std::time::Duration) {
        let modified = std::time::SystemTime::now()
            .checked_sub(age)
            .expect("old modified time");
        let file = std::fs::OpenOptions::new()
            .write(true)
            .open(path)
            .expect("open for timestamp");
        file.set_times(std::fs::FileTimes::new().set_modified(modified))
            .expect("set modified time");
    }

    fn create_completed_transaction(root: &Path) -> UpdateTransaction {
        let transaction = create_transaction(root);
        enter_verifying(root, &transaction.id);
        save_migrated_workspace(root, &transaction.id);
        complete_update_transaction(root, transaction.id.clone()).expect("complete transaction");
        transaction
    }

    #[test]
    fn snapshot_preserves_exact_envelope_bytes_and_manifest_hashes() {
        let root = temp_root();
        let expected = prepare_workspace(root.path());
        let transaction = create_transaction(root.path());
        let snapshot =
            workspace_snapshot_path(root.path(), &transaction.id).expect("snapshot path");
        assert_eq!(std::fs::read(snapshot).expect("snapshot bytes"), expected);
        assert_eq!(transaction.snapshot_checksum, sha256(&expected));
        let manifest = load_update_asset_manifest(root.path(), &transaction.id).expect("manifest");
        assert_eq!(manifest.entries.len(), 2);
        assert_eq!(manifest.entries[0].asset_id, "result-one");
        assert_eq!(manifest.entries[1].asset_id, "upload-one");
        assert!(manifest.entries.iter().all(|entry| {
            entry.relative_path.starts_with("assets/")
                || entry.relative_path.starts_with("generated/")
        }));
    }

    #[test]
    fn snapshot_checksum_tampering_is_rejected() {
        let root = temp_root();
        prepare_workspace(root.path());
        let transaction = create_transaction(root.path());
        let snapshot =
            workspace_snapshot_path(root.path(), &transaction.id).expect("snapshot path");
        let mut bytes = std::fs::read(&snapshot).expect("snapshot");
        bytes.push(b' ');
        std::fs::write(snapshot, bytes).expect("tamper snapshot");
        assert!(load_pre_update_snapshot(root.path(), &transaction.id)
            .expect_err("checksum failure")
            .contains("checksum"));
    }

    #[cfg(unix)]
    #[test]
    fn symlink_asset_is_rejected_before_transaction_is_published() {
        use std::os::unix::fs::symlink;

        let root = temp_root();
        workspace_storage::ensure_private_directory(&root.path().join("assets")).expect("assets");
        workspace_storage::ensure_private_directory(&root.path().join("generated"))
            .expect("generated");
        std::fs::write(root.path().join("outside.png"), b"outside").expect("outside");
        symlink(
            root.path().join("outside.png"),
            root.path().join("assets/reference.png"),
        )
        .expect("symlink");
        workspace_storage::save(root.path(), test_payload(root.path())).expect("save workspace");
        let error = create_pre_update_snapshot(root.path(), "0.6.7".into(), "0.8.0".into())
            .expect_err("symlink rejection");
        assert!(error.contains("symlink"));
        assert!(load_pending_update_transaction(root.path())
            .expect("load")
            .is_none());
    }

    #[test]
    fn manifest_path_traversal_is_rejected() {
        let root = temp_root();
        prepare_workspace(root.path());
        let transaction = create_transaction(root.path());
        let manifest_path =
            asset_manifest_path(root.path(), &transaction.id).expect("manifest path");
        let (mut manifest, _): (AssetManifest, Vec<u8>) =
            read_private_json(&manifest_path).expect("manifest");
        manifest.entries[0].relative_path = "assets/../credentials.json".into();
        let bytes = write_json(&manifest_path, &manifest).expect("tampered manifest");
        let mut current =
            current_transaction_for_id(root.path(), &transaction.id).expect("transaction");
        current.asset_manifest_checksum = sha256(bytes);
        persist_transaction(root.path(), &current).expect("update transaction checksum");
        let error = verify_update_assets(root.path(), transaction.id)
            .expect_err("path traversal rejection");
        assert!(error.contains("traversal"));
    }

    #[test]
    fn asset_mutation_during_both_hash_attempts_is_rejected() {
        let root = temp_root();
        let path = root.path().join("changing.bin");
        std::fs::write(&path, b"initial").expect("initial");
        let error = hash_regular_file_with_hook(&path, |attempt, path| {
            let mut file = std::fs::OpenOptions::new()
                .append(true)
                .open(path)
                .map_err(|error| error.to_string())?;
            file.write_all(&[attempt as u8])
                .map_err(|error| error.to_string())
        })
        .expect_err("changing file");
        assert!(error.contains("changed while"));
    }

    #[test]
    fn failed_atomic_snapshot_write_cleans_its_temporary_file() {
        let root = temp_root();
        workspace_storage::ensure_private_directory(root.path()).expect("root");
        let destination = root.path().join("destination");
        workspace_storage::ensure_private_directory(&destination).expect("destination directory");
        assert!(workspace_storage::atomic_write_private(&destination, b"bytes").is_err());
        let temporary_files = std::fs::read_dir(root.path())
            .expect("read root")
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(temporary_files, 0);
    }

    #[test]
    fn restore_preserves_exact_pre_update_bytes_and_keeps_diagnostic() {
        let root = temp_root();
        let expected = prepare_workspace(root.path());
        let transaction = create_transaction(root.path());
        workspace_storage::save(
            root.path(),
            serde_json::json!({"schemaVersion": 8, "sessions": []}),
        )
        .expect("replace workspace");
        let replaced = std::fs::read(
            workspace_storage::current_state_file(root.path()).expect("current path"),
        )
        .expect("replaced bytes");
        restore_pre_update_snapshot(root.path(), transaction.id.clone()).expect("restore");
        let current = std::fs::read(
            workspace_storage::current_state_file(root.path()).expect("current path"),
        )
        .expect("current bytes");
        assert_eq!(current, expected);
        let diagnostic = transaction_snapshot_directory(root.path(), &transaction.id)
            .expect("snapshot directory")
            .join(DIAGNOSTIC_WORKSPACE_FILE);
        assert_eq!(std::fs::read(diagnostic).expect("diagnostic"), replaced);
    }

    #[test]
    fn changed_asset_returns_recovery_report_without_touching_asset() {
        let root = temp_root();
        prepare_workspace(root.path());
        let transaction = create_transaction(root.path());
        set_update_transaction_phase(
            root.path(),
            &transaction.id,
            UpdateTransactionPhase::AwaitingRestart,
        )
        .expect("awaiting restart");
        std::fs::write(root.path().join("assets/reference.png"), b"changed").expect("change asset");
        let report = verify_update_assets(root.path(), transaction.id.clone()).expect("report");
        assert!(!report.valid);
        assert_eq!(report.changed_entries, 1);
        assert_eq!(
            load_pending_update_transaction(root.path())
                .expect("pending")
                .expect("transaction")
                .phase,
            UpdateTransactionPhase::RecoveryRequired
        );
        assert_eq!(
            std::fs::read(root.path().join("assets/reference.png")).expect("asset"),
            b"changed"
        );
    }

    #[test]
    fn retry_supersedes_pending_transaction_with_a_fresh_snapshot() {
        let root = temp_root();
        prepare_workspace(root.path());
        let first = create_transaction(root.path());
        let first_snapshot =
            workspace_snapshot_path(root.path(), &first.id).expect("first snapshot path");
        let first_bytes = std::fs::read(&first_snapshot).expect("first snapshot bytes");

        workspace_storage::save(
            root.path(),
            serde_json::json!({"schemaVersion": 7, "sessions": []}),
        )
        .expect("changed workspace");
        let second = create_transaction(root.path());

        assert_ne!(second.id, first.id);
        assert_eq!(
            std::fs::read(first_snapshot).expect("retained first snapshot"),
            first_bytes
        );
        let archived = read_transaction(
            &history_transaction_path(root.path(), &first.id).expect("history path"),
        )
        .expect("archived transaction");
        assert_eq!(archived.phase, UpdateTransactionPhase::RecoveryRequired);
        assert_eq!(
            archived.failure.expect("superseded failure").code,
            "transaction_superseded"
        );
        assert_eq!(
            load_pending_update_transaction(root.path())
                .expect("pending")
                .expect("new current")
                .id,
            second.id
        );
    }

    #[test]
    fn abort_clears_only_current_pointer_and_retains_recovery_artifacts() {
        let root = temp_root();
        let expected = prepare_workspace(root.path());
        let transaction = create_transaction(root.path());
        set_update_transaction_phase(
            root.path(),
            &transaction.id,
            UpdateTransactionPhase::Downloading,
        )
        .expect("downloading");

        let aborted = abort_update_transaction(root.path(), &transaction.id).expect("abort");
        assert_eq!(aborted.phase, UpdateTransactionPhase::RecoveryRequired);
        assert_eq!(
            aborted.failure.expect("cancellation diagnostic").code,
            "transaction_cancelled"
        );
        assert!(load_pending_update_transaction(root.path())
            .expect("pending")
            .is_none());
        assert!(!update_transaction_blocks_mutation(root.path()).expect("mutation guard"));
        assert_eq!(
            std::fs::read(
                workspace_snapshot_path(root.path(), &transaction.id).expect("snapshot path")
            )
            .expect("retained snapshot"),
            expected
        );
        let archived = read_transaction(
            &history_transaction_path(root.path(), &transaction.id).expect("history path"),
        )
        .expect("archived transaction");
        assert_eq!(archived.phase, UpdateTransactionPhase::RecoveryRequired);
        assert_eq!(
            transaction_for_recovery(root.path(), &transaction.id)
                .expect("recoverable transaction")
                .id,
            transaction.id
        );
        let downloads = root.path().join("Downloads");
        let exported = export_pre_update_snapshot(root.path(), &downloads, transaction.id.clone())
            .expect("export archived snapshot");
        assert_eq!(std::fs::read(exported).expect("exported bytes"), expected);
    }

    #[test]
    fn abort_rejects_post_relaunch_and_recovery_phases() {
        for forbidden_phase in [
            UpdateTransactionPhase::Installing,
            UpdateTransactionPhase::AwaitingRestart,
            UpdateTransactionPhase::Verifying,
            UpdateTransactionPhase::RecoveryRequired,
            UpdateTransactionPhase::Complete,
        ] {
            let root = temp_root();
            prepare_workspace(root.path());
            let transaction = create_transaction(root.path());
            match forbidden_phase {
                UpdateTransactionPhase::Installing => {
                    set_update_transaction_phase(
                        root.path(),
                        &transaction.id,
                        UpdateTransactionPhase::Downloading,
                    )
                    .expect("downloading");
                    set_update_transaction_phase(
                        root.path(),
                        &transaction.id,
                        UpdateTransactionPhase::Installing,
                    )
                    .expect("installing");
                }
                UpdateTransactionPhase::AwaitingRestart => {
                    set_update_transaction_phase(
                        root.path(),
                        &transaction.id,
                        UpdateTransactionPhase::AwaitingRestart,
                    )
                    .expect("awaiting restart");
                }
                UpdateTransactionPhase::Verifying => {
                    set_update_transaction_phase(
                        root.path(),
                        &transaction.id,
                        UpdateTransactionPhase::Verifying,
                    )
                    .expect("verifying");
                }
                UpdateTransactionPhase::RecoveryRequired => {
                    fail_update_transaction(
                        root.path(),
                        &transaction.id,
                        "test_failure".into(),
                        "Test recovery state.".into(),
                    )
                    .expect("recovery required");
                }
                UpdateTransactionPhase::Complete => {
                    enter_verifying(root.path(), &transaction.id);
                    save_migrated_workspace(root.path(), &transaction.id);
                    complete_update_transaction(root.path(), transaction.id.clone())
                        .expect("complete");
                }
                _ => unreachable!(),
            }
            assert!(abort_update_transaction(root.path(), &transaction.id).is_err());
        }
    }

    #[test]
    fn abort_accepts_every_pre_relaunch_phase() {
        for allowed_phase in [
            UpdateTransactionPhase::Preparing,
            UpdateTransactionPhase::SnapshotReady,
            UpdateTransactionPhase::Downloading,
        ] {
            let root = temp_root();
            prepare_workspace(root.path());
            let mut transaction = create_transaction(root.path());
            match allowed_phase {
                UpdateTransactionPhase::Preparing => {
                    transaction.phase = UpdateTransactionPhase::Preparing;
                    persist_transaction(root.path(), &transaction).expect("preparing");
                }
                UpdateTransactionPhase::SnapshotReady => {}
                UpdateTransactionPhase::Downloading => {
                    set_update_transaction_phase(
                        root.path(),
                        &transaction.id,
                        UpdateTransactionPhase::Downloading,
                    )
                    .expect("downloading");
                }
                _ => unreachable!(),
            }
            assert!(abort_update_transaction(root.path(), &transaction.id).is_ok());
            assert!(load_pending_update_transaction(root.path())
                .expect("pending")
                .is_none());
        }
    }

    #[test]
    fn transaction_ids_and_phase_transitions_are_allowlisted() {
        let root = temp_root();
        prepare_workspace(root.path());
        let transaction = create_transaction(root.path());
        assert!(restore_pre_update_snapshot(root.path(), "../escape".into()).is_err());
        assert!(set_update_transaction_phase(
            root.path(),
            &transaction.id,
            UpdateTransactionPhase::Complete,
        )
        .is_err());
        set_update_transaction_phase(
            root.path(),
            &transaction.id,
            UpdateTransactionPhase::Downloading,
        )
        .expect("downloading");
        set_update_transaction_phase(
            root.path(),
            &transaction.id,
            UpdateTransactionPhase::Installing,
        )
        .expect("installing");
        set_update_transaction_phase(
            root.path(),
            &transaction.id,
            UpdateTransactionPhase::AwaitingRestart,
        )
        .expect("awaiting restart");
        verify_update_assets(root.path(), transaction.id.clone()).expect("verify");
        save_migrated_workspace(root.path(), &transaction.id);
        assert!(set_update_transaction_phase(
            root.path(),
            &transaction.id,
            UpdateTransactionPhase::Complete,
        )
        .is_err());
        complete_update_transaction(root.path(), transaction.id).expect("complete");
        assert!(load_pending_update_transaction(root.path())
            .expect("pending")
            .is_none());
    }

    #[test]
    fn temporary_referenced_assets_are_not_manifested() {
        let root = temp_root();
        workspace_storage::ensure_private_directory(&root.path().join("assets")).expect("assets");
        workspace_storage::ensure_private_directory(&root.path().join("generated"))
            .expect("generated");
        let partial = root.path().join("assets/.upload-test.part");
        std::fs::write(&partial, b"partial").expect("partial");
        let payload = serde_json::json!({
            "schemaVersion": 6,
            "sessions": [{"assets": [{
                "id": "partial", "kind": "image", "origin": "upload", "localPath": partial
            }]}]
        });
        workspace_storage::save(root.path(), payload).expect("save");
        let transaction = create_transaction(root.path());
        assert!(load_update_asset_manifest(root.path(), &transaction.id)
            .expect("manifest")
            .entries
            .is_empty());
    }

    #[test]
    fn hashing_reports_byte_progress_without_absolute_paths() {
        let root = temp_root();
        prepare_workspace(root.path());
        let large_asset = vec![b'x'; HASH_BUFFER_BYTES * 2 + 17];
        std::fs::write(root.path().join("assets/reference.png"), &large_asset)
            .expect("large asset");
        let mut progress = Vec::new();
        create_pre_update_snapshot_with_observer(
            root.path(),
            "0.6.7".into(),
            "0.8.0".into(),
            |event| {
                progress.push(event);
                Ok(())
            },
            || false,
        )
        .expect("snapshot with progress");

        let upload_events: Vec<_> = progress
            .iter()
            .filter(|event| event.asset_id.as_deref() == Some("upload-one"))
            .collect();
        assert!(upload_events.len() >= 4);
        assert_eq!(upload_events.first().expect("first").asset_bytes_hashed, 0);
        assert_eq!(
            upload_events.last().expect("last").asset_bytes_hashed,
            large_asset.len() as u64
        );
        assert!(upload_events
            .windows(2)
            .all(|events| events[0].asset_bytes_hashed <= events[1].asset_bytes_hashed));
        assert!(progress
            .iter()
            .all(|event| match event.relative_path.as_deref() {
                Some(path) => !Path::new(path).is_absolute(),
                None => true,
            }));
    }

    #[test]
    fn cancellation_during_large_asset_hash_leaves_no_pending_transaction() {
        let root = temp_root();
        prepare_workspace(root.path());
        let large_asset = vec![b'z'; HASH_BUFFER_BYTES * 3];
        let asset_path = root.path().join("assets/reference.png");
        std::fs::write(&asset_path, &large_asset).expect("large asset");
        let current_path = workspace_storage::current_state_file(root.path()).expect("current");
        let workspace_before = std::fs::read(&current_path).expect("workspace before");
        let cancelled = AtomicBool::new(false);

        let error = create_pre_update_snapshot_with_observer(
            root.path(),
            "0.6.7".into(),
            "0.8.0".into(),
            |event| {
                if event.asset_bytes_hashed >= HASH_BUFFER_BYTES as u64 {
                    cancelled.store(true, Ordering::SeqCst);
                }
                Ok(())
            },
            || cancelled.load(Ordering::SeqCst),
        )
        .expect_err("cancelled snapshot");

        assert_eq!(error, PREPARATION_CANCELLED_ERROR);
        assert_eq!(
            std::fs::read(current_path).expect("workspace after"),
            workspace_before
        );
        assert_eq!(std::fs::read(asset_path).expect("asset after"), large_asset);
        assert!(load_pending_update_transaction(root.path())
            .expect("pending")
            .is_none());
        assert_eq!(
            std::fs::read_dir(transaction_history_directory(root.path()))
                .expect("history")
                .count(),
            0
        );
        assert_eq!(
            std::fs::read_dir(snapshots_directory(root.path()))
                .expect("snapshots")
                .count(),
            0
        );
    }

    #[test]
    fn verified_update_save_requires_verifying_phase_and_intact_assets() {
        let root = temp_root();
        let original = prepare_workspace(root.path());
        let transaction = create_transaction(root.path());
        let migrated = serde_json::json!({"schemaVersion": 8, "sessions": []});
        assert!(
            save_verified_update_workspace(root.path(), &transaction.id, migrated.clone(),)
                .is_err()
        );
        assert_eq!(
            std::fs::read(
                workspace_storage::current_state_file(root.path()).expect("current path")
            )
            .expect("current bytes"),
            original
        );

        set_update_transaction_phase(
            root.path(),
            &transaction.id,
            UpdateTransactionPhase::Verifying,
        )
        .expect("verifying");
        save_verified_update_workspace(root.path(), &transaction.id, migrated.clone())
            .expect("verified save");
        assert_eq!(
            workspace_storage::load(root.path())
                .expect("load")
                .expect("workspace")
                .payload,
            migrated
        );
    }

    #[test]
    fn verified_update_save_preserves_primary_when_an_asset_changed() {
        let root = temp_root();
        let original = prepare_workspace(root.path());
        let transaction = create_transaction(root.path());
        set_update_transaction_phase(
            root.path(),
            &transaction.id,
            UpdateTransactionPhase::Verifying,
        )
        .expect("verifying");
        std::fs::write(root.path().join("assets/reference.png"), b"changed")
            .expect("changed asset");

        assert!(save_verified_update_workspace(
            root.path(),
            &transaction.id,
            serde_json::json!({"schemaVersion": 8, "sessions": []}),
        )
        .is_err());
        assert_eq!(
            std::fs::read(
                workspace_storage::current_state_file(root.path()).expect("current path")
            )
            .expect("current bytes"),
            original
        );
        assert_eq!(
            load_pending_update_transaction(root.path())
                .expect("pending")
                .expect("transaction")
                .phase,
            UpdateTransactionPhase::RecoveryRequired
        );
    }

    #[test]
    fn verified_workspace_retry_is_idempotent_without_rotating_backups() {
        let root = temp_root();
        prepare_workspace(root.path());
        let transaction = create_transaction(root.path());
        enter_verifying(root.path(), &transaction.id);
        let migrated = save_migrated_workspace(root.path(), &transaction.id);
        let current_path = workspace_storage::current_state_file(root.path()).expect("current");
        let health = workspace_storage::health(root.path()).expect("health");
        let current_before = std::fs::read(&current_path).expect("current bytes");
        let backups_before: Vec<_> = health
            .backup_paths
            .iter()
            .map(|path| optional_file_bytes(Path::new(path)))
            .collect();

        let status = save_verified_update_workspace(root.path(), &transaction.id, migrated.clone())
            .expect("idempotent save");

        assert_eq!(
            status.checksum,
            canonical_payload_checksum(&migrated).unwrap()
        );
        assert_eq!(
            std::fs::read(current_path).expect("current after retry"),
            current_before
        );
        assert_eq!(
            health
                .backup_paths
                .iter()
                .map(|path| optional_file_bytes(Path::new(path)))
                .collect::<Vec<_>>(),
            backups_before
        );
        let pending = current_transaction_for_id(root.path(), &transaction.id).expect("pending");
        assert_eq!(
            pending.migrated_workspace,
            Some(MigratedWorkspaceReceipt {
                studio_schema: 8,
                payload_checksum: canonical_payload_checksum(&migrated).unwrap(),
            })
        );
        complete_update_transaction(root.path(), transaction.id).expect("complete after retry");
    }

    #[test]
    fn durable_receipt_resumes_a_workspace_write_after_interruption() {
        let root = temp_root();
        let original = prepare_workspace(root.path());
        let transaction = create_transaction(root.path());
        enter_verifying(root.path(), &transaction.id);
        let migrated = migrated_payload();
        let mut pending =
            current_transaction_for_id(root.path(), &transaction.id).expect("transaction");
        pending.migrated_workspace = Some(MigratedWorkspaceReceipt {
            studio_schema: 8,
            payload_checksum: canonical_payload_checksum(&migrated).unwrap(),
        });
        persist_transaction(root.path(), &pending).expect("write-ahead receipt");
        assert_eq!(
            std::fs::read(workspace_storage::current_state_file(root.path()).unwrap()).unwrap(),
            original
        );

        save_verified_update_workspace(root.path(), &transaction.id, migrated.clone())
            .expect("resume workspace write");
        assert_eq!(
            workspace_storage::load(root.path())
                .unwrap()
                .expect("workspace")
                .payload,
            migrated
        );
        complete_update_transaction(root.path(), transaction.id).expect("complete resumed update");
    }

    #[test]
    fn legacy_already_migrated_workspace_is_adopted_without_rewrite() {
        let root = temp_root();
        prepare_workspace(root.path());
        let transaction = create_transaction(root.path());
        enter_verifying(root.path(), &transaction.id);
        let migrated = migrated_payload();
        workspace_storage::save(root.path(), migrated.clone()).expect("legacy migrated save");
        let current_path = workspace_storage::current_state_file(root.path()).expect("current");
        let health = workspace_storage::health(root.path()).expect("health");
        let current_before = std::fs::read(&current_path).expect("legacy current");
        let backups_before: Vec<_> = health
            .backup_paths
            .iter()
            .map(|path| optional_file_bytes(Path::new(path)))
            .collect();

        save_verified_update_workspace(root.path(), &transaction.id, migrated.clone())
            .expect("adopt legacy save");

        assert_eq!(std::fs::read(current_path).unwrap(), current_before);
        assert_eq!(
            health
                .backup_paths
                .iter()
                .map(|path| optional_file_bytes(Path::new(path)))
                .collect::<Vec<_>>(),
            backups_before
        );
        assert_eq!(
            current_transaction_for_id(root.path(), &transaction.id)
                .unwrap()
                .migrated_workspace
                .expect("adopted receipt")
                .payload_checksum,
            canonical_payload_checksum(&migrated).unwrap()
        );
        complete_update_transaction(root.path(), transaction.id).expect("complete legacy update");
    }

    #[test]
    fn completion_requires_a_migrated_workspace_receipt() {
        let root = temp_root();
        prepare_workspace(root.path());
        let transaction = create_transaction(root.path());
        enter_verifying(root.path(), &transaction.id);

        let error = complete_update_transaction(root.path(), transaction.id.clone())
            .expect_err("missing receipt");

        assert!(error.contains("receipt"));
        let pending = load_pending_update_transaction(root.path())
            .unwrap()
            .expect("pending transaction");
        assert_eq!(pending.phase, UpdateTransactionPhase::RecoveryRequired);
        assert!(pending.migrated_workspace.is_none());
    }

    #[test]
    fn completion_rejects_missing_corrupt_and_wrong_workspace_primary() {
        for mode in ["missing", "corrupt", "wrong_schema", "different_payload"] {
            let root = temp_root();
            prepare_workspace(root.path());
            let transaction = create_transaction(root.path());
            enter_verifying(root.path(), &transaction.id);
            save_migrated_workspace(root.path(), &transaction.id);
            let current = workspace_storage::current_state_file(root.path()).expect("current");
            match mode {
                "missing" => std::fs::remove_file(&current).expect("remove current"),
                "corrupt" => std::fs::write(&current, b"{").expect("corrupt current"),
                "wrong_schema" => {
                    workspace_storage::save(
                        root.path(),
                        serde_json::json!({"schemaVersion": 7, "sessions": []}),
                    )
                    .expect("wrong schema current");
                }
                "different_payload" => {
                    workspace_storage::save(
                        root.path(),
                        serde_json::json!({
                            "schemaVersion": 8,
                            "sessions": [{"id": "different"}]
                        }),
                    )
                    .expect("different current");
                }
                _ => unreachable!(),
            }

            assert!(complete_update_transaction(root.path(), transaction.id.clone()).is_err());
            let pending = load_pending_update_transaction(root.path())
                .unwrap()
                .expect("pending after rejected completion");
            assert_eq!(pending.phase, UpdateTransactionPhase::RecoveryRequired);
            assert!(pending.migrated_workspace.is_some());
        }
    }

    #[test]
    fn a_second_distinct_migrated_payload_is_rejected_without_replacing_current() {
        let root = temp_root();
        prepare_workspace(root.path());
        let transaction = create_transaction(root.path());
        enter_verifying(root.path(), &transaction.id);
        save_migrated_workspace(root.path(), &transaction.id);
        let current_path = workspace_storage::current_state_file(root.path()).expect("current");
        let current_before = std::fs::read(&current_path).expect("current before");
        let different = serde_json::json!({
            "schemaVersion": 8,
            "sessions": [{"id": "unexpected"}]
        });

        let error = save_verified_update_workspace(root.path(), &transaction.id, different)
            .expect_err("different candidate");

        assert!(error.contains("differs"));
        assert_eq!(std::fs::read(current_path).unwrap(), current_before);
        assert_eq!(
            load_pending_update_transaction(root.path())
                .unwrap()
                .expect("pending")
                .phase,
            UpdateTransactionPhase::RecoveryRequired
        );
    }

    #[test]
    fn a_divergent_primary_is_rejected_before_the_first_migrated_save() {
        let root = temp_root();
        prepare_workspace(root.path());
        let transaction = create_transaction(root.path());
        enter_verifying(root.path(), &transaction.id);
        workspace_storage::save(
            root.path(),
            serde_json::json!({"schemaVersion": 8, "sessions": [{"id": "diverged"}]}),
        )
        .expect("divergent current");
        let current_path = workspace_storage::current_state_file(root.path()).expect("current");
        let current_before = std::fs::read(&current_path).expect("current before");

        assert!(
            save_verified_update_workspace(root.path(), &transaction.id, migrated_payload(),)
                .is_err()
        );
        assert_eq!(std::fs::read(current_path).unwrap(), current_before);
        let pending = load_pending_update_transaction(root.path())
            .unwrap()
            .expect("pending");
        assert_eq!(pending.phase, UpdateTransactionPhase::RecoveryRequired);
        assert!(pending.migrated_workspace.is_none());
    }

    #[test]
    fn receipt_persistence_failure_leaves_the_primary_workspace_unchanged() {
        let root = temp_root();
        let original = prepare_workspace(root.path());
        let transaction = create_transaction(root.path());
        enter_verifying(root.path(), &transaction.id);
        let history = history_transaction_path(root.path(), &transaction.id).expect("history");
        std::fs::remove_file(&history).expect("remove history file");
        std::fs::create_dir(&history).expect("block history write");

        assert!(
            save_verified_update_workspace(root.path(), &transaction.id, migrated_payload(),)
                .is_err()
        );
        assert_eq!(
            std::fs::read(workspace_storage::current_state_file(root.path()).unwrap()).unwrap(),
            original
        );
        assert!(current_transaction_for_id(root.path(), &transaction.id)
            .unwrap()
            .migrated_workspace
            .is_none());
    }

    #[test]
    fn legacy_transaction_json_and_receipt_validation_are_backward_compatible() {
        let root = temp_root();
        prepare_workspace(root.path());
        let transaction = create_transaction(root.path());
        let current_path = current_transaction_path(root.path());
        let mut legacy = serde_json::to_value(&transaction).expect("transaction JSON");
        assert!(legacy.get("migratedWorkspace").is_none());
        legacy.as_object_mut().unwrap().remove("migratedWorkspace");
        workspace_storage::atomic_write_private(
            &current_path,
            &serde_json::to_vec(&legacy).unwrap(),
        )
        .expect("legacy current");
        assert!(load_pending_update_transaction(root.path())
            .unwrap()
            .is_some());

        enter_verifying(root.path(), &transaction.id);
        let mut malformed =
            serde_json::to_value(current_transaction_for_id(root.path(), &transaction.id).unwrap())
                .unwrap();
        malformed["migratedWorkspace"] = serde_json::json!({
            "studioSchema": 8,
            "payloadChecksum": "not-a-checksum"
        });
        workspace_storage::atomic_write_private(
            &current_path,
            &serde_json::to_vec(&malformed).unwrap(),
        )
        .expect("malformed current");
        assert!(load_pending_update_transaction(root.path())
            .expect_err("malformed receipt")
            .contains("receipt"));

        malformed["migratedWorkspace"] = serde_json::json!({
            "studioSchema": 7,
            "payloadChecksum": canonical_payload_checksum(&migrated_payload()).unwrap()
        });
        workspace_storage::atomic_write_private(
            &current_path,
            &serde_json::to_vec(&malformed).unwrap(),
        )
        .expect("wrong-schema receipt");
        assert!(load_pending_update_transaction(root.path())
            .expect_err("wrong receipt schema")
            .contains("receipt"));
    }

    #[test]
    fn target_boot_can_resume_downloading_and_installing_markers_only() {
        for interrupted_phase in [
            UpdateTransactionPhase::Downloading,
            UpdateTransactionPhase::Installing,
        ] {
            let root = temp_root();
            prepare_workspace(root.path());
            let transaction = create_transaction(root.path());
            set_update_transaction_phase(
                root.path(),
                &transaction.id,
                UpdateTransactionPhase::Downloading,
            )
            .expect("downloading");
            if interrupted_phase == UpdateTransactionPhase::Installing {
                set_update_transaction_phase(
                    root.path(),
                    &transaction.id,
                    UpdateTransactionPhase::Installing,
                )
                .expect("installing");
            }

            assert!(begin_update_verification(root.path(), &transaction.id, "0.6.7").is_err());
            assert_eq!(
                current_transaction_for_id(root.path(), &transaction.id)
                    .unwrap()
                    .phase,
                interrupted_phase
            );
            assert!(update_transaction_blocks_mutation(root.path()).unwrap());

            let resumed = begin_update_verification(root.path(), &transaction.id, "0.8.0")
                .expect("target boot verification");
            assert_eq!(resumed.phase, UpdateTransactionPhase::Verifying);
            assert!(update_transaction_blocks_mutation(root.path()).unwrap());
        }
    }

    #[test]
    fn fresh_source_relaunch_can_abandon_post_install_phases() {
        for abandoned_phase in [
            UpdateTransactionPhase::Installing,
            UpdateTransactionPhase::AwaitingRestart,
            UpdateTransactionPhase::RecoveryRequired,
        ] {
            let root = temp_root();
            let original = prepare_workspace(root.path());
            let transaction = create_transaction(root.path());
            set_update_transaction_phase(
                root.path(),
                &transaction.id,
                UpdateTransactionPhase::Downloading,
            )
            .expect("downloading");
            set_update_transaction_phase_for_process(
                root.path(),
                &transaction.id,
                UpdateTransactionPhase::Installing,
                101,
            )
            .expect("installing with process marker");
            if abandoned_phase == UpdateTransactionPhase::AwaitingRestart {
                set_update_transaction_phase_for_process(
                    root.path(),
                    &transaction.id,
                    UpdateTransactionPhase::AwaitingRestart,
                    101,
                )
                .expect("awaiting restart");
            } else if abandoned_phase == UpdateTransactionPhase::RecoveryRequired {
                fail_update_transaction(
                    root.path(),
                    &transaction.id,
                    "install_failed".into(),
                    "Install did not relaunch the target version.".into(),
                )
                .expect("recovery required");
            }

            let archived = abandon_update_transaction_after_source_relaunch(
                root.path(),
                &transaction.id,
                "0.6.7",
                202,
            )
            .expect("fresh source relaunch abandonment");

            assert_eq!(archived.phase, UpdateTransactionPhase::RecoveryRequired);
            assert_eq!(
                archived.failure.expect("abandonment diagnostic").code,
                "source_version_relaunched"
            );
            assert!(load_pending_update_transaction(root.path())
                .unwrap()
                .is_none());
            assert!(!update_transaction_blocks_mutation(root.path()).unwrap());
            assert_eq!(
                std::fs::read(
                    workspace_snapshot_path(root.path(), &transaction.id).expect("snapshot")
                )
                .unwrap(),
                original
            );
            assert_eq!(
                read_transaction(
                    &history_transaction_path(root.path(), &transaction.id).expect("history")
                )
                .unwrap()
                .installing_process_id,
                Some(101)
            );
        }
    }

    #[test]
    fn source_relaunch_abandonment_rejects_same_process_and_other_versions() {
        for (running_version, process_id) in [("0.6.7", 101), ("0.8.0", 202), ("9.9.9", 202)] {
            let root = temp_root();
            prepare_workspace(root.path());
            let transaction = create_transaction(root.path());
            set_update_transaction_phase(
                root.path(),
                &transaction.id,
                UpdateTransactionPhase::Downloading,
            )
            .expect("downloading");
            set_update_transaction_phase_for_process(
                root.path(),
                &transaction.id,
                UpdateTransactionPhase::Installing,
                101,
            )
            .expect("installing");

            assert!(abandon_update_transaction_after_source_relaunch(
                root.path(),
                &transaction.id,
                running_version,
                process_id,
            )
            .is_err());
            assert_eq!(
                current_transaction_for_id(root.path(), &transaction.id)
                    .unwrap()
                    .phase,
                UpdateTransactionPhase::Installing
            );
            assert!(update_transaction_blocks_mutation(root.path()).unwrap());
        }
    }

    #[test]
    fn source_relaunch_abandonment_requires_a_durable_process_marker() {
        let root = temp_root();
        prepare_workspace(root.path());
        let transaction = create_transaction(root.path());
        set_update_transaction_phase(
            root.path(),
            &transaction.id,
            UpdateTransactionPhase::Downloading,
        )
        .expect("downloading");
        set_update_transaction_phase(
            root.path(),
            &transaction.id,
            UpdateTransactionPhase::Installing,
        )
        .expect("legacy installing marker");

        assert!(abandon_update_transaction_after_source_relaunch(
            root.path(),
            &transaction.id,
            "0.6.7",
            202,
        )
        .is_err());
        assert!(update_transaction_blocks_mutation(root.path()).unwrap());
    }

    #[test]
    fn completed_snapshot_cleanup_is_deferred_and_retains_latest_two() {
        let root = temp_root();
        prepare_workspace(root.path());
        let asset_before = std::fs::read(root.path().join("assets/reference.png")).unwrap();
        let generated_before = std::fs::read(root.path().join("generated/result.mp4")).unwrap();
        let mut transactions = Vec::new();
        for index in 0..4u64 {
            let transaction = create_completed_transaction(root.path());
            let history =
                history_transaction_path(root.path(), &transaction.id).expect("history path");
            set_file_age(
                &history,
                std::time::Duration::from_secs(
                    COMPLETED_SNAPSHOT_MIN_AGE_MS / 1000 + (4 - index) * 60,
                ),
            );
            transactions.push(transaction);
        }

        // Completion itself performs no retention cleanup.
        assert!(transactions.iter().all(|transaction| {
            transaction_snapshot_directory(root.path(), &transaction.id)
                .unwrap()
                .is_dir()
                && history_transaction_path(root.path(), &transaction.id)
                    .unwrap()
                    .is_file()
        }));

        assert_eq!(cleanup_completed_update_snapshots(root.path()).unwrap(), 2);
        for transaction in &transactions[..2] {
            assert!(
                !transaction_snapshot_directory(root.path(), &transaction.id)
                    .unwrap()
                    .exists()
            );
            assert!(!history_transaction_path(root.path(), &transaction.id)
                .unwrap()
                .exists());
        }
        for transaction in &transactions[2..] {
            assert!(transaction_snapshot_directory(root.path(), &transaction.id)
                .unwrap()
                .is_dir());
            assert!(history_transaction_path(root.path(), &transaction.id)
                .unwrap()
                .is_file());
        }
        assert_eq!(
            read_current_transaction(root.path()).unwrap().unwrap().id,
            transactions.last().unwrap().id
        );
        assert_eq!(cleanup_completed_update_snapshots(root.path()).unwrap(), 0);
        assert_eq!(
            std::fs::read(root.path().join("assets/reference.png")).unwrap(),
            asset_before
        );
        assert_eq!(
            std::fs::read(root.path().join("generated/result.mp4")).unwrap(),
            generated_before
        );
    }

    #[test]
    fn completed_snapshot_cleanup_respects_age_and_pending_transactions() {
        let root = temp_root();
        prepare_workspace(root.path());
        let mut completed = Vec::new();
        for index in 0..3u64 {
            let transaction = create_completed_transaction(root.path());
            let history = history_transaction_path(root.path(), &transaction.id).unwrap();
            let age_ms = match index {
                0 => COMPLETED_SNAPSHOT_MIN_AGE_MS - 60_000,
                1 => 20 * 24 * 60 * 60 * 1000,
                2 => 10 * 24 * 60 * 60 * 1000,
                _ => unreachable!(),
            };
            set_file_age(&history, std::time::Duration::from_millis(age_ms));
            completed.push(transaction);
        }
        assert_eq!(cleanup_completed_update_snapshots(root.path()).unwrap(), 0);
        assert!(
            transaction_snapshot_directory(root.path(), &completed[0].id)
                .unwrap()
                .is_dir()
        );

        set_file_age(
            &history_transaction_path(root.path(), &completed[0].id).unwrap(),
            std::time::Duration::from_millis(COMPLETED_SNAPSHOT_MIN_AGE_MS + 60_000),
        );
        let pending = create_transaction(root.path());
        assert!(cleanup_completed_update_snapshots(root.path()).is_err());
        assert!(completed.iter().all(|transaction| {
            transaction_snapshot_directory(root.path(), &transaction.id)
                .unwrap()
                .is_dir()
        }));
        assert_eq!(
            read_current_transaction(root.path()).unwrap().unwrap().id,
            pending.id
        );
        abort_update_transaction(root.path(), &pending.id).expect("archive pending");
        assert_eq!(cleanup_completed_update_snapshots(root.path()).unwrap(), 1);
        assert!(
            !transaction_snapshot_directory(root.path(), &completed[0].id)
                .unwrap()
                .exists()
        );
        assert!(transaction_snapshot_directory(root.path(), &pending.id)
            .unwrap()
            .is_dir());
    }

    #[test]
    fn completed_snapshot_cleanup_preserves_unknown_diagnostics() {
        let root = temp_root();
        prepare_workspace(root.path());
        let mut completed = Vec::new();
        for index in 0..3u64 {
            let transaction = create_completed_transaction(root.path());
            let history = history_transaction_path(root.path(), &transaction.id).unwrap();
            set_file_age(
                &history,
                std::time::Duration::from_millis(
                    COMPLETED_SNAPSHOT_MIN_AGE_MS + (3 - index) * 60_000,
                ),
            );
            completed.push(transaction);
        }
        let diagnostic = transaction_snapshot_directory(root.path(), &completed[0].id)
            .unwrap()
            .join("support-diagnostic.txt");
        std::fs::write(&diagnostic, b"retain me").expect("diagnostic");

        assert_eq!(cleanup_completed_update_snapshots(root.path()).unwrap(), 0);
        assert_eq!(std::fs::read(diagnostic).unwrap(), b"retain me");
        assert!(history_transaction_path(root.path(), &completed[0].id)
            .unwrap()
            .is_file());
    }
}
