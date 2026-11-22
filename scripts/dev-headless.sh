#!/usr/bin/env bash
# Runs Zarca on a virtual X display with an isolated data directory and the
# dev automation socket. For screenshots: scripts/screenshot.sh <name>.
set -euo pipefail
export DISPLAY="${ZARCA_DISPLAY:-:99}"
if ! pgrep -f "Xvfb $DISPLAY" >/dev/null; then
  Xvfb "$DISPLAY" -screen 0 1440x900x24 -nolisten tcp >/dev/null 2>&1 &
  sleep 1
fi
export ZARCA_DATA_DIR="${ZARCA_DATA_DIR:?set ZARCA_DATA_DIR to a scratch directory}"
export ZARCA_AUTOMATION_SOCKET="${ZARCA_AUTOMATION_SOCKET:-$ZARCA_DATA_DIR/automation.sock}"
mkdir -p "$ZARCA_DATA_DIR" && chmod 700 "$ZARCA_DATA_DIR"
cd "$(dirname "$0")/.."
hutch electrobun prepare >/dev/null
hutch pm exec -- vite build >/dev/null
exec hutch electrobun dev
