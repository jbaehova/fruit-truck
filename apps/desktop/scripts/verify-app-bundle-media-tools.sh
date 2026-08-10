#!/usr/bin/env bash

set -Eeuo pipefail

APP_BUNDLE="${1:?Path to Fruit Truck.app is required.}"
MACOS_DIR="${APP_BUNDLE}/Contents/MacOS"
RESOURCES_DIR="${APP_BUNDLE}/Contents/Resources"

[[ -d "${APP_BUNDLE}" ]] || {
  printf 'App bundle does not exist: %s\n' "${APP_BUNDLE}" >&2
  exit 1
}

for executable_name in ffmpeg ffprobe fruit-truckd; do
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
  if [[ "${executable_name}" == fruit-truckd ]]; then
    file "${executable}" | grep -q 'Mach-O universal binary'
  else
    PATH="/usr/bin:/bin:/usr/sbin:/sbin" "${executable}" -hide_banner -version
  fi
  codesign --verify --strict "${executable}"
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

verification_home="$(mktemp -d "${TMPDIR:-/tmp}/fruit-truck-verify.XXXXXX")"
core_pid=""
cleanup() {
  if [[ -n "${core_pid}" ]]; then
    kill "${core_pid}" 2>/dev/null || true
    wait "${core_pid}" 2>/dev/null || true
  fi
  [[ "${verification_home}" == *"/fruit-truck-verify."* ]] && rm -rf -- "${verification_home}"
}
trap cleanup EXIT

"${MACOS_DIR}/fruit-truckd" --home "${verification_home}" >/dev/null 2>&1 &
core_pid="$!"
socket_path="${verification_home}/run/core.sock"
for _ in {1..100}; do
  [[ -S "${socket_path}" ]] && break
  kill -0 "${core_pid}" 2>/dev/null || {
    printf 'Bundled Fruit Truck Core exited before creating its socket.\n' >&2
    exit 1
  }
  sleep 0.05
done
[[ -S "${socket_path}" ]] || {
  printf 'Bundled Fruit Truck Core did not create its socket.\n' >&2
  exit 1
}

python3 - "${socket_path}" <<'PY'
import json
import socket
import sys

client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
client.settimeout(5)
client.connect(sys.argv[1])
client.sendall(b'{"jsonrpc":"2.0","id":1,"method":"core.handshake","params":{}}\n')
with client.makefile("rb") as stream:
    response = json.loads(stream.readline())
result = response.get("result", {})
if result.get("protocolVersion") != 2 or result.get("storeSchemaVersion") != 1:
    raise SystemExit(f"Unexpected bundled Core handshake: {response}")
PY

codesign --verify --deep --strict "${APP_BUNDLE}"

printf 'Fruit Truck.app contains signed, self-contained Universal media tools and a compatible Core.\n'
