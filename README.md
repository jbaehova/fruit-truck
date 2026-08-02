<div align="center">

# Fruit Truck

### One clean workspace for image and video generation

Choose an OpenRouter model, see only the controls it supports, and inspect the exact request before you generate.

[![Status: Beta](https://img.shields.io/badge/status-beta-F2755C?style=flat-square)](#project-status)
[![Tauri 2](https://img.shields.io/badge/Tauri-2-24C8DB?style=flat-square&logo=tauri&logoColor=white)](https://tauri.app/)
[![React 19](https://img.shields.io/badge/React-19-087EA4?style=flat-square&logo=react&logoColor=white)](https://react.dev/)
[![TypeScript 6](https://img.shields.io/badge/TypeScript-6-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Rust](https://img.shields.io/badge/Rust-desktop-000000?style=flat-square&logo=rust&logoColor=white)](https://www.rust-lang.org/)

**English** · [한국어](./docs/i18n/README.ko.md) · [简体中文](./docs/i18n/README.zh-CN.md) · [日本語](./docs/i18n/README.ja.md) · [Español](./docs/i18n/README.es.md)

<br />

<img src="./assets/readme/fruit-truck-hero.png" alt="Vibrant cut-paper Fruit Truck banner with abstract image and film motifs" width="1200" />

<br />

[Why Fruit Truck?](#why-fruit-truck) · [Features](#features) · [How it works](#how-it-works) · [Quick start](#quick-start) · [Security](#security) · [Development](#development)

</div>

---

> **Fruit Truck** turns OpenRouter's live model metadata into a focused desktop workspace. Pick a model, compose a valid request, preview the JSON, and generate without rebuilding your form for every provider.

## Why Fruit Truck?

Generation models rarely agree on inputs. One supports seed and aspect ratio; another expects first and last frames; a third accepts several reference images. Fruit Truck reads those capabilities at runtime and adapts the workspace to the selected model.

| Without Fruit Truck | With Fruit Truck |
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
- **Agent-first, visual decisions** — start in Codex, Claude Code, or Hermes; Fruit Truck stays in the background until you open rich media, model, upload, assembly, or approval checkpoints.
- **Codex-native images** — Codex sessions choose once between built-in image generation/editing and OpenRouter; Claude Code and Hermes remain on OpenRouter.
- **Shared control** — the right `Agent / Assets` panel keeps status, current action, progress, pause/stop, and handover controls beside the unchanged generation canvas.
- **Traceable output** — provenance and evaluation stay available in each Asset preview without adding a dashboard to the main workspace.
- **Managed local media** — desktop uploads live under `~/.fruit-truck/assets`; generated and assembled results live under `~/.fruit-truck/generated`.
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

1. Fruit Truck fetches the live image and video model catalogs.
2. The selected model's metadata determines which inputs, references, and options appear.
3. Your prompt and settings are converted into a provider-valid request.
4. You can inspect the sanitized request JSON before generating.
5. Images render immediately; video jobs are persisted and polled until they finish.

## Quick start

### Prerequisites

These requirements are for building Fruit Truck from source. People installing
the DMG do not need Node.js, Rust, Homebrew, FFmpeg, or FFprobe.

| Requirement | Notes |
| --- | --- |
| Node.js | Version 24 or newer |
| Rust | Current stable toolchain |
| Tauri prerequisites | Platform dependencies from the [Tauri setup guide](https://v2.tauri.app/start/prerequisites/) |
| OpenRouter API key | Create one in [OpenRouter settings](https://openrouter.ai/settings/keys) |

### Run the desktop app

```bash
git clone https://github.com/jbaehova/fruit-truck.git
cd fruit-truck/apps/desktop
npm ci
npm run tauri:dev
```

You can also run `./run.sh` from the repository root. It requires Node.js 24+
and can select an installed Node 24+ executable even when an older Node remains
first on `PATH`. On macOS it launches the development process with the visible
name **Fruit Truck**. To use the browser-only development view, run
`./run.sh --web` or `npm run dev` from `apps/desktop`.

Source-tree desktop rendering uses `ffmpeg` and `ffprobe` from the developer's
`PATH`. Homebrew is one optional way to obtain them, not a project requirement.
Release DMGs bundle their own Universal executables.

When the app opens, add your OpenRouter API key in **Settings**. The model catalogs will load automatically.

### Connect a local agent

Fruit Truck includes a standalone stdio MCP server and Agent Skills in this repository. Until `@fruit-truck/agent-kit` is published to npm, install the checked-out package directly:

```bash
cd agent-kit
npm run build
npm install --global .
fruit-truck-agent-kit install codex --configure
# or: fruit-truck-agent-kit install claude --configure
# or: fruit-truck-agent-kit install hermes --configure
```

The installer copies [`fruit-truck-agent`](./agent-kit/skills/fruit-truck-agent/SKILL.md) and [`story-driven-short-form`](./agent-kit/skills/story-driven-short-form/SKILL.md) to the target's personal Skill directory and can register `fruit-truck-mcp`. See the [Agent Kit guide](./agent-kit/README.md) for installation, manual configuration, and update commands. The package compatibility manifest currently supports desktop `>=0.6.0 <0.7.0`.

Start from the local agent with a rough intent such as “Make a 15-second reel about discovering a perfume in an old shop on a rainy night.” The agent creates the session and checks Fruit Truck presence before claiming it. On macOS, an installed app may start in the background but never requests foreground focus. Textual story ambiguity stays in agent chat; media, model, upload, assembly, and approval checkpoints wait durably in Fruit Truck until you open them.

In a Codex-controlled session, the first image task opens a Fruit Truck choice between Codex built-in image generation and OpenRouter; that choice lasts for the session. OpenRouter model choices include published price information when available. The agent prepares final clip order and ranges, then the user reviews and renders them in **Make final video**. Distributed macOS builds use the bundled LGPL FFmpeg/FFprobe executables for MP4, MOV, and WebM input, then encode the final H.264 file through Apple's VideoToolbox hardware path when available.

Uploads are copied into `~/.fruit-truck/assets`; generated media and legacy IndexedDB-only assets are materialized into managed storage before the bridge publishes them. Session and bridge JSON store `localPath` metadata rather than Base64 media payloads.

## Security

In the Tauri desktop app, the OpenRouter key is stored at:

```text
~/.fruit-truck/credentials.json
```

- On macOS and Linux, the directory is restricted to `0700` and the credential file to `0600`.
- The key is masked in the interface and excluded from request previews and application logs.
- Network calls are proxied through the Rust process, which only permits the OpenRouter paths used by the app.
- Generated video files shared with local agents are restricted to `~/.fruit-truck/generated`.

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

Playwright runs headless at 1920×1080 and covers the full-window Agent/Assets layout, passive decision badges, visual review, Assembly, and Agent Skill management.

### macOS media packaging

`npm run bundle:mac:universal` builds FFmpeg 8.1.2 from its verified source
archive for Apple Silicon and Intel, combines both slices, validates that they
link only to macOS system libraries, and places them in the app bundle. It then
builds the Universal DMG using `src-tauri/tauri.release.conf.json`.

The FFmpeg build disables GPL and non-free components. Rendering uses one
filter graph for trim, timestamp reset, aspect-fit scale, pad, 30 fps
normalization, and concatenation, followed by one `h264_videotoolbox` encode.
`allow_sw=1` provides an Apple software fallback if hardware encoding is
unavailable. See [third-party notices](./THIRD_PARTY_NOTICES.md) and the
[release guide](./docs/RELEASING.md).

### Project structure

```text
fruit-truck/
├── agent-kit/              # Core/Workflow Skills and MCP configuration
├── apps/desktop/
│   ├── scripts/            # Local-agent MCP server
│   ├── src/                 # React workspace and request builder
│   └── src-tauri/           # Credential storage and OpenRouter proxy
└── assets/readme/           # README artwork
```

The request-building logic lives in `apps/desktop/src/openrouter.ts`; the native security boundary and OpenRouter proxy live in `apps/desktop/src-tauri/src/lib.rs`.

## Project status

Fruit Truck is currently **beta software**. The request layer and core desktop workflow are in place, while packaging, release automation, and broader provider coverage are still evolving.

<div align="center">

Built for creators who want model flexibility without request-shape busywork.

[Back to top](#fruit-truck)

</div>
