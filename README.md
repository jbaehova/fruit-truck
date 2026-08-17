# Fruit Truck

Fruit Truck is a focused macOS workspace for generating images and videos through OpenRouter.

## Features

- Live image and video model catalogs with capability-aware request fields
- Prompt enhancement with a global default that applies to every thread
- Parallel generation threads, persisted video polling, and per-session cost tracking
- Managed local uploads, generated media, image editing, masks, and result follow-up
- A single Asset Library panel for uploads and generated outputs
- English and Korean application UI

## Development

Requirements: Node.js 24+, Rust, and FFprobe for local media metadata inspection.

```sh
cd apps/desktop
npm ci
npm run check
npm run test:unit
npm run test:e2e
npm run tauri:dev
```

Playwright runs headless with a 1920×1080 viewport, matching the app's default maximized window.

## macOS release

`npm run bundle:mac` builds the pinned FFmpeg project source and packages only its `ffprobe` executable. The app bundle does not include the `ffmpeg` executable. FFmpeg licensing notices and build configuration remain in the bundle because FFprobe is an FFmpeg project output.

Download the latest Apple Silicon installer from [GitHub Releases](https://github.com/jbaehova/fruit-truck/releases/latest) or use the [permanent DMG link](https://github.com/jbaehova/fruit-truck/releases/latest/download/Fruit-Truck-macOS-universal.dmg).

See [docs/RELEASING.md](docs/RELEASING.md) for signing, notarization, and release automation.

## Repository

```text
apps/desktop/   React + Tauri desktop app
docs/i18n/      Translated project guides
```

## License

See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
