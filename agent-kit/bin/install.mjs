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
const skillsDirectoryOverride = args.find((value) => value.startsWith("--skills-dir="))?.slice("--skills-dir=".length);
const destinations = {
  codex: join(homedir(), ".agents", "skills"),
  claude: join(homedir(), ".claude", "skills"),
  hermes: join(homedir(), ".hermes", "skills"),
};
const configurationCommands = {
  codex: ["codex", ["mcp", "add", "oppa-gen", "--", "oppa-gen-mcp", "--agent-host", "codex"]],
  claude: ["claude", ["mcp", "add", "oppa-gen", "--scope", "user", "--", "oppa-gen-mcp", "--agent-host", "claude"]],
  hermes: ["hermes", ["mcp", "add", "oppa-gen", "--command", "oppa-gen-mcp", "--args", "--agent-host", "hermes"]],
};

function usage() {
  process.stdout.write([
    "Oppa Gen Agent Kit",
    "",
    "  oppa-gen-agent-kit install <codex|claude|hermes> [--configure] [--force] [--skills-dir=/absolute/path]",
    "  oppa-gen-agent-kit print-config <codex|claude|hermes>",
    "",
    "--configure also registers the oppa-gen-mcp stdio server through the target CLI.",
    "--force replaces an existing installed copy of the bundled Skills.",
    "--skills-dir overrides the target's default personal Skills directory.",
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
  for (const skill of ["oppa-gen-agent", "story-driven-short-form"]) {
    const output = join(destination, skill);
    if (force) await rm(output, { recursive: true, force: true });
    await cp(join(root, "skills", skill), output, { recursive: true, force });
  }
  process.stdout.write(`Installed Oppa Gen Skills in ${destination}.\n`);
  if (configure) {
    const [program, programArgs] = configurationCommands[target];
    const result = spawnSync(program, programArgs, { stdio: "inherit" });
    if (result.error) throw new Error(`Could not run ${program}: ${result.error.message}`);
    if (result.status !== 0) throw new Error(`${program} MCP configuration exited with status ${result.status}.`);
  } else {
    process.stdout.write(`Register MCP with: oppa-gen-agent-kit print-config ${target}\n`);
  }
} else {
  usage();
  process.exitCode = 2;
}
