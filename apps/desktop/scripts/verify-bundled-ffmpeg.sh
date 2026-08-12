#!/usr/bin/env bash

set -Eeuo pipefail

TOOLS_DIR="${1:?Path to the bundled-tools directory is required.}"
FFMPEG="${TOOLS_DIR}/ffmpeg-aarch64-apple-darwin"
FFPROBE="${TOOLS_DIR}/ffprobe-aarch64-apple-darwin"

for executable in "${FFMPEG}" "${FFPROBE}"; do
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
done

PATH="/usr/bin:/bin:/usr/sbin:/sbin" "${FFMPEG}" -hide_banner -version
ENCODERS="$(PATH="/usr/bin:/bin:/usr/sbin:/sbin" "${FFMPEG}" -hide_banner -encoders)"
DEMUXERS="$(PATH="/usr/bin:/bin:/usr/sbin:/sbin" "${FFMPEG}" -hide_banner -demuxers)"
DECODERS="$(PATH="/usr/bin:/bin:/usr/sbin:/sbin" "${FFMPEG}" -hide_banner -decoders)"
grep -q 'h264_videotoolbox' <<<"${ENCODERS}"
grep -Eq 'matroska|webm' <<<"${DEMUXERS}"
grep -Eq 'vp8|vp9|av1' <<<"${DECODERS}"
PATH="/usr/bin:/bin:/usr/sbin:/sbin" "${FFPROBE}" -hide_banner -version

printf 'Bundled Apple Silicon FFmpeg validation passed.\n'
