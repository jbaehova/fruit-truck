#!/usr/bin/env bash

set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
desktop_dir="$(cd -- "${script_dir}/.." && pwd)"
manifest="${desktop_dir}/src-tauri/Cargo.toml"
output_dir="${desktop_dir}/src-tauri/target/bundled-tools"

for target in aarch64-apple-darwin x86_64-apple-darwin; do
  cargo build --manifest-path "${manifest}" -p fruit-truckd --release --target "${target}"
  mkdir -p -- "${output_dir}"
  cp -f -- \
    "${desktop_dir}/src-tauri/target/${target}/release/fruit-truckd" \
    "${output_dir}/fruit-truckd-${target}"
done

lipo -create \
  "${output_dir}/fruit-truckd-aarch64-apple-darwin" \
  "${output_dir}/fruit-truckd-x86_64-apple-darwin" \
  -output "${output_dir}/fruit-truckd-universal-apple-darwin"
chmod 0755 "${output_dir}"/fruit-truckd-*-apple-darwin

archs="$(lipo -archs "${output_dir}/fruit-truckd-universal-apple-darwin")"
[[ "${archs}" == *arm64* && "${archs}" == *x86_64* ]] || {
  printf 'Fruit Truck Core helper is not Universal: %s\n' "${archs}" >&2
  exit 1
}

printf 'Prepared Universal Fruit Truck Core sidecar.\n'
