# Fruit Truck Agent Kit

This package contains the standalone `fruit-truck-mcp` stdio server plus the `fruit-truck-agent` Core Skill and `story-driven-short-form` Workflow Skill. It requires Node.js 24 or newer and Fruit Truck desktop `>=0.4.0 <0.5.0`.

## Install

From a repository checkout, build and install the package:

```bash
npm install
npm run build
npm install --global .
```

Then install Skills and register MCP for one agent:

```bash
fruit-truck-agent-kit install codex --configure --force
fruit-truck-agent-kit install claude --configure --force
fruit-truck-agent-kit install hermes --configure --force
```

Run only the line for the agent you use. Omit `--configure` to copy Skills without changing MCP configuration, then inspect the exact command with `fruit-truck-agent-kit print-config <target>`.

- Codex Skills are copied to `~/.agents/skills`; the CLI registers the stdio server in the shared Codex `config.toml`.
- Claude Code Skills are copied to `~/.claude/skills`; MCP is registered at user scope.
- Hermes Skills are copied to `~/.hermes/skills`; MCP is added to `~/.hermes/config.yaml`.
- The generated MCP command includes `--agent-host <target>`. Codex uses this stable host identity to expose its session-level built-in image-generation option; the other targets stay on OpenRouter.

Restart Codex if a newly created top-level skill directory is not detected. Claude Code watches an existing Skills directory live. In Hermes, run `/reload-mcp` after configuration changes.

## Update

Rebuild and reinstall from the updated checkout, then run `fruit-truck-agent-kit install <codex|claude|hermes> --force`.

The package refuses its own release build when its version and desktop compatibility manifest disagree. `create_session` publishes connection-waiting state; use `claim_session`, queue decisions, ask in the current agent chat, and call `resolve_decision` with the explicit reply. Run `fruit-truck-mcp --agent-host <codex|claude|hermes>` directly to verify stdio initialization.
