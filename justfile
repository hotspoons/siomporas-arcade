# Apex monorepo — task recipes (https://just.systems)
#   apps/arcade   the arcade: every game on one address   :5183   <- what ships
#   apps/conduit  tunnel racer-shooter                    :5180
#   apps/stuntin  stunt-track driving game                :5181
#   apps/coast    pseudo-3D sprite racer                  :5182
#   apps/fighter  2D/2.5D/3D fighting game                 :5184
#   apps/corridor viewer for tools/corridor bakes          :5185
#   apps/corridor world editor (just worldeditor-app)      :5212  (service on :8780)
#   packages/engine  shared runtime (loop, styles, input, menus, router, math, dev bridge)
#
# The three games still run on their own — that is where tuning, the bridge and the smoke
# harness live. The arcade mounts the same games into one page; `just dev arcade` is the
# thing a player actually sees.

set shell := ["bash", "-euo", "pipefail", "-c"]

# list recipes
default:
    @just --list --unsorted

# --- dev loop ---------------------------------------------------------------

# Vite dev server for an app (arcade :5183, conduit :5180, stuntin :5181, coast :5182, fighter :5184, corridor :5185)
dev app="arcade":
    npm run dev -w apps/{{ app }}

# production build of everything (typecheck + bundles) into apps/*/dist
build:
    npm run build

# serve an app's production build
preview app="arcade":
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

# measure every cabinet's artwork against the machine it goes on (see apps/arcade/ART.md)
art-check *games:
    node scripts/cabinet-check.mjs {{ games }}

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

# corridor's bridge needs :5185 free — stop the plain `just corridor-view` server first, then
# `just bridge-dev corridor`, open http://localhost:5185 in a REAL browser, and drive it with
# `just bridge 'apex.perf()' corridor`. The agent box has no GPU, so every frame-time number
# measured there is swiftshader's; this is how a real one gets read.

# list the pages currently attached to the shell
bridge-clients app="conduit":
    APEX_BRIDGE="${APEX_BRIDGE:-apex-dev}" APEX_ORIGIN="http://localhost:$(just _port {{ app }})" node scripts/bridge.mjs --clients

_port app:
    @case "{{ app }}" in stuntin) echo 5181;; coast) echo 5182;; arcade) echo 5183;; fighter) echo 5184;; corridor) echo 5185;; *) echo 5180;; esac

# --- remote testing ---------------------------------------------------------

# anonymous Cloudflare quick tunnel to an app's dev server; prints the public URL
tunnel app="conduit":
    PORT=$(just _port {{ app }}) APP={{ app }} bash scripts/tunnel.sh

# --- verification loop ------------------------------------------------------

# drive the running dev server in headless Chromium: boots the game, plays a
# few seconds, screenshots to shots/ and fails on any console error
smoke app="conduit":
    APEX_URL="http://localhost:$(just _port {{ app }})" node scripts/smoke.mjs

# drive the arcade shell headlessly: routes and the Back button, then mount/unmount every
# game a few times over watching for leaked canvases, AudioContexts and heap, then play each
# one. This is the check on the shell↔game contract (see apps/arcade/src/Shell.ts).
arcade-smoke rounds="2":
    ARCADE_URL="http://localhost:5183" ROUNDS={{ rounds }} node scripts/arcade-smoke.mjs

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

# install or build the pinned Blender in the foreground (post-create does it in the background)
blender:
    bash .devcontainer/build-blender.sh

# How far the background Blender build got.
blender-log:
    @tail -n 40 ~/.cache/blender-build.log 2>/dev/null || echo "no build log yet"

clean:
    rm -rf apps/*/dist node_modules/.tmp node_modules/.vite apps/*/node_modules/.vite shots

# --- corridor: real-road strips for the driving game -------------------------
# tools/corridor pulls a couple of miles of road either side of each reference photo: OSM spine
# and features, 1 m DEM, 30 cm NAIP, the classified lidar point cloud (bridge decks, canopy,
# cut/fill) and the geology under it. Python, in its own venv (see .devcontainer/post-create.sh).

# photos in ext/ref-driving -> tools/corridor/sites.json
corridor-sites:
    tools/corridor/.venv/bin/python -m corridor sites

# build tools/corridor/data/sites/<slug>/ (slug or `all`); e.g. `just corridor-fetch south-mountain-i70 --skip lidar`
corridor-fetch slug="all" *args:
    cd tools/corridor && .venv/bin/python -u -m corridor fetch {{ slug }} {{ args }}

# the viewer for baked sites, on :5185 (reads tools/corridor/data/sites straight off disk)
corridor-view:
    npm run dev -w apps/corridor

# rewrite the web/ layers + sites/index.json without re-fetching
corridor-export slug="all":
    tools/corridor/.venv/bin/python -m corridor export {{ slug }}

# a tunnel that survives dev-server restarts: devproxy on :5190 fronts the viewer, cloudflared fronts the proxy
corridor-tunnel:
    (node scripts/devproxy.mjs --listen 5190 --target 5185 &) && sleep 1 && PORT=5190 APP=corridor bash scripts/tunnel.sh

# one line per fetched site
corridor-report:
    tools/corridor/.venv/bin/python -m corridor report

# --- world editor: draw a world on a map, bake it, publish it ------------------
# tools/worldeditor is the pod's backend and apps/corridor/world.html is its page. The two run as
# two processes in development and one image in the cluster; see tools/worldeditor/README.md.
#
# The service on :8780 and the app on :5212 — run these in two terminals, in this order. The app
# reaches the service through a Vite proxy, so every fetch in the page is relative, exactly as it
# is in the pod.

# the world editor's backend, on :8780 (OSM, worlds, bakes, the editor's save path)
worldeditor-svc:
    node tools/worldeditor/server.mjs --port 8780 --data tools/corridor/data

# the world editor page, on :5212 -> http://localhost:5212/world.html
worldeditor-app:
    CORRIDOR_PORT=5212 WORLDEDITOR=http://localhost:8780 npm run dev -w apps/corridor

# `just worldeditor-probe` checks every claim in the README; `prove` runs the negatives instead —
# each check fed something that must break it, which is the only reason to believe the rest.

# the world editor's probe; `just worldeditor-probe prove` runs the negatives
worldeditor-probe mode="":
    #!/usr/bin/env bash
    set -euo pipefail
    if [ "{{ mode }}" = "prove" ]; then
      node tools/worldeditor/probe.mjs --prove
    else
      node tools/worldeditor/probe.mjs --api http://localhost:8780 --ui http://localhost:5212/world.html
    fi
