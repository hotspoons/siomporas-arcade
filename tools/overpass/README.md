# overpass — our own OSM query service

The corridor bake reads OpenStreetMap through Overpass: the road chains, lane tags, crossings,
building footprints and land use for every site. On 2026-09-21 every public mirror refused
connections for about an hour and every new bake died at step one. This is the fix Rich asked for.

## Where the OSM comes from

Every bake and every road on the world editor's map is an Overpass query. They go to our own
instances on gh200-1 first and to four public mirrors only when none of ours holds the place.

| instance | holds (Geofabrik region) | diff stream it follows |
|---|---|---|
| `overpass-eu` | `europe` | `europe-updates` |
| `overpass` | `us/maryland` | `north-america/us/maryland-updates` |
| `overpass-na` | `north-america` | `north-america-updates` |

**Routing is by the extract's real outline, not a box.** Geofabrik publishes each extract's polygon
(`index-v1.json`, and a `.poly` beside every `.pbf`; the two are the same polygon). The world editor
keeps each instance's coverage in `<data>/overpass/coverage.json` on its volume, seeded from
`overpassRegions` in `deploy/gh200-1/worldeditor.yaml` (`WORLDEDITOR_OVERPASS_REGIONS`, also
editable in Settings → Services) and grown by imports. A world's bake goes to the instance whose
coverage holds **all** of the area the bake will ask about (the world's square or ring, padded for
the UTM rotation), the smallest such first; if none does, to the public mirrors.

**Why it is not a box any more (2026-10-10).** `overpass`'s box was `37.9/-79.5/39.8/-75.0`: it
took in Washington, Arlington and Fairfax. Its extract is Maryland. Asked for highways over
Arlington it answered HTTP 200 with 0 ways (`overpass-na`: 4,346); over downtown Washington 0
(6,418); College Park, the control, 5,185 from both. dc-metro-take-2 sits wholly inside that box,
was routed to `overpass`, and baked with 108,816 roads in Maryland and none across the river —
35.3% of its square is outside `maryland.poly`. `overpass-na`, which holds all of it, was never asked.

**The bake checks the routing** (`tools/corridor/corridor/osm.py`). The Job is handed the coverage
file (`CORRIDOR_OVERPASS_COVERAGE`); every query whose area can be read from its text (a bbox, a
`poly:`, an `around:`) goes only to an instance whose coverage holds all of it, and if none of the
instances it was given does, the bake stops with a `BakeFault` naming the instance, its regions and
how much of the query is outside them. A cached answer whose sidecar says it came from an instance
that does not hold the area is asked again; `refreshOsm` on a bake (`run_bake`, or the API) skips the
cache entirely. An answer whose `remark` is a runtime error — a 200 with nothing in it, which an
instance taking an import produces for about 1 query in 100 — is retried and never cached.

**Where the outlines come from.** The editor's copy of Geofabrik's `index-v1.json`
(`<data>/overpass/geofabrik-index.json`, `tools/worldeditor/geofabrik.mjs`). A NEW volume starts
from `tools/worldeditor/geofabrik-seed.json` — the real outlines of `europe`, `north-america`,
`us/district-of-columbia`, `us/maryland` and `us/virginia` — so the deployment's own instances are
routed from the first request with no network; the live index is fetched in the background at
start-up, re-checked every 3 hours (`WORLDEDITOR_GEOFABRIK_CHECK_MS`) and fetched again when the
copy is a week old (an hour after a failure). **An outline is checked region by region.** Geofabrik's
index of 2026-10-10 listed `us/maryland`, `us/virginia` and nine others with
`"coordinates": []`; the editor took that as Maryland's outline, the Maryland instance then held
nothing, and the split's test bake of a Crofton world went to the public mirrors (which answered
504) with no problem reported. Now a region the live index leaves empty keeps the outline of the
volume's previous copy or the seed (said in the log and in `/api/osm/coverage` →
`geofabrik.outlinesFromElsewhere`); a configured region nobody can outline is a coverage problem and
its instance holds nothing (never "everywhere"); a coverage file written before the check heals on
the next start; and a failed fetch is a line in the log (`GEOFABRIK INDEX NOT FETCHED`) and in
`/api/osm/coverage` → `problems` and `geofabrik.error`. `WORLDEDITOR_GEOFABRIK_URL` points the
editor at a mirror of the index.

**See it:** world editor → menu → **OSM data** (or Settings → Services → OSM data…): each instance's
coverage on a map with its health (`/api/status`) and freshness (`/api/timestamp`, the replication
time of its last diff), every world filled with the colour of the instance it reads, and red where
no single instance holds it. While a `#s/w/n/e` box is still on a URL, the ground that box would
have baked as empty is painted red: for dc-metro-take-2 against `overpass`, Washington and northern
Virginia (`probes/worldedit-osmdata.mjs`, `MODE=before`).

## Adding a region to an instance

Rich, 2026-10-10: "Why new instances, why can't we add the data to existing instances? We could have
a job viewer kind of deal like we have for bakes." We can, and it is a run like a bake.

**How.** OSM data → *Add a region to an instance* → pick a Geofabrik region → *Add to <instance>*
(or the MCP tool `osm_import { upstream, region }`). That starts an `osm-import` run: one Job
(`osm-import-job.yaml` is the reviewed manifest, generated from the code that creates it), on the
instance's node with the instance's volume, which downloads the `.pbf` and `.poly`, checks them,
converts the extract to an osmChange and stages it under `/db/regions/<id>/`. The instance's
**`regions` sidecar** (this chart, `regions.enabled: true`) applies it with `update_from_dir`
**through the running dispatcher** — the same call the instance's own daily diffs make — and the Job
then asks the instance for a sample of the region's own ways (all must come back) before it exits 0.
On success the editor adds the region's polygon to that instance's coverage and routes to it.

**Why a sidecar, and not the Job.** Overpass is written through its dispatcher: the writer takes
the write lock over a socket in `/db/db` and a segment in `/dev/shm`, and readers keep reading the
committed index while it writes. The dispatcher's `/dev/shm` is the overpass pod's own memory
emptyDir; no other pod can reach it, so a Job could only write the files behind a dispatcher that is
serving readers off them. `kubectl exec` would reach it, but needs `pods/exec` and dies with its
connection. A sidecar shares `/db` and `/dev/shm` and needs no grant at all.

**It stays current.** The instance's own updater follows one stream — the extract it was built
from. The sidecar follows every imported region's stream from the replication sequence in that
region's `.pbf` header (`pyosmium-get-changes`, `update_from_dir`), daily. Its state is
`/db/regions/<id>/state.json`; its log is `apply.log` beside it and `kubectl logs <pod> -c regions`.
`/api/timestamp` stays the instance's own stream's time; a region's freshness is its `state.json`.

**Overlapping borders.** Geofabrik cuts every extract with a buffer, so neighbours share the objects
along their border. A create or modify of an object the database already holds writes the same
version again; harmless. A **delete** is the hazard: a region's diff deletes an object that merely
left that region, though the neighbour still holds it. Measured: 20 days of Washington diffs carry
2,006 deletes, 5 of them (4 nodes and a building outline at 38.970 N 77.074 W) objects the Maryland
extract still holds; applied blindly on an instance holding both, they vanish. So every diff — the
instance's own too, through `OVERPASS_DIFF_PREPROCESS` — goes through `defer_deletes.py` first: a
delete of an object whose last known position lies in ANOTHER imported region's polygon is left to
that region's stream (a real deletion appears in every region that held the object). On those 20
days it deferred exactly those 5 and nothing else. Remaining edge: an object that moves out of one
region into another on the same day may be deleted and re-created in the wrong order.

**What it costs, measured** on the instances' own image (`wiktorn/overpass-api@sha256:9bb5f4a9…`,
arm64) run locally on a throwaway database, `compression: no`, `flush-size 4`:

| into | added | apply | disk | queries meanwhile |
|---|---|---|---|---|
| Washington, 6.0 GB | Maryland, 216 MB pbf (4.9 GB osmChange) | 279 s, 1.4 GB RSS | → 41 GB (a fresh build of both: 31 GB) | 217, p95 180 ms, 1 runtime error |
| Maryland, 31.0 GB | Washington, 21 MB | 32 s (42 s end to end) | → 38.2 GB | — |
| Maryland, 31.0 GB | Virginia, 408 MiB (9.0 GB osmChange) | stopped at 429 s, ~90% through ways | → 71 GB and growing | 406, p95 159 ms, 4 runtime errors |

The disk is the catch: `update_from_dir` is copy-on-write, and every flush rewrites the `.map`
blocks it touches, so an in-place import grows the database by far more than its data — about the
database's own size for a state-sized region. The Job refuses to start below the larger of the
database's size and 150× the pbf. **`overpass` is a 60 Gi ceph-block volume holding ~31 GB**, so
Virginia into it needs the volume grown first (to ~150 Gi). Import time on gh200-1 is slower than
the local numbers (Maryland's own build: 20–40 min there, 3 min here), so budget roughly 5–10× them.
**Areas stay off**: nothing in the import or the sidecar calls the areas step, and `useAreas: false`
keeps the instance's own rules loop off. (The `overpass` release predates that value and is running
with the image's default, areas ON; its next `helm upgrade` turns them off.)

**When not to import in place.** For a large region into a large instance, the cheaper path is a
rebuild from a merged extract (`osmium merge a.pbf b.pbf`) onto a new volume while the old instance
keeps serving, then a switch of the Service — it costs one fresh build's disk (31 GB for
Maryland + Washington, against 41 GB in place) and needs no delete filter, because one extract has
one diff stream only if Geofabrik publishes the union as a region (`us`, `north-america`). That is
a new release, which is what the import exists to avoid; it stays the fallback.

**Turning it on for an instance** (once, by an admin; restarts the pod, which keeps its database —
`/db/init_done` is there):

```bash
# PREVIEW first (the recipe in project-worldeditor-settings-deploy): only the ConfigMap, the
# sidecar, its volume and OVERPASS_DIFF_PREPROCESS should differ
helm get manifest overpass -n default > /tmp/now.yaml
helm template overpass tools/overpass/chart -n default --set regions.enabled=true > /tmp/next.yaml
diff /tmp/now.yaml /tmp/next.yaml
helm upgrade overpass tools/overpass/chart -n default --set regions.enabled=true
kubectl -n default logs deploy/overpass -c regions      # "started: /db/regions …"
# the continents: their values files name their own primary region
helm upgrade overpass-na tools/overpass/chart -n default -f tools/overpass/values-na.yaml --set regions.enabled=true
```

`regions.primary` names the region the instance was built from (its outline is what deletes are
deferred to): Maryland in the chart's defaults, Europe and North America in `values-eu.yaml` and
`values-na.yaml`. Not `--reuse-values`: it carries the old release's values and the new ones the
chart adds may not arrive.

## Deploy

```bash
helm upgrade --install overpass tools/overpass/chart -n default
kubectl logs -l app=overpass -f            # init: download → osmium convert → clone
```

The first start downloads the extract and clones the database into the PVC; nothing answers until
that finishes (Maryland: roughly 20–40 minutes). Readiness gates traffic, and there is deliberately
no liveness probe — it would restart the clone forever.

Public URL: `https://overpass.richard-siomporas.basedweights.com/api/interpreter`.

## Point the bake at it

```bash
export CORRIDOR_OVERPASS_URL=https://overpass.richard-siomporas.basedweights.com/api/interpreter
python -m corridor fetch <slug>
```

`osm.py` puts that list first and keeps the public mirrors as the fallback, which matters because
our extract is one region: a California or Oregon site still needs a public mirror until the
extract covers it.

## Region

`values.yaml` pins a **dated** Geofabrik extract, not `-latest`: `-latest` is a 302 and the
image's downloader does not follow redirects — it writes the 254-byte redirect body and calls it a
planet. Geofabrik publishes `.osm.pbf` only, so `preprocess` converts it to the `.osm.bz2` the
image expects with `osmium cat`. Updates then come from `diffUrl`, so pinning the snapshot costs
nothing.

Maryland (204 MB) covers every corridor in the Gambrills / Crownsville / Davidsonville /
Bowie / Frederick / Sideling sets. To cover the California, Oregon and Maine sites, point
`planetUrl` and `diffUrl` at `north-america/us-...` and raise `storage.size` to ~400Gi; that
init runs for hours, so do it deliberately. Re-initialising means deleting the PVC — the container
only clones when `/db` is empty.

## Traps this hit, so nobody hits them twice

- **Block, not cephfs.** Overpass opens its database with direct I/O. On `ceph-filesystem` the
  clone downloaded and converted 204 MB and then died with `File error caught: 22 Invalid argument
  /db/db/nodes.bin` — EINVAL, O_DIRECT unsupported. `ceph-block` (RBD) works.
- **A dated URL, not `-latest`.** `-latest` is a 302 and the image's downloader does not follow
  redirects: it writes the 254-byte redirect body and reports a corrupt planet.
- **pbf, converted.** Geofabrik has no `.osm.bz2` for state extracts; `preprocess` runs
  `osmium cat` to make the file the image expects.

## Notes

- `meta: "no"` drops changeset/user/timestamp: a third off the database, and no query we write
  uses them.
- `updateSleep: 86400` — minutely diffs are pointless for roads that have been there for decades.
- The database is one directory on one volume, so the deployment is `Recreate` with one replica.
- The road not taken, again: the platform's `pai-managed-ext-gateway` (172.16.10.157) is the
  intended external front door; this chart uses ingress-nginx because that is what recon proved.
