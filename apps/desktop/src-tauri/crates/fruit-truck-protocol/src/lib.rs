use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u32 = 2;
pub const STORE_SCHEMA_VERSION: u32 = 1;
pub const CORE_VERSION: &str = env!("CARGO_PKG_VERSION");

pub const CAPABILITIES: &[&str] = &[
    "core.handshake",
    "core.integrity_check",
    "session.import_legacy",
    "session.ingest_legacy",
    "session.list",
    "session.read",
    "session.read_all",
    "session.commit",
    "session.commit_snapshot",
    "event.wait",
    "desktop.connect",
    "desktop.status",
    "desktop.wait_connected",
    "session.export_legacy",
    "telemetry.record",
];

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RpcRequest {
    pub jsonrpc: String,
    pub id: Value,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RpcResponse {
    pub jsonrpc: String,
    pub id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

impl RpcResponse {
    pub fn success(id: Value, result: impl Serialize) -> Self {
        match serde_json::to_value(result) {
            Ok(result) => Self {
                jsonrpc: "2.0".into(),
                id,
                result: Some(result),
                error: None,
            },
            Err(error) => Self::failure(id, "SERIALIZATION_FAILED", error.to_string()),
        }
    }

    pub fn failure(id: Value, code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            jsonrpc: "2.0".into(),
            id,
            result: None,
            error: Some(RpcError {
                code: code.into(),
                message: message.into(),
                data: None,
            }),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RpcError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Handshake {
    pub protocol_version: u32,
    pub store_schema_version: u32,
    pub core_version: String,
    pub capabilities: Vec<String>,
}

impl Default for Handshake {
    fn default() -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            store_schema_version: STORE_SCHEMA_VERSION,
            core_version: CORE_VERSION.into(),
            capabilities: CAPABILITIES.iter().map(|item| (*item).into()).collect(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandReceipt {
    pub ok: bool,
    pub session_id: String,
    pub revision: u64,
    pub command_id: String,
    pub changed: Vec<String>,
    pub event_cursor: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next: Option<NextAction>,
    pub replayed: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct NextAction {
    pub kind: String,
    pub id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventRecord {
    pub cursor: u64,
    pub session_id: String,
    pub session_sequence: u64,
    pub revision: u64,
    #[serde(rename = "type")]
    pub event_type: String,
    pub payload: Value,
    pub created_at_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecord {
    pub session_id: String,
    pub revision: u64,
    pub snapshot: Value,
    pub updated_at_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitSnapshot {
    pub session_id: String,
    pub base_revision: u64,
    pub snapshot: Value,
    pub command_id: String,
    #[serde(default)]
    pub changed: Vec<String>,
    #[serde(default)]
    pub event_type: Option<String>,
    #[serde(default)]
    pub event_payload: Value,
    #[serde(default)]
    pub idempotency_scope: Option<String>,
    #[serde(default)]
    pub idempotency_key: Option<String>,
    #[serde(default)]
    pub request_hash: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitOperations {
    pub session_id: String,
    pub base_revision: u64,
    pub command_id: String,
    pub request_key: String,
    pub request_hash: String,
    pub ops: Vec<Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadSession {
    pub session_id: String,
    #[serde(default = "default_view")]
    pub view: String,
    #[serde(default)]
    pub since_revision: Option<u64>,
    #[serde(default)]
    pub after_event: Option<u64>,
    #[serde(default)]
    pub thread_ids: Vec<String>,
    #[serde(default)]
    pub decision_ids: Vec<String>,
    #[serde(default)]
    pub asset_ids: Vec<String>,
}

fn default_view() -> String {
    "resume".into()
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaitEvents {
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub after_event: u64,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
    #[serde(default)]
    pub event_types: Vec<String>,
}

fn default_timeout_ms() -> u64 {
    20_000
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventBatch {
    pub events: Vec<EventRecord>,
    pub cursor: u64,
    pub timed_out: bool,
    #[serde(default)]
    pub reset_required: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyEnvelope {
    #[serde(default)]
    pub schema_version: u64,
    #[serde(default)]
    pub revision: u64,
    #[serde(default)]
    pub sessions: Vec<Value>,
}
