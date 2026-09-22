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

## Route: clone, not import

**Clone.** `OVERPASS_MODE=clone` fetches a prebuilt database. It is hours, not days, and it skips
the import code entirely — which matters, because the import is where every failure so far has
been.

**Import** would mean `planet.osm.pbf` (~80 GB) through `init_osm3s.sh`. The Maryland extract is
204 MB and took ten minutes; the planet is 400x that and the reorganize step is superlinear. Days,
holding a 48 Gi limit, with a failure mode we have already met three times.

There is no third option. Nobody publishes prebuilt Overpass *databases* per region — Geofabrik,
OpenPlanetData and SliceOSM publish raw `.pbf` extracts, which is the thing we would have to
import. Regional clone = import = the slow, fragile path.

## The risk this design turns on

**We do not know whether the clone's blocks are readable on our storage.**

The Maryland import failed three times with `File error caught: 22 Invalid argument ...
File_Blocks::read_block` and only succeeded once `OVERPASS_COMPRESSION=no` was set. O_DIRECT was
ruled out by direct test — 512 MB file on the actual volume, direct reads and writes at offsets
512, 3584, 4095x512 and past 2 GB, all fine, device reports 512-byte logical blocks. Memory was
ruled out by lowering the flush buffer from 16 GB to 4, which made it fail *sooner*.

What is left is the gz block layout, and a clone ships blocks built by the SOURCE with the
source's compression. If gz is genuinely what breaks here, a 277 GiB download may land and then
fail on first read.

**So the first step is a cheap test, not a big download.** Clone into a scratch PVC, stop as soon
as `nodes.bin` and its `.idx` are down (94.5 GiB, the largest single file, ~1 hour), and run a
query that forces a block read. If it throws errno 22, the clone route is dead and the honest
answer is to stay on the mirrors. Do not download 277 GiB first and find out after.

Note also that area generation still fails on our working Maryland instance
(`area_tags_local.bin`, `read_block::4`) while bbox queries answer fine. Areas are not used by any
corridor query. Set `rulesLoad: 0` and stop paying for a loop that cannot succeed.

## Shape

```
PVC          600 Gi   ceph-block RWO      277 GiB clone + diffs + headroom + room to rebuild
                                          beside the old one during a re-clone
mode         clone    OVERPASS_CLONE_SOURCE=https://dev.overpass-api.de/api_drolbr/
compression  no       until the gz question above is answered; costs disk, and disk is free
areas        off      rulesLoad: 0
diffs        on       OVERPASS_DIFF_URL → planet daily; minute diffs are not worth it for a
                      pipeline that bakes a corridor once
memory       16 Gi    the clone does not import, so the flush buffer does not apply
```

`tools/overpass/chart` already carries `flushSize` and `compression` as values; this adds
`cloneSource`, and `mode`, and turns `planetUrl`/`preprocess` off in clone mode.

## Rollout

1. Scratch PVC, clone `nodes.bin` only, query it, decide. **This is the gate.**
2. If green: full clone onto the 600 Gi PVC, alongside the Maryland one, which keeps working.
3. Verify with the boxes that matter — Stelvio, Crofton, somewhere in the southern hemisphere —
   and assert **non-zero** ways for each. The silent empty means "no exception" is not a pass.
4. Only then set `overpassUrl` back to ours on the worldeditor release, mirrors still appended.
5. Retire the Maryland PVC.

## What this does not solve

The bake fetches DEM, NAIP, lidar and geology from US federal sources. **Those are US-only.** An
Italian corridor gets its roads from OSM and then has no terrain. Whatever the elevation and
imagery story is outside the US — Copernicus DEM at 30 m, national orthophoto services, no lidar —
that is a separate design and it is the real blocker for an Italian pass, not Overpass.
