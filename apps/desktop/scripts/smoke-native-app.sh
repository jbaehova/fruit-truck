#!/usr/bin/env bash

set -Eeuo pipefail

APP_BUNDLE="${1:?Path to the notarized release Fruit Truck.app is required.}"
UPDATER_ARTIFACT="${2:?Path to the signed .app.tar.gz updater artifact is required.}"
UPDATER_SIGNATURE="${3:?Path to the updater .sig is required.}"
PRIOR_TAG="${4:?The published prior release tag is required.}"
TIMEOUT_SECONDS="${FRUIT_TRUCK_PACKAGED_UPDATE_TIMEOUT_SECONDS:-180}"
expected_video_status_path="/videos/provider-video-job-phase3"

[[ "$(uname -s)" == "Darwin" ]] || {
  printf 'The real packaged updater smoke requires macOS.\n' >&2
  exit 1
}
[[ "${CI:-}" == "true" && "${GITHUB_ACTIONS:-}" == "true" ]] || {
  printf 'The real packaged updater smoke launches signed app bundles and is restricted to an isolated GitHub Actions runner.\n' >&2
  exit 1
}

for command_name in codesign ditto git jq minisign node npm pgrep security shasum spctl uuidgen xcrun; do
  command -v "${command_name}" >/dev/null 2>&1 || {
    printf 'Missing packaged updater smoke tool: %s\n' "${command_name}" >&2
    exit 1
  }
done
for path in "${APP_BUNDLE}" "${UPDATER_ARTIFACT}" "${UPDATER_SIGNATURE}"; do
  [[ -e "${path}" ]] || {
    printf 'Packaged updater smoke input does not exist: %s\n' "${path}" >&2
    exit 1
  }
done
[[ "${PRIOR_TAG}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  printf 'Prior release tag is invalid: %s\n' "${PRIOR_TAG}" >&2
  exit 1
}
[[ "${TIMEOUT_SECONDS}" =~ ^[0-9]+$ ]] && (( TIMEOUT_SECONDS >= 30 && TIMEOUT_SECONDS <= 900 )) || {
  printf 'FRUIT_TRUCK_PACKAGED_UPDATE_TIMEOUT_SECONDS must be an integer from 30 to 900.\n' >&2
  exit 1
}

for secret_name in APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID; do
  [[ -n "${!secret_name:-}" ]] || {
    printf 'Missing prior-app notarization credential: %s\n' "${secret_name}" >&2
    exit 1
  }
done

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
desktop_root="$(cd -- "${script_dir}/.." && pwd)"
repository_root="$(cd -- "${desktop_root}/../.." && pwd)"
smoke_parent="$(cd -- "${RUNNER_TEMP:?RUNNER_TEMP is required on the release runner.}" && pwd -P)"
smoke_root="$(mktemp -d "${smoke_parent}/fruit-truck-packaged-update.XXXXXX")"
prior_worktree="${smoke_root}/prior-source"
prior_target="${smoke_root}/prior-target"
install_root="${smoke_root}/install"
installed_app="${install_root}/Fruit Truck.app"
data_root="${smoke_root}/data"
status_path="${smoke_root}/server-status.json"
server_log="${smoke_root}/server.log"
app_log="${smoke_root}/app.log"
server_pid=""
app_pid=""
installed_binary=""
smoke_keychain=""
smoke_keychain_password=""
original_keychains=()

cleanup() {
  set +e
  if [[ -n "${app_pid}" ]]; then
    kill -TERM "${app_pid}" >/dev/null 2>&1 || true
  fi
  if [[ -n "${installed_binary}" ]]; then
    while IFS= read -r candidate_pid; do
      [[ "${candidate_pid}" =~ ^[0-9]+$ ]] && kill -TERM "${candidate_pid}" >/dev/null 2>&1 || true
    done < <(pgrep -f -- "${installed_binary}" 2>/dev/null || true)
  fi
  if [[ -n "${server_pid}" ]]; then
    kill -TERM "${server_pid}" >/dev/null 2>&1 || true
  fi
  if [[ -n "${smoke_keychain}" ]]; then
    if (( ${#original_keychains[@]} )); then
      security list-keychains -d user -s "${original_keychains[@]}" >/dev/null 2>&1 || true
    fi
    security delete-keychain "${smoke_keychain}" >/dev/null 2>&1 || true
  fi
  if [[ -d "${prior_worktree}/.git" || -f "${prior_worktree}/.git" ]]; then
    git -C "${repository_root}" worktree remove --force "${prior_worktree}" >/dev/null 2>&1 || true
  fi
  if [[ "${smoke_root}" == "${smoke_parent}"/fruit-truck-packaged-update.* ]]; then
    rm -rf -- "${smoke_root}"
  fi
}
trap cleanup EXIT INT TERM

new_info="${APP_BUNDLE}/Contents/Info.plist"
[[ -f "${new_info}" ]]
new_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "${new_info}")"
new_executable="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "${new_info}")"
new_binary="${APP_BUNDLE}/Contents/MacOS/${new_executable}"
[[ -x "${new_binary}" ]]
[[ "v${new_version}" != "${PRIOR_TAG}" ]] || {
  printf 'The prior release tag equals the new app version: %s\n' "${PRIOR_TAG}" >&2
  exit 1
}

signing_identity="$(jq -er '.bundle.macOS.signingIdentity' "${desktop_root}/src-tauri/tauri.conf.json")"
export APPLE_SIGNING_IDENTITY="${signing_identity}"
if ! security find-identity -v -p codesigning | grep -F -- "${signing_identity}" >/dev/null; then
  while IFS= read -r keychain; do
    keychain="${keychain#\"}"
    keychain="${keychain%\"}"
    [[ -n "${keychain}" ]] && original_keychains+=("${keychain}")
  done < <(security list-keychains -d user | sed 's/^[[:space:]]*//')
  smoke_keychain="${smoke_root}/packaged-update-signing.keychain-db"
  smoke_keychain_password="$(uuidgen)"
  certificate_path="${smoke_root}/developer-id.p12"
  printf '%s' "${APPLE_CERTIFICATE}" | base64 --decode > "${certificate_path}"
  chmod 600 "${certificate_path}"
  security create-keychain -p "${smoke_keychain_password}" "${smoke_keychain}"
  security set-keychain-settings -lut 21600 "${smoke_keychain}"
  security unlock-keychain -p "${smoke_keychain_password}" "${smoke_keychain}"
  security import "${certificate_path}" \
    -k "${smoke_keychain}" \
    -P "${APPLE_CERTIFICATE_PASSWORD}" \
    -T /usr/bin/codesign \
    -T /usr/bin/security
  security set-key-partition-list \
    -S apple-tool:,apple: \
    -s \
    -k "${smoke_keychain_password}" \
    "${smoke_keychain}"
  security list-keychains -d user -s "${smoke_keychain}" "${original_keychains[@]}"
  security find-identity -v -p codesigning "${smoke_keychain}" | grep -F -- "${signing_identity}" >/dev/null || {
    printf 'The imported certificate does not contain the configured Developer ID identity.\n' >&2
    exit 1
  }
fi

# Verify the exact updater bytes before they are exposed to the old app.
jq -r '.plugins.updater.pubkey' "${desktop_root}/src-tauri/tauri.conf.json" | \
  base64 --decode > "${smoke_root}/updater-public.key"
base64 --decode < "${UPDATER_SIGNATURE}" > "${smoke_root}/updater-signature.minisig"
minisign -Vm "${UPDATER_ARTIFACT}" \
  -p "${smoke_root}/updater-public.key" \
  -x "${smoke_root}/updater-signature.minisig"

port="$(node -e 'const net=require("node:net");const s=net.createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close();});')"
origin="http://127.0.0.1:${port}"

node "${script_dir}/packaged-update-smoke.mjs" prepare-source \
  --data-root "${data_root}" > "${smoke_root}/source-report.json"

node "${script_dir}/packaged-update-smoke.mjs" serve \
  --port "${port}" \
  --artifact "${UPDATER_ARTIFACT}" \
  --signature "${UPDATER_SIGNATURE}" \
  --data-root "${data_root}" \
  --status "${status_path}" \
  --from-version "${PRIOR_TAG#v}" \
  --to-version "${new_version}" > "${server_log}" 2>&1 &
server_pid=$!
for _ in {1..100}; do
  [[ -s "${status_path}" ]] && jq -e '.ready == true' "${status_path}" >/dev/null 2>&1 && break
  kill -0 "${server_pid}" >/dev/null 2>&1 || {
    printf 'The local updater server exited before becoming ready.\n' >&2
    sed -n '1,200p' "${server_log}" >&2 || true
    exit 1
  }
  sleep 0.1
done
jq -e '.ready == true' "${status_path}" >/dev/null

# Build the immutable release commit with only its package version and updater
# endpoint overridden. This keeps the complete production update transaction
# implementation in the test bundle while making it a valid prior version.
git -C "${repository_root}" worktree add --detach "${prior_worktree}" HEAD
npm ci --prefix "${prior_worktree}/apps/desktop"
node "${script_dir}/packaged-update-smoke.mjs" prepare-prior \
  --worktree "${prior_worktree}" \
  --origin "${origin}" \
  --from-version "${PRIOR_TAG#v}" \
  --to-version "${new_version}" > "${smoke_root}/prior-config-report.json"
npm run build --prefix "${prior_worktree}/apps/desktop"
node "${script_dir}/packaged-update-smoke.mjs" inject-prior \
  --worktree "${prior_worktree}" \
  --origin "${origin}" \
  --to-version "${new_version}" > "${smoke_root}/prior-driver-report.json"

prior_tauri="${prior_worktree}/apps/desktop/src-tauri"
mkdir -p "${prior_tauri}/target"
ditto "${desktop_root}/src-tauri/target/bundled-tools" "${prior_tauri}/target/bundled-tools"
(
  cd -- "${prior_worktree}/apps/desktop"
  CARGO_TARGET_DIR="${prior_target}" npx tauri build \
    --target aarch64-apple-darwin \
    --bundles app \
    --config src-tauri/packaged-update-smoke.conf.json
)

prior_app="$(find "${prior_target}/aarch64-apple-darwin/release/bundle/macos" -name 'Fruit Truck.app' -print -quit)"
[[ -n "${prior_app}" && -d "${prior_app}" ]]
prior_info="${prior_app}/Contents/Info.plist"
prior_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "${prior_info}")"
[[ "v${prior_version}" == "${PRIOR_TAG}" ]] || {
  printf 'The prior bundle version %s does not match %s.\n' "${prior_version}" "${PRIOR_TAG}" >&2
  exit 1
}

codesign --verify --deep --strict --verbose=2 "${prior_app}"
codesign -dv --verbose=4 "${prior_app}" 2>&1 | grep -F 'Authority=Developer ID Application:' >/dev/null
if ! xcrun stapler validate "${prior_app}" >/dev/null 2>&1; then
  prior_zip="${smoke_root}/prior-notarization.zip"
  ditto -c -k --keepParent "${prior_app}" "${prior_zip}"
  xcrun notarytool submit "${prior_zip}" \
    --apple-id "${APPLE_ID}" \
    --password "${APPLE_PASSWORD}" \
    --team-id "${APPLE_TEAM_ID}" \
    --wait
  xcrun stapler staple "${prior_app}"
fi
xcrun stapler validate "${prior_app}"
spctl --assess --type execute --verbose=2 "${prior_app}"

mkdir -p "${install_root}"
ditto "${prior_app}" "${installed_app}"
installed_executable="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "${installed_app}/Contents/Info.plist")"
installed_binary="${installed_app}/Contents/MacOS/${installed_executable}"
prior_binary_sha="$(shasum -a 256 "${installed_binary}" | awk '{print $1}')"

# The prior test bundle has a hidden, non-focused window. Its injected script
# clicks the real update prompt through DOM APIs and delegates updater IPC to
# the unmodified Tauri updater plugin.
FRUIT_TRUCK_HOME="${data_root}" \
  CI=true \
  "${installed_binary}" > "${app_log}" 2>&1 &
app_pid=$!

deadline=$((SECONDS + TIMEOUT_SECONDS))
while (( SECONDS < deadline )); do
  if [[ -s "${status_path}" ]] && jq -e '.error != null' "${status_path}" >/dev/null 2>&1; then
    jq -r '.error' "${status_path}" >&2
    exit 1
  fi
  installed_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "${installed_app}/Contents/Info.plist" 2>/dev/null || true)"
  transaction_phase="$(jq -r '.phase // empty' "${data_root}/update-transactions/current.json" 2>/dev/null || true)"
  video_status_polled="$(jq -er --arg expected_path "${expected_video_status_path}" \
    '.events | any(.type == "video-status-polled" and .detail.path == $expected_path)' \
    "${status_path}" 2>/dev/null || true)"
  if [[ "${installed_version}" == "${new_version}" && "${transaction_phase}" == "complete" && "${video_status_polled}" == "true" ]]; then
    break
  fi
  sleep 1
done

installed_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "${installed_app}/Contents/Info.plist" 2>/dev/null || true)"
transaction_phase="$(jq -r '.phase // empty' "${data_root}/update-transactions/current.json" 2>/dev/null || true)"
video_status_polled="$(jq -er --arg expected_path "${expected_video_status_path}" \
  '.events | any(.type == "video-status-polled" and .detail.path == $expected_path)' \
  "${status_path}" 2>/dev/null || true)"
if [[ "${installed_version}" != "${new_version}" || "${transaction_phase}" != "complete" || "${video_status_polled}" != "true" ]]; then
  printf 'The real updater did not replace and verify the app or resume the expected video poll within %ss. Installed=%s transaction=%s video_poll=%s\n' \
    "${TIMEOUT_SECONDS}" "${installed_version:-missing}" "${transaction_phase:-missing}" "${video_status_polled:-missing}" >&2
  sed -n '1,240p' "${server_log}" >&2 || true
  sed -n '1,240p' "${app_log}" >&2 || true
  exit 1
fi

new_binary_sha="$(shasum -a 256 "${installed_binary}" | awk '{print $1}')"
[[ "${new_binary_sha}" != "${prior_binary_sha}" ]] || {
  printf 'The updater did not replace the prior executable bytes.\n' >&2
  exit 1
}
[[ "${new_binary_sha}" == "$(shasum -a 256 "${new_binary}" | awk '{print $1}')" ]] || {
  printf 'The installed updater executable differs from the release app executable.\n' >&2
  exit 1
}
codesign --verify --deep --strict --verbose=2 "${installed_app}"
xcrun stapler validate "${installed_app}"
spctl --assess --type execute --verbose=2 "${installed_app}"

node "${script_dir}/packaged-update-smoke.mjs" verify \
  --data-root "${data_root}" \
  --status "${status_path}" \
  --from-version "${prior_version}" \
  --to-version "${new_version}" > "${smoke_root}/verification-report.json"

printf 'Real packaged updater replaced notarized Fruit Truck %s with %s and completed the v6 to v8 transaction.\n' \
  "${prior_version}" "${new_version}"
printf 'Verified exact managed-asset bytes, legacy prompt history, Director plan bytes, session identity, and resumable video metadata.\n'
