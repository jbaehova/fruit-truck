#[cfg(not(unix))]
compile_error!("fruit-truckd currently requires Unix domain sockets.");

#[cfg(unix)]
mod daemon {
    use std::fs::{self, OpenOptions};
    use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Condvar, Mutex};
    use std::thread;
    use std::time::{Duration, Instant};

    use fruit_truck_core::{CoreError, CoreStore, DurableTask};
    use fruit_truck_protocol::{
        CommitOperations, CommitSnapshot, Handshake, LegacyEnvelope, ReadSession, RpcRequest,
        RpcResponse, WaitEvents,
    };
    use notify::{RecursiveMode, Watcher};
    use serde_json::{json, Value};

    const MAX_RPC_REQUEST_BYTES: usize = 50 * 1024 * 1024;
    const MAX_GENERATED_VIDEO_BYTES: u64 = 700 * 1024 * 1024;
    const DEFAULT_VIDEO_POLL_TIMEOUT_MS: u64 = 30 * 60_000;

    struct RuntimeFiles {
        socket: PathBuf,
        lock: PathBuf,
    }

    #[derive(Default)]
    struct DesktopPresence {
        connections: AtomicUsize,
        generation: Mutex<u64>,
        changed: Condvar,
    }

    impl DesktopPresence {
        fn connect(&self) {
            self.connections.fetch_add(1, Ordering::SeqCst);
            self.bump();
        }

        fn disconnect(&self) {
            self.connections.fetch_sub(1, Ordering::SeqCst);
            self.bump();
        }

        fn bump(&self) {
            if let Ok(mut generation) = self.generation.lock() {
                *generation += 1;
                self.changed.notify_all();
            }
        }

        fn connected(&self) -> bool {
            self.connections.load(Ordering::SeqCst) > 0
        }

        fn wait_connected(&self, timeout_ms: u64) -> bool {
            if self.connected() {
                return true;
            }
            let deadline = Instant::now() + Duration::from_millis(timeout_ms.clamp(100, 10_000));
            let Ok(mut generation) = self.generation.lock() else {
                return false;
            };
            let observed = *generation;
            while !self.connected() && *generation == observed {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    break;
                }
                let Ok(result) = self.changed.wait_timeout(generation, remaining) else {
                    return false;
                };
                generation = result.0;
                if result.1.timed_out() {
                    break;
                }
            }
            self.connected()
        }
    }

    struct DesktopLease {
        presence: Arc<DesktopPresence>,
        active: bool,
    }

    impl Drop for DesktopLease {
        fn drop(&mut self) {
            if self.active {
                self.presence.disconnect();
            }
        }
    }

    impl Drop for RuntimeFiles {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.socket);
            let _ = fs::remove_file(&self.lock);
        }
    }

    pub fn run() -> Result<(), String> {
        let home = home_from_args()?;
        secure_directory(&home)?;
        let run = home.join("run");
        secure_directory(&run)?;
        let socket = run.join("core.sock");
        let lock = run.join("core.lock");
        let mut lock_file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&lock)
            .map_err(|error| {
                format!("Could not acquire Fruit Truck Core singleton lock: {error}")
            })?;
        // SAFETY: lock_file owns this valid descriptor for at least as long as the advisory lock.
        let lock_result =
            unsafe { libc::flock(lock_file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        if lock_result != 0 {
            return Err("Fruit Truck Core is already running or starting.".into());
        }
        let mut previous_owner = String::new();
        lock_file
            .read_to_string(&mut previous_owner)
            .map_err(|error| error.to_string())?;
        let previous_owner_is_live = previous_owner
            .trim()
            .parse::<u32>()
            .ok()
            .filter(|pid| *pid != std::process::id())
            .is_some_and(|pid| {
                Command::new("kill")
                    .args(["-0", &pid.to_string()])
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status()
                    .is_ok_and(|status| status.success())
            });
        if previous_owner_is_live {
            return Err("Fruit Truck Core is already running or starting.".into());
        }
        lock_file
            .set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|error| error.to_string())?;
        lock_file.set_len(0).map_err(|error| error.to_string())?;
        lock_file
            .seek(SeekFrom::Start(0))
            .map_err(|error| error.to_string())?;
        write!(lock_file, "{}", std::process::id()).map_err(|error| error.to_string())?;
        lock_file.sync_data().map_err(|error| error.to_string())?;
        let _runtime_files = RuntimeFiles {
            socket: socket.clone(),
            lock,
        };
        let _ = fs::remove_file(&socket);
        let listener = UnixListener::bind(&socket).map_err(|error| error.to_string())?;
        fs::set_permissions(&socket, fs::Permissions::from_mode(0o600))
            .map_err(|error| error.to_string())?;
        let store = Arc::new(CoreStore::open(&home).map_err(|error| error.to_string())?);
        let presence = Arc::new(DesktopPresence::default());
        store.integrity_check().map_err(|error| error.to_string())?;
        start_legacy_ingress(Arc::clone(&store), home.clone());
        start_video_scheduler(Arc::clone(&store), home.clone());

        for incoming in listener.incoming() {
            match incoming {
                Ok(stream) => {
                    let store = Arc::clone(&store);
                    let presence = Arc::clone(&presence);
                    thread::spawn(move || {
                        if let Err(error) = serve_connection(stream, store, presence) {
                            eprintln!("fruit-truckd connection error: {error}");
                        }
                    });
                }
                Err(error) => eprintln!("fruit-truckd accept error: {error}"),
            }
        }
        Ok(())
    }

    fn serve_connection(
        mut stream: UnixStream,
        store: Arc<CoreStore>,
        presence: Arc<DesktopPresence>,
    ) -> Result<(), String> {
        let mut reader = BufReader::new(stream.try_clone().map_err(|error| error.to_string())?);
        let mut desktop = DesktopLease {
            presence: Arc::clone(&presence),
            active: false,
        };
        loop {
            let mut line = String::new();
            let read = reader
                .by_ref()
                .take((MAX_RPC_REQUEST_BYTES + 1) as u64)
                .read_line(&mut line)
                .map_err(|error| error.to_string())?;
            if read == 0 {
                break;
            }
            if line.len() > MAX_RPC_REQUEST_BYTES {
                return Err("Fruit Truck Core request exceeds the 50 MB safety limit.".into());
            }
            if line.trim().is_empty() {
                continue;
            }
            let response = match serde_json::from_str::<RpcRequest>(&line) {
                Ok(request) => {
                    if request.method == "desktop.connect" && !desktop.active {
                        presence.connect();
                        desktop.active = true;
                    }
                    dispatch(request, &store, &presence)
                }
                Err(error) => {
                    RpcResponse::failure(Value::Null, "INVALID_REQUEST", error.to_string())
                }
            };
            serde_json::to_writer(&mut stream, &response).map_err(|error| error.to_string())?;
            stream.write_all(b"\n").map_err(|error| error.to_string())?;
            stream.flush().map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    fn dispatch(request: RpcRequest, store: &CoreStore, presence: &DesktopPresence) -> RpcResponse {
        let started = Instant::now();
        let trace_id = request
            .params
            .pointer("/_trace/traceId")
            .and_then(Value::as_str)
            .map(str::to_string);
        let command_id = request
            .params
            .pointer("/_trace/commandId")
            .and_then(Value::as_str)
            .map(str::to_string);
        let id = request.id;
        let result: Result<Value, CoreError> = (|| match request.method.as_str() {
            "core.handshake" => Ok(serde_json::to_value(Handshake::default())?),
            "core.integrity_check" => {
                store.integrity_check()?;
                Ok(json!({ "ok": true }))
            }
            "desktop.connect" | "desktop.status" => {
                Ok(json!({ "connected": presence.connected() }))
            }
            "desktop.wait_connected" => {
                let timeout_ms = request
                    .params
                    .get("timeoutMs")
                    .and_then(Value::as_u64)
                    .unwrap_or(8_000);
                Ok(json!({ "connected": presence.wait_connected(timeout_ms) }))
            }
            "session.import_legacy" => {
                store.backup_legacy_files()?;
                let envelope: LegacyEnvelope = serde_json::from_value(request.params)?;
                Ok(serde_json::to_value(store.import_legacy(&envelope)?)?)
            }
            "session.ingest_legacy" => {
                let envelope: LegacyEnvelope = serde_json::from_value(request.params)?;
                let outcome = store.ingest_legacy(&envelope)?;
                if !outcome.receipts.is_empty() || !outcome.conflicts.is_empty() {
                    store.export_legacy_v4()?;
                }
                Ok(json!({ "receipts": outcome.receipts, "conflicts": outcome.conflicts }))
            }
            "session.list" => Ok(serde_json::to_value(store.list_sessions()?)?),
            "session.read_all" => store.canonical_envelope(),
            "session.read" => {
                let params: ReadSession = serde_json::from_value(request.params)?;
                store.read_session(&params)
            }
            "session.commit" => {
                let params: CommitOperations = serde_json::from_value(request.params)?;
                let receipt = store.commit_operations(params)?;
                store.export_legacy_v4()?;
                Ok(serde_json::to_value(receipt)?)
            }
            "session.commit_snapshot" | "shadow.commit_snapshot" => {
                let params: CommitSnapshot = serde_json::from_value(request.params)?;
                let receipt = store.commit_snapshot(params)?;
                if request.method == "session.commit_snapshot" {
                    store.export_legacy_v4()?;
                }
                Ok(serde_json::to_value(receipt)?)
            }
            "event.wait" => {
                let params: WaitEvents = serde_json::from_value(request.params)?;
                Ok(serde_json::to_value(store.wait_events(params)?)?)
            }
            "telemetry.record" => {
                let trace_id = request
                    .params
                    .get("traceId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| CoreError {
                        code: "INVALID_TELEMETRY",
                        message: "traceId is required.".into(),
                    })?;
                let command_id = request.params.get("commandId").and_then(Value::as_str);
                let name = request
                    .params
                    .get("name")
                    .and_then(Value::as_str)
                    .ok_or_else(|| CoreError {
                        code: "INVALID_TELEMETRY",
                        message: "name is required.".into(),
                    })?;
                let duration_us = request
                    .params
                    .get("durationUs")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                let fields = request
                    .params
                    .get("fields")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                store.record_telemetry_span(trace_id, command_id, name, duration_us, fields)?;
                Ok(json!({ "ok": true }))
            }
            "session.export_legacy" => store.export_legacy_v4(),
            _ => Err(CoreError {
                code: "METHOD_NOT_FOUND",
                message: format!("Unknown Core method: {}", request.method),
            }),
        })();
        let succeeded = result.is_ok();
        let response = match result {
            Ok(value) => RpcResponse::success(id, value),
            Err(error) => RpcResponse::failure(id, error.code, error.message),
        };
        if let Some(trace_id) = trace_id {
            let _ = store.record_telemetry_span(
                &trace_id,
                command_id.as_deref(),
                "core.command",
                started.elapsed().as_micros() as u64,
                json!({ "succeeded": succeeded }),
            );
        }
        response
    }

    fn home_from_args() -> Result<PathBuf, String> {
        let arguments = std::env::args().collect::<Vec<_>>();
        if let Some(index) = arguments.iter().position(|item| item == "--home") {
            return arguments
                .get(index + 1)
                .map(PathBuf::from)
                .filter(|path| path.is_absolute())
                .ok_or_else(|| "--home requires an absolute path.".into());
        }
        if let Some(value) = arguments
            .iter()
            .find_map(|item| item.strip_prefix("--home="))
        {
            let path = PathBuf::from(value);
            return if path.is_absolute() {
                Ok(path)
            } else {
                Err("--home requires an absolute path.".into())
            };
        }
        if let Some(value) = std::env::var_os("FRUIT_TRUCK_HOME") {
            let path = PathBuf::from(value);
            return if path.is_absolute() {
                Ok(path)
            } else {
                Err("FRUIT_TRUCK_HOME must be absolute.".into())
            };
        }
        let home = std::env::var_os("HOME").ok_or("The home directory is unavailable.")?;
        Ok(PathBuf::from(home).join(".fruit-truck"))
    }

    fn start_legacy_ingress(store: Arc<CoreStore>, home: PathBuf) {
        thread::spawn(move || {
            let (sender, receiver) = std::sync::mpsc::channel();
            let mut watcher = match notify::recommended_watcher(move |event| {
                let _ = sender.send(event);
            }) {
                Ok(watcher) => watcher,
                Err(error) => {
                    eprintln!("Fruit Truck legacy ingress watcher failed: {error}");
                    return;
                }
            };
            if let Err(error) = watcher.watch(&home, RecursiveMode::NonRecursive) {
                eprintln!("Fruit Truck legacy ingress watch failed: {error}");
                return;
            }
            while let Ok(event) = receiver.recv() {
                let Ok(event) = event else {
                    continue;
                };
                if !event.paths.iter().any(|path| {
                    path.file_name().and_then(|value| value.to_str()) == Some("agent-sessions.json")
                }) {
                    continue;
                }
                while receiver.recv_timeout(Duration::from_millis(25)).is_ok() {}
                let envelope = match read_legacy_envelope(&home) {
                    Ok(envelope) => envelope,
                    Err(error) => {
                        eprintln!("Fruit Truck legacy ingress read failed: {error}");
                        continue;
                    }
                };
                match store.ingest_legacy(&envelope) {
                    Ok(outcome) if !outcome.conflicts.is_empty() => {
                        if let Err(error) = store.export_legacy_v4() {
                            eprintln!("Fruit Truck legacy recovery export failed: {error}");
                        }
                    }
                    Ok(_) => {}
                    Err(error) => eprintln!("Fruit Truck legacy ingress failed: {error}"),
                }
            }
        });
    }

    fn start_video_scheduler(store: Arc<CoreStore>, home: PathBuf) {
        thread::spawn(move || {
            let client = match reqwest::blocking::Client::builder()
                .timeout(Duration::from_secs(180))
                .build()
            {
                Ok(client) => client,
                Err(error) => {
                    eprintln!("Fruit Truck video scheduler could not start: {error}");
                    return;
                }
            };
            loop {
                let now = match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
                    Ok(value) => value.as_millis() as u64,
                    Err(_) => {
                        thread::sleep(Duration::from_secs(1));
                        continue;
                    }
                };
                match store.claim_due_video_task(now) {
                    Ok(Some(task)) => {
                        if let Err(error) = poll_video_task(&client, &store, &home, &task) {
                            let retry = task
                                .state
                                .get("schedulerRetries")
                                .and_then(Value::as_u64)
                                .unwrap_or(0);
                            let delay = (1_000_u64
                                .saturating_mul(2_u64.saturating_pow(retry.min(6) as u32)))
                            .min(60_000);
                            if let Err(reschedule_error) = store.reschedule_task(&task.id, delay) {
                                eprintln!(
                                    "Fruit Truck video task reschedule failed: {reschedule_error}"
                                );
                            }
                            if error.code != "CREDENTIAL_UNAVAILABLE"
                                && error.code != "SESSION_CONFLICT"
                            {
                                eprintln!("Fruit Truck video task failed: {error}");
                            }
                        }
                    }
                    Ok(None) => thread::sleep(Duration::from_millis(250)),
                    Err(error) => {
                        eprintln!("Fruit Truck video scheduler store error: {error}");
                        thread::sleep(Duration::from_secs(1));
                    }
                }
            }
        });
    }

    fn poll_video_task(
        client: &reqwest::blocking::Client,
        store: &CoreStore,
        home: &Path,
        task: &DurableTask,
    ) -> Result<(), CoreError> {
        let poll_attempt = task
            .state
            .get("pollAttempt")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            + 1;
        let timeout_ms = std::env::var("FRUIT_TRUCK_VIDEO_POLL_TIMEOUT_MS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(DEFAULT_VIDEO_POLL_TIMEOUT_MS)
            .clamp(1_000, 24 * 60 * 60_000);
        let timed_out = task
            .state
            .get("submittedAt")
            .and_then(Value::as_str)
            .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
            .is_some_and(|submitted| {
                chrono::Utc::now()
                    .signed_duration_since(submitted.with_timezone(&chrono::Utc))
                    .num_milliseconds()
                    >= timeout_ms as i64
            });
        if timed_out {
            let timeout_minutes = timeout_ms as f64 / 60_000.0;
            store.commit_task_operation(
                task,
                json!({
                  "type": "apply_video_poll_result",
                  "threadId": task.state.get("threadId"),
                  "attemptId": task.state.get("attemptId"),
                  "jobId": task.provider_job_id,
                  "status": "failed",
                  "pollAttempt": poll_attempt,
                  "error": format!("Video generation did not reach a terminal state within {timeout_minutes:.1} minutes."),
                }),
            )?;
            return Ok(());
        }
        let credential_path = home.join("credentials.json");
        let credential: Value = fs::read(&credential_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .ok_or_else(|| CoreError {
                code: "CREDENTIAL_UNAVAILABLE",
                message: "OpenRouter credentials are unavailable.".into(),
            })?;
        let api_key = credential
            .get("openrouter_api_key")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| CoreError {
                code: "CREDENTIAL_UNAVAILABLE",
                message: "OpenRouter credentials are unavailable.".into(),
            })?;
        let base = std::env::var("FRUIT_TRUCK_OPENROUTER_BASE")
            .unwrap_or_else(|_| "https://openrouter.ai/api/v1".into());
        let response = client
            .get(format!("{base}/videos/{}", task.provider_job_id))
            .bearer_auth(api_key)
            .header("HTTP-Referer", "https://fruit-truck.local")
            .header("X-Title", "Fruit Truck Core")
            .send()
            .map_err(|error| CoreError {
                code: "PROVIDER_UNAVAILABLE",
                message: error.to_string(),
            })?;
        if !response.status().is_success() {
            return Err(CoreError {
                code: "PROVIDER_UNAVAILABLE",
                message: format!("OpenRouter returned HTTP {}.", response.status()),
            });
        }
        let body: Value = response.json().map_err(|error| CoreError {
            code: "PROVIDER_INVALID_RESPONSE",
            message: error.to_string(),
        })?;
        let remote_status = body
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("in_progress")
            .to_ascii_lowercase();
        let status = match remote_status.as_str() {
            "completed" | "succeeded" | "success" => "completed",
            "failed" | "error" | "expired" => "failed",
            "cancelled" | "canceled" => "canceled",
            _ => "in_progress",
        };
        let interval = std::env::var("FRUIT_TRUCK_VIDEO_POLL_INTERVAL_MS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(3_000)
            .clamp(500, 30_000);
        let next_poll_at =
            chrono_like_timestamp(std::time::SystemTime::now() + Duration::from_millis(interval));
        let mut operation = json!({
          "type": "apply_video_poll_result",
          "threadId": task.state.get("threadId"),
          "attemptId": task.state.get("attemptId"),
          "jobId": task.provider_job_id,
          "status": status,
          "pollAttempt": poll_attempt,
          "progress": body.get("progress"),
          "actualCostUsd": provider_cost(&body),
          "nextPollAt": next_poll_at,
        });
        if matches!(status, "failed" | "canceled") {
            operation["error"] = Value::String(
                body.get("error")
                    .and_then(Value::as_str)
                    .unwrap_or(if status == "canceled" {
                        "Video generation was canceled."
                    } else {
                        "Video generation failed."
                    })
                    .chars()
                    .take(2_000)
                    .collect(),
            );
        }
        let mut generated_path = None;
        if status == "completed" {
            let content = client
                .get(format!(
                    "{base}/videos/{}/content?index=0",
                    task.provider_job_id
                ))
                .bearer_auth(api_key)
                .header("HTTP-Referer", "https://fruit-truck.local")
                .header("X-Title", "Fruit Truck Core")
                .send()
                .map_err(|error| CoreError {
                    code: "PROVIDER_UNAVAILABLE",
                    message: error.to_string(),
                })?;
            if !content.status().is_success() {
                return Err(CoreError {
                    code: "PROVIDER_UNAVAILABLE",
                    message: format!(
                        "OpenRouter video content returned HTTP {}.",
                        content.status()
                    ),
                });
            }
            if content
                .content_length()
                .is_some_and(|bytes| bytes > MAX_GENERATED_VIDEO_BYTES)
            {
                return Err(CoreError {
                    code: "MEDIA_TOO_LARGE",
                    message: "Generated video exceeds 700 MB.".into(),
                });
            }
            let mime_type = content
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .unwrap_or("video/mp4")
                .to_string();
            let generated = home.join("generated");
            secure_directory(&generated).map_err(|message| CoreError {
                code: "MEDIA_WRITE_FAILED",
                message,
            })?;
            let asset_id = format!("asset-{}", uuid::Uuid::new_v4());
            let path = generated.join(format!(
                "agent-video-{}-{}.mp4",
                task.provider_job_id.replace(
                    |value: char| !value.is_ascii_alphanumeric() && value != '-' && value != '_',
                    "-"
                ),
                uuid::Uuid::new_v4()
            ));
            let write_result = (|| -> Result<u64, CoreError> {
                let mut file = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&path)
                    .map_err(|error| CoreError {
                        code: "MEDIA_WRITE_FAILED",
                        message: error.to_string(),
                    })?;
                file.set_permissions(fs::Permissions::from_mode(0o600))
                    .map_err(|error| CoreError {
                        code: "MEDIA_WRITE_FAILED",
                        message: error.to_string(),
                    })?;
                let mut limited = content.take(MAX_GENERATED_VIDEO_BYTES + 1);
                let copied = std::io::copy(&mut limited, &mut file).map_err(|error| CoreError {
                    code: "PROVIDER_UNAVAILABLE",
                    message: error.to_string(),
                })?;
                file.sync_all().map_err(|error| CoreError {
                    code: "MEDIA_WRITE_FAILED",
                    message: error.to_string(),
                })?;
                Ok(copied)
            })();
            let copied = match write_result {
                Ok(copied) if copied > 0 && copied <= MAX_GENERATED_VIDEO_BYTES => copied,
                Ok(_) => {
                    let _ = fs::remove_file(&path);
                    return Err(CoreError {
                        code: "MEDIA_TOO_LARGE",
                        message: "Generated video has an invalid size.".into(),
                    });
                }
                Err(error) => {
                    let _ = fs::remove_file(&path);
                    return Err(error);
                }
            };
            debug_assert!(copied <= MAX_GENERATED_VIDEO_BYTES);
            generated_path = Some(path.clone());
            operation["asset"] = json!({
              "id": asset_id,
              "name": format!("agent-video-{}.mp4", task.provider_job_id),
              "kind": "video",
              "mimeType": mime_type,
              "origin": "generated",
              "localPath": path.to_string_lossy(),
              "bridgeAvailability": "available",
              "jobId": task.provider_job_id,
              "generationBackend": "openrouter",
            });
        }
        if let Err(error) = store.commit_task_operation(task, operation) {
            if let Some(path) = generated_path {
                let _ = fs::remove_file(path);
            }
            return Err(error);
        }
        Ok(())
    }

    fn provider_cost(value: &Value) -> Option<f64> {
        value
            .get("cost")
            .and_then(Value::as_f64)
            .or_else(|| value.pointer("/usage/total_cost").and_then(Value::as_f64))
            .or_else(|| value.pointer("/usage/cost").and_then(Value::as_f64))
            .filter(|cost| cost.is_finite() && *cost >= 0.0)
    }

    fn chrono_like_timestamp(value: std::time::SystemTime) -> String {
        chrono::DateTime::<chrono::Utc>::from(value)
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    }

    fn read_legacy_envelope(home: &Path) -> Result<LegacyEnvelope, String> {
        let index_path = home.join("agent-sessions.json");
        let metadata = fs::metadata(&index_path).map_err(|error| error.to_string())?;
        if metadata.len() > 50 * 1024 * 1024 {
            return Err("Legacy session index exceeds the 50 MB recovery limit.".into());
        }
        let value: Value =
            serde_json::from_slice(&fs::read(index_path).map_err(|error| error.to_string())?)
                .map_err(|error| error.to_string())?;
        let schema_version = value
            .get("schemaVersion")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        if !(1..=4).contains(&schema_version) {
            return Err("Legacy session index uses an unsupported schema.".into());
        }
        let sessions = if let Some(sessions) = value.get("sessions").and_then(Value::as_array) {
            sessions.clone()
        } else {
            let entries = value
                .get("sessionFiles")
                .and_then(Value::as_array)
                .ok_or("Legacy session index has no session files.")?;
            let root = home.join("agent-sessions");
            let mut sessions = Vec::with_capacity(entries.len());
            for entry in entries {
                let id = entry
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or("Legacy session file entry has no ID.")?;
                let file = entry
                    .get("file")
                    .and_then(Value::as_str)
                    .ok_or("Legacy session file entry has no file.")?;
                if id.is_empty()
                    || id.len() > 128
                    || !id
                        .chars()
                        .all(|item| item.is_ascii_alphanumeric() || matches!(item, '-' | '_'))
                    || !file.ends_with(".json")
                    || !file
                        .chars()
                        .all(|item| item.is_ascii_alphanumeric() || matches!(item, '-' | '_' | '.'))
                {
                    return Err("Legacy session index contains an invalid file reference.".into());
                }
                let path = root.join(file);
                if fs::metadata(&path)
                    .map_err(|error| error.to_string())?
                    .len()
                    > 50 * 1024 * 1024
                {
                    return Err(format!("Legacy session {id} exceeds the 50 MB limit."));
                }
                let session: Value =
                    serde_json::from_slice(&fs::read(path).map_err(|error| error.to_string())?)
                        .map_err(|error| error.to_string())?;
                if session.get("id").and_then(Value::as_str) != Some(id) {
                    return Err(format!(
                        "Legacy session file for {id} contains a different ID."
                    ));
                }
                sessions.push(session);
            }
            sessions
        };
        Ok(LegacyEnvelope {
            schema_version,
            revision: value.get("revision").and_then(Value::as_u64).unwrap_or(0),
            sessions,
        })
    }

    fn secure_directory(path: &Path) -> Result<(), String> {
        fs::create_dir_all(path).map_err(|error| error.to_string())?;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|error| error.to_string())?;
        Ok(())
    }
}

fn main() {
    #[cfg(unix)]
    if let Err(error) = daemon::run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
