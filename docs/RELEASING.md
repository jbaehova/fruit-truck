# Releasing Fruit Truck for macOS

Fruit Truck ships one signed and notarized DMG for Apple Silicon Macs. Intel
Macs are not supported.

The app is self-contained. It includes Fruit Truck Core, LGPL-only `ffmpeg` and
`ffprobe`, Node.js, Agent Kit, and the Fruit Truck Skills. Users do not need
Homebrew, npm, Rust, or a separate runtime.

## One-time GitHub setup

1. Select **GitHub Actions** under **Settings → Pages → Build and deployment**.
2. Allow GitHub Actions to create releases under **Settings → Actions → General → Workflow permissions**.
3. Enable **Immutable releases** under **Settings → General**. Draft releases remain resumable.
4. Store `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` as repository secrets.
5. Export the Developer ID Application identity as a password-protected PKCS#12 file and store its base64 contents and password as `APPLE_CERTIFICATE` and `APPLE_CERTIFICATE_PASSWORD`.
6. Store `APPLE_ID`, its app-specific `APPLE_PASSWORD`, and `APPLE_TEAM_ID`.

Never commit the updater private key. Keep an offline backup; installed clients
cannot accept future updates if it is lost or replaced.

## Publish a release

Keep the version in these files in sync:

- `apps/desktop/package.json`
- `apps/desktop/src-tauri/tauri.conf.json`
- `apps/desktop/src-tauri/Cargo.toml`

Run the normal checks locally:

```bash
cd apps/desktop
npm ci
npm ci --prefix ../../agent-kit
npm run test:unit
npm run check
cargo test --manifest-path src-tauri/Cargo.toml --workspace
```

`npm run bundle:mac` is the local release-equivalent build. It requires an
Apple Silicon Mac, signing credentials, and Apple notarization credentials.

Commit the version, then create and push the matching tag:

```bash
git tag v0.6.3
git push origin v0.6.3
```

The release workflow runs on GitHub's Apple Silicon macOS runner and:

1. Verifies the tag, versions, permanent download URL, and signing keys.
2. Builds pinned LGPL-only FFmpeg and Fruit Truck Core for arm64.
3. Packages Node.js, Agent Kit, Skills, FFmpeg licenses, and third-party notices.
4. Builds and signs the arm64 app, DMG, and in-app updater.
5. Notarizes and staples the DMG.
6. Runs the bundled Core and Agent Kit with a system-only `PATH`, verifies every bundled executable is arm64, and checks Gatekeeper acceptance.
7. Verifies the remote updater signature, arm64-only updater mappings, checksums, and FFmpeg compliance files.
8. Publishes the draft as the latest release only after every verification passes.

The public asset retains the historical
`Fruit-Truck-macOS-universal.dmg` filename so the permanent landing-page link
does not break. The file produced by current releases is arm64-only.

## Resume an interrupted draft

Run **Actions → Release macOS app → Run workflow** with the unpublished tag.
The workflow reuses the draft and replaces matching assets. Published releases
are immutable; create a newer patch version instead of changing one.

The permanent download URL is:

```text
https://github.com/jbaehova/fruit-truck/releases/latest/download/Fruit-Truck-macOS-universal.dmg
```

## User installation and updates

Users open the DMG, drag Fruit Truck to Applications, and launch it. The app
does not ask them to install any package or command-line tool.

Users on 0.2.0 or newer receive signed in-app updates. The OpenRouter API key
stays in `~/.fruit-truck`, outside the application bundle, and survives an app
replacement.

## FFmpeg compliance

FFmpeg remains necessary because generated inputs may use WebM/VP8/VP9/AV1.
The pinned source version and SHA-256 live in
`apps/desktop/scripts/ffmpeg-version.env`. Each release includes that exact
source archive, its arm64 configure line, checksums, and
`THIRD_PARTY_NOTICES.md`.

The build disables GPL and non-free components. The release verifier rejects
non-system runtime library links and executes the bundled tools with a
system-only `PATH`.
