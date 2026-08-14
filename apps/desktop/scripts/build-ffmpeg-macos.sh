#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=ffmpeg-version.env
source "${SCRIPT_DIR}/ffmpeg-version.env"

OUTPUT_DIR=""
KEEP_SOURCE_ARCHIVE=""
INPUT_SOURCE_ARCHIVE=""

usage() {
  cat <<'EOF'
Usage: build-ffmpeg-macos.sh --output-dir DIR
       [--input-source-archive PATH] [--source-archive PATH]

Build the pinned LGPL FFmpeg and FFprobe executables for Apple Silicon.
The resulting executables have no Homebrew runtime dependency.
EOF
}

while (( $# > 0 )); do
  case "$1" in
    --output-dir)
      OUTPUT_DIR="${2:?--output-dir requires a path}"
      shift 2
      ;;
    --source-archive)
      KEEP_SOURCE_ARCHIVE="${2:?--source-archive requires a path}"
      shift 2
      ;;
    --input-source-archive)
      INPUT_SOURCE_ARCHIVE="${2:?--input-source-archive requires a path}"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

[[ "$(uname -s)" == "Darwin" ]] || {
  printf 'FFmpeg macOS binaries must be built on macOS.\n' >&2
  exit 1
}
[[ "$(uname -m)" == "arm64" ]] || {
  printf 'Fruit Truck releases support Apple Silicon only.\n' >&2
  exit 1
}
[[ -n "${OUTPUT_DIR}" ]] || {
  printf '%s\n' '--output-dir is required.' >&2
  exit 2
}

for command_name in curl make shasum tar xcrun; do
  command -v "${command_name}" >/dev/null 2>&1 || {
    printf 'Missing build tool: %s\n' "${command_name}" >&2
    exit 1
  }
done

BUILD_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fruit-truck-ffmpeg.XXXXXX")"
cleanup() {
  [[ "${BUILD_ROOT}" == *"/fruit-truck-ffmpeg."* ]] && rm -rf -- "${BUILD_ROOT}"
}
trap cleanup EXIT

ARCHIVE="${BUILD_ROOT}/ffmpeg-${FFMPEG_VERSION}.tar.xz"
if [[ -n "${INPUT_SOURCE_ARCHIVE}" ]]; then
  cp -f -- "${INPUT_SOURCE_ARCHIVE}" "${ARCHIVE}"
else
  curl \
    --fail \
    --location \
    --http1.1 \
    --connect-timeout 30 \
    --max-time 600 \
    --retry 5 \
    --retry-all-errors \
    --retry-delay 5 \
    --retry-max-time 900 \
    --remove-on-error \
    --output "${ARCHIVE}" \
    "${FFMPEG_SOURCE_URL}"
fi
printf '%s  %s\n' "${FFMPEG_SHA256}" "${ARCHIVE}" | shasum -a 256 --check

tar -xf "${ARCHIVE}" -C "${BUILD_ROOT}"
SOURCE_DIR="${BUILD_ROOT}/ffmpeg-${FFMPEG_VERSION}"
INSTALL_DIR="${BUILD_ROOT}/install"
mkdir -p -- "${INSTALL_DIR}" "${OUTPUT_DIR}"

CONFIGURE_ARGS=(
  "--prefix=${INSTALL_DIR}"
  "--target-os=darwin"
  "--arch=aarch64"
  "--cc=clang"
  "--extra-cflags=-arch arm64 -mmacosx-version-min=11.0"
  "--extra-ldflags=-arch arm64 -mmacosx-version-min=11.0"
  "--disable-gpl"
  "--disable-nonfree"
  "--disable-shared"
  "--enable-static"
  "--disable-autodetect"
  "--disable-network"
  "--disable-doc"
  "--disable-debug"
  "--disable-ffmpeg"
  "--disable-ffplay"
  "--disable-avdevice"
  "--disable-encoders"
  "--disable-muxers"
  "--disable-filters"
  "--disable-iconv"
  "--disable-securetransport"
  "--enable-pthreads"
)

(
  cd "${SOURCE_DIR}"
  ./configure "${CONFIGURE_ARGS[@]}"
  make -s -j"$(sysctl -n hw.logicalcpu)"
  make -s install
)

cp -f -- "${INSTALL_DIR}/bin/ffprobe" "${OUTPUT_DIR}/ffprobe"
chmod 0755 "${OUTPUT_DIR}/ffprobe"

{
  printf 'FFmpeg version: %s\n' "${FFMPEG_VERSION}"
  printf 'Source: %s\n' "${FFMPEG_SOURCE_URL}"
  printf 'Source SHA-256: %s\n' "${FFMPEG_SHA256}"
  printf 'Build architecture: arm64\n'
  printf './configure'
  printf ' %q' "${CONFIGURE_ARGS[@]}"
  printf '\n'
} > "${OUTPUT_DIR}/build-config-arm64.txt"

cp -f -- "${SOURCE_DIR}/COPYING.LGPLv2.1" "${OUTPUT_DIR}/COPYING.LGPLv2.1"
cp -f -- "${SOURCE_DIR}/LICENSE.md" "${OUTPUT_DIR}/FFmpeg-LICENSE.md"
if [[ -n "${KEEP_SOURCE_ARCHIVE}" ]]; then
  cp -f -- "${ARCHIVE}" "${KEEP_SOURCE_ARCHIVE}"
fi

file "${OUTPUT_DIR}/ffprobe"
otool -L "${OUTPUT_DIR}/ffprobe"
"${OUTPUT_DIR}/ffprobe" -hide_banner -version
