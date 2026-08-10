#!/usr/bin/env node
import { cp, mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const command = args.shift() ?? "help";
const target = args.find((value) => !value.startsWith("--"));
const configure = args.includes("--configure");
const force = args.includes("--force");
const toolProfileArgument = args.find((value) => value.startsWith("--tool-profile="))?.slice("--tool-profile=".length) ?? "fast";
if (toolProfileArgument !== "fast" && toolProfileArgument !== "legacy") {
  throw new Error("--tool-profile must be fast or legacy.");
}
const skillsDirectoryOverride = args.find((value) => value.startsWith("--skills-dir="))?.slice("--skills-dir=".length);
const destinations = {
  codex: join(homedir(), ".agents", "skills"),
  claude: join(homedir(), ".claude", "skills"),
  hermes: join(homedir(), ".hermes", "skills"),
};
const configurationCommands = {
  codex: ["codex", ["mcp", "add", "fruit-truck", "--", "fruit-truck-mcp", "--agent-host", "codex", "--tool-profile", toolProfileArgument, "--core-mode", "canonical"]],
  claude: ["claude", ["mcp", "add", "fruit-truck", "--scope", "user", "--", "fruit-truck-mcp", "--agent-host", "claude", "--tool-profile", toolProfileArgument, "--core-mode", "canonical"]],
  hermes: ["hermes", ["mcp", "add", "fruit-truck", "--command", "fruit-truck-mcp", "--args", "--agent-host", "hermes", "--tool-profile", toolProfileArgument, "--core-mode", "canonical"]],
};

function usage() {
  process.stdout.write([
    "Fruit Truck Agent Kit",
    "",
    "  fruit-truck-agent-kit install <codex|claude|hermes> [--configure] [--force] [--tool-profile=fast|legacy] [--skills-dir=/absolute/path]",
    "  fruit-truck-agent-kit print-config <codex|claude|hermes> [--tool-profile=fast|legacy]",
    "",
    "--configure also registers the fruit-truck-mcp stdio server through the target CLI.",
    "--force replaces an existing installed copy of the bundled Skills.",
    "--skills-dir overrides the target's default personal Skills directory.",
    "--tool-profile defaults to fast; legacy keeps every low-level compatibility tool visible.",
    "",
  ].join("\n"));
}

if (command === "help" || command === "--help" || command === "-h") {
  usage();
  process.exit(0);
}
if (!target || !(target in destinations)) {
  usage();
  process.exitCode = 2;
} else if (command === "print-config") {
  const [program, programArgs] = configurationCommands[target];
  process.stdout.write(`${[program, ...programArgs].join(" ")}\n`);
} else if (command === "install") {
  if (skillsDirectoryOverride && !isAbsolute(skillsDirectoryOverride)) {
    throw new Error("--skills-dir must be an absolute path.");
  }
  const destination = skillsDirectoryOverride ?? destinations[target];
  await mkdir(destination, { recursive: true });
  for (const skill of ["fruit-truck-agent", "story-driven-short-form"]) {
    const output = join(destination, skill);
    if (force) await rm(output, { recursive: true, force: true });
    await cp(join(root, "skills", skill), output, { recursive: true, force });
  }
  process.stdout.write(`Installed Fruit Truck Skills in ${destination}.\n`);
  if (configure) {
    const [program, programArgs] = configurationCommands[target];
    const hermesConfiguration = target === "hermes";
    const result = spawnSync(program, programArgs, hermesConfiguration
      ? { input: "y\n\n", encoding: "utf8" }
      : { stdio: "inherit" });
    if (hermesConfiguration) {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
    }
    if (result.error) throw new Error(`Could not run ${program}: ${result.error.message}`);
    if (result.status !== 0) throw new Error(`${program} MCP configuration exited with status ${result.status}.`);
    if (hermesConfiguration && !result.stdout?.includes("Saved 'fruit-truck'")) {
      throw new Error("Hermes did not save the fruit-truck MCP configuration. Confirm that fruit-truck-mcp is installed and reachable on PATH.");
    }
  } else {
    process.stdout.write(`Register MCP with: fruit-truck-agent-kit print-config ${target}\n`);
  }
} else {
  usage();
  process.exitCode = 2;
}
