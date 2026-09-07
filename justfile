# Apex Conduit — task recipes (https://just.systems)

set shell := ["bash", "-euo", "pipefail", "-c"]

# list recipes
default:
    @just --list --unsorted

# --- dev loop ---------------------------------------------------------------

# Vite dev server on :5180
dev:
    npm run dev

# production build (typecheck + bundle) into dist/
build:
    npm run build

# serve the production build on :5180
preview:
    npm run build && npm run preview -- --port 5180 --strictPort --host

# --- checks -----------------------------------------------------------------

# lint (oxlint) + typecheck (tsc project refs) + unit tests (vitest)
check:
    npm run lint
    npx tsc -b
    npx vitest run

# unit tests only
test:
    npx vitest run

lint:
    npm run lint

typecheck:
    npx tsc -b

# --- dev operator shell (opt-in) --------------------------------------------
# A JS shell into the LIVE page: the dev server relays code you POST to the
# running app and returns a JSON-safe result — real browser, real GPU. OFF
# unless APEX_BRIDGE is set, and it cannot reach a production build at all.
# See dev/bridge-plugin.ts.

export APEX_BRIDGE := env_var_or_default("APEX_BRIDGE", "")

# dev server WITH the operator shell enabled (token: apex-dev, override with APEX_BRIDGE)
bridge-dev:
    APEX_BRIDGE="${APEX_BRIDGE:-apex-dev}" npm run dev

# evaluate JS in the attached page: `just bridge 'apex.game.v'`
bridge code:
    APEX_BRIDGE="${APEX_BRIDGE:-apex-dev}" node scripts/bridge.mjs {{ quote(code) }}

# list the pages currently attached to the shell
bridge-clients:
    APEX_BRIDGE="${APEX_BRIDGE:-apex-dev}" node scripts/bridge.mjs --clients

# --- remote testing ---------------------------------------------------------

# anonymous Cloudflare quick tunnel to the dev server; prints the public URL
tunnel:
    bash scripts/tunnel.sh

# --- verification loop ------------------------------------------------------

# drive the running dev server in headless Chromium: boots the game, plays a
# few seconds, screenshots to shots/ and fails on any console error
smoke:
    node scripts/smoke.mjs

# headless screenshot probe against the dev server (see scripts/probe.mjs)
probe out="shots/probe.png" seconds="0" *keys:
    node scripts/probe.mjs {{ out }} {{ seconds }} {{ keys }}

# (re)install the headless Chromium the smoke harness drives
browser:
    sudo npx playwright install-deps chromium && npx playwright install chromium

# --- housekeeping -----------------------------------------------------------

clean:
    rm -rf dist node_modules/.tmp node_modules/.vite shots
