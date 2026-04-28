#!/usr/bin/env bash
# run-split.sh — spawn `make run-phone` and `make run-watch` in two new
# terminal windows. Assumes both devices are already picked (cache populated).
#
# Picks the right AppleScript dialect based on $TERM_PROGRAM:
#   - iTerm.app       → iTerm windows
#   - Apple_Terminal  → Terminal.app windows
#   - anything else   → falls back to Terminal.app (it's always installed)
#
# To force a specific terminal, set FB_TERM=terminal|iterm before invoking.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PHONE_CMD="cd '$ROOT' && FB_SKIP_PICK=1 make run-phone; echo; echo '[done — close window or press ⌘W]'"
WATCH_CMD="cd '$ROOT' && FB_SKIP_PICK=1 make run-watch; echo; echo '[done — close window or press ⌘W]'"

CACHE="$ROOT/.fishbones-devices.cache"
if [[ ! -f "$CACHE" ]]; then
  echo "ERROR: $CACHE missing. Run 'make pick-phone && make pick-watch' first," >&2
  echo "       or use 'make run-split' which calls the pickers up front." >&2
  exit 1
fi

CHOOSE="${FB_TERM:-}"
if [[ -z "$CHOOSE" ]]; then
  case "${TERM_PROGRAM:-}" in
    iTerm.app)      CHOOSE="iterm" ;;
    Apple_Terminal) CHOOSE="terminal" ;;
    *)              CHOOSE="terminal" ;;
  esac
fi

case "$CHOOSE" in
  iterm)
    osascript <<EOF
tell application "iTerm"
  activate
  set phoneWin to (create window with default profile)
  tell current session of phoneWin to write text "$PHONE_CMD"
  set watchWin to (create window with default profile)
  tell current session of watchWin to write text "$WATCH_CMD"
end tell
EOF
    ;;
  terminal)
    osascript -e "tell application \"Terminal\" to activate" \
              -e "tell application \"Terminal\" to do script \"$PHONE_CMD\"" \
              -e "tell application \"Terminal\" to do script \"$WATCH_CMD\""
    ;;
  *)
    echo "ERROR: unknown FB_TERM='$CHOOSE' (expected 'iterm' or 'terminal')." >&2
    exit 1
    ;;
esac

echo "Spawned phone + watch builds into separate $CHOOSE windows."
