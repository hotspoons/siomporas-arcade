"""The point cloud itself, from USGS's Entwine (EPT) staging, and what a road can learn from it.

WHY THE POINTS AND NOT JUST THE DEM. The 1 m DEM is bare earth: the vendor has already deleted
every bridge deck, tree and building from it. Those are precisely the things this game has to
place. The classified point cloud still has them, each with an ASPRS class:

    2 ground   3/4/5 low/medium/high vegetation   6 building   7/18 noise   9 water
    17 BRIDGE DECK   (and 10 rail, 11 road surface, 13-16 wires/towers where the vendor bothered)

Class 17 is the answer to "does something cross over this road": a bridge deck is explicitly
labelled, in 3D, at 8 points per square metre. OSM tells us a way crosses; the deck tells us how
high and how wide. Vegetation classes minus ground is a canopy height model — tree cover, per
metre, for placing trees where trees are. Ground beside the road versus the road's own height is
the cut/fill profile: a blasted rock cut is ground standing 10-30 m above the pavement a few
metres to the side; an embankment is the reverse.

WHY EPT. USGS stages every 3DEP project as Entwine Point Tiles on a public bucket: an octree of
LAZ files with a JSON hierarchy. A 6 km corridor a few hundred metres wide is a handful of octree
nodes — tens of MB — where the same stretch as LAZ delivery tiles is 850 MB. EPT is in Web
Mercator; points are re-projected to the site frame on the way in. There is no PDAL in this
container (Debian trixie/arm64 has none) so the octree walk is done by hand here and the LAZ nodes
are read with laspy+lazrs.

UNITS. EPT declares no vertical CRS. Z is compared against the DEM (metres, NAVD88) on load and
converted if it is in feet — one older Maryland project is.
"""
from __future__ import annotations

import json
import os
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import laspy
import numpy as np
import rasterio
import rasterio.enums
import requests
import shapely
from rasterio.features import rasterize
from rasterio.transform import from_origin
from scipy import ndimage
from shapely.geometry import LineString, Polygon

from .geo import Frame

BASE = "https://usgs-lidar-public.s3.us-west-2.amazonaws.com/{ds}/"
# Newest and best first. A dataset is used when its bounds contain the corridor.
DATASETS = [
    "MD_Western_2_D21",
    "MD_Western_1_D21",
    "MD_PotomacP2_TB_2021",
    "MD_VA_NCB_KGeorge_1_2020",
    "USGS_LPC_MD_VA_Sandy_NCR_2014_LAS_2015",
]
# EPT sets that are older AND mis-classified (Sandy NCR 2014 uses class 17/18 as junk bins and has
# no vegetation classes): skipped in favour of the TNM delivery tiles, where MD_Central_Processing_D24
# (2020, vegetation classified) covers the same ground — a rule, not a per-site flag (main, 2026-09-21).
PREFER_TNM_OVER = {"USGS_LPC_MD_VA_Sandy_NCR_2014_LAS_2015"}
# a deck's underside is a plane: lowest point per 2 m lateral cell agrees across the road.
# Real decks measured ≤ 0.28 m std / ≤ 0.74 m range; tree canopy over a narrow road ≥ 1.2 / ≥ 3.
DECK_UNDERSIDE_STD = 0.5
DECK_UNDERSIDE_RANGE = 1.5
# an unlabelled deck: the DTM drops this far below the local grade, for at most this long
DIP_MIN = 1.5
DIP_MAX_LEN = 120.0

CLASS_NAMES = {0: "never", 1: "unassigned", 2: "ground", 3: "veg_low", 4: "veg_med", 5: "veg_high", 6: "building", 7: "noise", 9: "water", 10: "rail", 11: "road", 13: "wire_guard", 14: "wire_conductor", 15: "tower", 16: "wire_connector", 17: "bridge_deck", 18: "noise_high", 20: "ignored_ground", 21: "snow", 22: "temporal_exclusion"}
session = requests.Session()
session.headers["User-Agent"] = "apex-conduit corridor (github.com/hotspoons)"


def _get_json(url: str, cache: Path) -> dict:
    cache.parent.mkdir(parents=True, exist_ok=True)
    if cache.exists():
        return json.loads(cache.read_text())
    r = session.get(url, timeout=120)
    r.raise_for_status()
    cache.write_bytes(r.content)
    return r.json()


def fetch_points(frame: Frame, bbox: tuple[float, float, float, float], cache: Path, jobs: int = 16, clip: Polygon | None = None) -> tuple[dict, dict]:
    """The whole corridor's points in memory, for the single-image paths. See point_batches."""
    meta: dict = {}
    # no DEM check per batch here: both callers run check_units on the whole cloud afterwards
    parts = [p for _, p in point_batches(frame, bbox, cache, clip, meta, None, jobs) if p]
    if not parts:
        raise RuntimeError("the lidar sources intersect the bbox but hold no points in it")
    pts = _join(parts)
    print(f"  lidar   {len(pts['x']):,} points in bbox", flush=True)
    meta["points"] = int(len(pts["x"]))
    return pts, meta


def dem_beside(site_dir: Path) -> Path | None:
    """The site's 1 m DEM, which a batch with an undeclared vertical unit is checked against."""
    for name in ("dem_1m.tif", "dem_1m.vrt"):
        if (site_dir / name).exists():
            return site_dir / name
    return None


def point_batches(frame: Frame, bbox, cache: Path, clip: Polygon | None, meta: dict, dem: Path | None = None, jobs: int = 16):
    """Point batches in the site frame, clipped to the streets, from the best source there is.

    EPT first (lidar_sources: USGS's staged sets, then NOAA's), when together they cover enough of
    the streets; the TNM delivery tiles otherwise, or when CORRIDOR_LIDAR_SOURCE=tnm. Yields
    (label, part) — part may be None for a tile with nothing inside — and fills `meta` with what
    the manifest records. A batch from an EPT whose vertical unit is undeclared is checked against
    the DEM once per source, as the single-road path always did for the whole cloud.
    """
    from . import lidar_sources as ls

    choice = ls.source_choice()
    if choice != "tnm":
        cands, share = ls.candidates(frame, bbox, clip, cache)
        if cands and (share is None or share >= ls.MIN_EPT_COVERAGE or choice == "ept"):
            zf: dict[str, float] = {}
            emitted = False
            for label, part in ls.stream_ept(frame, bbox, clip, cache, cands, meta, jobs):
                src = label.split(" ", 1)[0]
                if src not in zf:
                    zf[src] = check_units(part, dem) if dem is not None and (part["cls"] == 2).any() else 1.0
                if zf[src] != 1.0:
                    part["z"] = part["z"] * zf[src]
                emitted = True
                yield label, part
            if emitted:
                meta["z_factor"] = zf
                return
            print("  lidar   no EPT candidate had points over these streets; the TNM tiles instead", flush=True)
        elif cands:
            print(f"  lidar   EPT covers only {share:.0%} of the streets; the TNM tiles instead", flush=True)
        elif choice == "ept":
            raise RuntimeError("no lidar at all for this corridor as EPT (CORRIDOR_LIDAR_SOURCE=ept)")
    proj, tiles = tnm_pick(frame, bbox, clip)
    paths = tnm_download(proj, tiles, cache, int(os.environ.get("CORRIDOR_TNM_JOBS", "16")))
    meta.update({"dataset": f"TNM:{proj}", "source": "tnm", "tiles_laz": len(paths)})
    for i, pth in enumerate(paths, 1):
        yield f"tile {i}/{len(paths)} {pth.name}", _read_laz_tile(pth, frame, bbox, clip)


TNM = "https://tnmaccess.nationalmap.gov/api/v1/products"


#: How many points are reprojected at a time.
#:
#: MEASURED, not chosen. `laspy.read` on one 213 MiB delivery tile holds 36.5 million points and
#: peaks at 2.44 GB — the point record, then x and y materialised as float64, then the reprojected
#: pair, then z. 72 bytes of peak per point, for a tile of which a 9.5 km² corridor keeps under a
#: million of them. Rich's t-section bake was killed by the kernel on the fifth of seventeen tiles
#: with 3 GB free, and the runner said `exited null`.
#:
#: At four million the peak is bounded by the CHUNK rather than by the tile, so a 40 MiB delivery
#: and a 2 GiB one cost the same. Larger buys nothing: the work is one pyproj call per chunk and
#: its per-call overhead is lost against four million coordinates.
LAZ_CHUNK = 4_000_000


def _laz_crs(reader, path: Path, frame: Frame, bbox):
    """The tile's CRS: what its header says, or where its extent lands."""
    from pyproj import Transformer

    crs = reader.header.parse_crs()
    if crs is not None:
        return crs
    # Deliveries from before the convention of writing a CRS into the header exist and are
    # otherwise fine: OR_NorthCoast_2008-2009 is why Ecola would not bake. Decide it by geometry
    # instead of guessing — try the site's own CRS and the UTM zone either side, and keep the one
    # whose transformed extent lands on the corridor we asked USGS for.
    #
    # FROM THE HEADER'S EXTENT, not a median over the points: the header records the tile's bounds,
    # so this reads nothing. The median version read all thirty-six million points to take the
    # middle of two columns.
    cx = (reader.header.mins[0] + reader.header.maxs[0]) / 2
    cy = (reader.header.mins[1] + reader.header.maxs[1]) / 2
    xmin, ymin, xmax, ymax = bbox
    pad = 20_000.0
    for cand in (frame.crs, f"EPSG:{frame.epsg - 1}", f"EPSG:{frame.epsg + 1}"):
        try:
            tx, ty = Transformer.from_crs(cand, frame.crs, always_xy=True).transform(cx, cy)
        except Exception:
            continue
        if xmin - pad <= tx <= xmax + pad and ymin - pad <= ty <= ymax + pad:
            print(f"  lidar   {path.name}: no CRS in the header; its extent fits {cand}", flush=True)
            return cand
    print(f"  lidar   {path.name}: no CRS in the header and no candidate fits its extent; skipped", flush=True)
    return None


def _read_laz_tile(path: Path, frame: Frame, bbox, clip: Polygon | None = None) -> dict | None:
    """One delivery tile: read, re-project from ITS declared CRS to the site frame, clip.

    IN CHUNKS (LAZ_CHUNK), because the whole tile does not have to be in memory at once and on a
    loaded machine it does not fit. Only the points that survive the bbox and the corridor clip are
    kept, and on a 9.5 km² site that is a per cent or two of what was read.
    """
    from pyproj import Transformer

    reader = laspy.open(path)
    crs = _laz_crs(reader, path, frame, bbox)
    if crs is None:
        reader.close()
        return None
    tr = Transformer.from_crs(crs, frame.crs, always_xy=True)
    # a compound CRS in US survey feet puts Z in feet too; check_units() confirms against the DEM
    try:
        unit = crs.axis_info[0].unit_name if crs.axis_info else "metre"
    except Exception:
        unit = "metre"
    zf = 0.3048006096 if ("foot" in unit or "feet" in unit) else 1.0
    xmin, ymin, xmax, ymax = bbox

    keep: dict[str, list] = {k: [] for k in ("x", "y", "z", "cls", "rn", "nr", "i")}
    with reader as r:
        for chunk in r.chunk_iterator(LAZ_CHUNK):
            x, y = tr.transform(np.asarray(chunk.x), np.asarray(chunk.y))
            x, y = np.asarray(x), np.asarray(y)
            m = (x >= xmin) & (x < xmax) & (y >= ymin) & (y < ymax)
            if not m.any():
                continue
            if clip is not None:
                # the corridor is a strip on a diagonal; its bbox is mostly air. Clip per chunk so
                # the concatenated cloud is the strip, not the box (memory: 300 M points vs 40 M
                # on Clarksburg)
                idx = np.flatnonzero(m)
                inside = shapely.contains_xy(clip, x[idx], y[idx])
                m[idx[~inside]] = False
                if not m.any():
                    continue
            z = np.asarray(chunk.z)[m]
            keep["x"].append(x[m])
            keep["y"].append(y[m])
            keep["z"].append(z * zf if zf != 1.0 else z)
            keep["cls"].append(np.asarray(chunk.classification)[m].astype(np.uint8))
            keep["rn"].append(np.asarray(chunk.return_number)[m].astype(np.uint8))
            keep["nr"].append(np.asarray(chunk.number_of_returns)[m].astype(np.uint8))
            keep["i"].append(np.asarray(chunk.intensity)[m].astype(np.uint16))

    if not keep["x"]:
        return None
    # one chunk is the common case on a small site; concatenating a single array copies it for
    # nothing, and this runs once per tile per bake
    return {k: (v[0] if len(v) == 1 else np.concatenate(v)) for k, v in keep.items()}


def tnm_pick(frame: Frame, bbox, clip: Polygon | None = None) -> tuple[str, list[dict]]:
    """The TNM project to use and ITS tiles that touch the streets.

    ONE project (mixing vintages inside a corridor makes seams no game wants) — but the one that
    COVERS the corridor, then the newest. "Newest only" picked MD_4County_D24 for Bonnie Branch
    because a single edge tile of it touched the bbox: 0.4 % of the corridor had lidar, the DTM
    was nearest-filled from that sliver, and the road ran 60 m below the real ground in a canyon
    of its own making (Rich, terrain-and-data agent, 2026-09-21).

    BY THE STREETS, not the bbox. A tile is a whole download, so one no street comes near is
    minutes of rockyweb for points the clip then throws away.
    """
    from . import lidar_sources as ls

    w, s, e, n = frame.bbox_wgs(*bbox)
    r = session.get(TNM, params={"datasets": "Lidar Point Cloud (LPC)", "bbox": f"{w},{s},{e},{n}", "outputFormat": "JSON", "max": 800}, timeout=120)
    r.raise_for_status()
    items = r.json().get("items", [])
    if not items:
        raise RuntimeError("no lidar at all for this corridor (EPT or TNM)")
    by_proj: dict[str, list[dict]] = {}
    for it in items:
        by_proj.setdefault(" ".join(it["title"].split(" ")[4:-1]), []).append(it)

    def coverage(tiles: list[dict]) -> float:
        area = max(1e-12, (e - w) * (n - s))
        cov = 0.0
        for it in tiles:
            bb = it.get("boundingBox") or {}
            try:
                ix = max(0.0, min(e, float(bb["maxX"])) - max(w, float(bb["minX"])))
                iy = max(0.0, min(n, float(bb["maxY"])) - max(s, float(bb["minY"])))
            except (KeyError, TypeError, ValueError):
                continue
            cov += ix * iy
        return min(1.0, cov / area)

    scored = sorted(by_proj, key=lambda k: (round(coverage(by_proj[k]), 2), max(i.get("publicationDate", "") for i in by_proj[k]), len(by_proj[k])), reverse=True)
    proj = scored[0]
    tiles = by_proj[proj]
    for k in scored[:4]:
        print(f"  lidar   TNM candidate {k}: {len(by_proj[k])} tiles, covers {coverage(by_proj[k]):.0%} of the bbox, {max(i.get('publicationDate', '') for i in by_proj[k])[:10]}", flush=True)
    if coverage(tiles) < 0.6:
        print(f"  lidar   WARNING best TNM project covers only {coverage(tiles):.0%} of the corridor; gaps fall back to the 3DEP DEM", flush=True)
    kept = tiles_touching(tiles, ls.area_in_wgs(frame, bbox, clip)) if clip is not None else tiles
    total = sum(i.get("sizeInBytes", 0) for i in kept) / 2**20
    skipped = len(tiles) - len(kept)
    print(f"  lidar   TNM {proj}: {len(kept)} LAZ tiles, {total:.0f} MiB" + (f" ({skipped} more over the bbox that no street touches)" if skipped else ""), flush=True)
    return proj, kept


def tiles_touching(tiles: list[dict], area_wgs) -> list[dict]:
    """TNM tiles whose bounding box meets the area; a tile with no box is kept, not guessed away."""
    from shapely.geometry import box as _box

    out = []
    for it in tiles:
        bb = it.get("boundingBox") or {}
        try:
            tb = _box(float(bb["minX"]), float(bb["minY"]), float(bb["maxX"]), float(bb["maxY"]))
        except (KeyError, TypeError, ValueError):
            out.append(it)
            continue
        if tb.intersects(area_wgs):
            out.append(it)
    return out


def tnm_download(proj: str, tiles: list[dict], cache: Path, jobs: int = 16) -> list[Path]:
    """Every tile, `jobs` at a time, with a line per tile as it lands.

    SIXTEEN, not four: rockyweb serves ~80 KB/s per connection and scales with connections (twelve
    measured 930 KiB/s together, 2026-09-30), so four made a 7.6 GB project a six-hour bake. And a
    LINE PER TILE, because the old map() printed nothing until the last of 42 had arrived — half an
    hour of a log that looked like a hang.
    """
    from concurrent.futures import as_completed

    from .dem import download, sweep_partials

    swept = sweep_partials(cache / "laz")
    if swept:
        print(f"  lidar   swept {swept} abandoned .part file(s)", flush=True)
    dest = [cache / "laz" / proj / it["downloadURL"].rsplit("/", 1)[1] for it in tiles]
    total = sum(it.get("sizeInBytes", 0) for it in tiles) / 2**20
    t0 = time.time()
    got_mb = 0.0
    fetched_mb = 0.0
    with ThreadPoolExecutor(max(1, jobs)) as ex:
        futs = {}
        for it, d in zip(tiles, dest):
            size = it.get("sizeInBytes")
            cached = d.exists() and (size is None or d.stat().st_size == size)
            futs[ex.submit(download, it["downloadURL"], d, size)] = (it, d, cached)
        for k, f in enumerate(as_completed(futs), 1):
            it, d, cached = futs[f]
            f.result()
            mb = (it.get("sizeInBytes") or d.stat().st_size) / 2**20
            got_mb += mb
            if not cached:
                fetched_mb += mb
            rate = fetched_mb / max(1e-6, time.time() - t0)
            print(f"  lidar   tile {k}/{len(tiles)} {d.name}: {'cached' if cached else f'{mb:.0f} MiB'} — {got_mb:.0f} of {total:.0f} MiB, {rate:.1f} MiB/s", flush=True)
    return dest


def _join(parts: list[dict]) -> dict:
    """One cloud from many tiles, without holding two copies of it.

    `np.concatenate` allocates the result while every input is still alive, so the peak is twice
    the cloud. On t-section that is not academic: tiles 11 and 12 alone keep 16.7 and 25.5 million
    points, and the doubling lands on a machine that has already spent its memory on the tiles.

    So the total is counted first, the output allocated once, and each part copied in and then
    DROPPED — `parts[i][k] = None` is what makes it a saving rather than a rearrangement, because
    the caller's list holds a reference to every array until it does. Peak is the cloud plus the
    largest single part, rather than the cloud twice.
    """
    total = sum(len(p["x"]) for p in parts)
    out = {}
    for k in parts[0]:
        arr = np.empty(total, dtype=parts[0][k].dtype)
        at = 0
        for p in parts:
            v = p[k]
            arr[at:at + len(v)] = v
            at += len(v)
            p[k] = None  # the only reference left; without this the old copy survives the loop
        out[k] = arr
    return out

def _grid(bbox, res=1.0):
    xmin, ymin, xmax, ymax = bbox
    w, h = int(round((xmax - xmin) / res)), int(round((ymax - ymin) / res))
    return w, h, from_origin(xmin, ymax, res, res)


def _cells(pts, bbox, w, h, res=1.0):
    xmin, _, _, ymax = bbox
    col = ((pts["x"] - xmin) / res).astype(np.int64)
    row = ((ymax - pts["y"]) / res).astype(np.int64)
    ok = (col >= 0) & (col < w) & (row >= 0) & (row < h)
    return row, col, ok


def _fill_nan(a: np.ndarray) -> np.ndarray:
    nan = np.isnan(a)
    if not nan.any() or nan.all():
        return a
    idx = ndimage.distance_transform_edt(nan, return_distances=False, return_indices=True)
    return a[tuple(idx)]


def _write(path: Path, arr: np.ndarray, transform, crs: str, nodata=None):
    with rasterio.open(path, "w", driver="GTiff", width=arr.shape[1], height=arr.shape[0], count=1, dtype=arr.dtype, crs=crs, transform=transform, compress="deflate", tiled=True, nodata=nodata) as d:
        d.write(arr, 1)


def check_units(pts: dict, dem_path: Path) -> float:
    """Return the factor that puts Z in metres, measured against the bare-earth DEM."""
    with rasterio.open(dem_path) as d:
        g = pts["cls"] == 2
        idx = np.random.default_rng(0).choice(np.flatnonzero(g), size=min(20000, int(g.sum())), replace=False)
        rows, cols = rasterio.transform.rowcol(d.transform, pts["x"][idx], pts["y"][idx])
        rows, cols = np.asarray(rows), np.asarray(cols)
        ok = (rows >= 0) & (rows < d.height) & (cols >= 0) & (cols < d.width)
        dem = d.read(1)[rows[ok], cols[ok]]
        valid = dem > -9000
        z = pts["z"][idx][ok][valid]
        dem = dem[valid]
    ratio = float(np.median(z) / np.median(dem)) if len(dem) else 1.0
    factor = 0.3048 if abs(ratio - 1 / 0.3048) < 0.15 else 1.0
    resid = float(np.median(z * factor - dem))
    print(f"  lidar   ground z / DEM ratio {ratio:.3f} -> factor {factor}, median residual {resid:+.2f} m", flush=True)
    return factor


def classification_quality(pts: dict) -> dict:
    """Is this vendor's class 17 (bridge deck) believable? USGS's 2014 Sandy NCR delivery has 23% of
    the corridor as class 17 and another 23% as class 18 (high noise), at ground height — those bins
    were used for something else. Anything over 3% deck is not a road corridor's bridges. When the
    share is implausible, 17 and 18 are demoted to unassigned before any structure logic runs, and
    the manifest says so; the geometric overhead test still finds real overpasses."""
    cls = pts["cls"]
    n = max(1, len(cls))
    share17 = float((cls == 17).sum()) / n
    share18 = float((cls == 18).sum()) / n
    trust = share17 <= 0.03
    q = {"class17_share": round(share17, 4), "class18_share": round(share18, 4), "class17_trusted": trust}
    if not trust:
        demote = (cls == 17) | (cls == 18)
        pts["cls"] = np.where(demote, 1, cls).astype(np.uint8)
        q["note"] = "class 17/18 demoted to unassigned: implausible share, vendor used them as junk bins"
        print(f"  lidar   class 17 = {share17:.1%} of points — not bridge decks; demoted with class 18", flush=True)
    return q


def rasters(pts: dict, bbox, frame: Frame, corridor: Polygon, out_dir: Path) -> dict:
    w, h, tr = _grid(bbox)
    row, col, ok = _cells(pts, bbox, w, h)
    inside = rasterize([(corridor, 1)], out_shape=(h, w), transform=tr, fill=0, dtype=np.uint8).astype(bool)
    keep = ok.copy()
    keep[ok] &= inside[row[ok], col[ok]]
    pts = {k: v[keep] for k, v in pts.items()}
    row, col = row[keep], col[keep]
    z, cls = pts["z"], pts["cls"]
    flat = row * w + col

    def agg(mask, fn, init):
        a = np.full(w * h, init, dtype=np.float32)
        fn.at(a, flat[mask], z[mask].astype(np.float32))
        a[a == init] = np.nan
        return a.reshape(h, w)

    ground = cls == 2
    dtm = agg(ground, np.minimum, np.inf)
    # Fill lidar gaps: nearest lidar within 10 m (a bridge deck shadow, a pond), the 3DEP DEM beyond
    # that. Nearest-fill across a real coverage gap paints the whole corridor with the edge tile's
    # heights (Bonnie Branch: 0.4 % coverage became a 60 m canyon).
    dtm_filled = _fill_nan(dtm.copy())
    nan = np.isnan(dtm)
    if nan.any():
        dist = ndimage.distance_transform_edt(nan)
        far = nan & (dist > 10)
        dem_path = out_dir.parent / "dem_1m.tif"
        if far.any() and dem_path.exists():
            with rasterio.open(dem_path) as src:
                from rasterio.windows import from_bounds
                win = from_bounds(*bbox, transform=src.transform)
                dem_here = src.read(1, window=win, boundless=True, out_shape=(h, w), resampling=rasterio.enums.Resampling.bilinear, fill_value=src.nodata if src.nodata is not None else -9999).astype(np.float32)
            ok = dem_here > -9000
            dtm_filled[far & ok] = dem_here[far & ok]
            print(f"  lidar   coverage {100 * (1 - nan.mean()):.1f} %; {far.sum():,} cells (>10 m from lidar) filled from the 3DEP DEM", flush=True)
    dsm = agg(np.ones_like(cls, bool), np.maximum, -np.inf)
    # Canopy. Vendors differ: some classify vegetation (3/4/5), MD_Western_2021 leaves everything
    # that is not ground as 1 (unassigned). So canopy is "unassigned or vegetation, standing above
    # the ground", with deck cells zeroed. Buildings that the vendor did not classify (6) will show
    # up as canopy here; osm.geojson has their footprints for the game to mask them.
    veg = ((cls >= 3) & (cls <= 5)) | (cls == 1)
    veg_max = agg(veg, np.maximum, -np.inf)
    chm = np.clip(np.nan_to_num(veg_max - dtm_filled, nan=0.0), 0, 80).astype(np.float32)
    deck = cls == 17
    deck_z = agg(deck, np.maximum, -np.inf)
    deck_n = np.bincount(flat[deck], minlength=w * h).reshape(h, w).astype(np.uint16)
    chm[deck_n > 0] = 0
    bld_n = np.bincount(flat[cls == 6], minlength=w * h).reshape(h, w).astype(np.uint16)

    crs = frame.crs
    _write(out_dir / "dtm.tif", np.nan_to_num(dtm, nan=-9999).astype(np.float32), tr, crs, -9999)
    _write(out_dir / "dsm.tif", np.nan_to_num(dsm, nan=-9999).astype(np.float32), tr, crs, -9999)
    _write(out_dir / "chm.tif", chm, tr, crs)
    _write(out_dir / "deck_z.tif", np.nan_to_num(deck_z, nan=-9999).astype(np.float32), tr, crs, -9999)
    _write(out_dir / "deck_n.tif", deck_n, tr, crs)
    _write(out_dir / "building_n.tif", bld_n, tr, crs)

    counts = np.bincount(cls, minlength=32)
    classes = {CLASS_NAMES.get(i, str(i)): int(c) for i, c in enumerate(counts) if c}

    las = laspy.create(point_format=6, file_version="1.4")
    las.header.offsets = [float(np.floor(pts["x"].min())), float(np.floor(pts["y"].min())), 0.0]
    las.header.scales = [0.01, 0.01, 0.01]
    las.x, las.y, las.z = pts["x"], pts["y"], z
    las.classification = cls
    las.return_number, las.number_of_returns, las.intensity = pts["rn"], pts["nr"], pts["i"]
    import pyproj

    las.header.add_crs(pyproj.CRS.from_user_input(crs))
    las.write(out_dir / "corridor.laz")

    return {"points_in_corridor": int(len(z)), "classes": classes, "grid": [w, h], "rasters": ["dtm.tif", "dsm.tif", "chm.tif", "deck_z.tif", "deck_n.tif", "building_n.tif"], "pts": pts, "dtm": dtm_filled, "chm": chm, "transform": tr}


def _runs(mask: np.ndarray) -> list[tuple[int, int]]:
    out, i, n = [], 0, len(mask)
    while i < n:
        if mask[i]:
            j = i
            while j + 1 < n and mask[j + 1]:
                j += 1
            out.append((i, j))
            i = j + 1
        else:
            i += 1
    return out


def profile(spine: LineString, dtm: np.ndarray, chm: np.ndarray, tr, pts: dict, step: float = 2.0, major_road: bool = True, crossings_over_s: list[float] | None = None) -> dict:
    """Along-track profile: road height, ground beside the road (cut/fill), canopy beside the
    road, and structures — bridges we are on, overpasses over us.

    ORDER MATTERS. The DTM under a bridge we are driving on is the valley floor, so "points 4.5 m
    above the road" would flag our own deck as an overpass. Class-17 decks along the centreline
    are therefore resolved FIRST into bridge runs, the driving surface is lifted onto those decks,
    and only then is the geometry test for things above the surface run. Where a vendor did not
    label decks (older projects) the on-bridge case will still misfire; that is a known gap."""
    n = int(spine.length // step) + 1
    s = np.arange(n) * step
    p = np.array([spine.interpolate(v).coords[0] for v in s])
    ahead = np.array([spine.interpolate(min(v + 1.0, spine.length)).coords[0] for v in s])
    d = ahead - p
    d /= np.maximum(np.linalg.norm(d, axis=1, keepdims=True), 1e-9)
    normal = np.column_stack([-d[:, 1], d[:, 0]])  # left of travel

    def sample(arr, xy):
        r, c = rasterio.transform.rowcol(tr, xy[:, 0], xy[:, 1])
        r, c = np.clip(np.asarray(r), 0, arr.shape[0] - 1), np.clip(np.asarray(c), 0, arr.shape[1] - 1)
        return arr[r, c]

    ground_z = sample(dtm, p)
    surface_z = ground_z.copy()
    structures: list[dict] = []
    notnoise = (pts["cls"] != 7) & (pts["cls"] != 18)

    # --- 1. labelled decks (class 17) within 14 m of the centreline -----------------------------
    deck = (pts["cls"] == 17) & notnoise
    deck_min = np.full(n, np.nan)
    deck_max = np.full(n, np.nan)
    if deck.any():
        g = shapely.points(pts["x"][deck], pts["y"][deck])
        near = shapely.distance(g, spine) <= 14.0
        if near.any():
            bins = np.clip((shapely.line_locate_point(spine, g[near]) / step).astype(int), 0, n - 1)
            zd = pts["z"][deck][near]
            np.fmin.at(deck_min, bins, zd)
            np.fmax.at(deck_max, bins, zd)
    for i, j in _runs(~np.isnan(deck_min)):
        if (j - i + 1) * step < 4:
            continue
        a, b = max(0, i - 8), min(n - 1, j + 8)
        interp = np.interp(np.arange(i, j + 1), [a, b], [ground_z[a], ground_z[b]])
        on_deck = np.nanmean(np.abs(deck_min[i : j + 1] - interp))
        on_ground = np.nanmean(np.abs(ground_z[i : j + 1] - interp))
        above = float(np.nanmedian(deck_min[i : j + 1] - ground_z[i : j + 1]))
        if on_deck < on_ground and above >= 1.5:  # the deck continues our grade AND stands above the ground: we are ON it
            filled = deck_min[i : j + 1].copy()
            nan = np.isnan(filled)
            if nan.any():
                filled[nan] = np.interp(np.flatnonzero(nan), np.flatnonzero(~nan), filled[~nan])
            surface_z[i : j + 1] = filled
            structures.append({
                "kind": "bridge", "source": "class17",
                "s_start": round(float(s[i]), 1), "s_end": round(float(s[j]), 1), "length_m": round(float((j - i + 1) * step), 1),
                "deck_z_min": round(float(np.nanmin(deck_min[i : j + 1])), 2), "deck_z_max": round(float(np.nanmax(deck_max[i : j + 1])), 2),
                "clearance_m": None, "height_above_ground_m": round(float(np.nanmedian(deck_min[i : j + 1] - ground_z[i : j + 1])), 2),
            })
    # --- 1b. unlabelled decks: the road bridges a dip the DTM fell into ---------------------------
    # Where the vendor's class 17 is junk (Bowie, 2014) or absent, a culvert or a short bridge shows
    # up as the DTM dropping metres below the road's grade for a few dozen metres — the ground
    # under the deck — while the points near the centreline stay AT the grade: Bowie s≈2500–2515,
    # measured 2026-09-21: DTM 5 m down, 945 of 1000 points within ±0.5 m of the interpolated
    # grade (the deck), 12 ground points in the hole. Left alone, the road dives 5 m into a stream
    # bed (the car flew 101 m) and the deck itself is then flagged as a "gantry" 4.5 m over the
    # surface. So: a short run where ground_z sits ≥ DIP_MIN below the local grade AND the near
    # points cluster at the grade is a deck we are on; the surface is lifted onto those points.
    g_near = shapely.points(pts["x"][notnoise], pts["y"][notnoise])
    near_mask = shapely.distance(g_near, spine) <= 8.0
    near_bins = np.clip((shapely.line_locate_point(spine, g_near[near_mask]) / step).astype(int), 0, n - 1)
    near_z = pts["z"][notnoise][near_mask]
    order = np.argsort(near_bins, kind="stable")
    near_bins, near_z = near_bins[order], near_z[order]
    starts = np.searchsorted(near_bins, np.arange(n + 1))
    win = int(60 / step)
    local = np.array([np.median(ground_z[max(0, i - win) : i + win + 1]) for i in range(n)])
    dipped = (local - ground_z) >= DIP_MIN
    for st in structures:  # labelled bridges are already resolved
        dipped[int(st["s_start"] / step) : int(st["s_end"] / step) + 1] = False
    for i, j in _runs(dipped):
        length = (j - i + 1) * step
        if length < 4 or length > DIP_MAX_LEN:
            continue
        a, b = max(0, i - 3), min(n - 1, j + 3)
        grade = np.interp(np.arange(i, j + 1), [a, b], [ground_z[a], ground_z[b]])
        deck_med = np.full(j - i + 1, np.nan)
        deck_n = all_n = 0
        for k in range(i, j + 1):
            zs = near_z[starts[k] : starts[k + 1]]
            if len(zs) == 0:
                continue
            on = zs[np.abs(zs - grade[k - i]) <= 0.6]
            all_n += len(zs)
            deck_n += len(on)
            if len(on) >= 5:
                deck_med[k - i] = np.median(on)
        if all_n == 0 or deck_n / all_n < 0.6 or deck_n < 10 * (j - i + 1):
            continue
        nan = np.isnan(deck_med)
        if nan.all():
            continue
        if nan.any():
            deck_med[nan] = np.interp(np.flatnonzero(nan), np.flatnonzero(~nan), deck_med[~nan])
        # the deck has to actually stand above the hole, and a run touching either end of the spine
        # is the median window running out of road, not a bridge (Sideling s=0..8 and the last 8 m
        # came out as 0.07 m and -0.11 m "decks")
        if i == 0 or j == n - 1 or float(np.median(deck_med - ground_z[i : j + 1])) < DIP_MIN * 0.7:
            continue
        surface_z[i : j + 1] = deck_med
        structures.append({
            "kind": "bridge", "source": "geometry",
            "s_start": round(float(s[i]), 1), "s_end": round(float(s[j]), 1), "length_m": round(float(length), 1),
            "deck_z_min": round(float(np.min(deck_med)), 2), "deck_z_max": round(float(np.max(deck_med)), 2),
            "clearance_m": None, "height_above_ground_m": round(float(np.median(deck_med - ground_z[i : j + 1])), 2),
        })
    structures.sort(key=lambda st: st["s_start"])
    on_bridge = np.zeros(n, bool)
    for st in structures:
        on_bridge[int(st["s_start"] / step) : int(st["s_end"] / step) + 1] = True

    # --- 2. anything spanning the road 4.5-40 m above the DRIVING SURFACE ------------------------
    # A bridge over us covers the whole width in one along-track run; a tree overhangs from one
    # side; a sign gantry is a full-width run a metre or two long. Points within 10 m of the
    # centreline, binned 2 m along by 2 m across: a station is spanned when 6 of the 8 lateral
    # cells inside ±8 m hold a point. Class-agnostic, because the South Mountain arch deck is
    # "unassigned" in this dataset.
    #
    # Coverage alone is not enough on a two-lane road under trees: Race Track Road's canopy closes
    # over all ±8 m and produced 46 "overpasses" along 4.7 km. What separates a deck from a tree
    # tunnel is that a deck is a PLANE — its underside, read as the lowest point in each 2 m
    # lateral cell, agrees across the width. Measured (2026-09-21) on Clarksburg and Frederick:
    # real overpasses and gantries have a lateral std of the cell minima ≤ 0.28 m and a range
    # ≤ 0.74 m; Bowie's canopy runs have std 1.2–5.3 m and range 3–15 m, and the one Bowie run
    # that passes (s≈2350, std 0.28) sits exactly on an OSM bridleway tagged as crossing over.
    g_all = shapely.points(pts["x"][notnoise], pts["y"][notnoise])
    near_all = shapely.distance(g_all, spine) <= 10.0
    if near_all.any():
        bins_all = np.clip((shapely.line_locate_point(spine, g_all[near_all]) / step).astype(int), 0, n - 1)
        h_all = pts["z"][notnoise][near_all] - surface_z[bins_all]
        pxy = np.column_stack([pts["x"][notnoise][near_all], pts["y"][notnoise][near_all]])
        lat_off = np.einsum("ij,ij->i", pxy - p[bins_all], normal[bins_all])
        over = (h_all >= 4.5) & (h_all <= 40.0) & (np.abs(lat_off) <= 8.0)
        lat_bin = ((lat_off[over] + 8.0) / 2.0).astype(int).clip(0, 7)
        occ = np.zeros((n, 8), bool)
        occ[bins_all[over], lat_bin] = True
        cell_min = np.full((n, 8), np.nan)
        np.fmin.at(cell_min, (bins_all[over], lat_bin), h_all[over])
        with np.errstate(all="ignore"):
            under_std = np.nanstd(cell_min, axis=1)
            under_range = np.nanmax(cell_min, axis=1) - np.nanmin(cell_min, axis=1)
        planar = (under_std <= DECK_UNDERSIDE_STD) & (under_range <= DECK_UNDERSIDE_RANGE)
        spanned = (occ.sum(axis=1) >= 6) & planar & ~on_bridge
        hmin = np.nanmin(cell_min, axis=1)
        # On a country road under old growth a limb can pass the planarity test at one or two
        # stations, always right at the 4.5 m floor (Bacon Ridge: 7 "gantries", Chesterfield: 6, all
        # 2–6 m long, all 4.5–4.9 m). Sign gantries exist on motorways/trunks/primaries; on anything
        # smaller an overhead thing is only believed where OSM says a way crosses over within 25 m
        # (the Bowie bridleway at s≈2350 stays; the canopy goes).
        over_s = np.array(crossings_over_s or [], float)
        # `crossings_over_s is None` means the caller could not tell us what OSM crosses this road
        # (a branch profile); `[]` means it told us and NOTHING does. The difference matters below.
        known = crossings_over_s is not None
        for i, j in _runs(spanned):
            length = (j - i + 1) * step
            if length < 2.0:
                continue
            mid = (s[i] + s[j]) / 2
            crosses = bool(len(over_s)) and float(np.min(np.abs(over_s - mid))) <= 25.0
            if not major_road and not crosses:
                continue
            labelled = bool(np.any(~np.isnan(deck_min[i : j + 1])))
            # A SPAN IS ONLY AN OVERPASS WHERE SOMETHING ACTUALLY GOES OVER IT: an OSM way crossing
            # within 25 m, or class-17 deck points in the run. Naming a full-width overhead an
            # `overpass` off its LENGTH alone made the viewer raise a concrete road-carrying deck,
            # so the Capital Beltway grew a 31 m pad with a pier dropped in the median at s≈42386
            # that dead-ended on both sides — it was a sign gantry, and OSM maps nothing crossing
            # there (Rich, 2026-10-06). Without that evidence the record is still kept, as a
            # `gantry` (analysis only), never promoted to scenery by length. Where the caller gave
            # us no crossing list at all (a branch) we keep the old length naming: demoting every
            # real overpass on a road we never checked is worse than the bug.
            overpass = length >= 5 and ((crosses or labelled) if known else True)
            structures.append({
                "kind": "overpass" if overpass else "gantry", "source": "geometry+class17" if labelled else "geometry",
                "s_start": round(float(s[i]), 1), "s_end": round(float(s[j]), 1), "length_m": round(float(length), 1),
                "deck_z_min": round(float(np.nanmin(hmin[i : j + 1] + surface_z[i : j + 1])), 2), "deck_z_max": None,
                "clearance_m": round(float(np.nanmin(hmin[i : j + 1])), 2), "height_above_ground_m": None,
                "underside_std_m": round(float(np.nanmedian(under_std[i : j + 1])), 2),
            })
    structures.sort(key=lambda st: st["s_start"])

    # --- 3. ground and canopy beside the road, relative to the driving surface ------------------
    offsets = [8, 15, 25, 40, 60]
    ground, canopy = {}, {}
    for off in offsets:
        for side, sign in (("left", 1), ("right", -1)):
            q = p + normal * (sign * off)
            ground[f"{side}_{off}"] = (sample(dtm, q) - surface_z).round(2).tolist()
            canopy[f"{side}_{off}"] = sample(chm, q).round(1).tolist()

    return {"step_m": step, "s": s.round(1).tolist(), "road_z": surface_z.round(2).tolist(), "ground_z": ground_z.round(2).tolist(), "ground_rel": ground, "canopy": canopy, "structures": structures}
