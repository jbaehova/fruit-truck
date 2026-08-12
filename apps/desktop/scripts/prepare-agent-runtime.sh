#!/usr/bin/env bash

set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
desktop_dir="$(cd -- "${script_dir}/.." && pwd)"
repository_dir="$(cd -- "${desktop_dir}/../.." && pwd)"
agent_kit_dir="${repository_dir}/agent-kit"
output_dir="${desktop_dir}/src-tauri/target/bundled-agent-runtime"
core_dir="${desktop_dir}/src-tauri/target/bundled-tools"
if [[ -n "${1:-}" ]]; then
  echo "Usage: prepare-agent-runtime.sh" >&2
  exit 2
fi

[[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]] || {
  echo "Fruit Truck desktop builds support Apple Silicon macOS only." >&2
  exit 1
}

# shellcheck disable=SC1091
source "${script_dir}/agent-runtime-version.env"
[[ "${NODE_VERSION:-}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  echo "Pinned Node.js runtime version is invalid." >&2
  exit 1
}

node_cache_dir="${desktop_dir}/src-tauri/target/node-runtime-cache/v${NODE_VERSION}"
mkdir -p -- "${node_cache_dir}"

prepare_node_arch() {
  local arch="$1"
  local archive="node-v${NODE_VERSION}-darwin-${arch}.tar.gz"
  local archive_path="${node_cache_dir}/${archive}"
  local checksums="${node_cache_dir}/SHASUMS256.txt"
  local extracted="${node_cache_dir}/node-v${NODE_VERSION}-darwin-${arch}"
  if [[ ! -f "${checksums}" ]]; then
    curl --fail --location --silent --show-error \
      "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" \
      --output "${checksums}"
  fi
  if [[ ! -f "${archive_path}" ]]; then
    curl --fail --location --silent --show-error \
      "https://nodejs.org/dist/v${NODE_VERSION}/${archive}" \
      --output "${archive_path}"
  fi
  local expected
  expected="$(awk -v name="${archive}" '$2 == name { print $1 }' "${checksums}")"
  [[ "${expected}" =~ ^[0-9a-f]{64}$ ]] || {
    echo "Could not find the signed checksum for ${archive}." >&2
    exit 1
  }
  local actual
  actual="$(shasum -a 256 "${archive_path}" | awk '{ print $1 }')"
  [[ "${actual}" == "${expected}" ]] || {
    echo "Node.js checksum verification failed for ${archive}." >&2
    exit 1
  }
  if [[ ! -x "${extracted}/bin/node" ]]; then
    tar -xzf "${archive_path}" -C "${node_cache_dir}"
  fi
}

target_guard="${desktop_dir}/src-tauri/target/bundled-agent-runtime"
[[ "${output_dir}" == "${target_guard}" ]] || {
  echo "Refusing to replace an unexpected runtime directory: ${output_dir}" >&2
  exit 1
}
rm -rf -- "${output_dir}"
mkdir -p -- "${output_dir}/agent-kit/node_modules"

(cd "${agent_kit_dir}" && npm run build)
cp -R -- "${agent_kit_dir}/dist" "${output_dir}/agent-kit/dist"
cp -R -- "${agent_kit_dir}/skills" "${output_dir}/agent-kit/skills"
cp -R -- "${agent_kit_dir}/node_modules/pngjs" "${output_dir}/agent-kit/node_modules/pngjs"
cp -- "${agent_kit_dir}/package.json" "${agent_kit_dir}/compatibility.json" "${output_dir}/agent-kit/"

prepare_node_arch arm64
cp -- "${node_cache_dir}/node-v${NODE_VERSION}-darwin-arm64/bin/node" "${output_dir}/node"
cp -- "${node_cache_dir}/node-v${NODE_VERSION}-darwin-arm64/LICENSE" "${output_dir}/LICENSE.node.txt"
core_path="${core_dir}/fruit-truckd-aarch64-apple-darwin"
[[ -x "${core_path}" ]] || {
  echo "Prepare the Apple Silicon Fruit Truck Core sidecar before the agent runtime." >&2
  exit 1
}

find "${output_dir}" -maxdepth 1 -type f -name 'node*' -exec chmod 0755 {} +
printf 'Prepared bundled Agent Kit %s with Node.js %s for Apple Silicon.\n' \
  "$(node -p "require('${agent_kit_dir}/package.json').version")" "${NODE_VERSION}"
