#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
OUTPUT_DIR="${1:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/fruit-truck-supply-chain}"
mkdir -p -- "${OUTPUT_DIR}"

command -v npm >/dev/null 2>&1 || { printf 'npm is required.\n' >&2; exit 1; }
command -v cargo >/dev/null 2>&1 || { printf 'cargo is required.\n' >&2; exit 1; }
command -v cargo-deny >/dev/null 2>&1 || { printf 'cargo-deny is required.\n' >&2; exit 1; }

cd -- "${DESKTOP_DIR}"
npm audit --audit-level=high
npm run check:licenses
npm run sbom -- --output "${OUTPUT_DIR}/fruit-truck.cdx.json"

# Keep the policy in the checked-in workflow while allowing cargo-deny to run
# without adding a repository-wide config that could accidentally govern other
# Rust workspaces.
deny_config="${OUTPUT_DIR}/cargo-deny.toml"
cat > "${deny_config}" <<'EOF'
[licenses]
allow = [
  "0BSD",
  "Apache-2.0",
  "Apache-2.0 WITH LLVM-exception",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "CC0-1.0",
  "CDLA-Permissive-2.0",
  "ISC",
  "MIT",
  "MPL-2.0",
  "OFL-1.1",
  "OpenSSL",
  "Unicode-3.0",
  "Zlib",
]
include-dev = true

[licenses.private]
ignore = true

[advisories]
# Tauri's native GTK/WebKit stack currently has no compatible maintained
# replacement for several transitive crates. Keep vulnerable/yanked advisories
# fatal while surfacing these lifecycle notices without making the release
# gate permanently unsatisfiable on macOS.
yanked = "deny"
unmaintained = "workspace"

[sources]
unknown-registry = "deny"
unknown-git = "deny"
allow-registry = ["https://github.com/rust-lang/crates.io-index"]
EOF

cargo deny \
  --manifest-path "${DESKTOP_DIR}/src-tauri/Cargo.toml" \
  check --config "${deny_config}" advisories sources
printf 'Dependency advisory, license, source, and SBOM checks passed.\n'
