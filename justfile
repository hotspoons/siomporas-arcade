# Apex monorepo — task recipes (https://just.systems)
#   apps/conduit  tunnel racer-shooter        :5180
#   apps/stuntin  stunt-track driving game    :5181
#   apps/coast    pseudo-3D sprite racer      :5182
#   packages/engine  shared runtime (loop, styles, input, menus, math, dev bridge)

set shell := ["bash", "-euo", "pipefail", "-c"]

# list recipes
default:
    @just --list --unsorted

# --- dev loop ---------------------------------------------------------------

# Vite dev server for an app (conduit :5180, stuntin :5181, coast :5182)
dev app="conduit":
    npm run dev -w apps/{{ app }}

# production build of everything (typecheck + bundles) into apps/*/dist
build:
    npm run build

# serve an app's production build
preview app="conduit":
    npm run build -w apps/{{ app }} && npm run preview -w apps/{{ app }}

# --- checks -----------------------------------------------------------------

# lint (oxlint) + typecheck (tsc project refs) + unit tests (vitest)
check:
    @node scripts/check-lockfile.mjs
    npm run lint
    npx tsc -b
    npx vitest run

lint:
    npm run lint

typecheck:
    npx tsc -b

# unit tests only
test:
    npx vitest run

# --- dev operator shell (opt-in) --------------------------------------------
# A JS shell into the LIVE page: the dev server relays code you POST to the
# running app and returns a JSON-safe result — real browser, real GPU. OFF
# unless APEX_BRIDGE is set, and it cannot reach a production build at all.
# See packages/engine/src/dev/bridge-plugin.ts.

export APEX_BRIDGE := env_var_or_default("APEX_BRIDGE", "")

# dev server WITH the operator shell enabled (token: apex-dev, override with APEX_BRIDGE)
bridge-dev app="conduit":
    APEX_BRIDGE="${APEX_BRIDGE:-apex-dev}" npm run dev -w apps/{{ app }}

# evaluate JS in the attached page: `just bridge 'apex.snap.vehicle.s'` (add `stuntin` as the 2nd arg for the other app)
bridge code app="conduit":
    APEX_BRIDGE="${APEX_BRIDGE:-apex-dev}" APEX_ORIGIN="http://localhost:$(just _port {{ app }})" node scripts/bridge.mjs {{ quote(code) }}

# list the pages currently attached to the shell
bridge-clients app="conduit":
    APEX_BRIDGE="${APEX_BRIDGE:-apex-dev}" APEX_ORIGIN="http://localhost:$(just _port {{ app }})" node scripts/bridge.mjs --clients

_port app:
    @case "{{ app }}" in stuntin) echo 5181;; coast) echo 5182;; *) echo 5180;; esac

# --- remote testing ---------------------------------------------------------

# anonymous Cloudflare quick tunnel to an app's dev server; prints the public URL
tunnel app="conduit":
    PORT=$(just _port {{ app }}) APP={{ app }} bash scripts/tunnel.sh

# --- verification loop ------------------------------------------------------

# drive the running dev server in headless Chromium: boots the game, plays a
# few seconds, screenshots to shots/ and fails on any console error
smoke app="conduit":
    APEX_URL="http://localhost:$(just _port {{ app }})" node scripts/smoke.mjs

# drive the TURBO RADRUN world builder headlessly: builds a track with the pointer,
# saves it, drives it, and checks the built-in route still runs (see scripts/editor-smoke.mjs)
editor-smoke port="5182":
    APEX_URL="http://localhost:{{ port }}" node scripts/editor-smoke.mjs

# shoot the hero car from every angle the atlas bakes (coast's /model.html must be served)
model-shots out="shots/model":
    mkdir -p {{ out }} && OUT={{ out }} node scripts/model-shots.mjs

# headless screenshot probe against a dev server (see scripts/probe.mjs)
probe out="shots/probe.png" seconds="0" *keys:
    node scripts/probe.mjs {{ out }} {{ seconds }} {{ keys }}

# (re)install the headless Chromium the smoke harness drives
browser:
    sudo npx playwright install-deps chromium && npx playwright install chromium

# --- housekeeping -----------------------------------------------------------

clean:
    rm -rf apps/*/dist node_modules/.tmp node_modules/.vite apps/*/node_modules/.vite shots
