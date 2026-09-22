# The full world pull

**Status:** design, not built. 2026-09-22.
**Now:** the editor and the baker run on the four public query mirrors. Our own Overpass holds
Maryland and is deliberately NOT their first upstream — see "The silent empty" below.

## Why

A corridor can be anywhere. Mountain passes in Italy are a first-class target, not an edge case,
and a bake only needs OSM ways in a box — there is nothing region-specific in the pipeline. The
only thing that is regional is the extract our own Overpass happens to hold.

## The silent empty, which is the actual reason this is urgent

Our instance holds `maryland-260920.osm.pbf`. Asked for the Stelvio Pass it answers:

```
HTTP 200    ways returned: 0          # bbox 46.50,10.40,46.56,10.50 — the SS38 hairpins
HTTP 200    ways returned: 508        # bbox 39.00,-76.70,39.02,-76.68 — Crofton
```

**An out-of-extract query is not an error. It is a success with nothing in it.** The fallback loop
in `overpass.mjs` and `osm.py` rotates on an exception or a non-2xx; neither fires here. So a
Maryland instance placed first in the list does not degrade gracefully outside Maryland — it
silently reports that Italy has no roads, and the editor draws an empty map over the Alps.

This is why `overpassUrl` is currently set to `""` on the worldeditor release, which leaves only
the public mirrors. **Do not make a regional instance the first upstream again.** Either it holds
the planet, or it is not in the list.

If a regional instance is ever wanted as a cache in front of the mirrors, it needs an explicit
coverage test — the extract's own bbox, checked before the query is sent, falling through to a
mirror when the box is not contained. That is a guard we do not have and would have to write.

## What is measured, not assumed

| thing | measured | when |
|---|---|---|
| clone snapshot, live | `trigger_clone` → `https://dev.overpass-api.de/clone//2026-09-19` | 2026-09-22 |
| planet clone size | **277 GiB** over 19 files, no meta, no attic | 2026-09-22 |
| largest single file | `nodes.bin` 94.5 GiB, then `ways.bin` 78.8 GiB, `nodes.map` 52.8 GiB | 2026-09-22 |
| ceph free | **54.8 TiB** of 55.9 TiB | 2026-09-22 |
| Maryland import, 204 MB pbf | ~10 min to `init_done`, 30 GB on disk | 2026-09-22 |
| Italy through the mirrors | Stelvio bbox, 52 ways, 232 kB, **2.5 s** | 2026-09-22 |

277 GiB is **0.5%** of the free pool. The sizing question is closed; it was only ever a question
because the existing PVC was 60 Gi and I sized against that rather than against the cluster.

The docs' "about 40 GB" figure for a clone is long out of date — it is off by 7x.

## Route: import continent extracts uncompressed. NOT the clone.

**This reverses the first version of this document, which recommended the clone.** The gate it
proposed was run and the clone failed it.

### What the gate found

The `.idx` header carries the block format in 8 bytes — version, block-size exponent,
compression-factor exponent, then a uint16 compression method — so this cost a range request, not
a download.

```
clone nodes.bin       version 7600  block 16384  factor 8  method 2 = lz4
clone ways.bin        version 7600  block 16384  factor 8  method 2 = lz4
clone relations.bin   version 7600  block 65536  factor 8  method 2 = lz4
ours  nodes.bin       version 7600  block 16384  factor 8  method 0 = none
```

**The clone is lz4.** Our three failures had all been gz, so this looked at first like good news —
a different code path. It is not:

| compression | result on our storage |
|---|---|
| gz (method 1) | fails, `Reorganizing the database`, errno 22, `nodes.0a.bin` |
| **lz4 (method 2)** | **fails, same phase, same errno, `nodes.0g.bin`** |
| none (method 0) | **succeeds** — 30 GB, `init_done`, 508 ways for a Crofton bbox |

Compressed blocks do not read on this storage, whichever codec, and the clone is compressed. That
is enough to rule the route out without spending 277 GiB.

**A caveat I could not close.** An import writes compressed blocks and then reads them back; a
clone only ever reads blocks written upstream. So this test does not strictly prove the clone
would fail — only that our write-then-read cycle does. Closing it properly means decompressing an
upstream block by hand: the index parses cleanly (stride 16, pos and size in 8192-byte sub-blocks,
8301 entries) but the block body is not a bare LZ4 frame at any offset I tried, and going further
is reverse-engineering `File_Blocks`' internal layout. Not worth it when a working route exists.

### The working route

Import with `OVERPASS_COMPRESSION=no`, which is the configuration we have actually seen finish.

Not the planet — **continent extracts**, from the same Geofabrik source the current chart uses:

```
europe-latest.osm.pbf          35.0 GB
north-america-latest.osm.pbf   19.4 GB
```

That covers Italy, the Alps and everything we bake today, and it skips Asia, Africa and South
America entirely until someone wants them. Geofabrik also publishes per-country extracts, so Italy
alone is an option if Europe is too slow to start with.

**Sizing is genuinely uncertain and should be provisioned generously rather than estimated.**
Maryland is 204 MB of pbf and 30 GB on disk, but most of that is preallocated sparse map files
that do not scale with the extract — extrapolating that ratio gives 5 TB for Europe and is almost
certainly wrong. Working back from the clone instead (≈80 GB planet pbf → 277 GiB lz4) and
allowing a few times for decompression suggests under a terabyte for the planet uncompressed. The
two estimates disagree by an order of magnitude, which is the honest state of knowledge. Disk is
the cheap thing here: **provision 4 Ti and stop thinking about it.**

Import time is the real cost — Maryland took about ten minutes, and the reorganize step is
superlinear. Budget a day or more for Europe and run it once.

## The storage class was a misattribution, and cephfs works

`tools/overpass/chart/values.yaml` carries a comment saying the database must be on a BLOCK device
because "on the cephfs class the clone died with File error caught: 22 Invalid argument
/db/db/nodes.bin". **That is the same errno, the same function and the same phase as the failure
now attributed to compression** — which means it was never evidence about cephfs. It failed on
cephfs *with gz*, and gz was the cause.

Settled by test rather than argument, because a wrong guess costs a day-long import:

```
release      overpass-cephfs-test        a second release, not the running one
storage      80Gi ceph-filesystem
extract      maryland-260920.osm.pbf     the one known to import in ~10 minutes
compression  no
result       reached the serving phase; 0 occurrences of "File error caught"
             Crofton bbox -> 508 ways    the same number the ceph-block instance gives
```

**cephfs is fine for this workload with `compression: no`.** The chart comment is wrong and should
be corrected when someone owns that file. The 4 Ti ceph-filesystem choice below stands.

## The bz2 bottleneck, and lbzip2

`init_osm3s.sh` ends in `bunzip2 <$PLANET_FILE | update_database`, so the importer genuinely wants
bz2-compressed OSM XML — a pbf cannot be handed to it. Europe is 35.0 GB of pbf and expands to
several hundred GB of XML, and the image ships only single-threaded `bzip2`.

The image is Debian bookworm and `apt-get install lbzip2` works, so the preprocess becomes a
streamed, parallel conversion with no giant intermediate on disk:

```
apt-get update -qq && apt-get install -y -qq lbzip2 &&
mv /db/planet.osm.bz2 /db/planet.osm.pbf &&
osmium cat -o - -f osm /db/planet.osm.pbf | lbzip2 -c -n 8 > /db/planet.osm.bz2 &&
rm -f /db/planet.osm.pbf
```

Also worth correcting: the entrypoint uses `curl -L`, so it **does** follow redirects and
`europe-latest.osm.pbf` (a 302 to a Geofabrik mirror) downloads fine. The chart's note about
`-latest` not being followed is stale.

## Shape

```
PVC          4 Ti     ceph-filesystem     PROVEN for this workload, see above; sizing is uncertain
                                          by an order of magnitude and the pool has 54.8 TiB free
mode         init     OVERPASS_PLANET_URL=.../europe-latest.osm.pbf
compression  no       NOT negotiable — gz and lz4 both fail on this storage
areas        off      rulesLoad: 0
diffs        on       OVERPASS_DIFF_URL → planet daily; minute diffs are not worth it for a
                      pipeline that bakes a corridor once
memory       16 Gi    the clone does not import, so the flush buffer does not apply
```

`tools/overpass/chart` already carries `flushSize` and `compression` as values; this adds
`cloneSource`, and `mode`, and turns `planetUrl`/`preprocess` off in clone mode.

## Rollout

1. ~~Clone gate.~~ **Done 2026-09-22: the clone is lz4, lz4 fails here, route abandoned.**
2. Import `europe-latest.osm.pbf` uncompressed onto the 4 Ti PVC, alongside the Maryland one,
   which keeps working and keeps answering while it runs.
3. Verify with the boxes that matter — Stelvio, Crofton, somewhere in the southern hemisphere —
   and assert **non-zero** ways for each. The silent empty means "no exception" is not a pass.
4. Only then set `overpassUrl` back to ours on the worldeditor release, mirrors still appended.
5. Retire the Maryland PVC.

## What this does not solve

The bake fetches DEM, NAIP, lidar and geology from US federal sources. **Those are US-only.** An
Italian corridor gets its roads from OSM and then has no terrain. Whatever the elevation and
imagery story is outside the US — Copernicus DEM at 30 m, national orthophoto services, no lidar —
that is a separate design and it is the real blocker for an Italian pass, not Overpass.
