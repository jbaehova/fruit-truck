use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use fruit_truck_protocol::{RpcResponse, PROTOCOL_VERSION, STORE_SCHEMA_VERSION};
use serde_json::{json, Value};
use tauri::Manager;

static TRACE_SEQUENCE: AtomicU64 = AtomicU64::new(1);

pub fn core_home(app: &tauri::AppHandle) -> Result<PathBuf, String> {
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

fn socket_path(home: &Path) -> PathBuf {
    home.join("run/core.sock")
}

fn binary_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("FRUIT_TRUCK_CORE_BIN") {
        candidates.push(PathBuf::from(path));
    }
    if let Ok(executable) = std::env::current_exe() {
        if let Some(directory) = executable.parent() {
            candidates.push(directory.join("fruit-truckd"));
        }
    }
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/debug/fruit-truckd"));
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/release/fruit-truckd"));
    candidates
}

fn spawn_core(home: &Path) -> Result<(), String> {
    let binary = binary_candidates()
        .into_iter()
        .find(|candidate| candidate.is_file())
        .ok_or("Fruit Truck Core helper is missing from this build.")?;
    Command::new(binary)
        .arg("--home")
        .arg(home)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Could not start Fruit Truck Core: {error}"))?;
    Ok(())
}

fn connect_core(home: &Path) -> Result<UnixStream, String> {
    if let Ok(mut stream) = UnixStream::connect(socket_path(home)) {
        verify_handshake(&mut stream)?;
        return Ok(stream);
    }
    spawn_core(home)?;
    let deadline = Instant::now() + Duration::from_secs(4);
    loop {
        match UnixStream::connect(socket_path(home)) {
            Ok(mut stream) => {
                verify_handshake(&mut stream)?;
                return Ok(stream);
            }
            Err(error) if Instant::now() >= deadline => {
                return Err(format!("Fruit Truck Core did not become ready: {error}"));
            }
            Err(_) => std::thread::sleep(Duration::from_millis(25)),
        }
    }
}

fn verify_handshake(stream: &mut UnixStream) -> Result<(), String> {
    let handshake = request_on_stream(stream, 0, "core.handshake", json!({}))?;
    validate_handshake(&handshake)
}

fn validate_handshake(handshake: &Value) -> Result<(), String> {
    let protocol = handshake.get("protocolVersion").and_then(Value::as_u64);
    let schema = handshake.get("storeSchemaVersion").and_then(Value::as_u64);
    if protocol != Some(PROTOCOL_VERSION as u64) || schema != Some(STORE_SCHEMA_VERSION as u64) {
        return Err(format!(
      "Fruit Truck Core protocol is incompatible (protocol={protocol:?}, schema={schema:?}). Restart Fruit Truck after updating the app."
    ));
    }
    Ok(())
}

fn request_on_stream(
    stream: &mut UnixStream,
    id: u64,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    serde_json::to_writer(
        &mut *stream,
        &json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }),
    )
    .map_err(|error| error.to_string())?;
    stream.write_all(b"\n").map_err(|error| error.to_string())?;
    stream.flush().map_err(|error| error.to_string())?;
    let mut line = String::new();
    let mut reader = BufReader::new(stream.try_clone().map_err(|error| error.to_string())?);
    let read = reader
        .by_ref()
        .take(50 * 1024 * 1024 + 1)
        .read_line(&mut line)
        .map_err(|error| error.to_string())?;
    if read == 0 {
        return Err("Fruit Truck Core closed the connection before replying.".into());
    }
    if line.len() > 50 * 1024 * 1024 {
        return Err("Fruit Truck Core response exceeds the 50 MB safety limit.".into());
    }
    let response: RpcResponse = serde_json::from_str(&line).map_err(|error| error.to_string())?;
    if let Some(error) = response.error {
        return Err(format!("{}: {}", error.code, error.message));
    }
    response
        .result
        .ok_or_else(|| "Fruit Truck Core returned no result.".into())
}

pub fn request(app: &tauri::AppHandle, method: &str, params: Value) -> Result<Value, String> {
    let home = core_home(app)?;
    let mut stream = connect_core(&home)?;
    let sequence = TRACE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let created = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let mut params = params;
    if let Some(object) = params.as_object_mut() {
        object.insert(
            "_trace".into(),
            json!({
              "traceId": format!("desktop-{}-{created}", std::process::id()),
              "commandId": format!("desktop-command-{sequence}"),
            }),
        );
    }
    request_on_stream(&mut stream, sequence, method, params)
}

pub fn start_desktop_presence(app: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        let result = (|| -> Result<(), String> {
            let home = core_home(&app)?;
            let mut stream = connect_core(&home)?;
            request_on_stream(
                &mut stream,
                1,
                "desktop.connect",
                json!({
                  "pid": std::process::id(),
                  "version": app.package_info().version.to_string(),
                }),
            )?;
            let mut reader = BufReader::new(stream);
            let mut sink = String::new();
            loop {
                sink.clear();
                if reader
                    .read_line(&mut sink)
                    .map_err(|error| error.to_string())?
                    == 0
                {
                    break;
                }
            }
            Ok(())
        })();
        if let Err(error) = result {
            eprintln!("Fruit Truck Core desktop connection failed: {error}");
        }
        std::thread::sleep(Duration::from_millis(500));
    });
}

#[cfg(test)]
mod tests {
    use super::{socket_path, validate_handshake};
    use serde_json::json;

    #[test]
    fn socket_is_scoped_to_private_core_run_directory() {
        assert_eq!(
            socket_path(std::path::Path::new("/tmp/fruit-home")),
            std::path::PathBuf::from("/tmp/fruit-home/run/core.sock")
        );
    }

    #[test]
    fn handshake_rejects_incompatible_protocol_or_schema() {
        assert!(validate_handshake(&json!({
          "protocolVersion": fruit_truck_protocol::PROTOCOL_VERSION,
          "storeSchemaVersion": fruit_truck_protocol::STORE_SCHEMA_VERSION,
        }))
        .is_ok());
        assert!(validate_handshake(&json!({
          "protocolVersion": fruit_truck_protocol::PROTOCOL_VERSION + 1,
          "storeSchemaVersion": fruit_truck_protocol::STORE_SCHEMA_VERSION,
        }))
        .is_err());
        assert!(validate_handshake(&json!({
          "protocolVersion": fruit_truck_protocol::PROTOCOL_VERSION,
          "storeSchemaVersion": fruit_truck_protocol::STORE_SCHEMA_VERSION + 1,
        }))
        .is_err());
    }
}
