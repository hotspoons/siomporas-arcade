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


def candidate_datasets(bbox_merc, cache: Path) -> list[tuple[str, dict]]:
    """Datasets whose declared bounds contain the corridor, best first. The bounds are the
    octree's CUBE, padded square around the real footprint, so containment is necessary but not
    sufficient — Clarksburg sits inside MD_Western_2's cube and outside its points. The caller
    walks the list until one actually yields points."""
    x0, y0, x1, y1 = bbox_merc
    out = []
    for ds in DATASETS:
        ept = _get_json(BASE.format(ds=ds) + "ept.json", cache / "ept" / ds / "ept.json")
        b = ept["bounds"]
        if b[0] <= x0 and b[1] <= y0 and b[3] >= x1 and b[4] >= y1:
            out.append((ds, ept))
    if not out:
        raise RuntimeError("no EPT dataset covers this corridor")
    return out


def nodes_for(ds: str, ept: dict, bbox_merc, cache: Path) -> list[str]:
    """Octree keys (D-X-Y-Z) with points whose XY footprint intersects the bbox, all depths."""
    b = ept["bounds"]
    size = b[3] - b[0]
    x0, y0, x1, y1 = bbox_merc
    hier: dict[str, int] = dict(_get_json(BASE.format(ds=ds) + "ept-hierarchy/0-0-0-0.json", cache / "ept" / ds / "h" / "0-0-0-0.json"))
    out: list[str] = []
    stack = ["0-0-0-0"]
    while stack:
        key = stack.pop()
        d, x, y, z = (int(v) for v in key.split("-"))
        ns = size / (2**d)
        nx0, ny0 = b[0] + x * ns, b[1] + y * ns
        if nx0 > x1 or nx0 + ns < x0 or ny0 > y1 or ny0 + ns < y0:
            continue
        count = hier.get(key)
        if count is None:
            continue
        if count == -1:  # subtree lives in its own hierarchy file
            hier.update(_get_json(BASE.format(ds=ds) + f"ept-hierarchy/{key}.json", cache / "ept" / ds / "h" / f"{key}.json"))
            count = hier.get(key, 0)
        if count > 0:
            out.append(key)
        for dx in (0, 1):
            for dy in (0, 1):
                for dz in (0, 1):
                    child = f"{d + 1}-{2 * x + dx}-{2 * y + dy}-{2 * z + dz}"
                    if child in hier:
                        stack.append(child)
    return out


def _read_node(ds: str, key: str, bbox_merc, cache: Path) -> dict | None:
    path = cache / "ept" / ds / "data" / f"{key}.laz"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        r = session.get(BASE.format(ds=ds) + f"ept-data/{key}.laz", timeout=300)
        r.raise_for_status()
        tmp = path.with_suffix(".part")
        tmp.write_bytes(r.content)
        tmp.replace(path)
    las = laspy.read(path)
    x, y = np.asarray(las.x), np.asarray(las.y)
    x0, y0, x1, y1 = bbox_merc
    m = (x >= x0) & (x <= x1) & (y >= y0) & (y <= y1)
    if not m.any():
        return None
    return {
        "x": x[m], "y": y[m], "z": np.asarray(las.z)[m],
        "cls": np.asarray(las.classification)[m].astype(np.uint8),
        "rn": np.asarray(las.return_number)[m].astype(np.uint8),
        "nr": np.asarray(las.number_of_returns)[m].astype(np.uint8),
        "i": np.asarray(las.intensity)[m].astype(np.uint16),
    }


def fetch_points(frame: Frame, bbox: tuple[float, float, float, float], cache: Path, jobs: int = 8, clip: Polygon | None = None) -> tuple[dict, dict]:
    bbox_merc = frame.bbox_merc(*bbox)
    parts: list[dict] = []
    ds = ""
    keys: list[str] = []
    for ds, ept in candidate_datasets(bbox_merc, cache):
        keys = nodes_for(ds, ept, bbox_merc, cache)
        print(f"  lidar   {ds}: {len(keys)} octree nodes", flush=True)
        if not keys:
            continue
        with ThreadPoolExecutor(jobs) as ex:
            parts = [p for p in ex.map(lambda k: _read_node(ds, k, bbox_merc, cache), keys) if p]
        if parts:
            break
        print(f"  lidar   {ds}: inside its cube but no points here; trying the next dataset", flush=True)
    if not parts:
        # Not staged as EPT (yet): MD_Central_Processing_D24 was published 2026-03 and covers
        # Montgomery / Prince George's, where the Entwine bucket has nothing newer than 2014. Fall
        # back to the delivery LAZ tiles through the TNM API — heavier, but the same points.
        return _fetch_tnm_laz(frame, bbox, cache, jobs, clip)
    pts = {k: np.concatenate([p[k] for p in parts]) for k in parts[0]}
    ux, uy = frame.from_merc(pts["x"], pts["y"])
    pts["x"], pts["y"] = np.asarray(ux), np.asarray(uy)
    xmin, ymin, xmax, ymax = bbox
    m = (pts["x"] >= xmin) & (pts["x"] < xmax) & (pts["y"] >= ymin) & (pts["y"] < ymax)
    pts = {k: v[m] for k, v in pts.items()}
    print(f"  lidar   {len(pts['x']):,} points in bbox", flush=True)
    return pts, {"dataset": ds, "nodes": len(keys), "points": int(len(pts["x"]))}


TNM = "https://tnmaccess.nationalmap.gov/api/v1/products"


def _read_laz_tile(path: Path, frame: Frame, bbox, clip: Polygon | None = None) -> dict | None:
    """One delivery tile: read, re-project from ITS declared CRS to the site frame, clip."""
    from pyproj import Transformer

    las = laspy.read(path)
    crs = las.header.parse_crs()
    if crs is None:
        raise RuntimeError(f"{path.name}: no CRS in the LAS header")
    tr = Transformer.from_crs(crs, frame.crs, always_xy=True)
    x, y = tr.transform(np.asarray(las.x), np.asarray(las.y))
    x, y = np.asarray(x), np.asarray(y)
    xmin, ymin, xmax, ymax = bbox
    m = (x >= xmin) & (x < xmax) & (y >= ymin) & (y < ymax)
    if clip is not None and m.any():
        # the corridor is a strip on a diagonal; its bbox is mostly air. Clip per tile so the
        # concatenated cloud is the strip, not the box (memory: 300 M points vs 40 M on Clarksburg)
        idx = np.flatnonzero(m)
        inside = shapely.contains_xy(clip, x[idx], y[idx])
        m[idx[~inside]] = False
    if not m.any():
        return None
    z = np.asarray(las.z)[m]
    # a compound CRS in US survey feet puts Z in feet too; check_units() confirms against the DEM
    try:
        unit = crs.axis_info[0].unit_name if crs.axis_info else "metre"
    except Exception:
        unit = "metre"
    if "foot" in unit or "feet" in unit:
        z = z * 0.3048006096
    return {
        "x": x[m], "y": y[m], "z": z,
        "cls": np.asarray(las.classification)[m].astype(np.uint8),
        "rn": np.asarray(las.return_number)[m].astype(np.uint8),
        "nr": np.asarray(las.number_of_returns)[m].astype(np.uint8),
        "i": np.asarray(las.intensity)[m].astype(np.uint16),
    }


def _fetch_tnm_laz(frame: Frame, bbox, cache: Path, jobs: int, clip: Polygon | None = None) -> tuple[dict, dict]:
    from .dem import download

    w, s, e, n = frame.bbox_wgs(*bbox)
    r = session.get(TNM, params={"datasets": "Lidar Point Cloud (LPC)", "bbox": f"{w},{s},{e},{n}", "outputFormat": "JSON", "max": 400}, timeout=120)
    r.raise_for_status()
    items = r.json().get("items", [])
    if not items:
        raise RuntimeError("no lidar at all for this corridor (EPT or TNM)")
    # ONE project (mixing vintages inside a corridor makes seams no game wants) — but the one that
    # COVERS the corridor, then the newest. "Newest only" picked MD_4County_D24 for Bonnie Branch
    # because a single edge tile of it touched the bbox: 0.4 % of the corridor had lidar, the DTM
    # was nearest-filled from that sliver, and the road ran 60 m below the real ground in a canyon
    # of its own making (Rich, terrain-and-data agent, 2026-09-21).
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
    total = sum(i.get("sizeInBytes", 0) for i in tiles) / 2**20
    print(f"  lidar   TNM {proj}: {len(tiles)} LAZ tiles, {total:.0f} MiB", flush=True)
    paths = []
    with ThreadPoolExecutor(min(jobs, 4)) as ex:
        paths = list(ex.map(lambda it: download(it["downloadURL"], cache / "laz" / proj / it["downloadURL"].rsplit("/", 1)[1], it.get("sizeInBytes")), tiles))
    parts = []
    for i, pth in enumerate(paths, 1):
        part = _read_laz_tile(pth, frame, bbox, clip)
        if part:
            parts.append(part)
        print(f"  lidar   tile {i}/{len(paths)} {pth.name}: {len(part['x']) if part else 0:,} pts in bbox", flush=True)
    if not parts:
        raise RuntimeError("TNM tiles intersect the bbox but hold no points in it")
    pts = {k: np.concatenate([p[k] for p in parts]) for k in parts[0]}
    print(f"  lidar   {len(pts['x']):,} points in bbox", flush=True)
    return pts, {"dataset": f"TNM:{proj}", "tiles": len(paths), "points": int(len(pts["x"]))}


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
        for i, j in _runs(spanned):
            length = (j - i + 1) * step
            if length < 2.0:
                continue
            if not major_road:
                mid = (s[i] + s[j]) / 2
                if not (len(over_s) and np.min(np.abs(over_s - mid)) <= 25.0):
                    continue
            labelled = bool(np.any(~np.isnan(deck_min[i : j + 1])))
            structures.append({
                "kind": "overpass" if length >= 5 else "gantry", "source": "geometry+class17" if labelled else "geometry",
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
