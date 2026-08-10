# Releasing Fruit Truck for macOS

Fruit Truck is distributed as one Universal DMG for Apple Silicon and Intel Macs. The app is signed with a Developer ID Application certificate and notarized by Apple.

The DMG is self-contained. It includes Universal `ffmpeg` and `ffprobe`
executables and does not require Homebrew or any other package manager on the
user's Mac.

## One-time GitHub setup

1. Open **Settings → Pages** in the GitHub repository.
2. Under **Build and deployment**, select **GitHub Actions** as the source.
3. Ensure GitHub Actions has permission to create releases under **Settings → Actions → General → Workflow permissions**.
4. Store the Tauri updater private key and password as `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` repository secrets. Never commit the private key.
5. Export the Developer ID Application identity as a password-protected PKCS#12 file and store its base64 contents and password as `APPLE_CERTIFICATE` and `APPLE_CERTIFICATE_PASSWORD` repository secrets.
6. Store the developer account email, app-specific password, and Team ID as `APPLE_ID`, `APPLE_PASSWORD`, and `APPLE_TEAM_ID` repository secrets.

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
git tag v0.6.1
git push origin v0.6.1
```

The release workflow will:

1. Download and verify the pinned FFmpeg 8.1.2 source archive.
2. Build separate LGPL-only Apple Silicon and Intel media tools.
3. Combine them as Universal executables and reject Homebrew or other non-system runtime links.
4. Build a Universal macOS DMG containing the tools and their license notices.
5. Sign the application and bundled executables with the Developer ID identity and hardened runtime.
6. Notarize and staple the app, then submit the signed outer DMG and staple its own notarization ticket.
7. Verify Gatekeeper acceptance and that the tools run from inside the `.app` with a system-only `PATH`.
8. Create and sign the `.app.tar.gz` in-app updater bundle.
9. Upload `latest.json`, the updater bundle, and its signature.
10. Upload the byte-identical notarized DMG, checksums, corresponding FFmpeg source archive, and exact build configuration.
11. Publish the GitHub Release as `latest`.

The landing page always downloads the latest release from:

```text
https://github.com/jbaehova/fruit-truck/releases/latest/download/Fruit-Truck-macOS-universal.dmg
```

## First launch for users

1. Open the DMG and drag Fruit Truck to Applications.
2. Open Fruit Truck from Applications. The Developer ID signature and stapled Apple notarization ticket allow a normal Gatekeeper launch.

## Updating an installed app

Version 0.2.0 is the updater bootstrap release. Users on 0.1.x install its DMG manually once. Starting with 0.2.0, the app checks `latest.json` on launch, prompts when a newer signed version exists, verifies the updater signature, installs it, and relaunches.

The OpenRouter API key remains in `~/.fruit-truck`, outside the application bundle, so updating the app does not remove it.

The updater signing key is independent from Apple code signing. Losing it prevents installed clients from accepting future updates, so keep a secure offline backup.

## FFmpeg and VideoToolbox

Fruit Truck keeps FFmpeg because generated inputs may be WebM/VP8/VP9/AV1,
which AVFoundation cannot reliably open across supported macOS versions.
FFmpeg handles demuxing, decoding, trim/scale/pad/fps filtering, and
concatenation. The final H.264 encode uses Apple's
`h264_videotoolbox` implementation with quality priority and hardware
acceleration when available. This hybrid retains broad input compatibility
without shipping `libx264` or any GPL component.

The pinned version and source SHA-256 are stored in
`apps/desktop/scripts/ffmpeg-version.env`. The source archive, per-architecture
configure lines, and their checksums must remain attached to the same GitHub
Release as the DMG. The in-app Settings dialog and
`THIRD_PARTY_NOTICES.md` disclose the FFmpeg license.

Homebrew may be used on the Intel CI builder to obtain `nasm`; it is only an
assembler used while compiling and does not become a runtime dependency.
`verify-bundled-ffmpeg.sh` and `verify-app-bundle-media-tools.sh` enforce this
by inspecting linked libraries and executing the bundled tools with a
system-only `PATH`.

Before publishing, smoke-test on a Mac without Homebrew:

1. Install the signed and notarized DMG using the steps above.
2. Import at least one WebM clip and one MP4 or MOV clip.
3. Render them in **Make final video**.
4. Confirm the final MP4 plays and Activity Monitor shows hardware video
   encoding on supported hardware.

Performance comparisons are informational, not a release gate. Use
`scripts/benchmark-macos-renderer.sh` with a representative clip to record wall
time, CPU time, output size, PSNR, and SSIM for VideoToolbox and the previous
`libx264` reference.
