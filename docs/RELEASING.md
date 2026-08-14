# Releasing Fruit Truck

Fruit Truck ships an Apple Silicon macOS app and updater artifacts.

## Release contract

From `apps/desktop` run:

```sh
npm ci
npm run check
npm run test:unit
cargo test --manifest-path src-tauri/Cargo.toml
npm run test:e2e
npm run build
```

The contract requires the release bundle to contain only `ffprobe` as an external executable. It rejects the removed media renderer and old helper binaries, workflow resources, commands, and crates.

## Build assets

`scripts/prepare-macos-release-assets.sh` builds the pinned FFmpeg source on Apple Silicon, copies only FFprobe into `src-tauri/target/bundled-tools`, and retains the required LGPL notices and build configuration.

## Signing and notarization

Configure the Apple certificate, notarization credentials, and Tauri updater signing key documented in `.github/workflows/release.yml`. Push a matching `vX.Y.Z` tag or start the workflow manually with an unpublished matching tag.

The workflow builds the app and DMG, signs the updater artifacts, notarizes and staples the DMG, verifies FFprobe architecture and linkage, and confirms that removed executables and resources are absent.
