# OpenGen UI

OpenGen UI is a lightweight Tauri client for OpenRouter image and video generation models. It turns each model's live capability metadata into a small, valid request form and shows the exact JSON before sending it.

## What it does

- Discovers image models from `GET /api/v1/images/models`
- Discovers video models from `GET /api/v1/videos/models`
- Shows only the options supported by the selected model
- Converts local reference images to data URLs
- Maps video assets to general references, first frames, or last frames
- Generates images and displays base64 or URL results
- Submits video jobs, persists the active job ID, and polls until completion
- Keeps provider routing and passthrough settings in an optional advanced JSON field

## Development

Requirements: Node.js 24+, Rust, and the Tauri system prerequisites.

```bash
cd apps/desktop
npm install
npm run tauri:dev
```

## Checks

```bash
cd apps/desktop
npm run test:unit
npm run check
npm run build
cd src-tauri && cargo test
```

## API key storage

The Tauri process stores the OpenRouter key at `~/.open-gen-ui/credentials.json`. On macOS and Linux the directory is restricted to `0700` and the file to `0600`. The key is never included in request previews or application logs.

## Structure

```text
apps/desktop/
  src/               React workspace and capability/request layer
  src-tauri/         credential storage and OpenRouter proxy commands
```
