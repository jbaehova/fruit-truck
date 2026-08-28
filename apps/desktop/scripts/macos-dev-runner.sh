#!/usr/bin/env bash

set -Eeuo pipefail

if (( $# == 0 )); then
  printf 'Usage: %s <Tauri executable> [arguments...]\n' "$0" >&2
  exit 64
fi

BINARY_DIR="$(cd -- "$(dirname -- "$1")" && pwd)"
BINARY_PATH="${BINARY_DIR}/$(basename -- "$1")"
shift

[[ -x "${BINARY_PATH}" ]] || {
  printf 'Error: Tauri development executable is missing or not executable: %s\n' "${BINARY_PATH}" >&2
  exit 1
}

# `tauri dev` normally runs Cargo's `fruit-truck` binary directly. macOS then
# uses that executable name in the Dock and application menu, bypassing
# Tauri's `productName`. Run the same binary from a lightweight development
# app bundle so macOS sees the configured product name without doing a full
# release bundle on every rebuild.
APP_BUNDLE="${BINARY_DIR}/Fruit Truck.app"
CONTENTS_DIR="${APP_BUNDLE}/Contents"
MACOS_DIR="${CONTENTS_DIR}/MacOS"
RESOURCES_DIR="${CONTENTS_DIR}/Resources"
APP_EXECUTABLE="${MACOS_DIR}/Fruit Truck"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ICON_PATH="${SCRIPT_DIR}/../src-tauri/icons/icon.icns"

mkdir -p -- "${MACOS_DIR}" "${RESOURCES_DIR}"

if [[ ! -e "${APP_EXECUTABLE}" || ! "${BINARY_PATH}" -ef "${APP_EXECUTABLE}" ]]; then
  ln -f -- "${BINARY_PATH}" "${APP_EXECUTABLE}"
fi
chmod +x "${APP_EXECUTABLE}"

if [[ -f "${ICON_PATH}" ]]; then
  cp -f -- "${ICON_PATH}" "${RESOURCES_DIR}/icon.icns"
fi

cat > "${CONTENTS_DIR}/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>Fruit Truck</string>
  <key>CFBundleExecutable</key>
  <string>Fruit Truck</string>
  <key>CFBundleIconFile</key>
  <string>icon.icns</string>
  <key>CFBundleIdentifier</key>
  <string>ui.fruittruck.desktop</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Fruit Truck</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.6.7</string>
  <key>CFBundleVersion</key>
  <string>0.6.7</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
PLIST

printf 'APPL????' > "${CONTENTS_DIR}/PkgInfo"

exec "${APP_EXECUTABLE}" "$@"
