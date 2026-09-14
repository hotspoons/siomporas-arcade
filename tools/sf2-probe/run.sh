#!/usr/bin/env bash
# Run MAME headless with one of the probe scripts.
#   tools/sf2-probe/run.sh boot   [ROMSET]          -> PROBE_P1/PROBE_P2 env pick the match; saves a state
#   tools/sf2-probe/run.sh <script.lua> [ROMSET] [-state NAME] [extra mame args]
# Scratch (nvram, cfg, snapshots, states) lives under $PROBE_SCRATCH (default ext/reference-artwork/rom-dumps/mame).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
SCRIPT=$1; shift
ROMSET=${1:-sf2ceea}; [ $# -gt 0 ] && shift
[ "$SCRIPT" = boot ] && SCRIPT=boot.lua
case "$SCRIPT" in /*) ;; *) SCRIPT="$HERE/lua/$SCRIPT" ;; esac
export PROBE_DIR="$HERE/lua"
export PROBE_ROMSET="$ROMSET"
SCRATCH=${PROBE_SCRATCH:-$ROOT/ext/reference-artwork/rom-dumps/mame}
mkdir -p "$SCRATCH"
cd "$SCRATCH"
export PROBE_OUT="${PROBE_OUT:-$ROOT/ext/reference-artwork/rom-dumps/sf2/$ROMSET}"
mkdir -p "$PROBE_OUT"
timeout "${PROBE_TIMEOUT:-600}" ${MAME:-/usr/games/mame} "$ROMSET" -rompath "$ROOT/ext/reference-artwork/roms-mame" \
  -video none -sound none -nothrottle -skip_gameinfo -seconds_to_run "${PROBE_SECONDS:-300}" \
  -nvram_directory "$SCRATCH/nvram" -cfg_directory "$SCRATCH/cfg" -snapshot_directory "$SCRATCH/snap" \
  -state_directory "$SCRATCH/sta" -autoboot_script "$SCRIPT" "$@" 2>&1 \
  | grep -v -i -E "checksum|WRONG|EXPECTED|FOUND|ALSA|XDG_RUNTIME|might not run|^$"
