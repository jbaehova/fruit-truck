<div align="center">

# Fruit Truck

### One focused macOS studio for image and video generation

Explore OpenRouter models, shape a request around each model's real capabilities, and keep every input and result in one workspace.

[![Status: Beta](https://img.shields.io/badge/status-beta-F2755C?style=flat-square)](#project-status)
[![macOS: Apple Silicon](https://img.shields.io/badge/macOS-Apple%20Silicon-111111?style=flat-square&logo=apple&logoColor=white)](#download)
[![Tauri 2](https://img.shields.io/badge/Tauri-2-24C8DB?style=flat-square&logo=tauri&logoColor=white)](https://tauri.app/)
[![React 19](https://img.shields.io/badge/React-19-087EA4?style=flat-square&logo=react&logoColor=white)](https://react.dev/)
[![TypeScript 6](https://img.shields.io/badge/TypeScript-6-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

**English** · [한국어](./docs/i18n/README.ko.md) · [简体中文](./docs/i18n/README.zh-CN.md) · [日本語](./docs/i18n/README.ja.md) · [Español](./docs/i18n/README.es.md)

<br />

<img src="./assets/readme/fruit-truck-hero.png" alt="Vibrant cut-paper Fruit Truck banner with abstract image and film motifs" width="1200" />

<br />

[Why Fruit Truck?](#why-fruit-truck) · [Features](#features) · [Supported capabilities](#supported-capabilities) · [How it works](#how-it-works) · [Download](#download) · [Quick start](#quick-start) · [Security](#security-and-local-data) · [Development](#development)

</div>

---

> **Fruit Truck** turns OpenRouter's live model and endpoint metadata into a full-window generation workspace. Choose a model, attach references with explicit roles, inspect the request that will actually be sent, and continue from the results without rebuilding your workflow for every provider.

## Why Fruit Truck?

Image and video models rarely agree on their inputs. One exposes seed and aspect ratio, another accepts first and last frames, and another supports a mixture of image, video, and audio references. Even the meaning of a reference can change from identity to style, composition, or motion.

Fruit Truck adapts the workspace and request to the selected model instead of asking you to memorize those differences.

| Without Fruit Truck | With Fruit Truck |
| --- | --- |
| Cross-check model and provider documentation | Controls come from live catalog and endpoint capabilities |
| Guess which options and reference types are valid | Unsupported combinations are caught before submission |
| Hope every attached reference influences the right thing | Numbered inputs have explicit purposes and visible request mappings |
| Rewrite prompts by hand for each model family | Structured enhancement compiles the intent for the selected model and workflow |
| Build separate polling and file-management flows | Video jobs, generated media, and session costs stay in one workspace |

## Features

- **Guided first run** — introduces the workflow and connects one OpenRouter API key before opening the studio.
- **Live model and price discovery** — loads image and video catalogs, endpoint capabilities, and published pricing from OpenRouter.
- **Capability-aware controls** — renders supported options, clamps constrained values, and validates provider-specific passthrough fields against the selected endpoint.
- **Model-aware prompt enhancement** — turns the original intent into a structured plan, then compiles it with a profile suited to the target image or video model. Enhancement can be enabled once for every current and future thread.
- **Reference contracts** — assigns stable `@1`, `@2`, … inputs a purpose such as subject identity, product identity, style, composition, pose, motion, audio, or context when the selected endpoint declares that reference type. Required mappings are verified before generation; optional gaps remain visible as warnings.
- **Image and video workflows** — supports text-to-image/video generation, multi-reference composition, image editing, and semantic-mask edits according to the selected model's verified endpoint support. Prompt enhancement uses a separate chat-completions planner; Fruit Truck is not a general chat client.
- **Independent generation threads** — keeps image and video prompts, models, options, attempts, and background work isolated while several ideas progress in parallel.
- **Request inspector** — shows the provider-facing prompt, numbered-input mapping, native transport field, and sanitized JSON without embedding local media bodies.
- **Result follow-up** — reviews generated candidates and can reuse a result as a new input or image-edit target where the selected endpoint supports it; video references remain closed until their transport is verified.
- **Job and cost continuity** — restores active video polling, records attempt history, and keeps estimated or actual generation and enhancement costs in a per-session ledger.
- **Asset Library** — imports and previews image, video, and audio files; filters, reuses, deletes, and exports managed results to Downloads.
- **Desktop-native workflow** — provides macOS menus and shortcuts, a maximized full-window layout, English and Korean UI, and signed in-app updates.
- **Managed local data** — keeps uploads, generated media, session state, and credentials on the Mac instead of placing Base64 media in saved metadata.

## Supported capabilities

Fruit Truck is intentionally an OpenRouter image/video studio. A model in the
live catalog is not a promise that every OpenRouter endpoint or provider
feature is available in the app.

| Capability | Endpoint | Status |
| --- | --- | --- |
| Text-to-image and image editing | `/api/v1/images` | Supported when the selected endpoint declares the required options and references |
| Text-to-video | `/api/v1/videos` | Supported with persisted job polling |
| Prompt enhancement | `/api/v1/chat/completions` | Optional planner request; not general chat |
| Video image/video/audio references and editing | `/api/v1/videos` | Unavailable until a verified public HTTPS or signed-upload transport is configured |
| General chat, Responses, tools/function calling, TTS, STT, audio output, embeddings | Various | Not exposed in this studio |

The live endpoint metadata and Fruit Truck's request validator determine the
supported route. Direct-provider documentation alone does not enable an
OpenRouter capability. See the fuller [support matrix](./docs/SUPPORT.md).

## How it works

```mermaid
flowchart LR
    A[OpenRouter catalog and endpoint metadata] --> B[Capability-aware controls]
    C[Prompt and numbered references] --> D[Structured prompt planner]
    D --> E[Model and workflow compiler]
    B --> F[Preflight and request preview]
    E --> F
    F --> G[OpenRouter API]
    G --> H[Image candidate review]
    G --> I[Persisted video polling]
    H --> J[Asset Library and follow-up]
    I --> J
    G --> K[Session cost ledger]
```

1. Fruit Truck fetches OpenRouter's image and video catalogs, their prices, and the endpoint capabilities needed to build a valid request.
2. Each generation thread keeps its own mode, model, prompt, numbered inputs, and options.
3. When prompt enhancement is enabled, the selected planner preserves the original intent and creates reference-by-reference instructions for the active workflow and target model.
4. Fruit Truck compiles the final provider prompt, removes unsupported fields, validates reference coverage and provider options, and exposes the sanitized result in **Request preview**.
5. Images enter candidate review immediately. Video jobs remain attached to the session and resume polling after the app is reopened. Unsupported reference transports are blocked before a planner or paid generation request.
6. Accepted outputs are materialized in managed local storage and can be exported or routed into the next generation.

## Download

Fruit Truck currently ships for **Apple Silicon Macs only**. Intel Macs are not supported.

[Download the latest notarized DMG](https://github.com/jbaehova/fruit-truck/releases/latest/download/Fruit-Truck-macOS-universal.dmg) or review the version notes on [GitHub Releases](https://github.com/jbaehova/fruit-truck/releases/latest).

The stable asset filename contains `universal`, but the release workflow and bundled executable target `aarch64-apple-darwin`. Installed builds include the native media-inspection tool they need; app users do not need Node.js, Rust, Homebrew, or a separate FFmpeg installation.

After installing, open Fruit Truck and follow the one-minute setup to save an [OpenRouter API key](https://openrouter.ai/settings/keys). The key is stored locally, but prompts and selected media leave the Mac when you generate. The app checks signed updates and can install them without replacing the workspace manually.

## Quick start

### Build from source

| Requirement | Notes |
| --- | --- |
| Node.js | Version 24 or newer |
| Rust | Current stable toolchain |
| Tauri prerequisites | Platform dependencies from the [Tauri setup guide](https://v2.tauri.app/start/prerequisites/) |
| FFprobe | Required on `PATH` in development for local video and audio metadata inspection |
| OpenRouter API key | Create one in [OpenRouter settings](https://openrouter.ai/settings/keys) |

The repository runner checks the local toolchain, installs JavaScript dependencies when needed, and opens the maximized Tauri app:

```bash
git clone https://github.com/jbaehova/fruit-truck.git
cd fruit-truck
./run.sh
```

Or run the desktop package directly:

```bash
cd apps/desktop
npm ci
npm run tauri:dev
```

For the browser-only development view, run `./run.sh --web` from the repository root or `npm run dev` from `apps/desktop`. Native credential and managed-file behavior is available in the Tauri app; the browser view uses development fallbacks.

To verify a fresh source checkout without opening a window, run `./run.sh --check`. It installs the lockfile dependencies when needed, validates the TypeScript/OpenRouter/release contracts, and runs a locked Rust check; CI executes this same path.

### Create your first generation

1. Add the OpenRouter key during first-run setup. It can be changed later in **Settings**.
2. Choose an image or video thread and select a model by capability and price.
3. Write the prompt and, when useful, drag media from the Asset Library into the input tray.
4. Set the purpose and transport role of every reference. Use `@1`, `@2`, and so on when referring to a specific input in the prompt.
5. Keep prompt enhancement on for a model-aware rewrite, or turn it off to send the original prompt through the same request validation. Enhancement sends a separate planner request to `/chat/completions` before generation; review its possible cost and transfer notice.
6. Open **Request** to verify the final JSON, route, privacy notice, file count/size, and reference mapping, then generate and continue from the result.

## Security and local data

The Tauri app stores its data under `~/.fruit-truck` by default:

```text
~/.fruit-truck/
├── credentials.json   # OpenRouter API key
├── assets/            # Imported source media
└── generated/         # Materialized image and video results
```

- On Unix systems, Fruit Truck creates its private data directory with `0700` permissions and credential and managed-media files with `0600` permissions.
- The API key is masked in the interface and excluded from request previews and application logs.
- The key is attached only by the Rust process, whose proxy accepts the specific OpenRouter catalog, generation, endpoint, and job paths used by the app.
- Request previews replace local media payloads with readable placeholders instead of exposing Base64 data.
- A generation sends the prompt and the selected reference files to OpenRouter, which may route them to a downstream provider. Provider retention, training, and ZDR policies apply; local credential storage does not make cloud generation local.
- Prompt enhancement is a separate planner request and may send the prompt and supported visual context to the planner model before the final generation request. Review the planner cost and transfer notice before the first generation.
- Video routes can require temporary retention. An enforced ZDR constraint that the selected route cannot satisfy blocks the request; ZDR is not a universal guarantee.
- Local imports reject empty files and enforce safety limits of 30 MB for images, 700 MB for videos, and 50 MB for audio.
- The browser-only development view uses local storage as a fallback. Use the Tauri app for native credential and file handling.

Set `FRUIT_TRUCK_HOME` to an absolute path before launching the app to use a different local data directory.

## Development

Run the same core checks used by CI from `apps/desktop`:

```bash
npm ci
npm run check
npm run test:unit
npm run test:coverage
npm run build
npm run test:e2e
cargo test --manifest-path src-tauri/Cargo.toml
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo llvm-cov --manifest-path src-tauri/Cargo.toml --all-features --lcov --output-path "$TMPDIR/fruit-truck-rust.lcov" --fail-under-lines 35 --fail-under-functions 20
npm run check:licenses
npm run sbom -- --output "$TMPDIR/fruit-truck.cdx.json"
```

Install the pinned Rust coverage tool once with
`cargo install cargo-llvm-cov --version 0.9.0 --locked` if it is not already
available on your `PATH`.

`npm run build` also enforces a production JavaScript budget of 900,000 bytes
uncompressed and 300,000 bytes gzip-compressed.

Playwright always runs headless with a 1920×1080 viewport, matching the desktop app's default maximized-window workflow.

### macOS release

`npm run bundle:mac` builds the pinned FFmpeg project source for Apple Silicon but packages only its `ffprobe` executable. The app does **not** bundle or invoke the `ffmpeg` program. FFmpeg licensing notices and build configuration remain in the bundle because FFprobe is an FFmpeg project output. The matching source archive, build configuration, and SHA-256 manifest are uploaded as named release assets; see [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

The release workflow builds, signs, notarizes, and staples the DMG, verifies the Apple Silicon app bundle, and publishes signed Tauri updater artifacts. See [docs/RELEASING.md](./docs/RELEASING.md) for the complete release contract.

### Project structure

```text
fruit-truck/
├── apps/desktop/
│   ├── e2e/              # Headless full-window Playwright coverage
│   ├── scripts/          # Release, media-tool, and contract checks
│   ├── src/              # React workspace, prompt planner, and request builder
│   └── src-tauri/        # Native storage, media inspection, and OpenRouter proxy
├── assets/readme/        # README artwork
└── docs/                 # Release and translated project guides
```

The capability mapping and provider request logic live in `apps/desktop/src/openrouter.ts`; structured prompt planning lives in `apps/desktop/src/prompting`; native storage and the OpenRouter security boundary live in `apps/desktop/src-tauri/src/lib.rs`.

## Project status

Fruit Truck is currently **beta software**. The core macOS generation workflow, signed release path, local asset handling, request validation, and automated test coverage are in place. OpenRouter catalogs, provider behavior, and model-specific policies can continue to evolve.

## Third-party notices

See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) for bundled dependency and media-tool notices.

<div align="center">

Built for creators who want model flexibility without request-shape busywork.

[Back to top](#fruit-truck)

</div>
