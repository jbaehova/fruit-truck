# Releasing Fruit Truck

Fruit Truck ships an Apple Silicon macOS app and updater artifacts. The
release workflow is deliberately tag-bound: every source file used by the
gate and build is checked out at the exact commit pointed to by the requested
`vX.Y.Z` tag.

## Release contract

From `apps/desktop`, a local preflight should be equivalent to the required CI
checks:

```sh
npm ci
npm run check
npm run test:unit
npm run test:coverage
npm run build
npm run test:e2e
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo llvm-cov --manifest-path src-tauri/Cargo.toml --all-features --lcov --output-path "$TMPDIR/fruit-truck-rust.lcov" --fail-under-lines 35 --fail-under-functions 20
npm audit --audit-level=high
npm run check:licenses
npm run sbom -- --output "$TMPDIR/fruit-truck.cdx.json"
```

The CI image installs `cargo-llvm-cov` at version `0.9.0`; install that same
version locally before running the coverage command.

The release gate also runs the pinned ShellCheck and actionlint versions,
validates the packaged app's native launch path, and keeps a dependency SBOM
as a CI artifact. Browser E2E remains headless at the maximized desktop
viewport (1920×1080).

The production JavaScript budget defaults to 900,000 bytes uncompressed and
300,000 bytes gzip-compressed. A deliberate budget change must be made through
the `FRUIT_TRUCK_MAX_JS_BYTES` and `FRUIT_TRUCK_MAX_JS_GZIP_BYTES` environment
variables and reviewed with the resulting build artifact.

The license check covers both npm and third-party Cargo packages from the
locked dependency graph. Cargo-deny keeps vulnerable, yanked, and unknown
source findings fatal; unmaintained advisories are scoped to direct workspace
packages because the current Tauri native stack includes transitive GTK/WebKit
crates without a compatible maintained replacement. OSV exceptions are listed
by advisory ID with reasons and review expiry dates in
`apps/desktop/src-tauri/osv-scanner.toml`. Linux-only GTK findings are allowed
only after confirming they are absent from the Apple Silicon target tree;
new or unlisted vulnerabilities remain fatal.

The contract requires the release bundle to contain only `ffprobe` as an
external executable. It rejects the removed media renderer and old helper
binaries, workflow resources, commands, and crates. All GitHub Actions are
referenced by immutable commit SHA rather than a moving tag.

## Release assets

The public release contains exactly these assets:

| Asset | Purpose |
| --- | --- |
| `Fruit-Truck-macOS-universal.dmg` | Notarized Apple Silicon installer (the stable download URL) |
| `Fruit-Truck-macOS-universal.app.tar.gz` | Signed Tauri updater payload |
| `Fruit-Truck-macOS-universal.app.tar.gz.sig` | Updater signature |
| `latest.json` | Signed updater manifest |
| `Fruit-Truck-ffmpeg-source.tar.xz` | Exact source used to build the bundled FFprobe |
| `Fruit-Truck-ffmpeg-build-config-arm64.txt` | Exact FFmpeg configure arguments and source digest |
| `Fruit-Truck-ffmpeg-source.sha256` | SHA-256 manifest for the source archive |

The release verifier downloads the source/config/checksum assets, verifies the
source digest against `apps/desktop/scripts/ffmpeg-version.env`, checks the
archive's top-level version directory, and rejects missing or unexpected
assets. This keeps [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) and the
published release contract in sync.

## Build assets

`scripts/prepare-macos-release-assets.sh` builds the pinned FFmpeg source on
Apple Silicon, copies only FFprobe into `src-tauri/target/bundled-tools`, and
retains the required LGPL notices and build configuration. The workflow keeps
the verified source archive in the runner temporary directory until it uploads
the three source-disclosure assets above. The app does not bundle or invoke
the `ffmpeg` executable.

## Signing and notarization

Configure the Apple certificate, notarization credentials, and Tauri updater
signing key documented in `.github/workflows/release.yml`. Push a matching
`vX.Y.Z` tag or start the workflow manually with an unpublished matching tag.
The tag must point at the exact commit being built, and a published release
cannot be overwritten.

The workflow builds the app and DMG, signs the updater artifacts, notarizes and
staples the DMG, verifies FFprobe architecture and linkage, launches the
packaged app in a clean temporary data directory, and confirms that removed
executables and resources are absent before publishing.

## Product and privacy scope

Fruit Truck releases the image/video studio described in the
[support matrix](./SUPPORT.md). `/images` and `/videos` are generation routes;
`/chat/completions` is used only by the optional prompt planner, not exposed as
general chat. Prompts and selected media leave the Mac for generation and may
be routed to a downstream provider. Provider retention and video ZDR limits
apply, so release notes must not describe local credential storage as local
generation or promise universal ZDR.

# Paid OpenRouter provider matrix

Provider/reference transport claims must be verified with the manual
`OpenRouter paid provider smoke` workflow before a release enables them.
Protect the `openrouter-paid-smoke` GitHub environment with reviewer approval,
configure `OPENROUTER_API_KEY` and `OPENROUTER_PAID_SMOKE_CASES` as environment
secrets, then type `RUN_PAID_OPENROUTER_SMOKE` and choose a budget no greater
than $5. Each JSON case declares `id`, `mode`, `expect`, `maxCostUsd`,
`referenceKind`, `transport`, and the exact OpenRouter `request`. The runner
never retries a paid POST, retains video job IDs in the log, and stops when the
authorized budget is reached. It also saves bounded provider-returned media,
checks declared MIME against file signatures, records result counts, byte sizes,
and SHA-256 digests, and reconciles every provider-reported case cost with the
total cost ledger. An expected 400/404/405/415/422 contract rejection without
usage may enter the ledger as zero only with `providerCostReported: false`;
authentication, rate-limit, timeout, and server errors remain failures. The
workflow uploads the runner-side private-mode media and
`paid-smoke-report.json` as a seven-day evidence artifact; release reviewers
must compare that artifact—including every unreported rejection—with the
isolated OpenRouter test account before enabling a provider/reference
combination.
