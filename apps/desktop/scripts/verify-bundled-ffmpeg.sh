#!/usr/bin/env bash

set -Eeuo pipefail

TOOLS_DIR="${1:?Path to the bundled-tools directory is required.}"
FFPROBE="${TOOLS_DIR}/ffprobe-aarch64-apple-darwin"

executable="${FFPROBE}"
[[ -x "${executable}" ]] || {
  printf 'Missing bundled executable: %s\n' "${executable}" >&2
  exit 1
}
ARCHS="$(lipo -archs "${executable}")"
[[ "${ARCHS}" == "arm64" ]] || {
  printf '%s is not Apple Silicon-only: %s\n' "${executable}" "${ARCHS}" >&2
  exit 1
}
DEPENDENCIES="$(otool -L "${executable}" | grep -E '^[[:space:]]+(@|/)')"
if grep -Evq \
  '^[[:space:]]*(/System/Library/|/usr/lib/|@rpath/|@loader_path/|@executable_path/)' \
  <<<"${DEPENDENCIES}"; then
  printf '%s links to a non-system runtime library:\n' "${executable}" >&2
  otool -L "${executable}" >&2
  exit 1
fi

PATH="/usr/bin:/bin:/usr/sbin:/sbin" "${FFPROBE}" -hide_banner -version

for forbidden in ffmpeg fruit-truck-cli fruit-truckd; do
  [[ ! -e "${TOOLS_DIR}/${forbidden}-aarch64-apple-darwin" ]] || {
    printf 'Removed executable must not be bundled: %s\n' "${forbidden}" >&2
    exit 1
  }
done

printf 'Bundled Apple Silicon FFprobe validation passed.\n'
