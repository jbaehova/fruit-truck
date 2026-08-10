#!/usr/bin/env bash

set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
desktop_dir="$(cd -- "${script_dir}/.." && pwd)"
manifest="${desktop_dir}/src-tauri/Cargo.toml"
output_dir="${desktop_dir}/src-tauri/target/bundled-tools"
target_triple="$(rustc -vV | sed -n 's/^host: //p')"

cargo build --manifest-path "${manifest}" -p fruit-truckd
mkdir -p -- "${output_dir}"
cp -f -- \
  "${desktop_dir}/src-tauri/target/debug/fruit-truckd" \
  "${output_dir}/fruit-truckd-${target_triple}"
chmod 0755 "${output_dir}/fruit-truckd-${target_triple}"

printf 'Prepared Fruit Truck Core sidecar for %s.\n' "${target_triple}"
