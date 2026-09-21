"""Exposed rock: where the ground stands too steep to be soil.

What separates a rock face from a graded embankment in the data we have, MEASURED on 2026-09-21
against the cut faces cuts.py found (Sideling's shale wall, Braddock's Catoctin metabasalt):

    slope        soil rests at 25-35°; a 1:2 fill is 26.6°, a 1:1.5 fill 33.7°. Inside the tall
                 faces 16-64 % of cells stand STEEPER THAN 45°; on other steep bare ground 2-6 %.
                 Nothing else we have separates the two this cleanly.
    relief       max-min of the 1 m DTM over 7 m: 5.6-7.3 m on the faces, 3.7 m elsewhere.
    roughness    the 1 m DTM is a min-of-ground interpolation and too smooth to tell rock from
                 soil (0.19 vs 0.17 m residual std) — NOT used.
    intensity    ground-return intensity relative to the corridor's own verge: Catoctin metabasalt
                 reads 0.4× (dark), other steep ground 0.84×; Sideling's shale/sandstone reads
                 1.06× vs 1.18× — per-lithology, so it is RECORDED per polygon, not thresholded.
    NAIP         leaf-on imagery under forest shadow: luminance 65 on the face and 68 off it. Also
                 recorded, not thresholded.
    canopy       a face under trees is still rock; the CHM (< 0.5 m) is required only OUTSIDE a
                 detected cut face, where a steep forested slope is more likely a ravine bank.

So an exposed-rock cell is: valid DTM, `slope > SLOPE_MIN_DEG` (40°), `relief7 >= RELIEF_MIN` (3 m),
and (bare, or inside a cut face). Cells are closed and opened (3×3) and polygonised; polygons
under `AREA_MIN` (15 m²) are dropped. Each polygon carries its lithology (Macrostrat under the
nearest spine station, reduced to a rock-kit type by cuts.rock_type) — coastal-plain `sand` faces
(Bowie's 7.8 m bluff) are kept as polygons of type `sand` so the viewer can decide to put riprap or
nothing on them.

Output `rock.json` (manifest key `rock`): polygons with rings RELATIVE TO THE SITE ORIGIN.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import rasterio
from rasterio.features import rasterize, shapes
from scipy import ndimage
from shapely.geometry import LineString, Polygon, shape

from .cuts import _lith_at, rock_type

SLOPE_MIN_DEG = 40.0
RELIEF_MIN = 3.0
RELIEF_WIN = 7
BARE_CHM = 0.5
AREA_MIN = 15.0
EDGE_ERODE = 6  # cells of the lidar corridor's rim to ignore (the fill there is not ground)


def measure(site_dir: Path) -> dict | None:
    dtm_p, chm_p = site_dir / "lidar" / "dtm.tif", site_dir / "lidar" / "chm.tif"
    if not (dtm_p.exists() and chm_p.exists()):
        return None
    site = json.loads((site_dir / "site.json").read_text())
    ox, oy = site["frame"]["origin"]
    with rasterio.open(dtm_p) as s1, rasterio.open(chm_p) as s2:
        dtm = s1.read(1).astype(np.float32)
        chm = s2.read(1)
        tr = s1.transform
        bounds = s1.bounds
    valid = dtm > -9000
    if valid.mean() < 0.5 and (site_dir / "dem_1m.tif").exists():
        # the lidar covered a sliver (Bonnie Branch): the bare-earth DEM stands in on the DTM grid
        from rasterio.windows import from_bounds

        with rasterio.open(site_dir / "dem_1m.tif") as sd:
            win = from_bounds(bounds.left, bounds.bottom, bounds.right, bounds.top, transform=sd.transform)
            dem = sd.read(1, window=win, out_shape=dtm.shape, boundless=True, fill_value=-9999).astype(np.float32)
        use = (dem > -9000) & ~valid
        dtm[use] = dem[use]
        valid = dtm > -9000
        print(f"  rock    DTM {100 * (~use).mean():.0f}% sparse; DEM filled {int(use.sum()):,} cells", flush=True)
    if valid.sum() < 100:
        return None
    idx = ndimage.distance_transform_edt(~valid, return_distances=False, return_indices=True)
    filled = dtm[tuple(idx)]
    core = ndimage.binary_erosion(valid, iterations=EDGE_ERODE)
    gy, gx = np.gradient(filled)
    slope = np.degrees(np.arctan(np.hypot(gx, gy)))
    relief = ndimage.maximum_filter(filled, RELIEF_WIN) - ndimage.minimum_filter(filled, RELIEF_WIN)
    bare = chm < BARE_CHM

    # detected cut faces, as a raster: toe→top strips from cuts.json
    in_cut = np.zeros(dtm.shape, np.uint8)
    cuts_p = site_dir / "cuts.json"
    if cuts_p.exists():
        polys = []
        for f in json.loads(cuts_p.read_text()).get("faces", []):
            st = f.get("stations", [])
            if len(st) < 2:
                continue
            ring = [(q["toe"][0] + ox, q["toe"][1] + oy) for q in st] + [(q["top"][0] + ox, q["top"][1] + oy) for q in reversed(st)]
            pg = Polygon(ring)
            if not pg.is_valid:
                pg = pg.buffer(0)
            if not pg.is_empty:
                polys.append((pg, 1))
        if polys:
            in_cut = rasterize(polys, out_shape=dtm.shape, transform=tr, fill=0, dtype=np.uint8)

    mask = core & (slope > SLOPE_MIN_DEG) & (relief >= RELIEF_MIN) & (bare | (in_cut > 0))
    mask = ndimage.binary_opening(ndimage.binary_closing(mask, iterations=1), iterations=1)
    labels, n = ndimage.label(mask)
    if n == 0:
        out = {"thresholds": _thresholds(), "polygons": [], "summary": {"count": 0, "area_m2": 0.0, "in_cut": 0, "by_type": {}}}
        (site_dir / "rock.json").write_text(json.dumps(out))
        return out

    # per-region statistics
    ids = np.arange(1, n + 1)
    area = ndimage.sum(np.ones_like(mask, dtype=np.float32), labels, ids)
    mslope = ndimage.mean(slope, labels, ids)
    mrelief = ndimage.mean(relief, labels, ids)
    incut = ndimage.mean(in_cut.astype(np.float32), labels, ids)

    # ground-return intensity per cell, relative to the flat bare verge
    inten_ratio = np.full(n, np.nan)
    laz = site_dir / "lidar" / "corridor.laz"
    if laz.exists():
        try:
            import laspy

            las = laspy.read(laz)
            c = np.asarray(las.classification)
            g = c == 2
            x, y = np.asarray(las.x)[g], np.asarray(las.y)[g]
            it = np.asarray(las.intensity)[g].astype(np.float32)
            col = (x - bounds.left).astype(int)
            row = (bounds.top - y).astype(int)
            H, W = dtm.shape
            ok = (col >= 0) & (col < W) & (row >= 0) & (row < H)
            flat = row[ok] * W + col[ok]
            sums = np.bincount(flat, weights=it[ok], minlength=W * H)
            cnt = np.bincount(flat, minlength=W * H)
            imean = np.where(cnt > 0, sums / np.maximum(cnt, 1), np.nan).reshape(H, W)
            verge = core & (slope < 8) & bare & np.isfinite(imean)
            ref = float(np.nanmedian(imean[verge])) if verge.any() else np.nan
            if np.isfinite(ref) and ref > 0:
                im0 = np.nan_to_num(imean, nan=0.0)
                has = np.isfinite(imean).astype(np.float32)
                s_i = ndimage.sum(im0, labels, ids)
                s_n = ndimage.sum(has, labels, ids)
                inten_ratio = np.where(s_n > 0, s_i / np.maximum(s_n, 1) / ref, np.nan)
        except Exception as exc:
            print(f"  rock    intensity skipped: {exc}")

    # NAIP colour per region (1 m resample over the DTM bounds)
    lum_m = np.full(n, np.nan)
    chroma_m = np.full(n, np.nan)
    naip = site_dir / "naip.tif"
    if naip.exists():
        try:
            from rasterio.enums import Resampling
            from rasterio.windows import from_bounds

            with rasterio.open(naip) as src:
                win = from_bounds(bounds.left, bounds.bottom, bounds.right, bounds.top, transform=src.transform)
                rgb = src.read(out_shape=(3, dtm.shape[0], dtm.shape[1]), window=win, resampling=Resampling.average, boundless=True, fill_value=0).astype(np.float32)
            lum = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]
            chroma = rgb.max(0) - rgb.min(0)
            lum_m = ndimage.mean(lum, labels, ids)
            chroma_m = ndimage.mean(chroma, labels, ids)
        except Exception as exc:
            print(f"  rock    naip skipped: {exc}")

    spine = LineString(json.loads((site_dir / "spine_utm.json").read_text())["coords"])
    geology = json.loads((site_dir / "geology.json").read_text()) if (site_dir / "geology.json").exists() else {}

    polygons = []
    for geom, val in shapes(labels.astype(np.int32), mask=mask, transform=tr):
        k = int(val) - 1
        if k < 0 or area[k] < AREA_MIN:
            continue
        pg = shape(geom)
        if pg.geom_type != "Polygon":
            continue
        pg = pg.simplify(0.7)
        if pg.is_empty or pg.area < AREA_MIN:
            continue
        cen = pg.centroid
        s_at = float(spine.project(cen))
        strat, lith, descrip = _lith_at(geology, s_at)
        polygons.append({
            "id": f"rock-{int(round(s_at)):04d}-{k}",
            "ring": [[round(x - ox, 1), round(y - oy, 1)] for x, y in pg.exterior.coords[:-1]],
            "area_m2": round(float(pg.area), 1),
            "s": round(s_at, 1),
            "slope_deg": round(float(mslope[k]), 1),
            "relief_m": round(float(mrelief[k]), 1),
            "intensity_ratio": None if not np.isfinite(inten_ratio[k]) else round(float(inten_ratio[k]), 2),
            "naip_lum": None if not np.isfinite(lum_m[k]) else round(float(lum_m[k]), 0),
            "naip_chroma": None if not np.isfinite(chroma_m[k]) else round(float(chroma_m[k]), 0),
            "in_cut": bool(incut[k] >= 0.5),
            "formation": strat,
            "rock_type": rock_type(lith, descrip),
        })
    polygons.sort(key=lambda q: q["s"])
    by_type: dict[str, float] = {}
    for q in polygons:
        by_type[q["rock_type"]] = round(by_type.get(q["rock_type"], 0.0) + q["area_m2"], 1)
    out = {"thresholds": _thresholds(), "polygons": polygons, "summary": {"count": len(polygons), "area_m2": round(sum(q["area_m2"] for q in polygons), 1), "in_cut": sum(q["in_cut"] for q in polygons), "by_type": by_type}}
    (site_dir / "rock.json").write_text(json.dumps(out))
    return out


def _thresholds() -> dict:
    return {"slope_min_deg": SLOPE_MIN_DEG, "relief_min_m": RELIEF_MIN, "relief_window_m": RELIEF_WIN, "bare_chm_m": BARE_CHM, "area_min_m2": AREA_MIN}


def main() -> None:
    import sys

    from .__main__ import DATA

    slugs = sys.argv[1:] or [d.name for d in sorted((DATA / "sites").glob("*")) if d.is_dir()]
    for slug in slugs:
        r = measure(DATA / "sites" / slug)
        if r is None:
            print(f"{slug:24s} no lidar")
            continue
        sm = r["summary"]
        big = sorted(r["polygons"], key=lambda q: -q["area_m2"])[:4]
        print(f"{slug:24s} {sm['count']:4d} polygons, {sm['area_m2']:8.0f} m² ({sm['in_cut']} in cut faces) by type {sm['by_type']}")
        for q in big:
            print(f"    {q['id']:16s} {q['area_m2']:7.0f} m² slope {q['slope_deg']:.0f}° relief {q['relief_m']:.1f} m int {q['intensity_ratio']} lum {q['naip_lum']} {q['rock_type']} <- {q['formation']} {'CUT' if q['in_cut'] else ''}")


if __name__ == "__main__":
    main()
