"""Streams, rivers, ponds and falls: OSM says where the water is, the lidar says how high.

OSM `waterway=*` lines in the corridor are drawn from imagery and sit close to the channel:
measured 2026-09-21 on Little Catoctin Creek (South Mountain), the Monocacy tributary
(Frederick I-270) and Butterfly Branch (Braddock), the OSM line is within 3 m of the 1 m DTM's
low point 86-100 % of the time, median offset 0-1 m, and the DTM under the line is within 0.2 m of
that low point. So each vertex is SNAPPED to the lowest DTM cell across a ±`SNAP_M` (6 m) transect
and takes that height, which puts the water in the channel rather than on its bank. Outside the
lidar corridor the bare-earth DEM (300 m half-width) stands in; beyond that the vertex is dropped.

Width: OSM `width` when tagged (the Monocacy carries 20), else by class (`WIDTHS`). A segment
tagged `tunnel=culvert` is kept for continuity but flagged so the viewer does not draw water
through the fill under the road.

FALLS. Water in the piedmont steps down over ledges; Bonnie Branch is the test. Along the snapped
line the height is running-minimum-filtered in the flow direction (OSM draws waterways
downstream; a rise is DTM noise or a bridge deck), and any `FALL_WINDOW` (20 m) that drops more
than `FALL_DROP` (2 m) is a fall or rapid. Little Catoctin Creek's steepest 20 m drops 2.1 m.

Polygons (`natural=water`, `water=*`, `natural=wetland`) are flat at the median DTM inside them.

Output `water.json` (manifest key `water`): lines and areas with coordinates RELATIVE TO THE SITE
ORIGIN, z absolute (NAVD88).
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import rasterio
from shapely.geometry import LineString, shape

from .geo import Frame

STEP_M = 5.0
SNAP_M = 6.0
FALL_WINDOW = 20.0
FALL_DROP = 2.0
WIDTHS = {"river": 12.0, "canal": 6.0, "stream": 2.5, "ditch": 1.2, "drain": 1.0, "tidal_channel": 6.0}
KINDS = tuple(WIDTHS)


def _num(v) -> float | None:
    try:
        return float(str(v).split(";")[0].replace("m", "").strip())
    except (TypeError, ValueError):
        return None


class _Heights:
    """Ground height at arbitrary points: the lidar DTM first, the bare-earth DEM where it has no
    data, NaN beyond both.

    Two modes, because a corridor and a region are different problems. A single-road site's DTM is
    a few hundred MB at most, so it is read once into an array and indexed. A NETWORK site's
    `lidar/dtm.vrt` covers 18 km square — 324 M cells, 1.3 GB — and must never be resident: over
    `LAZY_CELLS` the dataset is kept open and each `at()` call reads only the window its own points
    need. That makes the CALLER's access pattern the thing that matters: ask for a compact clump of
    points (one along-track chunk), not for one lateral offset down a whole 16 km road.
    """

    LAZY_CELLS = 40_000_000

    def __init__(self, site_dir: Path):
        self.srcs: list[tuple] = []
        for name in ("lidar/dtm.vrt", "lidar/dtm.tif", "dem_1m.tif"):
            p = site_dir / name
            if not p.exists():
                continue
            src = rasterio.open(p)
            if src.width * src.height > self.LAZY_CELLS:
                self.srcs.append(("lazy", src, src.transform))
            else:
                arr = src.read(1).astype(np.float32)
                src.close()
                self.srcs.append(("array", arr, None))
                self.srcs[-1] = ("array", arr, rasterio.open(p).transform)

    def _read(self, kind, obj, tr, xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
        if kind == "array":
            r, c = rasterio.transform.rowcol(tr, xs, ys)
            r, c = np.asarray(r), np.asarray(c)
            ok = (r >= 0) & (r < obj.shape[0]) & (c >= 0) & (c < obj.shape[1])
            v = np.full(ok.shape, np.nan, np.float32)
            v[ok] = obj[r[ok], c[ok]]
            return v
        # lazy: one window covering exactly the points asked for
        src = obj
        r, c = rasterio.transform.rowcol(tr, xs, ys)
        r, c = np.asarray(r), np.asarray(c)
        ok = (r >= 0) & (r < src.height) & (c >= 0) & (c < src.width)
        v = np.full(ok.shape, np.nan, np.float32)
        if not ok.any():
            return v
        r0, r1 = int(r[ok].min()), int(r[ok].max())
        c0, c1 = int(c[ok].min()), int(c[ok].max())
        win = rasterio.windows.Window(c0, r0, c1 - c0 + 1, r1 - r0 + 1)
        a = src.read(1, window=win).astype(np.float32)
        v[ok] = a[r[ok] - r0, c[ok] - c0]
        return v

    def at(self, xs, ys) -> np.ndarray:
        xs = np.atleast_1d(np.asarray(xs, dtype=float))
        ys = np.atleast_1d(np.asarray(ys, dtype=float))
        out = np.full(len(xs), np.nan, np.float32)
        for kind, obj, tr in self.srcs:
            need = np.isnan(out)
            if not need.any():
                break
            v = self._read(kind, obj, tr, xs[need], ys[need])
            v = np.where((v < -9000) | ~np.isfinite(v), np.nan, v)
            out[need] = v
        return out

    def close(self):
        for kind, obj, _ in self.srcs:
            if kind == "lazy":
                obj.close()


def measure(site_dir: Path) -> dict | None:
    osm_p = site_dir / "osm.geojson"
    if not osm_p.exists():
        return None
    site = json.loads((site_dir / "site.json").read_text())
    frame = Frame.at(site["lon"], site["lat"])
    ox, oy = site["frame"]["origin"]
    hz = _Heights(site_dir)
    if not hz.srcs:
        return None
    feats = json.loads(osm_p.read_text())["features"]
    offs = np.arange(-SNAP_M, SNAP_M + 0.5, 1.0)

    lines = []
    for f in feats:
        p = f["properties"]
        kind = p.get("waterway")
        if kind not in KINDS or f["geometry"]["type"] != "LineString":
            continue
        c = np.array(f["geometry"]["coordinates"])
        if len(c) < 2:
            continue
        x, y = frame.from_wgs(c[:, 0], c[:, 1])
        ln = LineString(np.column_stack([x, y]))
        if ln.length < 5:
            continue
        ss = np.arange(0.0, ln.length, STEP_M).tolist() + [ln.length]
        P = np.array([ln.interpolate(v).coords[0] for v in ss])
        A = np.array([ln.interpolate(min(v + 1.0, ln.length)).coords[0] for v in ss])
        d = A - P
        d /= np.maximum(np.linalg.norm(d, axis=1, keepdims=True), 1e-9)
        nrm = np.column_stack([-d[:, 1], d[:, 0]])
        Z = np.stack([hz.at(P[:, 0] + nrm[:, 0] * o, P[:, 1] + nrm[:, 1] * o) for o in offs], axis=1)
        have = np.isfinite(Z).any(axis=1)
        if have.sum() < 2:
            continue
        culvert = bool(p.get("tunnel") == "culvert" or (str(p.get("layer", "0")).lstrip("-").isdigit() and int(p.get("layer", "0")) < 0))
        width = _num(p.get("width")) or WIDTHS[kind]
        # snap each vertex to the low point of its transect — unless the channel is wider than the
        # transect (the Monocacy at 20 m): then the OSM line is the centreline and only z is read
        Zf = np.where(np.isfinite(Z), Z, np.inf)
        j = np.argmin(Zf, axis=1)
        shift = offs[j] if width <= 2 * SNAP_M else np.zeros(len(ss))
        snapped = P + nrm * shift[:, None]
        z = Zf[np.arange(len(ss)), j]
        z[~have] = np.nan
        keep = have
        pts = snapped[keep]
        zk = z[keep]
        sk = np.array(ss)[keep]
        # water flows downhill: running minimum in the flow direction removes DTM noise and decks
        zmin = np.minimum.accumulate(zk)
        # falls and rapids: maximal runs of 20 m windows that each drop more than FALL_DROP. A step
        # (grade > 0.25) is a fall, a long steep reach is rapids. Not under a culvert: the DTM there
        # is the road fill and the "drop" is the outlet.
        falls = []
        n_win = max(1, int(round(FALL_WINDOW / STEP_M)))
        if not culvert and len(zmin) > n_win:
            steep = np.array([zmin[i] - zmin[i + n_win] > FALL_DROP for i in range(len(zmin) - n_win)])
            i = 0
            while i < len(steep):
                if not steep[i]:
                    i += 1
                    continue
                j0 = i
                while i < len(steep) and steep[i]:
                    i += 1
                j1 = min(len(zmin) - 1, i - 1 + n_win)
                drop = float(zmin[j0] - zmin[j1])
                length = float(sk[j1] - sk[j0])
                grade = drop / max(length, 1e-6)
                falls.append({"i0": int(j0), "i1": int(j1), "drop_m": round(drop, 2), "length_m": round(length, 1), "grade": round(grade, 3), "kind": "falls" if grade > 0.25 else "rapids"})
        lines.append({
            "id": f"water-{p.get('osm_id')}",
            "kind": kind,
            "name": p.get("name"),
            "width_m": round(width, 1),
            "culvert": culvert,
            "intermittent": p.get("intermittent") == "yes",
            "length_m": round(float(sk[-1] - sk[0]), 1),
            "fall_m": round(float(zmin[0] - zmin[-1]), 2),
            "snap_offset_m": round(float(np.median(np.abs(shift[keep]))), 1),
            "pts": [[round(float(px - ox), 1), round(float(py - oy), 1), round(float(pz), 2)] for (px, py), pz in zip(pts, zmin)],
            "falls": falls,
        })

    areas = []
    for f in feats:
        p = f["properties"]
        if f["geometry"]["type"] != "Polygon":
            continue
        kind = None
        if p.get("natural") == "water" or p.get("water"):
            kind = p.get("water") or "water"
        elif p.get("natural") == "wetland":
            kind = "wetland"
        elif p.get("landuse") in ("reservoir", "basin"):
            kind = p.get("landuse")
        if not kind:
            continue
        try:
            g = shape(f["geometry"])
            from shapely.ops import transform as shp_transform

            g = shp_transform(lambda lx, ly, lz=None: frame.from_wgs(lx, ly), g)
        except Exception:
            continue
        if g.is_empty or g.area < 20:
            continue
        ring = np.array(g.exterior.coords[:-1])
        # the water level: the median ground inside (sampled on a coarse lattice) — a pond's DTM is
        # the surface the laser saw, which is the water
        minx, miny, maxx, maxy = g.bounds
        step = max(1.0, np.sqrt(g.area) / 20)
        gx, gy = np.meshgrid(np.arange(minx, maxx, step), np.arange(miny, maxy, step))
        import shapely

        inside = shapely.contains_xy(g, gx.ravel(), gy.ravel())
        zs = hz.at(gx.ravel()[inside], gy.ravel()[inside]) if inside.any() else np.array([])
        zs = zs[np.isfinite(zs)]
        if zs.size == 0:
            continue
        areas.append({"id": f"water-{p.get('osm_id')}", "kind": kind, "name": p.get("name"), "area_m2": round(float(g.area), 1), "z": round(float(np.median(zs)), 2), "ring": [[round(float(x - ox), 1), round(float(y - oy), 1)] for x, y in ring]})

    n_falls = sum(sum(f["kind"] == "falls" for f in ln["falls"]) for ln in lines)
    n_rapids = sum(sum(f["kind"] == "rapids" for f in ln["falls"]) for ln in lines)
    out = {"thresholds": {"step_m": STEP_M, "snap_m": SNAP_M, "fall_window_m": FALL_WINDOW, "fall_drop_m": FALL_DROP, "widths": WIDTHS}, "lines": lines, "areas": areas, "summary": {"lines": len(lines), "length_m": round(sum(ln["length_m"] for ln in lines), 1), "falls": n_falls, "rapids": n_rapids, "areas": len(areas), "kinds": sorted({ln["kind"] for ln in lines})}}
    (site_dir / "water.json").write_text(json.dumps(out))
    return out


def main() -> None:
    import sys

    from .__main__ import DATA

    slugs = sys.argv[1:] or [d.name for d in sorted((DATA / "sites").glob("*")) if d.is_dir()]
    for slug in slugs:
        r = measure(DATA / "sites" / slug)
        if r is None:
            print(f"{slug:24s} no osm/heights")
            continue
        sm = r["summary"]
        print(f"{slug:24s} {sm['lines']:3d} lines {sm['length_m']:7.0f} m, {sm['falls']} falls, {sm['rapids']} rapids, {sm['areas']} areas, kinds {sm['kinds']}")
        for ln in r["lines"]:
            if ln["length_m"] >= 100 or ln["falls"]:
                print(f"    {ln['kind']:7s} {str(ln['name']):28s} {ln['length_m']:6.0f} m w {ln['width_m']:4.1f} fall {ln['fall_m']:+6.1f} snap {ln['snap_offset_m']} m {'CULVERT' if ln['culvert'] else ''} falls {[(f['kind'], f['drop_m'], f['length_m']) for f in ln['falls']]}")


if __name__ == "__main__":
    main()
