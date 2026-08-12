use std::collections::BTreeMap;
use std::ffi::OsString;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::Manager;

const AGENT_KIT_VERSION: &str = "2.1.0";
const INTEGRATIONS_FILE: &str = "agent-integrations.json";
const MANAGED_MARKER: &str = ".fruit-truck-managed.json";
static INTEGRATION_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentIntegrationTarget {
    Codex,
    Claude,
    Hermes,
}

impl AgentIntegrationTarget {
    fn id(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Claude => "claude",
            Self::Hermes => "hermes",
        }
    }

    fn display_name(self) -> &'static str {
        match self {
            Self::Codex => "Codex",
            Self::Claude => "Claude Code",
            Self::Hermes => "Hermes",
        }
    }

    fn skills_directory(self, home: &Path) -> PathBuf {
        match self {
            Self::Codex => home.join(".agents/skills"),
            Self::Claude => home.join(".claude/skills"),
            Self::Hermes => home.join(".hermes/skills"),
        }
    }

    fn all() -> [Self; 3] {
        [Self::Codex, Self::Claude, Self::Hermes]
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct IntegrationRecord {
    version: String,
    cli_path: String,
    installed_at: u64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct IntegrationRegistry {
    schema_version: u8,
    targets: BTreeMap<String, IntegrationRecord>,
}

impl Default for IntegrationRegistry {
    fn default() -> Self {
        Self {
            schema_version: 1,
            targets: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentIntegrationStatus {
    target: AgentIntegrationTarget,
    display_name: &'static str,
    cli_available: bool,
    connected: bool,
    needs_update: bool,
    version: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentIntegrationResult {
    status: AgentIntegrationStatus,
    restart_required: bool,
}

fn unix_timestamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or_default()
}

fn integration_version() -> String {
    format!(
        "desktop-{}/agent-kit-{AGENT_KIT_VERSION}",
        env!("CARGO_PKG_VERSION")
    )
}

fn private_directory(path: &Path) -> Result<(), String> {
    std::fs::create_dir_all(path).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn set_executable(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn write_private_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Invalid integration path.".to_string())?;
    private_directory(parent)?;
    let temporary = parent.join(format!(".agent-integrations-{}.tmp", std::process::id()));
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    std::fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600))
            .map_err(|error| error.to_string())?;
    }
    std::fs::rename(temporary, path).map_err(|error| error.to_string())
}

fn read_registry(root: &Path) -> Result<IntegrationRegistry, String> {
    let path = root.join(INTEGRATIONS_FILE);
    if !path.exists() {
        return Ok(IntegrationRegistry::default());
    }
    let raw = std::fs::read_to_string(path).map_err(|error| error.to_string())?;
    let registry: IntegrationRegistry = serde_json::from_str(&raw)
        .map_err(|_| "The agent connection registry is invalid.".to_string())?;
    if registry.schema_version != 1 {
        return Err("The agent connection registry version is unsupported.".into());
    }
    Ok(registry)
}

fn copy_tree(source: &Path, destination: &Path) -> Result<(), String> {
    if !source.is_dir() {
        return Err(format!(
            "Bundled directory is unavailable: {}",
            source.display()
        ));
    }
    private_directory(destination)?;
    for entry in std::fs::read_dir(source).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        if entry
            .file_type()
            .map_err(|error| error.to_string())?
            .is_dir()
        {
            copy_tree(&source_path, &destination_path)?;
        } else {
            std::fs::copy(&source_path, &destination_path)
                .map_err(|error| format!("Could not copy {}: {error}", source_path.display()))?;
        }
    }
    Ok(())
}

fn executable_candidates(target: AgentIntegrationTarget, home: &Path) -> Vec<PathBuf> {
    let name = target.id();
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path).map(|directory| directory.join(name)));
    }
    candidates.extend([
        home.join(".local/bin").join(name),
        home.join(".npm-global/bin").join(name),
        home.join(".bun/bin").join(name),
        home.join(".cargo/bin").join(name),
        home.join(".volta/bin").join(name),
        home.join(".asdf/shims").join(name),
        home.join(".local/share/mise/shims").join(name),
        PathBuf::from("/opt/homebrew/bin").join(name),
        PathBuf::from("/usr/local/bin").join(name),
        PathBuf::from("/usr/bin").join(name),
    ]);
    for versions_root in [
        home.join(".nvm/versions/node"),
        home.join(".local/share/fnm/node-versions"),
    ] {
        if let Ok(entries) = std::fs::read_dir(versions_root) {
            for entry in entries.flatten() {
                candidates.push(entry.path().join("bin").join(name));
                candidates.push(entry.path().join("installation/bin").join(name));
            }
        }
    }
    match target {
        AgentIntegrationTarget::Codex => candidates.extend([
            PathBuf::from("/Applications/ChatGPT.app/Contents/Resources/codex"),
            PathBuf::from("/Applications/Codex.app/Contents/Resources/codex"),
        ]),
        AgentIntegrationTarget::Claude => candidates.extend([PathBuf::from(
            "/Applications/Claude Code.app/Contents/MacOS/claude",
        )]),
        AgentIntegrationTarget::Hermes => {}
    }
    candidates
}

fn find_agent_cli(target: AgentIntegrationTarget, home: &Path) -> Option<PathBuf> {
    executable_candidates(target, home)
        .into_iter()
        .find(|candidate| is_executable(candidate))
        .map(|candidate| candidate.canonicalize().unwrap_or(candidate))
}

fn find_agent_cli_with_record(
    target: AgentIntegrationTarget,
    home: &Path,
    registry: &IntegrationRegistry,
) -> Option<PathBuf> {
    find_agent_cli(target, home).or_else(|| {
        registry
            .targets
            .get(target.id())
            .map(|record| PathBuf::from(&record.cli_path))
            .filter(|path| is_executable(path))
    })
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

fn runtime_directory(root: &Path) -> PathBuf {
    root.join("agent-runtime").join(AGENT_KIT_VERSION)
}

fn installed_runtime_valid(root: &Path) -> bool {
    let runtime = runtime_directory(root);
    runtime.join("node").is_file()
        && runtime
            .join("agent-kit/dist/scripts/mcp-server.js")
            .is_file()
        && root.join("bin/fruit-truckd").is_file()
}

fn managed_skills_valid(target: AgentIntegrationTarget, home: &Path) -> bool {
    ["fruit-truck-agent", "story-driven-short-form"]
        .iter()
        .all(|name| {
            target
                .skills_directory(home)
                .join(name)
                .join(MANAGED_MARKER)
                .is_file()
        })
}

fn status_for(
    target: AgentIntegrationTarget,
    home: &Path,
    root: &Path,
    registry: &IntegrationRegistry,
) -> AgentIntegrationStatus {
    let record = registry.targets.get(target.id());
    let cli = find_agent_cli_with_record(target, home, registry);
    let connected =
        record.is_some() && installed_runtime_valid(root) && managed_skills_valid(target, home);
    AgentIntegrationStatus {
        target,
        display_name: target.display_name(),
        cli_available: cli.is_some(),
        connected,
        needs_update: connected
            && record.is_some_and(|value| value.version != integration_version()),
        version: record.map(|value| value.version.clone()),
    }
}

fn bounded_output(bytes: &[u8]) -> String {
    const LIMIT: usize = 4_000;
    let start = bytes.len().saturating_sub(LIMIT);
    String::from_utf8_lossy(&bytes[start..]).trim().to_string()
}

fn run_agent_cli(
    path: &Path,
    arguments: &[OsString],
    input: Option<&str>,
) -> Result<String, String> {
    let mut command = Command::new(path);
    if let Some(parent) = path.parent() {
        let mut search_path = vec![parent.to_path_buf()];
        if let Some(current) = std::env::var_os("PATH") {
            search_path.extend(std::env::split_paths(&current));
        }
        if let Ok(value) = std::env::join_paths(search_path) {
            command.env("PATH", value);
        }
    }
    let mut child = command
        .args(arguments)
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Could not start {}: {error}", path.display()))?;
    if let (Some(stdin), Some(input)) = (child.stdin.as_mut(), input) {
        stdin
            .write_all(input.as_bytes())
            .map_err(|error| error.to_string())?;
    }
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        match child.try_wait().map_err(|error| error.to_string())? {
            Some(_) => break,
            None if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            None => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(
                    "The agent did not finish updating its connection within 30 seconds."
                        .to_string(),
                );
            }
        }
    }
    let output = child
        .wait_with_output()
        .map_err(|error| error.to_string())?;
    let stdout = bounded_output(&output.stdout);
    let stderr = bounded_output(&output.stderr);
    if !output.status.success() {
        return Err(if stderr.is_empty() { stdout } else { stderr });
    }
    Ok(if stdout.is_empty() { stderr } else { stdout })
}

fn remove_mcp_registration(target: AgentIntegrationTarget, cli: &Path) {
    let arguments = remove_mcp_arguments(target);
    let _ = run_agent_cli(cli, &arguments, None);
}

fn missing_registration_error(error: &str) -> bool {
    let normalized = error.to_ascii_lowercase();
    [
        "not found",
        "does not exist",
        "no server",
        "no mcp server",
        "not configured",
    ]
    .iter()
    .any(|needle| normalized.contains(needle))
}

fn remove_mcp_arguments(_target: AgentIntegrationTarget) -> Vec<OsString> {
    vec![
        OsString::from("mcp"),
        OsString::from("remove"),
        OsString::from("fruit-truck"),
    ]
}

fn add_mcp_arguments(target: AgentIntegrationTarget, node: &Path, server: &Path) -> Vec<OsString> {
    let shared = [
        server.as_os_str().to_os_string(),
        OsString::from("--agent-host"),
        OsString::from(target.id()),
        OsString::from("--tool-profile"),
        OsString::from("fast"),
        OsString::from("--core-mode"),
        OsString::from("canonical"),
    ];
    match target {
        AgentIntegrationTarget::Codex => {
            let mut values = vec![
                OsString::from("mcp"),
                OsString::from("add"),
                OsString::from("fruit-truck"),
                OsString::from("--"),
                node.as_os_str().to_os_string(),
            ];
            values.extend(shared);
            values
        }
        AgentIntegrationTarget::Claude => {
            let mut values = vec![
                OsString::from("mcp"),
                OsString::from("add"),
                OsString::from("--transport"),
                OsString::from("stdio"),
                OsString::from("--scope"),
                OsString::from("user"),
                OsString::from("fruit-truck"),
                OsString::from("--"),
                node.as_os_str().to_os_string(),
            ];
            values.extend(shared);
            values
        }
        AgentIntegrationTarget::Hermes => {
            let mut values = vec![
                OsString::from("mcp"),
                OsString::from("add"),
                OsString::from("--connect-timeout"),
                OsString::from("10"),
                OsString::from("fruit-truck"),
                OsString::from("--command"),
                node.as_os_str().to_os_string(),
                OsString::from("--args"),
            ];
            values.extend(shared);
            values
        }
    }
}

fn add_mcp_registration(
    target: AgentIntegrationTarget,
    cli: &Path,
    node: &Path,
    server: &Path,
) -> Result<(), String> {
    let arguments = add_mcp_arguments(target, node, server);
    run_agent_cli(
        cli,
        &arguments,
        matches!(target, AgentIntegrationTarget::Hermes).then_some("y\n\n"),
    )?;
    Ok(())
}

fn install_runtime(app: &tauri::AppHandle, root: &Path) -> Result<(PathBuf, PathBuf), String> {
    let source = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?
        .join("agent-runtime");
    let bundled_node = bundled_node_path(&source)?;
    let bundled_core = std::env::current_exe()
        .map_err(|error| error.to_string())?
        .parent()
        .map(|directory| directory.join("fruit-truckd"))
        .filter(|path| is_executable(path))
        .ok_or_else(|| "This Fruit Truck build is missing its Core helper.".to_string())?;
    for required in [
        bundled_node.clone(),
        source.join("agent-kit/dist/scripts/mcp-server.js"),
        source.join("agent-kit/skills/fruit-truck-agent/SKILL.md"),
        source.join("agent-kit/skills/story-driven-short-form/SKILL.md"),
    ] {
        if !required.exists() {
            return Err(format!(
                "This Fruit Truck build is missing {}.",
                required.display()
            ));
        }
    }

    let runtime = runtime_directory(root);
    let runtime_parent = runtime
        .parent()
        .ok_or_else(|| "Invalid agent runtime path.".to_string())?;
    private_directory(runtime_parent)?;
    let staged_runtime = runtime_parent.join(format!(".runtime-{}.tmp", std::process::id()));
    if staged_runtime.exists() {
        std::fs::remove_dir_all(&staged_runtime).map_err(|error| error.to_string())?;
    }
    private_directory(&staged_runtime)?;
    std::fs::copy(&bundled_node, staged_runtime.join("node")).map_err(|error| error.to_string())?;
    set_executable(&staged_runtime.join("node"))?;
    copy_tree(&source.join("agent-kit"), &staged_runtime.join("agent-kit"))?;
    let backup_runtime = runtime_parent.join(format!(".runtime-{}.backup", std::process::id()));
    if backup_runtime.exists() {
        std::fs::remove_dir_all(&backup_runtime).map_err(|error| error.to_string())?;
    }
    if runtime.exists() {
        std::fs::rename(&runtime, &backup_runtime).map_err(|error| error.to_string())?;
    }
    if let Err(error) = std::fs::rename(&staged_runtime, &runtime) {
        if backup_runtime.exists() {
            let _ = std::fs::rename(&backup_runtime, &runtime);
        }
        return Err(error.to_string());
    }
    if backup_runtime.exists() {
        std::fs::remove_dir_all(backup_runtime).map_err(|error| error.to_string())?;
    }
    let bin = root.join("bin");
    private_directory(&bin)?;
    let temporary_core = bin.join(format!(".fruit-truckd-{}.tmp", std::process::id()));
    std::fs::copy(bundled_core, &temporary_core).map_err(|error| error.to_string())?;
    set_executable(&temporary_core)?;
    std::fs::rename(temporary_core, bin.join("fruit-truckd")).map_err(|error| error.to_string())?;
    Ok((
        runtime.join("node"),
        runtime.join("agent-kit/dist/scripts/mcp-server.js"),
    ))
}

fn bundled_node_path(source: &Path) -> Result<PathBuf, String> {
    let thin = source.join("node");
    if thin.is_file() {
        return Ok(thin);
    }
    let architecture = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        value => return Err(format!("Unsupported Mac architecture: {value}")),
    };
    let path = source.join(format!("node-{architecture}"));
    path.is_file()
        .then_some(path)
        .ok_or_else(|| "This Fruit Truck build is missing its Node.js runtime.".to_string())
}

fn install_skills(
    app: &tauri::AppHandle,
    target: AgentIntegrationTarget,
    home: &Path,
    fruit_root: &Path,
) -> Result<(), String> {
    let source = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?
        .join("agent-runtime/agent-kit/skills");
    let skills_root = target.skills_directory(home);
    let backup_root = fruit_root.join("agent-backups").join(target.id());
    private_directory(&skills_root)?;
    for name in ["fruit-truck-agent", "story-driven-short-form"] {
        let destination = skills_root.join(name);
        let backup = backup_root.join(name);
        if destination.exists() && !destination.join(MANAGED_MARKER).is_file() && backup.exists() {
            return Err(format!(
                "The existing {name} workflow was changed after Fruit Truck connected it."
            ));
        }
    }
    for name in ["fruit-truck-agent", "story-driven-short-form"] {
        let destination = skills_root.join(name);
        let backup = backup_root.join(name);
        let staged = skills_root.join(format!(".fruit-truck-{name}-{}.tmp", std::process::id()));
        if staged.exists() {
            std::fs::remove_dir_all(&staged).map_err(|error| error.to_string())?;
        }
        copy_tree(&source.join(name), &staged)?;
        write_private_json(
            &staged.join(MANAGED_MARKER),
            &serde_json::json!({ "version": integration_version(), "target": target.id() }),
        )?;
        let mut backed_up_original = false;
        if destination.exists() {
            if destination.join(MANAGED_MARKER).is_file() {
                std::fs::remove_dir_all(&destination).map_err(|error| error.to_string())?;
            } else {
                private_directory(&backup_root)?;
                std::fs::rename(&destination, &backup).map_err(|error| error.to_string())?;
                backed_up_original = true;
            }
        }
        if let Err(error) = std::fs::rename(&staged, &destination) {
            if backed_up_original && !destination.exists() {
                let _ = std::fs::rename(&backup, &destination);
            }
            return Err(error.to_string());
        }
    }
    Ok(())
}

fn remove_managed_skills(
    target: AgentIntegrationTarget,
    home: &Path,
    fruit_root: &Path,
) -> Result<(), String> {
    let backup_root = fruit_root.join("agent-backups").join(target.id());
    for name in ["fruit-truck-agent", "story-driven-short-form"] {
        let directory = target.skills_directory(home).join(name);
        if directory.join(MANAGED_MARKER).is_file() {
            std::fs::remove_dir_all(&directory).map_err(|error| error.to_string())?;
        }
        let backup = backup_root.join(name);
        if backup.exists() && !directory.exists() {
            std::fs::rename(backup, directory).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn app_paths(app: &tauri::AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let home = app.path().home_dir().map_err(|error| error.to_string())?;
    let root = std::env::var_os("FRUIT_TRUCK_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".fruit-truck"));
    if !root.is_absolute() {
        return Err("FRUIT_TRUCK_HOME must be an absolute path.".into());
    }
    Ok((home, root))
}

#[tauri::command]
pub fn agent_integration_status(
    app: tauri::AppHandle,
) -> Result<Vec<AgentIntegrationStatus>, String> {
    let (home, root) = app_paths(&app)?;
    let registry = read_registry(&root)?;
    Ok(AgentIntegrationTarget::all()
        .into_iter()
        .map(|target| status_for(target, &home, &root, &registry))
        .collect())
}

#[tauri::command]
pub fn install_agent_integration(
    app: tauri::AppHandle,
    target: AgentIntegrationTarget,
) -> Result<AgentIntegrationResult, String> {
    let _guard = INTEGRATION_LOCK
        .lock()
        .map_err(|_| "The agent connection manager is unavailable.".to_string())?;
    let (home, root) = app_paths(&app)?;
    let mut registry = read_registry(&root)?;
    let cli = find_agent_cli_with_record(target, &home, &registry).ok_or_else(|| {
        format!(
            "{} is not installed or could not be found.",
            target.display_name()
        )
    })?;
    private_directory(&root)?;
    let (node, server) = install_runtime(&app, &root)?;
    install_skills(&app, target, &home, &root)?;
    remove_mcp_registration(target, &cli);
    if let Err(error) = add_mcp_registration(target, &cli, &node, &server) {
        return Err(format!(
            "Could not connect {}: {error}",
            target.display_name()
        ));
    }

    registry.targets.insert(
        target.id().to_string(),
        IntegrationRecord {
            version: integration_version(),
            cli_path: cli.to_string_lossy().into_owned(),
            installed_at: unix_timestamp(),
        },
    );
    write_private_json(&root.join(INTEGRATIONS_FILE), &registry)?;
    Ok(AgentIntegrationResult {
        status: status_for(target, &home, &root, &registry),
        restart_required: true,
    })
}

#[tauri::command]
pub fn remove_agent_integration(
    app: tauri::AppHandle,
    target: AgentIntegrationTarget,
) -> Result<AgentIntegrationResult, String> {
    let _guard = INTEGRATION_LOCK
        .lock()
        .map_err(|_| "The agent connection manager is unavailable.".to_string())?;
    let (home, root) = app_paths(&app)?;
    let mut registry = read_registry(&root)?;
    let cli = find_agent_cli_with_record(target, &home, &registry);
    if let Some(cli) = cli.as_deref() {
        let arguments = remove_mcp_arguments(target);
        if let Err(error) = run_agent_cli(cli, &arguments, None) {
            if !missing_registration_error(&error) {
                return Err(format!(
                    "Could not disconnect {}: {error}",
                    target.display_name()
                ));
            }
        }
    }
    remove_managed_skills(target, &home, &root)?;
    registry.targets.remove(target.id());
    write_private_json(&root.join(INTEGRATIONS_FILE), &registry)?;
    Ok(AgentIntegrationResult {
        status: status_for(target, &home, &root, &registry),
        restart_required: cli.is_some(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_supported_agents_have_distinct_skill_roots() {
        let home = Path::new("/tmp/fruit-truck-home");
        let roots: Vec<_> = AgentIntegrationTarget::all()
            .into_iter()
            .map(|target| target.skills_directory(home))
            .collect();
        assert_eq!(roots[0], home.join(".agents/skills"));
        assert_eq!(roots[1], home.join(".claude/skills"));
        assert_eq!(roots[2], home.join(".hermes/skills"));
    }

    #[test]
    fn registry_defaults_to_the_supported_schema() {
        let registry = IntegrationRegistry::default();
        assert_eq!(registry.schema_version, 1);
        assert!(registry.targets.is_empty());
    }

    #[test]
    fn disconnect_treats_an_already_missing_registration_as_success() {
        assert!(missing_registration_error(
            "No MCP server named 'fruit-truck' found."
        ));
        assert!(missing_registration_error(
            "Server fruit-truck does not exist"
        ));
        assert!(!missing_registration_error("Permission denied"));
    }

    #[test]
    fn disconnect_restores_workflows_that_preceded_fruit_truck() {
        let test_root = std::env::temp_dir().join(format!(
            "fruit-truck-agent-backup-test-{}-{}",
            std::process::id(),
            unix_timestamp()
        ));
        let home = test_root.join("home");
        let fruit_root = test_root.join("fruit");
        let managed = home.join(".agents/skills/fruit-truck-agent");
        let backup = fruit_root.join("agent-backups/codex/fruit-truck-agent");
        std::fs::create_dir_all(&managed).unwrap();
        std::fs::create_dir_all(&backup).unwrap();
        std::fs::write(managed.join(MANAGED_MARKER), b"{}").unwrap();
        std::fs::write(backup.join("original.txt"), b"keep me").unwrap();

        remove_managed_skills(AgentIntegrationTarget::Codex, &home, &fruit_root).unwrap();

        assert_eq!(
            std::fs::read_to_string(managed.join("original.txt")).unwrap(),
            "keep me"
        );
        assert!(!managed.join(MANAGED_MARKER).exists());
        std::fs::remove_dir_all(test_root).unwrap();
    }

    #[test]
    fn agent_cli_arguments_match_each_supported_host() {
        let node = Path::new("/runtime/node");
        let server = Path::new("/runtime/mcp-server.js");
        let as_strings = |values: Vec<OsString>| {
            values
                .into_iter()
                .map(|value| value.to_string_lossy().into_owned())
                .collect::<Vec<_>>()
        };

        assert_eq!(
            &as_strings(add_mcp_arguments(
                AgentIntegrationTarget::Codex,
                node,
                server
            ))[..5],
            ["mcp", "add", "fruit-truck", "--", "/runtime/node"]
        );
        assert_eq!(
            &as_strings(add_mcp_arguments(
                AgentIntegrationTarget::Claude,
                node,
                server
            ))[..9],
            [
                "mcp",
                "add",
                "--transport",
                "stdio",
                "--scope",
                "user",
                "fruit-truck",
                "--",
                "/runtime/node"
            ]
        );
        assert_eq!(
            &as_strings(add_mcp_arguments(
                AgentIntegrationTarget::Hermes,
                node,
                server
            ))[..9],
            [
                "mcp",
                "add",
                "--connect-timeout",
                "10",
                "fruit-truck",
                "--command",
                "/runtime/node",
                "--args",
                "/runtime/mcp-server.js"
            ]
        );
        assert_eq!(
            as_strings(remove_mcp_arguments(AgentIntegrationTarget::Claude)),
            ["mcp", "remove", "fruit-truck"]
        );
    }
}
