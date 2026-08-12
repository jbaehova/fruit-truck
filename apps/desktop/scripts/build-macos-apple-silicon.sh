#!/usr/bin/env bash

set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
desktop_dir="$(cd -- "${script_dir}/.." && pwd)"

bash "${script_dir}/prepare-macos-release-assets.sh"

cd "${desktop_dir}"
npm run tauri -- build \
  --bundles dmg \
  --target aarch64-apple-darwin \
  --config src-tauri/tauri.release.conf.json

bundle_dir="src-tauri/target/aarch64-apple-darwin/release/bundle/dmg"
raw_dmg="$(find "${bundle_dir}" -name 'Fruit Truck_*_aarch64.dmg' -print -quit)"
final_dmg="${bundle_dir}/Fruit-Truck-macOS-Apple-Silicon.dmg"
[[ -n "${raw_dmg}" ]] || {
  printf 'Apple Silicon DMG was not created.\n' >&2
  exit 1
}

notary_args=()
if [[ -n "${NOTARYTOOL_KEYCHAIN_PROFILE:-}" ]]; then
  notary_args=(--keychain-profile "${NOTARYTOOL_KEYCHAIN_PROFILE}")
elif [[ -n "${APPLE_ID:-}" && -n "${APPLE_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]]; then
  notary_args=(--apple-id "${APPLE_ID}" --password "${APPLE_PASSWORD}" --team-id "${APPLE_TEAM_ID}")
else
  printf 'Set NOTARYTOOL_KEYCHAIN_PROFILE or APPLE_ID, APPLE_PASSWORD, and APPLE_TEAM_ID to notarize the DMG.\n' >&2
  exit 1
fi

xcrun notarytool submit "${raw_dmg}" "${notary_args[@]}" --wait
xcrun stapler staple "${raw_dmg}"
codesign --verify --strict --verbose=2 "${raw_dmg}"
xcrun stapler validate "${raw_dmg}"
spctl --assess --type open --context context:primary-signature --verbose=2 "${raw_dmg}"

mount_dir="$(mktemp -d "${TMPDIR:-/tmp}/fruit-truck-dmg-mount.XXXXXX")"
mounted=false
cleanup_mount() {
  if [[ "${mounted}" == true ]]; then
    hdiutil detach "${mount_dir}" >/dev/null 2>&1 || true
  fi
  rmdir "${mount_dir}" >/dev/null 2>&1 || true
}
trap cleanup_mount EXIT
hdiutil attach "${raw_dmg}" -readonly -nobrowse -mountpoint "${mount_dir}" >/dev/null
mounted=true
app_bundle="${mount_dir}/Fruit Truck.app"
[[ -d "${app_bundle}" ]]
bash scripts/verify-app-bundle-media-tools.sh "${app_bundle}"
codesign --verify --deep --strict --verbose=2 "${app_bundle}"
spctl --assess --type execute --verbose=2 "${app_bundle}"
hdiutil detach "${mount_dir}" >/dev/null
mounted=false
rmdir "${mount_dir}"

if [[ "${raw_dmg}" != "${final_dmg}" ]]; then
  cp -f -- "${raw_dmg}" "${final_dmg}"
fi
printf 'Apple Silicon DMG ready: %s\n' "${final_dmg}"
