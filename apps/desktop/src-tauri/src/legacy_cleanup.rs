use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::Manager;

const REGISTRY_FILE: &str = "agent-integrations.json";
const MANAGED_MARKER: &str = ".fruit-truck-managed.json";
const COMPLETION_FILE: &str = "legacy-agent-cleanup-v1.json";
const SKILL_NAMES: [&str; 2] = ["fruit-truck-agent", "story-driven-short-form"];
const TARGETS: [&str; 3] = ["codex", "claude", "hermes"];
const REGISTRATION_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Registry {
    #[serde(default)]
    targets: BTreeMap<String, RegistryEntry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegistryEntry {
    #[serde(default)]
    cli_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Completion {
    schema_version: u8,
    completed_at: u64,
}

fn skill_root(home: &Path, target: &str) -> Option<PathBuf> {
    match target {
        "codex" => Some(home.join(".agents/skills")),
        "claude" => Some(home.join(".claude/skills")),
        "hermes" => Some(home.join(".hermes/skills")),
        _ => None,
    }
}

fn unix_timestamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or_default()
}

fn directory_modified_after_marker(directory: &Path, marker: &Path) -> Result<bool, String> {
    let marker_time = marker
        .metadata()
        .and_then(|metadata| metadata.modified())
        .map_err(|error| error.to_string())?;
    let mut pending = vec![directory.to_path_buf()];
    while let Some(current) = pending.pop() {
        if current
            .metadata()
            .and_then(|metadata| metadata.modified())
            .is_ok_and(|modified| modified > marker_time)
        {
            return Ok(true);
        }
        for entry in std::fs::read_dir(&current).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let path = entry.path();
            if path == marker {
                continue;
            }
            let file_type = entry.file_type().map_err(|error| error.to_string())?;
            if file_type.is_dir() {
                pending.push(path);
            } else if file_type.is_file()
                && entry
                    .metadata()
                    .and_then(|metadata| metadata.modified())
                    .is_ok_and(|modified| modified > marker_time)
            {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

fn is_executable(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        path.metadata()
            .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    true
}

fn executable_candidates(target: &str, home: &Path) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path).map(|directory| directory.join(target)));
    }
    candidates.extend([
        home.join(".local/bin").join(target),
        home.join(".npm-global/bin").join(target),
        home.join(".bun/bin").join(target),
        home.join(".cargo/bin").join(target),
        home.join(".volta/bin").join(target),
        home.join(".asdf/shims").join(target),
        home.join(".local/share/mise/shims").join(target),
        PathBuf::from("/opt/homebrew/bin").join(target),
        PathBuf::from("/usr/local/bin").join(target),
        PathBuf::from("/usr/bin").join(target),
    ]);
    for versions_root in [
        home.join(".nvm/versions/node"),
        home.join(".local/share/fnm/node-versions"),
    ] {
        if let Ok(entries) = std::fs::read_dir(versions_root) {
            for entry in entries.flatten() {
                candidates.push(entry.path().join("bin").join(target));
                candidates.push(entry.path().join("installation/bin").join(target));
            }
        }
    }
    match target {
        "codex" => candidates.extend([
            PathBuf::from("/Applications/ChatGPT.app/Contents/Resources/codex"),
            PathBuf::from("/Applications/Codex.app/Contents/Resources/codex"),
        ]),
        "claude" => candidates.push(PathBuf::from(
            "/Applications/Claude Code.app/Contents/MacOS/claude",
        )),
        _ => {}
    }
    candidates
}

fn find_cli(target: &str, home: &Path) -> Option<PathBuf> {
    executable_candidates(target, home)
        .into_iter()
        .find(|candidate| is_executable(candidate))
        .map(|candidate| candidate.canonicalize().unwrap_or(candidate))
}

fn inactive_path(root: &Path, target: &str, name: &str) -> PathBuf {
    let base = root.join("legacy-disabled").join(target);
    for suffix in 0u32.. {
        let candidate = base.join(if suffix == 0 {
            name.to_string()
        } else {
            format!("{name}-{suffix}")
        });
        if !candidate.exists() {
            return candidate;
        }
    }
    unreachable!("legacy backup suffix space exhausted")
}

fn cleanup_skill(home: &Path, root: &Path, target: &str, name: &str) -> Result<(), String> {
    let Some(skills) = skill_root(home, target) else {
        return Ok(());
    };
    let installed = skills.join(name);
    let marker = installed.join(MANAGED_MARKER);
    if marker.is_file() {
        if directory_modified_after_marker(&installed, &marker)? {
            let inactive = inactive_path(root, target, name);
            std::fs::create_dir_all(inactive.parent().expect("inactive path has parent"))
                .map_err(|error| error.to_string())?;
            std::fs::rename(&installed, inactive).map_err(|error| error.to_string())?;
        } else {
            std::fs::remove_dir_all(&installed).map_err(|error| error.to_string())?;
        }
    }

    let backup = root.join("agent-backups").join(target).join(name);
    if backup.exists() && !installed.exists() {
        std::fs::create_dir_all(&skills).map_err(|error| error.to_string())?;
        std::fs::rename(backup, installed).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn bounded_stderr(mut stderr: impl Read) -> Vec<u8> {
    const LIMIT: usize = 4_000;
    let mut tail = Vec::new();
    let mut chunk = [0u8; 1_024];
    while let Ok(count) = stderr.read(&mut chunk) {
        if count == 0 {
            break;
        }
        tail.extend_from_slice(&chunk[..count]);
        if tail.len() > LIMIT {
            tail.drain(..tail.len() - LIMIT);
        }
    }
    tail
}

fn remove_registration_with_timeout(cli: &Path, timeout: Duration) -> Result<(), String> {
    if !is_executable(cli) {
        return Err(format!(
            "legacy registration CLI is unavailable: {}",
            cli.display()
        ));
    }
    let mut child = Command::new(cli)
        .args(["mcp", "remove", "fruit-truck"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| error.to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "legacy registration stderr was unavailable".to_string())?;
    let stderr_reader = std::thread::spawn(move || bounded_stderr(stderr));
    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stderr_reader.join();
            return Err("legacy registration removal timed out".into());
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    let stderr = stderr_reader.join().unwrap_or_default();
    if status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&stderr).to_ascii_lowercase();
    if stderr.contains("not found")
        || stderr.contains("does not exist")
        || stderr.contains("no mcp server")
        || stderr.contains("no server")
        || stderr.contains("not configured")
    {
        Ok(())
    } else {
        Err("legacy registration removal failed".into())
    }
}

fn remove_registration(cli: &Path) -> Result<(), String> {
    remove_registration_with_timeout(cli, REGISTRATION_TIMEOUT)
}

fn managed_daemon_command(root: &Path, command: &str) -> bool {
    command.contains(&root.join("bin/fruit-truckd").to_string_lossy().to_string())
        || (command.contains("/Fruit Truck.app/Contents/MacOS/")
            && command.contains("fruit-truckd"))
}

fn stop_managed_daemon(root: &Path) -> Result<(), String> {
    let lock = root.join("run/core.lock");
    if !lock.is_file() {
        return Ok(());
    }
    let pid = std::fs::read_to_string(&lock)
        .map_err(|error| error.to_string())?
        .trim()
        .parse::<u32>()
        .map_err(|_| "legacy daemon lock is invalid".to_string())?;
    if pid < 2 {
        return Err("legacy daemon pid is invalid".into());
    }
    let output = Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "command="])
        .output()
        .map_err(|error| error.to_string())?;
    let command = String::from_utf8_lossy(&output.stdout);
    if !output.status.success() {
        return Ok(());
    }
    let verified = managed_daemon_command(root, &command);
    if !verified {
        return Err("active legacy daemon could not be verified as Fruit Truck managed".into());
    }
    let status = Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| error.to_string())?;
    if !status.success() {
        return Err("legacy daemon could not be stopped".into());
    }
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    while std::time::Instant::now() < deadline {
        let running = Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success());
        if !running {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    Err("legacy daemon did not stop in time".into())
}

fn cleanup_at(home: &Path, root: &Path, remove_registrations: bool) -> Result<(), String> {
    if root.join(COMPLETION_FILE).is_file() {
        return Ok(());
    }
    let registry_path = root.join(REGISTRY_FILE);
    let registry: Registry = if registry_path.is_file() {
        serde_json::from_slice(&std::fs::read(&registry_path).map_err(|error| error.to_string())?)
            .unwrap_or_default()
    } else {
        Registry::default()
    };
    let mut targets = registry.targets.keys().cloned().collect::<BTreeSet<_>>();
    let mut registration_targets = targets.clone();
    let mut has_managed_installation = registry_path.is_file();
    for target in TARGETS {
        let marker_exists = SKILL_NAMES.iter().any(|name| {
            skill_root(home, target)
                .is_some_and(|skills| skills.join(name).join(MANAGED_MARKER).is_file())
        });
        let backup_exists = SKILL_NAMES
            .iter()
            .any(|name| root.join("agent-backups").join(target).join(name).exists());
        if marker_exists || backup_exists {
            targets.insert(target.to_string());
            has_managed_installation = true;
        }
        if marker_exists {
            registration_targets.insert(target.to_string());
        }
    }
    let runtime = root.join("agent-runtime");
    let root_artifacts = [
        root.join("bin/fruit-truck"),
        root.join("bin/fruit-truckd"),
        root.join("run/core.sock"),
        root.join("run/core.lock"),
        runtime.clone(),
    ];
    if root_artifacts.iter().any(|path| path.exists()) {
        has_managed_installation = true;
    }
    if !has_managed_installation {
        return Ok(());
    }
    if targets.is_empty() {
        targets.extend(TARGETS.into_iter().map(str::to_string));
    }

    for target in &targets {
        if remove_registrations {
            let recorded = registry
                .targets
                .get(target)
                .map(|entry| PathBuf::from(&entry.cli_path))
                .filter(|path| is_executable(path));
            let cli = recorded.or_else(|| find_cli(target, home));
            if let Some(cli) = cli {
                remove_registration(&cli)?;
            } else if registration_targets.contains(target) {
                return Err(format!(
                    "legacy {target} registration could not be removed because its CLI is unavailable"
                ));
            }
        }
        for name in SKILL_NAMES {
            cleanup_skill(home, root, target, name)?;
        }
    }
    stop_managed_daemon(root)?;
    for path in [root.join("bin/fruit-truck"), root.join("bin/fruit-truckd")] {
        if path.is_file() {
            std::fs::remove_file(path).map_err(|error| error.to_string())?;
        }
    }
    if runtime.exists() {
        std::fs::remove_dir_all(runtime).map_err(|error| error.to_string())?;
    }
    for path in [
        root.join("run/core.sock"),
        root.join("run/core.lock"),
        registry_path,
    ] {
        if path.exists() {
            std::fs::remove_file(path).map_err(|error| error.to_string())?;
        }
    }
    std::fs::create_dir_all(root).map_err(|error| error.to_string())?;
    let completion = Completion {
        schema_version: 1,
        completed_at: unix_timestamp(),
    };
    std::fs::write(
        root.join(COMPLETION_FILE),
        serde_json::to_vec(&completion).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

pub fn cleanup_legacy_installations(app: &tauri::AppHandle) -> Result<(), String> {
    let home = app.path().home_dir().map_err(|error| error.to_string())?;
    let root = std::env::var_os("FRUIT_TRUCK_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".fruit-truck"));
    if !root.is_absolute() {
        return Err("FRUIT_TRUCK_HOME must be an absolute path".into());
    }
    cleanup_at(&home, &root, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> (PathBuf, PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "fruit-truck-cleanup-{name}-{}-{}",
            std::process::id(),
            unix_timestamp(),
        ));
        let home = root.join("home");
        let data = root.join("data");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&data).unwrap();
        (root, home, data)
    }

    fn registry(data: &Path) {
        std::fs::write(
            data.join(REGISTRY_FILE),
            br#"{"targets":{"codex":{"cliPath":""}}}"#,
        )
        .unwrap();
    }

    #[cfg(unix)]
    fn executable(path: &Path, contents: &str) {
        use std::os::unix::fs::PermissionsExt;

        std::fs::write(path, contents).unwrap();
        let mut permissions = path.metadata().unwrap().permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(path, permissions).unwrap();
    }

    #[test]
    fn removes_only_marked_skills_and_restores_user_backup() {
        let (fixture, home, data) = fixture("managed");
        registry(&data);
        let skills = home.join(".agents/skills");
        let managed = skills.join("fruit-truck-agent");
        let unmarked = skills.join("story-driven-short-form");
        let backup = data.join("agent-backups/codex/fruit-truck-agent");
        std::fs::create_dir_all(&managed).unwrap();
        std::fs::write(managed.join("SKILL.md"), "managed").unwrap();
        std::fs::write(managed.join(MANAGED_MARKER), "{}").unwrap();
        std::fs::create_dir_all(&unmarked).unwrap();
        std::fs::write(unmarked.join("SKILL.md"), "user owned").unwrap();
        std::fs::create_dir_all(&backup).unwrap();
        std::fs::write(backup.join("SKILL.md"), "original").unwrap();

        cleanup_at(&home, &data, false).unwrap();

        assert_eq!(
            std::fs::read_to_string(managed.join("SKILL.md")).unwrap(),
            "original"
        );
        assert_eq!(
            std::fs::read_to_string(unmarked.join("SKILL.md")).unwrap(),
            "user owned"
        );
        assert!(data.join(COMPLETION_FILE).is_file());
        std::fs::remove_dir_all(fixture).unwrap();
    }

    #[test]
    fn moves_a_modified_managed_skill_to_inactive_storage() {
        let (fixture, home, data) = fixture("modified");
        registry(&data);
        let managed = home.join(".agents/skills/fruit-truck-agent");
        std::fs::create_dir_all(&managed).unwrap();
        std::fs::write(managed.join(MANAGED_MARKER), "{}").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(10));
        std::fs::write(managed.join("SKILL.md"), "user edit").unwrap();

        cleanup_at(&home, &data, false).unwrap();

        assert!(!managed.exists());
        assert_eq!(
            std::fs::read_to_string(data.join("legacy-disabled/codex/fruit-truck-agent/SKILL.md"))
                .unwrap(),
            "user edit",
        );
        std::fs::remove_dir_all(fixture).unwrap();
    }

    #[test]
    fn treats_deleted_managed_files_as_user_modifications() {
        let (fixture, home, data) = fixture("deleted-file");
        registry(&data);
        let managed = home.join(".agents/skills/fruit-truck-agent");
        std::fs::create_dir_all(&managed).unwrap();
        let skill = managed.join("SKILL.md");
        std::fs::write(&skill, "managed").unwrap();
        std::fs::write(managed.join(MANAGED_MARKER), "{}").unwrap();
        std::thread::sleep(Duration::from_millis(10));
        std::fs::remove_file(skill).unwrap();

        cleanup_at(&home, &data, false).unwrap();

        assert!(!managed.exists());
        assert!(data
            .join("legacy-disabled/codex/fruit-truck-agent")
            .is_dir());
        std::fs::remove_dir_all(fixture).unwrap();
    }

    #[test]
    fn marker_fallback_cleans_a_partial_install_without_a_registry() {
        let (fixture, home, data) = fixture("marker-fallback");
        let managed = home.join(".agents/skills/fruit-truck-agent");
        std::fs::create_dir_all(&managed).unwrap();
        std::fs::write(managed.join("SKILL.md"), "managed").unwrap();
        std::fs::write(managed.join(MANAGED_MARKER), "{}").unwrap();
        std::fs::create_dir_all(data.join("agent-runtime/2.1.0")).unwrap();
        std::fs::write(data.join("agent-runtime/2.1.0/node"), "managed").unwrap();
        std::fs::create_dir_all(data.join("bin")).unwrap();
        std::fs::write(data.join("bin/fruit-truck"), "managed").unwrap();

        cleanup_at(&home, &data, false).unwrap();

        assert!(!managed.exists());
        assert!(!data.join("agent-runtime").exists());
        assert!(!data.join("bin/fruit-truck").exists());
        assert!(data.join(COMPLETION_FILE).is_file());
        std::fs::remove_dir_all(fixture).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn registration_removal_times_out() {
        let (fixture, _home, data) = fixture("registration-timeout");
        let cli = data.join("codex");
        executable(&cli, "#!/bin/sh\nwhile :; do :; done\n");
        let started = Instant::now();

        let error = remove_registration_with_timeout(&cli, Duration::from_millis(50)).unwrap_err();

        assert!(error.contains("timed out"));
        assert!(started.elapsed() < Duration::from_secs(1));
        std::fs::remove_dir_all(fixture).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn failed_cleanup_is_retried_before_writing_completion() {
        let (fixture, home, data) = fixture("retry");
        let cli = data.join("codex");
        executable(
            &cli,
            "#!/bin/sh\nprintf 'permission denied\\n' >&2\nexit 3\n",
        );
        std::fs::write(
            data.join(REGISTRY_FILE),
            serde_json::to_vec(&serde_json::json!({
                "targets": { "codex": { "cliPath": cli } }
            }))
            .unwrap(),
        )
        .unwrap();
        let managed = home.join(".agents/skills/fruit-truck-agent");
        std::fs::create_dir_all(&managed).unwrap();
        std::fs::write(managed.join("SKILL.md"), "managed").unwrap();
        std::fs::write(managed.join(MANAGED_MARKER), "{}").unwrap();

        assert!(cleanup_at(&home, &data, true).is_err());
        assert!(managed.exists());
        assert!(!data.join(COMPLETION_FILE).exists());

        executable(&cli, "#!/bin/sh\nexit 0\n");
        cleanup_at(&home, &data, true).unwrap();
        assert!(!managed.exists());
        assert!(data.join(COMPLETION_FILE).is_file());
        std::fs::remove_dir_all(fixture).unwrap();
    }

    #[test]
    fn daemon_verification_rejects_unrelated_processes() {
        let root = Path::new("/tmp/fruit-truck-owned");
        assert!(managed_daemon_command(
            root,
            "/tmp/fruit-truck-owned/bin/fruit-truckd --serve"
        ));
        assert!(managed_daemon_command(
            root,
            "/Applications/Fruit Truck.app/Contents/MacOS/fruit-truckd"
        ));
        assert!(!managed_daemon_command(root, "/usr/local/bin/fruit-truckd"));
        assert!(!managed_daemon_command(root, "/usr/bin/sleep 100"));
    }
}
