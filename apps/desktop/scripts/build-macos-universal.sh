#!/usr/bin/env bash
set -euo pipefail

npm run tauri -- build --bundles dmg --target universal-apple-darwin

bundle_dir="src-tauri/target/universal-apple-darwin/release/bundle/dmg"
raw_dmg="$(find "$bundle_dir" -name 'Fruit Truck_*_universal.dmg' -print -quit)"
final_dmg="$bundle_dir/Fruit-Truck-macOS-universal.dmg"

if [[ -z "$raw_dmg" ]]; then
  echo "Universal DMG was not created." >&2
  exit 1
fi

bash scripts/clean-dmg-volume-icon.sh "$raw_dmg" "$final_dmg"
echo "Universal DMG ready: $final_dmg"
