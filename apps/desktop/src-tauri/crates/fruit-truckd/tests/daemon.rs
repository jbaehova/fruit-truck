#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

struct Daemon(Child);

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn request(socket: &Path, id: u64, method: &str, params: Value) -> Value {
    let mut stream = UnixStream::connect(socket).unwrap();
    serde_json::to_writer(
        &mut stream,
        &json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }),
    )
    .unwrap();
    stream.write_all(b"\n").unwrap();
    let mut line = String::new();
    BufReader::new(stream).read_line(&mut line).unwrap();
    serde_json::from_str(&line).unwrap()
}

fn snapshot() -> Value {
    json!({
      "id": "session-daemon",
      "name": "Daemon integration",
      "createdAt": "fixture",
      "updatedAt": "fixture",
      "agent": {
        "revision": 0,
        "connection": { "status": "waiting" },
        "controlMode": "agent", "runStatus": "waiting",
        "brief": { "originalIntent": "verify uds" },
        "requirements": [], "plan": [], "decisions": [], "activity": [], "artifacts": [],
        "assembly": { "status": "draft", "clips": [] },
        "execution": { "costLedger": [] }
      },
      "generationDefaults": {}, "threads": { "image": [], "video": [] }, "assets": []
    })
}

fn video_snapshot(submitted_at: &str) -> Value {
    let mut value = snapshot();
    value["agent"]["connection"] =
        json!({ "status": "claimed", "claimedBy": "test", "agentHost": "claude" });
    value["agent"]["runStatus"] = Value::from("working");
    value["agent"]["execution"]["currentJobIds"] = json!(["job-durable"]);
    value["threads"]["video"] = json!([{
      "id": "thread-video", "name": "Video 1", "mode": "video", "revision": 0,
      "outputRole": "hero_video", "draft": { "references": [] }, "enhancementAttempts": [],
      "attempts": [{
        "id": "attempt-video", "status": "in_progress", "backend": "openrouter",
        "jobId": "job-durable", "pollAttempts": 0, "nextPollAt": "2020-01-01T00:00:00.000Z",
        "submittedAt": submitted_at,
        "createdAt": "2020-01-01T00:00:00.000Z", "updatedAt": "2020-01-01T00:00:00.000Z",
        "inputAssetIds": [], "assetIds": [],
        "snapshot": { "modelId": "test/video", "prompt": "private prompt", "outputRole": "hero_video" }
      }]
    }]);
    value
}

fn write_legacy_edit(home: &Path, name: &str, agent_revision: u64, envelope_revision: u64) {
    let index_path = home.join("agent-sessions.json");
    let mut index: Value = serde_json::from_slice(&std::fs::read(&index_path).unwrap()).unwrap();
    let file = index
        .pointer("/sessionFiles/0/file")
        .and_then(Value::as_str)
        .unwrap()
        .to_string();
    let session_path = home.join("agent-sessions").join(file);
    let mut session: Value =
        serde_json::from_slice(&std::fs::read(&session_path).unwrap()).unwrap();
    session["name"] = Value::from(name);
    session["agent"]["revision"] = Value::from(agent_revision);
    std::fs::write(session_path, serde_json::to_vec_pretty(&session).unwrap()).unwrap();
    index["revision"] = Value::from(envelope_revision);
    let temporary = home.join("agent-sessions.test.tmp");
    std::fs::write(&temporary, serde_json::to_vec_pretty(&index).unwrap()).unwrap();
    std::fs::rename(temporary, index_path).unwrap();
}

fn mock_video_provider() -> (String, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let handle = thread::spawn(move || {
        for _ in 0..2 {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut request_line = String::new();
            reader.read_line(&mut request_line).unwrap();
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" || line.is_empty() {
                    break;
                }
            }
            let (content_type, body) = if request_line.contains("/content?") {
                ("video/mp4", b"fixture-video".to_vec())
            } else {
                (
                    "application/json",
                    br#"{"status":"completed","progress":100,"cost":0.42}"#.to_vec(),
                )
            };
            write!(
        stream,
        "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
      ).unwrap();
            stream.write_all(&body).unwrap();
        }
    });
    (format!("http://{address}"), handle)
}

#[test]
fn uds_handshake_commit_read_and_event_wait() {
    let directory = tempfile::tempdir().unwrap();
    let mut child = Daemon(
        Command::new(env!("CARGO_BIN_EXE_fruit-truckd"))
            .arg("--home")
            .arg(directory.path())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let socket = directory.path().join("run/core.sock");
    let deadline = Instant::now() + Duration::from_secs(5);
    while !socket.exists() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    if !socket.exists() {
        let mut stderr = String::new();
        if let Some(stream) = child.0.stderr.take() {
            let _ = BufReader::new(stream).read_line(&mut stderr);
        }
        panic!("daemon socket was not created: {stderr}");
    }
    assert_eq!(
        socket.metadata().unwrap().permissions().mode() & 0o777,
        0o600
    );

    let handshake = request(&socket, 1, "core.handshake", json!({}));
    assert_eq!(
        handshake.pointer("/result/protocolVersion"),
        Some(&Value::from(2))
    );

    let wait_presence_socket = socket.clone();
    let presence_waiter = thread::spawn(move || {
        request(
            &wait_presence_socket,
            11,
            "desktop.wait_connected",
            json!({ "timeoutMs": 2_000 }),
        )
    });
    thread::sleep(Duration::from_millis(25));
    let mut desktop = UnixStream::connect(&socket).unwrap();
    serde_json::to_writer(
        &mut desktop,
        &json!({ "jsonrpc": "2.0", "id": 12, "method": "desktop.connect", "params": {} }),
    )
    .unwrap();
    desktop.write_all(b"\n").unwrap();
    let mut connected_line = String::new();
    BufReader::new(desktop.try_clone().unwrap())
        .read_line(&mut connected_line)
        .unwrap();
    assert_eq!(
        presence_waiter.join().unwrap().pointer("/result/connected"),
        Some(&Value::Bool(true))
    );
    assert_eq!(
        request(&socket, 13, "desktop.status", json!({})).pointer("/result/connected"),
        Some(&Value::Bool(true))
    );
    drop(desktop);
    let disconnected_deadline = Instant::now() + Duration::from_secs(1);
    while request(&socket, 14, "desktop.status", json!({})).pointer("/result/connected")
        != Some(&Value::Bool(false))
        && Instant::now() < disconnected_deadline
    {
        thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(
        request(&socket, 15, "desktop.status", json!({})).pointer("/result/connected"),
        Some(&Value::Bool(false))
    );

    let commit = request(
        &socket,
        2,
        "session.commit_snapshot",
        json!({
          "sessionId": "session-daemon", "baseRevision": 0, "snapshot": snapshot(),
          "commandId": "create-daemon", "changed": ["session"]
        }),
    );
    assert_eq!(commit.pointer("/result/revision"), Some(&Value::from(1)));
    let read = request(
        &socket,
        3,
        "session.read",
        json!({ "sessionId": "session-daemon", "view": "resume" }),
    );
    assert_eq!(
        read.pointer("/result/projection/identity/id"),
        Some(&Value::from("session-daemon"))
    );

    let wait_socket = socket.clone();
    let waiter = thread::spawn(move || {
        request(
            &wait_socket,
            4,
            "event.wait",
            json!({ "sessionId": "session-daemon", "afterEvent": 1, "timeoutMs": 2_000 }),
        )
    });
    thread::sleep(Duration::from_millis(50));
    let second = request(
        &socket,
        5,
        "session.commit_snapshot",
        json!({
          "sessionId": "session-daemon", "baseRevision": 1, "snapshot": snapshot(),
          "commandId": "update-daemon", "changed": ["brief"]
        }),
    );
    assert_eq!(second.pointer("/result/revision"), Some(&Value::from(2)));
    let waited = waiter.join().unwrap();
    assert_eq!(
        waited.pointer("/result/events/0/revision"),
        Some(&Value::from(2))
    );
    assert!(directory.path().join("agent-sessions.json").exists());

    write_legacy_edit(directory.path(), "Accepted stale-client edit", 3, 3);
    let ingress_deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let value = request(
            &socket,
            20,
            "session.read",
            json!({ "sessionId": "session-daemon", "view": "recovery" }),
        );
        if value.pointer("/result/projection/name")
            == Some(&Value::from("Accepted stale-client edit"))
        {
            break;
        }
        assert!(
            Instant::now() < ingress_deadline,
            "legacy ingress did not apply"
        );
        thread::sleep(Duration::from_millis(20));
    }

    write_legacy_edit(directory.path(), "Rejected stale overwrite", 3, 4);
    thread::sleep(Duration::from_millis(150));
    let retained = request(
        &socket,
        21,
        "session.read",
        json!({ "sessionId": "session-daemon", "view": "recovery" }),
    );
    assert_eq!(
        retained.pointer("/result/projection/name"),
        Some(&Value::from("Accepted stale-client edit"))
    );
    let conflicts = request(
        &socket,
        22,
        "event.wait",
        json!({ "sessionId": "session-daemon", "afterEvent": 3, "timeoutMs": 500, "eventTypes": ["legacy.conflict"] }),
    );
    assert_eq!(
        conflicts.pointer("/result/events/0/type"),
        Some(&Value::from("legacy.conflict"))
    );
}

#[test]
fn durable_video_task_completes_after_clients_disconnect() {
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(
        directory.path().join("credentials.json"),
        br#"{"schema_version":1,"openrouter_api_key":"test-key-for-daemon"}"#,
    )
    .unwrap();
    let (provider, provider_thread) = mock_video_provider();
    let _daemon = Daemon(
        Command::new(env!("CARGO_BIN_EXE_fruit-truckd"))
            .arg("--home")
            .arg(directory.path())
            .env("FRUIT_TRUCK_OPENROUTER_BASE", provider)
            .env("FRUIT_TRUCK_VIDEO_POLL_INTERVAL_MS", "500")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let socket = directory.path().join("run/core.sock");
    let deadline = Instant::now() + Duration::from_secs(5);
    while !socket.exists() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    assert!(socket.exists());

    let value = video_snapshot(&chrono::Utc::now().to_rfc3339());
    let committed = request(
        &socket,
        30,
        "session.commit_snapshot",
        json!({
          "sessionId": "session-daemon", "baseRevision": 0, "snapshot": value,
          "commandId": "create-video-task", "changed": ["attempt:attempt-video"]
        }),
    );
    assert_eq!(committed.pointer("/result/revision"), Some(&Value::from(1)));

    let terminal_deadline = Instant::now() + Duration::from_secs(5);
    let completed = loop {
        let read = request(
            &socket,
            31,
            "session.read",
            json!({ "sessionId": "session-daemon", "view": "recovery" }),
        );
        if read.pointer("/result/projection/threads/video/0/attempts/0/status")
            == Some(&Value::from("completed"))
        {
            break read;
        }
        assert!(
            Instant::now() < terminal_deadline,
            "durable video task did not complete"
        );
        thread::sleep(Duration::from_millis(25));
    };
    assert_eq!(
        completed.pointer("/result/projection/agent/execution/spentUsd"),
        Some(&Value::from(0.42))
    );
    let path = completed
        .pointer("/result/projection/assets/0/localPath")
        .and_then(Value::as_str)
        .unwrap();
    assert!(Path::new(path).exists());
    assert_eq!(std::fs::read(path).unwrap(), b"fixture-video");
    provider_thread.join().unwrap();
}

#[test]
fn expired_video_task_fails_without_contacting_provider() {
    let directory = tempfile::tempdir().unwrap();
    let _daemon = Daemon(
        Command::new(env!("CARGO_BIN_EXE_fruit-truckd"))
            .arg("--home")
            .arg(directory.path())
            .env("FRUIT_TRUCK_OPENROUTER_BASE", "http://127.0.0.1:1")
            .env("FRUIT_TRUCK_VIDEO_POLL_TIMEOUT_MS", "1000")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let socket = directory.path().join("run/core.sock");
    let deadline = Instant::now() + Duration::from_secs(5);
    while !socket.exists() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    assert!(socket.exists());

    let committed = request(
        &socket,
        40,
        "session.commit_snapshot",
        json!({
          "sessionId": "session-daemon", "baseRevision": 0,
          "snapshot": video_snapshot("2020-01-01T00:00:00.000Z"),
          "commandId": "create-expired-video-task", "changed": ["attempt:attempt-video"]
        }),
    );
    assert_eq!(committed.pointer("/result/revision"), Some(&Value::from(1)));

    let terminal_deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let read = request(
            &socket,
            41,
            "session.read",
            json!({ "sessionId": "session-daemon", "view": "recovery" }),
        );
        if read.pointer("/result/projection/threads/video/0/attempts/0/status")
            == Some(&Value::from("failed"))
        {
            assert!(read
                .pointer("/result/projection/threads/video/0/attempts/0/error")
                .and_then(Value::as_str)
                .is_some_and(|error| error.contains("terminal state")));
            break;
        }
        assert!(
            Instant::now() < terminal_deadline,
            "expired durable video task did not fail"
        );
        thread::sleep(Duration::from_millis(25));
    }
}
