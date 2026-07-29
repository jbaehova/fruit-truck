#!/usr/bin/env bash
set -euo pipefail

input_dmg="${1:?usage: clean-dmg-volume-icon.sh INPUT_DMG [OUTPUT_DMG]}"
output_dmg="${2:-$input_dmg}"

if [[ ! -f "$input_dmg" ]]; then
  echo "DMG not found: $input_dmg" >&2
  exit 1
fi

work_dir="$(mktemp -d /tmp/oppa-gen-dmg-clean.XXXXXX)"
mount_dir="$work_dir/mount"
readwrite_dmg="$work_dir/readwrite.dmg"
processed_dmg="$work_dir/processed.dmg"
mounted=false

cleanup() {
  if [[ "$mounted" == true ]]; then
    hdiutil detach "$mount_dir" >/dev/null 2>&1 || true
  fi
  rm -rf -- "$work_dir"
}
trap cleanup EXIT

mkdir "$mount_dir"
hdiutil convert "$input_dmg" -format UDRW -o "$readwrite_dmg" >/dev/null
hdiutil attach "$readwrite_dmg" -nobrowse -mountpoint "$mount_dir" >/dev/null
mounted=true

if [[ -f "$mount_dir/.VolumeIcon.icns" ]]; then
  mv "$mount_dir/.VolumeIcon.icns" "$work_dir/removed-VolumeIcon.icns"
fi

hdiutil detach "$mount_dir" >/dev/null
mounted=false
hdiutil convert "$readwrite_dmg" -format UDZO -imagekey zlib-level=9 -o "$processed_dmg" >/dev/null
mv "$processed_dmg" "$output_dmg"

echo "$output_dmg"
