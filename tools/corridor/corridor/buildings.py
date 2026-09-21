"""Buildings, land use and points of interest, in corridor coordinates, for autogen.

The editor agent's spec (tools/corridor/AUTOGEN.md §10). Per footprint, three things the browser
should never have to derive: the minimum rotated rectangle (a strip mall is long, a house is not,
and the long axis is the honest yaw on a corner lot), a height from the best source available,
and the corridor position — along-track metre `s` and SIGNED lateral offset `lat` of the centroid
(positive = left of travel), because every placement rule is written against the road.

Height chain: OSM `height` → OSM `building:levels` × 3.2 → lidar DSM minus DTM over the footprint
(median of the top quartile, so a tree over one corner does not become the roof) → 6 m default,
with `height_src` recording which. Overture is not fetched in this pipeline yet; when it is, it
slots in ahead of OSM.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from shapely.geometry import LineString, Point, Polygon, shape
from shapely.ops import transform as shp_transform

from .geo import Frame

MIN_AREA = 15.0
SIMPLIFY = 0.5
LEVEL_M = 3.2
DEFAULT_H = 6.0
POI_KEYS = ("amenity", "shop", "tourism", "office", "leisure", "craft", "healthcare")
# tagged, but not a place: parking bays and street furniture were 80% of the first run's POIs
POI_NOISE = {"amenity=parking_space", "amenity=parking", "amenity=bench", "amenity=waste_basket", "amenity=bicycle_parking", "amenity=vending_machine", "amenity=charging_station", "amenity=shelter", "amenity=loading_dock", "leisure=pitch", "leisure=picnic_table", "amenity=parking_entrance"}


def _to_site(geom, frame: Frame, ox: float, oy: float):
    return shp_transform(lambda x, y, z=None: (frame.from_wgs(x, y)[0] - ox, frame.from_wgs(x, y)[1] - oy), geom)


def _num(v) -> float | None:
    if v is None:
        return None
    try:
        s = str(v).strip().split(";")[0]
        if s.endswith("m"):
            s = s[:-1]
        if s.endswith("ft") or s.endswith("'"):
            return float(s.rstrip("ft'").strip()) * 0.3048
        return float(s)
    except ValueError:
        return None


def _lidar_height(ring_site: Polygon, site_dir: Path, ox: float, oy: float) -> float | None:
    dsm_p, dtm_p = site_dir / "lidar" / "dsm.tif", site_dir / "lidar" / "dtm.tif"
    if not (dsm_p.exists() and dtm_p.exists()):
        return None
    import rasterio
    from rasterio.mask import mask
    from shapely.affinity import translate

    poly = translate(ring_site, ox, oy)
    try:
        with rasterio.open(dsm_p) as dsm, rasterio.open(dtm_p) as dtm:
            a, _ = mask(dsm, [poly.__geo_interface__], crop=True, filled=False)
            b, _ = mask(dtm, [poly.__geo_interface__], crop=True, filled=False)
    except Exception:
        return None
    top = np.ma.masked_where(a[0] <= -9000, a[0])
    ground = np.ma.masked_where(b[0] <= -9000, b[0])
    if top.count() < 4 or ground.count() < 4:
        return None
    h = top - float(np.ma.median(ground))
    h = h.compressed()
    if len(h) < 4:
        return None
    q = np.percentile(h, 75)
    return float(np.median(h[h >= q])) if (h >= q).any() else float(np.median(h))


def derive(site_dir: Path) -> dict:
    site = json.loads((site_dir / "site.json").read_text())
    frame = Frame.at(site["lon"], site["lat"])
    ox, oy = site["frame"]["origin"]
    spine = json.loads((site_dir / "spine_utm.json").read_text())
    line = LineString([(x - ox, y - oy) for x, y in spine["coords"]])
    feats = json.loads((site_dir / "osm.geojson").read_text())["features"]

    def corridor_pos(pt: Point) -> tuple[float, float]:
        s = line.project(pt)
        on = line.interpolate(s)
        ahead = line.interpolate(min(line.length, s + 1.0))
        dx, dy = ahead.x - on.x, ahead.y - on.y
        n = np.hypot(dx, dy) or 1.0
        # left of travel is (-dy, dx)
        lat = ((pt.x - on.x) * (-dy) + (pt.y - on.y) * dx) / n
        return round(float(s), 1), round(float(lat), 1)

    buildings: list[dict] = []
    for f in feats:
        p = f["properties"]
        if "building" not in p or f["geometry"]["type"] != "Polygon":
            continue
        try:
            g = _to_site(shape(f["geometry"]), frame, ox, oy)
        except Exception:
            continue
        if not g.is_valid:
            g = g.buffer(0)
        if g.is_empty or g.area < MIN_AREA:
            continue
        rect = g.minimum_rotated_rectangle
        rc = list(rect.exterior.coords)
        e1 = np.hypot(rc[1][0] - rc[0][0], rc[1][1] - rc[0][1])
        e2 = np.hypot(rc[2][0] - rc[1][0], rc[2][1] - rc[1][1])
        if e1 >= e2:
            w, d, yaw = e1, e2, np.degrees(np.arctan2(rc[1][1] - rc[0][1], rc[1][0] - rc[0][0]))
        else:
            w, d, yaw = e2, e1, np.degrees(np.arctan2(rc[2][1] - rc[1][1], rc[2][0] - rc[1][0]))
        yaw = float(yaw % 180.0)
        h = _num(p.get("height"))
        src = "osm"
        if h is None:
            lv = _num(p.get("building:levels"))
            if lv:
                h = lv * LEVEL_M
        if h is None:
            h = _lidar_height(g, site_dir, ox, oy)
            src = "lidar"
        if h is None or h < 2.0:
            h, src = DEFAULT_H, "default"
        s, lat = corridor_pos(g.centroid)
        ring = [[round(x, 1), round(y, 1)] for x, y in g.simplify(SIMPLIFY).exterior.coords[:-1]]
        buildings.append({
            "ring": ring, "area_m2": round(float(g.area), 1),
            "rect": {"w": round(float(w), 1), "d": round(float(d), 1), "yaw_deg": round(yaw, 1)},
            "height_m": round(float(h), 1), "height_src": src, "s": s, "lat": lat,
            "tags": {k: v for k, v in p.items() if k in ("building", "name", "height", "building:levels", "addr:street") or k in POI_KEYS},
            "_geom": g,
        })

    landuse = []
    for f in feats:
        p = f["properties"]
        if "landuse" not in p or f["geometry"]["type"] != "Polygon":
            continue
        try:
            g = _to_site(shape(f["geometry"]), frame, ox, oy)
        except Exception:
            continue
        if g.is_empty:
            continue
        # what is GROWN there, when OSM says (Rich, 2026-09-21: "there is a farm at the end of my
        # neighborhood where they grow usually corn and soy"). OSM tags it as `crop=maize;soybean`
        # or `produce=*` on the farmland way; row detection from NAIP is not worth it, so where OSM
        # is silent this stays null and the editor authors it.
        crop = p.get("crop") or p.get("produce") or p.get("trees")
        crops = [c.strip() for c in str(crop).split(";") if c.strip()] if crop else None
        landuse.append({"class": p["landuse"], "ring": [[round(x, 1), round(y, 1)] for x, y in g.simplify(1.0).exterior.coords[:-1]], "area_m2": round(float(g.area), 1), "crop": crops, "name": p.get("name")})

    pois = []
    for f in feats:
        p = f["properties"]
        kind = next((f"{k}={p[k]}" for k in POI_KEYS if k in p), None)
        if not kind or kind in POI_NOISE:
            continue
        try:
            g = _to_site(shape(f["geometry"]), frame, ox, oy)
        except Exception:
            continue
        c = g.centroid if not g.is_empty else None
        if c is None:
            continue
        s, lat = corridor_pos(c)
        bidx = next((i for i, b in enumerate(buildings) if b["_geom"].contains(c)), None)
        pois.append({"x": round(c.x, 1), "y": round(c.y, 1), "s": s, "lat": lat, "kind": kind, "name": p.get("name"), "building": bidx})
        # a POI inside a footprint lends its tags to the building — the 85% tagged only building=yes
        if bidx is not None:
            for k in POI_KEYS:
                if k in p and k not in buildings[bidx]["tags"]:
                    buildings[bidx]["tags"][k] = p[k]
            if p.get("name") and "name" not in buildings[bidx]["tags"]:
                buildings[bidx]["tags"]["name"] = p["name"]

    for b in buildings:
        del b["_geom"]
    srcs: dict[str, int] = {}
    for b in buildings:
        srcs[b["height_src"]] = srcs.get(b["height_src"], 0) + 1
    return {"buildings": buildings, "landuse": landuse, "pois": pois, "summary": {"buildings": len(buildings), "height_src": srcs, "landuse": len(landuse), "pois": len(pois)}}
