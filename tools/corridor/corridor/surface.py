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
import shapely
from shapely.geometry import LineString
from shapely.ops import substring

LANE_M = 3.66
STEP_M = 20.0


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
        pts = shapely.points(np.asarray(las.x)[g], np.asarray(las.y)[g])
        inten = np.asarray(las.intensity)[g].astype(np.float64)
        d = shapely.distance(pts, line)
        s_of = shapely.line_locate_point(line, pts)
        bins = np.clip((s_of / STEP_M).astype(int), 0, n - 1)
        half = np.array([lanes_at(v) * LANE_M / 2 for v in s_arr])[bins]
        lane = d <= half - 0.3
        verge = (d >= 12) & (d <= 30)
        lane_med = np.full(n, np.nan)
        verge_med = np.full(n, np.nan)
        for b in range(n):
            m = lane & (bins == b)
            if m.sum() >= 30:
                lane_med[b] = np.median(inten[m])
            m2 = verge & (bins == b)
            if m2.sum() >= 30:
                verge_med[b] = np.median(inten[m2])
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
            for b in range(n):
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
