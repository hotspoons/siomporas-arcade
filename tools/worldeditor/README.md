# worldeditor — an online editor pod for building worlds

Explore OSM on a map, draw a boundary, turn it into a site the bake accepts, run the bake and
watch it, make a generated asset placeable, and publish the result to a bucket. It runs as a pod
on the cluster, and **the browser knows exactly one origin: this service.**

```
  browser ──HTTP──> worldeditor ──┬─► Overpass (ours, cached on the volume WITH the bake)
                                  ├─► the Kubernetes API (start a bake Job, follow its log)
                                  ├─► assetsvc, proxied (it reaches the GPUs; we never do)
                                  └─► the volume: sites, worlds, runs, authored files, catalog
```

```bash
# development: the app on 5212, this service on 8780, both against the corridor data directory
node tools/worldeditor/server.mjs --port 8780 --data tools/corridor/data
CORRIDOR_PORT=5212 WORLDEDITOR=http://localhost:8780 npm run dev -w apps/corridor
#   -> http://localhost:5212/world.html

node tools/worldeditor/probe.mjs                              # everything that needs no service
node tools/worldeditor/probe.mjs --prove                      # the checks, broken on purpose
node tools/worldeditor/probe.mjs --api http://localhost:8780 --ui http://localhost:5212/world.html
```

## What it is made of, and what it deliberately is not

| | |
|---|---|
| `server.mjs` | routes, the static app, the assetsvc proxy |
| `store.mjs` | the volume: the `/sites/**` contract, world definitions, runs, the merged catalog |
| `overpass.mjs` | two typed queries against our own Overpass, cached by the bake's own key |
| `worlds.mjs` | a drawn boundary → a `sites.json` entry, and what it will cost |
| `geo.mjs` | lon/lat only. Web Mercator, and the smallest circle containing a polygon |
| `runs.mjs` | a bake or a publish, as a Job or a subprocess, and its log |
| `k8s.mjs` | the two Kubernetes calls this makes, by hand |
| `probe.mjs` | every claim below, and a negative for every check |

It does **not** rebuild the asset pipeline (`tools/assetsvc` owns that and is proxied), the bake
(`tools/corridor`), the publish (`corridor publish`), or the design system (`apps/corridor/src/ui`).

## The five things worth knowing

### 1. The editor's save path exists in a pod now, and the editor did not change

`apps/corridor/src/editor/schema.ts` saves by `PUT /sites/<slug>/<name>.json`, and in development
that is answered by a middleware inside `apps/corridor/vite.config.ts`. **There is no Vite in a
pod.** So this service implements the same contract against the volume: the same paths, the same
five-name whitelist (`adjustments`, `placements`, `structures`, `dead_ends`, `tuning`), the same
`{ok, bytes}` reply, the same atomic tmp-and-rename, and the same refusal to fall through to an
HTML page when a file is missing. `schema.ts` and `sitetuning.ts` are untouched and cannot tell
the difference, which is also why a bug fixed in one is fixed in both.

A whitelist and not a path check: the bake owns `web/` and every raster beside it, and a PUT over
`manifest.json` would destroy a bake that cost an hour of USGS bandwidth.

### 2. The bake takes a SQUARE. The editor says so, in numbers

`network.roads` queries the geodetic bounding box of a **UTM square of side 2·radius_m** and there
is no circular clip on roads anywhere after it. A `radius_m` reads like a circular cut and is not
one. So the editor draws the square solid, labelled, and the circle only as a dashed hint at where
the radius came from — and the panel reports both counts:

```
in the square (baked)     163 ways · 46.8 km
inside your boundary       62 ways · 25.1 km
```

A boundary drawn round the Crofton triangle holds 25.1 km of centreline; the square the bake
actually takes holds 46.8 km. Drawing only the circle is how someone ends up sure they excluded a
motorway that the bake then chains straight through their town.

The preview's own box is a **geodetic** square, not the bake's UTM one, and it is not going to
become one: reimplementing UTM here to match a cache key is exactly the guess that rotated four
lanes' work by 1.06° on 2026-09-21. Instead the difference is measured, against the real
`corridor.geo.Frame`, and the probe fails if it ever goes the wrong way:

| site | EPSG | R | margin the bake adds |
|---|---|---|---|
| crofton-triangle (−76.683, 39.004) | 32618 | 2 600 m | +45.8 … +51.2 m |
| crofton-crownsville (−76.62, 39.0) | 32618 | 9 000 m | +145.5 … +174.5 m |
| a Big Sur centre (−121.9, 36.37) | 32610 | 3 000 m | +32.7 … +39.8 m |
| an Acadia centre (−68.19, 44.33) | 32619 | 2 000 m | +18 … +21 m |

Every margin is positive, so **the preview is conservative: everything it shows, the bake takes.**
The size tracks the grid convergence — zone 10 near its central meridian has less of it than zone
18 at Crofton — which is the cross-check that this is convergence and not an arithmetic slip.

### 3. Nothing here is ever site metres

A drawn boundary, a search result, a road, a world definition: all WGS84 degrees, end to end. Site
metres are meaningless without `manifest.frame.kind` and an anchor, and guessing wrong rotates a
world by the convergence and looks perfectly plausible. This service never holds a coordinate that
needs a frame stamp to interpret, so it cannot make that mistake. The one metre quantity that
leaves is `radius_m`, a geodesic distance, which is frame-free.

The authored files **are** site metres. They are stored as opaque bytes and no coordinate is ever
read out of them.

The Bake panel does read `manifest.frame.kind` off a baked site, and says so when it is still
`utm` — because anything authored against such a bake is in a frame that has since moved.

### 4. The cache is the bake's cache

`osm.py` keys Overpass responses on `sha1(query)[:16]` under `<data>/cache/overpass/`, and so does
this, on the same volume. Panning the map is free after the first look. The probe asks **Python**
for the hash rather than recomputing it in JavaScript, so the two cannot drift.

The browser never sends Overpass QL. This module owns two queries — the drivable network in a box
(`network.roads`' `all_streets` branch verbatim, including its post-query drop list) and a
place-name search — and builds them itself. A page that could post arbitrary QL could put our own
extract on the floor, which is the thing `tools/overpass` exists to prevent.

Ours first, the public mirrors behind it, same list and same order as `osm.py`, because our
extract is one region and a California site still needs a mirror.

### 5. A run is a file, and the browser polls it by byte offset

A bake is twenty minutes to an hour and its log is the thing you want afterwards. So every run has
`<data>/runs/<id>.json` and `<data>/runs/<id>.log` on the volume, written as it goes.
`GET /api/runs/<id>/log?offset=N` returns the bytes after N, and the tail asks again from wherever
it got to.

No EventSource: it needs proxy buffering off at the ingress and dies on a rolling update. And no
`requestAnimationFrame` anywhere near it — **rAF does not fire in a background tab**, which is
exactly the tab someone leaves a forty-minute bake in. Background `setTimeout` is clamped to about
1 Hz, which for a log tail is the difference between "slower" and "stopped".

A restart mid-bake loses nothing: `reconcile()` finds the Job by name and re-attaches, and the log
is already on the volume. A local subprocess cannot outlive its parent, so those are marked failed
with that sentence rather than left saying "running" for ever.

## Endpoints

| | |
|---|---|
| `GET /api/health` · `/api/ready` · `/api/config` | liveness; what is actually reachable; what this is pointed at |
| `GET /api/osm/roads?south&west&north&east` | drivable ways, as the bake would chain them |
| `GET /api/osm/search?q=` | a place in the loaded extract |
| `GET/POST /api/worlds` · `GET/PUT/DELETE /api/worlds/:slug` | world definitions |
| `POST /api/worlds/preview` | a boundary → the circle, the square, and what is in each |
| `GET /api/runs` · `POST /api/runs/bake` · `/api/runs/publish` | start one |
| `GET /api/runs/:id` · `/api/runs/:id/log?offset=` · `POST /api/runs/:id/cancel` | watch or stop it |
| `GET/POST /api/catalog` | the placement catalog — **POST merges by id and cannot replace** |
| `GET/PUT /sites/**` | the bake tree, and the editor's save |
| `/assetsvc/**` | proxied to assetsvc, unmodified |
| `/`, `/index.html`, `/editor.html` | the built app: the world editor, the viewer, the site editor |

`/api/ready` **reports and does not gate**. If Overpass is down this can still serve baked sites,
save authored files and watch a run, and taking the pod out of the Service for that would break the
editor for a fault it can work around and describe. The kubelet probes `/api/health`.

## Configuration

Environment only, so the chart and a laptop run the same code.

| | |
|---|---|
| `WORLDEDITOR_PORT` `_HOST` | where to listen (`--port`, `--host`) |
| `WORLDEDITOR_DATA` | the volume (`--data`). Default `tools/corridor/data` |
| `WORLDEDITOR_APP` | the built app to serve (`--app`). Default `apps/corridor/dist` |
| `WORLDEDITOR_OVERPASS_URL` | comma list, ours first; the public mirrors are appended |
| `WORLDEDITOR_ASSETSVC` | the assetsvc base URL, e.g. `http://assetsvc.default.svc` |
| `WORLDEDITOR_RUNNER` | force `local`; otherwise Kubernetes when a service-account token is mounted |
| `WORLDEDITOR_BAKE_IMAGE` `_CLAIM` `_BAKE_RESOURCES` | what the Job runs, on which PVC, with what |
| `WORLDEDITOR_NAMESPACE` | default: the pod's own |
| `WORLDEDITOR_S3_BUCKET` `_ENDPOINT` `_REGION` `_PREFIX` `_S3_SECRET` | the publish target |
| `WORLDEDITOR_PYTHON` `_CORRIDOR` | the local runner's interpreter and working directory |
| `WORLDEDITOR_SEED_SITES` | a `sites.json` to seed the worlds from on an empty volume |
| `WORLDEDITOR_CORS` | allowed origin, `*` by default, which is for development |

## In the cluster

```bash
helm upgrade --install worldeditor tools/worldeditor/chart -n default --set enabled=true \
  --set data.existingClaim=corridor-data
kubectl port-forward -n default svc/worldeditor 8780:80     # until a route is turned on
```

`enabled: false` is the default and is the point: nothing in corridor requires this, and a pod that
can create Jobs is something you turn on deliberately.

What the chart makes:

| | |
|---|---|
| Deployment | `Recreate`, one replica. Two processes watching one run's Job would both write its log |
| Service | `worldeditor:80` → the pod's 8780 |
| PVC | **the bake's volume**, RWX — `data.existingClaim: corridor-data` shares it with the bake Job, which is the whole design. The chart will make its own only if you ask it to |
| ServiceAccount + Role + RoleBinding | `jobs: create/get/list/watch/delete` and `pods: get/list` + `pods/log: get`, in one namespace. Nothing cluster-scoped, nothing on secrets |
| Ingress / HTTPRoute | both **off**, and exactly one should ever be on: external-dns publishes whichever object carries the hostname, and two claiming one name fight over the record |

**The Role is the smallest thing that works, and the reason it exists at all is that a person
should be able to start a bake without a kubeconfig.** It cannot read secrets, cannot touch another
namespace, and cannot create anything but a Job. The Job it creates is the chart's Job — same
image, same volume, same env, same command — with `backoffLimit: 0`, because a chart's retry is
right for an unattended nightly and wrong for someone watching a log: a failed bake that silently
restarts prints itself twice and looks like a hang.

**Readiness probes `/api/health`, not `/api/ready`** — see above.

**Which front door.** Both gateways on gh200-1 are Programmed, but `central-gateway` is a ClusterIP,
so an HTTPRoute there gets a DNS record nobody off-cluster can route to. The nginx Ingress is the
proven path and is what `tools/overpass` and `tools/recon-service` both use.

## Traps, measured

**A `<canvas>` is a replaced element.** `position: fixed` with all four insets and `width: auto`
sizes a normal block from the insets and leaves a canvas at its intrinsic **300 × 150**. The map
rendered the whole world, with every transform inside it perfectly correct, into a postage stamp
in the corner. The probe now asserts the canvas fills its box and that the drawing buffer matches
it at the device pixel ratio.

**`--bar-h` is a token and the bar's height is content-driven.** tokens.css says so — it was raised
from 46 to 50 once already for this reason. This bar carries a search field and a two-line world
button and measures 63, so a map sized off the token spent its first thirteen pixels underneath the
bar: invisible until you try to click a road there. The bar is measured into `--we-bar-h` with a
`ResizeObserver`, and the token is the fallback.

**`spawn` reports a missing interpreter on the next tick.** An `await` between `spawn` and
`child.on('error')` means the handler is not attached when it fires, and an unhandled `'error'` on
a ChildProcess throws — so a wrong `WORLDEDITOR_PYTHON` took the whole service down instead of
failing one run. Every handler is attached before the first await now.

**`waitUntil: 'networkidle'` never settles on a page that polls.** The run list and the roads are
both timers, so the first UI probe timed out on a page that had loaded perfectly. The honest signal
is the app saying it is up: `waitForFunction(() => !!window.__we)`.

**The probe's handle is `window.__we`.** Not `window.__apex`, and not `window.corridor` — those
both exist on the viewer and the editor and both carry `site`/`scene`/`camera`, which is how
someone probes the wrong one and gets true answers about the wrong object for an afternoon. This
page has no scene and no renderer, so it gets its own name and holds only what it really has.

**`JSON.parse` throwing un-tagged is a 500.** An unparseable body is the client's fault; the probe
caught it reporting a 500, which tells a person the service is broken when their editor sent
rubbish.

**A guard on the OBJECT is not a guard.** Cancelling a run signalled the child and recorded
`failed — cancelled`; the child's own `close` handler then fired and wrote `failed — exited null`
over it, so the API answered "cancelled" and the file on the volume said something else. Guarding
`#finish` on `run.state` did not fix it, and looked as though it had: `cancel` re-reads the record
off the volume, so it holds a **different object** from the one the child's handler closed over,
and both still say "running". The guard is keyed on the run **id**. The probe now re-reads the run
after cancelling rather than trusting the cancel response, because the response was right the whole
time the stored truth was wrong.

## The probe, and why half of it is negatives

On 2026-09-21 six checks across four lanes returned true answers about the wrong thing, most of
them looking green. **An assertion that cannot fail is not an assertion.** So `--prove` feeds each
check something that must break it and fails if the check stays green.

That mode has already earned its place: the first negative for the smallest-enclosing-circle check
used a SQUARE, where the centroid *is* the circumcentre and the naive answer is exactly right — so
the negative passed and proved nothing. It uses an asymmetric set now.

A skipped check prints `SKIP` and is counted separately, because a skip that prints `ok` is the
same failure in a different costume.

```
 7 passed, 0 failed    # --prove: every check goes red on a broken input
 9 passed, 0 failed    # offline: geometry, the guards, the cache key, the Job spec
21 passed, 0 failed    # + the live service and the page, driven headlessly
21 passed, 0 failed    # + the same, against the BUILT bundle with no Vite at all (the pod path)
```

The negatives keep earning it. The first one for the smallest-enclosing-circle check used a
SQUARE, where the naive answer is exactly right, so it passed and proved nothing. The first one
for the cancel check modelled two objects where the bug needs three, so it passed and proved
nothing. Both are written down above the code that fixes them.
