#!/bin/bash
# osm-import: stage one Geofabrik region on an Overpass instance's volume, for the instance's own
# `regions` sidecar to apply. Runs as the Job the world editor creates (tools/worldeditor/runs.mjs
# `osmImportJob`; the reviewed manifest is tools/overpass/osm-import-job.yaml), on the instance's
# node, with the instance's volume at /db.
#
# WHY THIS DOES NOT WRITE THE DATABASE. Overpass is written through its dispatcher: the writer asks
# it for the write lock over a socket in /db/db and a segment in /dev/shm, and readers keep reading
# the previous index files until the write is committed. The dispatcher's /dev/shm is the overpass
# pod's own memory-backed emptyDir — no other pod can see it — so a Job that wrote /db/db directly
# would be writing behind a dispatcher that is serving readers off the same files. This stages the
# change, and the sidecar, which shares /db and /dev/shm with the dispatcher, applies it with the
# same `update_from_dir` the instance's daily diffs use.
#
# Measured on the instance's own image, locally (tools/overpass/README.md, "Adding a region"):
# Maryland (216 MB pbf, 4.9 GB as an osmChange) applied into a live Washington database in 279 s,
# peak 1.4 GB, with 217 queries answered during it at p95 180 ms; Washington into Maryland, this
# script and the sidecar end to end, in 42 s.
#
# Everything this writes is under /db/regions/<id>/. Exit status is the verdict; the world editor
# reads it from the Job.
set -euo pipefail

: "${REGION_ID:?REGION_ID is required}"
: "${PBF_URL:?PBF_URL is required}"
UPSTREAM=${UPSTREAM:-overpass}
DB_ROOT=${DB_ROOT:-/db}
OSMIUM=${OSMIUM:-osmium}
INTERPRETER=${INTERPRETER:-http://$UPSTREAM/api/interpreter}
WAIT_HOURS=${WAIT_HOURS:-46}
UA="apex-conduit corridor osm-import (github.com/hotspoons)"

SAFE=$(printf '%s' "$REGION_ID" | tr -c 'a-zA-Z0-9-' '_')
DIR=$DB_ROOT/regions/$SAFE
AGENT=$DB_ROOT/regions/.agent

log() { echo "[import $(date -u +%H:%M:%S)] $*"; }
fail() { log "FAILED: $*"; [ -d "$DIR" ] && state "{\"state\":\"failed\",\"stage\":\"import\",\"why\":$(json "$*"),\"at\":\"$(now)\"}"; exit 1; }
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
json() { printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"; }
state() { printf '%s\n' "$1" > "$DIR/state.json.tmp" && mv "$DIR/state.json.tmp" "$DIR/state.json"; }
field() { sed -n "s/.*\"$1\": *\"\{0,1\}\([^\",}]*\)\"\{0,1\}.*/\1/p" "$2" | head -1; }

log "adding $REGION_ID to $UPSTREAM"
log "  pbf      $PBF_URL"

# ---- 0. the sidecar must be there: it applies; this only stages ----------------------------------
if [ ! -f "$AGENT" ]; then
  log "FAILED: $UPSTREAM has no regions sidecar ($AGENT does not exist)."
  log "        helm upgrade the $UPSTREAM release with regions.enabled=true first (tools/overpass/README.md)."
  exit 3
fi
age=$(( $(date +%s) - $(stat -c %Y "$AGENT") ))
if [ "$age" -gt 1800 ]; then
  log "FAILED: the regions sidecar has not run for ${age}s ($AGENT). Is the $UPSTREAM pod healthy?"
  exit 3
fi

mkdir -p "$DIR/import"
if [ -f "$DIR/state.json" ] && [ "$(field state "$DIR/state.json")" = applied ] && [ "${REIMPORT:-0}" != 1 ]; then
  log "$REGION_ID is already applied on $UPSTREAM (state.json); nothing to do. REIMPORT=1 stages it again."
  exit 0
fi
state "{\"state\":\"downloading\",\"id\":$(json "$REGION_ID"),\"at\":\"$(now)\"}"

# ---- 1. the extract and its outline ---------------------------------------------------------------
# curl -L: `-latest` is a redirect to a dated file, and the large ones go on to a mirror
curl -fsSL --retry 5 --retry-delay 30 -A "$UA" -o "$DIR/region.osm.pbf.part" "$PBF_URL" || fail "download of $PBF_URL failed"
mv "$DIR/region.osm.pbf.part" "$DIR/region.osm.pbf"
PBF_BYTES=$(stat -c %s "$DIR/region.osm.pbf")
log "  got      $(( PBF_BYTES / 1048576 )) MiB"
# Geofabrik: <region>-latest.osm.pbf beside <region>.poly — the polygon the extract was cut with,
# which the delete filter needs (defer_deletes.py) and the coverage map shows
POLY_URL=${POLY_URL:-${PBF_URL%-latest.osm.pbf}.poly}
curl -fsSL --retry 3 -A "$UA" -o "$DIR/region.poly" "$POLY_URL" || fail "the region's outline $POLY_URL could not be read"

# ---- 2. what the extract says about itself -------------------------------------------------------
# The replication sequence in the header is where this region's diff stream picks up. Without it
# the region could be imported and never kept current, which would rot without a sound — so it is
# a failure here, not a warning.
HDR=$("$OSMIUM" fileinfo "$DIR/region.osm.pbf") || fail "osmium cannot read the download — truncated or not a pbf"
SEQ=$(printf '%s\n' "$HDR" | sed -n 's/.*osmosis_replication_sequence_number=\([0-9]*\).*/\1/p' | head -1)
BASE=$(printf '%s\n' "$HDR" | sed -n 's/.*osmosis_replication_base_url=\(.*\)$/\1/p' | head -1)
TS=$(printf '%s\n' "$HDR" | sed -n 's/.*osmosis_replication_timestamp=\(.*\)$/\1/p' | head -1)
[ -n "$SEQ" ] && [ -n "$BASE" ] || fail "the extract carries no replication sequence/base url, so it could never be kept current"
UPDATES=${UPDATES_URL:-$BASE}
[ "${UPDATES%/}" = "${BASE%/}" ] || log "  note: the index names $UPDATES_URL but the file says $BASE; following the file's"
UPDATES=$BASE
log "  snapshot $TS (sequence $SEQ of $UPDATES)"

# ---- 3. room for it --------------------------------------------------------------------------------
# An apply through update_from_dir is copy-on-write: every flush writes the .map blocks it touches
# to new space, so the database grows by far more than the data. Measured on the instance's image:
#   Washington (21 MB pbf) into Maryland (31.0 GB)   +7.1 GB
#   Maryland (216 MB) into Washington (6.0 GB)       +35 GB (a fresh build of both is 31 GB)
#   Virginia (408 MiB) into Maryland (31.0 GB)       +40 GB and still going when stopped at 90%
# plus the staged osmChange, ~22x the pbf. So: free space of at least the database's own size, or
# 150x the pbf, whichever is more — and the message says which.
FREE=$(df --output=avail -B1 "$DB_ROOT" | tail -1)
DBSIZE=$(du -sb "$DB_ROOT/db" 2>/dev/null | cut -f1)
DBSIZE=${DBSIZE:-0}
NEED=$(( PBF_BYTES * 150 ))
[ "$DBSIZE" -gt "$NEED" ] && NEED=$DBSIZE
log "  space    $(( FREE / 1073741824 )) GiB free; want $(( NEED / 1073741824 )) GiB (database $(( DBSIZE / 1073741824 )) GiB, pbf x150 $(( PBF_BYTES * 150 / 1073741824 )) GiB)"
if [ "$FREE" -lt "$NEED" ] && [ "${IGNORE_SPACE:-0}" != 1 ]; then
  fail "not enough room on $UPSTREAM's volume: $(( FREE / 1073741824 )) GiB free, about $(( NEED / 1073741824 )) GiB wanted. Grow the volume (or rebuild the instance from a merged extract — tools/overpass/README.md)."
fi

# ---- 4. the change -------------------------------------------------------------------------------
# Every object as a create/modify. Overpass treats the two alike (it stores the version it is
# given), so an object the database already holds — a way crossing the border, which both
# neighbouring extracts carry in full — is written again with the same content.
log "  converting to an osmChange"
"$OSMIUM" cat "$DIR/region.osm.pbf" -f osc -o "$DIR/import/region.osc" --overwrite || fail "osmium could not write the osmChange"
log "  staged   $(( $(stat -c %s "$DIR/import/region.osc") / 1048576 )) MiB"

# a control for later: a sample of the region's own ways, which must all be there afterwards
WAYS=$("$OSMIUM" fileinfo -e -g data.count.ways "$DIR/region.osm.pbf")
STEP=$(( WAYS / 40 + 1 ))
# (awk stops reading after 40, osmium then dies of SIGPIPE, and pipefail would call that a failure)
{ "$OSMIUM" cat "$DIR/region.osm.pbf" -t way -f opl | awk -v s="$STEP" 'NR % s == 1 { sub(/^w/, "", $1); print $1; if (++n >= 40) exit }'; } > "$DIR/control.ids" || true
[ -s "$DIR/control.ids" ] || fail "could not sample the region's ways for the control"

cat > "$DIR/request.json" <<EOF
{"id":$(json "$REGION_ID"),"name":$(json "${REGION_NAME:-$REGION_ID}"),"sequence":$SEQ,"updates":$(json "$UPDATES"),"snapshot":$(json "$TS"),"pbf":$(json "$PBF_URL"),"pbfBytes":$PBF_BYTES,"ways":$WAYS,"staged":"$(now)"}
EOF
rm -f "$DIR/region.osm.pbf"
# the sidecar applies as the `overpass` user, which owns the database
[ "$(id -u)" = 0 ] && chown -R 1000:1000 "$DIR" || true
state "{\"state\":\"staged\",\"id\":$(json "$REGION_ID"),\"at\":\"$(now)\"}"
log "  staged; waiting for $UPSTREAM's regions sidecar to apply it"

# ---- 5. wait for the apply, and show it ------------------------------------------------------------
off=0
deadline=$(( $(date +%s) + WAIT_HOURS * 3600 ))
while :; do
  if [ -f "$DIR/apply.log" ]; then
    size=$(stat -c %s "$DIR/apply.log")
    [ "$size" -lt "$off" ] && off=0
    if [ "$size" -gt "$off" ]; then tail -c +$(( off + 1 )) "$DIR/apply.log" | head -c $(( size - off )); off=$size; fi
  fi
  st=$(field state "$DIR/state.json")
  case "$st" in
    applied) break ;;
    failed) log "FAILED: the sidecar could not apply it: $(field why "$DIR/state.json")"; exit 1 ;;
  esac
  [ "$(date +%s)" -lt "$deadline" ] || fail "no apply after ${WAIT_HOURS} h (state: $st)"
  sleep 10
done

# ---- 6. the control: the instance answers for the region now --------------------------------------
# Content, never status: a 200 from an instance that does not hold the region is the whole failure
# this lane exists for. Every sampled way of the region's own must come back.
want=$(wc -l < "$DIR/control.ids")
ids=$(paste -sd, "$DIR/control.ids")
got=$(curl -fsS --max-time 300 --data-urlencode "data=[out:json][timeout:240];way(id:$ids);out ids;" "$INTERPRETER" | { grep -o '"type": *"way"' || true; } | wc -l) || got=-1
log "  control  $got of $want sampled ways of $REGION_ID answered by $UPSTREAM"
[ "$got" -eq "$want" ] || fail "$UPSTREAM answered $got of $want of the region's own ways after the apply"
log "done: $UPSTREAM holds $REGION_ID, and its regions sidecar follows $UPDATES from sequence $SEQ"
