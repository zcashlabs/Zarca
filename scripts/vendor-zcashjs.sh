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
BASE="cb1b706caf2c30e49fb4b9db64730e5d1dc6f518"   # main: chore: prepare 0.1.2 NU7 release (#24)
# Pull requests merged on top of BASE, as "number:commit".
PULLS=(
  "28:5a10a36"   # accept lightwallet-protocol v0.6.0
  "31:0ac571c"   # authenticated at-rest encryption for Node filesystem storage
)

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
git checkout --quiet --detach "$BASE"
for pull in "${PULLS[@]}"; do
  number="${pull%%:*}" commit="${pull##*:}"
  git fetch --quiet origin "pull/$number/head"
  resolved="$(git rev-parse FETCH_HEAD)"
  case "$resolved" in "$commit"*) ;; *) echo "PR #$number head moved to $resolved (pinned $commit)" >&2; exit 1 ;; esac
  git -c user.name=zarca -c user.email=zarca@localhost merge --quiet --no-edit "$resolved"
done
npm ci --silent
npm run build
mkdir -p "$root/vendor"
out="$(npm pack --silent --pack-destination "$root/vendor" | tail -1)"
mv "$root/vendor/$out" "$root/vendor/zcashlabs-zcash.js.tgz"
sha256sum "$root/vendor/zcashlabs-zcash.js.tgz"
