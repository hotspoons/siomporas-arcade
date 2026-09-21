# overpass — our own OSM query service

The corridor bake reads OpenStreetMap through Overpass: the road chains, lane tags, crossings,
building footprints and land use for every site. On 2026-09-21 every public mirror refused
connections for about an hour and every new bake died at step one. This is the fix Rich asked for.

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
