#!/usr/bin/env bash
# pick-device.sh — interactive device picker for `make run` flow.
#
# Usage:
#   pick-device.sh phone           # always prompt
#   pick-device.sh watch           # always prompt
#   pick-device.sh phone --reuse   # if cache has phone, ask "Use last? (Y/n)"
#   pick-device.sh watch --reuse
#
# Writes / updates IPHONE_* or WATCH_* shell-assignment lines in
# .fishbones-devices.cache (relative to the Makefile's working dir, i.e.
# the repo root when invoked from `make`):
#
#     IPHONE_KIND=sim|real
#     IPHONE_UDID=<udid>
#     IPHONE_NAME="Human readable"
#     WATCH_KIND=sim|real
#     WATCH_UDID=<udid>
#     WATCH_NAME="Human readable"
#
# The Makefile sources that file to know which devices to target.
#
# All interactive output goes to stderr so callers can `eval` the script's
# stdout if they ever want to (currently we just rely on the cache file).

set -euo pipefail

KIND="${1:-}"
MODE="${2:-}"
CACHE=".fishbones-devices.cache"

if [[ "$KIND" != "phone" && "$KIND" != "watch" ]]; then
  echo "usage: $0 phone|watch [--reuse]" >&2
  exit 64
fi

PREFIX="WATCH"
[[ "$KIND" == "phone" ]] && PREFIX="IPHONE"

# ---------- reuse path ----------
if [[ "$MODE" == "--reuse" && -f "$CACHE" ]]; then
  CACHED_NAME="$(grep -E "^${PREFIX}_NAME=" "$CACHE" 2>/dev/null | head -1 | sed -e "s/^${PREFIX}_NAME=//" -e 's/^"//' -e 's/"$//' || true)"
  CACHED_UDID="$(grep -E "^${PREFIX}_UDID=" "$CACHE" 2>/dev/null | head -1 | sed -e "s/^${PREFIX}_UDID=//" || true)"
  if [[ -n "$CACHED_NAME" && -n "$CACHED_UDID" ]]; then
    printf "Use last %s? [%s] (Y/n) " "$KIND" "$CACHED_NAME" >&2
    read -r ans </dev/tty || ans=""
    case "$ans" in
      ""|y|Y|yes|YES) exit 0 ;;
      *) ;;
    esac
  fi
fi

# ---------- gather candidates ----------
# Format per line (tab-separated): KIND\tUDID\tDISPLAY_NAME
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

SIMCTL_JSON="$(xcrun simctl list devices available --json 2>/dev/null || echo '{"devices":{}}')"
DEVICECTL_JSON_PATH="$(mktemp)"
# devicectl prints a banner on stderr; suppress it. If it fails, we still get
# a usable empty file.
xcrun devicectl list devices --json-output "$DEVICECTL_JSON_PATH" >/dev/null 2>&1 || echo '{}' > "$DEVICECTL_JSON_PATH"

PYTHON="$(command -v python3 || command -v python)"
if [[ -z "$PYTHON" ]]; then
  echo "ERROR: python3 not found; pick-device.sh needs it for JSON parsing." >&2
  exit 1
fi

"$PYTHON" - "$KIND" "$SIMCTL_JSON" "$DEVICECTL_JSON_PATH" >"$TMP" <<'PYEOF'
import json, sys

kind = sys.argv[1]
simctl = json.loads(sys.argv[2])
with open(sys.argv[3]) as f:
    try:
        dctl = json.load(f)
    except Exception:
        dctl = {}

want_runtime = "iOS" if kind == "phone" else "watchOS"
want_device_type = "iPhone" if kind == "phone" else "appleWatch"
# simctl reports iPads under the iOS runtime too; filter the device-type
# identifier so the phone list doesn't include "iPad Pro 13-inch".
sim_type_token = "iPhone-" if kind == "phone" else "Apple-Watch-"

rows = []  # (sort_key, kind, udid, display_name)

# Simulators — booted first, then shutdown.
for runtime, devs in (simctl.get("devices") or {}).items():
    if want_runtime not in runtime:
        continue
    for d in devs:
        if not d.get("isAvailable"):
            continue
        if sim_type_token not in (d.get("deviceTypeIdentifier") or ""):
            continue
        state = d.get("state", "Shutdown")
        # Sort: booted (0) before shutdown (1); within group, by name.
        rank = 0 if state == "Booted" else 1
        suffix = " [booted]" if state == "Booted" else ""
        name = f"{d['name']} (sim){suffix}"
        rows.append((rank, 0, name.lower(), "sim", d["udid"], name))

# Real devices.
for d in (dctl.get("result") or {}).get("devices", []) or []:
    hp = d.get("hardwareProperties") or {}
    dp = d.get("deviceProperties") or {}
    cp = d.get("connectionProperties") or {}
    if hp.get("deviceType") != want_device_type:
        continue
    if hp.get("reality") != "physical":
        continue
    udid = hp.get("udid") or d.get("identifier")
    if not udid:
        continue
    name = dp.get("name") or hp.get("marketingName") or "Device"
    paired = cp.get("pairingState") == "paired"
    suffix = " [real device]" if paired else " [real device, unpaired]"
    rows.append((-1, 0, name.lower(), "real", udid, f"{name}{suffix}"))

rows.sort()
for _, _, _, k, u, n in rows:
    print(f"{k}\t{u}\t{n}")
PYEOF

rm -f "$DEVICECTL_JSON_PATH"

if [[ ! -s "$TMP" ]]; then
  echo "" >&2
  echo "No $KIND devices found (no available sims, no paired real devices)." >&2
  if [[ "$KIND" == "phone" ]]; then
    echo "Hint: open Xcode → Window → Devices and Simulators, or run 'xcrun simctl list devices'." >&2
  else
    echo "Hint: pair an Apple Watch in Xcode, or create a watchOS sim via Xcode." >&2
  fi
  exit 1
fi

# ---------- prompt ----------
echo "" >&2
echo "Available $KIND devices:" >&2
i=1
while IFS=$'\t' read -r k u n; do
  printf "  [%d] %s\n" "$i" "$n" >&2
  i=$((i + 1))
done < "$TMP"

TOTAL=$((i - 1))
if [[ ! -r /dev/tty ]]; then
  echo "ERROR: no controlling terminal (/dev/tty unreadable). Run from an interactive shell." >&2
  exit 1
fi
CHOICE=""
ATTEMPTS=0
while :; do
  printf "Pick %s (1-%d): " "$KIND" "$TOTAL" >&2
  if ! read -r CHOICE </dev/tty; then
    echo "" >&2
    echo "ERROR: aborted (EOF on tty)." >&2
    exit 1
  fi
  if [[ "$CHOICE" =~ ^[0-9]+$ ]] && (( CHOICE >= 1 && CHOICE <= TOTAL )); then
    break
  fi
  ATTEMPTS=$((ATTEMPTS + 1))
  if (( ATTEMPTS >= 5 )); then
    echo "ERROR: too many invalid selections, giving up." >&2
    exit 1
  fi
  echo "  Invalid selection." >&2
done

LINE="$(awk -v n="$CHOICE" 'NR==n' "$TMP")"
PICKED_KIND="$(printf '%s' "$LINE" | cut -f1)"
PICKED_UDID="$(printf '%s' "$LINE" | cut -f2)"
PICKED_NAME="$(printf '%s' "$LINE" | cut -f3)"

# ---------- write cache ----------
NEWCACHE="$(mktemp)"
if [[ -f "$CACHE" ]]; then
  grep -vE "^${PREFIX}_(KIND|UDID|NAME)=" "$CACHE" > "$NEWCACHE" || true
fi
{
  echo "${PREFIX}_KIND=${PICKED_KIND}"
  echo "${PREFIX}_UDID=${PICKED_UDID}"
  echo "${PREFIX}_NAME=\"${PICKED_NAME}\""
} >> "$NEWCACHE"
mv "$NEWCACHE" "$CACHE"

echo "Selected $KIND: $PICKED_NAME ($PICKED_UDID)" >&2
