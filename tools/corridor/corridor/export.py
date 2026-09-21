"""Web export: the site, in the shapes a browser can decode without a GIS stack.

GeoTIFFs are the archive. A viewer (apps/corridor) and eventually the game want small, decodable
layers, all on the same lattice, with a manifest that says where each one sits in the site frame:

    web/dem_2m.png       height, RGB-encoded uint16 (R = high byte, G = low byte) in centimetres
                         above `zmin`. Why RGB and not a 16-bit PNG: browsers decode 16-bit PNGs to
                         8 bits per channel on the canvas, silently. Two 8-bit channels survive.
    web/chm_2m.png       canopy height, 8-bit, 0.25 m per step (0-63 m), on the DEM lattice
    web/naip_1m.jpg      imagery, 1 m/px (6600×1300 for a corridor; one texture)
    web/horizon_60m.png  the far terrain, same encoding as the DEM, 1000² over 60 km
    web/manifest.json    frame, per-layer georeferencing, the spine with z, structures, crossings,
                         profile every 10 m, geology, photos. Coordinates are METRES RELATIVE TO
                         THE SITE ORIGIN so the viewer never sees a six-digit easting.

`sites/index.json` lists every exported site. Both are what `publish` puts in the bucket and what
the Worker will hand the browser, so the viewer is already reading the production shape.
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from rasterio.enums import Resampling
from shapely.geometry import LineString

from .geo import Frame

Z_SCALE = 0.01  # metres per count; 655 m of range in a uint16


def _fill(a: np.ndarray, nodata: float) -> np.ndarray:
    from scipy import ndimage

    bad = ~np.isfinite(a) | (a <= nodata + 1)
    if bad.any() and not bad.all():
        idx = ndimage.distance_transform_edt(bad, return_distances=False, return_indices=True)
        a = a[tuple(idx)]
    return a


def _encode_height(z: np.ndarray) -> tuple[np.ndarray, float, float]:
    zmin = float(np.floor(np.nanmin(z)))
    scale = Z_SCALE
    while (np.nanmax(z) - zmin) / scale > 65000:
        scale *= 2
    q = np.clip(np.round((z - zmin) / scale), 0, 65535).astype(np.uint16)
    rgb = np.zeros((*q.shape, 3), np.uint8)
    rgb[..., 0] = q >> 8
    rgb[..., 1] = q & 0xFF
    return rgb, zmin, scale


def _read_at(path: Path, res: float, bbox=None) -> tuple[np.ndarray, dict]:
    with rasterio.open(path) as src:
        b = src.bounds
        if bbox is None:
            bbox = (b.left, b.bottom, b.right, b.top)
        w = int(round((bbox[2] - bbox[0]) / res))
        h = int(round((bbox[3] - bbox[1]) / res))
        from rasterio.windows import from_bounds

        win = from_bounds(*bbox, transform=src.transform)
        a = src.read(1, window=win, out_shape=(h, w), resampling=Resampling.average, boundless=True, fill_value=src.nodata if src.nodata is not None else 0)
        nodata = src.nodata
    return a.astype(np.float32), {"bbox": [float(v) for v in bbox], "res": res, "size": [w, h], "nodata": nodata}



def _smooth_on_line(raw, sigma: float = 15.0, max_dev: float = 1.5):
    """Smooth the digitising jitter out of a centreline WITHOUT leaving the road.

    A plain gaussian over the vertices cuts corners: at sigma 15 samples (30 m) the spine left the
    real centreline by up to 10.6 m on a bend, which is the road sitting visibly beside its own
    trace in the air photo (Rich, 2026-09-21). Angular paint and a snapping camera were why the
    smoothing went in, and those come from vertex-to-vertex direction changes, not from position —
    so smooth, then pull every point back to within `max_dev` of the raw polyline. Jitter of a
    metre disappears; a real curve is kept.
    """
    import numpy as np
    from scipy.ndimage import gaussian_filter1d
    from shapely.geometry import LineString, Point

    if len(raw) < 4:
        return raw
    sm = np.column_stack([gaussian_filter1d(raw[:, 0], sigma, mode="nearest"), gaussian_filter1d(raw[:, 1], sigma, mode="nearest")])
    sm[0], sm[-1] = raw[0], raw[-1]
    line = LineString(raw)
    for i in range(1, len(sm) - 1):
        p = Point(sm[i])
        d = p.distance(line)
        if d > max_dev:
            q = line.interpolate(line.project(p))
            f = (d - max_dev) / d
            sm[i] = (sm[i][0] + (q.x - sm[i][0]) * f, sm[i][1] + (q.y - sm[i][1]) * f)
    return sm


def _service_ways(site_dir: Path, frame, ox: float, oy: float, bbox) -> list[dict]:
    """Driveways and other unnamed asphalt: `highway=service` inside the site.

    Rich's court has a driveway to every house in OSM and we were throwing them away — the roads
    list only keeps named ways, so the world had houses standing in grass. These are drawn
    unmarked and narrow. Their grade is the bare-earth DEM (a driveway is never a bridge), lightly
    smoothed, and the viewer drops them onto the strip where one covers them.
    """
    gj_p = site_dir / "osm.geojson"
    if not gj_p.exists():
        return []
    import rasterio
    from shapely.geometry import LineString, box
    from shapely.ops import transform as shp_transform

    WIDTH = {"driveway": 3.2, "parking_aisle": 5.0, "alley": 3.6}
    site_box = box(bbox[0], bbox[1], bbox[2], bbox[3])
    dem_p = site_dir / "dem_1m.tif"
    src = rasterio.open(dem_p) if dem_p.exists() else None
    out: list[dict] = []
    for f in json.loads(gj_p.read_text())["features"]:
        p = f["properties"]
        if p.get("highway") != "service" or f["geometry"]["type"] != "LineString":
            continue
        try:
            ln = shp_transform(lambda x, y, z=None: frame.from_wgs(x, y), LineString(f["geometry"]["coordinates"]))
        except Exception:
            continue
        ln = ln.intersection(site_box)
        for part in (ln.geoms if ln.geom_type == "MultiLineString" else [ln]):
            if part.is_empty or part.geom_type != "LineString" or part.length < 8:
                continue
            step = 4.0
            ss = np.arange(0.0, part.length, step).tolist() + [part.length]
            pts = np.array([part.interpolate(v).coords[0] for v in ss])
            if src is not None:
                zs = np.array([v[0] for v in src.sample([(float(x), float(y)) for x, y in pts])], dtype=float)
                zs[zs < -9000] = np.nan
                if np.isfinite(zs).any():
                    ok = np.isfinite(zs)
                    zs[~ok] = np.interp(np.flatnonzero(~ok), np.flatnonzero(ok), zs[ok])
                    if len(zs) > 4:
                        zs = np.convolve(np.pad(np.nan_to_num(zs), 2, mode="edge"), np.ones(5) / 5, mode="valid")
                else:
                    zs = np.zeros(len(pts))
            else:
                zs = np.zeros(len(pts))
            out.append({
                "service": p.get("service") or "service",
                "width_m": WIDTH.get(p.get("service", ""), 3.6),
                "surface": p.get("surface"),
                "coords": np.column_stack([pts[:, 0] - ox, pts[:, 1] - oy, np.nan_to_num(zs)]).round(2).tolist(),
            })
    if src is not None:
        src.close()
    return out


def _our_lines(site_dir: Path):
    """Every carriageway we already draw, in ABSOLUTE UTM — the same frame the OSM ways arrive in.

    (They were built in the site frame once and every distance came out at 4.3 million metres,
    which is the origin, so no road was ever "near" another.)
    """
    from shapely.geometry import LineString, MultiLineString

    out = []
    sp_p = site_dir / "spine_utm.json"
    if sp_p.exists():
        sp = json.loads(sp_p.read_text())
        out.append(LineString(sp["coords"]))
        for sib in sp.get("siblings", []):
            g = sib["geometry"]
            parts = [g["coordinates"]] if g["type"] == "LineString" else g["coordinates"]
            for part in parts:
                if len(part) > 1:
                    out.append(LineString(part))
    return MultiLineString(out) if out else None


def _stub_roads(site_dir: Path, frame, ox: float, oy: float, bbox) -> list[dict]:
    """The roads we do NOT model, stubbed a little way in from where they meet the ones we do.

    "When we bake a road, detect when we intersect another road even if it isn't part of the
    network, and draw at least a portion of it so it doesn't appear overgrown with grass — fine if
    it dead ends 100 or 200 feet later" (Rich, 2026-09-21). A junction with nothing on the far
    side reads as a mowed gap in the trees; 60 m of asphalt reads as a road going somewhere.
    """
    gj_p = site_dir / "osm.geojson"
    ours = _our_lines(site_dir)
    if not gj_p.exists() or ours is None:
        return []
    import rasterio
    from shapely.geometry import LineString, box
    from shapely.ops import transform as shp_transform

    DRIVABLE = {"motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential", "living_street", "track"}
    LANES = {"motorway": 4, "trunk": 4, "primary": 2, "secondary": 2, "tertiary": 2, "unclassified": 2, "residential": 2, "living_street": 1, "track": 1}
    STUB_M = 60.0
    site_box = box(*bbox)
    dem_p = site_dir / "dem_1m.tif"
    src = rasterio.open(dem_p) if dem_p.exists() else None
    out: list[dict] = []
    for f in json.loads(gj_p.read_text())["features"]:
        p = f["properties"]
        hw = p.get("highway")
        if hw not in DRIVABLE or f["geometry"]["type"] != "LineString":
            continue
        try:
            ln = shp_transform(lambda x, y, z=None: frame.from_wgs(x, y), LineString(f["geometry"]["coordinates"]))
        except Exception:
            continue
        ln = ln.intersection(site_box)
        for part in (ln.geoms if ln.geom_type == "MultiLineString" else [ln]):
            if part.is_empty or part.geom_type != "LineString" or part.length < 6:
                continue
            # where does this way meet ours? sample it and find the closest approach
            n = max(2, int(part.length // 5))
            ss = np.linspace(0.0, part.length, n)
            ds = np.array([ours.distance(part.interpolate(float(v))) for v in ss])
            i = int(np.argmin(ds))
            if ds[i] > 12.0:
                continue  # not a junction with us: some other road passing through the box
            # …and not a road we already draw. A way that RUNS ALONG one of ours (most of its
            # length within 6 m) is the same road, named or not; stub only what branches off.
            if float(np.mean(ds < 6.0)) > 0.5:
                continue
            meet = float(ss[i])
            # our own carriageway occupies the first few metres; start clear of it
            lo, hi = max(0.0, meet - STUB_M), min(part.length, meet + STUB_M)
            keep = LineString([part.interpolate(float(v)).coords[0] for v in np.arange(lo, hi, 4.0).tolist() + [hi]])
            if keep.length < 12:
                continue
            pts = np.array(keep.coords)
            if src is not None:
                zs = np.array([v[0] for v in src.sample([(float(x), float(y)) for x, y in pts])], dtype=float)
                zs[zs < -9000] = np.nan
                if np.isfinite(zs).any():
                    ok = np.isfinite(zs)
                    zs[~ok] = np.interp(np.flatnonzero(~ok), np.flatnonzero(ok), zs[ok])
                    if len(zs) > 4:
                        zs = np.convolve(np.pad(np.nan_to_num(zs), 2, mode="edge"), np.ones(5) / 5, mode="valid")
                else:
                    zs = np.zeros(len(pts))
            else:
                zs = np.zeros(len(pts))
            out.append({
                "highway": hw, "name": p.get("name") or p.get("ref"),
                "lanes": int(p["lanes"]) if str(p.get("lanes", "")).isdigit() else LANES.get(hw, 2),
                "oneway": p.get("oneway"),
                "coords": np.column_stack([pts[:, 0] - ox, pts[:, 1] - oy, np.nan_to_num(zs)]).round(2).tolist(),
            })
    if src is not None:
        src.close()
    return out


DRIVABLE = (
    "motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential",
    "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link", "living_street",
)


def _bearing(dx: float, dy: float) -> float:
    """Compass bearing of a vector in UTM metres (x east, y north): 0 = north, 90 = east."""
    return math.degrees(math.atan2(dx, dy)) % 360.0


def _road_index(features) -> dict:
    """Every drivable way's vertices, keyed by exact WGS84 coordinate.

    A `highway=traffic_signals` node is not a free-floating point: OSM puts it ON the way it
    governs, as one of its vertices, and at a junction the SAME node is a vertex of every arm. So
    the way to find out what a signal governs, and which way the traffic runs, is to look the
    node's own coordinate up among the vertices — no geometry search and no tolerance needed,
    because these are the same floats from the same extract.
    """
    idx: dict[tuple, list] = {}
    for f in features:
        p = f["properties"]
        if p.get("highway") not in DRIVABLE or f["geometry"]["type"] != "LineString":
            continue
        cs = f["geometry"]["coordinates"]
        for i, c in enumerate(cs):
            idx.setdefault((c[0], c[1]), []).append((f, i))
    return idx


def _lanes_of(p: dict) -> int:
    for k in ("lanes", "lanes:forward"):
        try:
            n = int(str(p.get(k, "")).split(";")[0])
            if 1 <= n <= 12:
                return n
        except (TypeError, ValueError):
            pass
    hw = p.get("highway", "")
    return 4 if hw in ("motorway", "trunk", "primary") else 2


def _signals(site_dir: Path, frame, ox: float, oy: float, bbox) -> dict:
    """Traffic signals, stop and give-way signs.

    Crofton has 218 `highway=traffic_signals` nodes and we draw none of them, which is most of why
    a signalised suburban junction reads as a crossroads in a field.

    A signal node carries no bearing of its own, so the bearing comes from the geometry: look the
    node up in the road index to get the arm it sits on, group the nodes of one junction together
    (they are within a few tens of metres of each other), and the direction of travel on that arm
    is from the node toward the group's centre. The heads then face BACK along that, at the
    traffic. `traffic_signals:direction` is used where OSM has it (112 of the 218 here), because a
    forward/backward tag beats an inference.

    Isolated signals — a mid-block pedestrian crossing, of which there are many — have no junction
    to point at, so they take the arm's own tangent and the OSM direction tag.
    """
    gj_p = site_dir / "osm.geojson"
    if not gj_p.exists():
        return {"masts": [], "signs": []}
    import rasterio
    from shapely.geometry import Point, box

    site_box = box(*bbox)
    dem_p = site_dir / "dem_1m.tif"
    src = rasterio.open(dem_p) if dem_p.exists() else None

    def ground(x: float, y: float) -> float:
        if src is None:
            return 0.0
        v = next(src.sample([(float(x), float(y))]))[0]
        return 0.0 if v < -9000 else float(v)

    features = json.loads(gj_p.read_text())["features"]
    idx = _road_index(features)

    # the signal nodes, in UTM, with the arm they sit on
    nodes = []
    for f in features:
        p = f["properties"]
        if p.get("highway") != "traffic_signals" or f["geometry"]["type"] != "Point":
            continue
        lon, lat = f["geometry"]["coordinates"][:2]
        x, y = frame.from_wgs(lon, lat)
        if not site_box.contains(Point(x, y)):
            continue
        ways = idx.get((lon, lat), [])
        if not ways:
            continue  # a signal on a way we do not draw (a cycleway, a private service road)
        nodes.append({"x": x, "y": y, "lon": lon, "lat": lat, "ways": ways, "dir": p.get("traffic_signals:direction")})

    # junctions: signal nodes within JUNCTION_R of each other are arms of one crossing
    JUNCTION_R = 45.0
    unassigned = list(range(len(nodes)))
    groups: list[list[int]] = []
    while unassigned:
        seed = unassigned.pop()
        grp = [seed]
        changed = True
        while changed:
            changed = False
            for i in list(unassigned):
                if any(math.hypot(nodes[i]["x"] - nodes[j]["x"], nodes[i]["y"] - nodes[j]["y"]) <= JUNCTION_R for j in grp):
                    grp.append(i)
                    unassigned.remove(i)
                    changed = True
        groups.append(grp)

    masts = []
    for grp in groups:
        cx = sum(nodes[i]["x"] for i in grp) / len(grp)
        cy = sum(nodes[i]["y"] for i in grp) / len(grp)
        for i in grp:
            n = nodes[i]
            way, vi = n["ways"][0]
            cs = way["geometry"]["coordinates"]
            # the arm's own tangent at this vertex, in UTM
            a = cs[max(0, vi - 1)]
            b = cs[min(len(cs) - 1, vi + 1)]
            ax, ay = frame.from_wgs(a[0], a[1])
            bx, by = frame.from_wgs(b[0], b[1])
            tx, ty = bx - ax, by - ay
            tl = math.hypot(tx, ty) or 1.0
            tx, ty = tx / tl, ty / tl
            # which way does traffic run? toward the junction centre when there is one, otherwise
            # the tag, otherwise the tangent as it lies
            dx, dy = cx - n["x"], cy - n["y"]
            d = math.hypot(dx, dy)
            if len(grp) > 1 and d > 3.0:
                # project the centre direction onto the arm, so the signal stays on its own road
                sgn = 1.0 if (dx * tx + dy * ty) >= 0 else -1.0
                trav = (tx * sgn, ty * sgn)
            else:
                sgn = -1.0 if n["dir"] == "backward" else 1.0
                trav = (tx * sgn, ty * sgn)
            heads = _bearing(-trav[0], -trav[1])  # the heads look back at the traffic
            lanes = _lanes_of(way["properties"])
            masts.append({
                "x": round(float(n["x"] - ox), 2),
                "y": round(float(n["y"] - oy), 2),
                "z": round(ground(n["x"], n["y"]), 2),
                "yaw_deg": round(heads, 1),            # compass bearing the heads face
                "travel_deg": round(_bearing(*trav), 1),
                "arm_m": round(lanes * 3.66 / 2 + 1.4, 2),
                "lanes": lanes,
                "junction": len(grp),
                "tagged": bool(n["dir"]),
            })

    # stop and give-way: a sign on a post, facing the traffic it stops
    signs = []
    for f in features:
        p = f["properties"]
        kind = p.get("highway")
        if kind not in ("stop", "give_way") or f["geometry"]["type"] != "Point":
            continue
        lon, lat = f["geometry"]["coordinates"][:2]
        x, y = frame.from_wgs(lon, lat)
        if not site_box.contains(Point(x, y)):
            continue
        ways = idx.get((lon, lat), [])
        if not ways:
            continue
        way, vi = ways[0]
        cs = way["geometry"]["coordinates"]
        a = cs[max(0, vi - 1)]
        b = cs[min(len(cs) - 1, vi + 1)]
        ax, ay = frame.from_wgs(a[0], a[1])
        bx, by = frame.from_wgs(b[0], b[1])
        tx, ty = bx - ax, by - ay
        tl = math.hypot(tx, ty) or 1.0
        sgn = -1.0 if p.get("direction") == "backward" else 1.0
        trav = (tx / tl * sgn, ty / tl * sgn)
        signs.append({
            "kind": kind,
            "x": round(float(x - ox), 2),
            "y": round(float(y - oy), 2),
            "z": round(ground(x, y), 2),
            "yaw_deg": round(_bearing(-trav[0], -trav[1]), 1),
            "travel_deg": round(_bearing(*trav), 1),
        })

    if src is not None:
        src.close()
    return {"masts": masts, "signs": signs}


def _parking(site_dir: Path, frame, ox: float, oy: float, bbox) -> list[dict]:
    """`amenity=parking` areas: the asphalt a shopping centre is mostly made of.

    Crofton has 233 of them, from a 34 m² pull-in to a 64 000 m² park-and-ride, and we drew none —
    so every strip mall on the site was a building standing in grass with a road going past it.

    Only the ring and what OSM says about it comes out here. Whether a lot overlaps a carriageway,
    and where its stalls go, are both decided in the viewer: the first because only the viewer
    knows which roads are actually drawn, and the second because the aisles are already in the
    manifest as `driveways` with `service=parking_aisle` and there is no reason to carry them twice.

    Multi-storey and underground lots are tagged and passed through rather than dropped, because
    the viewer wants to NOT pave a roof or a basement, and it cannot tell without being told.
    """
    gj_p = site_dir / "osm.geojson"
    if not gj_p.exists():
        return []
    import rasterio
    from shapely.geometry import Polygon, box
    from shapely.ops import transform as shp_transform

    site_box = box(*bbox)
    dem_p = site_dir / "dem_1m.tif"
    src = rasterio.open(dem_p) if dem_p.exists() else None
    out: list[dict] = []
    for f in json.loads(gj_p.read_text())["features"]:
        p = f["properties"]
        if p.get("amenity") != "parking" or f["geometry"]["type"] != "Polygon":
            continue
        try:
            poly = shp_transform(lambda x, y, z=None: frame.from_wgs(x, y), Polygon(f["geometry"]["coordinates"][0], f["geometry"]["coordinates"][1:]))
        except Exception:
            continue
        if not poly.is_valid:
            poly = poly.buffer(0)
        poly = poly.intersection(site_box)
        if poly.is_empty:
            continue
        for part in (poly.geoms if poly.geom_type == "MultiPolygon" else [poly]):
            if part.geom_type != "Polygon" or part.area < 60:
                continue
            ring = [[round(float(x - ox), 2), round(float(y - oy), 2)] for x, y in part.exterior.coords[:-1]]
            if len(ring) < 3:
                continue
            cx, cy = part.centroid.x, part.centroid.y
            z = 0.0
            if src is not None:
                v = next(src.sample([(float(cx), float(cy))]))[0]
                z = 0.0 if v < -9000 else float(v)
            out.append({
                "kind": p.get("parking") or "surface",
                "surface": p.get("surface"),
                "access": p.get("access"),
                "name": p.get("name"),
                "area_m2": round(float(part.area), 1),
                "z": round(z, 2),
                "ring": ring,
                "holes": [[[round(float(x - ox), 2), round(float(y - oy), 2)] for x, y in h.coords[:-1]] for h in part.interiors],
            })
    if src is not None:
        src.close()
    return out


def _power(site_dir: Path, frame, ox: float, oy: float, bbox) -> dict:
    """Power lines and their supports: `power=line|minor_line` ways, `power=tower|pole` nodes.

    Wires and poles are most of what a rural roadside actually looks like, and they are in the
    data already — Rich's region has 247 towers and 304 poles. Support heights are OSM's when
    tagged, otherwise by kind.
    """
    gj_p = site_dir / "osm.geojson"
    if not gj_p.exists():
        return {"lines": [], "supports": []}
    import rasterio
    from shapely.geometry import LineString, Point, box
    from shapely.ops import transform as shp_transform

    HEIGHT = {"tower": 26.0, "pole": 9.5, "portal": 18.0}
    site_box = box(*bbox)
    dem_p = site_dir / "dem_1m.tif"
    src = rasterio.open(dem_p) if dem_p.exists() else None

    def ground(x: float, y: float) -> float:
        if src is None:
            return 0.0
        v = next(src.sample([(float(x), float(y))]))[0]
        return 0.0 if v < -9000 else float(v)

    lines, supports = [], []
    for f in json.loads(gj_p.read_text())["features"]:
        p = f["properties"]
        pw = p.get("power")
        g = f["geometry"]
        if pw in ("line", "minor_line") and g["type"] == "LineString":
            try:
                ln = shp_transform(lambda x, y, z=None: frame.from_wgs(x, y), LineString(g["coordinates"])).intersection(site_box)
            except Exception:
                continue
            for part in (ln.geoms if ln.geom_type == "MultiLineString" else [ln]):
                if part.is_empty or part.geom_type != "LineString" or part.length < 20:
                    continue
                pts = np.array(part.coords)
                lines.append({
                    "kind": pw, "voltage": p.get("voltage"), "circuits": p.get("circuits"),
                    "coords": [[round(float(x - ox), 2), round(float(y - oy), 2), round(ground(x, y), 2)] for x, y in pts],
                })
        elif pw in ("tower", "pole", "portal") and g["type"] == "Point":
            x, y = frame.from_wgs(*g["coordinates"][:2])
            if not site_box.contains(Point(x, y)):
                continue
            h = None
            try:
                h = float(str(p.get("height", "")).rstrip("m ").strip())
            except ValueError:
                h = None
            supports.append({"kind": pw, "x": round(float(x - ox), 2), "y": round(float(y - oy), 2), "z": round(ground(x, y), 2), "height_m": h or HEIGHT.get(pw, 10.0)})
    if src is not None:
        src.close()
    return {"lines": lines, "supports": supports}

def export_site(site_dir: Path) -> dict:
    site = json.loads((site_dir / "site.json").read_text())
    manifest = json.loads((site_dir / "manifest.json").read_text()) if (site_dir / "manifest.json").exists() else {}
    ox, oy = site["frame"]["origin"]
    bbox = tuple(site["bbox_utm"])
    web = site_dir / "web"
    web.mkdir(exist_ok=True)
    layers: dict = {}

    def rel_bbox(b):
        return [b[0] - ox, b[1] - oy, b[2] - ox, b[3] - oy]

    # network sites over 6 km go out as 1 km tiles (network_tiles.export_tiles, below); the
    # single-image dem/chm/naip blocks are skipped for them — an 18 km DEM PNG is 85 M pixels
    tiled = bool(manifest.get("tiled"))

    # --- near terrain --------------------------------------------------------------------------
    if (site_dir / "dem_1m.tif").exists() and not tiled:
        z, g = _read_at(site_dir / "dem_1m.tif", 2.0, bbox)
        z = _fill(z, -9999)
        rgb, zmin, scale = _encode_height(z)
        Image.fromarray(rgb, "RGB").save(web / "dem_2m.png", optimize=True)
        layers["dem"] = {"file": "dem_2m.png", "res": 2.0, "size": g["size"], "bbox": rel_bbox(g["bbox"]), "zmin": zmin, "zscale": scale}

    # buildings / landuse / POIs in corridor coordinates (AUTOGEN.md §10) — derived here, before the
    # canopy layer, because the canopy mask below needs the footprints. (The first version read them
    # from web/buildings.json, a file nothing ever wrote: the mask was a silent no-op on all nine
    # sites — found by the editor agent with probes/chm-buildings-check.py, 2026-09-21.)
    try:
        from . import buildings as bld
        derived = bld.derive(site_dir)
    except Exception as exc:
        print(f"  buildings failed: {exc}")
        derived = {"buildings": [], "landuse": [], "pois": [], "summary": {}}

    # --- canopy on the same lattice ------------------------------------------------------------
    chm_path = site_dir / "lidar" / "chm.tif"
    if chm_path.exists() and "dem" in layers and not tiled:
        c, g = _read_at(chm_path, 2.0, bbox)  # boundless: 0 outside the lidar corridor
        c = np.nan_to_num(c, nan=0.0)
        # The canopy model is "unclassified points above ground", and on a working interstate that
        # includes every truck the flight caught: a tractor-trailer is a 4 m "tree" on the pavement.
        # Zero the canopy over both carriageways (paved width + 2 m) so nothing grows on the road.
        from rasterio.features import rasterize
        from rasterio.transform import from_origin

        sp0 = json.loads((site_dir / "spine_utm.json").read_text())
        lanes_max = 2
        for seg in sp0.get("segments", []):
            try:
                lanes_max = max(lanes_max, int(seg["tags"].get("lanes", 2)))
            except ValueError:
                pass
        half = (lanes_max * 3.66 + 4.2) / 2 + 2.0
        shapes = [(LineString(sp0["coords"]).buffer(half, cap_style="flat"), 1)]
        for sib in sp0.get("siblings", []):
            gg = sib["geometry"]
            parts = [gg["coordinates"]] if gg["type"] == "LineString" else gg["coordinates"]
            for part in parts:
                if len(part) > 1:
                    shapes.append((LineString(part).buffer(half, cap_style="flat"), 1))
        tr2 = from_origin(g["bbox"][0], g["bbox"][3], 2.0, 2.0)
        # A roof is the same problem as a truck: this lidar has no vegetation classes, canopy is
        # "unassigned above ground", so every building footprint is also a 6 m tree — and autogen
        # now stands a model on each one (editor agent, 2026-09-21). Zero the canopy under every
        # OSM footprint (+1 m), in the bake, so viewer, editor and preview all get it.
        from shapely.geometry import Polygon
        ox, oy = site["frame"]["origin"]
        for b in derived.get("buildings", []):
            ring = b.get("ring") or []
            if len(ring) >= 3:
                shapes.append((Polygon([(x + ox, y + oy) for x, y in ring]).buffer(1.0), 1))
        road_mask = rasterize(shapes, out_shape=c.shape, transform=tr2, fill=0, dtype=np.uint8).astype(bool)
        c[road_mask] = 0.0
        Image.fromarray(np.clip(np.round(c * 4), 0, 255).astype(np.uint8), "L").save(web / "chm_2m.png", optimize=True)
        layers["chm"] = {"file": "chm_2m.png", "res": 2.0, "size": g["size"], "bbox": rel_bbox(g["bbox"]), "scale": 0.25}

    # --- imagery -------------------------------------------------------------------------------
    # NAIP is flown for measurement, not for looks: leaf-on, high sun, and the service's overview
    # mosaic at 60 m is a desaturated grey-green (35% grey on average). Under fog and a hemisphere
    # light it reads as beige. Push saturation and contrast at export so the drape carries the
    # colour the eye expects from a Maryland ridge; the GeoTIFF stays untouched for measurement.
    from PIL import ImageEnhance

    def vivid(img: Image.Image, sat: float, con: float, green: float = 1.0) -> Image.Image:
        img = ImageEnhance.Color(img).enhance(sat)
        img = ImageEnhance.Contrast(img).enhance(con)
        if green != 1.0:
            r, g, b = img.split()
            g = g.point(lambda v: min(255, int(v * green)))
            img = Image.merge("RGB", (r, g, b))
        return img

    if tiled:
        try:
            from . import network_tiles

            shapes = network_tiles.mask_shapes(site_dir, derived)
            tl = network_tiles.export_tiles(site_dir, web, ox, oy, shapes, vivid)
            if tl:
                layers["tiles"] = tl
                print(f"  tiles   {len(tl['list'])} km tiles -> web/tiles/0", flush=True)
            # ...and a coarse whole-region overview, because a site whose only height layer is
            # `tiles` does not load at all until the viewer streams them
            ov = network_tiles.overview(site_dir, web, ox, oy, shapes, vivid)
            layers.update(ov)
            if ov:
                print(f"  overview {', '.join(f'{k} {v['size'][0]}x{v['size'][1]}' for k, v in ov.items())}", flush=True)
        except Exception as exc:
            import traceback

            traceback.print_exc()
            print(f"  tiles failed: {exc}")
    if (site_dir / "naip.tif").exists() and not tiled:
        with rasterio.open(site_dir / "naip.tif") as src:
            w = int(round((bbox[2] - bbox[0]) / 1.0))
            h = int(round((bbox[3] - bbox[1]) / 1.0))
            # WINDOW it. `naip.tif` is fetched over the LIDAR corridor (bbox + 150 m each side);
            # reading the whole file and labelling it with the site bbox squeezed 2570 m of
            # photograph into a 2280 m frame — a 12% stretch, zero error at the centre and ±145 m
            # at the edges. That is the imagery sliding off the roads that Rich kept reporting and
            # that three "is the data aligned" measurements missed, because a stretch is not a
            # shift and they all sampled near the middle (2026-09-21).
            from rasterio.windows import from_bounds as _from_bounds

            win = _from_bounds(*bbox, transform=src.transform)
            rgb = src.read(window=win, out_shape=(3, h, w), resampling=Resampling.average, boundless=True, fill_value=0)
        # warm it a touch as well: NAIP's blue channel runs high and the drape read as teal
        img = vivid(Image.fromarray(np.moveaxis(rgb, 0, -1), "RGB"), 1.3, 1.1)
        r_, g_, b_ = img.split()
        img = Image.merge("RGB", (r_.point(lambda v: min(255, int(v * 1.06))), g_, b_.point(lambda v: int(v * 0.9))))
        img.save(web / "naip_1m.jpg", quality=85, optimize=True)
        layers["naip"] = {"file": "naip_1m.jpg", "res": 1.0, "size": [w, h], "bbox": rel_bbox(bbox)}

    # --- far terrain ---------------------------------------------------------------------------
    if (site_dir / "horizon_30m.tif").exists():
        z, g = _read_at(site_dir / "horizon_30m.tif", 60.0)
        z = _fill(z, -9999)
        rgb, zmin, scale = _encode_height(z)
        Image.fromarray(rgb, "RGB").save(web / "horizon_60m.png", optimize=True)
        layers["horizon"] = {"file": "horizon_60m.png", "res": 60.0, "size": g["size"], "bbox": rel_bbox(g["bbox"]), "zmin": zmin, "zscale": scale}
        if (site_dir / "horizon_naip_60m.jpg").exists():
            vivid(Image.open(site_dir / "horizon_naip_60m.jpg").convert("RGB"), 1.9, 1.25, 1.06).save(web / "horizon_naip_60m.jpg", quality=88)
            layers["horizon_naip"] = {"file": "horizon_naip_60m.jpg", "res": 60.0, "size": g["size"], "bbox": rel_bbox(g["bbox"])}

    # --- vectors, relative to the origin -------------------------------------------------------
    spine = json.loads((site_dir / "spine_utm.json").read_text())
    coords = np.array(spine["coords"])
    line = LineString(coords)
    prof = json.loads((site_dir / "profile.json").read_text()) if (site_dir / "profile.json").exists() else None
    # Densify to 10 m so a spline through the points is smooth in plan AND in grade: OSM nodes are
    # hundreds of metres apart on a straight, and z comes from the lidar profile every 2 m, which a
    # node-only line would throw away.
    # OSM draws a highway curve as chords between nodes 20-100 m apart. Densifying the chords and
    # fitting a spline through the dense points reproduces the chords, kinks included. So the
    # line is smoothed FIRST, along-track, with a Gaussian of sigma 30 m — a real interstate curve
    # has a radius of 300 m or more, so nothing real is lost and the chord corners are gone. The
    # smoothed line drifts from OSM's centreline by under a metre on tight ramps; a highway lane
    # is 3.66 m wide.
    from scipy.ndimage import gaussian_filter1d

    step = 10.0
    fine = np.arange(0.0, line.length, 2.0).tolist() + [line.length]
    raw = np.array([line.interpolate(v).coords[0] for v in fine])
    sm = _smooth_on_line(raw)
    smooth_line = LineString(sm)
    s_dense = np.arange(0.0, smooth_line.length, step).tolist() + [smooth_line.length]
    pts = np.array([smooth_line.interpolate(v).coords[0] for v in s_dense])
    if prof:
        zs = np.interp(np.array(s_dense), np.array(prof["s"]), np.array(prof["road_z"]))
    else:
        # No lidar here (the 2008 Oregon delivery has no CRS, the California coast has no EPT):
        # the road's grade is then the bare-earth DEM under the centreline, lightly smoothed. Zero
        # buried Ragged Point's road 33 m under its own terrain — "only terrain, no roads"
        # (Rich, 2026-09-21).
        dem_p = site_dir / "dem_1m.tif"
        if dem_p.exists():
            import rasterio as _rio
            with _rio.open(dem_p) as _src:
                zs = np.array([v[0] for v in _src.sample([(float(x), float(y)) for x, y in pts])], dtype=float)
            zs[zs < -9000] = np.nan
            if np.isnan(zs).any() and np.isfinite(zs).any():
                ok = np.isfinite(zs)
                zs[~ok] = np.interp(np.flatnonzero(~ok), np.flatnonzero(ok), zs[ok])
            zs = np.nan_to_num(zs, nan=0.0)
            if len(zs) > 9:  # a car follows the road, not the 1 m noise of a bare-earth raster
                k = np.ones(9) / 9
                zs = np.convolve(np.pad(zs, 4, mode="edge"), k, mode="valid")
            print(f"  export  no lidar profile; spine grade from the DEM ({zs.min():.1f}–{zs.max():.1f} m)", flush=True)
        else:
            zs = np.zeros(len(s_dense))
    spine_rel = np.column_stack([pts[:, 0] - ox, pts[:, 1] - oy, zs]).round(2).tolist()

    siblings = []
    for sib in spine.get("siblings", []):
        g = sib["geometry"]
        parts = [g["coordinates"]] if g["type"] == "LineString" else g["coordinates"]
        for part in parts:
            if len(part) < 2:
                continue
            ln = LineString(part)
            if ln.length < 40:
                continue
            fine2 = np.arange(0.0, ln.length, 2.0).tolist() + [ln.length]
            raw2 = np.array([ln.interpolate(v).coords[0] for v in fine2])
            sm2 = _smooth_on_line(raw2)
            sm2[0], sm2[-1] = raw2[0], raw2[-1]
            ln2 = LineString(sm2)
            dense2 = np.array([ln2.interpolate(v).coords[0] for v in np.arange(0.0, ln2.length, step).tolist() + [ln2.length]])
            siblings.append(np.column_stack([dense2[:, 0] - ox, dense2[:, 1] - oy]).round(2).tolist())

    profile_10 = None
    if prof:
        step = max(1, int(round(10.0 / prof["step_m"])))
        keys = ["left_8", "right_8", "left_15", "right_15", "left_40", "right_40"]
        profile_10 = {
            "s": prof["s"][::step],
            "road_z": prof["road_z"][::step],
            "ground_rel": {k: prof["ground_rel"][k][::step] for k in keys if k in prof["ground_rel"]},
            "canopy": {k: prof["canopy"][k][::step] for k in ("left_15", "right_15", "left_40", "right_40") if k in prof["canopy"]},
        }

    surface = json.loads((site_dir / "surface.json").read_text()) if (site_dir / "surface.json").exists() else None
    crossings = json.loads((site_dir / "crossings.json").read_text()) if (site_dir / "crossings.json").exists() else []
    geology = json.loads((site_dir / "geology.json").read_text()) if (site_dir / "geology.json").exists() else {}

    # buildings/landuse/POIs: `derived`, computed above the canopy layer

    # terrain features (terrain-and-data agent, 2026-09-21): cut faces, exposed rock, water. Each
    # module measures from the rasters + OSM and writes its own <site>/{cuts,rock,water}.json;
    # the manifest carries the dict. cuts before rock (rock reads cuts.json). No lidar → null.
    import importlib

    features: dict = {}
    for name in ("cuts", "rock", "water"):
        mod = importlib.import_module(f".{name}", __package__)
        # a network samples per road / per raster tile through a windowed reader; a corridor reads
        # its one DTM into an array. Same rules either way — see water._Heights for why.
        fn = getattr(mod, "measure_network", None) if tiled else None
        try:
            features[name] = (fn or mod.measure)(site_dir)
        except Exception as exc:
            import traceback

            traceback.print_exc()
            print(f"  {name} failed: {exc}")
            features[name] = None
        if features[name] and features[name].get("summary"):
            print(f"  {name:7s} {features[name]['summary']}", flush=True)

    out = {
        "slug": site["slug"],
        "ident": site.get("ident"),
        "frame": site["frame"],
        "bbox": rel_bbox(bbox),
        "layers": layers,
        "spine": {"coords": spine_rel, "photo_s": spine["photo_s"], "length_m": round(float(line.length), 1), "segments": spine.get("segments", [])},
        "siblings": siblings,
        "structures": prof["structures"] if prof else [],
        "crossings": [{k: c.get(k) for k in ("s", "kind", "relation", "name", "inferred")} for c in crossings],
        "surface": {"step_m": surface["step_m"], "s": surface["stations"]["s"], "class": surface["stations"]["class"], "lidar_ratio": surface["stations"]["lidar_ratio"], "naip_brightness": surface["stations"]["naip_brightness"], "segments": surface["segments"], "summary": surface["summary"]} if surface else None,
        "profile": profile_10,
        "geology": {"named_formations": geology.get("named_formations", []), "units": [{k: u.get(k) for k in ("name", "strat_name", "lith", "descrip", "b_age", "t_age")} for u in geology.get("units", []) if u.get("strat_name")]},
        "photos": [{"file": p["file"], "heading_deg": p.get("heading_deg"), "taken": p.get("taken")} for p in site.get("photos", [])],
        "lidar": {k: manifest.get("lidar", {}).get(k) for k in ("dataset", "points_in_corridor", "classes")},
        "buildings": derived["buildings"],
        "driveways": _service_ways(site_dir, Frame.at(site["lon"], site["lat"]), ox, oy, bbox),
        "stubs": _stub_roads(site_dir, Frame.at(site["lon"], site["lat"]), ox, oy, bbox),
        "power": _power(site_dir, Frame.at(site["lon"], site["lat"]), ox, oy, bbox),
        "signals": _signals(site_dir, Frame.at(site["lon"], site["lat"]), ox, oy, bbox),
        "parking": _parking(site_dir, Frame.at(site["lon"], site["lat"]), ox, oy, bbox),
        "landuse": derived["landuse"],
        "pois": derived["pois"],
        "cuts": features.get("cuts"),
        "rock": features.get("rock"),
        "water": features.get("water"),
    }
    # network sites (cadre §6): every other road as a first-class branch — coords with lidar grade,
    # junctions, profile, structures. `siblings` above stays as it was for the old viewer path.
    try:
        from . import network

        br = network.export_branches(site_dir, ox, oy)
        if br is not None:
            out["network"] = True
            out["roads"] = spine.get("roads", [])
            out["junctions"] = (spine.get("primary") or {}).get("junctions", [])
            out["branches"] = br
    except Exception as exc:
        print(f"  branches failed: {exc}")
    (web / "manifest.json").write_text(json.dumps(out))
    return {"layers": list(layers), "bytes": sum(f.stat().st_size for f in web.iterdir()), "buildings": derived["summary"]}


def write_index(sites_dir: Path) -> Path:
    entries = []
    for d in sorted(sites_dir.glob("*")):
        m = d / "web" / "manifest.json"
        if not m.exists():
            continue
        j = json.loads(m.read_text())
        entries.append({"slug": j["slug"], "ident": j.get("ident"), "length_m": j["spine"]["length_m"], "structures": len(j["structures"]), "formations": j["geology"]["named_formations"][:4], "layers": list(j["layers"]), "photos": [p["file"] for p in j["photos"]]})
    out = sites_dir / "index.json"
    out.write_text(json.dumps({"sites": entries}, indent=1))
    return out
