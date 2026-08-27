#!/usr/bin/env bash

set -Eeuo pipefail

APP_BUNDLE="${1:?Path to a packaged Fruit Truck.app is required.}"
SMOKE_SECONDS="${FRUIT_TRUCK_NATIVE_SMOKE_SECONDS:-8}"

[[ "$(uname -s)" == "Darwin" ]] || {
  printf 'The packaged-app smoke test requires macOS.\n' >&2
  exit 1
}
[[ -d "${APP_BUNDLE}" ]] || {
  printf 'App bundle does not exist: %s\n' "${APP_BUNDLE}" >&2
  exit 1
}

info_plist="${APP_BUNDLE}/Contents/Info.plist"
[[ -f "${info_plist}" ]] || {
  printf 'App bundle is missing Info.plist: %s\n' "${info_plist}" >&2
  exit 1
}
bundle_executable="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "${info_plist}")"
binary="${APP_BUNDLE}/Contents/MacOS/${bundle_executable}"
[[ -x "${binary}" ]] || {
  printf 'App bundle executable is missing or not executable: %s\n' "${binary}" >&2
  exit 1
}

smoke_parent="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
[[ -d "${smoke_parent}" ]] || {
  printf 'Native smoke temporary directory does not exist: %s\n' "${smoke_parent}" >&2
  exit 1
}
# macOS exposes /var as a symlink to /private/var. Resolve that system alias so
# the app still exercises its deliberate custom-root symlink rejection instead
# of failing on the test harness path itself.
smoke_parent="$(cd -- "${smoke_parent}" && pwd -P)"
smoke_root="$(mktemp -d "${smoke_parent}/fruit-truck-native-smoke.XXXXXX")"
log_path="${smoke_root}/app.log"
data_root="${smoke_root}/data"
workspace_path="${data_root}/workspace/workspace-state-v1.json"
FRUIT_TRUCK_HOME="${smoke_root}/data" \
  CI=true \
  "${binary}" >"${log_path}" 2>&1 &
app_pid=$!

cleanup() {
  if kill -0 "${app_pid}" >/dev/null 2>&1; then
    kill -TERM "${app_pid}" >/dev/null 2>&1 || true
    for _ in 1 2 3 4 5; do
      kill -0 "${app_pid}" >/dev/null 2>&1 || break
      sleep 1
    done
    kill -KILL "${app_pid}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

wait_for_workspace() {
  local required_asset_name="${1:-}"
  local elapsed=0
  while (( elapsed < SMOKE_SECONDS )); do
    if [[ -s "${workspace_path}" ]] && jq -e \
      --arg asset_name "${required_asset_name}" \
      '.schema_version == 1
        and (.checksum | test("^[0-9a-f]{64}$"))
        and (.payload.schemaVersion == 6)
        and ($asset_name == "" or any(.payload.sessions[].assets[]?; .name == $asset_name))' \
      "${workspace_path}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  return 1
}

assert_private_mode() {
  local path="$1"
  local expected="$2"
  local actual
  actual="$(stat -f '%Lp' "${path}")"
  [[ "${actual}" == "${expected}" ]] || {
    printf 'Native smoke path %s has mode %s; expected %s.\n' "${path}" "${actual}" "${expected}" >&2
    exit 1
  }
}

if ! wait_for_workspace; then
  printf 'Packaged app did not create a valid native workspace within %ss. Log: %s\n' "${SMOKE_SECONDS}" "${log_path}" >&2
  sed -n '1,200p' "${log_path}" >&2 || true
  exit 1
fi
if ! kill -0 "${app_pid}" >/dev/null 2>&1; then
  wait "${app_pid}" || {
    printf 'Packaged app exited before the native smoke window. Log: %s\n' "${log_path}" >&2
    sed -n '1,160p' "${log_path}" >&2 || true
    exit 1
  }
fi

assert_private_mode "${data_root}" 700
assert_private_mode "${data_root}/workspace" 700
assert_private_mode "${workspace_path}" 600
initial_session_id="$(jq -er '.payload.activeSessionId | select(length > 0)' "${workspace_path}")"

printf 'Packaged app launched with a valid private native workspace using %s.\n' "${bundle_executable}"

# Reuse the exact same native home on a second launch. This catches packaged
# startup state that only works on a pristine first run and exercises the
# relaunch/recovery path without automating or focusing the window.
cleanup
wait "${app_pid}" >/dev/null 2>&1 || true

# Place a valid image into the configured custom managed root. Startup
# reconciliation must recover this orphan into the durable workspace on the
# second launch, proving that the packaged binary and the renderer agree on
# the runtime root without relying on a build-time asset-protocol scope.
mkdir -p "${data_root}/assets"
assert_private_mode "${data_root}/assets" 700
printf '%s' 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' | \
  base64 --decode > "${data_root}/assets/native-smoke.png"
chmod 600 "${data_root}/assets/native-smoke.png"
FRUIT_TRUCK_HOME="${smoke_root}/data" \
  CI=true \
  "${binary}" >>"${log_path}" 2>&1 &
app_pid=$!
if ! wait_for_workspace "native-smoke.png"; then
  printf 'Packaged app did not reconcile the custom-root media fixture within %ss. Log: %s\n' "${SMOKE_SECONDS}" "${log_path}" >&2
  sed -n '1,240p' "${log_path}" >&2 || true
  exit 1
fi
if ! kill -0 "${app_pid}" >/dev/null 2>&1; then
  wait "${app_pid}" || {
    printf 'Packaged app exited during the same-home relaunch smoke. Log: %s\n' "${log_path}" >&2
    sed -n '1,200p' "${log_path}" >&2 || true
    exit 1
  }
fi

[[ "$(jq -r '.payload.activeSessionId' "${workspace_path}")" == "${initial_session_id}" ]] || {
  printf 'Packaged app replaced the durable session during same-home relaunch.\n' >&2
  exit 1
}
assert_private_mode "${workspace_path}" 600
assert_private_mode "${data_root}/assets/native-smoke.png" 600
[[ -s "${workspace_path}.bak1" ]] || {
  printf 'Packaged app did not retain a last-known-good native workspace backup.\n' >&2
  exit 1
}
if find "${data_root}" -type f \( -name '*.tmp' -o -name '*.part' \) -print -quit | grep -q .; then
  printf 'Packaged app left a partial native file after relaunch.\n' >&2
  exit 1
fi

printf 'Packaged app relaunched with the same session and reconciled custom-root media durably.\n'
