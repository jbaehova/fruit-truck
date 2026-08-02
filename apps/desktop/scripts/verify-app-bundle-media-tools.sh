#!/usr/bin/env bash

set -Eeuo pipefail

APP_BUNDLE="${1:?Path to Fruit Truck.app is required.}"
MACOS_DIR="${APP_BUNDLE}/Contents/MacOS"
RESOURCES_DIR="${APP_BUNDLE}/Contents/Resources"

[[ -d "${APP_BUNDLE}" ]] || {
  printf 'App bundle does not exist: %s\n' "${APP_BUNDLE}" >&2
  exit 1
}

for executable_name in ffmpeg ffprobe; do
  executable="${MACOS_DIR}/${executable_name}"
  [[ -x "${executable}" ]] || {
    printf 'Bundled media executable is missing: %s\n' "${executable}" >&2
    exit 1
  }
  archs="$(lipo -archs "${executable}")"
  [[ "${archs}" == *arm64* && "${archs}" == *x86_64* ]] || {
    printf '%s is not Universal: %s\n' "${executable}" "${archs}" >&2
    exit 1
  }
  dependencies="$(otool -L "${executable}" | grep -E '^[[:space:]]+(@|/)')"
  if grep -Evq \
    '^[[:space:]]*(/System/Library/|/usr/lib/|@rpath/|@loader_path/|@executable_path/)' \
    <<<"${dependencies}"; then
    printf '%s links to a non-system runtime library:\n' "${executable}" >&2
    otool -L "${executable}" >&2
    exit 1
  fi
  PATH="/usr/bin:/bin:/usr/sbin:/sbin" "${executable}" -hide_banner -version
done

for notice in \
  "${RESOURCES_DIR}/licenses/ffmpeg/COPYING.LGPLv2.1" \
  "${RESOURCES_DIR}/licenses/ffmpeg/FFmpeg-LICENSE.md" \
  "${RESOURCES_DIR}/licenses/ffmpeg/THIRD_PARTY_NOTICES.md"; do
  [[ -f "${notice}" ]] || {
    printf 'Bundled FFmpeg notice is missing: %s\n' "${notice}" >&2
    exit 1
  }
done

printf 'Fruit Truck.app contains self-contained Universal media tools.\n'
