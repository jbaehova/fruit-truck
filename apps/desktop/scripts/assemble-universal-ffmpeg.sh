#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
ARM64_DIR="${1:?Path to the arm64 FFmpeg artifact is required.}"
X86_64_DIR="${2:?Path to the x86_64 FFmpeg artifact is required.}"
OUTPUT_DIR="${DESKTOP_DIR}/src-tauri/target/bundled-tools"
LICENSE_DIR="${OUTPUT_DIR}/licenses/ffmpeg"

mkdir -p -- "${OUTPUT_DIR}" "${LICENSE_DIR}"

for executable in ffmpeg ffprobe; do
  [[ -f "${ARM64_DIR}/${executable}" ]] || {
    printf 'Missing arm64 binary: %s\n' "${ARM64_DIR}/${executable}" >&2
    exit 1
  }
  [[ -f "${X86_64_DIR}/${executable}" ]] || {
    printf 'Missing x86_64 binary: %s\n' "${X86_64_DIR}/${executable}" >&2
    exit 1
  }
  cp -f -- \
    "${ARM64_DIR}/${executable}" \
    "${OUTPUT_DIR}/${executable}-aarch64-apple-darwin"
  cp -f -- \
    "${X86_64_DIR}/${executable}" \
    "${OUTPUT_DIR}/${executable}-x86_64-apple-darwin"
  lipo -create \
    "${ARM64_DIR}/${executable}" \
    "${X86_64_DIR}/${executable}" \
    -output "${OUTPUT_DIR}/${executable}-universal-apple-darwin"
  chmod 0755 \
    "${OUTPUT_DIR}/${executable}-aarch64-apple-darwin" \
    "${OUTPUT_DIR}/${executable}-x86_64-apple-darwin" \
    "${OUTPUT_DIR}/${executable}-universal-apple-darwin"
done

cp -f -- "${ARM64_DIR}/COPYING.LGPLv2.1" "${LICENSE_DIR}/COPYING.LGPLv2.1"
cp -f -- "${ARM64_DIR}/FFmpeg-LICENSE.md" "${LICENSE_DIR}/FFmpeg-LICENSE.md"
cp -f -- "${ARM64_DIR}/build-config-arm64.txt" "${LICENSE_DIR}/build-config-arm64.txt"
cp -f -- "${X86_64_DIR}/build-config-x86_64.txt" "${LICENSE_DIR}/build-config-x86_64.txt"
cp -f -- "${DESKTOP_DIR}/../../THIRD_PARTY_NOTICES.md" "${LICENSE_DIR}/THIRD_PARTY_NOTICES.md"

"${SCRIPT_DIR}/verify-bundled-ffmpeg.sh" "${OUTPUT_DIR}"
