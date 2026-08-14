#!/usr/bin/env bash

set -Eeuo pipefail

APP_BUNDLE="${1:?Path to Fruit Truck.app is required.}"
MACOS_DIR="${APP_BUNDLE}/Contents/MacOS"
RESOURCES_DIR="${APP_BUNDLE}/Contents/Resources"
FFPROBE="${MACOS_DIR}/ffprobe"

[[ -d "${APP_BUNDLE}" ]] || {
  printf 'App bundle does not exist: %s\n' "${APP_BUNDLE}" >&2
  exit 1
}
[[ -x "${FFPROBE}" ]] || {
  printf 'Bundled FFprobe executable is missing: %s\n' "${FFPROBE}" >&2
  exit 1
}
[[ "$(lipo -archs "${FFPROBE}")" == "arm64" ]]
dependencies="$(otool -L "${FFPROBE}" | grep -E '^[[:space:]]+(@|/)')"
if grep -Evq '^[[:space:]]*(/System/Library/|/usr/lib/|@rpath/|@loader_path/|@executable_path/)' <<<"${dependencies}"; then
  printf 'FFprobe links to a non-system runtime library:\n' >&2
  otool -L "${FFPROBE}" >&2
  exit 1
fi
PATH="/usr/bin:/bin:/usr/sbin:/sbin" "${FFPROBE}" -hide_banner -version
codesign --verify --strict "${FFPROBE}"

for forbidden in ffmpeg fruit-truck-cli fruit-truckd; do
  [[ ! -e "${MACOS_DIR}/${forbidden}" ]] || {
    printf 'Removed executable is still bundled: %s\n' "${forbidden}" >&2
    exit 1
  }
done
[[ ! -e "${RESOURCES_DIR}/agent-skills" ]] || {
  printf 'Removed workflow resources are still bundled.\n' >&2
  exit 1
}

for notice in \
  "${RESOURCES_DIR}/licenses/ffmpeg/COPYING.LGPLv2.1" \
  "${RESOURCES_DIR}/licenses/ffmpeg/FFmpeg-LICENSE.md" \
  "${RESOURCES_DIR}/licenses/ffmpeg/THIRD_PARTY_NOTICES.md"; do
  [[ -f "${notice}" ]] || {
    printf 'Bundled FFprobe notice is missing: %s\n' "${notice}" >&2
    exit 1
  }
done

codesign --verify --deep --strict "${APP_BUNDLE}"
printf 'Fruit Truck.app contains signed Apple Silicon FFprobe and no removed sidecars or workflow resources.\n'
