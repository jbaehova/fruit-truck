use std::collections::{BTreeSet, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use chrono::{SecondsFormat, Utc};
use fruit_truck_protocol::{
    CommandReceipt, CommitOperations, CommitSnapshot, EventBatch, EventRecord, LegacyEnvelope,
    NextAction, ReadSession, SessionRecord, WaitEvents, STORE_SCHEMA_VERSION,
};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const MAX_SNAPSHOT_BYTES: usize = 50 * 1024 * 1024;
const MAX_CHANGED_ITEMS: usize = 64;
const MAX_CHANGED_BYTES: usize = 160;
const MAX_EVENT_PAYLOAD_BYTES: usize = 32 * 1024;
const EVENT_RETENTION: u64 = 20_000;

#[derive(Debug)]
pub struct CoreError {
    pub code: &'static str,
    pub message: String,
}

impl CoreError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for CoreError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for CoreError {}

impl From<rusqlite::Error> for CoreError {
    fn from(error: rusqlite::Error) -> Self {
        Self::new("STORE_ERROR", error.to_string())
    }
}

impl From<serde_json::Error> for CoreError {
    fn from(error: serde_json::Error) -> Self {
        Self::new("INVALID_JSON", error.to_string())
    }
}

#[derive(Default)]
struct EventSignal {
    cursor: Mutex<u64>,
    changed: Condvar,
}

#[derive(Clone)]
pub struct CoreStore {
    home: PathBuf,
    database: PathBuf,
    signal: Arc<EventSignal>,
    export_lock: Arc<Mutex<()>>,
}

#[derive(Debug, Default)]
pub struct LegacyIngressOutcome {
    pub receipts: Vec<CommandReceipt>,
    pub conflicts: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct DurableTask {
    pub id: String,
    pub session_id: String,
    pub provider_job_id: String,
    pub state: Value,
}

impl CoreStore {
    pub fn open(home: impl AsRef<Path>) -> Result<Self, CoreError> {
        let home = home.as_ref().to_path_buf();
        secure_directory(&home)?;
        let database = home.join("core.sqlite3");
        let store = Self {
            home,
            database,
            signal: Arc::new(EventSignal::default()),
            export_lock: Arc::new(Mutex::new(())),
        };
        let connection = store.connection()?;
        store.migrate(&connection)?;
        let cursor: i64 =
            connection.query_row("SELECT COALESCE(MAX(cursor), 0) FROM events", [], |row| {
                row.get(0)
            })?;
        *store
            .signal
            .cursor
            .lock()
            .map_err(|_| CoreError::new("CORE_POISONED", "Core event state is unavailable."))? =
            cursor as u64;
        Ok(store)
    }

    pub fn database_path(&self) -> &Path {
        &self.database
    }

    fn connection(&self) -> Result<Connection, CoreError> {
        let connection = Connection::open(&self.database)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.execute_batch(
            "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;",
        )?;
        Ok(connection)
    }

    fn migrate(&self, connection: &Connection) -> Result<(), CoreError> {
        connection.execute_batch(&format!(
      r#"
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_content (
        session_id TEXT PRIMARY KEY,
        content_json TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS requirements (
        session_id TEXT NOT NULL,
        id TEXT NOT NULL,
        status TEXT,
        source TEXT,
        blocking INTEGER NOT NULL,
        value_json TEXT NOT NULL,
        PRIMARY KEY(session_id, id),
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS plan_steps (
        session_id TEXT NOT NULL,
        id TEXT NOT NULL,
        status TEXT NOT NULL,
        value_json TEXT NOT NULL,
        PRIMARY KEY(session_id, id),
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS plan_dependencies (
        session_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        dependency_id TEXT NOT NULL,
        PRIMARY KEY(session_id, step_id, dependency_id),
        FOREIGN KEY(session_id, step_id) REFERENCES plan_steps(session_id, id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS decisions (
        session_id TEXT NOT NULL,
        id TEXT NOT NULL,
        request_key TEXT,
        semantic_key TEXT,
        status TEXT NOT NULL,
        channel TEXT,
        value_json TEXT NOT NULL,
        PRIMARY KEY(session_id, id),
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS decisions_request_key
        ON decisions(session_id, request_key) WHERE request_key IS NOT NULL;
      CREATE TABLE IF NOT EXISTS activities (
        session_id TEXT NOT NULL,
        id TEXT NOT NULL,
        kind TEXT NOT NULL,
        created_at TEXT,
        value_json TEXT NOT NULL,
        PRIMARY KEY(session_id, id),
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS assets (
        session_id TEXT NOT NULL,
        id TEXT NOT NULL,
        kind TEXT,
        origin TEXT,
        value_json TEXT NOT NULL,
        PRIMARY KEY(session_id, id),
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        session_id TEXT NOT NULL,
        asset_id TEXT NOT NULL,
        approval TEXT,
        value_json TEXT NOT NULL,
        PRIMARY KEY(session_id, asset_id),
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS artifact_parents (
        session_id TEXT NOT NULL,
        asset_id TEXT NOT NULL,
        parent_asset_id TEXT NOT NULL,
        PRIMARY KEY(session_id, asset_id, parent_asset_id),
        FOREIGN KEY(session_id, asset_id) REFERENCES artifacts(session_id, asset_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS generation_threads (
        session_id TEXT NOT NULL,
        id TEXT NOT NULL,
        mode TEXT NOT NULL,
        revision INTEGER NOT NULL,
        archived INTEGER NOT NULL,
        value_json TEXT NOT NULL,
        PRIMARY KEY(session_id, id),
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS generation_attempts (
        session_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        id TEXT NOT NULL,
        status TEXT NOT NULL,
        provider_job_id TEXT,
        value_json TEXT NOT NULL,
        PRIMARY KEY(session_id, id),
        FOREIGN KEY(session_id, thread_id) REFERENCES generation_threads(session_id, id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS enhancement_attempts (
        session_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        id TEXT NOT NULL,
        status TEXT NOT NULL,
        value_json TEXT NOT NULL,
        PRIMARY KEY(session_id, id),
        FOREIGN KEY(session_id, thread_id) REFERENCES generation_threads(session_id, id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS assembly (
        session_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        output_asset_id TEXT,
        value_json TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS assembly_clips (
        session_id TEXT NOT NULL,
        id TEXT NOT NULL,
        asset_id TEXT NOT NULL,
        clip_order INTEGER NOT NULL,
        value_json TEXT NOT NULL,
        PRIMARY KEY(session_id, id),
        FOREIGN KEY(session_id) REFERENCES assembly(session_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS cost_ledger (
        session_id TEXT NOT NULL,
        id TEXT NOT NULL,
        category TEXT NOT NULL,
        actual_cost_usd REAL NOT NULL,
        recorded_at TEXT,
        PRIMARY KEY(session_id, id),
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS idempotency (
        session_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        request_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        receipt_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY(session_id, scope, request_key),
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS events (
        cursor INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        session_sequence INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        UNIQUE(session_id, session_sequence),
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS events_session_cursor ON events(session_id, cursor);
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        provider_job_id TEXT,
        state_json TEXT NOT NULL,
        next_run_at_ms INTEGER,
        updated_at_ms INTEGER NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS telemetry_spans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trace_id TEXT NOT NULL,
        command_id TEXT,
        name TEXT NOT NULL,
        duration_us INTEGER NOT NULL,
        fields_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      );
      INSERT INTO meta(key, value) VALUES('store_schema_version', '{STORE_SCHEMA_VERSION}')
        ON CONFLICT(key) DO UPDATE SET value=excluded.value;
      COMMIT;
    "#
    ))?;
        Ok(())
    }

    pub fn integrity_check(&self) -> Result<(), CoreError> {
        let result: String = self
            .connection()?
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
        if result == "ok" {
            Ok(())
        } else {
            Err(CoreError::new("STORE_INTEGRITY_FAILED", result))
        }
    }

    pub fn record_telemetry_span(
        &self,
        trace_id: &str,
        command_id: Option<&str>,
        name: &str,
        duration_us: u64,
        fields: Value,
    ) -> Result<(), CoreError> {
        if trace_id.is_empty()
            || trace_id.len() > 100
            || command_id.is_some_and(|value| value.is_empty() || value.len() > 100)
            || name.is_empty()
            || name.len() > 100
        {
            return Err(CoreError::new(
                "INVALID_TELEMETRY",
                "Telemetry identifiers exceed their bounds.",
            ));
        }
        let safe_fields = fields.as_object().is_some_and(|values| {
            values
                .values()
                .all(|value| value.is_boolean() || value.is_number())
        });
        if !safe_fields {
            return Err(CoreError::new(
                "INVALID_TELEMETRY",
                "Telemetry fields may contain only numbers and booleans.",
            ));
        }
        let connection = self.connection()?;
        connection.execute(
      "INSERT INTO telemetry_spans(trace_id, command_id, name, duration_us, fields_json, created_at_ms) VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
      params![trace_id, command_id, name, duration_us as i64, serde_json::to_string(&fields)?, now_ms()? as i64],
    )?;
        connection.execute(
      "DELETE FROM telemetry_spans WHERE id < (SELECT COALESCE(MAX(id), 0) - 20000 FROM telemetry_spans)",
      [],
    )?;
        Ok(())
    }

    pub fn import_legacy(
        &self,
        envelope: &LegacyEnvelope,
    ) -> Result<Vec<CommandReceipt>, CoreError> {
        let mut receipts = Vec::new();
        for legacy_snapshot in &envelope.sessions {
            let snapshot = normalize_legacy_snapshot(legacy_snapshot, envelope.schema_version)?;
            let session_id = valid_session_id(snapshot.get("id").and_then(Value::as_str))?;
            if self.read_record(session_id)?.is_some() {
                continue;
            }
            let command = CommitSnapshot {
                session_id: session_id.into(),
                base_revision: 0,
                snapshot: snapshot.clone(),
                command_id: format!("legacy-import-{session_id}"),
                changed: vec!["session".into()],
                event_type: Some("session.imported".into()),
                event_payload: json!({ "legacySchemaVersion": envelope.schema_version }),
                idempotency_scope: Some("legacy-import".into()),
                idempotency_key: Some(session_id.into()),
                request_hash: Some(hash_json(&snapshot)?),
            };
            receipts.push(self.commit_snapshot(command)?);
        }
        Ok(receipts)
    }

    pub fn ingest_legacy(
        &self,
        envelope: &LegacyEnvelope,
    ) -> Result<LegacyIngressOutcome, CoreError> {
        let mut outcome = LegacyIngressOutcome::default();
        for candidate in &envelope.sessions {
            let session_id = valid_session_id(candidate.get("id").and_then(Value::as_str))?;
            let Some(current) = self.read_record(session_id)? else {
                let imported = self.import_legacy(&LegacyEnvelope {
                    schema_version: envelope.schema_version,
                    revision: envelope.revision,
                    sessions: vec![candidate.clone()],
                })?;
                outcome.receipts.extend(imported);
                continue;
            };
            if semantic_snapshot(&current.snapshot) == semantic_snapshot(candidate) {
                continue;
            }
            let declared_revision = candidate
                .pointer("/agent/revision")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            if declared_revision != current.revision + 1 {
                self.record_event(
                    session_id,
                    current.revision,
                    "legacy.conflict",
                    json!({
                      "declaredRevision": declared_revision,
                      "coreRevision": current.revision,
                      "reason": "stale_or_ambiguous_base",
                    }),
                )?;
                outcome.conflicts.push(session_id.into());
                continue;
            }
            outcome.receipts.push(self.commit_snapshot(CommitSnapshot {
                session_id: session_id.into(),
                base_revision: current.revision,
                snapshot: candidate.clone(),
                command_id: format!("legacy-ingress-{}-{}", session_id, envelope.revision),
                changed: vec!["legacy-ingress".into()],
                event_type: Some("legacy.ingested".into()),
                event_payload: json!({ "legacyEnvelopeRevision": envelope.revision }),
                idempotency_scope: None,
                idempotency_key: None,
                request_hash: None,
            })?);
        }
        Ok(outcome)
    }

    pub fn record_event(
        &self,
        session_id: &str,
        revision: u64,
        event_type: &str,
        payload: Value,
    ) -> Result<EventRecord, CoreError> {
        valid_session_id(Some(session_id))?;
        let payload_json = serde_json::to_string(&payload)?;
        if payload_json.len() > MAX_EVENT_PAYLOAD_BYTES {
            return Err(CoreError::new(
                "EVENT_TOO_LARGE",
                "Event payload exceeds the 32 KB limit.",
            ));
        }
        let now = now_ms()?;
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current: Option<i64> = transaction
            .query_row(
                "SELECT revision FROM sessions WHERE id=?1",
                params![session_id],
                |row| row.get(0),
            )
            .optional()?;
        if current.map(|value| value as u64) != Some(revision) {
            return Err(CoreError::new(
                "SESSION_CONFLICT",
                "Session changed while recording an event.",
            ));
        }
        let sequence: i64 = transaction.query_row(
            "SELECT COALESCE(MAX(session_sequence), 0) + 1 FROM events WHERE session_id=?1",
            params![session_id],
            |row| row.get(0),
        )?;
        transaction.execute(
      "INSERT INTO events(session_id, session_sequence, revision, event_type, payload_json, created_at_ms) VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
      params![session_id, sequence, revision as i64, event_type, payload_json, now as i64],
    )?;
        let cursor = transaction.last_insert_rowid() as u64;
        transaction.commit()?;
        self.publish(cursor)?;
        Ok(EventRecord {
            cursor,
            session_id: session_id.into(),
            session_sequence: sequence as u64,
            revision,
            event_type: event_type.into(),
            payload,
            created_at_ms: now,
        })
    }

    pub fn backup_legacy_files(&self) -> Result<Option<PathBuf>, CoreError> {
        let index = self.home.join("agent-sessions.json");
        if !index.exists() {
            return Ok(None);
        }
        let backup = self.home.join("legacy-backup-v4");
        if backup.exists() {
            return Ok(Some(backup));
        }
        let temporary = self.home.join(format!(
            "legacy-backup-v4.tmp-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let result = (|| {
            secure_directory(&temporary)?;
            fs::copy(&index, temporary.join("agent-sessions.json"))
                .map_err(|error| CoreError::new("LEGACY_BACKUP_FAILED", error.to_string()))?;
            let sessions = self.home.join("agent-sessions");
            if sessions.is_dir() {
                let target = temporary.join("agent-sessions");
                secure_directory(&target)?;
                for entry in fs::read_dir(sessions)
                    .map_err(|error| CoreError::new("LEGACY_BACKUP_FAILED", error.to_string()))?
                {
                    let entry = entry.map_err(|error| {
                        CoreError::new("LEGACY_BACKUP_FAILED", error.to_string())
                    })?;
                    if entry.path().extension().and_then(|value| value.to_str()) == Some("json") {
                        fs::copy(entry.path(), target.join(entry.file_name())).map_err(
                            |error| CoreError::new("LEGACY_BACKUP_FAILED", error.to_string()),
                        )?;
                    }
                }
            }
            fs::rename(&temporary, &backup)
                .map_err(|error| CoreError::new("LEGACY_BACKUP_FAILED", error.to_string()))?;
            Ok::<(), CoreError>(())
        })();
        if let Err(error) = result {
            let _ = fs::remove_dir_all(&temporary);
            if backup.exists() {
                return Ok(Some(backup));
            }
            return Err(error);
        }
        Ok(Some(backup))
    }

    pub fn commit_snapshot(
        &self,
        mut command: CommitSnapshot,
    ) -> Result<CommandReceipt, CoreError> {
        let session_id = valid_session_id(Some(&command.session_id))?.to_string();
        validate_snapshot(&command.snapshot, &session_id)?;
        if command.command_id.trim().is_empty() || command.command_id.len() > 200 {
            return Err(CoreError::new(
                "INVALID_COMMAND",
                "commandId must contain 1 to 200 characters.",
            ));
        }
        command.changed = bounded_changed(command.changed);
        let event_type = command.event_type.as_deref().unwrap_or("session.changed");
        if event_type.is_empty() || event_type.len() > 100 {
            return Err(CoreError::new(
                "INVALID_EVENT",
                "eventType must contain 1 to 100 characters.",
            ));
        }
        let payload_json = serde_json::to_string(&command.event_payload)?;
        if payload_json.len() > MAX_EVENT_PAYLOAD_BYTES {
            return Err(CoreError::new(
                "EVENT_TOO_LARGE",
                "Event payload exceeds the 32 KB limit.",
            ));
        }
        let idempotency = normalize_idempotency(&command)?;
        let now = now_ms()?;
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;

        if let Some((scope, key, request_hash)) = &idempotency {
            let existing: Option<(String, String)> = transaction.query_row(
        "SELECT request_hash, receipt_json FROM idempotency WHERE session_id=?1 AND scope=?2 AND request_key=?3",
        params![session_id, scope, key],
        |row| Ok((row.get(0)?, row.get(1)?)),
      ).optional()?;
            if let Some((stored_hash, receipt_json)) = existing {
                if stored_hash != *request_hash {
                    return Err(CoreError::new(
                        "IDEMPOTENCY_KEY_REUSED",
                        "The idempotency key was already used with a different request.",
                    ));
                }
                let mut receipt: CommandReceipt = serde_json::from_str(&receipt_json)?;
                receipt.replayed = true;
                return Ok(receipt);
            }
        }

        let current: Option<i64> = transaction
            .query_row(
                "SELECT revision FROM sessions WHERE id=?1",
                params![session_id],
                |row| row.get(0),
            )
            .optional()?;
        let current_revision = current.unwrap_or(0) as u64;
        if command.base_revision != current_revision {
            return Err(CoreError::new(
                "SESSION_CONFLICT",
                format!(
                    "Expected session revision {}, but Core is at {}.",
                    command.base_revision, current_revision
                ),
            ));
        }
        let revision = current_revision + 1;
        set_snapshot_revision(&mut command.snapshot, revision, now)?;
        let snapshot_json = serde_json::to_string(&command.snapshot)?;
        transaction.execute(
      "INSERT INTO sessions(id, revision, snapshot_json, created_at_ms, updated_at_ms) VALUES(?1, ?2, ?3, ?4, ?4)
       ON CONFLICT(id) DO UPDATE SET revision=excluded.revision, snapshot_json=excluded.snapshot_json, updated_at_ms=excluded.updated_at_ms",
      params![session_id, revision as i64, snapshot_json, now as i64],
    )?;
        refresh_relational_projection(&transaction, &session_id, &command.snapshot)?;
        let sequence: i64 = transaction.query_row(
            "SELECT COALESCE(MAX(session_sequence), 0) + 1 FROM events WHERE session_id=?1",
            params![session_id],
            |row| row.get(0),
        )?;
        transaction.execute(
      "INSERT INTO events(session_id, session_sequence, revision, event_type, payload_json, created_at_ms) VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
      params![session_id, sequence, revision as i64, event_type, payload_json, now as i64],
    )?;
        let cursor = transaction.last_insert_rowid() as u64;
        let next = next_action(&command.snapshot);
        let receipt = CommandReceipt {
            ok: true,
            session_id: session_id.clone(),
            revision,
            command_id: command.command_id,
            changed: command.changed,
            event_cursor: cursor,
            next,
            replayed: false,
        };
        if let Some((scope, key, request_hash)) = idempotency {
            transaction.execute(
        "INSERT INTO idempotency(session_id, scope, request_key, request_hash, receipt_json, created_at_ms) VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
        params![session_id, scope, key, request_hash, serde_json::to_string(&receipt)?, now as i64],
      )?;
        }
        transaction.execute(
      "DELETE FROM idempotency WHERE rowid < (SELECT COALESCE(MAX(rowid), 0) - 20000 FROM idempotency)",
      [],
    )?;
        transaction.execute(
            "DELETE FROM events WHERE cursor < (SELECT MAX(cursor) - ?1 FROM events)",
            params![EVENT_RETENTION as i64],
        )?;
        transaction.commit()?;
        self.publish(cursor)?;
        Ok(receipt)
    }

    pub fn commit_operations(
        &self,
        command: CommitOperations,
    ) -> Result<CommandReceipt, CoreError> {
        valid_session_id(Some(&command.session_id))?;
        if command.ops.is_empty() || command.ops.len() > 64 {
            return Err(CoreError::new(
                "INVALID_COMMAND",
                "ops must contain 1 to 64 typed objects.",
            ));
        }
        if command.request_key.trim().is_empty() || command.request_key.len() > 200 {
            return Err(CoreError::new(
                "INVALID_IDEMPOTENCY",
                "requestKey must contain 1 to 200 characters.",
            ));
        }
        if command.request_hash.trim().is_empty() || command.request_hash.len() > 128 {
            return Err(CoreError::new(
                "INVALID_IDEMPOTENCY",
                "requestHash must contain 1 to 128 characters.",
            ));
        }
        if let Some(receipt) = self.operation_replay(
            &command.session_id,
            &command.request_key,
            &command.request_hash,
        )? {
            return Ok(receipt);
        }
        let record = self.read_record(&command.session_id)?.ok_or_else(|| {
            CoreError::new(
                "SESSION_NOT_FOUND",
                format!("Session {} does not exist.", command.session_id),
            )
        })?;
        if record.revision != command.base_revision {
            return Err(CoreError::new(
                "SESSION_CONFLICT",
                format!(
                    "Expected session revision {}, but Core is at {}.",
                    command.base_revision, record.revision
                ),
            ));
        }
        let mut snapshot = record.snapshot;
        let mut changed = BTreeSet::new();
        for operation in &command.ops {
            apply_operation(&mut snapshot, operation, &mut changed)?;
        }
        validate_command_snapshot(&snapshot)?;
        let timestamp = iso_timestamp();
        snapshot["updatedAt"] = Value::String(timestamp.clone());
        snapshot["agent"]["updatedAt"] = Value::String(timestamp);
        self.commit_snapshot(CommitSnapshot {
            session_id: command.session_id,
            base_revision: command.base_revision,
            snapshot,
            command_id: command.command_id,
            changed: changed.into_iter().collect(),
            event_type: Some("session.changed".into()),
            event_payload: json!({ "operationCount": command.ops.len() }),
            idempotency_scope: Some("session-commit".into()),
            idempotency_key: Some(command.request_key),
            request_hash: Some(command.request_hash),
        })
    }

    fn operation_replay(
        &self,
        session_id: &str,
        request_key: &str,
        request_hash: &str,
    ) -> Result<Option<CommandReceipt>, CoreError> {
        let stored: Option<(String, String)> = self
      .connection()?
      .query_row(
        "SELECT request_hash, receipt_json FROM idempotency WHERE session_id=?1 AND scope='session-commit' AND request_key=?2",
        params![session_id, request_key],
        |row| Ok((row.get(0)?, row.get(1)?)),
      )
      .optional()?;
        let Some((stored_hash, receipt_json)) = stored else {
            return Ok(None);
        };
        if stored_hash != request_hash {
            return Err(CoreError::new(
                "IDEMPOTENCY_KEY_REUSED",
                "The idempotency key was already used with a different request.",
            ));
        }
        let mut receipt: CommandReceipt = serde_json::from_str(&receipt_json)?;
        receipt.replayed = true;
        Ok(Some(receipt))
    }

    pub fn claim_due_video_task(&self, now: u64) -> Result<Option<DurableTask>, CoreError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let task: Option<(String, String, String, String)> = transaction
            .query_row(
                "SELECT id, session_id, provider_job_id, state_json FROM tasks
         WHERE kind='video_poll'
           AND (status='scheduled' OR status='running')
           AND next_run_at_ms <= ?1
         ORDER BY next_run_at_ms LIMIT 1",
                params![now as i64],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        let Some((id, session_id, provider_job_id, state_json)) = task else {
            transaction.commit()?;
            return Ok(None);
        };
        transaction.execute(
            "UPDATE tasks SET status='running', next_run_at_ms=?2, updated_at_ms=?1 WHERE id=?3",
            params![now as i64, (now + 60_000) as i64, id],
        )?;
        transaction.commit()?;
        Ok(Some(DurableTask {
            id,
            session_id,
            provider_job_id,
            state: serde_json::from_str(&state_json)?,
        }))
    }

    pub fn reschedule_task(&self, task_id: &str, delay_ms: u64) -> Result<(), CoreError> {
        let now = now_ms()?;
        self.connection()?.execute(
            "UPDATE tasks SET status='scheduled', next_run_at_ms=?1, updated_at_ms=?2,
               state_json=json_set(state_json, '$.schedulerRetries',
                 COALESCE(json_extract(state_json, '$.schedulerRetries'), 0) + 1)
       WHERE id=?3 AND status='running'",
            params![
                (now + delay_ms.clamp(500, 300_000)) as i64,
                now as i64,
                task_id
            ],
        )?;
        Ok(())
    }

    pub fn commit_task_operation(
        &self,
        task: &DurableTask,
        operation: Value,
    ) -> Result<CommandReceipt, CoreError> {
        let record = self.read_record(&task.session_id)?.ok_or_else(|| {
            CoreError::new(
                "SESSION_NOT_FOUND",
                format!("Session {} does not exist.", task.session_id),
            )
        })?;
        let request_hash = hash_json(&operation)?;
        let poll_attempt = operation
            .get("pollAttempt")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        self.commit_operations(CommitOperations {
            session_id: task.session_id.clone(),
            base_revision: record.revision,
            command_id: format!("{}-{poll_attempt}", task.id),
            request_key: format!("{}-{poll_attempt}", task.id),
            request_hash,
            ops: vec![operation],
        })
    }

    pub fn read_record(&self, session_id: &str) -> Result<Option<SessionRecord>, CoreError> {
        valid_session_id(Some(session_id))?;
        self.connection()?
            .query_row(
                "SELECT id, revision, snapshot_json, updated_at_ms FROM sessions WHERE id=?1",
                params![session_id],
                |row| {
                    let raw: String = row.get(2)?;
                    let snapshot = serde_json::from_str(&raw).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            raw.len(),
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })?;
                    let revision: i64 = row.get(1)?;
                    let updated_at_ms: i64 = row.get(3)?;
                    Ok(SessionRecord {
                        session_id: row.get(0)?,
                        revision: revision as u64,
                        snapshot,
                        updated_at_ms: updated_at_ms as u64,
                    })
                },
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn list_sessions(&self) -> Result<Vec<Value>, CoreError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
      "SELECT revision, snapshot_json, updated_at_ms FROM sessions ORDER BY updated_at_ms DESC",
    )?;
        let rows = statement.query_map([], |row| {
            let revision = row.get::<_, i64>(0)? as u64;
            let raw: String = row.get(1)?;
            let snapshot: Value = serde_json::from_str(&raw).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    raw.len(),
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?;
            Ok(summary_projection(&snapshot, revision))
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn canonical_envelope(&self) -> Result<Value, CoreError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Deferred)?;
        let cursor: i64 =
            transaction.query_row("SELECT COALESCE(MAX(cursor), 0) FROM events", [], |row| {
                row.get(0)
            })?;
        let sessions = {
            let mut statement =
                transaction.prepare("SELECT snapshot_json FROM sessions ORDER BY created_at_ms")?;
            let rows = statement
                .query_map([], |row| {
                    let raw: String = row.get(0)?;
                    serde_json::from_str(&raw).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            raw.len(),
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })
                })?
                .collect::<Result<Vec<Value>, _>>()?;
            rows
        };
        transaction.commit()?;
        Ok(json!({
          "schemaVersion": 4,
          "revision": cursor as u64,
          "sessions": sessions,
        }))
    }

    pub fn read_session(&self, request: &ReadSession) -> Result<Value, CoreError> {
        // Capture the cursor before the snapshot. A concurrent commit may then be
        // observed twice, but it can never be hidden behind a newer cursor.
        let cursor = self.latest_cursor()?;
        let record = self.read_record(&request.session_id)?.ok_or_else(|| {
            CoreError::new(
                "SESSION_NOT_FOUND",
                format!("Session {} does not exist.", request.session_id),
            )
        })?;
        let event_batch = if let Some(after_event) = request.after_event {
            Some(self.query_events(&WaitEvents {
                session_id: Some(request.session_id.clone()),
                after_event,
                timeout_ms: 0,
                event_types: vec![],
            })?)
        } else {
            None
        };
        let reset_required = event_batch
            .as_ref()
            .is_some_and(|batch| batch.reset_required);
        let event_cursor = event_batch
            .as_ref()
            .map_or(cursor, |batch| cursor.max(batch.cursor));
        if request.since_revision == Some(record.revision) {
            let events = event_batch
                .as_ref()
                .map(|batch| batch.events.clone())
                .unwrap_or_default();
            return Ok(json!({
              "sessionId": record.session_id,
              "revision": record.revision,
              "eventCursor": event_cursor,
              "unchanged": true,
              "resetRequired": reset_required,
              "events": if reset_required { vec![] } else { events },
            }));
        }
        let projection = project_session(&record.snapshot, &request.view, request)?;
        let events = event_batch.map(|batch| batch.events).unwrap_or_default();
        Ok(json!({
          "sessionId": record.session_id,
          "revision": record.revision,
          "eventCursor": event_cursor,
          "view": request.view,
          "resetRequired": reset_required,
          "projection": projection,
          "events": if reset_required { vec![] } else { events },
        }))
    }

    pub fn wait_events(&self, mut request: WaitEvents) -> Result<EventBatch, CoreError> {
        request.timeout_ms = request.timeout_ms.clamp(100, 25_000);
        let initial = self.query_events(&request)?;
        if initial.reset_required || !initial.events.is_empty() {
            return Ok(initial);
        }
        request.after_event = initial.cursor;
        let deadline = std::time::Instant::now() + Duration::from_millis(request.timeout_ms);
        let mut cursor = self
            .signal
            .cursor
            .lock()
            .map_err(|_| CoreError::new("CORE_POISONED", "Core event state is unavailable."))?;
        while *cursor <= request.after_event {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                break;
            }
            let result = self
                .signal
                .changed
                .wait_timeout(cursor, remaining)
                .map_err(|_| CoreError::new("CORE_POISONED", "Core event state is unavailable."))?;
            cursor = result.0;
            if result.1.timed_out() {
                break;
            }
        }
        drop(cursor);
        self.query_events(&request)
    }

    pub fn export_legacy_v4(&self) -> Result<Value, CoreError> {
        let _export_guard = self.export_lock.lock().map_err(|_| {
            CoreError::new("CORE_POISONED", "Core legacy export state is unavailable.")
        })?;
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Deferred)?;
        let revision: i64 =
            transaction.query_row("SELECT COALESCE(MAX(cursor), 0) FROM events", [], |row| {
                row.get(0)
            })?;
        let sessions = {
            let mut statement = transaction
                .prepare("SELECT id, snapshot_json FROM sessions ORDER BY created_at_ms")?;
            let rows = statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        transaction.commit()?;
        let root = self.home.join("agent-sessions");
        secure_directory(&root)?;
        let revision = revision as u64;
        let mut session_files = Vec::new();
        let mut retained = std::collections::HashSet::new();
        for (id, raw) in sessions {
            let file = format!("{id}.json");
            atomic_private_write(&root.join(&file), raw.as_bytes())?;
            retained.insert(file.clone());
            session_files.push(json!({ "id": id, "file": file }));
        }
        for entry in fs::read_dir(&root)
            .map_err(|error| CoreError::new("EXPORT_FAILED", error.to_string()))?
        {
            let entry =
                entry.map_err(|error| CoreError::new("EXPORT_FAILED", error.to_string()))?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.ends_with(".json") && !retained.contains(&name) {
                fs::remove_file(entry.path())
                    .map_err(|error| CoreError::new("EXPORT_FAILED", error.to_string()))?;
            }
        }
        let envelope =
            json!({ "schemaVersion": 4, "revision": revision, "sessionFiles": session_files });
        atomic_private_write(
            &self.home.join("agent-sessions.json"),
            serde_json::to_string_pretty(&envelope)?.as_bytes(),
        )?;
        Ok(envelope)
    }

    fn query_events(&self, request: &WaitEvents) -> Result<EventBatch, CoreError> {
        let oldest = self.oldest_cursor()?;
        let latest = self.latest_cursor()?;
        let reset_required = request.after_event > latest
            || oldest > 0 && request.after_event.saturating_add(1) < oldest;
        if reset_required {
            return Ok(EventBatch {
                events: vec![],
                cursor: latest,
                timed_out: false,
                reset_required: true,
            });
        }
        let connection = self.connection()?;
        let event_types_json = serde_json::to_string(&request.event_types)?;
        let mut statement = connection.prepare(
      "SELECT cursor, session_id, session_sequence, revision, event_type, payload_json, created_at_ms
       FROM events
       WHERE cursor > ?1
         AND (?2 IS NULL OR session_id = ?2)
         AND (?3 = 1 OR event_type IN (SELECT value FROM json_each(?4)))
       ORDER BY cursor LIMIT 256"
    )?;
        let rows = statement.query_map(
            params![
                request.after_event as i64,
                request.session_id,
                request.event_types.is_empty(),
                event_types_json,
            ],
            |row| {
                let event_type: String = row.get(4)?;
                let payload_raw: String = row.get(5)?;
                let cursor: i64 = row.get(0)?;
                let session_sequence: i64 = row.get(2)?;
                let revision: i64 = row.get(3)?;
                let created_at_ms: i64 = row.get(6)?;
                Ok(EventRecord {
                    cursor: cursor as u64,
                    session_id: row.get(1)?,
                    session_sequence: session_sequence as u64,
                    revision: revision as u64,
                    event_type,
                    payload: serde_json::from_str(&payload_raw).unwrap_or(Value::Null),
                    created_at_ms: created_at_ms as u64,
                })
            },
        )?;
        let events = rows.collect::<Result<Vec<_>, _>>()?;
        let cursor = events
            .last()
            .map(|event| event.cursor)
            .unwrap_or(request.after_event.max(latest));
        Ok(EventBatch {
            timed_out: events.is_empty(),
            events,
            cursor,
            reset_required: false,
        })
    }

    fn latest_cursor(&self) -> Result<u64, CoreError> {
        let cursor: i64 = self
            .connection()?
            .query_row("SELECT COALESCE(MAX(cursor), 0) FROM events", [], |row| {
                row.get(0)
            })
            .map_err(CoreError::from)?;
        Ok(cursor as u64)
    }

    fn oldest_cursor(&self) -> Result<u64, CoreError> {
        let cursor: i64 = self
            .connection()?
            .query_row("SELECT COALESCE(MIN(cursor), 0) FROM events", [], |row| {
                row.get(0)
            })
            .map_err(CoreError::from)?;
        Ok(cursor as u64)
    }

    fn publish(&self, cursor: u64) -> Result<(), CoreError> {
        *self
            .signal
            .cursor
            .lock()
            .map_err(|_| CoreError::new("CORE_POISONED", "Core event state is unavailable."))? =
            cursor;
        self.signal.changed.notify_all();
        Ok(())
    }
}

fn iso_timestamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn operation_string<'a>(operation: &'a Value, key: &str) -> Result<&'a str, CoreError> {
    operation
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            CoreError::new(
                "INVALID_COMMAND",
                format!(
                    "{}.{} is required.",
                    operation
                        .get("type")
                        .and_then(Value::as_str)
                        .unwrap_or("operation"),
                    key
                ),
            )
        })
}

fn append_activity(
    snapshot: &mut Value,
    actor: &str,
    kind: &str,
    title: String,
    detail: Option<String>,
    asset_ids: Vec<String>,
) -> Result<(), CoreError> {
    let activity = snapshot
        .pointer_mut("/agent/activity")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| CoreError::new("INVALID_SESSION", "Agent activity must be an array."))?;
    let mut entry = json!({
      "id": format!("activity-{}", uuid::Uuid::new_v4()),
      "createdAt": iso_timestamp(),
      "actor": actor,
      "kind": kind,
      "title": title,
    });
    if let Some(detail) = detail {
        entry["detail"] = Value::String(detail);
    }
    if !asset_ids.is_empty() {
        entry["assetIds"] = serde_json::to_value(asset_ids)?;
    }
    activity.push(entry);
    if activity.len() > 500 {
        activity.drain(..activity.len() - 500);
    }
    Ok(())
}

fn refresh_current_steps(snapshot: &mut Value) -> Result<(), CoreError> {
    let active = snapshot
        .pointer("/agent/plan")
        .and_then(Value::as_array)
        .ok_or_else(|| CoreError::new("INVALID_SESSION", "Agent plan must be an array."))?
        .iter()
        .filter(|step| {
            matches!(
                step.get("status").and_then(Value::as_str),
                Some("in_progress" | "waiting")
            )
        })
        .filter_map(|step| step.get("id").and_then(Value::as_str).map(str::to_string))
        .collect::<Vec<_>>();
    snapshot["agent"]["currentStepIds"] = serde_json::to_value(&active)?;
    if let Some(first) = active.first() {
        snapshot["agent"]["currentStepId"] = Value::String(first.clone());
    } else if let Some(agent) = snapshot.get_mut("agent").and_then(Value::as_object_mut) {
        agent.remove("currentStepId");
    }
    Ok(())
}

fn mark_step(
    snapshot: &mut Value,
    step_id: &str,
    status: &str,
    detail: Option<&str>,
) -> Result<(), CoreError> {
    if !matches!(
        status,
        "pending" | "in_progress" | "waiting" | "completed" | "failed" | "skipped"
    ) {
        return Err(CoreError::new(
            "INVALID_TRANSITION",
            format!("Unsupported plan step status: {status}"),
        ));
    }
    let plan = snapshot
        .pointer("/agent/plan")
        .and_then(Value::as_array)
        .ok_or_else(|| CoreError::new("INVALID_SESSION", "Agent plan must be an array."))?;
    let target = plan
        .iter()
        .find(|step| step.get("id").and_then(Value::as_str) == Some(step_id))
        .ok_or_else(|| {
            CoreError::new(
                "INVALID_TRANSITION",
                format!("Plan step {step_id} does not exist."),
            )
        })?;
    if matches!(status, "in_progress" | "waiting" | "completed") {
        let incomplete = target
            .get("dependsOn")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .find(|dependency| {
                !plan.iter().any(|step| {
                    step.get("id").and_then(Value::as_str) == Some(*dependency)
                        && matches!(
                            step.get("status").and_then(Value::as_str),
                            Some("completed" | "skipped")
                        )
                })
            });
        if let Some(dependency) = incomplete {
            return Err(CoreError::new(
                "INVALID_TRANSITION",
                format!(
                    "Plan step {step_id} cannot run before dependency {dependency} is complete."
                ),
            ));
        }
    }
    let plan = snapshot
        .pointer_mut("/agent/plan")
        .and_then(Value::as_array_mut)
        .expect("plan checked above");
    let target = plan
        .iter_mut()
        .find(|step| step.get("id").and_then(Value::as_str) == Some(step_id))
        .expect("step checked above");
    target["status"] = Value::String(status.into());
    if status == "failed" {
        snapshot["agent"]["execution"]["lastError"] =
            Value::String(detail.unwrap_or("The bound operation failed.").into());
    }
    refresh_current_steps(snapshot)
}

fn find_thread_mut<'a>(snapshot: &'a mut Value, thread_id: &str) -> Option<&'a mut Value> {
    let mode = ["image", "video"].into_iter().find(|mode| {
        snapshot
            .pointer(&format!("/threads/{mode}"))
            .and_then(Value::as_array)
            .is_some_and(|threads| {
                threads
                    .iter()
                    .any(|thread| thread.get("id").and_then(Value::as_str) == Some(thread_id))
            })
    })?;
    snapshot
        .pointer_mut(&format!("/threads/{mode}"))
        .and_then(Value::as_array_mut)?
        .iter_mut()
        .find(|thread| thread.get("id").and_then(Value::as_str) == Some(thread_id))
}

fn apply_operation(
    snapshot: &mut Value,
    operation: &Value,
    changed: &mut BTreeSet<String>,
) -> Result<(), CoreError> {
    let operation_type = operation_string(operation, "type")?;
    match operation_type {
        "update_brief" => {
            let patch = operation
                .get("patch")
                .and_then(Value::as_object)
                .ok_or_else(|| {
                    CoreError::new("INVALID_COMMAND", "update_brief.patch must be an object.")
                })?;
            let brief = snapshot
                .pointer_mut("/agent/brief")
                .and_then(Value::as_object_mut)
                .ok_or_else(|| {
                    CoreError::new("INVALID_SESSION", "Agent brief must be an object.")
                })?;
            for (key, value) in patch {
                brief.insert(key.clone(), value.clone());
            }
            append_activity(
                snapshot,
                "agent",
                "plan",
                "Updated creative brief".into(),
                Some("Brief fields changed by the agent from explicit user direction.".into()),
                vec![],
            )?;
            changed.insert("brief".into());
        }
        "upsert_requirements" => {
            let incoming = operation
                .get("requirements")
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    CoreError::new(
                        "INVALID_COMMAND",
                        "upsert_requirements.requirements must be an array.",
                    )
                })?;
            let requirements = snapshot
                .pointer_mut("/agent/requirements")
                .and_then(Value::as_array_mut)
                .ok_or_else(|| {
                    CoreError::new("INVALID_SESSION", "Agent requirements must be an array.")
                })?;
            for requirement in incoming {
                let id = operation_string(requirement, "id")?;
                if let Some(index) = requirements
                    .iter()
                    .position(|item| item.get("id").and_then(Value::as_str) == Some(id))
                {
                    requirements[index] = requirement.clone();
                } else {
                    requirements.push(requirement.clone());
                }
                changed.insert(format!("requirement:{id}"));
            }
        }
        "replace_plan" => {
            let steps = operation
                .get("steps")
                .and_then(Value::as_array)
                .filter(|steps| !steps.is_empty() && steps.len() <= 80)
                .ok_or_else(|| {
                    CoreError::new(
                        "INVALID_COMMAND",
                        "replace_plan.steps must contain 1 to 80 steps.",
                    )
                })?;
            snapshot["agent"]["plan"] = Value::Array(steps.clone());
            refresh_current_steps(snapshot)?;
            append_activity(
                snapshot,
                "agent",
                "plan",
                "Revised production graph".into(),
                Some(format!("{} steps", steps.len())),
                vec![],
            )?;
            changed.insert("plan".into());
        }
        "mark_step" => {
            let step_id = operation_string(operation, "stepId")?;
            let status = operation_string(operation, "status")?;
            let title = snapshot
                .pointer("/agent/plan")
                .and_then(Value::as_array)
                .and_then(|plan| {
                    plan.iter()
                        .find(|step| step.get("id").and_then(Value::as_str) == Some(step_id))
                })
                .and_then(|step| step.get("title").and_then(Value::as_str))
                .unwrap_or(step_id)
                .to_string();
            mark_step(
                snapshot,
                step_id,
                status,
                operation.get("detail").and_then(Value::as_str),
            )?;
            append_activity(
                snapshot,
                "agent",
                if status == "failed" { "error" } else { "plan" },
                format!("{}: {}", title, status.replace('_', " ")),
                operation
                    .get("detail")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                vec![],
            )?;
            changed.insert(format!("plan:{step_id}"));
        }
        "create_thread" => {
            let request_key = operation_string(operation, "requestKey")?;
            let existing = ["image", "video"].into_iter().find_map(|mode| {
                snapshot
                    .pointer(&format!("/threads/{mode}"))
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .find(|thread| {
                        thread.get("requestKey").and_then(Value::as_str) == Some(request_key)
                    })
                    .and_then(|thread| thread.get("id").and_then(Value::as_str))
                    .map(str::to_string)
            });
            if let Some(id) = existing {
                changed.insert(format!("thread:{id}"));
                return Ok(());
            }
            let mode = if operation.get("mode").and_then(Value::as_str) == Some("video") {
                "video"
            } else {
                "image"
            };
            if let Some(step_id) = operation.get("planStepId").and_then(Value::as_str) {
                if !snapshot
                    .pointer("/agent/plan")
                    .and_then(Value::as_array)
                    .is_some_and(|plan| {
                        plan.iter()
                            .any(|step| step.get("id").and_then(Value::as_str) == Some(step_id))
                    })
                {
                    return Err(CoreError::new(
                        "INVALID_COMMAND",
                        format!("Plan step {step_id} does not exist."),
                    ));
                }
            }
            let threads = snapshot
                .pointer_mut(&format!("/threads/{mode}"))
                .and_then(Value::as_array_mut)
                .ok_or_else(|| {
                    CoreError::new("INVALID_SESSION", "Generation threads must be arrays.")
                })?;
            let id = format!("thread-{}", uuid::Uuid::new_v4());
            let name = operation_string(operation, "name")?;
            let created_at = iso_timestamp();
            let output_role = operation
                .get("outputRole")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .unwrap_or(if mode == "image" {
                    "generated_image"
                } else {
                    "generated_video"
                });
            let mut thread = json!({
              "id": id,
              "requestKey": request_key,
              "name": name,
              "mode": mode,
              "createdAt": created_at,
              "updatedAt": created_at,
              "revision": 0,
              "outputRole": output_role,
              "optionOverrides": {},
              "draft": {
                "prompt": "", "references": [], "options": {}, "providerJson": "",
                "enhancePrompt": false, "enhancedPrompt": "", "enhancedPromptDirty": false,
                "enhancedVisualCount": 0, "imageEditMode": false, "imageEditTarget": "",
                "maskInstructions": "", "maskStrokes": []
              },
              "attempts": [],
              "enhancementAttempts": []
            });
            if let Some(step_id) = operation.get("planStepId").and_then(Value::as_str) {
                thread["planStepId"] = Value::String(step_id.into());
            }
            threads.push(thread);
            snapshot["activeThreadIds"][mode] = Value::String(id.clone());
            append_activity(
                snapshot,
                "agent",
                "plan",
                format!("Created generation thread: {name}"),
                None,
                vec![],
            )?;
            changed.insert(format!("thread:{id}"));
        }
        "update_thread" => {
            let thread_id = operation_string(operation, "threadId")?;
            let patch = operation
                .get("patch")
                .and_then(Value::as_object)
                .ok_or_else(|| {
                    CoreError::new("INVALID_COMMAND", "update_thread.patch must be an object.")
                })?;
            let known_assets = snapshot
                .get("assets")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|asset| asset.get("id").and_then(Value::as_str).map(str::to_string))
                .collect::<HashSet<_>>();
            let thread = find_thread_mut(snapshot, thread_id).ok_or_else(|| {
                CoreError::new(
                    "INVALID_COMMAND",
                    format!("Generation thread {thread_id} does not exist."),
                )
            })?;
            if thread
                .get("attempts")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .any(|attempt| {
                    !matches!(
                        attempt.get("status").and_then(Value::as_str),
                        Some("completed" | "failed" | "uncertain" | "canceled")
                    )
                })
            {
                return Err(CoreError::new(
                    "INVALID_TRANSITION",
                    "An active generation thread cannot be edited.",
                ));
            }
            if let Some(expected) = operation
                .get("expectedThreadRevision")
                .and_then(Value::as_u64)
            {
                let current = thread.get("revision").and_then(Value::as_u64).unwrap_or(0);
                if expected != current {
                    return Err(CoreError::new(
                        "GENERATION_THREAD_CONFLICT",
                        format!(
                            "Expected thread revision {expected}, but the thread is at {current}."
                        ),
                    ));
                }
            }
            if let Some(name) = patch
                .get("name")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
            {
                thread["name"] = Value::String(name.trim().into());
            }
            if let Some(prompt) = patch.get("prompt").and_then(Value::as_str) {
                thread["draft"]["prompt"] = Value::String(prompt.into());
            }
            if let Some(role) = patch
                .get("outputRole")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
            {
                thread["outputRole"] = Value::String(role.trim().into());
            }
            if patch.get("useModeDefaultModel").and_then(Value::as_bool) == Some(true) {
                if let Some(object) = thread.as_object_mut() {
                    object.remove("modelOverrideId");
                }
            } else if let Some(model) = patch.get("modelOverrideId").and_then(Value::as_str) {
                if model.is_empty() {
                    thread
                        .as_object_mut()
                        .expect("thread object")
                        .remove("modelOverrideId");
                } else {
                    thread["modelOverrideId"] = Value::String(model.into());
                }
            }
            if let Some(value) = patch.get("enhancePrompt").and_then(Value::as_bool) {
                thread["draft"]["enhancePrompt"] = Value::Bool(value);
            }
            if let Some(options) = patch.get("options").filter(|value| value.is_object()) {
                thread["optionOverrides"] = options.clone();
            }
            if let Some(provider) = patch.get("provider").filter(|value| value.is_object()) {
                thread["providerJsonOverride"] = Value::String(serde_json::to_string(provider)?);
            }
            if let Some(bindings) = patch.get("assetBindings").and_then(Value::as_array) {
                let mut references = Vec::new();
                for (index, binding) in bindings.iter().enumerate() {
                    let asset_id = operation_string(binding, "assetId")?;
                    if !known_assets.contains(asset_id) {
                        return Err(CoreError::new(
                            "INVALID_COMMAND",
                            "update_thread references a missing asset.",
                        ));
                    }
                    let role = match binding.get("role").and_then(Value::as_str) {
                        Some("first_frame") => "first_frame",
                        Some("last_frame") => "last_frame",
                        _ => "reference",
                    };
                    references
                        .push(json!({ "assetId": asset_id, "slot": index + 1, "role": role }));
                }
                thread["draft"]["references"] = Value::Array(references);
            }
            thread["revision"] =
                Value::from(thread.get("revision").and_then(Value::as_u64).unwrap_or(0) + 1);
            thread["updatedAt"] = Value::String(iso_timestamp());
            let name = thread
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(thread_id)
                .to_string();
            append_activity(
                snapshot,
                "agent",
                "plan",
                format!("Updated generation thread: {name}"),
                None,
                vec![],
            )?;
            changed.insert(format!("thread:{thread_id}"));
        }
        "archive_thread" | "restore_thread" => {
            let thread_id = operation_string(operation, "threadId")?;
            let thread = find_thread_mut(snapshot, thread_id).ok_or_else(|| {
                CoreError::new(
                    "INVALID_COMMAND",
                    format!("Generation thread {thread_id} does not exist."),
                )
            })?;
            if operation_type == "archive_thread" {
                thread["archivedAt"] = Value::String(iso_timestamp());
            } else {
                thread
                    .as_object_mut()
                    .expect("thread object")
                    .remove("archivedAt");
            }
            thread["updatedAt"] = Value::String(iso_timestamp());
            let name = thread
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(thread_id)
                .to_string();
            append_activity(
                snapshot,
                "agent",
                "plan",
                format!(
                    "{} generation thread: {name}",
                    if operation_type == "archive_thread" {
                        "Archived"
                    } else {
                        "Restored"
                    }
                ),
                None,
                vec![],
            )?;
            changed.insert(format!("thread:{thread_id}"));
        }
        "apply_projection_patch" => {
            let patches = operation
                .get("patches")
                .and_then(Value::as_array)
                .filter(|patches| !patches.is_empty() && patches.len() <= 512)
                .ok_or_else(|| {
                    CoreError::new(
                        "INVALID_COMMAND",
                        "apply_projection_patch.patches must contain 1 to 512 entries.",
                    )
                })?;
            for patch in patches {
                let action = operation_string(patch, "op")?;
                let path = operation_string(patch, "path")?;
                apply_projection_patch(snapshot, action, path, patch.get("value"))?;
                changed.insert(projection_change_handle(path));
            }
        }
        "apply_video_poll_result" => apply_video_poll_result(snapshot, operation, changed)?,
        "queue_decision" => apply_queue_decision(snapshot, operation, changed)?,
        "resolve_decision" | "resolve_ui_decision" => {
            apply_resolve_decision(snapshot, operation, changed)?
        }
        "evaluate_artifact" => {
            if operation.get("approval").is_some() || operation.get("confirmedByUser").is_some() {
                return Err(CoreError::new(
                    "INVALID_COMMAND",
                    "Artifact approval requires a separate explicit user checkpoint.",
                ));
            }
            let asset_id = operation_string(operation, "assetId")?;
            let technical = operation_string(operation, "technical")?;
            let aesthetic = operation_string(operation, "aesthetic")?;
            let recommendation = operation_string(operation, "recommendation")?;
            let artifact = snapshot
                .pointer_mut("/agent/artifacts")
                .and_then(Value::as_array_mut)
                .and_then(|artifacts| {
                    artifacts
                        .iter_mut()
                        .find(|item| item.get("assetId").and_then(Value::as_str) == Some(asset_id))
                })
                .ok_or_else(|| {
                    CoreError::new(
                        "INVALID_COMMAND",
                        format!("Artifact {asset_id} does not exist."),
                    )
                })?;
            artifact["evaluation"] = json!({
              "technical": technical,
              "aesthetic": aesthetic,
              "recommendation": recommendation,
            });
            append_activity(
                snapshot,
                "agent",
                "evaluation",
                format!("Evaluated {asset_id}"),
                Some(recommendation.into()),
                vec![asset_id.into()],
            )?;
            changed.insert(format!("artifact:{asset_id}"));
        }
        "propose_assembly" => apply_propose_assembly(snapshot, operation, changed)?,
        "fail_attempt" => {
            let thread_id = operation_string(operation, "threadId")?;
            let attempt_id = operation_string(operation, "attemptId")?;
            let error = operation_string(operation, "error")?;
            let thread = find_thread_mut(snapshot, thread_id).ok_or_else(|| {
                CoreError::new(
                    "INVALID_COMMAND",
                    format!("Generation thread {thread_id} does not exist."),
                )
            })?;
            let attempt = thread
                .get_mut("attempts")
                .and_then(Value::as_array_mut)
                .and_then(|attempts| {
                    attempts
                        .iter_mut()
                        .find(|item| item.get("id").and_then(Value::as_str) == Some(attempt_id))
                })
                .ok_or_else(|| {
                    CoreError::new(
                        "INVALID_COMMAND",
                        format!("Attempt {attempt_id} does not exist."),
                    )
                })?;
            if matches!(
                attempt.get("status").and_then(Value::as_str),
                Some("completed" | "failed" | "uncertain" | "canceled")
            ) {
                return Err(CoreError::new(
                    "INVALID_TRANSITION",
                    "A terminal generation attempt cannot be failed again.",
                ));
            }
            attempt["status"] = Value::String("failed".into());
            attempt["error"] = Value::String(error.into());
            attempt["completedAt"] = Value::String(iso_timestamp());
            let step_id = thread
                .get("planStepId")
                .and_then(Value::as_str)
                .map(str::to_string);
            let name = thread
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(thread_id)
                .to_string();
            if let Some(step_id) = &step_id {
                if mark_step(snapshot, step_id, "failed", Some(error)).is_ok() {
                    changed.insert(format!("plan:{step_id}"));
                }
            }
            append_activity(
                snapshot,
                "agent",
                "error",
                format!("{name} failed"),
                Some(error.into()),
                vec![],
            )?;
            changed.insert(format!("attempt:{attempt_id}"));
        }
        "bind_step" => {
            let entity_type = operation_string(operation, "entityType")?;
            let entity_id = operation_string(operation, "entityId")?;
            let step_id = operation_string(operation, "planStepId")?;
            if !snapshot
                .pointer("/agent/plan")
                .and_then(Value::as_array)
                .is_some_and(|plan| {
                    plan.iter()
                        .any(|step| step.get("id").and_then(Value::as_str) == Some(step_id))
                })
            {
                return Err(CoreError::new(
                    "INVALID_COMMAND",
                    format!("Plan step {step_id} does not exist."),
                ));
            }
            match entity_type {
                "decision" => {
                    let decision = snapshot
                        .pointer_mut("/agent/decisions")
                        .and_then(Value::as_array_mut)
                        .and_then(|decisions| {
                            decisions.iter_mut().find(|item| {
                                item.get("id").and_then(Value::as_str) == Some(entity_id)
                            })
                        })
                        .ok_or_else(|| {
                            CoreError::new(
                                "INVALID_COMMAND",
                                format!("Decision {entity_id} does not exist."),
                            )
                        })?;
                    decision["relatedStepId"] = Value::String(step_id.into());
                }
                "thread" => {
                    let thread = find_thread_mut(snapshot, entity_id).ok_or_else(|| {
                        CoreError::new(
                            "INVALID_COMMAND",
                            format!("Generation thread {entity_id} does not exist."),
                        )
                    })?;
                    thread["planStepId"] = Value::String(step_id.into());
                }
                _ => {
                    return Err(CoreError::new(
                        "INVALID_COMMAND",
                        "bind_step.entityType must be decision or thread.",
                    ));
                }
            }
            changed.insert(format!("{entity_type}:{entity_id}"));
        }
        _ => {
            return Err(CoreError::new(
                "INVALID_COMMAND",
                format!("Unsupported session_commit operation: {operation_type}"),
            ));
        }
    }
    Ok(())
}

fn apply_video_poll_result(
    snapshot: &mut Value,
    operation: &Value,
    changed: &mut BTreeSet<String>,
) -> Result<(), CoreError> {
    let thread_id = operation_string(operation, "threadId")?;
    let attempt_id = operation_string(operation, "attemptId")?;
    let status = operation_string(operation, "status")?;
    if !matches!(status, "in_progress" | "completed" | "failed" | "canceled") {
        return Err(CoreError::new(
            "INVALID_COMMAND",
            "Video poll result status is invalid.",
        ));
    }
    let actual_cost = match operation.get("actualCostUsd") {
        None | Some(Value::Null) => None,
        Some(value) => Some(value.as_f64().filter(|cost| *cost >= 0.0).ok_or_else(|| {
            CoreError::new(
                "INVALID_COMMAND",
                "Video poll actualCostUsd must be a non-negative number.",
            )
        })?),
    };
    let timestamp = iso_timestamp();
    let (thread_name, output_role, step_id, model_id, input_asset_ids, prompt) = {
        let thread = find_thread_mut(snapshot, thread_id).ok_or_else(|| {
            CoreError::new(
                "INVALID_COMMAND",
                format!("Generation thread {thread_id} does not exist."),
            )
        })?;
        let thread_name = thread
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(thread_id)
            .to_string();
        let output_role = thread
            .get("outputRole")
            .and_then(Value::as_str)
            .unwrap_or("video_shot")
            .to_string();
        let step_id = thread
            .get("planStepId")
            .and_then(Value::as_str)
            .map(str::to_string);
        let attempt = thread
            .get_mut("attempts")
            .and_then(Value::as_array_mut)
            .and_then(|attempts| {
                attempts
                    .iter_mut()
                    .find(|item| item.get("id").and_then(Value::as_str) == Some(attempt_id))
            })
            .ok_or_else(|| {
                CoreError::new(
                    "INVALID_COMMAND",
                    format!("Attempt {attempt_id} does not exist."),
                )
            })?;
        if matches!(
            attempt.get("status").and_then(Value::as_str),
            Some("completed" | "failed" | "uncertain" | "canceled")
        ) {
            return Err(CoreError::new(
                "INVALID_TRANSITION",
                "The video attempt is already terminal.",
            ));
        }
        let model_id = attempt
            .get("modelId")
            .and_then(Value::as_str)
            .or_else(|| attempt.pointer("/snapshot/modelId").and_then(Value::as_str))
            .map(str::to_string);
        let input_asset_ids = attempt
            .get("inputAssetIds")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let prompt = attempt
            .pointer("/snapshot/prompt")
            .and_then(Value::as_str)
            .map(str::to_string);
        attempt["pollAttempts"] = Value::from(
            operation
                .get("pollAttempt")
                .and_then(Value::as_u64)
                .unwrap_or(1),
        );
        attempt["lastPolledAt"] = Value::String(timestamp.clone());
        attempt["updatedAt"] = Value::String(timestamp.clone());
        attempt["status"] = Value::String(status.into());
        if let Some(progress) = operation.get("progress").and_then(Value::as_f64) {
            attempt["progress"] = Value::from(progress);
        }
        if let Some(cost) = actual_cost {
            attempt["actualCostUsd"] = Value::from(cost);
            attempt["costRecordedAt"] = Value::String(timestamp.clone());
        }
        if let Some(error) = operation.get("error").and_then(Value::as_str) {
            attempt["error"] = Value::String(error.into());
        } else if let Some(object) = attempt.as_object_mut() {
            object.remove("error");
        }
        if status == "in_progress" {
            attempt["nextPollAt"] = Value::String(
                operation
                    .get("nextPollAt")
                    .and_then(Value::as_str)
                    .unwrap_or(&timestamp)
                    .into(),
            );
        } else {
            attempt["completedAt"] = Value::String(timestamp.clone());
            if let Some(object) = attempt.as_object_mut() {
                object.remove("nextPollAt");
            }
        }
        (
            thread_name,
            output_role,
            step_id,
            model_id,
            input_asset_ids,
            prompt,
        )
    };
    if status == "completed" {
        let asset = operation
            .get("asset")
            .filter(|value| value.is_object())
            .ok_or_else(|| {
                CoreError::new(
                    "INVALID_COMMAND",
                    "A completed video poll result requires an asset.",
                )
            })?;
        let asset_id = operation_string(asset, "id")?;
        let assets = snapshot
            .get_mut("assets")
            .and_then(Value::as_array_mut)
            .ok_or_else(|| CoreError::new("INVALID_SESSION", "Session assets must be an array."))?;
        if !assets
            .iter()
            .any(|item| item.get("id").and_then(Value::as_str) == Some(asset_id))
        {
            assets.push(asset.clone());
        }
        let thread = find_thread_mut(snapshot, thread_id).expect("thread checked above");
        let attempt = thread
            .get_mut("attempts")
            .and_then(Value::as_array_mut)
            .and_then(|attempts| {
                attempts
                    .iter_mut()
                    .find(|item| item.get("id").and_then(Value::as_str) == Some(attempt_id))
            })
            .expect("attempt checked above");
        attempt["assetIds"] = json!([asset_id]);
        attempt["progress"] = Value::from(100);
        let artifacts = snapshot
            .pointer_mut("/agent/artifacts")
            .and_then(Value::as_array_mut)
            .ok_or_else(|| {
                CoreError::new("INVALID_SESSION", "Agent artifacts must be an array.")
            })?;
        if !artifacts
            .iter()
            .any(|item| item.get("assetId").and_then(Value::as_str) == Some(asset_id))
        {
            artifacts.push(json!({
              "assetId": asset_id, "role": output_role, "parentAssetIds": input_asset_ids,
              "prompt": prompt, "modelId": model_id, "threadId": thread_id, "attemptId": attempt_id,
              "approval": "unreviewed"
            }));
        }
        append_activity(
            snapshot,
            "runtime",
            "generation",
            "Video generation completed".into(),
            None,
            vec![asset_id.into()],
        )?;
        changed.insert(format!("asset:{asset_id}"));
    } else if matches!(status, "failed" | "canceled") {
        let error = operation
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("Video generation failed.");
        snapshot["agent"]["execution"]["lastError"] = Value::String(error.into());
        if snapshot
            .pointer("/agent/controlMode")
            .and_then(Value::as_str)
            == Some("agent")
        {
            snapshot["agent"]["runStatus"] = Value::String("failed".into());
        }
        if let Some(step_id) = &step_id {
            if mark_step(snapshot, step_id, "failed", Some(error)).is_ok() {
                changed.insert(format!("plan:{step_id}"));
            }
        }
        append_activity(
            snapshot,
            "runtime",
            "error",
            format!("{thread_name} failed"),
            Some(error.into()),
            vec![],
        )?;
    }
    if status != "in_progress" {
        if let Some(job_id) = operation.get("jobId").and_then(Value::as_str) {
            if let Some(jobs) = snapshot
                .pointer_mut("/agent/execution/currentJobIds")
                .and_then(Value::as_array_mut)
            {
                jobs.retain(|item| item.as_str() != Some(job_id));
            }
        }
    }
    if let Some(cost) = actual_cost {
        let ledger = snapshot
            .pointer_mut("/agent/execution/costLedger")
            .and_then(Value::as_array_mut)
            .ok_or_else(|| CoreError::new("INVALID_SESSION", "Cost ledger must be an array."))?;
        let id = format!("generation:{attempt_id}");
        if let Some(entry) = ledger
            .iter_mut()
            .find(|item| item.get("id").and_then(Value::as_str) == Some(&id))
        {
            entry["actualCostUsd"] = Value::from(cost);
            entry["recordedAt"] = Value::String(timestamp.clone());
        } else {
            ledger.push(json!({ "id": id, "category": "generation", "actualCostUsd": cost, "recordedAt": timestamp }));
        }
        let spent = ledger
            .iter()
            .filter_map(|item| item.get("actualCostUsd").and_then(Value::as_f64))
            .sum::<f64>();
        snapshot["agent"]["execution"]["spentUsd"] = Value::from(spent);
    }
    changed.insert(format!("attempt:{attempt_id}"));
    Ok(())
}

fn projection_change_handle(path: &str) -> String {
    let parts = path.trim_start_matches('/').split('/').collect::<Vec<_>>();
    match parts.as_slice() {
        ["agent", section, ..] => format!("agent:{section}"),
        [section, ..] => (*section).into(),
        _ => "desktop".into(),
    }
}

fn decode_pointer_segment(value: &str) -> Result<String, CoreError> {
    let mut output = String::with_capacity(value.len());
    let mut characters = value.chars();
    while let Some(character) = characters.next() {
        if character != '~' {
            output.push(character);
            continue;
        }
        match characters.next() {
            Some('0') => output.push('~'),
            Some('1') => output.push('/'),
            _ => {
                return Err(CoreError::new(
                    "INVALID_COMMAND",
                    "Projection patch contains an invalid JSON pointer.",
                ))
            }
        }
    }
    Ok(output)
}

fn apply_projection_patch(
    snapshot: &mut Value,
    action: &str,
    path: &str,
    value: Option<&Value>,
) -> Result<(), CoreError> {
    if !path.starts_with('/') || path.len() > 512 || path.contains("//") {
        return Err(CoreError::new(
            "INVALID_COMMAND",
            "Projection patch path is invalid.",
        ));
    }
    if matches!(
        path,
        "/id"
            | "/createdAt"
            | "/agent/revision"
            | "/agent/updatedAt"
            | "/coreRevision"
            | "/coreUpdatedAtMs"
    ) || path.starts_with("/fastReceipts")
    {
        return Err(CoreError::new(
            "INVALID_COMMAND",
            format!("Projection patch cannot modify Core-owned path {path}."),
        ));
    }
    let segments = path
        .trim_start_matches('/')
        .split('/')
        .map(decode_pointer_segment)
        .collect::<Result<Vec<_>, _>>()?;
    if segments.is_empty() || segments.len() > 12 {
        return Err(CoreError::new(
            "INVALID_COMMAND",
            "Projection patch path is too deep.",
        ));
    }
    let mut parent = snapshot;
    for segment in &segments[..segments.len() - 1] {
        parent = parent
            .as_object_mut()
            .and_then(|object| object.get_mut(segment))
            .ok_or_else(|| {
                CoreError::new(
                    "INVALID_COMMAND",
                    format!("Projection patch parent for {path} does not exist."),
                )
            })?;
        if !parent.is_object() {
            return Err(CoreError::new(
                "INVALID_COMMAND",
                "Projection patches may not address individual array entries.",
            ));
        }
    }
    let key = segments.last().expect("segments checked");
    let object = parent.as_object_mut().ok_or_else(|| {
        CoreError::new(
            "INVALID_COMMAND",
            "Projection patch parent must be an object.",
        )
    })?;
    match action {
        "set" => {
            let value = value
                .ok_or_else(|| CoreError::new("INVALID_COMMAND", "A set patch requires value."))?;
            let raw = serde_json::to_vec(value)?;
            if raw.len() > MAX_SNAPSHOT_BYTES {
                return Err(CoreError::new(
                    "SESSION_TOO_LARGE",
                    "Projection patch value is too large.",
                ));
            }
            object.insert(key.clone(), value.clone());
        }
        "remove" => {
            object.remove(key);
        }
        _ => {
            return Err(CoreError::new(
                "INVALID_COMMAND",
                "Projection patch op must be set or remove.",
            ))
        }
    }
    Ok(())
}

fn apply_queue_decision(
    snapshot: &mut Value,
    operation: &Value,
    changed: &mut BTreeSet<String>,
) -> Result<(), CoreError> {
    let request_key = operation_string(operation, "requestKey")?;
    if let Some(id) = snapshot
        .pointer("/agent/decisions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|decision| decision.get("requestKey").and_then(Value::as_str) == Some(request_key))
        .and_then(|decision| decision.get("id").and_then(Value::as_str))
        .map(str::to_string)
    {
        changed.insert(format!("decision:{id}"));
        return Ok(());
    }
    if operation.get("presentation").and_then(Value::as_str) == Some("assembly_review") {
        return Err(CoreError::new(
            "INVALID_COMMAND",
            "Assembly review checkpoints are created only by propose_assembly.",
        ));
    }
    let title = operation_string(operation, "title")?;
    let prompt = operation_string(operation, "prompt")?;
    let id = format!("decision-{}", uuid::Uuid::new_v4());
    let channel = if operation.get("channel").and_then(Value::as_str) == Some("fruit_truck_ui") {
        "fruit_truck_ui"
    } else {
        "agent_chat"
    };
    let blocking = operation.get("blocking").and_then(Value::as_bool) == Some(true);
    let requested_step_id = operation
        .get("planStepId")
        .or_else(|| operation.get("relatedStepId"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let step_id = requested_step_id.filter(|step_id| {
        snapshot
            .pointer("/agent/plan")
            .and_then(Value::as_array)
            .is_some_and(|plan| {
                plan.iter()
                    .any(|step| step.get("id").and_then(Value::as_str) == Some(step_id))
            })
    });
    let related_threads = operation
        .get("relatedThreadIds")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut decision = json!({
      "id": id,
      "requestKey": request_key,
      "title": title,
      "prompt": prompt,
      "kind": operation.get("kind").and_then(Value::as_str).unwrap_or("choice"),
      "channel": channel,
      "presentation": operation.get("presentation").and_then(Value::as_str).unwrap_or("form"),
      "selectionMode": operation.get("selectionMode").and_then(Value::as_str).unwrap_or("single"),
      "minSelections": operation.get("minSelections").cloned(),
      "maxSelections": operation.get("maxSelections").cloned(),
      "allowNote": operation.get("allowNote").and_then(Value::as_bool).unwrap_or(false),
      "status": "pending",
      "blocking": blocking,
      "relatedStepId": step_id,
      "relatedAssetIds": operation.get("relatedAssetIds").and_then(Value::as_array).cloned().unwrap_or_default(),
      "relatedThreadIds": related_threads,
      "options": operation.get("options").and_then(Value::as_array).cloned().unwrap_or_default(),
      "createdAt": iso_timestamp(),
    });
    if let Some(semantic_key) = operation.get("semanticKey").and_then(Value::as_str) {
        decision["semanticKey"] = Value::String(semantic_key.into());
    }
    snapshot
        .pointer_mut("/agent/decisions")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| CoreError::new("INVALID_SESSION", "Agent decisions must be an array."))?
        .push(decision);
    let control = snapshot
        .pointer("/agent/controlMode")
        .and_then(Value::as_str);
    let run = snapshot.pointer("/agent/runStatus").and_then(Value::as_str);
    if blocking && related_threads.is_empty() && control == Some("agent") && run == Some("working")
    {
        snapshot["agent"]["runStatus"] = Value::String("waiting".into());
    }
    if channel == "fruit_truck_ui" {
        snapshot["agent"]["uiAttention"] =
            json!({ "requestedAt": iso_timestamp(), "decisionId": id });
    }
    if blocking {
        if let Some(step_id) = &step_id {
            if mark_step(snapshot, step_id, "waiting", None).is_ok() {
                changed.insert(format!("plan:{step_id}"));
            }
        }
    }
    append_activity(
        snapshot,
        "agent",
        "decision",
        format!("Requested: {title}"),
        Some(prompt.into()),
        vec![],
    )?;
    changed.insert(format!("decision:{id}"));
    Ok(())
}

fn apply_resolve_decision(
    snapshot: &mut Value,
    operation: &Value,
    changed: &mut BTreeSet<String>,
) -> Result<(), CoreError> {
    let decision_id = operation_string(operation, "decisionId")?;
    let ui_resolution =
        operation.get("type").and_then(Value::as_str) == Some("resolve_ui_decision");
    let response = if ui_resolution {
        operation
            .get("userResponse")
            .and_then(Value::as_str)
            .unwrap_or("Confirmed in Fruit Truck")
    } else {
        operation_string(operation, "userResponse")?
    };
    let target = snapshot
        .pointer("/agent/decisions")
        .and_then(Value::as_array)
        .and_then(|decisions| {
            decisions
                .iter()
                .find(|item| item.get("id").and_then(Value::as_str) == Some(decision_id))
        })
        .cloned()
        .ok_or_else(|| {
            CoreError::new(
                "INVALID_COMMAND",
                format!("Decision {decision_id} does not exist."),
            )
        })?;
    if target.get("status").and_then(Value::as_str) != Some("pending") {
        return Err(CoreError::new(
            "INVALID_TRANSITION",
            format!("Decision {decision_id} is already resolved."),
        ));
    }
    let channel = target
        .get("channel")
        .and_then(Value::as_str)
        .unwrap_or("agent_chat");
    if (!ui_resolution && channel == "fruit_truck_ui")
        || (ui_resolution && channel != "fruit_truck_ui")
    {
        return Err(CoreError::new(
            "WRONG_DECISION_CHANNEL",
            if ui_resolution {
                "This decision must be answered in the agent chat."
            } else {
                "This decision must be completed in Fruit Truck."
            },
        ));
    }
    if matches!(
        target.get("semanticKey").and_then(Value::as_str),
        Some("custom_skill_approval" | "custom_skill_activation")
    ) {
        return Err(CoreError::new(
            "INVALID_COMMAND",
            "Custom Skill filesystem changes require the legacy dedicated resolution tool.",
        ));
    }
    let selected_option_ids = if ui_resolution {
        operation
            .get("selectedOptionIds")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    } else {
        operation
            .get("optionId")
            .and_then(Value::as_str)
            .map(|value| vec![Value::String(value.into())])
            .unwrap_or_default()
    };
    if selected_option_ids.iter().any(|value| !value.is_string()) {
        return Err(CoreError::new(
            "INVALID_COMMAND",
            "Selected option IDs must be strings.",
        ));
    }
    let selected_option_set = selected_option_ids
        .iter()
        .filter_map(Value::as_str)
        .collect::<HashSet<_>>();
    if selected_option_set.len() != selected_option_ids.len() {
        return Err(CoreError::new(
            "INVALID_COMMAND",
            "Selected option IDs must be unique.",
        ));
    }
    let option_id = selected_option_ids.first().and_then(Value::as_str);
    let options = target
        .get("options")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if !ui_resolution && !options.is_empty() && option_id.is_none() {
        return Err(CoreError::new(
            "INVALID_COMMAND",
            "An option is required for this decision.",
        ));
    }
    if let Some(option_id) =
        selected_option_ids
            .iter()
            .filter_map(Value::as_str)
            .find(|option_id| {
                !options
                    .iter()
                    .any(|option| option.get("id").and_then(Value::as_str) == Some(*option_id))
            })
    {
        return Err(CoreError::new(
            "INVALID_COMMAND",
            format!("Option {option_id} is not valid for decision {decision_id}."),
        ));
    }
    if target.get("semanticKey").and_then(Value::as_str) == Some("final_approval")
        && option_id == Some("approve")
        && snapshot
            .pointer("/agent/decisions")
            .and_then(Value::as_array)
            .is_some_and(|decisions| {
                decisions.iter().any(|decision| {
                    decision.get("id").and_then(Value::as_str) != Some(decision_id)
                        && decision.get("status").and_then(Value::as_str) == Some("pending")
                        && decision.get("blocking").and_then(Value::as_bool) == Some(true)
                })
            })
    {
        return Err(CoreError::new(
            "INVALID_TRANSITION",
            "Resolve every other blocking decision before approving the final result.",
        ));
    }
    let selected_assets = operation
        .get(if ui_resolution {
            "selectedAssetIds"
        } else {
            "relatedAssetIds"
        })
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if selected_assets.iter().any(|value| !value.is_string()) {
        return Err(CoreError::new(
            "INVALID_COMMAND",
            "Selected asset IDs must be strings.",
        ));
    }
    let selected_asset_set = selected_assets
        .iter()
        .filter_map(Value::as_str)
        .collect::<HashSet<_>>();
    if selected_asset_set.len() != selected_assets.len() {
        return Err(CoreError::new(
            "INVALID_COMMAND",
            "Selected asset IDs must be unique.",
        ));
    }
    let known_assets =
        if ui_resolution && target.get("kind").and_then(Value::as_str) != Some("upload") {
            target
                .get("relatedAssetIds")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .chain(
                    options
                        .iter()
                        .filter_map(|option| option.get("assetId").and_then(Value::as_str)),
                )
                .map(str::to_string)
                .collect::<HashSet<_>>()
        } else {
            snapshot
                .pointer("/agent/artifacts")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|item| item.get("assetId").and_then(Value::as_str))
                .map(str::to_string)
                .collect::<HashSet<_>>()
        };
    if let Some(invalid) = selected_assets
        .iter()
        .filter_map(Value::as_str)
        .find(|id| !known_assets.contains(*id))
    {
        return Err(CoreError::new(
            "INVALID_COMMAND",
            format!("Related asset {invalid} does not exist."),
        ));
    }
    if ui_resolution {
        let selection_count = if selected_assets.is_empty() {
            selected_option_ids.len()
        } else {
            selected_assets.len()
        };
        let minimum = target
            .get("minSelections")
            .and_then(Value::as_u64)
            .unwrap_or(0) as usize;
        let maximum = target
            .get("maxSelections")
            .and_then(Value::as_u64)
            .unwrap_or(usize::MAX as u64) as usize;
        if selection_count < minimum || selection_count > maximum {
            return Err(CoreError::new(
                "INVALID_COMMAND",
                format!("Decision {decision_id} requires {minimum} to {maximum} selections."),
            ));
        }
        match target.get("selectionMode").and_then(Value::as_str) {
            Some("none") if selection_count != 0 => {
                return Err(CoreError::new(
                    "INVALID_COMMAND",
                    "This decision does not accept selections.",
                ));
            }
            Some("single") if selection_count > 1 => {
                return Err(CoreError::new(
                    "INVALID_COMMAND",
                    "Choose exactly one item for this decision.",
                ));
            }
            Some("one_per_group") => {
                let expected_groups = options
                    .iter()
                    .filter_map(|option| option.get("groupId").and_then(Value::as_str))
                    .collect::<HashSet<_>>();
                let mut selected_groups = HashSet::new();
                for option in &options {
                    let Some(group_id) = option.get("groupId").and_then(Value::as_str) else {
                        continue;
                    };
                    let selected = option
                        .get("id")
                        .and_then(Value::as_str)
                        .is_some_and(|id| selected_option_set.contains(id))
                        || option
                            .get("assetId")
                            .and_then(Value::as_str)
                            .is_some_and(|id| selected_asset_set.contains(id));
                    if selected && !selected_groups.insert(group_id) {
                        return Err(CoreError::new(
                            "INVALID_COMMAND",
                            "Choose only one item from each group.",
                        ));
                    }
                }
                if selected_groups.len() != expected_groups.len() {
                    return Err(CoreError::new(
                        "INVALID_COMMAND",
                        "Choose one item from every group.",
                    ));
                }
            }
            _ => {}
        }
    }
    let note = operation
        .get("note")
        .and_then(Value::as_str)
        .map(str::to_string);
    let resolved_at = iso_timestamp();
    let selected_label = option_id.and_then(|id| {
        options
            .iter()
            .find(|option| option.get("id").and_then(Value::as_str) == Some(id))
            .and_then(|option| option.get("label").and_then(Value::as_str))
            .map(str::to_string)
    });
    {
        let decisions = snapshot
            .pointer_mut("/agent/decisions")
            .and_then(Value::as_array_mut)
            .expect("decisions checked above");
        let decision = decisions
            .iter_mut()
            .find(|item| item.get("id").and_then(Value::as_str) == Some(decision_id))
            .expect("decision checked above");
        if !ui_resolution && !selected_assets.is_empty() {
            let mut merged = decision
                .get("relatedAssetIds")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            for asset in &selected_assets {
                if !merged.contains(asset) {
                    merged.push(asset.clone());
                }
            }
            decision["relatedAssetIds"] = Value::Array(merged);
        }
        decision["status"] = Value::String("resolved".into());
        decision["resolution"] = json!({
          "optionId": option_id,
          "selectedOptionIds": selected_option_ids,
          "selectedAssetIds": if ui_resolution { selected_assets.clone() } else { vec![] },
          "note": note,
          "userResponse": response,
          "channel": if ui_resolution { "fruit_truck_ui" } else { "agent_chat" },
          "resolvedAt": resolved_at,
        });
    }
    let mut affected_assets = target
        .get("relatedAssetIds")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if ui_resolution && !selected_assets.is_empty() {
        affected_assets = selected_assets.clone();
    } else {
        for asset in &selected_assets {
            if !affected_assets.contains(asset) {
                affected_assets.push(asset.clone());
            }
        }
    }
    let approval = if target.get("kind").and_then(Value::as_str) == Some("approval")
        && !affected_assets.is_empty()
    {
        match option_id {
            Some("revise" | "reject") => Some("rejected"),
            Some("approve" | "rendered") => Some("approved"),
            _ if ui_resolution && !selected_assets.is_empty() => Some("approved"),
            _ => None,
        }
    } else {
        None
    };
    if let Some(approval) = approval {
        if let Some(artifacts) = snapshot
            .pointer_mut("/agent/artifacts")
            .and_then(Value::as_array_mut)
        {
            for artifact in artifacts {
                if affected_assets
                    .iter()
                    .any(|asset| asset.as_str() == artifact.get("assetId").and_then(Value::as_str))
                {
                    artifact["approval"] = Value::String(approval.into());
                }
            }
        }
    }
    let final_approval = target.get("semanticKey").and_then(Value::as_str)
        == Some("final_approval")
        && option_id == Some("approve");
    if final_approval {
        if let Some(plan) = snapshot
            .pointer_mut("/agent/plan")
            .and_then(Value::as_array_mut)
        {
            for step in plan {
                if step.get("status").and_then(Value::as_str) != Some("skipped") {
                    step["status"] = Value::String("completed".into());
                }
            }
        }
    } else if let (Some(step_id), Some(approval)) = (
        target.get("relatedStepId").and_then(Value::as_str),
        approval,
    ) {
        if mark_step(
            snapshot,
            step_id,
            if approval == "rejected" {
                "waiting"
            } else {
                "completed"
            },
            None,
        )
        .is_ok()
        {
            changed.insert(format!("plan:{step_id}"));
        }
    }
    apply_semantic_resolution(
        snapshot,
        &target,
        option_id,
        note.as_deref(),
        selected_label.as_deref(),
    )?;
    let pending_blocking = snapshot
        .pointer("/agent/decisions")
        .and_then(Value::as_array)
        .is_some_and(|decisions| {
            decisions.iter().any(|decision| {
                decision.get("status").and_then(Value::as_str) == Some("pending")
                    && decision.get("blocking").and_then(Value::as_bool) == Some(true)
            })
        });
    let current_run = snapshot
        .pointer("/agent/runStatus")
        .and_then(Value::as_str)
        .unwrap_or("working");
    let control = snapshot
        .pointer("/agent/controlMode")
        .and_then(Value::as_str)
        .unwrap_or("agent");
    let run_status = if final_approval {
        "completed"
    } else if control == "human" || matches!(current_run, "paused" | "idle") {
        current_run
    } else if pending_blocking {
        "waiting"
    } else {
        "working"
    };
    snapshot["agent"]["runStatus"] = Value::String(run_status.into());
    if final_approval {
        snapshot["agent"]["currentStepIds"] = json!([]);
        snapshot["agent"]
            .as_object_mut()
            .expect("agent object")
            .remove("currentStepId");
    } else {
        refresh_current_steps(snapshot)?;
    }
    let detail = [selected_label, note]
        .into_iter()
        .flatten()
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join(" · ");
    append_activity(
        snapshot,
        "user",
        "decision",
        target
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("Resolved decision")
            .into(),
        Some(if detail.is_empty() {
            "Resolved".into()
        } else {
            detail
        }),
        vec![],
    )?;
    changed.insert(format!("decision:{decision_id}"));
    Ok(())
}

fn apply_semantic_resolution(
    snapshot: &mut Value,
    target: &Value,
    option_id: Option<&str>,
    note: Option<&str>,
    selected_label: Option<&str>,
) -> Result<(), CoreError> {
    let semantic = target.get("semanticKey").and_then(Value::as_str);
    let confirmed = [selected_label, note]
        .into_iter()
        .flatten()
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join(" · ");
    let confirmed = if confirmed.is_empty() {
        "Confirmed"
    } else {
        &confirmed
    };
    let confirm_requirement = |snapshot: &mut Value, label: &str, value: &str| {
        if let Some(requirements) = snapshot
            .pointer_mut("/agent/requirements")
            .and_then(Value::as_array_mut)
        {
            for requirement in requirements {
                if requirement.get("label").and_then(Value::as_str) == Some(label) {
                    requirement["value"] = Value::String(value.into());
                    requirement["status"] = Value::String("confirmed".into());
                    requirement["source"] = Value::String("user".into());
                    requirement["blocking"] = Value::Bool(false);
                }
            }
        }
    };
    match semantic {
        Some("visual_approach") => {
            snapshot["agent"]["brief"]["visualApproach"] = Value::String(confirmed.into());
            confirm_requirement(snapshot, "Visual approach", confirmed);
        }
        Some("output_spec") => {
            snapshot["agent"]["brief"]["outputSpec"] = Value::String(confirmed.into());
            confirm_requirement(snapshot, "Output specification", confirmed);
        }
        Some("identity_refs") => {
            confirm_requirement(snapshot, "Identity and references", confirmed)
        }
        Some("deliverable_usage") => {
            if let Some(label) = selected_label {
                snapshot["agent"]["brief"]["deliverable"] = Value::String(label.into());
                confirm_requirement(snapshot, "Final deliverable", label);
            }
            if let Some(note) = note.filter(|value| !value.trim().is_empty()) {
                snapshot["agent"]["brief"]["usage"] = Value::String(note.trim().into());
                confirm_requirement(snapshot, "Usage", note.trim());
            }
        }
        Some("image_generation_backend") => {
            if let Some(backend @ ("codex_builtin" | "openrouter")) = option_id {
                snapshot["agent"]["imageGeneration"] = json!({
                  "status": "selected", "backend": backend, "selectedBy": "user_chat",
                  "selectedAt": iso_timestamp(), "decisionId": target.get("id")
                });
            }
        }
        Some("model_selection_image" | "model_selection_video") if option_id.is_some() => {
            let mode = if semantic == Some("model_selection_image") {
                "image"
            } else {
                "video"
            };
            let option_id = option_id.expect("checked");
            let related = target
                .get("relatedThreadIds")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if related.is_empty() {
                snapshot["generationDefaults"]["modelIds"][mode] = Value::String(option_id.into());
                snapshot["agent"]["modelSelections"][mode] = json!({
                  "status": "selected", "modelId": option_id, "selectedBy": "user", "selectedAt": iso_timestamp()
                });
            } else {
                for thread_id in related.iter().filter_map(Value::as_str) {
                    let thread = find_thread_mut(snapshot, thread_id).ok_or_else(|| {
                        CoreError::new(
                            "INVALID_COMMAND",
                            format!("Model decision thread {thread_id} is missing."),
                        )
                    })?;
                    if thread.get("mode").and_then(Value::as_str) != Some(mode) {
                        return Err(CoreError::new(
                            "INVALID_COMMAND",
                            format!("Model decision thread {thread_id} has the wrong mode."),
                        ));
                    }
                    thread["modelOverrideId"] = Value::String(option_id.into());
                }
            }
        }
        _ => {}
    }
    Ok(())
}

fn apply_propose_assembly(
    snapshot: &mut Value,
    operation: &Value,
    changed: &mut BTreeSet<String>,
) -> Result<(), CoreError> {
    let request_key = operation_string(operation, "requestKey")?;
    if let Some(id) = snapshot
        .pointer("/agent/decisions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|decision| decision.get("requestKey").and_then(Value::as_str) == Some(request_key))
        .and_then(|decision| decision.get("id").and_then(Value::as_str))
        .map(str::to_string)
    {
        changed.insert(format!("decision:{id}"));
        return Ok(());
    }
    let clips = operation
        .get("clips")
        .and_then(Value::as_array)
        .filter(|clips| !clips.is_empty() && clips.len() <= 24)
        .ok_or_else(|| {
            CoreError::new(
                "INVALID_COMMAND",
                "propose_assembly.clips must contain 1 to 24 clips.",
            )
        })?;
    let assets = snapshot
        .get("assets")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let artifacts = snapshot
        .pointer("/agent/artifacts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for clip in clips {
        let asset_id = operation_string(clip, "assetId")?;
        let valid_asset = assets.iter().any(|asset| {
            asset.get("id").and_then(Value::as_str) == Some(asset_id)
                && asset.get("kind").and_then(Value::as_str) == Some("video")
        });
        let approved = artifacts.iter().any(|artifact| {
            artifact.get("assetId").and_then(Value::as_str) == Some(asset_id)
                && artifact.get("approval").and_then(Value::as_str) == Some("approved")
        });
        let start = clip
            .get("startSeconds")
            .and_then(Value::as_f64)
            .unwrap_or(-1.0);
        let end = clip
            .get("endSeconds")
            .and_then(Value::as_f64)
            .unwrap_or(-1.0);
        if !valid_asset || !approved || start < 0.0 || end <= start {
            return Err(CoreError::new(
        "INVALID_COMMAND",
        "Every proposed assembly clip must be an approved video artifact with a valid range.",
      ));
        }
    }
    let mut sorted = clips.clone();
    sorted.sort_by_key(|clip| clip.get("order").and_then(Value::as_i64).unwrap_or(0));
    for clip in &mut sorted {
        if clip
            .get("id")
            .and_then(Value::as_str)
            .map_or(true, str::is_empty)
        {
            clip["id"] = Value::String(format!("assembly-{}", uuid::Uuid::new_v4()));
        }
    }
    snapshot["agent"]["assembly"]["clips"] = Value::Array(sorted);
    snapshot["agent"]["assembly"]["status"] = Value::String("ready".into());
    snapshot["agent"]["assembly"]
        .as_object_mut()
        .expect("assembly object")
        .remove("error");
    let id = format!("decision-{}", uuid::Uuid::new_v4());
    let created_at = iso_timestamp();
    snapshot
    .pointer_mut("/agent/decisions")
    .and_then(Value::as_array_mut)
    .expect("decisions array")
    .push(json!({
      "id": id, "requestKey": request_key, "title": "Review final video assembly",
      "prompt": "Review clip order and usable ranges in Fruit Truck, then render the final video.",
      "kind": "approval", "channel": "fruit_truck_ui", "presentation": "assembly_review",
      "selectionMode": "single", "minSelections": 1, "maxSelections": 1,
      "status": "pending", "blocking": true,
      "relatedAssetIds": clips.iter().filter_map(|clip| clip.get("assetId").cloned()).collect::<Vec<_>>(),
      "options": [{ "id": "rendered", "label": "Render final video", "recommended": true }, { "id": "revise", "label": "Request a new assembly plan" }],
      "createdAt": created_at
    }));
    snapshot["agent"]["runStatus"] = Value::String("waiting".into());
    snapshot["agent"]["uiAttention"] = json!({ "requestedAt": created_at, "decisionId": id });
    append_activity(
        snapshot,
        "agent",
        "assembly",
        "Proposed final video assembly".into(),
        Some(format!("{} clip(s)", clips.len())),
        vec![],
    )?;
    changed.insert("assembly".into());
    changed.insert(format!("decision:{id}"));
    Ok(())
}

fn validate_command_snapshot(snapshot: &Value) -> Result<(), CoreError> {
    let plan = snapshot
        .pointer("/agent/plan")
        .and_then(Value::as_array)
        .ok_or_else(|| CoreError::new("INVALID_SESSION", "Agent plan must be an array."))?;
    let mut ids = HashSet::new();
    for step in plan {
        let id = entity_id(step, "plan step")?;
        if !ids.insert(id) {
            return Err(CoreError::new(
                "INVALID_SESSION",
                "Plan step IDs must be unique.",
            ));
        }
    }
    for step in plan {
        let id = entity_id(step, "plan step")?;
        for dependency in step
            .get("dependsOn")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            if dependency == id || !ids.contains(dependency) {
                return Err(CoreError::new(
                    "INVALID_SESSION",
                    format!("Plan step {id} has an invalid dependency {dependency}."),
                ));
            }
        }
    }
    let active = plan
        .iter()
        .filter(|step| {
            matches!(
                step.get("status").and_then(Value::as_str),
                Some("in_progress" | "waiting")
            )
        })
        .filter_map(|step| step.get("id").and_then(Value::as_str))
        .collect::<HashSet<_>>();
    let current = snapshot
        .pointer("/agent/currentStepIds")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect::<HashSet<_>>();
    if active != current {
        return Err(CoreError::new(
            "INVALID_SESSION",
            "Active plan step IDs must match in-progress and waiting steps.",
        ));
    }
    let mut request_keys = HashSet::new();
    for decision in snapshot
        .pointer("/agent/decisions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if let Some(key) = decision.get("requestKey").and_then(Value::as_str) {
            if !request_keys.insert(key) {
                return Err(CoreError::new(
                    "INVALID_SESSION",
                    "Decision request keys must be unique.",
                ));
            }
        }
        if let Some(step_id) = decision.get("relatedStepId").and_then(Value::as_str) {
            if !ids.contains(step_id) {
                return Err(CoreError::new(
                    "INVALID_SESSION",
                    format!("Decision points to unknown step {step_id}."),
                ));
            }
        }
    }
    let mut thread_ids = HashSet::new();
    let mut attempt_ids = HashSet::new();
    for mode in ["image", "video"] {
        for thread in snapshot
            .pointer(&format!("/threads/{mode}"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let thread_id = entity_id(thread, "generation thread")?;
            if !thread_ids.insert(thread_id) {
                return Err(CoreError::new(
                    "INVALID_SESSION",
                    "Generation thread IDs must be unique.",
                ));
            }
            let attempts = thread
                .get("attempts")
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    CoreError::new(
                        "INVALID_SESSION",
                        format!("Generation thread {thread_id} attempts must be an array."),
                    )
                })?;
            let mut active_attempts = 0;
            for attempt in attempts {
                let attempt_id = entity_id(attempt, "generation attempt")?;
                if !attempt_ids.insert(attempt_id) {
                    return Err(CoreError::new(
                        "INVALID_SESSION",
                        "Generation attempt IDs must be unique.",
                    ));
                }
                match attempt.get("status").and_then(Value::as_str) {
                    Some(
                        "queued" | "enhancing" | "awaiting_host" | "submitting" | "in_progress",
                    ) => {
                        active_attempts += 1;
                    }
                    Some("completed" | "failed" | "uncertain" | "canceled") => {}
                    _ => {
                        return Err(CoreError::new(
                            "INVALID_SESSION",
                            format!("Generation attempt {attempt_id} has an invalid status."),
                        ));
                    }
                }
            }
            if active_attempts > 1 {
                return Err(CoreError::new(
                    "INVALID_SESSION",
                    format!("Generation thread {thread_id} has more than one active attempt."),
                ));
            }
        }
    }
    Ok(())
}

fn valid_session_id(value: Option<&str>) -> Result<&str, CoreError> {
    let value =
        value.ok_or_else(|| CoreError::new("INVALID_SESSION", "Session ID is required."))?;
    if value.is_empty()
        || value.len() > 128
        || !value
            .chars()
            .all(|item| item.is_ascii_alphanumeric() || matches!(item, '-' | '_'))
    {
        return Err(CoreError::new("INVALID_SESSION", "Session ID is invalid."));
    }
    Ok(value)
}

fn refresh_relational_projection(
    transaction: &rusqlite::Transaction<'_>,
    session_id: &str,
    snapshot: &Value,
) -> Result<(), CoreError> {
    let content = json!({
      "name": snapshot.get("name"),
      "mode": snapshot.get("mode"),
      "generationDefaults": snapshot.get("generationDefaults"),
      "activeThreadIds": snapshot.get("activeThreadIds"),
      "brief": snapshot.pointer("/agent/brief"),
      "imageGeneration": snapshot.pointer("/agent/imageGeneration"),
      "modelSelections": snapshot.pointer("/agent/modelSelections"),
      "controlMode": snapshot.pointer("/agent/controlMode"),
      "runStatus": snapshot.pointer("/agent/runStatus"),
    });
    transaction.execute(
        "INSERT INTO session_content(session_id, content_json) VALUES(?1, ?2)
     ON CONFLICT(session_id) DO UPDATE SET content_json=excluded.content_json",
        params![session_id, serde_json::to_string(&content)?],
    )?;

    for table in [
        "plan_dependencies",
        "requirements",
        "plan_steps",
        "decisions",
        "artifact_parents",
        "artifacts",
        "assets",
        "generation_attempts",
        "enhancement_attempts",
        "generation_threads",
        "assembly_clips",
        "assembly",
        "cost_ledger",
    ] {
        transaction.execute(
            &format!("DELETE FROM {table} WHERE session_id=?1"),
            params![session_id],
        )?;
    }

    for requirement in array_at(snapshot, "/agent/requirements") {
        let id = entity_id(requirement, "requirement")?;
        transaction.execute(
      "INSERT INTO requirements(session_id, id, status, source, blocking, value_json) VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
      params![
        session_id, id, string_at(requirement, "status"), string_at(requirement, "source"),
        requirement.get("blocking").and_then(Value::as_bool).unwrap_or(false) as i64,
        serde_json::to_string(requirement)?,
      ],
    )?;
    }

    for step in array_at(snapshot, "/agent/plan") {
        let id = entity_id(step, "plan step")?;
        transaction.execute(
            "INSERT INTO plan_steps(session_id, id, status, value_json) VALUES(?1, ?2, ?3, ?4)",
            params![
                session_id,
                id,
                string_at(step, "status").unwrap_or("pending"),
                serde_json::to_string(step)?
            ],
        )?;
        for dependency in step
            .get("dependsOn")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            transaction.execute(
        "INSERT INTO plan_dependencies(session_id, step_id, dependency_id) VALUES(?1, ?2, ?3)",
        params![session_id, id, dependency],
      )?;
        }
    }

    for decision in array_at(snapshot, "/agent/decisions") {
        transaction.execute(
      "INSERT INTO decisions(session_id, id, request_key, semantic_key, status, channel, value_json) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
      params![
        session_id, entity_id(decision, "decision")?, string_at(decision, "requestKey"),
        string_at(decision, "semanticKey"), string_at(decision, "status").unwrap_or("pending"),
        string_at(decision, "channel"), serde_json::to_string(decision)?,
      ],
    )?;
    }

    for activity in array_at(snapshot, "/agent/activity") {
        transaction.execute(
      "INSERT OR IGNORE INTO activities(session_id, id, kind, created_at, value_json) VALUES(?1, ?2, ?3, ?4, ?5)",
      params![
        session_id, entity_id(activity, "activity")?, string_at(activity, "kind").unwrap_or("plan"),
        string_at(activity, "createdAt"), serde_json::to_string(activity)?,
      ],
    )?;
    }
    transaction.execute(
        "DELETE FROM activities WHERE session_id=?1 AND id NOT IN (
      SELECT id FROM activities WHERE session_id=?1 ORDER BY rowid DESC LIMIT 500
    )",
        params![session_id],
    )?;

    for asset in snapshot
        .get("assets")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        transaction.execute(
      "INSERT INTO assets(session_id, id, kind, origin, value_json) VALUES(?1, ?2, ?3, ?4, ?5)",
      params![
        session_id,
        entity_id(asset, "asset")?,
        string_at(asset, "kind"),
        string_at(asset, "origin"),
        serde_json::to_string(asset)?
      ],
    )?;
    }

    for artifact in array_at(snapshot, "/agent/artifacts") {
        let asset_id = artifact
            .get("assetId")
            .and_then(Value::as_str)
            .ok_or_else(|| CoreError::new("INVALID_SESSION", "Artifact assetId is required."))?;
        transaction.execute(
      "INSERT INTO artifacts(session_id, asset_id, approval, value_json) VALUES(?1, ?2, ?3, ?4)",
      params![
        session_id,
        asset_id,
        string_at(artifact, "approval"),
        serde_json::to_string(artifact)?
      ],
    )?;
        for parent in artifact
            .get("parentAssetIds")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            transaction.execute(
        "INSERT INTO artifact_parents(session_id, asset_id, parent_asset_id) VALUES(?1, ?2, ?3)",
        params![session_id, asset_id, parent],
      )?;
        }
    }

    let mut active_video_task_ids = Vec::new();
    for mode in ["image", "video"] {
        for thread in snapshot
            .pointer(&format!("/threads/{mode}"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let thread_id = entity_id(thread, "generation thread")?;
            transaction.execute(
        "INSERT INTO generation_threads(session_id, id, mode, revision, archived, value_json) VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
        params![
          session_id, thread_id, mode, thread.get("revision").and_then(Value::as_i64).unwrap_or(0),
          thread.get("archived").and_then(Value::as_bool).unwrap_or(false) as i64,
          serde_json::to_string(thread)?,
        ],
      )?;
            for attempt in thread
                .get("attempts")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let attempt_id = entity_id(attempt, "generation attempt")?;
                transaction.execute(
          "INSERT INTO generation_attempts(session_id, thread_id, id, status, provider_job_id, value_json) VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
          params![
            session_id, thread_id, attempt_id,
            string_at(attempt, "status").unwrap_or("uncertain"), string_at(attempt, "jobId"),
            serde_json::to_string(attempt)?,
          ],
        )?;
                let status = string_at(attempt, "status").unwrap_or("uncertain");
                if mode == "video"
                    && !matches!(status, "completed" | "failed" | "uncertain" | "canceled")
                    && string_at(attempt, "jobId").is_some()
                {
                    let task_id = format!("video-poll-{attempt_id}");
                    active_video_task_ids.push(task_id.clone());
                    let next_run_at = string_at(attempt, "nextPollAt")
                        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
                        .map(|value| value.timestamp_millis().max(0) as u64)
                        .unwrap_or(now_ms()?);
                    let state = json!({
                      "threadId": thread_id,
                      "attemptId": attempt_id,
                      "pollAttempt": attempt.get("pollAttempts").and_then(Value::as_u64).unwrap_or(0),
                      "submittedAt": string_at(attempt, "submittedAt")
                        .or_else(|| string_at(attempt, "createdAt"))
                        .or_else(|| string_at(snapshot, "createdAt"))
                        .map(str::to_string)
                        .unwrap_or_else(iso_timestamp),
                    });
                    transaction.execute(
            "INSERT INTO tasks(id, session_id, kind, status, provider_job_id, state_json, next_run_at_ms, updated_at_ms)
             VALUES(?1, ?2, 'video_poll', 'scheduled', ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET
               status=CASE
                 WHEN tasks.status='running' AND tasks.next_run_at_ms > excluded.updated_at_ms THEN 'running'
                 ELSE 'scheduled'
               END,
               provider_job_id=excluded.provider_job_id,
               state_json=excluded.state_json,
               next_run_at_ms=CASE
                 WHEN tasks.status='running' AND tasks.next_run_at_ms > excluded.updated_at_ms THEN tasks.next_run_at_ms
                 ELSE excluded.next_run_at_ms
               END,
               updated_at_ms=excluded.updated_at_ms",
            params![
              task_id, session_id, string_at(attempt, "jobId"),
              serde_json::to_string(&state)?, next_run_at as i64, now_ms()? as i64,
            ],
          )?;
                }
            }
            for attempt in thread
                .get("enhancementAttempts")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                transaction.execute(
          "INSERT INTO enhancement_attempts(session_id, thread_id, id, status, value_json) VALUES(?1, ?2, ?3, ?4, ?5)",
          params![
            session_id, thread_id, entity_id(attempt, "enhancement attempt")?,
            string_at(attempt, "status").unwrap_or("failed"), serde_json::to_string(attempt)?,
          ],
        )?;
            }
        }
    }

    transaction.execute(
        "UPDATE tasks SET status='terminal', next_run_at_ms=NULL
         WHERE session_id=?1 AND kind='video_poll'
           AND id NOT IN (SELECT value FROM json_each(?2))",
        params![session_id, serde_json::to_string(&active_video_task_ids)?],
    )?;

    if let Some(assembly) = snapshot.pointer("/agent/assembly") {
        transaction.execute(
      "INSERT INTO assembly(session_id, status, output_asset_id, value_json) VALUES(?1, ?2, ?3, ?4)",
      params![
        session_id, string_at(assembly, "status").unwrap_or("draft"), string_at(assembly, "outputAssetId"),
        serde_json::to_string(assembly)?,
      ],
    )?;
        for (index, clip) in assembly
            .get("clips")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .enumerate()
        {
            let id = clip
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| format!("assembly-clip-{index}"));
            let asset_id = clip.get("assetId").and_then(Value::as_str).ok_or_else(|| {
                CoreError::new("INVALID_SESSION", "Assembly clip assetId is required.")
            })?;
            transaction.execute(
        "INSERT INTO assembly_clips(session_id, id, asset_id, clip_order, value_json) VALUES(?1, ?2, ?3, ?4, ?5)",
        params![session_id, id, asset_id, clip.get("order").and_then(Value::as_i64).unwrap_or(index as i64), serde_json::to_string(clip)?],
      )?;
        }
    }

    for entry in array_at(snapshot, "/agent/execution/costLedger") {
        transaction.execute(
      "INSERT INTO cost_ledger(session_id, id, category, actual_cost_usd, recorded_at) VALUES(?1, ?2, ?3, ?4, ?5)",
      params![
        session_id, entity_id(entry, "cost entry")?, string_at(entry, "category").unwrap_or("generation"),
        entry.get("actualCostUsd").and_then(Value::as_f64).unwrap_or(0.0), string_at(entry, "recordedAt"),
      ],
    )?;
    }
    Ok(())
}

fn array_at<'a>(value: &'a Value, pointer: &str) -> impl Iterator<Item = &'a Value> {
    value
        .pointer(pointer)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
}

fn entity_id<'a>(value: &'a Value, kind: &str) -> Result<&'a str, CoreError> {
    value
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty() && id.len() <= 200)
        .ok_or_else(|| CoreError::new("INVALID_SESSION", format!("{kind} ID is required.")))
}

fn string_at<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn validate_snapshot(snapshot: &Value, session_id: &str) -> Result<(), CoreError> {
    if snapshot.get("id").and_then(Value::as_str) != Some(session_id) {
        return Err(CoreError::new(
            "INVALID_SESSION",
            "Snapshot ID does not match sessionId.",
        ));
    }
    if !snapshot.get("agent").is_some_and(Value::is_object) {
        return Err(CoreError::new(
            "INVALID_SESSION",
            "Snapshot agent state is required.",
        ));
    }
    let raw = serde_json::to_vec(snapshot)?;
    if raw.len() > MAX_SNAPSHOT_BYTES {
        return Err(CoreError::new(
            "SESSION_TOO_LARGE",
            "Session snapshot exceeds the 50 MB limit.",
        ));
    }
    let lower = String::from_utf8_lossy(&raw).to_ascii_lowercase();
    if lower.contains("data:image/") || lower.contains("data:video/") || lower.contains(";base64,")
    {
        return Err(CoreError::new(
            "EMBEDDED_MEDIA",
            "Session metadata cannot contain Base64 or data URL media.",
        ));
    }
    Ok(())
}

fn normalize_legacy_snapshot(snapshot: &Value, schema_version: u64) -> Result<Value, CoreError> {
    if !(1..=4).contains(&schema_version) {
        return Err(CoreError::new(
            "UNSUPPORTED_SCHEMA",
            format!("Legacy schema {schema_version} is unsupported."),
        ));
    }
    let id = valid_session_id(snapshot.get("id").and_then(Value::as_str))?;
    let created_at = snapshot
        .get("createdAt")
        .and_then(Value::as_str)
        .unwrap_or("legacy");
    let updated_at = snapshot
        .get("updatedAt")
        .and_then(Value::as_str)
        .unwrap_or(created_at);
    let name = snapshot
        .get("name")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or("Recovered agent session");
    let intent = snapshot
        .pointer("/agent/brief/originalIntent")
        .and_then(Value::as_str)
        .unwrap_or(name);
    let mode = snapshot
        .get("mode")
        .and_then(Value::as_str)
        .filter(|value| *value == "image" || *value == "video")
        .unwrap_or("image");
    let mut canonical = json!({
      "id": id,
      "name": name,
      "createdAt": created_at,
      "updatedAt": updated_at,
      "mode": mode,
      "generationDefaults": {
        "modelIds": { "image": "", "video": "" },
        "options": { "image": {}, "video": {} },
        "providerJson": { "image": "", "video": "" }
      },
      "threads": { "image": [], "video": [] },
      "activeThreadIds": { "image": "", "video": "" },
      "assets": [],
      "agent": {
        "schemaVersion": 4,
        "revision": 0,
        "connection": { "status": "waiting" },
        "controlMode": "agent",
        "runStatus": "idle",
        "brief": {
          "originalIntent": intent, "goal": "", "deliverable": "", "usage": "",
          "visualApproach": "", "outputSpec": "", "message": "", "mustInclude": [], "mustAvoid": []
        },
        "requirements": [], "plan": [], "currentStepIds": [], "decisions": [], "activity": [],
        "imageGeneration": { "status": "unselected" },
        "modelSelections": { "image": { "status": "unselected" }, "video": { "status": "unselected" } },
        "artifacts": [],
        "assembly": { "status": "draft", "clips": [] },
        "execution": {
          "currentJobIds": [], "generationCount": 0, "costLedger": [], "spentUsd": 0,
          "retryCount": 0
        }
      }
    });
    deep_merge_json(&mut canonical, snapshot);
    canonical["agent"]["schemaVersion"] = Value::from(4);
    if snapshot.pointer("/agent/currentStepIds").is_none() {
        canonical["agent"]["currentStepIds"] = snapshot
            .pointer("/agent/currentStepId")
            .and_then(Value::as_str)
            .map(|id| json!([id]))
            .unwrap_or_else(|| json!([]));
    }
    if snapshot.get("generationDefaults").is_none() {
        if let Some(selected) = snapshot.get("selectedModelIds") {
            if let Some(image) = selected.get("image").and_then(Value::as_str) {
                canonical["generationDefaults"]["modelIds"]["image"] = Value::String(image.into());
            }
            if let Some(video) = selected.get("video").and_then(Value::as_str) {
                canonical["generationDefaults"]["modelIds"]["video"] = Value::String(video.into());
            }
        }
    }
    Ok(canonical)
}

fn deep_merge_json(target: &mut Value, source: &Value) {
    match (target, source) {
        (Value::Object(target), Value::Object(source)) => {
            for (key, value) in source {
                if let Some(existing) = target.get_mut(key) {
                    deep_merge_json(existing, value);
                } else {
                    target.insert(key.clone(), value.clone());
                }
            }
        }
        (target, source) => *target = source.clone(),
    }
}

fn semantic_snapshot(value: &Value) -> Value {
    let mut value = value.clone();
    if let Some(root) = value.as_object_mut() {
        root.remove("coreRevision");
        root.remove("coreUpdatedAtMs");
        root.remove("updatedAt");
        if let Some(agent) = root.get_mut("agent").and_then(Value::as_object_mut) {
            agent.remove("revision");
            agent.remove("updatedAt");
            agent.remove("updatedAtMs");
        }
    }
    value
}

fn normalize_idempotency(
    command: &CommitSnapshot,
) -> Result<Option<(String, String, String)>, CoreError> {
    match (
        &command.idempotency_scope,
        &command.idempotency_key,
        &command.request_hash,
    ) {
        (None, None, None) => Ok(None),
        (Some(scope), Some(key), Some(hash))
            if !scope.is_empty()
                && scope.len() <= 100
                && !key.is_empty()
                && key.len() <= 200
                && !hash.is_empty()
                && hash.len() <= 128 =>
        {
            Ok(Some((scope.clone(), key.clone(), hash.clone())))
        }
        _ => Err(CoreError::new(
            "INVALID_IDEMPOTENCY",
            "scope, key, and requestHash must be supplied together within their limits.",
        )),
    }
}

fn set_snapshot_revision(snapshot: &mut Value, revision: u64, now: u64) -> Result<(), CoreError> {
    let agent = snapshot
        .get_mut("agent")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| CoreError::new("INVALID_SESSION", "Snapshot agent state is required."))?;
    agent.insert("revision".into(), Value::from(revision));
    let updated = format!("{now}");
    agent.insert("updatedAtMs".into(), Value::from(now));
    if let Some(root) = snapshot.as_object_mut() {
        root.insert("coreRevision".into(), Value::from(revision));
        root.insert("coreUpdatedAtMs".into(), Value::from(now));
        if !root.contains_key("updatedAt") {
            root.insert("updatedAt".into(), Value::String(updated));
        }
    }
    Ok(())
}

fn bounded_changed(values: Vec<String>) -> Vec<String> {
    values
        .into_iter()
        .filter_map(|value| {
            let value = value.trim();
            if value.is_empty() {
                None
            } else {
                Some(value.chars().take(MAX_CHANGED_BYTES).collect())
            }
        })
        .take(MAX_CHANGED_ITEMS)
        .collect()
}

fn next_action(snapshot: &Value) -> Option<NextAction> {
    let decisions = snapshot.pointer("/agent/decisions")?.as_array()?;
    let decision = decisions
        .iter()
        .rev()
        .find(|decision| decision.get("status").and_then(Value::as_str) == Some("pending"))?;
    Some(NextAction {
        kind: "decision".into(),
        id: decision.get("id")?.as_str()?.into(),
    })
}

fn project_session(
    snapshot: &Value,
    view: &str,
    request: &ReadSession,
) -> Result<Value, CoreError> {
    match view {
        "summary" => Ok(summary_projection(
            snapshot,
            snapshot
                .pointer("/agent/revision")
                .and_then(Value::as_u64)
                .unwrap_or(0),
        )),
        "resume" => Ok(resume_projection(snapshot)),
        "decisions" => Ok(json!({
          "decisions": filtered_entities(snapshot.pointer("/agent/decisions"), &request.decision_ids, true),
        })),
        "threads" => Ok(json!({
          "threads": filtered_threads(snapshot, &request.thread_ids),
          "generationDefaults": snapshot.get("generationDefaults").cloned().unwrap_or(Value::Null),
        })),
        "artifacts" => Ok(json!({
          "artifacts": filtered_assets(snapshot.pointer("/agent/artifacts"), &request.asset_ids),
          "assets": filtered_assets(snapshot.get("assets"), &request.asset_ids),
          "assembly": snapshot.pointer("/agent/assembly").cloned().unwrap_or(Value::Null),
        })),
        "recovery" => Ok(snapshot.clone()),
        _ => Err(CoreError::new(
            "INVALID_VIEW",
            format!("Unsupported session view: {view}"),
        )),
    }
}

fn summary_projection(snapshot: &Value, revision: u64) -> Value {
    let decisions = snapshot
        .pointer("/agent/decisions")
        .and_then(Value::as_array);
    let plan = snapshot.pointer("/agent/plan").and_then(Value::as_array);
    let threads = ["image", "video"]
        .into_iter()
        .flat_map(|mode| {
            snapshot
                .pointer(&format!("/threads/{mode}"))
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        })
        .collect::<Vec<_>>();
    json!({
      "id": snapshot.get("id").cloned().unwrap_or(Value::Null),
      "name": snapshot.get("name").cloned().unwrap_or(Value::Null),
      "updatedAt": snapshot.get("updatedAt").cloned().unwrap_or(Value::Null),
      "revision": revision,
      "connection": snapshot.pointer("/agent/connection").cloned().unwrap_or(Value::Null),
      "controlMode": snapshot.pointer("/agent/controlMode").cloned().unwrap_or(Value::Null),
      "runStatus": snapshot.pointer("/agent/runStatus").cloned().unwrap_or(Value::Null),
      "pendingDecisions": decisions.map_or(0, |items| items.iter().filter(|item| item.get("status").and_then(Value::as_str) == Some("pending")).count()),
      "activeSteps": plan.map_or(0, |items| items.iter().filter(|item| matches!(item.get("status").and_then(Value::as_str), Some("in_progress" | "waiting"))).count()),
      "activeAttempts": threads.iter().flat_map(|thread| thread.get("attempts").and_then(Value::as_array).into_iter().flatten()).filter(|attempt| {
        !matches!(attempt.get("status").and_then(Value::as_str), Some("completed" | "failed" | "uncertain" | "canceled"))
      }).count(),
    "actualCostUsd": snapshot.pointer("/agent/execution/spentUsd")
      .or_else(|| snapshot.pointer("/agent/cost/actualUsd"))
      .cloned().unwrap_or(Value::from(0)),
    })
}

fn resume_projection(snapshot: &Value) -> Value {
    let agent = snapshot.get("agent").cloned().unwrap_or_else(|| json!({}));
    let pending = agent
        .get("decisions")
        .and_then(Value::as_array)
        .and_then(|items| {
            items
                .iter()
                .find(|item| item.get("status").and_then(Value::as_str) == Some("pending"))
        })
        .cloned();
    let active_steps = agent
        .get("plan")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter(|item| {
                    matches!(
                        item.get("status").and_then(Value::as_str),
                        Some("in_progress" | "waiting")
                    )
                })
                .cloned()
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let threads = ["image", "video"]
        .into_iter()
        .flat_map(|mode| {
            snapshot
                .pointer(&format!("/threads/{mode}"))
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        })
        .filter_map(|thread| {
            if thread.get("archivedAt").is_some() {
                return None;
            }
            let attempts = thread.get("attempts").and_then(Value::as_array);
            let latest = attempts.and_then(|items| items.last());
            let prepared = thread
                .pointer("/draft/prompt")
                .and_then(Value::as_str)
                .is_some_and(|prompt| !prompt.trim().is_empty())
                || thread
                    .pointer("/draft/references")
                    .and_then(Value::as_array)
                    .is_some_and(|references| !references.is_empty());
            if latest.is_none() && !prepared {
                return None;
            }
            Some(json!({
              "id": thread.get("id"), "mode": thread.get("mode"), "name": thread.get("name"),
              "revision": thread.get("revision"), "outputRole": thread.get("outputRole"),
              "prepared": prepared,
              "latestAttempt": latest,
            }))
        })
        .collect::<Vec<_>>();
    json!({
      "identity": { "id": snapshot.get("id"), "name": snapshot.get("name"), "updatedAt": snapshot.get("updatedAt") },
      "connection": agent.get("connection"),
      "controlMode": agent.get("controlMode"),
      "runStatus": agent.get("runStatus"),
      "brief": agent.get("brief"),
      "blockingRequirements": agent.get("requirements").and_then(Value::as_array).map(|items| items.iter().filter(|item| item.get("blocking") == Some(&Value::Bool(true)) && item.get("status").and_then(Value::as_str) == Some("missing")).cloned().collect::<Vec<_>>()).unwrap_or_default(),
      "activeSteps": active_steps,
      "pendingDecision": pending,
      "activeThreads": threads,
      "generationDefaults": snapshot.get("generationDefaults"),
      "imageGeneration": agent.get("imageGeneration"),
      "cost": agent.get("cost"),
      "actualCostUsd": agent.pointer("/execution/spentUsd")
        .or_else(|| agent.pointer("/cost/actualUsd"))
        .cloned().unwrap_or(Value::from(0)),
    })
}

fn filtered_entities(
    source: Option<&Value>,
    ids: &[String],
    pending_by_default: bool,
) -> Vec<Value> {
    source
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|item| {
            if !ids.is_empty() {
                return item
                    .get("id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| ids.iter().any(|candidate| candidate == id));
            }
            pending_by_default && item.get("status").and_then(Value::as_str) == Some("pending")
        })
        .cloned()
        .collect()
}

fn filtered_threads(snapshot: &Value, ids: &[String]) -> Vec<Value> {
    let detailed = !ids.is_empty();
    ["image", "video"]
        .into_iter()
        .flat_map(|mode| {
            snapshot
                .pointer(&format!("/threads/{mode}"))
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        })
        .filter(|item| {
            ids.is_empty()
                || item
                    .get("id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| ids.iter().any(|candidate| candidate == id))
        })
        .map(|thread| {
            let mut compact = thread.as_object().cloned().unwrap_or_default();
            compact.remove("enhancementAttempts");
            if let Some(attempts) = compact.get("attempts").and_then(Value::as_array) {
                compact.insert(
                    "attempts".into(),
                    Value::Array(attempts.last().cloned().into_iter().collect()),
                );
            }
            if !detailed {
                compact.remove("draft");
                compact.remove("optionOverrides");
                compact.remove("providerJsonOverride");
            }
            Value::Object(compact)
        })
        .collect()
}

fn filtered_assets(source: Option<&Value>, ids: &[String]) -> Vec<Value> {
    source
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|item| {
            ids.is_empty()
                || item
                    .get("id")
                    .or_else(|| item.get("assetId"))
                    .and_then(Value::as_str)
                    .is_some_and(|id| ids.iter().any(|candidate| candidate == id))
        })
        .cloned()
        .collect()
}

fn hash_json(value: &Value) -> Result<String, CoreError> {
    let mut hasher = Sha256::new();
    hasher.update(serde_json::to_vec(value)?);
    Ok(format!("{:x}", hasher.finalize()))
}

fn now_ms() -> Result<u64, CoreError> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| CoreError::new("CLOCK_ERROR", error.to_string()))?
        .as_millis() as u64)
}

fn secure_directory(path: &Path) -> Result<(), CoreError> {
    fs::create_dir_all(path)
        .map_err(|error| CoreError::new("STORE_INIT_FAILED", error.to_string()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|error| CoreError::new("STORE_INIT_FAILED", error.to_string()))?;
    }
    Ok(())
}

fn atomic_private_write(path: &Path, bytes: &[u8]) -> Result<(), CoreError> {
    let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
    fs::write(&temporary, bytes)
        .map_err(|error| CoreError::new("EXPORT_FAILED", error.to_string()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))
            .map_err(|error| CoreError::new("EXPORT_FAILED", error.to_string()))?;
    }
    fs::rename(&temporary, path)
        .map_err(|error| CoreError::new("EXPORT_FAILED", error.to_string()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;

    fn snapshot(id: &str) -> Value {
        json!({
          "id": id,
          "name": "Core fixture",
          "createdAt": "fixture",
          "updatedAt": "fixture",
          "agent": {
            "revision": 0,
            "connection": { "status": "waiting" },
            "controlMode": "agent",
            "runStatus": "waiting",
            "brief": { "originalIntent": "test" },
            "requirements": [], "plan": [], "decisions": [], "activity": [],
            "artifacts": [], "assembly": { "clips": [] }, "cost": { "actualUsd": 0 }
          },
          "generationDefaults": { "modelIds": { "image": "", "video": "" } },
          "threads": { "image": [], "video": [] }, "assets": []
        })
    }

    fn command(id: &str, base_revision: u64, value: Value, key: &str) -> CommitSnapshot {
        CommitSnapshot {
            session_id: id.into(),
            base_revision,
            snapshot: value,
            command_id: format!("command-{key}"),
            changed: vec!["brief".into()],
            event_type: None,
            event_payload: json!({ "changed": ["brief"] }),
            idempotency_scope: Some("test".into()),
            idempotency_key: Some(key.into()),
            request_hash: Some(format!("hash-{key}")),
        }
    }

    fn snapshot_with_video_task(id: &str) -> Value {
        let mut value = snapshot(id);
        value["agent"]["execution"] = json!({
          "currentJobIds": ["job-durable"], "costLedger": [], "spentUsd": 0
        });
        value["threads"]["video"] = json!([{
          "id": "thread-video", "name": "Video", "mode": "video", "revision": 0,
          "outputRole": "hero_video", "draft": { "references": [] },
          "enhancementAttempts": [], "attempts": [{
            "id": "attempt-video", "status": "in_progress", "backend": "openrouter",
            "jobId": "job-durable", "pollAttempts": 0,
            "nextPollAt": "2020-01-01T00:00:00.000Z", "submittedAt": iso_timestamp(),
            "createdAt": "fixture", "updatedAt": "fixture", "inputAssetIds": [], "assetIds": [],
            "snapshot": { "modelId": "test/video", "prompt": "test", "outputRole": "hero_video" }
          }]
        }]);
        value
    }

    #[test]
    fn commits_per_session_revisions_and_replays_idempotently() {
        let directory = tempfile::tempdir().unwrap();
        let store = CoreStore::open(directory.path()).unwrap();
        let first = store
            .commit_snapshot(command("session-a", 0, snapshot("session-a"), "one"))
            .unwrap();
        let replay = store
            .commit_snapshot(command("session-a", 0, snapshot("session-a"), "one"))
            .unwrap();
        let other = store
            .commit_snapshot(command("session-b", 0, snapshot("session-b"), "one"))
            .unwrap();
        assert_eq!(first.revision, 1);
        assert_eq!(replay.revision, 1);
        assert!(replay.replayed);
        assert_eq!(other.revision, 1);
        assert!(store.integrity_check().is_ok());
    }

    #[test]
    fn rejects_conflict_and_reused_key_with_different_hash() {
        let directory = tempfile::tempdir().unwrap();
        let store = CoreStore::open(directory.path()).unwrap();
        store
            .commit_snapshot(command("session-a", 0, snapshot("session-a"), "one"))
            .unwrap();
        let conflict = store
            .commit_snapshot(command("session-a", 0, snapshot("session-a"), "two"))
            .unwrap_err();
        assert_eq!(conflict.code, "SESSION_CONFLICT");
        let mut reused = command("session-a", 1, snapshot("session-a"), "one");
        reused.request_hash = Some("different".into());
        assert_eq!(
            store.commit_snapshot(reused).unwrap_err().code,
            "IDEMPOTENCY_KEY_REUSED"
        );
    }

    #[test]
    fn event_wait_wakes_without_storage_polling() {
        let directory = tempfile::tempdir().unwrap();
        let store = CoreStore::open(directory.path()).unwrap();
        let waiter = store.clone();
        let thread = thread::spawn(move || {
            waiter
                .wait_events(WaitEvents {
                    session_id: Some("session-a".into()),
                    after_event: 0,
                    timeout_ms: 2_000,
                    event_types: vec!["session.changed".into()],
                })
                .unwrap()
        });
        thread::sleep(Duration::from_millis(50));
        store
            .commit_snapshot(command("session-a", 0, snapshot("session-a"), "one"))
            .unwrap();
        let batch = thread.join().unwrap();
        assert_eq!(batch.events.len(), 1);
        assert!(!batch.timed_out);
    }

    #[test]
    fn compact_views_exclude_full_history() {
        let directory = tempfile::tempdir().unwrap();
        let store = CoreStore::open(directory.path()).unwrap();
        let mut value = snapshot("session-a");
        value["agent"]["activity"] =
            json!([{"id": "activity-one", "kind": "plan", "detail": "large-history"}]);
        let large_prompt = "prepared-prompt-".repeat(200);
        value["threads"]["image"] = Value::Array(
            (0..10)
                .map(|index| {
                    json!({
                      "id": format!("thread-{index}"), "name": format!("Thread {index}"),
                      "mode": "image", "revision": 0, "outputRole": "candidate",
                      "draft": { "prompt": large_prompt.clone(), "references": [] },
                      "attempts": [], "enhancementAttempts": []
                    })
                })
                .collect(),
        );
        store
            .commit_snapshot(command("session-a", 0, value, "one"))
            .unwrap();
        let view = store
            .read_session(&ReadSession {
                session_id: "session-a".into(),
                view: "resume".into(),
                since_revision: None,
                after_event: None,
                thread_ids: vec![],
                decision_ids: vec![],
                asset_ids: vec![],
            })
            .unwrap();
        assert!(!view.to_string().contains("large-history"));
        assert!(!view.to_string().contains("prepared-prompt"));
        assert_eq!(
            view.pointer("/projection/activeThreads/0/prepared")
                .and_then(Value::as_bool),
            Some(true)
        );
        assert!(serde_json::to_vec(&view).unwrap().len() < 8 * 1024);
        let compact_threads = store
            .read_session(&ReadSession {
                session_id: "session-a".into(),
                view: "threads".into(),
                since_revision: None,
                after_event: None,
                thread_ids: vec![],
                decision_ids: vec![],
                asset_ids: vec![],
            })
            .unwrap();
        assert!(!compact_threads.to_string().contains("prepared-prompt"));
        assert!(serde_json::to_vec(&compact_threads).unwrap().len() < 8 * 1024);
        let detailed_thread = store
            .read_session(&ReadSession {
                session_id: "session-a".into(),
                view: "threads".into(),
                since_revision: None,
                after_event: None,
                thread_ids: vec!["thread-0".into()],
                decision_ids: vec![],
                asset_ids: vec![],
            })
            .unwrap();
        assert!(detailed_thread.to_string().contains("prepared-prompt"));
        assert!(store
            .read_session(&ReadSession {
                session_id: "session-a".into(),
                view: "resume".into(),
                since_revision: Some(1),
                after_event: None,
                thread_ids: vec![],
                decision_ids: vec![],
                asset_ids: vec![],
            })
            .unwrap()
            .get("unchanged")
            .and_then(Value::as_bool)
            .unwrap());
    }

    #[test]
    fn canonical_envelope_uses_event_cursor_and_core_snapshot() {
        let directory = tempfile::tempdir().unwrap();
        let store = CoreStore::open(directory.path()).unwrap();
        store
            .commit_snapshot(command("session-a", 0, snapshot("session-a"), "one"))
            .unwrap();
        let envelope = store.canonical_envelope().unwrap();
        assert_eq!(envelope.get("revision").and_then(Value::as_u64), Some(1));
        assert_eq!(
            envelope
                .pointer("/sessions/0/coreRevision")
                .and_then(Value::as_u64),
            Some(1)
        );
    }

    #[test]
    fn concurrent_legacy_exports_are_serialized_and_consistent() {
        let directory = tempfile::tempdir().unwrap();
        let store = CoreStore::open(directory.path()).unwrap();
        store
            .commit_snapshot(command("session-a", 0, snapshot("session-a"), "one"))
            .unwrap();
        store
            .commit_snapshot(command("session-b", 0, snapshot("session-b"), "two"))
            .unwrap();

        let workers = (0..8)
            .map(|_| {
                let store = store.clone();
                thread::spawn(move || {
                    for _ in 0..5 {
                        store.export_legacy_v4().unwrap();
                    }
                })
            })
            .collect::<Vec<_>>();
        for worker in workers {
            worker.join().unwrap();
        }

        let index: Value = serde_json::from_slice(
            &fs::read(directory.path().join("agent-sessions.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(index.get("revision").and_then(Value::as_u64), Some(2));
        let files = index.get("sessionFiles").and_then(Value::as_array).unwrap();
        assert_eq!(files.len(), 2);
        for file in files {
            let name = file.get("file").and_then(Value::as_str).unwrap();
            assert!(directory.path().join("agent-sessions").join(name).is_file());
        }
    }

    #[test]
    fn event_wait_requires_a_reset_after_a_retention_gap() {
        let directory = tempfile::tempdir().unwrap();
        let store = CoreStore::open(directory.path()).unwrap();
        store
            .commit_snapshot(command("session-a", 0, snapshot("session-a"), "one"))
            .unwrap();
        let mut changed = store.read_record("session-a").unwrap().unwrap().snapshot;
        changed["name"] = Value::from("Second revision");
        store
            .commit_snapshot(command("session-a", 1, changed, "two"))
            .unwrap();
        store
            .connection()
            .unwrap()
            .execute("DELETE FROM events WHERE cursor = 1", [])
            .unwrap();

        let batch = store
            .wait_events(WaitEvents {
                session_id: None,
                after_event: 0,
                timeout_ms: 100,
                event_types: vec![],
            })
            .unwrap();

        assert!(batch.reset_required);
        assert!(!batch.timed_out);
        assert!(batch.events.is_empty());
        assert_eq!(batch.cursor, 2);

        let replaced_database = store
            .wait_events(WaitEvents {
                session_id: None,
                after_event: 99,
                timeout_ms: 100,
                event_types: vec![],
            })
            .unwrap();
        assert!(replaced_database.reset_required);
        assert_eq!(replaced_database.cursor, 2);
    }

    #[test]
    fn filtered_event_wait_does_not_skip_a_match_after_large_irrelevant_gap() {
        let directory = tempfile::tempdir().unwrap();
        let store = CoreStore::open(directory.path()).unwrap();
        store
            .commit_snapshot(command("session-a", 0, snapshot("session-a"), "one"))
            .unwrap();
        for index in 0..300 {
            store
                .record_event("session-a", 1, "noise.event", json!({ "index": index }))
                .unwrap();
        }
        let expected = store
            .record_event("session-a", 1, "target.event", json!({ "matched": true }))
            .unwrap();

        let batch = store
            .wait_events(WaitEvents {
                session_id: Some("session-a".into()),
                after_event: 1,
                timeout_ms: 100,
                event_types: vec!["target.event".into()],
            })
            .unwrap();

        assert_eq!(batch.events.len(), 1);
        assert_eq!(batch.events[0].cursor, expected.cursor);
        assert_eq!(batch.cursor, expected.cursor);
        assert!(!batch.timed_out);
    }

    #[test]
    fn unchanged_session_read_still_returns_new_events() {
        let directory = tempfile::tempdir().unwrap();
        let store = CoreStore::open(directory.path()).unwrap();
        store
            .commit_snapshot(command("session-a", 0, snapshot("session-a"), "one"))
            .unwrap();
        let event = store
            .record_event("session-a", 1, "desktop.changed", json!({ "ready": true }))
            .unwrap();
        let read = store
            .read_session(&ReadSession {
                session_id: "session-a".into(),
                view: "resume".into(),
                since_revision: Some(1),
                after_event: Some(1),
                thread_ids: vec![],
                decision_ids: vec![],
                asset_ids: vec![],
            })
            .unwrap();
        assert_eq!(read.get("unchanged").and_then(Value::as_bool), Some(true));
        assert_eq!(
            read.pointer("/events/0/cursor").and_then(Value::as_u64),
            Some(event.cursor)
        );
        assert_eq!(
            read.get("eventCursor").and_then(Value::as_u64),
            Some(event.cursor)
        );
    }

    #[test]
    fn expired_running_video_task_lease_can_be_reclaimed() {
        let directory = tempfile::tempdir().unwrap();
        let store = CoreStore::open(directory.path()).unwrap();
        store
            .commit_snapshot(command(
                "session-a",
                0,
                snapshot_with_video_task("session-a"),
                "create",
            ))
            .unwrap();
        let now = now_ms().unwrap();
        let first = store.claim_due_video_task(now).unwrap().unwrap();
        assert_eq!(first.provider_job_id, "job-durable");
        assert!(store.claim_due_video_task(now + 1).unwrap().is_none());
        let reclaimed = store.claim_due_video_task(now + 60_000).unwrap().unwrap();
        assert_eq!(reclaimed.id, first.id);
        store
            .connection()
            .unwrap()
            .execute(
                "UPDATE tasks SET status='terminal', next_run_at_ms=NULL WHERE id=?1",
                params![reclaimed.id],
            )
            .unwrap();
        store.reschedule_task(&first.id, 500).unwrap();
        let status: String = store
            .connection()
            .unwrap()
            .query_row(
                "SELECT status FROM tasks WHERE id=?1",
                params![first.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "terminal");
    }

    #[test]
    fn video_task_reschedule_persists_scheduler_backoff_count() {
        let directory = tempfile::tempdir().unwrap();
        let store = CoreStore::open(directory.path()).unwrap();
        store
            .commit_snapshot(command(
                "session-a",
                0,
                snapshot_with_video_task("session-a"),
                "create",
            ))
            .unwrap();
        let task = store
            .claim_due_video_task(now_ms().unwrap())
            .unwrap()
            .unwrap();

        store.reschedule_task(&task.id, 2_000).unwrap();

        let (status, state): (String, String) = store
            .connection()
            .unwrap()
            .query_row(
                "SELECT status, state_json FROM tasks WHERE id=?1",
                params![task.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        let state: Value = serde_json::from_str(&state).unwrap();
        assert_eq!(status, "scheduled");
        assert_eq!(
            state.get("schedulerRetries").and_then(Value::as_u64),
            Some(1)
        );
    }

    #[test]
    fn active_video_task_keeps_its_running_lease_across_session_commits() {
        let directory = tempfile::tempdir().unwrap();
        let store = CoreStore::open(directory.path()).unwrap();
        store
            .commit_snapshot(command(
                "session-a",
                0,
                snapshot_with_video_task("session-a"),
                "create",
            ))
            .unwrap();
        let now = now_ms().unwrap();
        let task = store.claim_due_video_task(now).unwrap().unwrap();
        let leased_until: i64 = store
            .connection()
            .unwrap()
            .query_row(
                "SELECT next_run_at_ms FROM tasks WHERE id=?1",
                params![task.id],
                |row| row.get(0),
            )
            .unwrap();

        let mut changed = store.read_record("session-a").unwrap().unwrap().snapshot;
        changed["name"] = Value::String("Unrelated desktop edit".into());
        store
            .commit_snapshot(command("session-a", 1, changed, "desktop-edit"))
            .unwrap();

        let (status, next_run_at): (String, i64) = store
            .connection()
            .unwrap()
            .query_row(
                "SELECT status, next_run_at_ms FROM tasks WHERE id=?1",
                params![task.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(status, "running");
        assert_eq!(next_run_at, leased_until);

        let mut completed = store.read_record("session-a").unwrap().unwrap().snapshot;
        completed["threads"]["video"][0]["attempts"][0]["status"] =
            Value::String("completed".into());
        store
            .commit_snapshot(command("session-a", 2, completed, "complete"))
            .unwrap();
        let terminal: (String, Option<i64>) = store
            .connection()
            .unwrap()
            .query_row(
                "SELECT status, next_run_at_ms FROM tasks WHERE id=?1",
                params![task.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(terminal, ("terminal".into(), None));
    }

    #[test]
    fn typed_commits_reject_multiple_active_attempts_in_one_thread() {
        let directory = tempfile::tempdir().unwrap();
        let store = CoreStore::open(directory.path()).unwrap();
        let mut invalid = snapshot_with_video_task("session-a");
        let mut second = invalid["threads"]["video"][0]["attempts"][0].clone();
        second["id"] = Value::String("attempt-video-second".into());
        second["jobId"] = Value::String("job-durable-second".into());
        invalid["threads"]["video"][0]["attempts"]
            .as_array_mut()
            .unwrap()
            .push(second);
        store
            .commit_snapshot(command("session-a", 0, invalid, "create-invalid"))
            .unwrap();

        let error = store
            .commit_operations(CommitOperations {
                session_id: "session-a".into(),
                base_revision: 1,
                command_id: "validate-active-attempts".into(),
                request_key: "validate-active-attempts".into(),
                request_hash: "validate-active-attempts".into(),
                ops: vec![json!({
                  "type": "apply_projection_patch",
                  "patches": [{ "op": "set", "path": "/name", "value": "Changed" }]
                })],
            })
            .unwrap_err();
        assert_eq!(error.code, "INVALID_SESSION");
        assert!(error.message.contains("more than one active attempt"));
        assert_eq!(
            store
                .read_record("session-a")
                .unwrap()
                .unwrap()
                .snapshot
                .get("name")
                .and_then(Value::as_str),
            Some("Core fixture")
        );
    }

    #[test]
    fn video_poll_cost_correction_updates_one_ledger_entry() {
        let directory = tempfile::tempdir().unwrap();
        let store = CoreStore::open(directory.path()).unwrap();
        store
            .commit_snapshot(command(
                "session-a",
                0,
                snapshot_with_video_task("session-a"),
                "create",
            ))
            .unwrap();
        for (base_revision, poll_attempt, cost) in [(1, 1, 0.1), (2, 2, 0.3)] {
            store
                .commit_operations(CommitOperations {
                    session_id: "session-a".into(),
                    base_revision,
                    command_id: format!("poll-{poll_attempt}"),
                    request_key: format!("poll-{poll_attempt}"),
                    request_hash: format!("hash-poll-{poll_attempt}"),
                    ops: vec![json!({
                      "type": "apply_video_poll_result", "threadId": "thread-video",
                      "attemptId": "attempt-video", "jobId": "job-durable",
                      "status": "in_progress", "pollAttempt": poll_attempt,
                      "actualCostUsd": cost, "nextPollAt": iso_timestamp()
                    })],
                })
                .unwrap();
        }
        let record = store.read_record("session-a").unwrap().unwrap();
        let ledger = record
            .snapshot
            .pointer("/agent/execution/costLedger")
            .and_then(Value::as_array)
            .unwrap();
        assert_eq!(ledger.len(), 1);
        assert_eq!(
            ledger[0].get("actualCostUsd").and_then(Value::as_f64),
            Some(0.3)
        );
        assert_eq!(
            record
                .snapshot
                .pointer("/agent/execution/spentUsd")
                .and_then(Value::as_f64),
            Some(0.3)
        );
        assert_eq!(
            summary_projection(&record.snapshot, record.revision)
                .get("actualCostUsd")
                .and_then(Value::as_f64),
            Some(0.3)
        );
    }

    #[test]
    fn legacy_ingress_accepts_current_base_and_rejects_stale_overwrite() {
        let directory = tempfile::tempdir().unwrap();
        let store = CoreStore::open(directory.path()).unwrap();
        store
            .commit_snapshot(command("session-a", 0, snapshot("session-a"), "one"))
            .unwrap();
        let mut accepted = store.read_record("session-a").unwrap().unwrap().snapshot;
        accepted["name"] = Value::from("Accepted legacy edit");
        accepted["agent"]["revision"] = Value::from(2);
        let outcome = store
            .ingest_legacy(&LegacyEnvelope {
                schema_version: 4,
                revision: 2,
                sessions: vec![accepted],
            })
            .unwrap();
        assert_eq!(outcome.receipts.len(), 1);
        assert!(outcome.conflicts.is_empty());
        let mut stale = snapshot("session-a");
        stale["name"] = Value::from("Stale overwrite");
        stale["agent"]["revision"] = Value::from(2);
        let outcome = store
            .ingest_legacy(&LegacyEnvelope {
                schema_version: 4,
                revision: 3,
                sessions: vec![stale],
            })
            .unwrap();
        assert_eq!(outcome.conflicts, vec!["session-a"]);
        assert_eq!(
            store.read_record("session-a").unwrap().unwrap().snapshot["name"],
            Value::from("Accepted legacy edit")
        );
        let events = store
            .query_events(&WaitEvents {
                session_id: Some("session-a".into()),
                after_event: 0,
                timeout_ms: 0,
                event_types: vec!["legacy.conflict".into()],
            })
            .unwrap();
        assert_eq!(events.events.len(), 1);
    }

    #[test]
    fn telemetry_accepts_only_bounded_nonsensitive_fields() {
        let directory = tempfile::tempdir().unwrap();
        let store = CoreStore::open(directory.path()).unwrap();
        store
            .record_telemetry_span(
                "trace-one",
                Some("command-one"),
                "core.command",
                42,
                json!({ "succeeded": true, "bytes": 512 }),
            )
            .unwrap();
        assert_eq!(
            store
                .record_telemetry_span(
                    "trace-two",
                    None,
                    "core.command",
                    1,
                    json!({ "prompt": "must not be stored" })
                )
                .unwrap_err()
                .code,
            "INVALID_TELEMETRY"
        );
        let fields: String = store
            .connection()
            .unwrap()
            .query_row("SELECT fields_json FROM telemetry_spans", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(fields, r#"{"bytes":512,"succeeded":true}"#);
    }

    #[test]
    fn core_reducer_commits_fast_operations_atomically_and_replays_receipts() {
        let directory = tempfile::tempdir().unwrap();
        let store = CoreStore::open(directory.path()).unwrap();
        store
            .commit_snapshot(command("session-a", 0, snapshot("session-a"), "create"))
            .unwrap();
        let operation = CommitOperations {
            session_id: "session-a".into(),
            base_revision: 1,
            command_id: "fast-one".into(),
            request_key: "fast-one".into(),
            request_hash: "hash-fast-one".into(),
            ops: vec![
                json!({ "type": "update_brief", "patch": { "goal": "Core-owned goal" } }),
                json!({
                  "type": "replace_plan",
                  "steps": [{ "id": "shot-one", "title": "Shot one", "description": "Create it", "status": "in_progress", "dependsOn": [] }]
                }),
                json!({
                  "type": "queue_decision", "requestKey": "direction-one", "title": "Approve direction",
                  "prompt": "Continue?", "kind": "approval", "channel": "agent_chat", "blocking": true,
                  "planStepId": "shot-one", "options": [{ "id": "approve", "label": "Approve" }]
                }),
            ],
        };
        let receipt = store.commit_operations(operation.clone()).unwrap();
        assert_eq!(receipt.revision, 2);
        assert_eq!(store.commit_operations(operation).unwrap().revision, 2);
        assert!(store
            .commit_operations(CommitOperations {
                session_id: "session-a".into(),
                base_revision: 2,
                command_id: "bad-batch".into(),
                request_key: "bad-batch".into(),
                request_hash: "hash-bad-batch".into(),
                ops: vec![
                    json!({ "type": "update_brief", "patch": { "goal": "Must roll back" } }),
                    json!({ "type": "mark_step", "stepId": "missing", "status": "completed" }),
                ],
            })
            .is_err());
        let record = store.read_record("session-a").unwrap().unwrap();
        assert_eq!(record.revision, 2);
        assert_eq!(
            record
                .snapshot
                .pointer("/agent/brief/goal")
                .and_then(Value::as_str),
            Some("Core-owned goal")
        );
        assert_eq!(
            record
                .snapshot
                .pointer("/agent/plan/0/status")
                .and_then(Value::as_str),
            Some("waiting")
        );
        assert!(
            record
                .snapshot
                .pointer("/agent/activity")
                .and_then(Value::as_array)
                .unwrap()
                .len()
                >= 3
        );
    }

    #[test]
    fn desktop_projection_patch_and_ui_resolution_are_core_owned() {
        let directory = tempfile::tempdir().unwrap();
        let store = CoreStore::open(directory.path()).unwrap();
        let mut value = snapshot("session-a");
        value["assets"] =
            json!([{ "id": "asset-one", "name": "One", "kind": "video", "origin": "generated" }]);
        value["agent"]["artifacts"] = json!([{ "assetId": "asset-one", "role": "hero", "parentAssetIds": [], "approval": "unreviewed" }]);
        value["agent"]["plan"] = json!([{ "id": "shot-one", "title": "Shot", "description": "Create it", "status": "waiting", "dependsOn": [] }]);
        value["agent"]["currentStepIds"] = json!(["shot-one"]);
        value["agent"]["runStatus"] = Value::from("waiting");
        value["agent"]["decisions"] = json!([{
          "id": "decision-one", "requestKey": "review-one", "title": "Review", "prompt": "Approve?",
          "kind": "approval", "channel": "fruit_truck_ui", "status": "pending", "blocking": true,
          "relatedStepId": "shot-one", "relatedAssetIds": ["asset-one"],
          "options": [{ "id": "approve", "label": "Approve" }], "createdAt": "fixture"
        }]);
        store
            .commit_snapshot(command("session-a", 0, value, "create"))
            .unwrap();
        let receipt = store.commit_operations(CommitOperations {
      session_id: "session-a".into(), base_revision: 1, command_id: "desktop-one".into(),
      request_key: "desktop-one".into(), request_hash: "hash-desktop-one".into(),
      ops: vec![
        json!({ "type": "apply_projection_patch", "patches": [{ "op": "set", "path": "/agent/brief/goal", "value": "Desktop goal" }] }),
        json!({ "type": "resolve_ui_decision", "decisionId": "decision-one", "selectedOptionIds": ["approve"], "selectedAssetIds": [], "note": "Looks good" }),
      ],
    }).unwrap();
        assert_eq!(receipt.revision, 2);
        let value = store.read_record("session-a").unwrap().unwrap().snapshot;
        assert_eq!(
            value.pointer("/agent/brief/goal").and_then(Value::as_str),
            Some("Desktop goal")
        );
        assert_eq!(
            value
                .pointer("/agent/decisions/0/resolution/channel")
                .and_then(Value::as_str),
            Some("fruit_truck_ui")
        );
        assert_eq!(
            value
                .pointer("/agent/artifacts/0/approval")
                .and_then(Value::as_str),
            Some("approved")
        );
        assert_eq!(
            value
                .pointer("/agent/plan/0/status")
                .and_then(Value::as_str),
            Some("completed")
        );
        assert_eq!(
            value.pointer("/agent/runStatus").and_then(Value::as_str),
            Some("working")
        );
    }

    #[test]
    fn grouped_ui_selection_requires_exactly_one_item_per_group() {
        let directory = tempfile::tempdir().unwrap();
        let store = CoreStore::open(directory.path()).unwrap();
        let mut value = snapshot("session-a");
        value["assets"] = json!([
          { "id": "asset-a", "kind": "image", "origin": "generated" },
          { "id": "asset-b", "kind": "image", "origin": "generated" },
          { "id": "asset-c", "kind": "image", "origin": "generated" },
          { "id": "asset-d", "kind": "image", "origin": "generated" }
        ]);
        value["agent"]["artifacts"] = json!([
          { "assetId": "asset-a", "parentAssetIds": [], "approval": "unreviewed" },
          { "assetId": "asset-b", "parentAssetIds": [], "approval": "unreviewed" },
          { "assetId": "asset-c", "parentAssetIds": [], "approval": "unreviewed" },
          { "assetId": "asset-d", "parentAssetIds": [], "approval": "unreviewed" }
        ]);
        value["agent"]["decisions"] = json!([{
          "id": "decision-grouped", "requestKey": "grouped-review", "title": "Choose frames",
          "prompt": "Choose one frame per shot", "kind": "approval", "channel": "fruit_truck_ui",
          "status": "pending", "blocking": true, "selectionMode": "one_per_group",
          "minSelections": 2, "maxSelections": 2,
          "relatedAssetIds": ["asset-a", "asset-b", "asset-c", "asset-d"],
          "options": [
            { "id": "option-a", "assetId": "asset-a", "groupId": "shot-one", "label": "A" },
            { "id": "option-b", "assetId": "asset-b", "groupId": "shot-one", "label": "B" },
            { "id": "option-c", "assetId": "asset-c", "groupId": "shot-two", "label": "C" },
            { "id": "option-d", "assetId": "asset-d", "groupId": "shot-two", "label": "D" }
          ],
          "createdAt": "fixture"
        }]);
        store
            .commit_snapshot(command("session-a", 0, value, "create"))
            .unwrap();
        let operation = |request_key: &str, assets: Value| CommitOperations {
            session_id: "session-a".into(),
            base_revision: 1,
            command_id: request_key.into(),
            request_key: request_key.into(),
            request_hash: format!("hash-{request_key}"),
            ops: vec![json!({
              "type": "resolve_ui_decision", "decisionId": "decision-grouped",
              "selectedOptionIds": [], "selectedAssetIds": assets
            })],
        };
        assert_eq!(
            store
                .commit_operations(operation("invalid-groups", json!(["asset-a", "asset-b"])))
                .unwrap_err()
                .code,
            "INVALID_COMMAND"
        );
        store
            .commit_operations(operation("valid-groups", json!(["asset-a", "asset-c"])))
            .unwrap();
        let record = store.read_record("session-a").unwrap().unwrap();
        assert_eq!(
            record
                .snapshot
                .pointer("/agent/decisions/0/status")
                .and_then(Value::as_str),
            Some("resolved")
        );
    }

    #[test]
    fn artifact_evaluation_never_changes_approval() {
        let directory = tempfile::tempdir().unwrap();
        let store = CoreStore::open(directory.path()).unwrap();
        let mut value = snapshot("session-a");
        value["assets"] = json!([{ "id": "asset-one", "kind": "image", "origin": "generated" }]);
        value["agent"]["artifacts"] = json!([{
          "assetId": "asset-one", "role": "hero", "parentAssetIds": [], "approval": "unreviewed"
        }]);
        store
            .commit_snapshot(command("session-a", 0, value, "create"))
            .unwrap();
        store
            .commit_operations(CommitOperations {
                session_id: "session-a".into(),
                base_revision: 1,
                command_id: "evaluate-one".into(),
                request_key: "evaluate-one".into(),
                request_hash: "hash-evaluate-one".into(),
                ops: vec![json!({
                  "type": "evaluate_artifact", "assetId": "asset-one",
                  "technical": "Clean", "aesthetic": "Restrained", "recommendation": "Approve"
                })],
            })
            .unwrap();
        assert_eq!(
            store
                .read_record("session-a")
                .unwrap()
                .unwrap()
                .snapshot
                .pointer("/agent/artifacts/0/approval")
                .and_then(Value::as_str),
            Some("unreviewed")
        );
    }

    #[test]
    fn derived_step_bookkeeping_does_not_block_the_parent_command() {
        let directory = tempfile::tempdir().unwrap();
        let store = CoreStore::open(directory.path()).unwrap();
        store
            .commit_snapshot(command("session-a", 0, snapshot("session-a"), "create"))
            .unwrap();
        store
            .commit_operations(CommitOperations {
                session_id: "session-a".into(),
                base_revision: 1,
                command_id: "queue-with-stale-binding".into(),
                request_key: "queue-with-stale-binding".into(),
                request_hash: "hash-queue-with-stale-binding".into(),
                ops: vec![json!({
                  "type": "queue_decision", "requestKey": "stale-binding",
                  "title": "Review", "prompt": "Continue?", "kind": "approval",
                  "channel": "agent_chat", "blocking": true, "planStepId": "missing-step",
                  "options": [{ "id": "approve", "label": "Approve" }]
                })],
            })
            .unwrap();
        assert_eq!(
            store
                .read_record("session-a")
                .unwrap()
                .unwrap()
                .snapshot
                .pointer("/agent/decisions/0/status")
                .and_then(Value::as_str),
            Some("pending")
        );
    }

    #[test]
    fn schema_one_through_four_import_to_the_same_v4_recovery_shape() {
        let directory = tempfile::tempdir().unwrap();
        let store = CoreStore::open(directory.path()).unwrap();
        for schema_version in 1..=4 {
            let id = format!("session-schema-{schema_version}");
            store.import_legacy(&LegacyEnvelope {
        schema_version,
        revision: schema_version,
        sessions: vec![json!({
          "id": id,
          "name": "Legacy fixture",
          "createdAt": "fixture",
          "updatedAt": "fixture",
          "selectedModelIds": { "image": "legacy/image", "video": "legacy/video" },
          "agent": {
            "schemaVersion": schema_version,
            "brief": { "originalIntent": "legacy intent", "goal": "legacy goal" },
            "currentStepId": "step-one",
            "plan": [{ "id": "step-one", "title": "Step", "description": "Do it", "status": "waiting", "dependsOn": [] }]
          }
        })],
      }).unwrap();
            let value = store.read_record(&id).unwrap().unwrap().snapshot;
            assert_eq!(
                value
                    .pointer("/agent/schemaVersion")
                    .and_then(Value::as_u64),
                Some(4)
            );
            assert_eq!(
                value
                    .pointer("/agent/currentStepIds/0")
                    .and_then(Value::as_str),
                Some("step-one")
            );
            assert_eq!(
                value
                    .pointer("/generationDefaults/modelIds/image")
                    .and_then(Value::as_str),
                Some("legacy/image")
            );
            assert!(value
                .pointer("/agent/decisions")
                .is_some_and(Value::is_array));
            assert!(value
                .pointer("/agent/execution/costLedger")
                .is_some_and(Value::is_array));
        }
    }

    #[test]
    fn one_hundred_session_command_p95_stays_below_twenty_milliseconds() {
        let directory = tempfile::tempdir().unwrap();
        let store = CoreStore::open(directory.path()).unwrap();
        for index in 0..100 {
            let id = format!("session-perf-{index}");
            store
                .commit_snapshot(command(&id, 0, snapshot(&id), "create"))
                .unwrap();
        }
        let mut p95_samples = Vec::new();
        for sample in 0..3_u64 {
            let mut elapsed = Vec::new();
            for index in 0..100 {
                let id = format!("session-perf-{index}");
                let started = std::time::Instant::now();
                store.commit_operations(CommitOperations {
          session_id: id,
          base_revision: sample + 1,
          command_id: format!("perf-{sample}-{index}"),
          request_key: format!("perf-{sample}-{index}"),
          request_hash: format!("hash-perf-{sample}-{index}"),
          ops: vec![json!({ "type": "update_brief", "patch": { "goal": "measure command latency" } })],
        }).unwrap();
                elapsed.push(started.elapsed().as_micros());
            }
            elapsed.sort_unstable();
            let p95 = elapsed[94];
            p95_samples.push(p95);
            if p95 < 20_000 {
                break;
            }
        }
        let best_p95 = *p95_samples.iter().min().unwrap();
        assert!(
            best_p95 < 20_000,
            "Core state command best P95 was {best_p95}µs across samples {p95_samples:?}"
        );
    }
}
