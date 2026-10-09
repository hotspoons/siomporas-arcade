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

import json
import math
from dataclasses import dataclass

from .naip import NAIP_BLANK_MAX

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

# THE GRADED GROUND. A tile's `dem.png` carries the road grading folded in (grade.py — the
# viewer's own formula), and `bare.png` beside it is the earth as sampled, for the deck tests
# that need bare earth. Only levels whose pixel is finer than this are graded: the blend from
# pavement to DEM runs 0.6–7 m, and a 10–40 m pixel cannot hold it — it would just smear the road
# height across a strip wider than the verge. At latitude 39 that is z13 (4.7 m) and z14 (2.3 m);
# coarser levels stay bare and the viewer, which reads the finest resident tile, has a leaf or a
# z13 under anything within four kilometres of the eye. The car's physics tiles reach 180 m.
GRADE_MAX_PX_M = 6.0


def graded_levels(zmin: int, zmax: int, lat: float) -> list[int]:
    """The levels whose pixel is at most GRADE_MAX_PX_M across (the finer end of the pyramid)."""
    return [z for z in range(zmin, zmax + 1) if max(tile_metres(z, lat)) / TILE_PX <= GRADE_MAX_PX_M]


# One open dataset per source for the whole bake. Opening the 1 m DEM once per tile, per band,
# is most of the wall time — trailworks resamples from a dataset it already holds.
_OPEN: dict = {}


def _dataset(src_path):
    import rasterio

    key = str(src_path)
    if key not in _OPEN:
        _OPEN[key] = rasterio.open(src_path) if src_path.exists() else None
    return _OPEN[key]


def _sample(src_path, w: float, s: float, e: float, n: float, px: int, nodata: float, band: int = 1):
    """Reproject one band of a source raster onto this tile's WGS84 grid. None if the file is absent."""
    import numpy as np
    import rasterio
    from rasterio.transform import from_bounds
    from rasterio.warp import Resampling, reproject

    src = _dataset(src_path)
    if src is None:
        return None
    dst = np.full((px, px), nodata, dtype=np.float32)
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

    src = _dataset(src_path)
    if src is None:
        return None
    dst = np.zeros((3, px, px), dtype=np.uint8)
    for b in range(3):
        reproject(
            rasterio.band(src, b + 1), dst[b],
            dst_transform=from_bounds(w, s, e, n, px, px), dst_crs="EPSG:4326",
            resampling=Resampling.average, dst_nodata=0,
        )
    return dst


def naip_blank(rgb):
    """Boolean (h, w) mask of pixels that are no-data: very dark on every channel."""
    return (rgb <= NAIP_BLANK_MAX).all(axis=0)


def _source_mean(src_path):
    """A plausible average NAIP tone for the whole site, from a decimated read (uses the .ovr).

    Used to colour a tile whose window is ENTIRELY no-data. There is no local valid mean to borrow
    there, so the choice is this or black; black ground is the bug we are closing, and a flat mean
    reads as ground rather than as a hole. Returns a (3,) uint8 array, or None if the source has no
    valid pixels at all.
    """
    import numpy as np

    src = _dataset(src_path)
    if src is None or src.count < 3:
        return None
    a = src.read(indexes=[1, 2, 3], out_shape=(3, 64, 64))
    m = (a > NAIP_BLANK_MAX).any(axis=0)
    if not m.any():
        return None
    return np.array([int(a[c][m].mean()) for c in range(3)], dtype=np.uint8)


def fill_blank(rgb, fallback=None):
    """
    Replace the nodata fill with the tile's own valid mean, and report the fraction.

    A tile at the edge of coverage is not black ground. `reproject` leaves whatever it cannot reach
    at the fill value, and on the flat tile set that painted edge tiles BLACK — crofton-triangle
    had tiles at 13.8 mean luma beside neighbours at 91.4, and the dark ones were 85 % nodata whose
    real imagery averaged 91.9 against the neighbour's 91.8. The photograph was never the problem.
    A pyramid has four times as many edge tiles per level, so this matters more here, not less.

    A window that is ENTIRELY no-data has no valid mean to borrow. With `fallback` (the site mean)
    it is filled with that instead of left black; without one it is left as it was, which keeps the
    helper's answer identical to `network_tiles._fill_naip_blank` for the partial-hole case.
    """
    import numpy as np

    blank = (rgb == 0).all(axis=0)
    nb = int(blank.sum())
    if blank.size and nb == blank.size:
        if fallback is not None:
            rgb[:] = np.asarray(fallback, dtype=np.uint8)[:, None, None]
            return rgb, 1.0
        return rgb, 0.0
    if nb:
        for c in range(3):
            ch = rgb[c]
            ch[blank] = int(ch[~blank].mean())
    return rgb, (nb / blank.size if blank.size else 0.0)


def _bake_serial(site_dir, web, frame, zmax: int | None = None, zmin: int | None = None, vivid=None, only_tiles: list | None = None, grade_model=None, grade_z: tuple = ()) -> dict:
    """
    Emit the pyramid under `web/pyr/<z>/<x>_<y>.{pack,jpg}` and return the manifest block.

    With `grade_model` (a `grade.RoadModel`), every tile at a level in `grade_z` is written with
    the road grading folded into `dem.png` and the sampled earth beside it as `bare.png`.

    A tile's bounds are IMPLICIT in (z, x, y) — that is the point of quadtree addressing, and it
    is why this needs no control lattice where the UTM tiles did. The viewer derives the geodetic
    corners from the id and asks `Anchor.toLocal` for the ENU position of each vertex, so the grid
    curves correctly with no per-tile metadata at all.
    """
    import io
    import json
    import time

    import numpy as np
    from PIL import Image

    from .export import _encode_height, _fill
    from .pack import write_pack

    grade_ms = 0.0

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
    if only_tiles is not None:
        # a worker's slice: the parent decided the plan; a worker just renders its share
        tiles = [Tile(int(z), int(x), int(y)) for z, x, y in only_tiles]

    dem_p = site_dir / "dem_1m.tif"
    chm_p = site_dir / "lidar" / "chm.vrt"
    naip_p = site_dir / "naip_1m.tif"
    if not naip_p.exists():
        naip_p = site_dir / "naip.tif"
    # The tone to paint a window that is ENTIRELY no-data, so the ground never renders black when
    # imagery is absent. Computed once per worker from a decimated read.
    naip_mean = _source_mean(naip_p) if naip_p.exists() else None
    blank_tiles: list = []

    out = web / "pyr"
    entries = []
    rev = int((site_dir / "manifest.json").stat().st_mtime) if (site_dir / "manifest.json").exists() else 0
    skipped = 0
    from . import progress

    p = progress.Progress("pyramid", len(tiles))
    for i, t in enumerate(tiles):
        p.tick()
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
        if grade_model is not None and t.z in grade_z:
            # The viewer reads this raster through `toEnuUp`, so the grading happens in ENU up and
            # comes back to a stored height with the viewer's own corner-patch drop (grade_block).
            from .grade import corner_enu_for, grade_block

            tg0 = time.perf_counter()
            corners = corner_enu_for(frame.anchor_frame(), w, s, e, n)
            zg, touched = grade_block(grade_model, corners, z)
            grade_ms += (time.perf_counter() - tg0) * 1000
            rgb_b, zmn_b, scale_b = _encode_height(z)
            buf = io.BytesIO()
            Image.fromarray(rgb_b, "RGB").save(buf, "PNG", optimize=True)
            parts["bare.png"] = buf.getvalue()
            entry["bare"] = {"zmin": zmn_b, "zscale": scale_b}
            entry["graded_px"] = int(touched.sum())
            z = zg
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
        if rgb is not None:
            # The no-data test is a threshold (a hole arrives through a JPEG shard, so it decodes
            # to a few counts, not exact zero). fill_blank fills a partial hole from its own valid
            # mean; an ENTIRELY blank window has none, so paint the site mean and report it.
            blank_frac = float(naip_blank(rgb).mean()) if rgb.size else 0.0
            rgb, frac = fill_blank(rgb, fallback=naip_mean)
            if frac:
                entry["naip_fill"] = round(frac, 3)
            if blank_frac > 0.98:
                if naip_mean is not None:
                    rgb = np.tile(naip_mean[:, None, None], (1, TILE_PX, TILE_PX))
                else:
                    rgb = np.full((3, TILE_PX, TILE_PX), 128, dtype=np.uint8)  # neutral earth tone
                entry["naip_blank"] = round(blank_frac, 3)
                blank_tiles.append((t.z, t.x, t.y, round(blank_frac, 3)))
            img = Image.fromarray(np.moveaxis(rgb, 0, -1), "RGB")
            if vivid is not None:
                img = vivid(img, 1.3, 1.1)
                r_, g_, b_ = img.split()
                img = Image.merge("RGB", (r_.point(lambda v: min(255, int(v * 1.06))), g_, b_.point(lambda v: int(v * 0.9))))
            img.save(d / f"{t.x}_{t.y}.jpg", quality=85, optimize=True)
            entry["naip"] = True
        entries.append(entry)
    p.close()

    if blank_tiles:
        byz: dict[int, int] = {}
        for z, _x, _y, _f in blank_tiles:
            byz[z] = byz.get(z, 0) + 1
        sample = ", ".join(f"z{z}:{x}_{y}" for z, x, y, _f in blank_tiles[:4])
        tone = tuple(int(v) for v in naip_mean) if naip_mean is not None else (128, 128, 128)
        print(
            f"  pyramid WARNING {len(blank_tiles)} tiles had NO NAIP imagery (painted the site mean "
            f"{tone}): {dict(sorted(byz.items()))} e.g. {sample}",
            flush=True,
        )

    out_block = {
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
    if grade_model is not None:
        # `graded` is the viewer's switch: physGroundAt and the strips read the raster directly
        # and the deck tests ask `bareAt`. An old bake has no flag and grades at run time as before.
        out_block["graded"] = True
        out_block["graded_levels"] = sorted(grade_z)
        out_block["grade_ms"] = round(grade_ms)
    return out_block


#: Set in the parent before forking so every worker inherits `frame` (its pyproj Transformer cache
#: is not picklable) and the vivid filter by copy-on-write, not through a pickle.
_PYR_CTX: dict = {}


def _init_ctx(ctx: dict) -> None:
    """Worker initializer: timestamped stream + the pyramid context (a forkserver child inherits no
    module globals; see `pool.map_chunks`)."""
    from . import progress

    progress.install_timestamps()
    global _PYR_CTX
    _PYR_CTX = ctx


def _bake_worker(tiles: list) -> dict:
    c = _PYR_CTX
    return _bake_serial(c["site_dir"], c["web"], c["frame"], c["zmax"], c["zmin"], c["vivid"], only_tiles=tiles, grade_model=c.get("grade"), grade_z=c.get("grade_z", ()))


def road_model(site_dir, frame, manifest: dict):
    """The site's carriageways as the viewer builds them (grade.RoadModel), over the 1 m DEM.

    Built ONCE, in the parent, and handed to every worker: the junction meet and the station field
    are a whole-network job, and a tile only needs to ask the finished field.
    """
    import os
    import time

    from . import grade

    if os.environ.get("CORRIDOR_GRADE", "1").strip().lower() in ("0", "false", "no", "off"):
        return None
    dem_p = site_dir / "dem_1m.tif"
    if not dem_p.exists() or not manifest or not manifest.get("spine", {}).get("coords"):
        return None
    t0 = time.perf_counter()
    model = grade.RoadModel(manifest, grade.site_dem_up(frame, dem_p))
    # the grades against the earth they are about to be graded into: a GradeFault here is the
    # whole export's (export.py re-raises it), because the deck runs below would be wrong
    go = model.assert_grades_on_the_dem()
    print(f"  grade   carriageways off the DEM by a median {go['median']:+.3f} m over {go['n']:,} non-deck stations "
          f"(|p90| {go['p90']:.2f} m, {100 * go['deck_share']:.1f} % deck) — within {grade.GRADE_OFF_MAX_M} m", flush=True)
    # the manifest is the caller's `out`: the deck runs land in it before it is written
    decks = model.annotate_decks(manifest)
    sm = model.summary()
    print(f"  grade   {decks} elevated runs written as elev_s (the viewer's deck tests follow the bake)", flush=True)
    print(f"  grade   {sm['roads']} carriageways, {sm['stations']} stations + {sm['bulbs']} bulbs + {sm['driveway_stations']} driveway stations; "
          f"junctions {sm['junctions']['junctions']} met, {sm['junctions']['warped']} warped (max {sm['junctions']['maxStep']} m), "
          f"{sm['junctions']['noTarget']} without a target — {time.perf_counter() - t0:.1f} s", flush=True)
    return model


def bake(site_dir, web, frame, zmax: int | None = None, zmin: int | None = None, vivid=None, manifest: dict | None = None) -> dict:
    """Render the pyramid, forked across `pool` workers (one manifest merged from the slices).

    A pyramid tile is sampled from the same site rasters as its siblings and written to a file keyed
    by its own (z, x, y), so the tiles are independent and the only shared state is the read-only
    plan. On the Capital Beltway that was 1,272 tiles in a single `for` loop (corridor-bake-495,
    ~60 min); the plan is unchanged, only who runs it is.

    `manifest` is the manifest-shaped dict the viewer will read (spine, branches, intersections,
    structures, driveways). With it, the fine levels are written GRADED — see `GRADE_MAX_PX_M` and
    grade.py; `CORRIDOR_GRADE=0` turns that off. Without it the pyramid is bare, as it always was.
    """
    from . import pool

    site = json.loads((site_dir / "site.json").read_text())
    bb = site.get("bbox_utm")
    if not bb:
        return {}
    bbox_wgs = frame.bbox_wgs(*bb)
    zmax = zmax if zmax is not None else leaf_level(float(site["lat"]))
    zmin = zmin if zmin is not None else root_level(bbox_wgs)
    tiles = plan(bbox_wgs, zmax=zmax, zmin=zmin)
    print(f"pyramid: {len(tiles)} tiles z{zmin}..{zmax}", flush=True)
    if not tiles:
        return {}
    model = None
    if manifest is not None:
        try:
            model = road_model(site_dir, frame, manifest)
        except Exception as exc:  # a bare pyramid is the old viewer path, not a broken one — but say so
            import traceback

            traceback.print_exc()
            print(f"  grade   FAILED ({exc.__class__.__name__}: {exc}) — the pyramid is baked BARE and the viewer grades at run time", flush=True)
    grade_z = tuple(graded_levels(zmin, zmax, float(site["lat"]))) if model is not None else ()
    if model is not None:
        print(f"  grade   levels {grade_z} graded (pixel <= {GRADE_MAX_PX_M} m); {tuple(z for z in range(zmin, zmax + 1) if z not in grade_z)} bare", flush=True)
    global _PYR_CTX
    _PYR_CTX = {"site_dir": site_dir, "web": web, "frame": frame, "zmax": zmax, "zmin": zmin, "vivid": vivid, "grade": model, "grade_z": grade_z}
    chunks = pool.chunk([(t.z, t.x, t.y) for t in tiles], pool.default_jobs(len(tiles)))
    parts = pool.map_chunks(_bake_worker, chunks, "pyramid", initializer=_init_ctx, initargs=(_PYR_CTX,))
    entries: list = []
    empty = 0
    grade_ms = 0
    out = None
    for r in parts:
        if not r:
            continue
        out = out or r
        entries.extend(r.get("list") or [])
        empty += int(r.get("empty") or 0)
        grade_ms += int(r.get("grade_ms") or 0)
    if out is None:
        return {}
    out = dict(out)
    out["list"] = entries
    out["empty"] = empty
    if model is not None:
        # worker CPU summed across the slices — what the grading cost, not the wall it hid behind
        n_graded = sum(1 for e in entries if e.get("bare"))
        px = sum(int(e.get("graded_px") or 0) for e in entries)
        print(f"  grade   {n_graded} tiles graded, {px:,} pixels touched, {grade_ms / 1000:.1f} s of worker time", flush=True)
        out.pop("grade_ms", None)
    return out
