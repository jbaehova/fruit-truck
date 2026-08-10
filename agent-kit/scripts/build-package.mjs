#!/usr/bin/env node
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const repository = dirname(root);
const desktop = join(repository, "apps", "desktop");
const dist = join(root, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(join(dist, "scripts"), { recursive: true });
await mkdir(join(dist, "src"), { recursive: true });

const compile = async (source, destination) => {
  const input = await readFile(source, "utf8");
  const output = ts.transpileModule(input, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.ESNext,
      verbatimModuleSyntax: true,
    },
    fileName: source,
  }).outputText
    .replaceAll("../src/agent.ts", "../src/agent.js")
    .replaceAll("../src/openrouter.ts", "../src/openrouter.js")
    .replaceAll("../src/mask.ts", "../src/mask.js")
    .replaceAll("../src/videoPolling.ts", "../src/videoPolling.js")
    .replaceAll("./core-client.ts", "./core-client.js")
    .replaceAll("./telemetry.ts", "./telemetry.js");
  await writeFile(destination, output, { mode: 0o755 });
};

await compile(join(desktop, "scripts", "mcp-server.ts"), join(dist, "scripts", "mcp-server.js"));
await compile(join(desktop, "scripts", "core-client.ts"), join(dist, "scripts", "core-client.js"));
await compile(join(desktop, "scripts", "telemetry.ts"), join(dist, "scripts", "telemetry.js"));
await compile(join(desktop, "src", "agent.ts"), join(dist, "src", "agent.js"));
await compile(join(desktop, "src", "openrouter.ts"), join(dist, "src", "openrouter.js"));
await compile(join(desktop, "src", "mask.ts"), join(dist, "src", "mask.js"));
await compile(join(desktop, "src", "videoPolling.ts"), join(dist, "src", "videoPolling.js"));
