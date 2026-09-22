"""An LOD pyramid on the shared geographic quadtree.

## Why

`network_tiles.export_tiles` emits ONE flat level of 1 km tiles, and the viewer loads every one of
them before it draws a frame — 33.8 MB of packs at boot for crofton-crownsville's 125 tiles. That
is not streaming, it is deferred loading, and it scales with the size of the world:

    342 km²  ->    342 tiles ->    92 MB fetched at boot
  3 000 km²  ->  3 000 tiles ->   811 MB
 32 000 km²  -> 32 000 tiles ->  8.7 GB

A pyramid bounds the resident set by the VIEW instead of by the world. With strict
child-replaces-parent selection and a screen-space ring, a driving camera holds about 69 tiles
whatever the world's size — fewer than the 125 one site costs today.

## The scheme, and why this one

The same geographic quadtree trailworks uses (`globe_tiles.tile_bounds`, `geoMath.tileBoundsRaw`,
and `tileBounds`/`tileOf` in packages/engine/src/geo/wgs84.ts, which were written during the
geodetic work precisely so the two projects could meet): level z has 2^(z+1) columns of longitude
and 2^z rows of latitude.

At latitude 39 that gives:

    z10  19.6 x 15.2 km      one tile covers the whole crofton-crownsville hull
    z11   9.8 x  7.6 km
    z12   4.9 x  3.8 km
    z13   2.4 x  1.9 km
    z14   1.2 x  0.95 km     ~ the 1 km tile we already emit

So **z14 is the leaf** and the existing tile size needs no reshaping to fit the scheme — the grid
moves from a UTM lattice to a geodetic one, but the resolution does not change. z10 is the root
for a site of this size; a bigger world simply starts higher.

## Quad closure, learned from trailworks the hard way

Strict child-replaces-parent means a tile subdivides only when ALL FOUR children exist. A parent
with one to three baked children can never subdivide and freezes at its own coarse level, however
much detail sits below it. trailworks hit this on every region boundary — `pipeline/bake/pyramid.py`
documents Burton Island stuck at z8 while the land beside it was crisp.

So `plan()` returns a quad-closed set: whenever a tile is wanted, every sibling in its quad is
emitted too, and so on up to the root. A sibling with no source data still gets written, as a leaf,
rather than left absent.

## Heights, and the objection this answers

The current loader was written on the premise that heights cannot stream — the strip, trees, grass
and car all ask for a height on the first frame, and a missing height is a hole rather than a
coarser LOD. That is true of a FLAT tile set. A pyramid dissolves it: the root level is small, is
always resident, and always answers. Finer tiles refine that answer as they arrive; nothing ever
has to wait for one.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

# --- the quadtree (mirrors packages/engine/src/geo/wgs84.ts) -------------------------------------


def tile_bounds(z: int, x: int, y: int) -> tuple[float, float, float, float]:
    """(w, s, e, n) in degrees for tile (z, x, y)."""
    cols, rows = 2 ** (z + 1), 2**z
    return (
        -180.0 + (x * 360.0) / cols,
        90.0 - ((y + 1) * 180.0) / rows,
        -180.0 + ((x + 1) * 360.0) / cols,
        90.0 - (y * 180.0) / rows,
    )


def tile_of(z: int, lon: float, lat: float) -> tuple[int, int]:
    cols, rows = 2 ** (z + 1), 2**z
    x = min(cols - 1, max(0, int(((lon + 180.0) / 360.0) * cols)))
    y = min(rows - 1, max(0, int(((90.0 - lat) / 180.0) * rows)))
    return x, y


def tiles_over(z: int, w: float, s: float, e: float, n: float) -> list[tuple[int, int]]:
    """Every tile at level z whose square intersects the WGS84 bbox."""
    x0, y1 = tile_of(z, w, s)
    x1, y0 = tile_of(z, e, n)
    return [(x, y) for x in range(min(x0, x1), max(x0, x1) + 1) for y in range(min(y0, y1), max(y0, y1) + 1)]


def tile_metres(z: int, lat: float) -> tuple[float, float]:
    """Tile edge in metres (east-west, north-south) at a latitude — for choosing zmin/zmax."""
    ns = (180.0 / 2**z) * 111_320.0
    ew = (360.0 / 2 ** (z + 1)) * 111_320.0 * math.cos(math.radians(lat))
    return ew, ns


@dataclass(frozen=True)
class Tile:
    z: int
    x: int
    y: int

    @property
    def key(self) -> str:
        return f"{self.z}/{self.x}/{self.y}"

    def parent(self) -> "Tile | None":
        return None if self.z == 0 else Tile(self.z - 1, self.x // 2, self.y // 2)

    def quad(self) -> list["Tile"]:
        """This tile's four siblings, including itself."""
        bx, by = (self.x // 2) * 2, (self.y // 2) * 2
        return [Tile(self.z, bx + dx, by + dy) for dx in (0, 1) for dy in (0, 1)]


def leaf_level(lat: float, target_m: float = 1000.0, lo: int = 6, hi: int = 20) -> int:
    """The z whose tile is closest to `target_m` across — how the leaf level is chosen, not assumed."""
    best, bz = None, lo
    for z in range(lo, hi + 1):
        ew, ns = tile_metres(z, lat)
        d = abs(math.hypot(ew, ns) / math.sqrt(2) - target_m)
        if best is None or d < best:
            best, bz = d, z
    return bz


def root_level(bbox_wgs: tuple[float, float, float, float], lo: int = 6, hi: int = 20) -> int:
    """
    The coarsest level worth baking: the finest z whose tile still COVERS the site in one or two.

    Not a constant. A fixed root wastes the whole upper pyramid on nodata — crofton-triangle is
    8.5 km across, and a z10 tile is 19.6 x 15.2 km, so 97.5 % of that tile has no source behind
    it. Measured, not guessed: the first z10 tile sampled came back 2.5 % valid.

    A genuinely continental world would take its coarse levels from a WIDE source instead (the way
    trailworks builds its globe pyramid from ETOPO and reserves real DEM for the leaves, and the
    way our own 60 m / 60 km horizon raster could serve). That is the right answer when the world
    outgrows its own rasters. It is not today's problem: for one site, the site's own data covers
    the site, and the root is simply the level where that stops being several tiles.
    """
    w, s, e, n = bbox_wgs
    lat = (s + n) / 2
    # the site's own extent in metres
    site_ew = (e - w) * 111_320.0 * math.cos(math.radians(lat))
    site_ns = (n - s) * 111_320.0
    span = max(site_ew, site_ns)
    # the FINEST level whose tile is still at least as big as the site. Counting tiles instead of
    # comparing sizes does not work: a small site sitting on a boundary touches four tiles at every
    # level, however coarse, so the count never settles and the search runs away to z8.
    best = lo
    for z in range(lo, hi + 1):
        ew, ns = tile_metres(z, lat)
        if min(ew, ns) >= span:
            best = z
        else:
            break
    return best


def plan(bbox_wgs: tuple[float, float, float, float], zmax: int, zmin: int) -> list[Tile]:
    """
    Every tile to bake, QUAD-CLOSED from `zmax` up to `zmin`.

    Quad closure is the whole point: a parent whose quad is incomplete can never subdivide under
    strict child-replaces-parent, so it freezes at its own level and the detail below it is
    unreachable. Emitting the siblings costs a little disk and removes a class of bug that renders
    as "this corner of the world is permanently blurry".
    """
    w, s, e, n = bbox_wgs
    want: set[Tile] = {Tile(zmax, x, y) for x, y in tiles_over(zmax, w, s, e, n)}
    # close each level's quads, then carry the parents up
    for z in range(zmax, zmin, -1):
        level = {t for t in want if t.z == z}
        for t in list(level):
            want.update(t.quad())
        want.update(p for t in level if (p := t.parent()) is not None)
    want.update(Tile(zmin, x, y) for x, y in tiles_over(zmin, w, s, e, n))
    return sorted(want, key=lambda t: (t.z, t.x, t.y))


# --- baking --------------------------------------------------------------------------------------

TILE_PX = 512  # samples a side, every level. z14 lands at ~1.9 x 2.4 m, near the 2 m we emit today.


def _sample(src_path, w: float, s: float, e: float, n: float, px: int, nodata: float, band: int = 1):
    """Reproject one band of a source raster onto this tile's WGS84 grid. None if the file is absent."""
    import numpy as np
    import rasterio
    from rasterio.transform import from_bounds
    from rasterio.warp import Resampling, reproject

    if not src_path.exists():
        return None
    dst = np.full((px, px), nodata, dtype=np.float32)
    with rasterio.open(src_path) as src:
        reproject(
            rasterio.band(src, band), dst,
            dst_transform=from_bounds(w, s, e, n, px, px), dst_crs="EPSG:4326",
            resampling=Resampling.average, dst_nodata=nodata,
        )
    return dst


def _sample_rgb(src_path, w: float, s: float, e: float, n: float, px: int):
    import numpy as np
    import rasterio
    from rasterio.transform import from_bounds
    from rasterio.warp import Resampling, reproject

    if not src_path.exists():
        return None
    dst = np.zeros((3, px, px), dtype=np.uint8)
    with rasterio.open(src_path) as src:
        for b in range(3):
            reproject(
                rasterio.band(src, b + 1), dst[b],
                dst_transform=from_bounds(w, s, e, n, px, px), dst_crs="EPSG:4326",
                resampling=Resampling.average, dst_nodata=0,
            )
    return dst


def fill_blank(rgb):
    """
    Replace the nodata fill with the tile's own valid mean, and report the fraction.

    A tile at the edge of coverage is not black ground. `reproject` leaves whatever it cannot reach
    at the fill value, and on the flat tile set that painted edge tiles BLACK — crofton-triangle
    had tiles at 13.8 mean luma beside neighbours at 91.4, and the dark ones were 85 % nodata whose
    real imagery averaged 91.9 against the neighbour's 91.8. The photograph was never the problem.
    A pyramid has four times as many edge tiles per level, so this matters more here, not less.
    """
    import numpy as np

    blank = (rgb == 0).all(axis=0)
    nb = int(blank.sum())
    if nb and nb < blank.size:
        for c in range(3):
            ch = rgb[c]
            ch[blank] = int(ch[~blank].mean())
    return rgb, (nb / blank.size if blank.size else 0.0)


def bake(site_dir, web, frame, zmax: int | None = None, zmin: int | None = None, vivid=None) -> dict:
    """
    Emit the pyramid under `web/pyr/<z>/<x>_<y>.{pack,jpg}` and return the manifest block.

    A tile's bounds are IMPLICIT in (z, x, y) — that is the point of quadtree addressing, and it
    is why this needs no control lattice where the UTM tiles did. The viewer derives the geodetic
    corners from the id and asks `Anchor.toLocal` for the ENU position of each vertex, so the grid
    curves correctly with no per-tile metadata at all.
    """
    import io
    import json

    import numpy as np
    from PIL import Image

    from .export import _encode_height, _fill
    from .pack import write_pack

    site = json.loads((site_dir / "site.json").read_text())
    lat = float(site["lat"])
    ox, oy = frame.origin
    bb = site.get("bbox_utm")
    bbox_wgs = frame.bbox_wgs(*bb) if bb else None
    if bbox_wgs is None:
        return {}
    zmax = zmax if zmax is not None else leaf_level(lat)
    zmin = zmin if zmin is not None else root_level(bbox_wgs)
    tiles = plan(bbox_wgs, zmax=zmax, zmin=zmin)

    dem_p = site_dir / "dem_1m.tif"
    chm_p = site_dir / "lidar" / "chm.vrt"
    naip_p = site_dir / "naip_1m.tif"
    if not naip_p.exists():
        naip_p = site_dir / "naip.tif"

    out = web / "pyr"
    entries = []
    rev = int((site_dir / "manifest.json").stat().st_mtime) if (site_dir / "manifest.json").exists() else 0
    skipped = 0
    for t in tiles:
        w, s, e, n = tile_bounds(t.z, t.x, t.y)
        parts: dict[str, bytes] = {}
        entry: dict = {"z": t.z, "x": t.x, "y": t.y}

        z = _sample(dem_p, w, s, e, n, TILE_PX, -9999.0)
        if z is None or not np.isfinite(z).any() or not (z > -9000).any():
            # No source under this tile. It is still EMITTED — quad closure means an absent sibling
            # freezes its parent forever — but as a marker with no rasters.
            entry["empty"] = True
            entries.append(entry)
            skipped += 1
            continue
        z = _fill(z, -9999.0)
        rgb_h, zmn, scale = _encode_height(z)
        buf = io.BytesIO()
        Image.fromarray(rgb_h, "RGB").save(buf, "PNG", optimize=True)
        parts["dem.png"] = buf.getvalue()
        entry["dem"] = {"zmin": zmn, "zscale": scale}

        c = _sample(chm_p, w, s, e, n, TILE_PX, 0.0)
        if c is not None and np.isfinite(c).any():
            buf = io.BytesIO()
            Image.fromarray(np.clip(np.round(np.nan_to_num(c) * 4), 0, 255).astype(np.uint8), "L").save(buf, "PNG", optimize=True)
            parts["chm.png"] = buf.getvalue()
            entry["chm"] = True

        d = out / str(t.z)
        d.mkdir(parents=True, exist_ok=True)
        entry["pack"] = write_pack(d / f"{t.x}_{t.y}.pack", parts, rev=rev)

        rgb = _sample_rgb(naip_p, w, s, e, n, TILE_PX)
        if rgb is not None and rgb.any():
            rgb, frac = fill_blank(rgb)
            img = Image.fromarray(np.moveaxis(rgb, 0, -1), "RGB")
            if vivid is not None:
                img = vivid(img, 1.3, 1.1)
                r_, g_, b_ = img.split()
                img = Image.merge("RGB", (r_.point(lambda v: min(255, int(v * 1.06))), g_, b_.point(lambda v: int(v * 0.9))))
            img.save(d / f"{t.x}_{t.y}.jpg", quality=85, optimize=True)
            entry["naip"] = True
            if frac:
                entry["naip_fill"] = round(frac, 3)
        entries.append(entry)

    return {
        "scheme": "geo-quadtree",   # 2^(z+1) lon cols, 2^z lat rows — same ids as trailworks
        "zmin": zmin,
        "zmax": zmax,
        "px": TILE_PX,
        "dir": "pyr",
        "format": "pack-1",
        "texture": "jpg",
        "empty": skipped,
        "list": entries,
    }
