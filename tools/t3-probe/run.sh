#!/usr/bin/env bash
# Run MAME headless with one of the System 12 probe scripts.
#   tools/t3-probe/run.sh navigate.lua [ROMSET] [extra mame args]
#
# Unlike the 2D harness there is no savestate to load: every run starts from a cold boot and the
# script drives the board from attract mode to wherever it needs to be. Headless the board runs at
# about 450% of real time, so a two-minute in-game sequence costs about twenty-five seconds.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
SCRIPT=$1; shift
ROMSET=${1:-tekken3je1}; [ $# -gt 0 ] && shift
case "$SCRIPT" in /*) ;; *) SCRIPT="$HERE/lua/$SCRIPT" ;; esac
export PROBE_DIR="$HERE/lua"
export PROBE_ROMSET="$ROMSET"
SCRATCH=${PROBE_SCRATCH:-$ROOT/ext/reference-artwork/rom-dumps/mame3d}
mkdir -p "$SCRATCH"
cd "$SCRATCH"
export PROBE_OUT="${PROBE_OUT:-$ROOT/ext/reference-artwork/rom-dumps/t3/$ROMSET}"
mkdir -p "$PROBE_OUT"
timeout "${PROBE_TIMEOUT:-900}" ${MAME:-/usr/games/mame} "$ROMSET" -rompath "$ROOT/ext/reference-artwork/roms-mame" \
  -video none -sound none -nothrottle -skip_gameinfo -seconds_to_run "${PROBE_SECONDS:-300}" \
  -nvram_directory "$SCRATCH/nvram" -cfg_directory "$SCRATCH/cfg" -snapshot_directory "$SCRATCH/snap" \
  -state_directory "$SCRATCH/sta" -autoboot_script "$SCRIPT" "$@" 2>&1 \
  | grep -v -i -E "checksum|WRONG|EXPECTED|FOUND|ALSA|XDG_RUNTIME|might not run|^$"
