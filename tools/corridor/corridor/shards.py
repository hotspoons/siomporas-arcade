"""Shard a world too big for one bake: plan -> shard -> finalize.

THE PROBLEM. A 30 x 28 km world (the dc-metro/495 site) is one Job holding the whole thing in
memory: every 1 km lidar tile, the 408 k-feature OSM set, the 62187 m primary profile, 10 137
chains. It OOMs `network_tiles.lidar_tiled`, and when it does not it runs for hours on one node
while seven sit idle.

THE SHAPE. The same plan `PLAN-SHARDED-BAKE.md` describes:

  * PLAN — run `roads()`/`dead_ends()` once, choose a grid of rectangular blocks, and write, for
    every block, the 1 km tiles and the chains that belong to it. One cheap Job.
  * SHARD — N Jobs, one per block, each a small bake of its own block: the same area stages
    (`dem`, `naip`, `lidar`, profiles, `export_tiles`, `pyramid.bake`) scoped to the block's tiles,
    writing `sites/<slug>/shards/<i>/` in the same layout as a site. Every shard profiles the full
    primary against ITS OWN rasters (the line is long, the samples are 2 m, this is cheap) so the
    finalizer can stitch by absolute `s` with no offsets to get wrong.
  * FINALIZE — union the tiles and the pyramid, union the branch/geology sets, stitch the primary
    elementwise by `s`, then run `export.export_site` over the merged site. One cheap Job.

WHY THE PRIMARY IS NOT CLIPPED. `profile_tiled(fill=False)` on a shard's local rasters answers NaN
outside that block, on the SAME `s` lattice as every other shard. Merging is then "first finite
value wins", and the last step is the same `_fill_along` the single-image path already does. If we
clipped the line to the block we would have to carry, per shard, the distance from the world start
to the clip, and get it right on a self-intersecting motorway. Not clipping removes that class of
bug entirely.

A block is a plain rectangle in the site's UTM frame. Chains are assigned WHOLE (never split at a
seam) by where most of their length falls, and a shard's raster extent is the block PLUS a margin
so an assigned chain whose tail pokes past the block edge still has ground under its samples.
"""

from __future__ import annotations

import json
import math
import shutil
from pathlib import Path

TILE_M = 1000.0
DEFAULT_MAX_SIDE_M = 8000.0
DEFAULT_MAX_SHARDS = 16
# A chain is assigned to the block it mostly lies in; sampled every CHAIN_SAMPLE_M. A margin around
# each block keeps an assigned chain's overhanging tail over real raster.
CHAIN_SAMPLE_M = 25.0
PRIMARY_SAMPLE_M = 100.0
DEFAULT_MARGIN_M = 300.0


def tile_grid(bbox: tuple[float, float, float, float], tile: float = TILE_M) -> tuple[float, float, list[tuple[int, int]]]:
    """The 1 km tiles covering `bbox`, aligned to the world UTM origin: `(x0, y0, [(tx, ty), ...])`.

    `tx`/`ty` are tile indices so the world's tile `(0, 0)` sits at `(x0, y0)` — the same convention
    `network_tiles._tile_grid` uses, so a shard's tiles are named exactly as the single bake names
    them and the finalizer is a union, not a renumber.
    """
    x0 = math.floor(bbox[0] / tile) * tile
    y0 = math.floor(bbox[1] / tile) * tile
    nx = max(1, int(math.ceil((bbox[2] - x0) / tile)))
    ny = max(1, int(math.ceil((bbox[3] - y0) / tile)))
    return x0, y0, [(tx, ty) for ty in range(ny) for tx in range(nx)]


def partition(bbox: tuple[float, float, float, float], max_side_m: float = DEFAULT_MAX_SIDE_M,
              max_shards: int = DEFAULT_MAX_SHARDS) -> list[dict]:
    """`nx x ny` contiguous rectangles covering `bbox`, each <= `max_side_m` a side.

    The world's own aspect decides the split; when that is more than `max_shards` tiles we shrink
    the longer axis first so the blocks stay square-ish (surface area, not perimeter, is what the
    raster stages pay for).
    """
    w = bbox[2] - bbox[0]
    h = bbox[3] - bbox[1]
    nx = max(1, int(math.ceil(w / max_side_m)))
    ny = max(1, int(math.ceil(h / max_side_m)))
    while nx * ny > max_shards:
        if w / nx >= h / ny and nx > 1:
            nx -= 1
        elif ny > 1:
            ny -= 1
        else:
            break
    xs = [bbox[0] + w * i / nx for i in range(nx + 1)]
    ys = [bbox[1] + h * i / ny for i in range(ny + 1)]
    blocks = []
    for j in range(ny):
        for i in range(nx):
            blocks.append({"index": len(blocks), "bbox": [xs[i], ys[j], xs[i + 1], ys[j + 1]]})
    return blocks


def block_at(blocks: list[dict], x: float, y: float) -> int:
    """The block containing `(x, y)`, or the nearest one if it is outside the covered bbox."""
    best, best_d = None, None
    for b in blocks:
        x0, y0, x1, y1 = b["bbox"]
        if x0 <= x < x1 and y0 <= y < y1:
            return b["index"]
        dx = max(x0 - x, 0.0, x - x1)
        dy = max(y0 - y, 0.0, y - y1)
        d = dx * dx + dy * dy
        if best_d is None or d < best_d:
            best_d, best = d, b["index"]
    return int(best)


def _samples(line, step_m: float):
    """Evenly spaced points along a shapely line (endpoints included)."""
    n = max(2, int(math.ceil(float(line.length) / step_m)) + 1)
    step = float(line.length) / (n - 1)
    return [line.interpolate(min(float(line.length), i * step)) for i in range(n)]


def assign_chains(chains: list[dict], primary: dict, blocks: list[dict]) -> dict[str, int]:
    """`{chain_id: block_index}` for every non-primary chain, by where most of its length falls.

    Whole chains, on purpose: a chain split across a seam would be profiled twice and land in the
    manifest twice. The primary is excluded — it is stitched, and lives in no single block.
    """
    out: dict[str, int] = {}
    for c in chains:
        if c is primary:
            continue
        counts: dict[int, int] = {}
        for p in _samples(c["line"], CHAIN_SAMPLE_M):
            bi = block_at(blocks, p.x, p.y)
            counts[bi] = counts.get(bi, 0) + 1
        if counts:
            out[str(c["id"])] = max(counts, key=counts.get)  # type: ignore[arg-type]
    return out


def assign_tiles(bbox: tuple[float, float, float, float], blocks: list[dict]) -> dict[str, list[list[int]]]:
    """Every 1 km tile of `bbox`, assigned to the block its centre falls in."""
    x0, y0, tiles = tile_grid(bbox)
    out: dict[str, list[list[int]]] = {str(b["index"]): [] for b in blocks}
    for tx, ty in tiles:
        cx = x0 + (tx + 0.5) * TILE_M
        cy = y0 + (ty + 0.5) * TILE_M
        out[str(block_at(blocks, cx, cy))].append([tx, ty])
    return out


def primary_blocks(primary: dict, blocks: list[dict]) -> list[int]:
    """Which blocks the primary's line passes through (its samples' blocks)."""
    seen = {block_at(blocks, p.x, p.y) for p in _samples(primary["line"], PRIMARY_SAMPLE_M)}
    return sorted(int(i) for i in seen)


def lidar_area(primary_line, assigned_lines: list, block: list[float], margin_m: float, half_width_m: float):
    """The streets a shard reads lidar for: its assigned chains WHOLE, and the primary only where it
    crosses the block plus `margin_m`.

    WHY (2026-10-10). Every shard used to buffer the whole primary. On dc-metro-take-2 that is the
    93 km Capital Beltway, so shard 5 — a 9.6 x 9.3 km block — read lidar over a 36.7 x 27.6 km
    bbox: 222,212 EPT nodes, 10.5 B points decoded, ~85 GB fetched, and all 25 shards fetched the
    Beltway again. A shard only ever keeps the primary's stations inside its own block
    (`profile_owner`); the margin is context for the along-track windows (the 60 m median, the
    +-16 m deck interpolation, the 60 m ground and canopy offsets), and it is the same margin
    every other raster of the shard already has.

    Assigned chains stay whole: a chain is assigned to one block by where most of it lies and only
    that shard profiles it, so its tail past the margin still needs ground under it.
    """
    from shapely.geometry import box as _box
    from shapely.ops import unary_union

    x0, y0, x1, y1 = block
    near = _box(x0 - margin_m, y0 - margin_m, x1 + margin_m, y1 + margin_m)
    parts = [primary_line.buffer(half_width_m, cap_style="flat").intersection(near)]
    parts += [ln.buffer(half_width_m, cap_style="flat") for ln in assigned_lines]
    return unary_union([g for g in parts if not g.is_empty])


def world_lidar_area(plan: dict, index: int, world, streets):
    """What a shard reads the point cloud over: the 1 km tiles it OWNS (plan["tiles"]), inside the
    world, plus its streets (`lidar_area`).

    WHY THE WHOLE BLOCK (Rich, 2026-10-10: "remove the strip logic and have full world trees").
    Reading only the streets left the lidar CHM at 0 between them -- all of Rockville on
    dc-metro-take-2 had no trees -- and the global-canopy fallback that replaced those zeros is a
    different model, so the world showed a strip: lidar canopy along every road, Meta/WRI between.

    THE OWNED TILES, NOT THE BLOCK PLUS ITS MARGIN. The finalizer keeps the owner's copy of every
    tile (`merge_lidar`), so a tile read in full by its neighbour as well is bytes and minutes for
    nothing. The streets come along as they always did: a chain's tail and the primary's margin are
    context for the profiles, and the tiles they touch are written partly, exactly as before.
    """
    from shapely.geometry import box as _box
    from shapely.ops import unary_union

    x0, y0, _ = tile_grid(tuple(plan["bbox"]), float(plan.get("tile_m", TILE_M)))
    t = float(plan.get("tile_m", TILE_M))
    owned = [_box(x0 + tx * t, y0 + ty * t, x0 + (tx + 1) * t, y0 + (ty + 1) * t) for tx, ty in (plan.get("tiles") or {}).get(str(index), [])]
    mine = unary_union(owned) if owned else None
    if mine is not None and world is not None:
        mine = mine.intersection(world)
    parts = [g for g in (mine, streets) if g is not None and not g.is_empty]
    return unary_union(parts) if parts else streets


def profile_owner(line, s: list[float], blocks: list[dict]) -> list[int]:
    """The block owning each station of the primary's profile: the one its point lies in.

    The stitch keeps a station's values from its owner. Any shard whose margin also reached the
    station saw it near the EDGE of its lidar, where the along-track windows run out of data.
    """
    import numpy as np
    import shapely

    xy = shapely.get_coordinates(shapely.line_interpolate_point(line, np.asarray(s, dtype=float)))
    return [block_at(blocks, float(x), float(y)) for x, y in xy]


def owner_runs(owner: list[int], index: int) -> list[list[int]]:
    """[[i0, i1], ...] station index ranges (inclusive) owned by `index`; compact for profile.json."""
    runs: list[list[int]] = []
    start = None
    for i, b in enumerate(owner + [-1]):
        if b == index and start is None:
            start = i
        elif b != index and start is not None:
            runs.append([start, i - 1])
            start = None
    return runs


def build_plan(slug: str, bbox: tuple[float, float, float, float], chains: list[dict], primary: dict,
               max_side_m: float = DEFAULT_MAX_SIDE_M, max_shards: int = DEFAULT_MAX_SHARDS) -> dict:
    """The whole plan: blocks, their tiles, their chains, and the blocks the primary crosses."""
    blocks = partition(bbox, max_side_m=max_side_m, max_shards=max_shards)
    return {
        "slug": slug,
        "tile_m": TILE_M,
        "bbox": list(bbox),
        "max_side_m": max_side_m,
        "blocks": blocks,
        "tiles": assign_tiles(bbox, blocks),
        "chains": assign_chains(chains, primary, blocks),
        "primary": primary_blocks(primary, blocks),
        "n": len(blocks),
    }


def write_plan(site_dir: Path, plan: dict) -> None:
    d = site_dir / "plan"
    d.mkdir(parents=True, exist_ok=True)
    (d / "shards.json").write_text(json.dumps(plan, indent=1))


def read_plan(site_dir: Path) -> dict | None:
    p = site_dir / "plan" / "shards.json"
    return json.loads(p.read_text()) if p.exists() else None


def shard_dir(site_dir: Path, index: int) -> Path:
    return site_dir / "shards" / str(index)


# --- finalize -----------------------------------------------------------------------------------
#
# Every merge below is a UNION, never a rebake: the shards did the expensive work, the finalizer
# only has to know which copy to keep when two shards saw the same thing (a tile astride a seam, a
# chain that touches two blocks, a primary station the overlap margin gave to both).


def merge_tree(parts: list[Path], dest: Path, sub: str) -> int:
    """Copy every file under each `parts[i]/sub/` into `dest/sub/`, first writer wins.

    Tiles and pyramid levels are content-addressed by `(z, x, y)` in the filename, so "first writer
    wins" is exactly right: a tile two overlapping shards both baked is the same tile.
    """
    dest_sub = dest / sub
    dest_sub.mkdir(parents=True, exist_ok=True)
    n = 0
    for p in parts:
        src = p / sub
        if not src.exists():
            continue
        for f in src.rglob("*"):
            if not f.is_file():
                continue
            tgt = dest_sub / f.relative_to(src)
            tgt.parent.mkdir(parents=True, exist_ok=True)
            if not tgt.exists():
                shutil.copy2(f, tgt)
                n += 1
    return n


def blocks_of(blocks: list[dict], x, y):
    """`block_at` for arrays of points: the blocks are a regular grid (`partition`), so a point's
    block is two searchsorted lookups; one outside the grid goes to the nearest edge block."""
    import numpy as np

    xs = sorted({b["bbox"][0] for b in blocks})
    ys = sorted({b["bbox"][1] for b in blocks})
    nx = len(xs)
    i = np.clip(np.searchsorted(np.asarray(xs), np.asarray(x), side="right") - 1, 0, nx - 1)
    j = np.clip(np.searchsorted(np.asarray(ys), np.asarray(y), side="right") - 1, 0, len(ys) - 1)
    return j * nx + i


_LIDAR_KINDS = ("dtm", "dsm", "chm", "deck_z", "deck_n", "building_n")


def merge_lidar(parts: list[tuple[int, Path]], dest: Path, plan: dict, primary_line=None) -> dict:
    """The shards' `lidar/` trees into one: tiles by place, owner first; the primary's near-road
    points from every block.

    TILES. Shards name 1 km tiles on the world grid (network_tiles.tile_index), so one name is one
    square kilometre everywhere. A tile astride a seam is written by both neighbours, each with
    only the streets IT read, so neither copy is the whole tile. The owner's (plan["tiles"], by
    the tile's centre) is the base; a pixel it has no point in (dsm nodata) takes all six layers
    from the next shard that has one there.

    corridor.laz. `surface.measure` reads the merged cloud for the primary's lane intensity along
    its whole length, and `rock` for ground intensity. A first-writer-wins copy kept one shard's
    file — which held the whole primary only because every shard used to read all of it. Now each
    shard contributes the near-road points of the PRIMARY (within BAND_M of it) that lie in its own
    block: the whole primary, once, streamed chunk by chunk.
    """
    import shutil as _sh

    import numpy as np
    import rasterio

    ldir = dest / "lidar"
    tdir = ldir / "tiles"
    tdir.mkdir(parents=True, exist_ok=True)
    owner = {(int(t[0]), int(t[1])): int(i) for i, ts in plan.get("tiles", {}).items() for t in ts}
    copies: dict[str, list[tuple[int, Path]]] = {}
    for idx, part in parts:
        td = part / "lidar" / "tiles"
        if not td.exists():
            continue
        for f in td.glob("*.dsm.tif"):
            copies.setdefault(f.name.split(".", 1)[0], []).append((idx, td))
    stats = {"tiles": 0, "seam_tiles": 0, "filled_px": 0, "near_points": 0}
    for name, have in sorted(copies.items()):
        tx, ty = (int(v) for v in name.split("_"))
        own = owner.get((tx, ty))
        have.sort(key=lambda t: (t[0] != own, t[0]))
        stats["tiles"] += 1
        if len(have) == 1:
            for kind in _LIDAR_KINDS:
                src = have[0][1] / f"{name}.{kind}.tif"
                if src.exists():
                    _sh.copy2(src, tdir / src.name)
            continue
        stats["seam_tiles"] += 1
        layers, prof = {}, {}
        for kind in _LIDAR_KINDS:
            with rasterio.open(have[0][1] / f"{name}.{kind}.tif") as r:
                layers[kind], prof[kind] = r.read(1), r.profile
        valid = layers["dsm"] != -9999
        for _, td in have[1:]:
            with rasterio.open(td / f"{name}.dsm.tif") as r:
                other_valid = r.read(1) != -9999
            take = ~valid & other_valid
            if not take.any():
                continue
            for kind in _LIDAR_KINDS:
                with rasterio.open(td / f"{name}.{kind}.tif") as r:
                    layers[kind][take] = r.read(1)[take]
            valid |= take
            stats["filled_px"] += int(take.sum())
        for kind in _LIDAR_KINDS:
            with rasterio.open(tdir / f"{name}.{kind}.tif", "w", **prof[kind]) as w:
                w.write(layers[kind], 1)
    if primary_line is not None:
        stats["near_points"] = _merge_primary_cloud(parts, ldir / "corridor.laz", plan, primary_line)
    return stats


def _merge_primary_cloud(parts: list[tuple[int, Path]], out: Path, plan: dict, primary_line, chunk: int = 5_000_000) -> int:
    import laspy
    import numpy as np
    from rasterio.features import rasterize
    from rasterio.transform import from_origin

    from .network_tiles import BAND_M

    blocks = plan["blocks"]
    band_geom = primary_line.buffer(BAND_M)
    writer = None
    n = 0
    tmp = out.with_name(out.stem + ".part.laz")  # laspy compresses by the extension
    try:
        for idx, part in parts:
            laz = part / "lidar" / "corridor.laz"
            if not laz.exists() or laz.stat().st_size == 0:
                continue
            with laspy.open(laz) as r:
                h = r.header
                x0, y0, x1, y1 = float(h.mins[0]), float(h.mins[1]), float(h.maxs[0]), float(h.maxs[1])
                w_, h_ = max(1, int(np.ceil((x1 - x0) / 2.0)) + 1), max(1, int(np.ceil((y1 - y0) / 2.0)) + 1)
                band = rasterize([(band_geom, 1)], out_shape=(h_, w_), transform=from_origin(x0, y1 + 2.0, 2.0, 2.0), fill=0, dtype=np.uint8).astype(bool)
                if writer is None:
                    hdr = laspy.LasHeader(point_format=6, version="1.4")
                    hdr.offsets = [float(np.floor(plan["bbox"][0])), float(np.floor(plan["bbox"][1])), 0.0]
                    hdr.scales = [0.01, 0.01, 0.01]
                    crs = h.parse_crs()
                    if crs is not None:
                        hdr.add_crs(crs)
                    writer = laspy.open(tmp, mode="w", header=hdr, do_compress=True)
                for pts in r.chunk_iterator(chunk):
                    x, y = np.asarray(pts.x), np.asarray(pts.y)
                    rr = np.clip(((y1 + 2.0 - y) / 2.0).astype(np.int64), 0, h_ - 1)
                    cc = np.clip(((x - x0) / 2.0).astype(np.int64), 0, w_ - 1)
                    keep = band[rr, cc] & (blocks_of(blocks, x, y) == idx)
                    if not keep.any():
                        continue
                    rec = laspy.ScaleAwarePointRecord.zeros(int(keep.sum()), header=writer.header)
                    rec.x, rec.y, rec.z = x[keep], y[keep], np.asarray(pts.z)[keep]
                    for dim in ("classification", "return_number", "number_of_returns", "intensity"):
                        rec[dim] = np.asarray(pts[dim])[keep]
                    writer.write_points(rec)
                    n += int(keep.sum())
        if writer is not None:
            writer.close()
            writer = None
            tmp.replace(out)
    finally:
        if writer is not None:
            writer.close()
        tmp.unlink(missing_ok=True)
    return n


def mosaic_shard_raster(site_dir: Path, parts: list[Path], name: str) -> int:
    """Build `site_dir/<name>` as a VRT over every shard's `<name>`, and return the source count.

    Each shard fetches its block's `dem_1m.tif`/`naip_1m.tif`/`horizon_30m.tif`; the finalizer needs
    the whole region's for `export_tiles`/`pyramid`/`overview`. Re-fetching is a waste AND a
    redownload: `naip_tiled` keys its service tiles on the CALL's bbox origin, so a global fetch
    shares nothing with the block fetches and re-downloads every JPEG (measured on shard-smoke,
    2026-10-05). A VRT over the shard files is instant and offline. The blocks tile the world
    contiguously (with a margin of overlap), and adjacent shards read the same source, so the
    overlap is identical data.

    GDAL identifies a VRT by content, not extension, so the file can keep the `.tif` name every
    reader already opens.
    """
    import subprocess

    src = [p / name for p in parts if (p / name).exists()]
    if not src:
        return 0
    subprocess.run(["gdalbuildvrt", "-q", "-overwrite", str(site_dir / name), *[str(x) for x in sorted(src)]], check=True)
    return len(src)


def rebuild_lidar_vrts(site_dir: Path) -> int:
    """Rebuild each `lidar/<kind>.vrt` over EVERY merged `lidar/tiles/*.<kind>.tif`.

    `merge_tree` copies a shard's VRT first-writer-wins, but that VRT names only the tiles THAT
    shard wrote — using it would silently shrink the merged world to one block. The 1 km tile names
    are on the global UTM grid (`network_tiles.tile_index`), so the union is just a glob + rebuild.
    """
    import subprocess

    ldir = site_dir / "lidar"
    tdir = ldir / "tiles"
    if not tdir.exists():
        return 0
    kinds: dict[str, list[Path]] = {}
    for f in tdir.glob("*.*.tif"):
        kinds.setdefault(f.name.split(".", 1)[1][:-4], []).append(f)
    n = 0
    for kind, files in sorted(kinds.items()):
        vrt = ldir / f"{kind}.vrt"
        subprocess.run(["gdalbuildvrt", "-q", "-overwrite", str(vrt), *[str(x) for x in sorted(files)]], check=True)
        n += 1
    return n


def add_overviews(path: Path, min_px: int = 256) -> int:
    """Build external overviews (`<path>.ovr`) on a merged VRT/GeoTIFF; return how many levels.

    The finalizer's merged `dem_1m.tif`/`naip_1m.tif`/`horizon_30m.tif` and lidar VRTs reference
    hundreds of 1 km tiles. A decimated read of such a VRT with no overviews makes GDAL decode every
    full-resolution pixel under the destination: `pyramid._sample` for the coarse z8–z11 tiles and
    `overview()` at 8 m both did exactly that. Measured on dc-metro (2026-10-05) that was ~12 s a
    tile in one pyramid chunk while the other fifteen finished in seconds, and a 134 MB `chm_2m.png`.
    `gdaladdo` pays it once, offline, and every later reader uses the result.
    """
    import subprocess

    import rasterio

    if not path.exists():
        return 0
    factors: list[str] = []
    try:
        with rasterio.open(path) as ds:
            if ds.overviews(1):
                return 0  # already has them (a source that came with internal overviews, or a rerun)
            w, h = ds.width, ds.height
    except Exception:
        return 0
    f = 2
    while min(w, h) // f >= min_px:
        factors.append(str(f))
        f *= 2
    if not factors:
        return 0
    # `-r average`: the same resampling `_sample`/`overview` ask for, so the overview is the read
    # they would have computed themselves, just precomputed.
    subprocess.run(["gdaladdo", "-q", "-r", "average", str(path), *factors], check=True)
    return len(factors)


def add_overviews_all(site_dir: Path, lidar: bool = True) -> dict:
    """Overview the merged rasters the finalizer/export downsample. Returns {name: levels}."""
    out: dict[str, int] = {}
    for name in ("dem_1m.tif", "naip_1m.tif", "horizon_30m.tif", "canopy_global.tif"):
        n = add_overviews(site_dir / name)
        if n:
            out[name] = n
    if lidar:
        ldir = site_dir / "lidar"
        for vrt in sorted(ldir.glob("*.vrt")) if ldir.exists() else []:
            n = add_overviews(vrt)
            if n:
                out[f"lidar/{vrt.name}"] = n
    return out


def merge_branches(parts: list[Path], dest: Path) -> int:
    """Union the shards' `branches.json`, keyed by chain id. Whole chains mean no real overlap."""
    by_id: dict[str, dict] = {}
    order: list[str] = []
    tag = None  # every shard is written under the site's one frame; the union carries its tag
    for p in parts:
        src = p / "branches.json"
        if not src.exists():
            continue
        doc = json.loads(src.read_text())
        tag = tag or doc.get("frame")
        for b in doc.get("branches", []):
            key = str(b.get("id"))
            if key not in by_id:
                by_id[key] = b
                order.append(key)
    merged = [by_id[k] for k in order]
    dest.mkdir(parents=True, exist_ok=True)
    from .network import branches_doc

    (dest / "branches.json").write_text(branches_doc(merged, tag))
    return len(merged)


def merge_geology(parts: list[Path], dest: Path) -> None:
    """Union `geology.json` by `map_id`, primary first so `samples` keep their meaning."""
    units: dict[str, dict] = {}
    for p in parts:
        src = p / "geology.json"
        if not src.exists():
            continue
        for u in json.loads(src.read_text()).get("units", []):
            units.setdefault(str(u["map_id"]), u)
    if not units:
        return
    named = sorted({u["strat_name"] for u in units.values() if u.get("strat_name")})
    dest.mkdir(parents=True, exist_ok=True)
    (dest / "geology.json").write_text(json.dumps({"units": list(units.values()), "named_formations": named}, indent=1))


def _combine(arrays: list, fill: bool = True, prefer: list | None = None):
    """Elementwise merge of the shards' along-track arrays: a station's OWNER first (`prefer[i]` is
    shard i's ownership mask, or None), then "first finite value wins" for whatever is left."""
    import numpy as np

    want = max((len(np.asarray(a)) for a in arrays), default=0)
    out = np.full(want, np.nan, dtype=float)
    passes = ([True, False] if prefer is not None else [False])
    for owned_only in passes:
        for i, a in enumerate(arrays):
            a = np.asarray(a, dtype=float)
            take = np.isnan(out[: len(a)]) & np.isfinite(a)
            if owned_only:
                m = prefer[i]
                if m is None:
                    continue
                take &= m[: len(a)]
            out[: len(a)][take] = a[take]
    if fill:
        from .network_tiles import _fill_along

        return _fill_along(out.tolist())
    return [None if not np.isfinite(v) else round(float(v), 2) for v in out]


def _owned_mask(p: dict, n: int):
    """A profile's `owned` runs as a boolean array over its stations; None for a profile written
    before shards recorded ownership (every shard then read the whole primary)."""
    import numpy as np

    runs = p.get("owned")
    if runs is None:
        return None
    m = np.zeros(n, bool)
    for a, b in runs:
        m[int(a) : int(b) + 1] = True
    return m


def _merge_structures(found: list[tuple[dict, object, float]]) -> list[dict]:
    """The primary's structures across shards: each from a shard that owns at least one of its
    stations, and the pieces of one object joined.

    With the primary clipped to each block plus its margin, a structure across a seam is seen by
    both neighbours, and one longer than the margin (the Woodrow Wilson Bridge is 1.8 km) is seen
    by each only up to the edge of its lidar. Same kind, overlapping or touching (within a
    station): one structure, from the first s_start to the last s_end.
    """
    kept = []
    for st, owned, step in found:
        if owned is not None:
            i0, i1 = int(float(st.get("s_start", 0)) / step), int(float(st.get("s_end", 0)) / step)
            if not owned[max(0, i0) : i1 + 1].any():
                continue  # seen from this shard's margin only; its owner reports it
        kept.append((st, step))
    kept.sort(key=lambda t: (str(t[0].get("kind")), float(t[0].get("s_start", 0))))
    out: list[dict] = []
    for st, step in kept:
        prev = out[-1] if out else None
        if prev is not None and prev.get("kind") == st.get("kind") and float(st["s_start"]) <= float(prev["s_end"]) + step:
            longer = st if float(st.get("length_m") or 0) > float(prev.get("length_m") or 0) else prev
            merged = dict(longer)
            merged["s_start"] = min(float(prev["s_start"]), float(st["s_start"]))
            merged["s_end"] = max(float(prev["s_end"]), float(st["s_end"]))
            merged["length_m"] = round(merged["s_end"] - merged["s_start"] + step, 1)
            for k, fn in (("deck_z_min", min), ("deck_z_max", max), ("clearance_m", min)):
                vals = [v for v in (prev.get(k), st.get(k)) if v is not None]
                merged[k] = fn(vals) if vals else None
            out[-1] = merged
        else:
            out.append(dict(st))
    return sorted(out, key=lambda x: float(x.get("s_start", 0)))


def stitch_profile(parts: list[Path], dest: Path) -> bool:
    """Merge the shards' primary `profile.json` files on their shared absolute-`s` lattice.

    Every shard profiles the SAME primary line at the SAME `step_m`, so the `s` axis is identical
    and the merge is per-station: the shard that OWNS the station (`profile.json`'s `owned`, see
    `profile_owner`) wins, then any shard with raster there. Empty outside every block (a hole in
    the flights) is filled along-track exactly as the single-image path fills it.
    """
    profiles = []
    for p in parts:
        f = p / "profile.json"
        if f.exists():
            profiles.append(json.loads(f.read_text()))
    if not profiles:
        return False
    base = max(profiles, key=lambda x: len(x.get("s") or []))
    n = len(base["s"])
    masks = [_owned_mask(p, n) for p in profiles]
    prefer = masks if any(m is not None for m in masks) else None
    out = {
        "step_m": base["step_m"],
        "s": base["s"],
        "road_z": _combine([p.get("road_z") or [] for p in profiles], prefer=prefer),
    }
    if any("ground_z" in p for p in profiles):
        out["ground_z"] = _combine([p.get("ground_z") or [] for p in profiles], prefer=prefer)
    for group in ("ground_rel", "canopy"):
        keys = sorted({k for p in profiles for k in (p.get(group) or {})})
        merged = {k: _combine([(p.get(group) or {}).get(k) or [] for p in profiles], prefer=prefer) for k in keys}
        if merged:
            out[group] = merged
    step = float(base["step_m"])
    found = [(st, masks[i], step) for i, p in enumerate(profiles) for st in (p.get("structures") or [])]
    if prefer is None:
        # profiles from before ownership: every shard read the whole primary, dedupe by start
        seen: set[tuple] = set()
        structs = []
        for st, _, _ in found:
            key = (st.get("kind"), round(float(st.get("s_start", 0)), 1))
            if key not in seen:
                seen.add(key)
                structs.append(st)
        out["structures"] = sorted(structs, key=lambda s: float(s.get("s_start", 0)))
    else:
        out["structures"] = _merge_structures(found)
    dest.mkdir(parents=True, exist_ok=True)
    (dest / "profile.json").write_text(json.dumps(out))
    return True


def merge_manifest(parts: list[Path], dest: Path) -> None:
    """A skeleton manifest for the finalizer's `export_site`; the export rewrites the layers."""
    base = None
    for p in parts:
        f = p / "manifest.json"
        if f.exists():
            base = json.loads(f.read_text())
            break
    dest.mkdir(parents=True, exist_ok=True)
    (dest / "manifest.json").write_text(json.dumps(base or {}, indent=1, default=str))
