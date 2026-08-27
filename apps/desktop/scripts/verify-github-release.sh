#!/usr/bin/env bash

set -Eeuo pipefail

RELEASE_TAG="${1:?A v-prefixed release tag is required.}"
REPOSITORY="${2:-${GITHUB_REPOSITORY:-jbaehova/fruit-truck}}"
SOURCE_ROOT="${3:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)}"

for command_name in base64 codesign gh jq shasum spctl tar xcrun; do
  command -v "${command_name}" >/dev/null 2>&1 || {
    printf 'Missing release verification tool: %s\n' "${command_name}" >&2
    exit 1
  }
done

[[ "${RELEASE_TAG}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  printf 'Release tag must be a stable v-prefixed semantic version: %s\n' "${RELEASE_TAG}" >&2
  exit 2
}

release_json="$(gh release view "${RELEASE_TAG}" --repo "${REPOSITORY}" --json tagName,assets 2>/dev/null || true)"
[[ -n "${release_json}" ]] || {
  printf 'GitHub Release does not exist: %s\n' "${RELEASE_TAG}" >&2
  exit 1
}
asset_names="$(jq -r '.assets[].name' <<<"${release_json}")"
required_assets=(
  "Fruit-Truck-macOS-universal.dmg"
  "Fruit-Truck-macOS-universal.app.tar.gz"
  "Fruit-Truck-macOS-universal.app.tar.gz.sig"
  "latest.json"
  "Fruit-Truck-ffmpeg-source.tar.xz"
  "Fruit-Truck-ffmpeg-build-config-arm64.txt"
  "Fruit-Truck-ffmpeg-source.sha256"
)
for asset_name in "${required_assets[@]}"; do
  grep -Fxq "${asset_name}" <<<"${asset_names}" || {
    printf 'Required release asset is missing from %s: %s\n' "${RELEASE_TAG}" "${asset_name}" >&2
    exit 1
  }
done
[[ "$(wc -l <<<"${asset_names}" | tr -d ' ')" == "${#required_assets[@]}" ]] || {
  printf 'Release %s contains unexpected assets:\n%s\n' "${RELEASE_TAG}" "${asset_names}" >&2
  exit 1
}

command -v minisign >/dev/null 2>&1 || {
  printf 'Missing release verification tool: minisign\n' >&2
  exit 1
}

verification_dir="$(mktemp -d "${TMPDIR:-/tmp}/fruit-truck-release.XXXXXX")"
cleanup() {
  [[ "${verification_dir}" == *"/fruit-truck-release."* ]] && rm -rf -- "${verification_dir}"
}
trap cleanup EXIT

for pattern in \
  'Fruit-Truck-macOS-universal.dmg' \
  latest.json \
  'Fruit-Truck-macOS-universal.app.tar.gz' \
  'Fruit-Truck-macOS-universal.app.tar.gz.sig' \
  'Fruit-Truck-ffmpeg-source.tar.xz' \
  'Fruit-Truck-ffmpeg-build-config-arm64.txt' \
  'Fruit-Truck-ffmpeg-source.sha256'; do
  asset_url="$(jq -r --arg name "${pattern}" '.assets[] | select(.name == $name) | .apiUrl' <<<"${release_json}")"
  [[ -n "${asset_url}" && "${asset_url}" != "null" ]]
  gh api "${asset_url}" \
    --header 'Accept: application/octet-stream' \
    > "${verification_dir}/${pattern}"
done

# The source-disclosure assets are part of the same release contract as the
# installer. Verify both the archive digest and the configure/source metadata
# against the pinned values used by the release build.
# shellcheck source=ffmpeg-version.env
source "${SOURCE_ROOT}/apps/desktop/scripts/ffmpeg-version.env"
source_archive="${verification_dir}/Fruit-Truck-ffmpeg-source.tar.xz"
checksum_manifest="${verification_dir}/Fruit-Truck-ffmpeg-source.sha256"
(cd "${verification_dir}" && shasum -a 256 --check "${checksum_manifest##*/}")
printf '%s  %s\n' "${FFMPEG_SHA256}" "Fruit-Truck-ffmpeg-source.tar.xz" | \
  cmp -s - "${checksum_manifest}" || {
    printf 'Published FFmpeg checksum manifest does not match ffmpeg-version.env.\n' >&2
    exit 1
  }
grep -Fqx "FFmpeg version: ${FFMPEG_VERSION}" \
  "${verification_dir}/Fruit-Truck-ffmpeg-build-config-arm64.txt"
grep -Fqx "Source: ${FFMPEG_SOURCE_URL}" \
  "${verification_dir}/Fruit-Truck-ffmpeg-build-config-arm64.txt"
grep -Fqx "Source SHA-256: ${FFMPEG_SHA256}" \
  "${verification_dir}/Fruit-Truck-ffmpeg-build-config-arm64.txt"
tar -tJf "${source_archive}" | grep -Eq "^ffmpeg-${FFMPEG_VERSION}/" || {
  printf 'Published FFmpeg source archive has an unexpected top-level directory.\n' >&2
  exit 1
}

expected_version="${RELEASE_TAG#v}"
jq -e --arg version "${expected_version}" '.version == $version' "${verification_dir}/latest.json" >/dev/null

updater_api_url="$(jq -r '.assets[] | select(.name == "Fruit-Truck-macOS-universal.app.tar.gz") | .apiUrl' <<<"${release_json}")"
updater_browser_url="https://github.com/${REPOSITORY}/releases/download/${RELEASE_TAG}/Fruit-Truck-macOS-universal.app.tar.gz"
signature="$(<"${verification_dir}/Fruit-Truck-macOS-universal.app.tar.gz.sig")"
for platform in darwin-aarch64 darwin-aarch64-app; do
  jq -e \
    --arg platform "${platform}" \
    --arg signature "${signature}" \
    --arg api_url "${updater_api_url}" \
    --arg browser_url "${updater_browser_url}" \
    '.platforms[$platform].signature == $signature and (.platforms[$platform].url == $api_url or .platforms[$platform].url == $browser_url)' \
    "${verification_dir}/latest.json" >/dev/null || {
      printf 'latest.json has an invalid updater mapping for %s.\n' "${platform}" >&2
      exit 1
    }
done
jq -e '
  (.platforms | keys | length) == 2 and
  (.platforms | keys | all(. == "darwin-aarch64" or . == "darwin-aarch64-app"))
' "${verification_dir}/latest.json" >/dev/null || {
  printf 'latest.json contains a non-Apple-Silicon updater mapping.\n' >&2
  exit 1
}

jq -r '.plugins.updater.pubkey' "${SOURCE_ROOT}/apps/desktop/src-tauri/tauri.conf.json" | \
  base64 --decode > "${verification_dir}/updater-public.key"
base64 --decode \
  < "${verification_dir}/Fruit-Truck-macOS-universal.app.tar.gz.sig" \
  > "${verification_dir}/updater-signature.minisig"
minisign -Vm "${verification_dir}/Fruit-Truck-macOS-universal.app.tar.gz" \
  -p "${verification_dir}/updater-public.key" \
  -x "${verification_dir}/updater-signature.minisig"

dmg_digest="$(jq -r '.assets[] | select(.name == "Fruit-Truck-macOS-universal.dmg") | .digest' <<<"${release_json}")"
[[ "${dmg_digest}" =~ ^sha256:[0-9a-f]{64}$ ]] || {
  printf 'Published DMG is missing its GitHub SHA-256 digest.\n' >&2
  exit 1
}
dmg_path="${verification_dir}/Fruit-Truck-macOS-universal.dmg"
published_dmg_sha="$(shasum -a 256 "${dmg_path}" | awk '{print $1}')"
[[ "sha256:${published_dmg_sha}" == "${dmg_digest}" ]] || {
  printf 'Downloaded DMG bytes do not match the GitHub SHA-256 digest.\n' >&2
  exit 1
}
codesign --verify --strict --verbose=2 "${dmg_path}"
xcrun stapler validate "${dmg_path}"
spctl --assess --type open --context context:primary-signature --verbose=2 "${dmg_path}"

printf 'GitHub Release %s contains the notarized DMG, signed updater assets, and verified FFmpeg source-disclosure assets.\n' "${RELEASE_TAG}"
