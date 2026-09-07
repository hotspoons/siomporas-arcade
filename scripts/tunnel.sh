#!/usr/bin/env bash
# Anonymous Cloudflare quick tunnel to the dev server, for testing on a phone
# or from anywhere. Starts `just bridge-dev` if nothing is listening on :5180
# yet (so it can also attach to a dev server you already have running), then
# prints the public https URL and keeps streaming cloudflared's log.
#
#   just tunnel            # prints  ➜  TUNNEL: https://<random>.trycloudflare.com
#   cat .tunnel-url        # the same URL, for scripts
#
# HTTPS matters: phones only expose motion sensors on secure origins.
set -euo pipefail
PORT="${PORT:-5180}"

if ! (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -q ":$PORT "; then
  echo "no dev server on :$PORT — starting one (bridge enabled)"
  APEX_BRIDGE="${APEX_BRIDGE:-apex-dev}" npm run dev >/dev/null 2>&1 &
  DEV=$!
  trap 'kill $DEV 2>/dev/null || true' EXIT
  for _ in $(seq 1 30); do
    (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -q ":$PORT " && break
    sleep 0.5
  done
fi

rm -f .tunnel-url
cloudflared tunnel --url "http://localhost:$PORT" --no-autoupdate 2>&1 | while IFS= read -r line; do
  if [[ -z "${URL:-}" && "$line" =~ (https://[a-z0-9-]+\.trycloudflare\.com) ]]; then
    URL="${BASH_REMATCH[1]}"
    echo "$URL" > .tunnel-url
    printf '\n  \033[32m➜\033[0m  TUNNEL: \033[1m%s\033[0m\n\n' "$URL"
  elif [[ "$line" == *ERR* || "$line" == *error* ]]; then
    echo "$line"
  fi
done
