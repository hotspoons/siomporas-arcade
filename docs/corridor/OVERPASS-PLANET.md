# The full world pull

**Status:** Europe is importing. 2026-09-23.
**Now:** the editor and the baker still run on the four public query mirrors. `overpass` holds
Maryland and is deliberately NOT their first upstream — see "The silent empty" below. `overpass-eu`
holds Europe and is **not yet in any client's list**; it goes in only when
`tools/overpass/verify.sh --pod overpass-eu` returns non-zero ways for Stelvio *and* Crofton.

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

Import time is the real cost. Maryland took about ten minutes; **Europe takes about thirty hours**,
and the shape of those hours is nothing like a scaled-up Maryland — see "What a continent import
actually costs" below. Run it once.

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

### The hidden third pass: `osmium fileinfo -e`

The entrypoint computes the database version inline, before it imports:

```
/app/bin/init_osm3s.sh /db/planet.osm.bz2 ... "--version=$(osmium fileinfo -e -g data.timestamp.last /db/planet.osm.bz2) ..."
```

`-e` is *extended*, so this **decompresses and parses the entire file to read one timestamp**, and
it is single-threaded. On Maryland that is seconds and invisible. On Europe it is a full pass over
**58.6 GB of bz2** before the import has started — measured: the conversion finished, the pbf was
removed, `/db/db` was still empty, and the only process burning CPU was `osmium fileinfo`.

So a continent import is **three full passes over the data**, not one:

| pass | what | parallel? |
|---|---|---|
| 1 | `osmium cat` pbf → XML → `lbzip2` | yes, with lbzip2 |
| 2 | `osmium fileinfo -e` to read the timestamp | **no** |
| 3 | `bunzip2 \| update_database`, then Reorganizing | no |

**Measured cost of pass 2 on Europe: 2 h 13 min.** Not estimated — `/db/db/osm_base_version` is
the file that pass 2 exists to write, so its mtime is the moment pass 2 ended, and the converted
`planet.osm.bz2`'s mtime is the moment it began.

An in-flight extrapolation from the read offset predicted **3.5 hours and was 60% high**. The
offset was 59.7% after 128 minutes, which reads as a clean linear ETA and is not one: bz2 offset
is a poor proxy for parse work, because the node-dense front of the file decompresses to far more
elements per byte than the tail. **Use the offset to tell a long pass from a hung one — that is
what it is good for — and do not turn it into a completion time.**

**How to tell a long pass from a hung one**, which is worth more than the number: the process holds
the file open, so its read position is the exact progress.

```
kubectl exec -n default <pod> -- sh -c '
  for d in /proc/[0-9]*; do case "$(tr "\0" " " < $d/cmdline)" in *fileinfo*)
    for f in $d/fd/*; do case "$(readlink $f)" in *planet.osm.bz2)
      grep "^pos:" $d/fdinfo/${f##*/};; esac; done;; esac; done'
```

That turns "is it stuck?" into a percentage, for any of the three passes, without touching the job.

**One trap in writing that loop:** `/proc/*/cmdline` includes the shell running the loop, and the
patterns being matched are literal text inside it, so a naive version matches itself and reports
whatever phase it happens to mention first. It reported `diffs` on a pod that was still
downloading. Match on `argv[0..1]` only — a real worker is `curl`, `bunzip2`, `osmium fileinfo` or
`/app/bin/update_from_dir`, and the watcher's own shell is `sh -c`, which collides with none of
them. This is the `/proc` twin of `pkill -f <pattern>` killing its own shell.

Pass 2 buys one string. If Europe's import time ever needs cutting, passing a known `--version`
and skipping it is the cheapest hour available — it would need a change to the image's entrypoint
or an `OVERPASS_PLANET_PREPROCESS` that writes the timestamp somewhere the entrypoint reads, and
neither is obviously clean. Recorded so the next person does not mistake it for a stall.

### The hidden FOURTH pass: `pyosmium-get-changes` finding the newest object

After `update_database` prints `Update complete.` the entrypoint runs `update_overpass.sh`, whose
first act on a fresh database is `pyosmium-get-changes -O /db/planet.osm.bz2`, and Geofabrik
extracts carry no replication headers, so it logs `OSM file has no replication headers. Looking
for newest OSM object.` and **reads the whole 58.6 GB bz2 again**, single-threaded, to find one
timestamp — the same job pass 2 did, done a second time by a different tool. Measured on the
first Europe run: `Update complete.` at 04:22, first diff download at 06:39 — **2 h 17 min**. The
pod stays 0/1 throughout, and the process to look for is `pyosmium-get-changes`, not `bunzip2`.

So a continent import is four passes over the data, and two of them exist to produce a timestamp
each. Writing `/db/replicate_id` before the update step (the sequence number for the extract's
date, which Geofabrik's `state.txt` files give you) skips this one entirely; not done yet.

### Sizing, measured rather than extrapolated

`europe-latest.osm.pbf` is **35.0 GB**, and converted to `.osm.bz2` it is **58.6 GB** — 1.67x, not
the ~1x this document guessed. Both live on the volume at once until the conversion finishes, so
the peak before the database is even built is **~94 GB**. The 4 Ti provisioning remains obviously
right; the point is that the pbf size is not a useful predictor of anything downstream.

### What a continent import actually costs, hour by hour

The Europe import, `europe-latest.osm.pbf` onto 4 Ti ceph-filesystem with `compression: no`,
started 2026-09-22 19:16 UTC. Every boundary below is a file mtime inside the pod, not a guess.

| phase | from | to | wall |
|---|---|---|---|
| 1. download 35.0 GB pbf, `osmium cat \| lbzip2 -n 8` → 58.6 GB bz2 | 19:16 | 20:49 | **1 h 33 m** |
| 2. `osmium fileinfo -e`, to produce one timestamp | 20:49 | 23:02 | **2 h 13 m** |
| 3a. `update_database`, **nodes** | 23:02 | 02:01 | **3 h 0 m** |
| 3b. `update_database`, **ways** | 02:01 | still running at 21:31 (93%) | **19 h 30 m +** |
| 3c. relations, then the closing reorganize | — | — | not reached on the first run |
| 4. `pyosmium-get-changes` scanning the bz2 for the newest object | `Update complete.` | first diff download | **2 h 17 m** (first run: 04:22 → 06:39) |

**The ways are the import.** Nodes are roughly the first **70%** of the bz2 stream and cost three
hours; ways are the remaining ~28% and have cost nineteen and a half. That is a **~13x slowdown
per byte at the node→way boundary**, confirmed across four independent readings before it was
believed. Anyone watching the percentage climb through the node phase will conclude the import
lands in six hours, and they will be wrong by a day. Budget from the boundary, not from the start.

**The closing reorganize is not a cliff.** `Reorganizing the database ... done.` is interleaved
throughout — it appears between ordinary flushes every few hundred million elements and completes
inside a two-minute sampling window. The feared superlinear final step is being paid incrementally
as the import runs.

**Disk, measured at 93% of pass 3:** `/db/db` is **219.6 GB** and none of it is sparse (apparent
size equals allocated size, file by file), plus the 58.6 GB bz2 that can be deleted afterwards.
**`df` on this cephfs mount is wrong** — it reported 55 G used against 278 GB of real contents, so
size a continent volume from `du -sb`, never from `df`. 4 Ti remains obviously right, and the
order-of-magnitude uncertainty this document opened with is now closed at roughly **a quarter of a
terabyte for Europe**.

## Areas killed it at the finish line, and `rulesLoad: 0` does not turn them off

The Europe import finished. Nodes, ways and relations all landed, four days of Geofabrik diffs
applied cleanly to `2026-09-23T20:22:04Z`, and the update loop reported `status code: 3` — caught
up. Then the entrypoint ran one more step nobody asked for:

```
Generating areas...
File_Error: Invalid argument 22 /db/db/area_tags_local.bin File_Blocks::read_block::4
Failed to process planet file
```

**`OVERPASS_USE_AREAS=true` is baked into the image.** Our chart sets `rulesLoad: 0` and that reads
like "areas off"; it is not. `OVERPASS_RULES_LOAD` is only the *interval* of the rules loop. The
one-shot area generation in the entrypoint is gated on `OVERPASS_USE_AREAS`, which we never set,
so the image default won.

**Why it failed is the old finding in a new place.** The areas step is
`osm3s_query --progress --rules --db-dir=/db/db`, and it is the one call in the entrypoint that
does **not** pass `--compression-method`. So it writes the default codec regardless of
`OVERPASS_COMPRESSION`. Measured from the `.idx` headers rather than inferred — the compression
method is a `uint16` at byte 6:

| file | method |
|---|---|
| `nodes.bin.idx`, `ways.bin.idx` | **0 — none**, our setting took effect |
| `area_tags_local.bin.idx`, `area_blocks.bin.idx`, `areas.bin.idx` | **2 — lz4** |

lz4 is the codec the clone gate already proved cannot be read back on this storage. The same
errno, the same `File_Blocks::read_block`, 33 hours later, in the only step that ignores the
setting.

### The failure mode that makes it expensive

The area step sits inside the entrypoint's `&&` chain, **before `touch /db/init_done`**. So:

1. areas fail → the chain breaks → `Failed to process planet file` → container exits 1
2. Kubernetes restarts it
3. the entrypoint tests `[[ ! -f /db/init_done ]]`, finds no marker, prints
   **`No database directory. Initializing`** — and begins re-downloading
   `europe-latest.osm.pbf` on top of a finished 254 GB database

It does not check whether `/db/db` is populated, and `init_osm3s.sh` does `mkdir -p` rather than
refusing. **Any failure anywhere in that chain silently converts a completed continent import into
a restart loop that eats it.** The marker is the only state that matters, and it is written last.

**What was actually done, 2026-09-24:** re-imported from scratch with `useAreas: false`. The
in-place recovery — `touch /db/init_done` and roll — was available and would have been serving in
minutes, but it was not chosen, and by the time the decision came back the restart loop had been
running for twelve hours and `update_database` was already nine hours into writing over the old
database. **Which is the lesson: the window to recover a finished import is the length of one
download, and it closes silently.** Nothing alerts on "this container is re-importing a database
it already has"; the log line is the cheerful `No database directory. Initializing`.

If this happens again and the database is wanted, `touch /db/init_done` **first** — it is one file
and it costs nothing to create, it can be deleted again, and it is the only thing standing between
a crash loop and a wiped continent.

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
   `tools/overpass/verify.sh --pod overpass-eu` is that probe, and its third outcome matters: it
   reported `NOASK` while the pod had no listener, which is *inconclusive*, not a coverage
   failure. Without that distinction this would have read as "our extract is missing Italy".
4. Only then set `overpassUrl` back to ours on the worldeditor release, mirrors still appended.
5. Retire the Maryland PVC.

## What this does not solve

The bake fetches DEM, NAIP, lidar and geology from US federal sources. **Those are US-only.** An
Italian corridor gets its roads from OSM and then has no terrain. Whatever the elevation and
imagery story is outside the US — Copernicus DEM at 30 m, national orthophoto services, no lidar —
that is a separate design and it is the real blocker for an Italian pass, not Overpass.
