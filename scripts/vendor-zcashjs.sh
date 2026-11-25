#!/usr/bin/env bash
# Build the zcash.js package Zarca depends on from pinned upstream commits.
#
# Zarca needs zcash.js changes that are not yet released on npm. This script
# checks out a pinned base commit, merges pinned pull-request heads, builds the
# package (native WASM build included; first run takes several minutes) and
# writes vendor/zcashlabs-zcash.js.tgz. Replace it with an npm version once
# the changes ship upstream.
set -euo pipefail

REPO="https://github.com/zcashlabs/zcashjs.git"
BASE="354129f04ea24ccc0e9a85a8ecc52eaef2fa04f6"   # main: lightwallet-protocol v0.6.0 (#28), THS testing API (#27), cheaper idle sync (#39)
# Pull requests merged on top of BASE, as "number:commit".
PULLS=()

root="$(cd "$(dirname "$0")/.." && pwd)"
# Keep the checkout outside this repository: bundlers would otherwise pick up
# Zarca's tsconfig.json from a parent directory.
work="${ZARCA_ZCASHJS_CHECKOUT:-${XDG_CACHE_HOME:-$HOME/.cache}/zarca/zcashjs}"
mkdir -p "$work"
if [ ! -d "$work/.git" ]; then
  git clone --quiet "$REPO" "$work"
fi
cd "$work"
git fetch --quiet origin main
git reset --quiet --hard   # discard any local edits from earlier runs
git checkout --quiet --detach "$BASE"
for pull in ${PULLS[@]+"${PULLS[@]}"}; do   # empty-array safe under set -u (bash 3.2)
  number="${pull%%:*}" commit="${pull##*:}"
  git fetch --quiet origin "pull/$number/head"
  resolved="$(git rev-parse FETCH_HEAD)"
  case "$resolved" in "$commit"*) ;; *) echo "PR #$number head moved to $resolved (pinned $commit)" >&2; exit 1 ;; esac
  git -c user.name=zarca -c user.email=zarca@localhost merge --quiet --no-edit "$resolved"
done
# BASE pins the native wallet bindings (scripts/native-source.json), including the
# Linux, macOS and Windows Node storage host (jp4g/zakura-wasm-bindings#41, #43).
npm ci --silent
npm run build
mkdir -p "$root/vendor"
out="$(npm pack --silent --pack-destination "$root/vendor" | tail -1)"
mv "$root/vendor/$out" "$root/vendor/zcashlabs-zcash.js.tgz"
if command -v sha256sum >/dev/null; then sha256sum "$root/vendor/zcashlabs-zcash.js.tgz"; else shasum -a 256 "$root/vendor/zcashlabs-zcash.js.tgz"; fi
# The package name and version do not change between vendor builds, so installers
# keep the previous copy; drop it so the next install unpacks this build.
rm -rf "$root/node_modules/@zcashlabs/zcash.js"
