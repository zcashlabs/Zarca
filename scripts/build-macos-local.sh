#!/usr/bin/env bash
# Local macOS build for machines without an Apple Developer ID (#6).
#
# Produces Zarca.app sealed with an ad hoc signature and the hardened runtime.
# It runs on the Mac that built it. It is not notarized, so copies downloaded
# elsewhere are blocked by Gatekeeper; distribution needs a Developer ID.
#   bash scripts/build-macos-local.sh [--install]   # --install copies to ~/Applications
set -euo pipefail
[ "$(uname -s)" = Darwin ] || { echo "macOS only" >&2; exit 1; }
cd "$(dirname "$0")/.."
npx --yes electrobun@2.0.7 prepare >/dev/null
bunx vite build >/dev/null
npx --yes electrobun@2.0.7 build --env=canary
app="$(ls -d build/canary-macos-*/*.app | head -1)"
codesign --force --deep --sign - --options runtime --entitlements assets/macos/entitlements.plist "$app"
codesign --verify --deep --strict --verbose=2 "$app"
codesign -dv "$app" 2>&1 | grep -E "^(Identifier|Signature|Runtime|CodeDirectory)"
echo "Built and ad hoc signed: $app"
if [ "${1:-}" = "--install" ]; then
  mkdir -p "$HOME/Applications"
  rm -rf "$HOME/Applications/Zarca.app"
  cp -R "$app" "$HOME/Applications/Zarca.app"
  echo "Installed: $HOME/Applications/Zarca.app"
fi
