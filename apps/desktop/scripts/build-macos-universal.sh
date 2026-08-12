#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
desktop_dir="$(cd -- "${script_dir}/.." && pwd)"
build_root="$(mktemp -d "${TMPDIR:-/tmp}/fruit-truck-universal.XXXXXX")"
cleanup() {
  [[ "${build_root}" == *"/fruit-truck-universal."* ]] && rm -rf -- "${build_root}"
}
trap cleanup EXIT

bash "${script_dir}/build-ffmpeg-macos.sh" --arch arm64 --output-dir "${build_root}/arm64"
bash "${script_dir}/build-ffmpeg-macos.sh" --arch x86_64 --output-dir "${build_root}/x86_64"
bash "${script_dir}/assemble-universal-ffmpeg.sh" "${build_root}/arm64" "${build_root}/x86_64"
bash "${script_dir}/build-core-sidecar-universal.sh"
bash "${script_dir}/prepare-agent-runtime.sh" --universal

cd "${desktop_dir}"
npm run tauri -- build \
  --bundles dmg \
  --target universal-apple-darwin \
  --config src-tauri/tauri.release.conf.json

bundle_dir="src-tauri/target/universal-apple-darwin/release/bundle/dmg"
raw_dmg="$(find "$bundle_dir" -name 'Fruit Truck_*_universal.dmg' -print -quit)"
final_dmg="$bundle_dir/Fruit-Truck-macOS-universal.dmg"

if [[ -z "$raw_dmg" ]]; then
  echo "Universal DMG was not created." >&2
  exit 1
fi

notary_args=()
if [[ -n "${NOTARYTOOL_KEYCHAIN_PROFILE:-}" ]]; then
  notary_args=(--keychain-profile "$NOTARYTOOL_KEYCHAIN_PROFILE")
elif [[ -n "${APPLE_ID:-}" && -n "${APPLE_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]]; then
  notary_args=(--apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID")
else
  echo "Set NOTARYTOOL_KEYCHAIN_PROFILE or APPLE_ID, APPLE_PASSWORD, and APPLE_TEAM_ID to notarize the DMG." >&2
  exit 1
fi

xcrun notarytool submit "$raw_dmg" "${notary_args[@]}" --wait
xcrun stapler staple "$raw_dmg"
codesign --verify --strict --verbose=2 "$raw_dmg"
xcrun stapler validate "$raw_dmg"
spctl --assess --type open --context context:primary-signature --verbose=2 "$raw_dmg"

mount_dir="$(mktemp -d "${TMPDIR:-/tmp}/fruit-truck-dmg-mount.XXXXXX")"
mounted=false
cleanup_mount() {
  if [[ "$mounted" == true ]]; then
    hdiutil detach "$mount_dir" >/dev/null 2>&1 || true
  fi
  rmdir "$mount_dir" >/dev/null 2>&1 || true
}
trap 'cleanup_mount; cleanup' EXIT
hdiutil attach "$raw_dmg" -readonly -nobrowse -mountpoint "$mount_dir" >/dev/null
mounted=true
app_bundle="$mount_dir/Fruit Truck.app"
test -d "$app_bundle"
bash scripts/verify-app-bundle-media-tools.sh "$app_bundle"
codesign --verify --deep --strict --verbose=2 "$app_bundle"
spctl --assess --type execute --verbose=2 "$app_bundle"
hdiutil detach "$mount_dir" >/dev/null
mounted=false
rmdir "$mount_dir"

cp "$raw_dmg" "$final_dmg"
echo "Universal DMG ready: $final_dmg"
