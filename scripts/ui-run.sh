#!/usr/bin/env bash
# scripts/ui-run.sh <script.js>   (script uses ui-helpers.js and returns a value)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
helpers="$(cat "$here/ui-helpers.js")"
body="$(cat "$1")"
exec "$here/ui.sh" eval "${helpers}
return (async () => {
${body}
})();"
