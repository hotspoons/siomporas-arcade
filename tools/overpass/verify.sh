#!/usr/bin/env bash
# Is this Overpass instance safe to put FIRST in the rotation?
#
# THE ONLY QUESTION THAT MATTERS IS COVERAGE, and a status code cannot answer it. A regional
# extract answers an out-of-area bbox with HTTP 200 and zero ways — not an error, not a 404, a
# success with nothing in it (docs/corridor/OVERPASS-PLANET.md, "the silent empty"). So this
# asserts NON-ZERO WAYS for boxes on three continents, and "no exception" is not a pass.
#
#   tools/overpass/verify.sh http://host/api/interpreter
#   tools/overpass/verify.sh --pod overpass-eu        # exec into the pod, no route needed
#
# THREE OUTCOMES, NOT TWO, and keeping them apart is the point of the whole file:
#
#   ok       200 with ways            this instance holds that area
#   EMPTY    200 with zero ways       the silent empty — the failure this exists to catch
#   NOASK    504, timeout, no JSON    could not ask; inconclusive, retry, NOT a coverage verdict
#
# Conflating the last two is how you conclude "our extract is missing Italy" when a public mirror
# was merely overloaded. The first version of this script did exactly that, and its own positive
# control caught it.
#
# Proven in both directions before being trusted:
#   against the Maryland instance -> Crofton 508 ok, Stelvio EMPTY, Sydney EMPTY   (must go red)
#   against a planet-wide mirror  -> all three ok                                   (must go green)
set -uo pipefail

MODE=url; TARGET="${1:-}"
[ "${1:-}" = "--pod" ] && { MODE=pod; TARGET="${2:-}"; }
[ -z "$TARGET" ] && { echo "usage: $0 <interpreter-url> | --pod <pod-label>"; exit 2; }
RETRIES="${VERIFY_RETRIES:-3}"

BOXES=(
  "Crofton, Maryland|39.00,-76.70,39.02,-76.68|the box every US bake depends on"
  "Stelvio pass, Italy|46.50,10.40,46.56,10.50|the box a Maryland extract answers with silence"
  "Sydney, Australia|-33.88,151.19,-33.86,151.22|southern hemisphere, as the rollout asks"
)

ask() {
  if [ "$MODE" = pod ]; then
    local p; p=$(kubectl get pods -n default -l "app=$TARGET" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
    [ -z "$p" ] && return 1
    kubectl exec -n default "$p" -- sh -c "wget -qO- --post-data=\"data=$1\" http://localhost/api/interpreter" 2>/dev/null
  else
    curl -sf --max-time 240 -A "apex-conduit corridor (github.com/hotspoons)" \
         --data-urlencode "data=$1" "$TARGET" 2>/dev/null
  fi
}

empty=0; noask=0
printf '%-22s %8s  %s\n' "box" "ways" "verdict"
for row in "${BOXES[@]}"; do
  IFS='|' read -r name bbox why <<< "$row"
  n=-1
  for try in $(seq 1 "$RETRIES"); do
    out=$(ask "[out:json][timeout:90];way($bbox)[highway];out ids;") || { sleep $((try*5)); continue; }
    n=$(printf '%s' "$out" | python3 -c 'import json,sys
try: print(len(json.load(sys.stdin).get("elements",[])))
except Exception: print(-1)' 2>/dev/null || echo -1)
    [ "$n" -ge 0 ] 2>/dev/null && break
    sleep $((try*5))
  done
  if   [ "$n" -gt 0 ] 2>/dev/null; then v="ok"
  elif [ "$n" -eq 0 ] 2>/dev/null; then v="EMPTY — $why"; empty=1
  else v="NOASK — no answer after $RETRIES tries; inconclusive, not a coverage verdict"; noask=1; fi
  printf '%-22s %8s  %s\n' "$name" "$n" "$v"
done
echo
if [ $empty -eq 1 ]; then
  echo "FAIL — a box came back with HTTP 200 and nothing in it. That is the silent empty: it is"
  echo "       indistinguishable from 'no roads there' and it is how a regional instance poisons"
  echo "       the editor. Do NOT put this first in the rotation."
  exit 1
elif [ $noask -eq 1 ]; then
  echo "INCONCLUSIVE — could not reach the instance for at least one box. Nothing is proven about"
  echo "       coverage either way; fix the transport and run again."
  exit 2
else
  echo "PASS — every box returned ways. Safe to put first in the rotation."
  exit 0
fi
