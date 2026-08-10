#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const repository = dirname(root);
const compatibility = JSON.parse(await readFile(join(root, "compatibility.json"), "utf8"));
const packageManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const desktopManifest = JSON.parse(await readFile(join(repository, "apps", "desktop", "package.json"), "utf8"));

const numeric = (value) => value.split(".").map((item) => Number(item));
const compare = (left, right) => {
  const a = numeric(left);
  const b = numeric(right);
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
};

if (packageManifest.version !== compatibility.agentKitVersion) {
  throw new Error(`Agent Kit package ${packageManifest.version} does not match compatibility manifest ${compatibility.agentKitVersion}.`);
}
if (compare(desktopManifest.version, compatibility.desktop.minimum) < 0
  || compare(desktopManifest.version, compatibility.desktop.maximumExclusive) >= 0) {
  throw new Error(`Desktop ${desktopManifest.version} is outside the supported Agent Kit range.`);
}
if (compatibility.desktop.bridgeSchemaVersion !== 4) {
  throw new Error("This Agent Kit build supports only bridge schema version 4.");
}

const smokeHome = mkdtempSync(join(tmpdir(), "fruit-truck-agent-kit-check-"));
try {
  for (const host of ["codex", "hermes"]) {
    for (const profile of ["legacy", "fast"]) {
    const smoke = spawnSync(process.execPath, [join(root, "dist", "scripts", "mcp-server.js"), "--agent-host", host, "--tool-profile", profile, "--core-mode", "off"], {
      input: [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { clientInfo: { name: "agent-kit-package-check", version: packageManifest.version } },
        }),
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
        "",
      ].join("\n"),
      encoding: "utf8",
      timeout: 5_000,
      env: { ...process.env, FRUIT_TRUCK_HOME: join(smokeHome, host) },
    });
    if (smoke.error) throw smoke.error;
    if (smoke.status !== 0) {
      throw new Error(`Packaged ${host} MCP server exited with status ${smoke.status}: ${smoke.stderr.trim()}`);
    }
    const messages = smoke.stdout.trim().split("\n").map((line) => JSON.parse(line));
    const initialized = messages.find((message) => message.id === 1);
    const tools = messages.find((message) => message.id === 2)?.result?.tools ?? [];
    const toolNames = new Set(tools.map((item) => item.name));
    const expectedEntryTool = profile === "fast" ? "session_open" : "create_session";
    if (initialized?.result?.serverInfo?.name !== "fruit-truck" || !toolNames.has(expectedEntryTool)) {
      throw new Error(`Packaged ${host} MCP server did not complete initialization and tool discovery.`);
    }
    if (profile === "legacy" && (host === "codex") !== toolNames.has("request_image_backend_selection")) {
      throw new Error("Codex-only image tools were exposed to the wrong agent host.");
    }
    if (profile === "fast" && (tools.length > 8 || Buffer.byteLength(JSON.stringify(tools)) >= 5 * 1024)) {
      throw new Error(`Packaged ${host} fast profile exceeds its tool-count or schema-size budget.`);
    }
    }
  }

  const mockBin = join(smokeHome, "bin");
  const hermesSkills = join(smokeHome, "hermes-skills");
  const mockHermes = join(mockBin, "hermes");
  mkdirSync(mockBin, { recursive: true });
  writeFileSync(mockHermes, `#!/usr/bin/env node
import { readFileSync } from "node:fs";
const input = readFileSync(0, "utf8");
if (input !== ${JSON.stringify("y\n\n")}) process.exit(3);
process.stdout.write("Saved 'fruit-truck' to mock Hermes config.\\n");
`, { mode: 0o755 });
  chmodSync(mockHermes, 0o755);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const install = spawnSync(process.execPath, [
      join(root, "bin", "install.mjs"),
      "install",
      "hermes",
      "--configure",
      "--force",
      `--skills-dir=${hermesSkills}`,
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${mockBin}:${process.env.PATH ?? ""}`,
      },
    });
    if (install.error) throw install.error;
    if (install.status !== 0 || !install.stdout.includes("Saved 'fruit-truck'")) {
      throw new Error(`Hermes repeat configuration attempt ${attempt + 1} failed: ${install.stderr || install.stdout}`);
    }
  }
} finally {
  rmSync(smokeHome, { recursive: true, force: true });
}
process.stdout.write(`Agent Kit ${packageManifest.version} is compatible with desktop ${desktopManifest.version}.\n`);
