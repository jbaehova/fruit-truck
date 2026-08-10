#!/usr/bin/env bash

set -Eeuo pipefail

RELEASE_TAG="${1:?A v-prefixed release tag is required.}"
REPOSITORY="${2:-${GITHUB_REPOSITORY:-jbaehova/fruit-truck}}"
SOURCE_ROOT="${3:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)}"
# shellcheck source=ffmpeg-version.env
source "${SOURCE_ROOT}/apps/desktop/scripts/ffmpeg-version.env"

for command_name in base64 gh jq shasum; do
  command -v "${command_name}" >/dev/null 2>&1 || {
    printf 'Missing release verification tool: %s\n' "${command_name}" >&2
    exit 1
  }
done

[[ "${RELEASE_TAG}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  printf 'Release tag must be a stable v-prefixed semantic version: %s\n' "${RELEASE_TAG}" >&2
  exit 2
}

release_json="$(gh api --paginate --slurp "repos/${REPOSITORY}/releases?per_page=100" | \
  jq -c --arg tag "${RELEASE_TAG}" \
    '[.[][] | select(.tag_name == $tag)][0] // empty | {tagName: .tag_name, assets: [.assets[] | {name, apiUrl: .url, digest}]}')"
[[ -n "${release_json}" ]] || {
  printf 'GitHub Release does not exist: %s\n' "${RELEASE_TAG}" >&2
  exit 1
}
asset_names="$(jq -r '.assets[].name' <<<"${release_json}")"
required_assets=(
  "Fruit-Truck-macOS-universal.dmg"
  "Fruit-Truck-macOS-universal.dmg.sha256"
  "Fruit-Truck-macOS-universal.app.tar.gz"
  "Fruit-Truck-macOS-universal.app.tar.gz.sig"
  "latest.json"
  "ffmpeg-${FFMPEG_VERSION}.tar.xz"
  "build-config-arm64.txt"
  "build-config-x86_64.txt"
  "ffmpeg-${FFMPEG_VERSION}-assets.sha256"
  "THIRD_PARTY_NOTICES.md"
)
for asset_name in "${required_assets[@]}"; do
  grep -Fxq "${asset_name}" <<<"${asset_names}" || {
    printf 'Required release asset is missing from %s: %s\n' "${RELEASE_TAG}" "${asset_name}" >&2
    exit 1
  }
done

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
  latest.json \
  'Fruit-Truck-macOS-universal.app.tar.gz' \
  'Fruit-Truck-macOS-universal.app.tar.gz.sig' \
  'Fruit-Truck-macOS-universal.dmg.sha256' \
  "ffmpeg-${FFMPEG_VERSION}.tar.xz" \
  'build-config-arm64.txt' \
  'build-config-x86_64.txt' \
  "ffmpeg-${FFMPEG_VERSION}-assets.sha256"; do
  asset_url="$(jq -r --arg name "${pattern}" '.assets[] | select(.name == $name) | .apiUrl' <<<"${release_json}")"
  [[ -n "${asset_url}" && "${asset_url}" != "null" ]]
  gh api "${asset_url}" \
    --header 'Accept: application/octet-stream' \
    > "${verification_dir}/${pattern}"
done

expected_version="${RELEASE_TAG#v}"
jq -e --arg version "${expected_version}" '.version == $version' "${verification_dir}/latest.json" >/dev/null

updater_api_url="$(jq -r '.assets[] | select(.name == "Fruit-Truck-macOS-universal.app.tar.gz") | .apiUrl' <<<"${release_json}")"
updater_browser_url="https://github.com/${REPOSITORY}/releases/download/${RELEASE_TAG}/Fruit-Truck-macOS-universal.app.tar.gz"
signature="$(<"${verification_dir}/Fruit-Truck-macOS-universal.app.tar.gz.sig")"
for platform in darwin-aarch64 darwin-x86_64 darwin-universal darwin-aarch64-app darwin-x86_64-app darwin-universal-app; do
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

jq -r '.plugins.updater.pubkey' "${SOURCE_ROOT}/apps/desktop/src-tauri/tauri.conf.json" | \
  base64 --decode > "${verification_dir}/updater-public.key"
base64 --decode \
  < "${verification_dir}/Fruit-Truck-macOS-universal.app.tar.gz.sig" \
  > "${verification_dir}/updater-signature.minisig"
minisign -Vm "${verification_dir}/Fruit-Truck-macOS-universal.app.tar.gz" \
  -p "${verification_dir}/updater-public.key" \
  -x "${verification_dir}/updater-signature.minisig"

dmg_digest="$(jq -r '.assets[] | select(.name == "Fruit-Truck-macOS-universal.dmg") | .digest' <<<"${release_json}")"
dmg_checksum="$(awk 'NR == 1 { print $1 }' "${verification_dir}/Fruit-Truck-macOS-universal.dmg.sha256")"
[[ "${dmg_digest}" == "sha256:${dmg_checksum}" ]] || {
  printf 'Published DMG checksum does not match the GitHub asset digest.\n' >&2
  exit 1
}
grep -Eq '^[0-9a-f]{64}[[:space:]]+Fruit-Truck-macOS-universal\.dmg$' \
  "${verification_dir}/Fruit-Truck-macOS-universal.dmg.sha256"

(
  cd "${verification_dir}"
  shasum -a 256 --check "ffmpeg-${FFMPEG_VERSION}-assets.sha256"
  printf '%s  %s\n' "${FFMPEG_SHA256}" "ffmpeg-${FFMPEG_VERSION}.tar.xz" | shasum -a 256 --check
)

printf 'GitHub Release %s contains a complete signed updater, notarized DMG metadata, and FFmpeg compliance set.\n' "${RELEASE_TAG}"
