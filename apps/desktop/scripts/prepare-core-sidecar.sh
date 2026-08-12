#!/usr/bin/env bash

set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
desktop_dir="$(cd -- "${script_dir}/.." && pwd)"
manifest="${desktop_dir}/src-tauri/Cargo.toml"
output_dir="${desktop_dir}/src-tauri/target/bundled-tools"
profile="debug"
target_triple="$(rustc -vV | sed -n 's/^host: //p')"
binary_path="${desktop_dir}/src-tauri/target/debug/fruit-truckd"

if [[ "${1:-}" == "--release" ]]; then
  [[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]] || {
    printf 'Fruit Truck releases must be built on Apple Silicon macOS.\n' >&2
    exit 1
  }
  profile="release"
  target_triple="aarch64-apple-darwin"
  binary_path="${desktop_dir}/src-tauri/target/${target_triple}/release/fruit-truckd"
elif [[ -n "${1:-}" ]]; then
  printf 'Usage: prepare-core-sidecar.sh [--release]\n' >&2
  exit 2
fi

if [[ "${profile}" == "release" ]]; then
  cargo build --manifest-path "${manifest}" -p fruit-truckd --release --target "${target_triple}"
else
  cargo build --manifest-path "${manifest}" -p fruit-truckd
fi
mkdir -p -- "${output_dir}"
cp -f -- \
  "${binary_path}" \
  "${output_dir}/fruit-truckd-${target_triple}"
chmod 0755 "${output_dir}/fruit-truckd-${target_triple}"

printf 'Prepared %s Fruit Truck Core sidecar for %s.\n' "${profile}" "${target_triple}"
