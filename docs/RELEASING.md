# Releasing OpenGen UI for macOS

OpenGen UI is distributed as one Universal DMG for Apple Silicon and Intel Macs. The app is ad-hoc signed and intentionally not notarized with Apple.

## One-time GitHub setup

1. Open **Settings → Pages** in the GitHub repository.
2. Under **Build and deployment**, select **GitHub Actions** as the source.
3. Ensure GitHub Actions has permission to create releases under **Settings → Actions → General → Workflow permissions**.

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
git tag v0.1.0
git push origin v0.1.0
```

The release workflow will:

1. Build a Universal macOS DMG.
2. Ad-hoc sign the application without an Apple Developer account.
3. Remove the DMG volume icon metadata so hidden files never overlap the installer window.
4. Upload it as `OpenGen-UI-macOS-universal.dmg`.
5. Upload a SHA-256 checksum.
6. Publish the GitHub Release.

The landing page always downloads the latest release from:

```text
https://github.com/jbaehova/open-gen-ui/releases/latest/download/OpenGen-UI-macOS-universal.dmg
```

## First launch for users

Because the app is not notarized, users must approve it once:

1. Open the DMG and drag OpenGen UI to Applications.
2. Try to open OpenGen UI once.
3. Open **System Settings → Privacy & Security**.
4. Select **Open Anyway**.

## Updating an installed app

Automatic updates are not built in yet. Existing users update manually:

1. Quit OpenGen UI.
2. Download and open the latest DMG from the landing page.
3. Drag OpenGen UI to Applications and select **Replace**.
4. If macOS blocks the new version, try opening it once, then use **System Settings → Privacy & Security → Open Anyway** again.

The OpenRouter API key remains in `~/.open-gen-ui`, outside the application bundle, so replacing the app does not remove it.
