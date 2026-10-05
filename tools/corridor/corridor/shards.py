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
    for p in parts:
        src = p / "branches.json"
        if not src.exists():
            continue
        for b in json.loads(src.read_text()).get("branches", []):
            key = str(b.get("id"))
            if key not in by_id:
                by_id[key] = b
                order.append(key)
    merged = [by_id[k] for k in order]
    dest.mkdir(parents=True, exist_ok=True)
    (dest / "branches.json").write_text(json.dumps({"frame": "enu", "branches": merged}))
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


def _combine(arrays: list, fill: bool = True):
    """Elementwise "first finite value wins" across the shards' along-track arrays."""
    import numpy as np

    want = max((len(np.asarray(a)) for a in arrays), default=0)
    out = np.full(want, np.nan, dtype=float)
    for a in arrays:
        a = np.asarray(a, dtype=float)
        take = np.isnan(out[: len(a)]) & np.isfinite(a)
        out[: len(a)][take] = a[take]
    if fill:
        from .network_tiles import _fill_along

        return _fill_along(out.tolist())
    return [None if not np.isfinite(v) else round(float(v), 2) for v in out]


def stitch_profile(parts: list[Path], dest: Path) -> bool:
    """Merge the shards' primary `profile.json` files on their shared absolute-`s` lattice.

    Every shard profiles the SAME primary line at the SAME `step_m`, so the `s` axis is identical
    and the merge is per-station: keep whichever shard had raster there. Empty outside every block
    (a hole in the flights) is filled along-track exactly as the single-image path fills it.
    """
    profiles = []
    for p in parts:
        f = p / "profile.json"
        if f.exists():
            profiles.append(json.loads(f.read_text()))
    if not profiles:
        return False
    base = max(profiles, key=lambda x: len(x.get("s") or []))
    out = {
        "step_m": base["step_m"],
        "s": base["s"],
        "road_z": _combine([p.get("road_z") or [] for p in profiles]),
    }
    if any("ground_z" in p for p in profiles):
        out["ground_z"] = _combine([p.get("ground_z") or [] for p in profiles])
    for group in ("ground_rel", "canopy"):
        keys = sorted({k for p in profiles for k in (p.get(group) or {})})
        merged = {k: _combine([(p.get(group) or {}).get(k) or [] for p in profiles]) for k in keys}
        if merged:
            out[group] = merged
    # structures: a structure is a real object on the primary; dedupe by kind + start station.
    seen: set[tuple] = set()
    structs = []
    for p in profiles:
        for st in p.get("structures") or []:
            key = (st.get("kind"), round(float(st.get("s_start", 0)), 1))
            if key not in seen:
                seen.add(key)
                structs.append(st)
    out["structures"] = sorted(structs, key=lambda s: float(s.get("s_start", 0)))
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
