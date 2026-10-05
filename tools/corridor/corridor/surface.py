"""What the road is paved with, measured, every 20 m.

Two signals we already have, neither of which is a guess:

  LIDAR RETURN INTENSITY on ground-classified points inside the travelled lanes. Asphalt is a
  near-black target for a 1064 nm laser; concrete is bright. On Braddock I-70 the pavement median
  is ~5,900 (16-bit) against ~34,000 for the grass verge — a 6:1 gap — and it drifts 4,400–7,200
  along the corridor as the surface ages and gets patched. Concrete would sit above ~15,000.
  Intensity is per-project (sensor, gain), so thresholds are relative to the corridor's own verge.

  NAIP COLOUR inside the same lane region: brightness and chroma. Fresh asphalt is dark and
  neutral (~50-70), aged asphalt greys up toward 100-130, concrete is 140+ and slightly warm;
  chip seal is brighter still and textured. This is the signal that survives on roads without
  lidar, and it cross-checks the other.

  OSM `surface=` on the way, when mapped, is the third vote.

The output is a per-station record and a class per OSM segment:

    asphalt_new | asphalt_aged | asphalt_patched | concrete | chipseal | unknown

That class is what the game maps to a texture set (tools/surfaces). The thresholds here are a
FIRST CALIBRATION against one interstate; they belong in the manifest so a later fit can move them.
"""
from __future__ import annotations

import json
from pathlib import Path

import laspy
import numpy as np
import rasterio
from shapely.geometry import LineString
from shapely.ops import substring

from . import progress

LANE_M = 3.66
STEP_M = 20.0


def _polyline_measures(coords, x, y, densify_m: float = 1.0, chunk: int = 8_000_000):
    """Distance to a polyline and arc-length position, for hundreds of millions of points.

    `shapely.distance` / `shapely.line_locate_point` scan every segment once PER POINT, so the
    Capital Beltway's ~400 M ground returns against its 827-segment spine is ~3x10^11 segment
    tests — the three hours `surface.measure` spent, and the thing that used 150 GiB building a
    `Point` object for each return. Here the line is densified once and indexed with a KD-tree:
    each point looks up its nearest sample, then is EXACTLY projected onto the few original
    segments around that sample. O(points · log samples), a few GB instead of hundreds, and the
    same distance and s to floating point.

    The samples are EVERY polygon vertex plus a ~`densify_m` step between them. The vertices matter:
    a run of segments shorter than the step would otherwise sit between two samples, and a point
    nearest one of them could look several segments away from the sample it chose.

    Points are handled in chunks so peak memory is bounded by `chunk`, not by the cloud's size.
    """
    from scipy.spatial import cKDTree

    coords = np.asarray(coords, dtype=float)
    # drop duplicate consecutive vertices; a zero-length segment makes arc length ambiguous
    if coords.ndim != 2 or coords.shape[0] < 2:
        z = np.zeros(np.shape(x), dtype=float)
        return z, z
    step = np.hypot(np.diff(coords[:, 0]), np.diff(coords[:, 1]))
    p = coords[np.concatenate(([True], step > 0.0))]
    if p.shape[0] < 2:
        z = np.zeros(np.shape(x), dtype=float)
        return z, z

    seg = p[1:] - p[:-1]
    seglen = np.hypot(seg[:, 0], seg[:, 1])
    cum = np.concatenate(([0.0], np.cumsum(seglen)))
    total = float(cum[-1])

    # densify to ~densify_m samples, each remembering which ORIGINAL segment it lies on. Every
    # vertex is a sample too, so short segments cannot fall between two samples.
    ds = max(0.5, float(densify_m))
    ns = max(2, int(np.ceil(total / ds)) + 1)
    s_samp = np.unique(np.concatenate((np.linspace(0.0, total, ns), cum)))
    seg_of = np.clip(np.searchsorted(cum, s_samp, side="right") - 1, 0, seglen.shape[0] - 1)
    frac = (s_samp - cum[seg_of]) / seglen[seg_of]
    samp = p[seg_of] + frac[:, None] * seg[seg_of]
    tree = cKDTree(samp)

    a, b = p[:-1], p[1:]
    nseg = seglen.shape[0]
    out_d = np.empty(x.shape, dtype=np.float64)
    out_s = np.empty(x.shape, dtype=np.float64)
    total_pts = int(x.shape[0])
    for i0 in range(0, total_pts, max(1, chunk)):
        i1 = min(total_pts, i0 + max(1, chunk))
        q = np.column_stack((np.asarray(x[i0:i1], dtype=float), np.asarray(y[i0:i1], dtype=float)))
        _, j = tree.query(q, k=1, workers=-1)
        base = seg_of[j]
        best_d = np.full(q.shape[0], np.inf)
        best_s = np.zeros(q.shape[0])
        # the nearest point is on the sample's own segment or the one beside it; +/-2 is margin
        for off in (-2, -1, 0, 1, 2):
            kk = np.clip(base + off, 0, nseg - 1)
            ax, ay = a[kk, 0], a[kk, 1]
            ex, ey = b[kk, 0] - ax, b[kk, 1] - ay
            l2 = ex * ex + ey * ey
            t = ((q[:, 0] - ax) * ex + (q[:, 1] - ay) * ey) / np.where(l2 == 0.0, 1.0, l2)
            np.clip(t, 0.0, 1.0, out=t)
            cxp, cyp = ax + t * ex, ay + t * ey
            dd = np.hypot(q[:, 0] - cxp, q[:, 1] - cyp)
            upd = dd < best_d
            best_d[upd] = dd[upd]
            best_s[upd] = (cum[kk] + t * seglen[kk])[upd]
        out_d[i0:i1] = best_d
        out_s[i0:i1] = best_s
    return out_d, out_s


def _bin_median(values, bins, n: int, min_count: int):
    """`np.median` of `values` per bin 0..n-1, NaN where a bin holds fewer than `min_count`.

    The old code looped `for b in range(n)` and rebuilt `m = mask & (bins == b)` every time — n
    full-array passes (3,089 for this corridor). One argsort by bin and one median per contiguous
    group is the same answer in a single pass over the points, plus n tiny groups.
    """
    out = np.full(n, np.nan)
    if values.shape[0] == 0:
        return out
    order = np.argsort(bins, kind="stable")
    b = bins[order]
    v = values[order]
    edges = np.flatnonzero(np.diff(b)) + 1
    starts = np.concatenate(([0], edges))
    ends = np.concatenate((edges, [b.shape[0]]))
    for s0, e0 in zip(starts, ends):
        if e0 - s0 >= min_count:
            out[b[s0]] = np.median(v[s0:e0])
    return out


def measure(site_dir: Path) -> dict | None:
    sp = json.loads((site_dir / "spine_utm.json").read_text())
    line = LineString(sp["coords"])
    segs = sp.get("segments", [])

    def lanes_at(s: float) -> int:
        for g in segs:
            if g["s_start"] - 0.5 <= s <= g["s_end"] + 0.5:
                try:
                    return max(1, int(g["tags"].get("lanes", 2)))
                except ValueError:
                    return 2
        return 2

    def osm_surface_at(s: float) -> str | None:
        for g in segs:
            if g["s_start"] - 0.5 <= s <= g["s_end"] + 0.5:
                return g["tags"].get("surface")
        return None

    n = int(line.length // STEP_M) + 1
    s_arr = np.arange(n) * STEP_M
    rec = {"s": s_arr.round(1).tolist(), "lanes": [lanes_at(v) for v in s_arr], "osm_surface": [osm_surface_at(v) for v in s_arr]}

    # --- lidar intensity: ground returns inside the lanes, and on the verge for a reference -----
    laz = site_dir / "lidar" / "corridor.laz"
    if laz.exists():
        las = laspy.read(laz)
        c = np.asarray(las.classification)
        g = c == 2
        gx = np.asarray(las.x)[g]
        gy = np.asarray(las.y)[g]
        inten = np.asarray(las.intensity)[g].astype(np.float64)
        d, s_of = _polyline_measures(sp["coords"], gx, gy)
        bins = np.clip((s_of / STEP_M).astype(int), 0, n - 1)
        half_all = np.array([lanes_at(v) for v in s_arr], dtype=float) * (LANE_M / 2.0)
        half = half_all[bins]
        lane = d <= half - 0.3
        verge = (d >= 12) & (d <= 30)
        lane_med = _bin_median(inten[lane], bins[lane], n, 30)
        verge_med = _bin_median(inten[verge], bins[verge], n, 30)
        rec["lidar_lane_intensity"] = [None if np.isnan(v) else round(float(v)) for v in lane_med]
        rec["lidar_verge_intensity"] = [None if np.isnan(v) else round(float(v)) for v in verge_med]
        verge_ref = float(np.nanmedian(verge_med)) if np.isfinite(np.nanmedian(verge_med)) else None
        rec["lidar_verge_reference"] = verge_ref
        rec["lidar_ratio"] = [None if (np.isnan(v) or not verge_ref) else round(float(v) / verge_ref, 3) for v in lane_med]
    else:
        rec["lidar_lane_intensity"] = [None] * n
        rec["lidar_ratio"] = [None] * n

    # --- NAIP colour inside the lanes ----------------------------------------------------------
    naip = site_dir / "naip.tif"
    if naip.exists():
        with rasterio.open(naip) as src:
            bright = np.full(n, np.nan)
            chroma = np.full(n, np.nan)
            texture = np.full(n, np.nan)
            p = progress.Progress("surface", n)
            for b in range(n):
                p.tick()
                s0 = s_arr[b]
                # lane polygon for this station: the spine substring buffered to the lane half-width
                sub = substring(line, s0, min(line.length, s0 + STEP_M))
                if sub.length < 2:
                    continue
                poly = sub.buffer(lanes_at(s0) * LANE_M / 2 - 0.4, cap_style="flat")
                try:
                    from rasterio.mask import mask

                    arr, _ = mask(src, [poly.__geo_interface__], crop=True, filled=False)
                except Exception:
                    continue
                if arr.mask.all():
                    continue
                rgb = arr.astype(np.float32)
                valid = ~arr.mask[0]
                if valid.sum() < 50:
                    continue
                r, gch, bl = rgb[0][valid], rgb[1][valid], rgb[2][valid]
                lum = 0.299 * r + 0.587 * gch + 0.114 * bl
                bright[b] = float(np.median(lum))
                chroma[b] = float(np.median(np.maximum.reduce([r, gch, bl]) - np.minimum.reduce([r, gch, bl])))
                texture[b] = float(np.std(lum))
            p.close()
        rec["naip_brightness"] = [None if np.isnan(v) else round(float(v), 1) for v in bright]
        rec["naip_chroma"] = [None if np.isnan(v) else round(float(v), 1) for v in chroma]
        rec["naip_texture"] = [None if np.isnan(v) else round(float(v), 1) for v in texture]
    else:
        rec["naip_brightness"] = [None] * n
        rec["naip_chroma"] = [None] * n
        rec["naip_texture"] = [None] * n

    # --- the call ------------------------------------------------------------------------------
    # Lidar intensity is NOT comparable between projects (Sideling's MD_Western_1 pavement reads
    # 14,300 where Braddock's MD_Western_2 reads 5,900 for the same asphalt), so intensity only
    # ever votes RELATIVE to this corridor's own median: darker than usual = newer binder, brighter
    # = older or concrete. Imagery brightness is absolute and decides concrete versus asphalt.
    # Chip seal does not happen on a motorway; the road class gates it.
    hw = {g["tags"].get("highway") for g in segs}
    big_road = bool(hw & {"motorway", "trunk", "primary", "motorway_link"})
    ratios = rec.get("lidar_ratio", [None] * n)
    valid_r = [r for r in ratios if r is not None]
    ratio_med = float(np.median(valid_r)) if valid_r else None
    thresholds = {"concrete_brightness": 120, "new_brightness": 90, "new_ratio_rel": 0.75, "concrete_ratio_rel": 1.6, "chipseal_texture": 22, "patch_jump": 0.35, "ratio_median": ratio_med}
    classes = []
    for i in range(n):
        osm = rec["osm_surface"][i]
        ratio = ratios[i]
        br = rec["naip_brightness"][i]
        tex = rec["naip_texture"][i]
        rel = (ratio / ratio_med) if (ratio is not None and ratio_med) else None
        cls = "unknown"
        if osm in ("concrete", "concrete:plates", "concrete:lanes"):
            cls = "concrete"
        elif br is not None and br >= thresholds["concrete_brightness"] and (rel is None or rel >= 1.15):
            cls = "concrete"
        elif rel is not None and rel >= thresholds["concrete_ratio_rel"] and (br is None or br >= 105):
            cls = "concrete"
        elif rel is not None and rel <= thresholds["new_ratio_rel"] and (br is None or br <= thresholds["new_brightness"] + 15):
            cls = "asphalt_new"
        elif br is not None and br <= thresholds["new_brightness"] and rel is None:
            cls = "asphalt_new"
        elif br is not None or rel is not None:
            cls = "asphalt_aged"
        elif osm in ("asphalt", "paved"):
            cls = "asphalt_aged"
        elif osm in ("gravel", "compacted", "fine_gravel", "unpaved"):
            cls = "chipseal"
        if not big_road and cls.startswith("asphalt") and tex is not None and tex >= thresholds["chipseal_texture"] and (br or 0) > 110:
            cls = "chipseal"
        classes.append(cls)
    # patches: a station whose lane intensity jumps ≥35% against both neighbours is a resurfaced patch
    for i in range(1, n - 1):
        a, b_, c_ = ratios[i - 1], ratios[i], ratios[i + 1]
        if None in (a, b_, c_) or not classes[i].startswith("asphalt"):
            continue
        if abs(b_ - a) / max(a, 1e-6) >= thresholds["patch_jump"] and abs(b_ - c_) / max(c_, 1e-6) >= thresholds["patch_jump"]:
            classes[i] = "asphalt_patched"
    rec["class"] = classes
    # per OSM segment: the majority class
    by_seg = []
    for g in segs:
        idx = [i for i, v in enumerate(s_arr) if g["s_start"] - 0.5 <= v <= g["s_end"] + 0.5]
        votes: dict[str, int] = {}
        for i in idx:
            votes[classes[i]] = votes.get(classes[i], 0) + 1
        by_seg.append({"s_start": g["s_start"], "s_end": g["s_end"], "osm_id": g.get("osm_id"), "class": max(votes, key=votes.get) if votes else "unknown", "votes": votes})
    summary: dict[str, int] = {}
    for c_ in classes:
        summary[c_] = summary.get(c_, 0) + 1
    out = {"step_m": STEP_M, "thresholds": thresholds, "stations": rec, "segments": by_seg, "summary": summary}
    (site_dir / "surface.json").write_text(json.dumps(out))
    return out
