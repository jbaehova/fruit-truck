<div align="center">

# Oppa Gen

### One clean workspace for image and video generation

Choose an OpenRouter model, see only the controls it supports, and inspect the exact request before you generate.

[![Status: Beta](https://img.shields.io/badge/status-beta-F2755C?style=flat-square)](#project-status)
[![Tauri 2](https://img.shields.io/badge/Tauri-2-24C8DB?style=flat-square&logo=tauri&logoColor=white)](https://tauri.app/)
[![React 19](https://img.shields.io/badge/React-19-087EA4?style=flat-square&logo=react&logoColor=white)](https://react.dev/)
[![TypeScript 6](https://img.shields.io/badge/TypeScript-6-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Rust](https://img.shields.io/badge/Rust-desktop-000000?style=flat-square&logo=rust&logoColor=white)](https://www.rust-lang.org/)

**English** · [한국어](./docs/i18n/README.ko.md) · [简体中文](./docs/i18n/README.zh-CN.md) · [日本語](./docs/i18n/README.ja.md) · [Español](./docs/i18n/README.es.md)

<br />

<img src="./assets/readme/oppa-gen-hero.png" alt="Vibrant cut-paper Oppa Gen banner with abstract image and film motifs" width="1200" />

<br />

[Why Oppa Gen?](#why-oppa-gen) · [Features](#features) · [How it works](#how-it-works) · [Quick start](#quick-start) · [Security](#security) · [Development](#development)

</div>

---

> **Oppa Gen** turns OpenRouter's live model metadata into a focused desktop workspace. Pick a model, compose a valid request, preview the JSON, and generate without rebuilding your form for every provider.

## Why Oppa Gen?

Generation models rarely agree on inputs. One supports seed and aspect ratio; another expects first and last frames; a third accepts several reference images. Oppa Gen reads those capabilities at runtime and adapts the workspace to the selected model.

| Without Oppa Gen | With Oppa Gen |
| --- | --- |
| Cross-check provider docs for every model | Controls are derived from the live model catalog |
| Guess which fields are valid | Unsupported options stay out of the request |
| Handcraft JSON and image data URLs | References and parameters are mapped for you |
| Build custom polling for video jobs | Active jobs are restored and polled to completion |

## Features

- **Live model discovery** — loads image and video catalogs directly from OpenRouter.
- **Capability-aware controls** — renders only the parameters supported by the selected model.
- **Image and video workflows** — handles image results as well as asynchronous video jobs.
- **Flexible references** — maps uploads to general references, first frames, or last frames when supported.
- **Request inspector** — shows sanitized request JSON without embedding media bodies.
- **Advanced routing** — accepts optional provider routing and passthrough settings as JSON.
- **Job continuity** — remembers an active video job and resumes polling after a restart.
- **Chat-owned Agent decisions** — local agents ask every creative choice, model selection, and approval in their own chat while the desktop stays focused on media and status.
- **Codex-native images** — Codex sessions choose once between built-in image generation/editing and OpenRouter; Claude Code and Hermes remain on OpenRouter.
- **Shared control** — the right `Agent / Assets` panel keeps status, current action, progress, pause/stop, and handover controls beside the unchanged generation canvas.
- **Traceable output** — provenance and evaluation stay available in each Asset preview without adding a dashboard to the main workspace.
- **Managed local media** — desktop uploads live under `~/.oppa-gen/assets`; generated and assembled results live under `~/.oppa-gen/generated`.
- **Local credential storage** — keeps the OpenRouter API key in the desktop app's local data, outside request previews and logs.

## How it works

```mermaid
flowchart LR
    A[OpenRouter live catalog] --> B[Capability mapper]
    B --> C[Model-specific controls]
    C --> D[Request preview]
    D --> E[OpenRouter API]
    E --> F[Image result]
    E --> G[Video job polling]
```

1. Oppa Gen fetches the live image and video model catalogs.
2. The selected model's metadata determines which inputs, references, and options appear.
3. Your prompt and settings are converted into a provider-valid request.
4. You can inspect the sanitized request JSON before generating.
5. Images render immediately; video jobs are persisted and polled until they finish.

## Quick start

### Prerequisites

| Requirement | Notes |
| --- | --- |
| Node.js | Version 24 or newer |
| Rust | Current stable toolchain |
| Tauri prerequisites | Platform dependencies from the [Tauri setup guide](https://v2.tauri.app/start/prerequisites/) |
| OpenRouter API key | Create one in [OpenRouter settings](https://openrouter.ai/settings/keys) |

### Run the desktop app

```bash
git clone https://github.com/jbaehova/oppa-gen.git
cd oppa-gen/apps/desktop
npm ci
npm run tauri:dev
```

To use the browser-only development view instead, run `npm run dev` from `apps/desktop`.

When the app opens, add your OpenRouter API key in **Settings**. The model catalogs will load automatically.

### Connect a local agent

Oppa Gen includes a standalone stdio MCP server and Agent Skills in this repository. Until `@oppa-gen/agent-kit` is published to npm, install the checked-out package directly:

```bash
cd agent-kit
npm run build
npm install --global .
oppa-gen-agent-kit install codex --configure
# or: oppa-gen-agent-kit install claude --configure
# or: oppa-gen-agent-kit install hermes --configure
```

The installer copies [`oppa-gen-agent`](./agent-kit/skills/oppa-gen-agent/SKILL.md) and [`story-driven-short-form`](./agent-kit/skills/story-driven-short-form/SKILL.md) to the target's personal Skill directory and can register `oppa-gen-mcp`. See the [Agent Kit guide](./agent-kit/README.md) for installation, manual configuration, and update commands. The package compatibility manifest currently supports desktop `>=0.3.0 <0.4.0`.

Start from the local agent with a rough intent such as “Make a 15-second reel about discovering a perfume in an old shop on a rainy night.” A published session first appears as **Connection waiting**. The MCP agent calls `claim_session`, records each structured decision, asks in agent chat, and applies the explicit reply with `resolve_decision`. Session writes use revision checks, a shared lock, and a last-synced three-way merge.

In a Codex-controlled session, the first image task asks whether to use Codex built-in image generation or OpenRouter; that choice lasts for the session. Claude Code, Hermes, Human-driven image generation, and all video generation use OpenRouter. Final crop-and-merge rendering remains in the desktop's **Make final video** window and uses local `ffmpeg` and `ffprobe`.

Uploads are copied into `~/.oppa-gen/assets`; generated media and legacy IndexedDB-only assets are materialized into managed storage before the bridge publishes them. Session and bridge JSON store `localPath` metadata rather than Base64 media payloads.

## Security

In the Tauri desktop app, the OpenRouter key is stored at:

```text
~/.oppa-gen/credentials.json
```

- On macOS and Linux, the directory is restricted to `0700` and the credential file to `0600`.
- The key is masked in the interface and excluded from request previews and application logs.
- Network calls are proxied through the Rust process, which only permits the OpenRouter paths used by the app.
- Generated video files shared with local agents are restricted to `~/.oppa-gen/generated`.

> [!NOTE]
> The browser-only Vite development view uses local storage as a development fallback. Use the Tauri app for desktop credential handling.

## Development

Run checks from `apps/desktop`:

```bash
npm run test:unit
npm run check
npm run build
npm run test:e2e
cd src-tauri && cargo test
```

Playwright runs headless at 1920×1080 and covers the full-window Agent/Assets layout, chat-owned decision status, Assembly, and Agent Skill management.

### Project structure

```text
oppa-gen/
├── agent-kit/              # Core/Workflow Skills and MCP configuration
├── apps/desktop/
│   ├── scripts/            # Local-agent MCP server
│   ├── src/                 # React workspace and request builder
│   └── src-tauri/           # Credential storage and OpenRouter proxy
└── assets/readme/           # README artwork
```

The request-building logic lives in `apps/desktop/src/openrouter.ts`; the native security boundary and OpenRouter proxy live in `apps/desktop/src-tauri/src/lib.rs`.

## Project status

Oppa Gen is currently **beta software**. The request layer and core desktop workflow are in place, while packaging, release automation, and broader provider coverage are still evolving.

<div align="center">

Built for creators who want model flexibility without request-shape busywork.

[Back to top](#oppa-gen)

</div>
