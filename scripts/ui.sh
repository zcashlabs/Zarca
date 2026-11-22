#!/usr/bin/env bash
# Dev helpers against a running dev-headless instance.
#   scripts/ui.sh eval '<js returning a value>'
#   scripts/ui.sh shot <file.png>
set -euo pipefail
sock="${ZARCA_AUTOMATION_SOCKET:-$ZARCA_DATA_DIR/automation.sock}"
case "$1" in
  eval) curl -sS --unix-socket "$sock" -X POST --data-binary "$2" http://localhost/ ;;
  shot) ffmpeg -loglevel error -y -f x11grab -video_size 1440x900 -i "${ZARCA_DISPLAY:-:99}" -frames:v 1 "$2" ;;
  *) echo "usage: $0 eval <js> | shot <png>" >&2; exit 2 ;;
esac
