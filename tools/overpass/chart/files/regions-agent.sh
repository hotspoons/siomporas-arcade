#!/bin/bash
# The `regions` sidecar: the part of adding a region that has to happen INSIDE the overpass pod.
#
# It shares /db and /dev/shm with the instance's dispatcher, so `update_from_dir` here takes the
# dispatcher's write lock exactly as the instance's own updater does, and readers keep reading the
# committed state throughout. Two jobs, in one loop:
#
#   apply   a region an osm-import Job has staged in /db/regions/<id>/import/ (import.sh)
#   follow  every applied region's own Geofabrik diff stream, from the sequence in its extract's
#           header — the instance's own updater follows only the extract it was built from
#
# Every diff, the instance's own included (OVERPASS_DIFF_PREPROCESS, see deployment.yaml), goes
# through defer_deletes.py first: a Geofabrik diff DELETES an object that merely left its region,
# and on an instance holding two regions that object may still be the other region's.
#
# The state of each region is /db/regions/<id>/state.json; its log is apply.log beside it.
set -uo pipefail

DB_ROOT=${DB_ROOT:-/db}
BIN=${BIN:-/app/bin}
PY=${PY:-/app/venv/bin/python}
GETCHANGES=${GETCHANGES:-/app/venv/bin/pyosmium-get-changes}
OSMIUM=${OSMIUM:-osmium}
SCRIPTS=${SCRIPTS:-/opt/regions}
SLEEP=${REGIONS_SLEEP:-300}
DIFF_EVERY=${REGIONS_DIFF_EVERY:-${OVERPASS_UPDATE_SLEEP:-86400}}
FLUSH=${OVERPASS_FLUSH_SIZE:-4}
# the database belongs to `overpass`; a file written by root in /db/db is one the instance's own
# updater cannot rewrite. Empty RUNAS (a laptop test) runs as whoever this is.
RUNAS=${RUNAS-runuser -u overpass --}
R=$DB_ROOT/regions

log() { echo "[regions $(date -u +%F' '%T)] $*"; }
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
field() { sed -n "s/.*\"$1\": *\"\{0,1\}\([^\",}]*\)\"\{0,1\}.*/\1/p" "$2" 2>/dev/null | head -1; }
json() { printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"; }
setstate() { printf '%s\n' "$2" > "$1/state.json.tmp" && mv "$1/state.json.tmp" "$1/state.json"; }

mkdir -p "$R"
[ "$(id -u)" = 0 ] && chown 1000:1000 "$R" 2>/dev/null

# The instance's own extract's outline, so deletes in an IMPORTED region's diffs that touch it are
# deferred too. From the chart (regions.primaryPoly); retried every loop until it is there.
primary_poly() {
  [ -n "${PRIMARY_POLY_URL:-}" ] || return 0
  [ -s "$R/_primary/region.poly" ] && return 0
  mkdir -p "$R/_primary"
  curl -fsSL --retry 2 -o "$R/_primary/region.poly.part" "$PRIMARY_POLY_URL" && mv "$R/_primary/region.poly.part" "$R/_primary/region.poly" &&
    setstate "$R/_primary" "{\"state\":\"applied\",\"id\":$(json "${PRIMARY_ID:-primary}"),\"primary\":true,\"at\":\"$(now)\"}" &&
    log "primary outline ${PRIMARY_ID:-} from $PRIMARY_POLY_URL"
}

# The version stamped on the database is the INSTANCE's — the replication time of the stream it
# was built from, which /api/timestamp reports. An import or a region's diff leaves it as it is:
# moving it to the region's time would make /api/timestamp say the whole instance is as fresh as
# the region that last ran. Each region's own freshness is in its state.json.
dbversion() { cat "$DB_ROOT/db/osm_base_version" 2>/dev/null || echo "$1"; }

apply_import() {
  local d=$1 id v
  id=$(field id "$d/request.json")
  v=$(dbversion "$(field snapshot "$d/request.json")")
  setstate "$d" "{\"state\":\"applying\",\"id\":$(json "$id"),\"at\":\"$(now)\"}"
  log "applying $id ($(du -sh "$d/import" | cut -f1) staged) through the dispatcher"
  echo "[regions $(now)] update_from_dir --osc-dir=$d/import --version=$v --flush-size=$FLUSH" >> "$d/apply.log"
  local t0=$SECONDS
  # shellcheck disable=SC2086
  if $RUNAS "$BIN/update_from_dir" --osc-dir="$d/import" --version="$v" --flush-size="$FLUSH" >> "$d/apply.log" 2>&1; then
    field sequence "$d/request.json" > "$d/replicate_id"
    rm -f "$d/import/"*.osc
    setstate "$d" "{\"state\":\"applied\",\"id\":$(json "$id"),\"applied\":\"$(now)\",\"seconds\":$(( SECONDS - t0 )),\"sequence\":$(cat "$d/replicate_id"),\"lastDiff\":null}"
    echo "[regions $(now)] applied in $(( SECONDS - t0 )) s" >> "$d/apply.log"
    log "applied $id in $(( SECONDS - t0 )) s"
  else
    local rc=$?
    setstate "$d" "{\"state\":\"failed\",\"id\":$(json "$id"),\"why\":\"update_from_dir exited $rc after $(( SECONDS - t0 )) s; see apply.log\",\"at\":\"$(now)\"}"
    log "FAILED to apply $id (exit $rc)"
  fi
}

# a stream that failed is asked again in an hour, not every loop: Geofabrik is a free service, and
# a burst of requests is answered with 404s for a while (seen 2026-10-10)
later() { touch -d "@$(( $(date +%s) - DIFF_EVERY + 3600 ))" "$1/followed"; }

follow() {
  local d=$1 name id upd last
  name=$(basename "$d")
  id=$(field id "$d/request.json")
  upd=$(field updates "$d/request.json")
  [ -n "$upd" ] && [ -s "$d/replicate_id" ] || return 0
  last=$(stat -c %Y "$d/followed" 2>/dev/null || echo 0)
  [ $(( $(date +%s) - last )) -ge "$DIFF_EVERY" ] || return 0
  mkdir -p "$d/diffs"
  rm -f "$d/diffs/"*.osc
  cp -f "$d/replicate_id" "$d/replicate_id.backup"
  # one call fetches up to -s MB of consecutive diffs and advances replicate_id; exit 3 means
  # there was nothing newer, which is a normal day
  "$GETCHANGES" --server "$upd" -f "$d/replicate_id" -o "$d/diffs/changes.osc" -s 512 >> "$d/apply.log" 2>&1
  local rc=$?
  if [ -s "$d/diffs/changes.osc" ]; then
    local ts v
    ts=$("$OSMIUM" fileinfo -e -g data.timestamp.last "$d/diffs/changes.osc" 2>/dev/null)
    v=$(dbversion "$ts")
    if "$PY" "$SCRIPTS/defer_deletes.py" "$d/diffs/changes.osc" --self "$name" --regions "$R" >> "$d/apply.log" 2>&1 &&
      $RUNAS "$BIN/update_from_dir" --osc-dir="$d/diffs" --version="$v" --flush-size="$FLUSH" >> "$d/apply.log" 2>&1; then
      setstate "$d" "{\"state\":\"applied\",\"id\":$(json "$id"),\"sequence\":$(cat "$d/replicate_id"),\"lastDiff\":$(json "$ts"),\"at\":\"$(now)\"}"
      log "$id: applied its diffs up to $ts (sequence $(cat "$d/replicate_id"))"
    else
      # put the sequence back, as the instance's own updater does, so the same diffs are tried again
      cp -f "$d/replicate_id.backup" "$d/replicate_id"
      log "$id: FAILED to apply its diffs; will retry in an hour (see $d/apply.log)"
      later "$d"
      return 0
    fi
  elif [ "$rc" -ne 0 ] && [ "$rc" -ne 3 ]; then
    cp -f "$d/replicate_id.backup" "$d/replicate_id"
    log "$id: could not fetch diffs from $upd (exit $rc); will retry in an hour"
    later "$d"
    return 0
  fi
  rm -f "$d/diffs/"*.osc
  touch "$d/followed"
}

log "started: ${R}, apply every ${SLEEP}s, diffs every ${DIFF_EVERY}s"
while :; do
  touch "$R/.agent"
  primary_poly
  # NEVER write without the dispatcher: without it update_from_dir would open the files directly,
  # behind nobody's lock. `--show-dir` answers File_Error when there is no dispatcher to ask.
  if "$BIN/dispatcher" --osm-base --show-dir 2>&1 | grep -q File_Error; then
    log "no dispatcher answering yet; waiting"
    sleep 30
    continue
  fi
  for d in "$R"/*/; do
    d=${d%/}
    [ "$(basename "$d")" = _primary ] && continue
    [ -f "$d/state.json" ] || continue
    case "$(field state "$d/state.json")" in
      staged) apply_import "$d" ;;
    esac
    [ "$(field state "$d/state.json")" = applied ] && follow "$d"
  done
  sleep "$SLEEP"
done
