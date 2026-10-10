"""Where a bake's point cloud comes from, and the batches it arrives in.

Rich, 2026-09-30, of a crofton-triangle bake that had been silent for half an hour: "why do we
need 7 GB of lidar for a few square miles? ... Something seems buggy here." It was not a bug so
much as the only source it knew. Crofton's newest survey (USGS MD_Central_Processing_D24, 2024) is
published only as whole LAZ tiles on rockyweb.usgs.gov, which serves ~80 KB/s per connection, and a
plain LAZ tile cannot be read in part: 42 tiles, 7.6 GB, six hours at four connections.

TWO KINDS OF SOURCE, fastest first:

  EPT   Entwine Point Tiles: an octree of small LAZ nodes on S3, so a bake reads only the nodes over
        its streets and only down to the density it needs. USGS stages 2,279 3DEP projects on
        `usgs-lidar-public` and NOAA Digital Coast ~1000 more on `noaa-nos-coastal-lidar-pds`, both
        DISCOVERED from their indexes, not listed: with only a hand-kept list of five Maryland sets,
        Pikes Peak (USGS CO_Eastern_ElPaso_2018) fell to the six-hour tiles and Mount Desert Island
        took NOAA's 2010 survey over USGS's 2021 one. lidar.DATASETS is now only the fallback for a
        bake that cannot reach the USGS index. Crofton: NOAA 10311 (2020 Anne Arundel, properly classified,
        43 MiB/s measured) covers 88 %; NOAA 9235 (2018 Prince George's) fills the western edge.
  TNM   the USGS delivery tiles, whole, through tnmaccess — the fallback when no EPT covers enough.
        Newer, sometimes (2024 vs 2020 at Crofton), and slow: a person can force it with
        CORRIDOR_LIDAR_SOURCE=tnm when the vintage matters more than the hours.

DENSITY, NOT DEPTH. An EPT's full depth over Crofton is 21 points/m², 1.3 billion points, 11 GiB.
The rasters are 1 m and the bridge-deck test was calibrated at ~8 points/m², so the walk stops at
the shallowest depth whose cumulative density reaches CORRIDOR_LIDAR_DENSITY (default 8): depth 9,
~4 GiB, about two minutes.

GAPS ARE FILLED, not averaged. The best source is used wherever it has points; the next source's
points are kept only in cells (GAP_CELL_M) the best one left empty. Two vintages never overlap in
one cell, so there is no seam of doubled ground — only a boundary between two surveys, which the
manifest names.
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterator

import laspy
import numpy as np
import requests
import shapely
from pyproj import CRS, Transformer
from shapely.geometry import Polygon, box, shape
from shapely.geometry.base import BaseGeometry

from . import write_atomic
from .geo import Frame

NOAA_INDEX = "https://noaa-nos-coastal-lidar-pds.s3.us-east-1.amazonaws.com/entwine/stac/noaa_item_collection.json"
# USGS's staged 3DEP as EPT: every set's real footprint, point count and ept.json, maintained by
# Hobu (who stages the bucket for USGS). The bucket itself has no index (boundaries/ answers 404).
USGS_INDEX = "https://raw.githubusercontent.com/hobuinc/usgs-lidar/master/boundaries/resources.geojson"
# NOAA stages each dataset under several vertical datums; these two are NAVD88, which is what the
# 3DEP DEM every bake also fetches is in. mllw / msl / igld85 / egm08 are right for their coasts and
# lakes and wrong beside a NAVD88 DEM by up to a metre, so they are not candidates here.
NAVD88_PATHS = ("/entwine/geoid18/", "/entwine/geoid12b/")
INDEX_MAX_AGE_S = 30 * 86400
GAP_CELL_M = 25.0
ENOUGH_COVERAGE = 0.98   # stop adding sources once this share of the streets' cells has points
MIN_EPT_COVERAGE = 0.5   # below this the EPT candidates together are worse than the TNM tiles
MAX_SOURCES = 3
BATCH_POINTS = 5_000_000


def density_target() -> float:
    return float(os.environ.get("CORRIDOR_LIDAR_DENSITY", "8"))


def source_choice() -> str:
    v = os.environ.get("CORRIDOR_LIDAR_SOURCE", "auto").strip().lower()
    return v if v in ("auto", "ept", "tnm") else "auto"


@dataclass
class EptSource:
    name: str                       # "USGS:MD_Western_2_D21", "NOAA:10311"
    base: str                       # URL prefix of ept.json, ending in "/"
    year: int | None = None
    footprint: BaseGeometry | None = None  # WGS84; None when only the octree cube is known
    points: int | None = None
    ept: dict | None = field(default=None, repr=False)
    # the share of the area its footprint covers; the density target is met over THAT, not the
    # whole bbox (a fill source over 12 % of it went five times too deep chasing the bbox's average)
    share: float = 1.0

    @property
    def slug(self) -> str:
        """Its folder under the bake cache. USGS keeps the bare dataset name it always had, so a
        rebake of an existing site finds its nodes; NOAA's are namespaced (ids are just numbers)."""
        kind, ident = self.name.split(":", 1)
        return ident if kind == "USGS" else f"{kind.lower()}-{ident}"

    def label(self) -> str:
        return f"{self.name}" + (f" ({self.year})" if self.year else "")


# ---- discovery ------------------------------------------------------------------------------


def slim_noaa_index(collection: dict) -> list[dict]:
    """NOAA's STAC item collection (188 MB, full-resolution footprints) down to what ranking needs.

    Footprints are simplified to ~50 m: enough to tell a county line from the next county, and it
    turns the index into a few MB that every later bake reads instantly.
    """
    out = []
    for f in collection.get("features", []):
        href = ((f.get("assets") or {}).get("ept") or {}).get("href") or ""
        if not href.endswith("ept.json") or not any(p in href for p in NAVD88_PATHS):
            continue
        p = f.get("properties") or {}
        if p.get("pc:type") not in (None, "lidar"):
            continue
        try:
            geom = shape(f["geometry"]).simplify(0.0005, preserve_topology=True)
        except Exception:
            continue
        when = p.get("start_datetime") or p.get("datetime") or p.get("end_datetime") or ""
        ident = str(f.get("id", "")).rsplit("_", 1)[-1] or href.rstrip("/").rsplit("/", 2)[-2]
        out.append({
            "id": ident,
            "base": href[: -len("ept.json")],
            "year": int(when[:4]) if when[:4].isdigit() else None,
            "points": p.get("pc:count"),
            "footprint": shapely.to_wkt(geom, rounding_precision=5),
        })
    return out


def survey_year(name: str) -> int | None:
    """The year in a USGS project name: a funding code (`D21`, `B23`: fiscal 2021, 2023) or a plain
    year (`CO_Eastern_ElPaso_2018`; the first one, so `..._2014_LAS_2015` is the 2014 flight).
    None for the four statewide mosaics that carry no year, which then rank as oldest."""
    for t in name.split("_"):
        if re.fullmatch(r"[A-Z]\d\d", t):
            return 2000 + int(t[1:])
    m = re.search(r"(?<!\d)(19|20)\d\d(?!\d)", name)
    return int(m.group(0)) if m else None


def slim_usgs_index(collection: dict) -> list[dict]:
    """USGS's EPT boundaries (8.7 MB) down to what ranking needs; sets whose classes are junk bins
    (lidar.PREFER_TNM_OVER) are left out, as the hand-kept path always skipped them."""
    from .lidar import PREFER_TNM_OVER

    out = []
    for f in collection.get("features", []):
        p = f.get("properties") or {}
        name, url = p.get("name"), p.get("url") or ""
        if not name or not url.endswith("ept.json") or name in PREFER_TNM_OVER:
            continue
        try:
            geom = shape(f["geometry"]).simplify(0.0005, preserve_topology=True)
        except Exception:
            continue
        out.append({"id": name, "base": url[: -len("ept.json")], "year": survey_year(name), "points": p.get("count"), "footprint": shapely.to_wkt(geom, rounding_precision=5)})
    return out


def _cached_index(cache: Path, name: str, url: str, slim_fn, what: str) -> list[dict] | None:
    """An index, slimmed and kept in the bake cache for a month. A stale copy beats none; None
    means there is no copy at all and the caller decides what that costs."""
    slim = cache / "ept" / f"{name}-index.json"
    if slim.exists() and time.time() - slim.stat().st_mtime < INDEX_MAX_AGE_S:
        return json.loads(slim.read_text())
    from .dem import download

    big = cache / "ept" / f"{name}-index.raw.json"
    try:
        print(f"  lidar   refreshing {what} (once a month)", flush=True)
        big.unlink(missing_ok=True)
        download(url, big)
        entries = slim_fn(json.loads(big.read_text()))
        if not entries:
            raise RuntimeError("it listed no usable datasets")
        slim.parent.mkdir(parents=True, exist_ok=True)
        write_atomic(slim, json.dumps(entries))
    except Exception as exc:
        print(f"  lidar   {what} unavailable ({exc}); {'using the old copy' if slim.exists() else 'none'}", flush=True)
        if not slim.exists():
            return None
    finally:
        big.unlink(missing_ok=True)
    return json.loads(slim.read_text())


def _from_entries(kind: str, entries: list[dict]) -> list[EptSource]:
    return [EptSource(name=f"{kind}:{e['id']}", base=e["base"], year=e.get("year"), points=e.get("points"), footprint=shapely.from_wkt(e["footprint"])) for e in entries]


def noaa_sources(cache: Path) -> list[EptSource]:
    """NOAA's EPT datasets, from a slim copy of its STAC index (188 MB raw) in the bake cache."""
    entries = _cached_index(cache, "noaa", NOAA_INDEX, slim_noaa_index, "NOAA's EPT index (188 MB)")
    return _from_entries("NOAA", entries) if entries else []


def usgs_sources(cache: Path) -> list[EptSource]:
    """USGS's EPT datasets from its boundaries index; the hand-kept list only when that is out of reach."""
    entries = _cached_index(cache, "usgs", USGS_INDEX, slim_usgs_index, "USGS's EPT index (8.7 MB)")
    if entries:
        return _from_entries("USGS", entries)
    from .lidar import BASE, DATASETS, PREFER_TNM_OVER

    return [EptSource(name=f"USGS:{ds}", base=BASE.format(ds=ds), year=survey_year(ds)) for ds in DATASETS if ds not in PREFER_TNM_OVER]


def rank_by_footprint(sources: list[EptSource], area_wgs: BaseGeometry, min_share: float = 0.01) -> list[tuple[EptSource, float]]:
    """Candidates with a footprint over the area: the most of it covered first, then the newest."""
    out = []
    a = max(area_wgs.area, 1e-15)
    for s in sources:
        if s.footprint is None or not s.footprint.intersects(area_wgs):
            continue
        share = s.footprint.intersection(area_wgs).area / a
        if share >= min_share:
            out.append((s, share))
    out.sort(key=lambda t: (round(t[1], 2), t[0].year or 0), reverse=True)
    return out


def plan_cover(ranked: list[tuple[EptSource, float]], area_wgs: BaseGeometry, limit: int = MAX_SOURCES + 1) -> list[tuple[EptSource, float]]:
    """The order to read NOAA sources in: a primary, then whatever covers what is still bare.

    NOT BY COVERAGE ALONE. Over Crofton that picked NOAA 8494 — a 2011 survey whose footprint
    covers 96 % and whose points are ground and "unassigned", no trees, no roofs — over 10311, the
    2020 Anne Arundel survey at 88 % with every class the rasters use (measured 2026-09-30). The gap
    fill exists so that coverage need not win: the PRIMARY is the newest survey over at least half
    the streets, and each next one is whichever covers the most of what is still bare, newest on a
    tie — the 2018 Prince George's survey for Crofton's western edge, not a 2017 re-fly of the same
    county the primary already had.

    Returns (source, share of the area it newly covers).
    """
    a = max(area_wgs.area, 1e-15)
    pool = [(s, sh) for s, sh in ranked if s.footprint is not None]
    out: list[tuple[EptSource, float]] = []
    bare = area_wgs
    while pool and len(out) < limit and not bare.is_empty:
        if not out:
            # the date only counts among surveys over half; under that, the widest is the primary
            best = max(pool, key=lambda t: (t[1] >= 0.5, (t[0].year or 0) if t[1] >= 0.5 else 0, t[1]))
            gain = best[1]
        else:
            gains = [(t, t[0].footprint.intersection(bare).area / a) for t in pool]
            (best, gain) = max(gains, key=lambda g: (round(g[1] / 0.05), g[0][0].year or 0, g[1]))
            if gain < 0.01:
                break
        out.append((best[0], gain))
        pool.remove(best)
        bare = bare.difference(best[0].footprint)
    return out


def union_share(ranked: list[tuple[EptSource, float]], area_wgs: BaseGeometry) -> float:
    if not ranked:
        return 0.0
    u = shapely.union_all([s.footprint for s, _ in ranked if s.footprint is not None])
    return float(u.intersection(area_wgs).area / max(area_wgs.area, 1e-15))


def area_in_wgs(frame: Frame, bbox, clip: Polygon | None) -> BaseGeometry:
    """The streets' outline (or the bbox) in WGS84, for comparing with footprints."""
    geom = clip if clip is not None else box(*bbox)
    geom = geom.simplify(10.0)
    return shapely.transform(geom, lambda xy: np.column_stack(frame.to_wgs(xy[:, 0], xy[:, 1])))


# ---- one EPT: which nodes, how deep --------------------------------------------------------


def ept_crs(ept: dict) -> CRS:
    srs = ept.get("srs") or {}
    if srs.get("authority") and srs.get("horizontal"):
        return CRS.from_user_input(f"{srs['authority']}:{srs['horizontal']}")
    if srs.get("wkt"):
        return CRS.from_wkt(srs["wkt"])
    return CRS.from_epsg(3857)  # USGS's EPT, which declares nothing, is Web Mercator


def z_factor(ept: dict) -> float:
    """Metres per Z unit from the declared vertical CRS; 1.0 when undeclared (check_units decides)."""
    v = (ept.get("srs") or {}).get("vertical")
    if not v:
        return 1.0
    try:
        unit = CRS.from_epsg(int(v)).axis_info[0].unit_name.lower()
    except Exception:
        return 1.0
    return 0.3048006096 if "us survey foot" in unit else 0.3048 if "foot" in unit or "feet" in unit else 1.0


def bbox_in(frame: Frame, bbox, crs: CRS) -> tuple[float, float, float, float]:
    """The site bbox in another CRS, edges sampled so a curved edge is still contained."""
    xmin, ymin, xmax, ymax = bbox
    xs, ys = np.linspace(xmin, xmax, 9), np.linspace(ymin, ymax, 9)
    px = np.concatenate([xs, xs, np.full(9, xmin), np.full(9, xmax)])
    py = np.concatenate([np.full(9, ymin), np.full(9, ymax), ys, ys])
    tx, ty = Transformer.from_crs(frame.crs, crs, always_xy=True).transform(px, py)
    return float(np.min(tx)), float(np.min(ty)), float(np.max(tx)), float(np.max(ty))


def area_in(frame: Frame, bbox, clip: BaseGeometry | None, crs: CRS) -> tuple[BaseGeometry, float]:
    """The area a source is read over — the streets' outline, or the bbox without one — in the
    EPT's CRS, and its true area in m² (measured in the site frame, before reprojection)."""
    geom = clip if clip is not None else box(*bbox)
    geom = geom.intersection(box(*bbox))
    tr = Transformer.from_crs(frame.crs, crs, always_xy=True)
    # densified first: a 10 km straight edge reprojected by its two ends is not the same curve
    return shapely.transform(shapely.segmentize(geom, 250.0), lambda xy: np.column_stack(tr.transform(xy[:, 0], xy[:, 1]))), float(geom.area)


def node_box(ept: dict, key: str) -> tuple[float, float, float, float]:
    b = ept["bounds"]
    d, x, y, _ = (int(v) for v in key.split("-"))
    s = (b[3] - b[0]) / (2**d)
    return b[0] + x * s, b[1] + y * s, b[0] + (x + 1) * s, b[1] + (y + 1) * s


def choose_depth(counts: list[tuple[str, int, float]], area_m2: float, target: float) -> tuple[int, float]:
    """The shallowest depth whose nodes, cumulatively, reach `target` points per m² over the area.

    `counts` is (key, points, share of the node's footprint inside the area). EPT is additive — a
    deeper node adds points to the shallower ones rather than replacing them — so density is the
    running sum. When even the full depth falls short, the full depth is what there is.
    """
    per: dict[int, float] = {}
    for key, n, share in counts:
        d = int(key.split("-", 1)[0])
        per[d] = per.get(d, 0.0) + n * share
    cum = 0.0
    for d in sorted(per):
        cum += per[d]
        if cum / max(area_m2, 1.0) >= target:
            return d, cum / area_m2
    return (max(per) if per else 0), cum / max(area_m2, 1.0)


class AreaShare:
    """How much of an EPT node's box lies inside the area being read (the streets' outline, in the
    EPT's CRS): a mask of the area on a grid, summed once, so a node's share is four lookups.

    Exact areas would be a polygon intersection per node — 40,000 of them against a 7,700-vertex
    outline for one dc-metro shard. The grid is ~4 M cells over the bbox; a node smaller than a few
    cells gets a coarse share, which is what a density estimate needs.
    """

    def __init__(self, area_ept: BaseGeometry, bbox_ept, cells: int = 4_000_000):
        from rasterio.features import rasterize
        from rasterio.transform import from_origin

        self.area = area_ept
        shapely.prepare(self.area)
        x0, y0, x1, y1 = bbox_ept
        self.x0, self.y1 = x0, y1
        self.c = max(1.0, float(np.sqrt(max((x1 - x0) * (y1 - y0), 1.0) / cells)))
        w, h = max(1, int(np.ceil((x1 - x0) / self.c))), max(1, int(np.ceil((y1 - y0) / self.c)))
        m = rasterize([(area_ept, 1)], out_shape=(h, w), transform=from_origin(x0, y1, self.c, self.c), fill=0, all_touched=False, dtype=np.uint8)
        self.sat = np.zeros((h + 1, w + 1), np.int64)
        self.sat[1:, 1:] = m.astype(np.int64).cumsum(0).cumsum(1)
        self.h, self.w = h, w

    def touches(self, nb) -> bool:
        return bool(self.area.intersects(box(*nb)))

    def share(self, nb) -> float:
        nx0, ny0, nx1, ny1 = nb
        c0 = int(np.clip(np.floor((nx0 - self.x0) / self.c), 0, self.w))
        c1 = int(np.clip(np.ceil((nx1 - self.x0) / self.c), 0, self.w))
        r0 = int(np.clip(np.floor((self.y1 - ny1) / self.c), 0, self.h))
        r1 = int(np.clip(np.ceil((self.y1 - ny0) / self.c), 0, self.h))
        cells = ((nx1 - nx0) / self.c) * ((ny1 - ny0) / self.c)
        if r1 <= r0 or c1 <= c0 or cells <= 0:
            return 0.0
        inside = self.sat[r1, c1] - self.sat[r0, c1] - self.sat[r1, c0] + self.sat[r0, c0]
        return float(min(1.0, inside / cells))


def nodes_over(src: EptSource, bbox_ept, get_json, target: float, area_ept: BaseGeometry | None = None, area_m2: float | None = None) -> tuple[list[str], int, float]:
    """Nodes over the area to read, down to the depth that reaches the density target there.

    THE AREA IS THE STREETS, NOT THEIR BBOX (2026-10-10). dc-metro-take-2 shard 5's streets are
    97.5 km² inside a 1,014 km² bbox. Walking the bbox fetched 222,212 nodes and decoded 10.5 B
    points of which 1.86 B landed on the streets, and the density that chose the depth was points
    over (bbox x `src.share`) — but `share` is the source's coverage of the STREETS, so where the
    survey covered a quarter of the bbox and three quarters of the streets, the estimate came out
    a third of the truth and the walk went two levels too deep: depth 12, 25.6 pts/m² on the
    streets for a target of 8, where depth 10 already gave 10.7.

    So with `area_ept` (the streets' outline in the EPT's CRS) a node whose box does not touch it
    is not walked, its subtree's hierarchy is not fetched and it is not read; a node's points count
    by the share of its box inside the outline; and the density is over `area_m2` — the outline's
    TRUE area, measured in the site frame, times the source's coverage of that same outline. (The
    old denominator was in the EPT's own units, which for USGS's Web Mercator is 1.6 x the true m²
    at the latitude of Washington.) Without `area_ept` the bbox is the area, as before.
    """
    ept = src.ept
    x0, y0, x1, y1 = bbox_ept
    grid = AreaShare(area_ept, bbox_ept) if area_ept is not None and not area_ept.is_empty else None
    hier: dict[str, int] = dict(get_json("ept-hierarchy/0-0-0-0.json"))
    found: list[tuple[str, int, float]] = []
    stack = ["0-0-0-0"]
    while stack:
        key = stack.pop()
        nb = node_box(ept, key)
        nx0, ny0, nx1, ny1 = nb
        if nx0 > x1 or nx1 < x0 or ny0 > y1 or ny1 < y0:
            continue
        if grid is not None and not grid.touches(nb):
            continue  # and neither does anything under it: no hierarchy file, no node read
        count = hier.get(key)
        if count is None:
            continue
        if count == -1:  # the subtree's counts live in their own file
            hier.update(get_json(f"ept-hierarchy/{key}.json"))
            count = hier.get(key, 0)
        if count > 0:
            if grid is not None:
                share = grid.share(nb)
            else:
                share = max(0.0, min(x1, nx1) - max(x0, nx0)) * max(0.0, min(y1, ny1) - max(y0, ny0)) / ((nx1 - nx0) * (ny1 - ny0))
            found.append((key, count, share))
        d, x, y, z = (int(v) for v in key.split("-"))
        for dx in (0, 1):
            for dy in (0, 1):
                for dz in (0, 1):
                    child = f"{d + 1}-{2 * x + dx}-{2 * y + dy}-{2 * z + dz}"
                    if child in hier:
                        stack.append(child)
    base = area_m2 if area_m2 is not None else (x1 - x0) * (y1 - y0)
    depth, density = choose_depth(found, base * max(src.share, 0.05), target)
    return [k for k, _, _ in found if int(k.split("-", 1)[0]) <= depth], depth, density


# ---- streaming points ------------------------------------------------------------------------


class Occupancy:
    """Which GAP_CELL_M cells of the streets' outline have points, across every source so far."""

    def __init__(self, bbox, clip: Polygon | None, cell: float = GAP_CELL_M):
        from rasterio.features import rasterize
        from rasterio.transform import from_origin

        self.x0, self.y0, x1, self.y1 = bbox[0], bbox[1], bbox[2], bbox[3]
        self.cell = cell
        self.w = max(1, int(np.ceil((x1 - self.x0) / cell)))
        self.h = max(1, int(np.ceil((self.y1 - self.y0) / cell)))
        self.hit = np.zeros((self.h, self.w), bool)
        if clip is None:
            self.want = np.ones((self.h, self.w), bool)
        else:
            self.want = rasterize([(clip, 1)], out_shape=(self.h, self.w), transform=from_origin(self.x0, self.y1, cell, cell), fill=0, all_touched=True, dtype=np.uint8).astype(bool)

    def cells(self, x, y):
        c = np.clip(((x - self.x0) / self.cell).astype(np.int64), 0, self.w - 1)
        r = np.clip(((self.y1 - y) / self.cell).astype(np.int64), 0, self.h - 1)
        return r, c

    def empty(self, x, y) -> np.ndarray:
        r, c = self.cells(x, y)
        return ~self.hit[r, c]

    def mark(self, x, y, into: np.ndarray | None = None) -> None:
        r, c = self.cells(x, y)
        (self.hit if into is None else into)[r, c] = True

    def pending(self) -> np.ndarray:
        """A grid for one source's cells, merged when that source is finished (see stream_ept)."""
        return np.zeros_like(self.hit)

    def merge(self, grid: np.ndarray) -> None:
        self.hit |= grid

    def share(self) -> float:
        return float((self.hit & self.want).sum() / max(1, self.want.sum()))


class NodeReader:
    """Reads one EPT node into the site frame, clipped to the streets — from ANY thread of the pool.

    WHY EVERY THREAD HAS ITS OWN CLIP. dc-metro-take-2 shard 5 (2026-10-10, 17:39 UTC) walked
    222,212 Virginia nodes, started the sixteen readers, and two seconds later glibc aborted the
    process: `malloc(): unaligned tcache chunk detected`, exit 133, no Python traceback. The readers
    shared ONE shapely polygon, the streets' outline, and each called `shapely.contains_xy` on it.
    That call prepares the geometry in place and then releases the GIL, and GEOS builds a prepared
    polygon's point locator, and that locator's STR tree, LAZILY on first use and with no lock
    (`PreparedPolygon::getPointLocator`, then `IndexedPointInAreaLocator::locate` -> the tree's
    `build()`). Two threads in their first clip test together both build it; one frees what the
    other is still filling. Reproduced off-cluster on the baker image's own Python, glibc and wheels
    (shapely 2.2.0 / GEOS 3.14.1, and 2.1.2 / 3.13.1 aborts the same way): sixteen threads released
    together onto shard 5's own streets polygon abort with `double free or corruption` in the first
    round, every run, and gdb puts the `free()` inside
    `TemplateSTRtreeImpl<IndexedPointInAreaLocator::SegmentView, IntervalTraits>::build()` under
    `GEOSPreparedContains_r`. Earlier bakes ran this same code and finished because the window is
    only the FIRST clip test of each source's pool: a race, not a data problem.

    So nothing native crosses threads here: each worker thread builds its own clip (from WKB, which
    is the same doubles bit for bit) and prepares it, its own pyproj Transformer, and its own HTTP
    session, on its first node. pyproj's Transformer is already per-thread inside, and a Session is
    pure Python; building them per thread costs a few milliseconds per source and makes the rule
    one sentence instead of three library-specific exceptions.
    """

    def __init__(self, src: EptSource, cache: Path, crs_from, crs_to, zf: float, bbox, clip: BaseGeometry | None):
        self.src, self.cache, self.zf, self.bbox = src, cache, zf, tuple(bbox)
        self.crs_from, self.crs_to = crs_from, crs_to
        # bytes, not a geometry: the only form of the clip the threads ever see
        self.clip_wkb = None if clip is None else shapely.to_wkb(clip)
        self._local = threading.local()

    def kit(self) -> "_Kit":
        """This thread's clip, transformer and session, built the first time it asks."""
        k = getattr(self._local, "kit", None)
        if k is None:
            from .lidar import session as shared

            clip = None
            if self.clip_wkb is not None:
                clip = shapely.from_wkb(self.clip_wkb)
                shapely.prepare(clip)
            sess = requests.Session()
            sess.headers.update(shared.headers)
            k = self._local.kit = _Kit(clip, Transformer.from_crs(self.crs_from, self.crs_to, always_xy=True), sess)
        return k

    def fetch(self, key: str, session: requests.Session) -> Path:
        path = self.cache / "ept" / self.src.slug / "data" / f"{key}.laz"
        if path.exists():
            return path
        path.parent.mkdir(parents=True, exist_ok=True)
        for attempt in range(3):
            try:
                r = session.get(self.src.base + f"ept-data/{key}.laz", timeout=300)
                r.raise_for_status()
                break
            except Exception:
                if attempt == 2:
                    raise
                time.sleep(2 * (attempt + 1))
        tmp = path.with_name(f"{path.name}.{os.getpid()}.{uuid.uuid4().hex[:8]}.part")
        try:
            tmp.write_bytes(r.content)
            tmp.replace(path)
        finally:
            tmp.unlink(missing_ok=True)
        return path

    def __call__(self, key: str) -> dict | None:
        k = self.kit()
        las = laspy.read(self.fetch(key, k.session))
        x, y = k.tr.transform(np.asarray(las.x), np.asarray(las.y))
        x, y = np.asarray(x), np.asarray(y)
        xmin, ymin, xmax, ymax = self.bbox
        m = (x >= xmin) & (x < xmax) & (y >= ymin) & (y < ymax)
        if k.clip is not None and m.any():
            idx = np.flatnonzero(m)
            m[idx[~shapely.contains_xy(k.clip, x[idx], y[idx])]] = False
        if not m.any():
            return None
        z = np.asarray(las.z)[m]
        zf = self.zf
        return {
            "x": x[m], "y": y[m], "z": z * zf if zf != 1.0 else z,
            "cls": np.asarray(las.classification)[m].astype(np.uint8),
            "rn": np.asarray(las.return_number)[m].astype(np.uint8),
            "nr": np.asarray(las.number_of_returns)[m].astype(np.uint8),
            "i": np.asarray(las.intensity)[m].astype(np.uint16),
        }


@dataclass
class _Kit:
    """One pool thread's own native objects (see NodeReader)."""

    clip: BaseGeometry | None
    tr: Transformer
    session: requests.Session


def _join(parts: list[dict]) -> dict:
    return parts[0] if len(parts) == 1 else {k: np.concatenate([p[k] for p in parts]) for k in parts[0]}


def candidates(frame: Frame, bbox, clip, cache: Path) -> tuple[list[EptSource], float | None]:
    """EPT sources worth trying, in order, and the share of the area their footprints cover.

    USGS's and NOAA's together, in one plan (plan_cover): the newest survey over half the streets,
    then whatever covers the gaps. A USGS set known only from the hand-kept fallback list has no
    footprint, so it is tried first if its octree cube contains the bbox (what single-road bakes
    always did) and the share is None, because a cube says nothing about where the points are.
    """
    from .lidar import _get_json

    area = area_in_wgs(frame, bbox, clip)
    usgs = usgs_sources(cache)
    blind: list[EptSource] = []
    for s in (u for u in usgs if u.footprint is None):
        try:
            s.ept = _get_json(s.base + "ept.json", cache / "ept" / s.slug / "ept.json")
        except Exception:
            continue
        b = s.ept["bounds"]
        x0, y0, x1, y1 = bbox_in(frame, bbox, ept_crs(s.ept))
        if b[0] <= x0 and b[1] <= y0 and b[3] >= x1 and b[4] >= y1:
            blind.append(s)
    ranked = rank_by_footprint([u for u in usgs if u.footprint is not None] + noaa_sources(cache), area)
    for s, share in ranked[:8]:
        print(f"  lidar   candidate {s.label()}: footprint covers {share:.0%} of the streets", flush=True)
    if len(ranked) > 8:
        print(f"  lidar   ... and {len(ranked) - 8} more", flush=True)
    plan = plan_cover(ranked, area)
    if plan:
        print("  lidar   plan: " + ", then ".join(f"{s.label()} (+{g:.0%})" for s, g in plan), flush=True)
    for s, _ in plan:
        s.share = next(sh for r, sh in ranked if r is s)
    return blind + [s for s, _ in plan], (None if blind else union_share(plan, area))


def stream_ept(frame: Frame, bbox, clip, cache: Path, sources: list[EptSource], meta: dict, jobs: int = 16) -> Iterator[tuple[str, dict]]:
    """Point batches from the best source, then from the next ones only where it left gaps.

    `meta` is filled in as it goes (the caller reads it after the last batch): which sources were
    used, at what depth and density, and the share of the streets' cells that got points.
    """
    from .lidar import _get_json

    target = density_target()
    occ = Occupancy(bbox, clip)
    used: list[dict] = []
    for src in sources:
        if len(used) >= MAX_SOURCES or occ.share() >= ENOUGH_COVERAGE:
            break
        if src.ept is None:
            src.ept = _get_json(src.base + "ept.json", cache / "ept" / src.slug / "ept.json")
        crs = ept_crs(src.ept)
        area_ept, area_m2 = area_in(frame, bbox, clip, crs)
        keys, depth, density = nodes_over(src, bbox_in(frame, bbox, crs), lambda rel: _get_json(src.base + rel, cache / "ept" / src.slug / rel.replace("ept-hierarchy/", "h/")), target, area_ept, area_m2)
        if not keys:
            continue
        first = not used
        before = occ.share()
        read = NodeReader(src, cache, crs, frame.crs, z_factor(src.ept), bbox, clip)
        print(f"  lidar   {src.label()}: {len(keys)} nodes to depth {depth} (~{density:.1f} pts/m² where it covers){'' if first else f', filling {1 - before:.0%} of the streets it left empty'}", flush=True)
        t0 = time.time()
        got = 0
        # THIS source's cells, merged only when it is finished: marking as it streamed would have
        # its own later nodes find the cells its earlier nodes filled and drop themselves, halving
        # the density in every gap cell. EPT nodes are spatially interleaved, so that is all of them.
        mine = occ.pending()
        batch: list[dict] = []
        n = 0
        done = 0
        with ThreadPoolExecutor(jobs) as ex:
            for part in ex.map(read, keys):
                done += 1
                if part is not None:
                    if not first:
                        keep = occ.empty(part["x"], part["y"])
                        part = {k: v[keep] for k, v in part.items()} if keep.any() else None
                    if part is not None:
                        batch.append(part)
                        n += len(part["x"])
                if n >= BATCH_POINTS or (done == len(keys) and batch):
                    pts = _join(batch)
                    occ.mark(pts["x"], pts["y"], into=mine)
                    got += len(pts["x"])
                    yield f"{src.name} nodes {done}/{len(keys)}", pts
                    batch, n = [], 0
        occ.merge(mine)
        if not got:
            # a USGS cube can contain the bbox with no points in it (Clarksburg, KGeorge over
            # Crofton): tried, and not what this bake is made of
            print(f"  lidar   {src.label()}: no points over these streets", flush=True)
            continue
        used.append({"dataset": src.name, "year": src.year, "depth": depth, "density_bbox": round(density, 2), "points": got, "seconds": round(time.time() - t0, 1)})
        print(f"  lidar   {src.label()}: {got:,} points in {time.time() - t0:.0f} s; streets covered {occ.share():.0%}", flush=True)
    meta.update({
        "dataset": used[0]["dataset"] if used else None,
        "source": "ept",
        "sources": used,
        "density_target": target,
        "coverage": round(occ.share(), 3),
    })
