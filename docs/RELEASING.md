# Releasing Fruit Truck for macOS

Fruit Truck is distributed as one Universal DMG for Apple Silicon and Intel Macs. The app is ad-hoc signed and intentionally not notarized with Apple.

## One-time GitHub setup

1. Open **Settings → Pages** in the GitHub repository.
2. Under **Build and deployment**, select **GitHub Actions** as the source.
3. Ensure GitHub Actions has permission to create releases under **Settings → Actions → General → Workflow permissions**.
4. Store the Tauri updater private key and password as `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` repository secrets. Never commit the private key.

## Publish a release

Keep the version in these three files in sync:

- `apps/desktop/package.json`
- `apps/desktop/src-tauri/tauri.conf.json`
- `apps/desktop/src-tauri/Cargo.toml`

Run the checks locally:

```bash
cd apps/desktop
npm ci
npm run test:unit
npm run check
cargo test --manifest-path src-tauri/Cargo.toml
npm run bundle:mac:universal
```

Commit the version, then create and push the matching tag:

```bash
git tag v0.4.0
git push origin v0.4.0
```

The release workflow will:

1. Build a Universal macOS DMG.
2. Ad-hoc sign the application without an Apple Developer account.
3. Remove the DMG volume icon metadata so hidden files never overlap the installer window.
4. Create and sign the `.app.tar.gz` in-app updater bundle.
5. Upload `latest.json`, the updater bundle, and its signature.
6. Upload the DMG as `Fruit-Truck-macOS-universal.dmg` and its SHA-256 checksum.
7. Publish the GitHub Release as `latest`.

The landing page always downloads the latest release from:

```text
https://github.com/jbaehova/fruit-truck/releases/latest/download/Fruit-Truck-macOS-universal.dmg
```

## First launch for users

Because the app is not notarized, users must approve it once:

1. Open the DMG and drag Fruit Truck to Applications.
2. Try to open Fruit Truck once.
3. Open **System Settings → Privacy & Security**.
4. Select **Open Anyway**.

## Updating an installed app

Version 0.2.0 is the updater bootstrap release. Users on 0.1.x install its DMG manually once. Starting with 0.2.0, the app checks `latest.json` on launch, prompts when a newer signed version exists, verifies the updater signature, installs it, and relaunches.

The OpenRouter API key remains in `~/.fruit-truck`, outside the application bundle, so updating the app does not remove it.

The updater signing key is independent from Apple code signing. Losing it prevents installed clients from accepting future updates, so keep a secure offline backup.
