#!/usr/bin/env bash
# The ROM zips in ext/reference-artwork/roms/ are labelled for a much older MAME (the MAME 2003
# reference set). The bytes are right; the file names are not. This matches every file by CRC
# against what MAME 0.276 expects and writes correctly named zips to ext/reference-artwork/
# roms-mame/, one per set that is fully covered (missing PLD dumps are stood in for by zero-filled
# blanks — see below).
#
#   tools/sf2-probe/rebuild-romsets.sh                     # every sf2* set
#   PATTERN='mk*' tools/sf2-probe/rebuild-romsets.sh       # some other family
set -euo pipefail
SRC=${1:-ext/reference-artwork/roms}
OUT=${2:-ext/reference-artwork/roms-mame}
PATTERN=${PATTERN:-'sf2*'}
# Files this big or smaller are stood in for with zeros when they are missing: PLD equations by
# default, and on request a sound DSP (BLANK_MAX=8192), which costs audio we do not record anyway.
BLANK_MAX=${BLANK_MAX:-300}
MAME=${MAME:-/usr/games/mame}
mkdir -p "$OUT"
TMP=$(mktemp -d)

# crc -> "zip file" index over every zip we have
for z in "$SRC"/*.zip; do
  unzip -v "$z" | awk -v z="$z" 'NR>3 && $1 ~ /^[0-9]+$/ {print tolower($7), z, $8}'
done | sort -u > "$TMP/have.txt"

for set in $($MAME -listfull "$PATTERN" 2>/dev/null | awk 'NR>1{print $1}'); do
  $MAME -listroms "$set" 2>/dev/null | awk 'NR>2 && $3 ~ /^CRC/ {gsub(/CRC\(|\)/,"",$3); print $1, tolower($3), $2}' > "$TMP/want.txt"
  total=$(wc -l < "$TMP/want.txt"); [ "$total" -gt 0 ] || continue
  found=0; pld_missing=0; missing=""
  rm -rf "$TMP/build"; mkdir -p "$TMP/build"
  while read -r name crc size; do
    line=$(grep -m1 "^$crc " "$TMP/have.txt" || true)
    if [ -n "$line" ]; then
      zip=$(echo "$line" | awk '{print $2}'); file=$(echo "$line" | awk '{print $3}')
      unzip -p "$zip" "$file" > "$TMP/build/$name"; found=$((found+1))
    elif [ "$size" -le "$BLANK_MAX" ]; then
      # A PLD dump we do not have. MAME refuses to start with a file *missing* but only warns about a
      # wrong checksum, so a blank of the right size stands in. The logic in a PLD is glue the
      # emulator does not use; nothing about the game changes.
      head -c "$size" /dev/zero > "$TMP/build/$name"; pld_missing=$((pld_missing+1))
    else missing="$missing $name"; fi
  done < "$TMP/want.txt"
  if [ -z "$missing" ]; then
    (cd "$TMP/build" && zip -q -0 "$OLDPWD/$OUT/$set.zip" ./*)
    printf "%-10s COMPLETE  %d/%d files (%d PLD dumps absent)\n" "$set" "$found" "$total" "$pld_missing"
  else
    printf "%-10s partial   %d/%d  missing:%s\n" "$set" "$found" "$total" "$missing"
  fi
done | tee -a "$OUT/REPORT.txt"
rm -rf "$TMP"
