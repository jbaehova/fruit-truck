#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${ROOT_DIR}/apps/desktop"
MODE="desktop"

usage() {
  cat <<'EOF'
Usage: ./run.sh [--web|--check] [arguments...]

Run Fruit Truck locally.

  ./run.sh          Start the Tauri desktop app
  ./run.sh --web    Start the browser-only development server
  ./run.sh --check  Install from the lockfile and validate the source checkout
  ./run.sh --help   Show this help

Any additional arguments are forwarded to the selected development command.
EOF
}

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

node_version_supported() {
  local version="$1"
  local major="${version%%.*}"
  [[ "${major}" =~ ^[0-9]+$ ]] && (( major >= 24 ))
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

if [[ "${1:-}" == "--web" ]]; then
  MODE="web"
  shift
elif [[ "${1:-}" == "--check" ]]; then
  MODE="check"
  shift
fi

NODE_VERSION=""
if command -v node >/dev/null 2>&1; then
  NODE_VERSION="$(node -p 'process.versions.node')"
fi

if ! node_version_supported "${NODE_VERSION}"; then
  for NODE_CANDIDATE in \
    /opt/homebrew/opt/node@24/bin/node \
    /opt/homebrew/opt/node/bin/node \
    /usr/local/opt/node@24/bin/node \
    /usr/local/opt/node/bin/node; do
    [[ -x "${NODE_CANDIDATE}" ]] || continue
    CANDIDATE_VERSION="$("${NODE_CANDIDATE}" -p 'process.versions.node')"
    if node_version_supported "${CANDIDATE_VERSION}"; then
      export PATH="$(dirname -- "${NODE_CANDIDATE}"):${PATH}"
      NODE_VERSION="${CANDIDATE_VERSION}"
      printf 'Using Node.js %s from %s.\n' "${NODE_VERSION}" "$(dirname -- "${NODE_CANDIDATE}")"
      break
    fi
  done
fi

if [[ -z "${NODE_VERSION}" ]]; then
  fail "Node.js is required. Install Node.js 24 or newer and try again."
fi
if ! node_version_supported "${NODE_VERSION}"; then
  fail "Node.js ${NODE_VERSION} is unsupported. Install Node.js 24 or newer."
fi
command -v npm >/dev/null 2>&1 ||
  fail "npm is required. Install it with Node.js and try again."

if [[ "${MODE}" == "desktop" || "${MODE}" == "check" ]]; then
  command -v cargo >/dev/null 2>&1 ||
    fail "Rust is required for the desktop app. Install it from https://rustup.rs/."
  command -v rustc >/dev/null 2>&1 ||
    fail "Rust is required for the desktop app. Install it from https://rustup.rs/."

  if [[ "$(uname -s)" == "Darwin" ]] && ! xcode-select -p >/dev/null 2>&1; then
    fail "Xcode Command Line Tools are required. Run: xcode-select --install"
  fi

  if [[ "$(uname -s)" == "Darwin" ]]; then
    MACOS_DEV_RUNNER="${APP_DIR}/scripts/macos-dev-runner.sh"
    case "$(uname -m)" in
      arm64)
        if [[ -x "${MACOS_DEV_RUNNER}" ]]; then
          export CARGO_TARGET_AARCH64_APPLE_DARWIN_RUNNER="${MACOS_DEV_RUNNER}"
        else
          unset CARGO_TARGET_AARCH64_APPLE_DARWIN_RUNNER
        fi
        ;;
      x86_64)
        if [[ -x "${MACOS_DEV_RUNNER}" ]]; then
          export CARGO_TARGET_X86_64_APPLE_DARWIN_RUNNER="${MACOS_DEV_RUNNER}"
        else
          unset CARGO_TARGET_X86_64_APPLE_DARWIN_RUNNER
        fi
        ;;
    esac
  fi

  if ! command -v ffprobe >/dev/null 2>&1 ||
    ! ffprobe -version >/dev/null 2>&1; then
    printf 'Warning: source-tree development uses FFprobe on PATH for local video/audio metadata. Release DMGs bundle FFprobe and do not require Homebrew.\n' >&2
  fi
fi

cd "${APP_DIR}"

if [[ ! -x node_modules/.bin/vite ]] ||
  [[ ! -f node_modules/.package-lock.json ]] ||
  [[ package.json -nt node_modules/.package-lock.json ]] ||
  [[ package-lock.json -nt node_modules/.package-lock.json ]]; then
  printf 'Installing JavaScript dependencies...\n'
  npm ci --no-audit --no-fund
fi

if [[ "${MODE}" == "web" ]]; then
  printf 'Starting Fruit Truck in the browser...\n'
  exec npm run dev -- "$@"
fi

if [[ "${MODE}" == "check" ]]; then
  printf 'Validating the Fruit Truck source checkout...\n'
  npm run check
  cargo check --manifest-path src-tauri/Cargo.toml --locked
  printf 'Fruit Truck source checkout is ready.\n'
  exit 0
fi

[[ -x node_modules/.bin/tauri ]] ||
  fail "The Tauri CLI is missing. Remove apps/desktop/node_modules and run this script again."

printf 'Starting the Fruit Truck desktop app...\n'
exec npm run tauri:dev -- "$@"
