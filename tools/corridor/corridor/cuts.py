"""Cut faces and canyon walls beside the road, measured from the lidar DTM.

The profile's `ground_rel` samples the ground at five offsets; a face that starts 11 m out and
tops out at 30 m falls between them (Braddock's Catoctin cut reads as "+15 m at 40 m" and
nothing at 8 or 15). So this walks the DTM itself: at every 4 m station, a lateral transect
1 m apart from 2 to 70 m each side, height relative to the driving surface. A CUT FACE is where a
5 m window of that transect rises faster than `SLOPE_MIN` (0.6 m/m, ~31°) and the steep part
climbs at least `RISE_MIN` (3 m), with its toe inside `TOE_MAX` (40 m) of the centreline, for at
least `RUN_MIN` (20 m) along the road (a gap of two stations is bridged).

Measured 2026-09-21 on the day-one sites before a threshold was chosen: Sideling (US 40 Scenic)
has one left-hand wall from s=1576 to 3628 m, toe 9 m out, median rise 16 m, max 32 m, plus nine
shorter faces; Braddock has the Catoctin climb on the right (s 168-504 and 1016-1504, toe 11-13 m,
rise 12-19 m) and a face 35 m out on the left; South Mountain's right side rises 20 m at
s 320-620; Bowie and Clarksburg have nothing over 3 m within 40 m. Those are the faces the
photos show.

CLASS. `artificial` is a blasted or graded face: the toe runs parallel to the road (lateral std
of the toe ≤ `PARALLEL_STD`) and the slope is steady. `natural` is a ravine wall: the toe
wanders, or a mapped OSM waterway runs beside the road for most of the interval, or both sides
rise together. Bonnie Branch (falls down the fall line) is the natural test; Sideling and
Braddock the artificial ones.

LITHOLOGY comes from geology.json's Macrostrat samples at the interval's midpoint: the named
unit's `lith` string, reduced to one of the rock-kit types in `ROCK_TYPES` so the viewer can pick
the boulder set (`catalog.json` entries with `category: "rock"` and a matching `rock_type`).

Output `cuts.json` (and manifest key `cuts`, via export.py): one record per face with the
along-track interval, side, class, toe/top/height/slope statistics, rock type, and a station
list every 10 m with the toe and top as [x, y, z] RELATIVE TO THE SITE ORIGIN (z absolute,
NAVD88) so the viewer can dress the face without re-sampling anything.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import rasterio
from shapely.geometry import LineString, shape

STEP_M = 4.0
OFFSETS = np.arange(2.0, 71.0, 1.0)
WINDOW = 5          # transect samples (m) the slope is measured over
SLOPE_MIN = 0.6     # m/m: ~31°, steeper than any graded embankment (1:2 = 0.5) and shallower than a 1:1 rock cut
RISE_MIN = 3.0      # m the steep part must climb
TOE_MAX = 40.0      # m from the centreline the face must start within
RUN_MIN = 20.0      # m along the road
NATURAL_SLOPE_MIN = 0.4  # m/m (~22°): a ravine wall is gentler than a blasted cut but still a wall...
NATURAL_RISE_MIN = 6.0   # ...when it climbs this much (Bonnie Branch's walls: 4-24 m at 0.3-0.6 m/m)
GAP_STATIONS = 2    # stations of no-face a run may bridge
PARALLEL_STD = 3.0  # m: a graded toe wanders less than this
WATER_NEAR = 30.0   # m: a stream this close beside the road for half the interval makes it a ravine

# Rock-kit types and the words that vote for them in Macrostrat's `lith` and `descrip`. The named
# (state-map) units often have an EMPTY `lith` and carry the rock in the description ("Interbedded
# red shale, red mudstone, and ... sandstone"), so both fields are read and every keyword hit is a
# vote; the type with most votes wins, ties to the earlier entry. Hampshire (shale+mudstone+
# siltstone vs sandstone) -> shale; Purslane -> sandstone; Catoctin -> greenstone; Wissahickon ->
# schist; the coastal-plain Potomac/Monmouth -> sand (no rock kit: sand faces and riprap).
ROCK_TYPES: list[tuple[str, tuple[str, ...]]] = [
    ("greenstone", ("metabasalt", "greenstone", "basalt", "metavolcanic", "metaandesite", "metarhyolite", "diabase")),
    ("phyllite", ("phyllite", "slate", "phyllonite")),
    ("schist", ("schist", "gneiss", "metagraywacke", "migmatite")),
    ("granite", ("granodiorite", "granite", "diorite", "gabbro", "tonalite", "intrusive")),
    ("sandstone", ("sandstone", "quartzite", "conglomerate", "arkose", "graywacke")),
    ("shale", ("shale", "siltstone", "mudstone", "argillite", "claystone")),
    ("limestone", ("limestone", "dolostone", "dolomite", "marble", "calcareous")),
    ("sand", ("gravel", "sand", "clay", "silt", "glauconitic", "unconsolidated")),
]


def rock_type(lith: str | None, descrip: str | None = None) -> str:
    text = f"{lith or ''} {descrip or ''}".lower()
    if not text.strip():
        return "unknown"
    best, score = "unknown", 0
    for t, words in ROCK_TYPES:
        n = sum(text.count(w) for w in words)
        if n > score:
            best, score = t, n
    return best


def _runs(mask: np.ndarray, gap: int) -> list[tuple[int, int]]:
    idx = np.flatnonzero(mask)
    if idx.size == 0:
        return []
    out = [[int(idx[0]), int(idx[0])]]
    for i in idx[1:]:
        if i - out[-1][1] <= gap + 1:
            out[-1][1] = int(i)
        else:
            out.append([int(i), int(i)])
    return [(a, b) for a, b in out]


def _lith_at(geology: dict, s: float) -> tuple[str | None, str | None, str | None]:
    """The unit under the spine nearest along-track s: (name, lith, descrip). Named units first,
    and among them the one that says what rock it is."""
    samples = geology.get("samples") or []
    units = {u["map_id"]: u for u in geology.get("units", [])}
    if not samples:
        return None, None, None
    best = min(samples, key=lambda q: abs(q["s"] - s))
    cands = [units[i] for i in best.get("map_ids", []) if i in units]
    named = [u for u in cands if u.get("strat_name")]
    ordered = sorted(named or cands, key=lambda u: -len(f"{u.get('lith') or ''}{u.get('descrip') or ''}"))
    pick = ordered[0] if ordered else None
    return (pick.get("strat_name") or pick.get("name"), pick.get("lith"), pick.get("descrip")) if pick else (None, None, None)


def measure(site_dir: Path) -> dict | None:
    dtm_p = site_dir / "lidar" / "dtm.tif"
    if not (dtm_p.exists() and (site_dir / "profile.json").exists()):
        return None
    site = json.loads((site_dir / "site.json").read_text())
    ox, oy = site["frame"]["origin"]
    sp = json.loads((site_dir / "spine_utm.json").read_text())
    prof = json.loads((site_dir / "profile.json").read_text())
    geology = json.loads((site_dir / "geology.json").read_text()) if (site_dir / "geology.json").exists() else {}
    line = LineString(sp["coords"])
    s = np.arange(0.0, line.length, STEP_M)
    p = np.array([line.interpolate(v).coords[0] for v in s])
    a = np.array([line.interpolate(min(v + 1.0, line.length)).coords[0] for v in s])
    d = a - p
    d /= np.maximum(np.linalg.norm(d, axis=1, keepdims=True), 1e-9)
    normal = np.column_stack([-d[:, 1], d[:, 0]])  # left of travel
    road_z = np.interp(s, prof["s"], prof["road_z"])

    # streams beside the road, for the natural/artificial call
    waters: list[LineString] = []
    osm_p = site_dir / "osm.geojson"
    if osm_p.exists():
        from .geo import Frame

        frame = Frame.at(site["lon"], site["lat"])
        for f in json.loads(osm_p.read_text())["features"]:
            if f["properties"].get("waterway") in ("stream", "river", "canal", "ditch", "drain") and f["geometry"]["type"] == "LineString":
                c = np.array(f["geometry"]["coordinates"])
                x, y = frame.from_wgs(c[:, 0], c[:, 1])
                waters.append(LineString(np.column_stack([x, y])))
    water_dist = np.full(len(s), np.inf)
    if waters:
        import shapely

        pts = shapely.points(p[:, 0], p[:, 1])
        for w in waters:
            water_dist = np.minimum(water_dist, shapely.distance(pts, w))

    # heights: the lidar DTM first, the bare-earth DEM where it has no data (Bonnie Branch's TNM
    # bake covered a sliver of the corridor: 0.4 % valid DTM cells, 2026-09-21)
    from .water import _Heights

    hz = _Heights(site_dir)
    if True:
        def sample(xy: np.ndarray) -> np.ndarray:
            return hz.at(xy[:, 0], xy[:, 1])

        faces: list[dict] = []
        per_side: dict[str, np.ndarray] = {}

        def detect(slope_min: float, rise_min: float, forced_class: str | None) -> None:
            for side, sg in (("left", 1.0), ("right", -1.0)):
                Z = np.zeros((len(s), len(OFFSETS)))
                for j, o in enumerate(OFFSETS):
                    Z[:, j] = sample(p + normal * (sg * o)) - road_z
                with np.errstate(invalid="ignore"):
                    dz = (Z[:, WINDOW:] - Z[:, :-WINDOW]) / WINDOW  # slope of each 5 m window, at OFFSETS[:-WINDOW]
                steep = np.nan_to_num(dz, nan=0.0) > slope_min
                n_toe = int(np.searchsorted(OFFSETS, TOE_MAX))  # windows whose start is inside TOE_MAX
                win = steep[:, :n_toe]
                has = win.any(axis=1)
                first = np.argmax(win, axis=1)
                last = win.shape[1] - 1 - np.argmax(win[:, ::-1], axis=1)
                toe = np.where(has, OFFSETS[first], np.nan)
                top = np.where(has, OFFSETS[last] + WINDOW, np.nan)
                rise = np.full(len(s), np.nan)
                smax = np.full(len(s), np.nan)
                for i in np.flatnonzero(has):
                    j0, j1 = int(first[i]), int(last[i]) + WINDOW
                    rise[i] = Z[i, j1] - Z[i, j0]
                    smax[i] = np.nanmax(dz[i, first[i] : last[i] + 1])
                good = has & (np.nan_to_num(rise) >= rise_min)
                if forced_class is None:
                    per_side[side] = good
                for i0, i1 in _runs(good, GAP_STATIONS):
                    if s[i1] - s[i0] < RUN_MIN:
                        continue
                    if forced_class is not None and any(f["side"] == side and f["s_start"] <= s[i1] and f["s_end"] >= s[i0] for f in faces):
                        continue  # the steep pass already has this stretch
                    sl = slice(i0, i1 + 1)
                    toe_med = float(np.nanmedian(toe[sl]))
                    toe_std = float(np.nanstd(toe[sl]))
                    stations = []
                    for i in range(i0, i1 + 1, max(1, int(round(10.0 / STEP_M)))):
                        if not good[i]:
                            continue
                        t_xy = p[i] + normal[i] * (sg * toe[i])
                        u_xy = p[i] + normal[i] * (sg * top[i])
                        stations.append({
                            "s": round(float(s[i]), 1),
                            "toe": [round(float(t_xy[0] - ox), 1), round(float(t_xy[1] - oy), 1), round(float(road_z[i] + Z[i, int(toe[i] - OFFSETS[0])]), 2)],
                            "top": [round(float(u_xy[0] - ox), 1), round(float(u_xy[1] - oy), 1), round(float(road_z[i] + Z[i, int(top[i] - OFFSETS[0])]), 2)],
                        })
                    near_water = float(np.mean(water_dist[sl] <= WATER_NEAR)) if waters else 0.0
                    mid = float((s[i0] + s[i1]) / 2)
                    strat, lith, descrip = _lith_at(geology, mid)
                    faces.append({
                        "id": f"cut-{side[0]}-{int(round(float(s[i0]))):04d}",
                        "side": side,
                        "s_start": round(float(s[i0]), 1), "s_end": round(float(s[i1]), 1), "length_m": round(float(s[i1] - s[i0]), 1),
                        "toe_m": round(toe_med, 1), "toe_std_m": round(toe_std, 1), "top_m": round(float(np.nanmedian(top[sl])), 1),
                        "height_m": round(float(np.nanmedian(rise[sl])), 1), "height_max_m": round(float(np.nanmax(rise[sl])), 1),
                        "slope": round(float(np.nanmedian(smax[sl])), 2), "slope_max": round(float(np.nanmax(smax[sl])), 2),
                        "water_share": round(near_water, 2),
                        "formation": strat, "lith": lith or (descrip or "")[:80] or None, "rock_type": rock_type(lith, descrip),
                        "stations": stations, "pass": "steep" if forced_class is None else "gentle", "forced_class": forced_class,
                    })

        detect(SLOPE_MIN, RISE_MIN, None)
        detect(NATURAL_SLOPE_MIN, NATURAL_RISE_MIN, "natural")
        # both sides rising over the same stations is a canyon, however straight
        both = per_side["left"] & per_side["right"]
        for f in faces:
            i0, i1 = int(f["s_start"] / STEP_M), int(f["s_end"] / STEP_M)
            two_sided = float(np.mean(both[i0 : i1 + 1]))
            f["two_sided_share"] = round(two_sided, 2)
            natural = f["toe_std_m"] > PARALLEL_STD or f["water_share"] >= 0.5 or (two_sided >= 0.5 and f["water_share"] > 0)
            f["class"] = f.pop("forced_class") or ("natural" if natural else "artificial")
    faces.sort(key=lambda f: f["s_start"])
    summary = {"faces": len(faces), "artificial": sum(f["class"] == "artificial" for f in faces), "natural": sum(f["class"] == "natural" for f in faces), "total_length_m": round(sum(f["length_m"] for f in faces), 1), "tallest_m": max((f["height_max_m"] for f in faces), default=0.0), "rock_types": sorted({f["rock_type"] for f in faces})}
    out = {"step_m": STEP_M, "thresholds": {"slope_min": SLOPE_MIN, "rise_min_m": RISE_MIN, "natural_slope_min": NATURAL_SLOPE_MIN, "natural_rise_min_m": NATURAL_RISE_MIN, "toe_max_m": TOE_MAX, "run_min_m": RUN_MIN, "window_m": WINDOW, "parallel_std_m": PARALLEL_STD, "water_near_m": WATER_NEAR}, "faces": faces, "summary": summary}
    (site_dir / "cuts.json").write_text(json.dumps(out))
    return out


def main() -> None:
    import sys

    from .__main__ import DATA

    slugs = sys.argv[1:] or [d.name for d in sorted((DATA / "sites").glob("*")) if d.is_dir()]
    for slug in slugs:
        r = measure(DATA / "sites" / slug)
        if r is None:
            print(f"{slug:24s} no lidar/profile")
            continue
        sm = r["summary"]
        print(f"{slug:24s} {sm['faces']} faces ({sm['artificial']} artificial, {sm['natural']} natural), {sm['total_length_m']:.0f} m, tallest {sm['tallest_m']} m, rock {sm['rock_types']}")
        for f in r["faces"]:
            print(f"   {f['id']:12s} {f['class']:10s} s {f['s_start']:6.0f}-{f['s_end']:6.0f} ({f['length_m']:5.0f} m) toe {f['toe_m']:4.0f}±{f['toe_std_m']:.1f} height {f['height_m']:5.1f} (max {f['height_max_m']:.1f}) slope {f['slope']:.2f} water {f['water_share']:.2f} two-sided {f['two_sided_share']:.2f} {f['rock_type']} <- {f['formation']}")


if __name__ == "__main__":
    main()
