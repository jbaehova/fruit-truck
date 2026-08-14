#!/usr/bin/env bash

set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
desktop_dir="$(cd -- "${script_dir}/.." && pwd)"
tools_dir="${desktop_dir}/src-tauri/target/bundled-tools"
license_dir="${tools_dir}/licenses/ffmpeg"
source_archive=""

if [[ "${1:-}" == "--source-archive" ]]; then
  source_archive="${2:?--source-archive requires a path}"
  shift 2
fi
if (( $# > 0 )); then
  printf 'Usage: prepare-macos-release-assets.sh [--source-archive PATH]\n' >&2
  exit 2
fi
[[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]] || {
  printf 'Fruit Truck releases must be prepared on Apple Silicon macOS.\n' >&2
  exit 1
}

build_dir="$(mktemp -d "${TMPDIR:-/tmp}/fruit-truck-release-assets.XXXXXX")"
cleanup() {
  [[ "${build_dir}" == *"/fruit-truck-release-assets."* ]] && rm -rf -- "${build_dir}"
}
trap cleanup EXIT

ffmpeg_args=(--output-dir "${build_dir}/ffmpeg")
if [[ -n "${source_archive}" ]]; then
  ffmpeg_args+=(--source-archive "${source_archive}")
fi
bash "${script_dir}/build-ffmpeg-macos.sh" "${ffmpeg_args[@]}"

mkdir -p -- "${tools_dir}" "${license_dir}"
cp -f -- \
  "${build_dir}/ffmpeg/ffprobe" \
  "${tools_dir}/ffprobe-aarch64-apple-darwin"
chmod 0755 "${tools_dir}/ffprobe-aarch64-apple-darwin"
rm -f -- \
  "${tools_dir}/ffmpeg-aarch64-apple-darwin" \
  "${tools_dir}/fruit-truck-cli-aarch64-apple-darwin" \
  "${tools_dir}/fruit-truckd-aarch64-apple-darwin"
cp -f -- "${build_dir}/ffmpeg/COPYING.LGPLv2.1" "${license_dir}/COPYING.LGPLv2.1"
cp -f -- "${build_dir}/ffmpeg/FFmpeg-LICENSE.md" "${license_dir}/FFmpeg-LICENSE.md"
cp -f -- "${build_dir}/ffmpeg/build-config-arm64.txt" "${license_dir}/build-config-arm64.txt"
cp -f -- "${desktop_dir}/../../THIRD_PARTY_NOTICES.md" "${license_dir}/THIRD_PARTY_NOTICES.md"

bash "${script_dir}/verify-bundled-ffmpeg.sh" "${tools_dir}"

printf 'Prepared the Apple Silicon FFprobe release asset.\n'
