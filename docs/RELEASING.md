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
git tag v0.6.2
git push origin v0.6.2
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

Before either FFmpeg build starts, the workflow checks that all seven Apple and
Tauri signing secrets are still registered in GitHub, proves that the updater
private key matches the public key embedded in the app, and verifies that the
exact tag, desktop versions, updater endpoint, bundled tools, and landing-page
download URL agree. The updater private key remains only in GitHub Actions; do
not rotate or replace it unless every installed client is intentionally migrated
to a new public key.

### Resume an interrupted draft release

The workflow can be run manually from **Actions → Release macOS app → Run
workflow** with an existing, unpublished `v`-prefixed tag. It resolves the exact
tag ref, reuses its draft release, replaces matching draft assets, and verifies
the complete remote asset set. This is the recovery path when a runner is
cancelled after a tag was pushed but before the draft was published.

A release is not published until all of these files exist and agree:

- `latest.json`, the Universal `.app.tar.gz`, and its `.sig`
- the notarized Universal DMG and its SHA-256 file
- the pinned FFmpeg source, both architecture build configs, their checksums,
  and the third-party notice

Published releases are immutable. If a published release is defective, bump all
three desktop versions, create a newer patch tag, and publish that replacement;
the workflow rejects an already-published tag and any tag that is not newer than
the current latest release. It marks a draft `latest` only after all assets pass
remote verification, then checks the exact
`/releases/latest/download/Fruit-Truck-macOS-universal.dmg` URL used by the
landing page. Publishing a new version therefore does not require redeploying
Pages.

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
