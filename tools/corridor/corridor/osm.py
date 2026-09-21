"""OpenStreetMap for a corridor: the road's spine, then everything near it.

Three steps, each one Overpass query, each cached by query hash so a re-run is offline:

1. `nearest_road`  — the drivable way closest to the photo fix. Its `ref` (I 70, MD 200) or,
                     failing that, its `name` is the road's identity. Divided highways are two
                     one-way carriageways with the same ref; we get the one we were on.
2. `spine`         — every way carrying that identity within the search box, chained through
                     shared node ids into carriageways. The chain containing the nearest way is
                     the SPINE; it is trimmed to ±`half_length_m` along-track from the photo.
                     The other chains with the same ref (the opposite carriageway, ramps tagged
                     with the ref) are kept as `siblings` — the game needs both carriageways to
                     measure the median.
3. `features`      — every tagged way/node inside the spine buffered by `half_width_m`:
                     roads, rail, power lines, barriers, cuttings/embankments, cliffs, woods,
                     landuse, water, buildings, street lamps, junctions. Raw tags are kept; the
                     game decides what a `barrier=jersey_barrier` becomes, not this file.

Also `crossings`: ways that intersect the spine and are not the spine — with their bridge/tunnel/
layer tags and a first guess whether they pass OVER or UNDER us. lidar.py checks that guess against
bridge-deck returns; the two are joined in report.py.
"""
from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path

import numpy as np
import requests
from shapely.geometry import LineString, MultiLineString, Point, Polygon, mapping
from shapely.ops import linemerge, substring

from .geo import Frame

# Public Overpass instances, tried in turn: the main one 504s under load on queries that take
# milliseconds elsewhere, and every one of these is a shared free server owed the same courtesy.
OVERPASS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://lz4.overpass-api.de/api/interpreter",
]
UA = "apex-conduit corridor (github.com/hotspoons; road-corridor extraction for a driving game)"
DRIVABLE = "motorway|trunk|primary|secondary|tertiary|unclassified|residential|motorway_link|trunk_link|primary_link"

session = requests.Session()
session.headers["User-Agent"] = UA


def overpass(query: str, cache_dir: Path) -> dict:
    cache_dir.mkdir(parents=True, exist_ok=True)
    key = hashlib.sha1(query.encode()).hexdigest()[:16]
    hit = cache_dir / f"{key}.json"
    if hit.exists():
        return json.loads(hit.read_text())
    last = None
    for attempt in range(8):
        url = OVERPASS[attempt % len(OVERPASS)]
        try:
            resp = session.post(url, data={"data": query}, timeout=240)
        except requests.RequestException as exc:
            print(f"  overpass {url.split('/')[2]}: {exc.__class__.__name__}")
            last = exc
            continue
        if resp.status_code == 200:
            data = resp.json()
            hit.write_text(json.dumps(data))
            return data
        last = resp
        wait = 5 if attempt < len(OVERPASS) else 20
        print(f"  overpass {url.split('/')[2]} HTTP {resp.status_code}; next mirror in {wait}s")
        time.sleep(wait)
    if isinstance(last, requests.Response):
        last.raise_for_status()
    raise RuntimeError(f"overpass: all mirrors failed ({last})")


def _way_line(el: dict, frame: Frame) -> LineString:
    lon = np.array([p["lon"] for p in el["geometry"]])
    lat = np.array([p["lat"] for p in el["geometry"]])
    x, y = frame.from_wgs(lon, lat)
    return LineString(np.column_stack([x, y]))


def nearest_road(lat: float, lon: float, frame: Frame, cache: Path, radius_m: int = 300) -> dict:
    # Widen in steps: a fix taken from a moving car can sit a few hundred metres off the road it
    # shows (Burtonsville's was 120+ m off the ICC). The step-up is logged so a far snap is visible.
    els = []
    for r in (radius_m, 800):
        q = f'[out:json][timeout:60];way(around:{r},{lat},{lon})[highway~"^({DRIVABLE})$"];out geom tags;'
        els = overpass(q, cache)["elements"]
        if els:
            if r != radius_m:
                print(f"  snap    no road within {radius_m} m; found within {r} m")
            break
    if not els:
        raise RuntimeError(f"no drivable way within 800 m of {lat},{lon}")
    px, py = frame.from_wgs(lon, lat)
    p = Point(px, py)

    # Nearest is not always right: at an interchange the closest way is a ramp with neither ref
    # nor name, and a spine needs an identity to chain along. Penalise links and anonymous ways
    # so a mainline a lane or two further away wins.
    # ...and prefer the bigger road outright. Every reference photo in this project was taken FROM
    # a highway, so a fix 80 m from a residential street and 200 m from the interstate belongs to
    # the interstate (Frederick's I-70/I-270 frame snapped to Guilford Drive before this).
    CLASS_PENALTY = {"motorway": 0, "trunk": 40, "primary": 120, "secondary": 220, "tertiary": 320}

    def score(e):
        t = e.get("tags", {})
        hw = str(t.get("highway", ""))
        d = _way_line(e, frame).distance(p)
        d += CLASS_PENALTY.get(hw, 420)
        d += 150 if hw.endswith("_link") else 0
        d += 200 if not (t.get("ref") or t.get("name")) else 0
        return d

    best = min(els, key=score)
    tags = best.get("tags", {})
    if not (tags.get("ref") or tags.get("name")):
        raise RuntimeError(f"nearest drivable way {best['id']} has neither ref nor name; cannot chain a spine")
    ident = ("ref", tags["ref"]) if tags.get("ref") else ("name", tags["name"])
    return {"way": best, "ident": ident, "distance_m": float(_way_line(best, frame).distance(p))}


def _chains(ways: list[dict]) -> list[list[dict]]:
    """Group ways into carriageways by shared END nodes and order each chain.

    Orientation: one-way chains run in travel direction. Two-way roads (Racetrack Rd) are chained
    by endpoint regardless of the way's digitising direction, flipping geometry as needed."""
    by_id = {w["id"]: w for w in ways}
    first = {w["id"]: w["nodes"][0] for w in ways}
    last = {w["id"]: w["nodes"][-1] for w in ways}
    used: set[int] = set()
    chains: list[list[dict]] = []
    ends: dict[int, list[int]] = {}
    for wid in by_id:
        ends.setdefault(first[wid], []).append(wid)
        ends.setdefault(last[wid], []).append(wid)

    def others_at(node: int, wid: int) -> list[int]:
        return [o for o in ends.get(node, []) if o != wid and o not in used]

    for start in by_id:
        if start in used:
            continue
        # walk backwards to the chain's head
        head = start
        node = first[head]
        seen = {head}
        while True:
            prev = [o for o in others_at(node, head) if o not in seen]
            if len(prev) != 1:
                break
            head = prev[0]
            seen.add(head)
            node = first[head] if last[head] == node else last[head]
        # walk forward from the head
        chain: list[dict] = []
        wid = head
        node_in = first[head] if len(seen) == 1 else node  # entering node
        # orient head: its far end is whichever end is not node_in
        flipped = last[wid] == node_in and first[wid] != node_in
        while True:
            used.add(wid)
            w = dict(by_id[wid])
            if flipped:
                w = {**w, "geometry": list(reversed(w["geometry"])), "nodes": list(reversed(w["nodes"]))}
            chain.append(w)
            out_node = w["nodes"][-1]
            nxt = others_at(out_node, wid)
            if len(nxt) != 1:
                break
            wid = nxt[0]
            flipped = last[wid] == out_node
        chains.append(chain)
    return chains


def spine(site: dict, frame: Frame, cache: Path, half_length_m: float, search_m: float) -> dict:
    near = nearest_road(site["lat"], site["lon"], frame, cache)
    key, val = near["ident"]
    esc = val.replace('"', '\\"')
    ox, oy = frame.origin
    w, s, e, n = frame.bbox_wgs(ox - search_m, oy - search_m, ox + search_m, oy + search_m)
    q = f'[out:json][timeout:120];way({s},{w},{n},{e})[highway]["{key}"="{esc}"];out geom;'
    ways = [x for x in overpass(q, cache)["elements"] if x.get("geometry")]
    chains = _chains(ways)
    mine = next(c for c in chains if any(x["id"] == near["way"]["id"] for x in c))

    coords = []
    for wy in mine:
        pts = [(p["lon"], p["lat"]) for p in wy["geometry"]]
        if coords and coords[-1] == pts[0]:
            pts = pts[1:]
        coords.extend(pts)
    lon = np.array([c[0] for c in coords])
    lat = np.array([c[1] for c in coords])
    x, y = frame.from_wgs(lon, lat)
    full = LineString(np.column_stack([x, y]))
    s0 = full.project(Point(*frame.origin))
    a, b = max(0.0, s0 - half_length_m), min(full.length, s0 + half_length_m)
    line = substring(full, a, b)

    # per-way attribute segments along the trimmed spine (lanes change mid-corridor)
    segs = []
    acc = 0.0
    for wy in mine:
        ln = _way_line(wy, frame)
        seg = (acc, acc + ln.length)
        acc += ln.length
        if seg[1] < a or seg[0] > b:
            continue
        segs.append({"osm_id": wy["id"], "s_start": round(max(seg[0], a) - a, 1), "s_end": round(min(seg[1], b) - a, 1), "tags": wy.get("tags", {})})

    siblings = []
    for c in chains:
        if c is mine:
            continue
        cl = linemerge(MultiLineString([_way_line(wy, frame) for wy in c]))
        if cl.distance(line) < 120:  # the opposite carriageway or a ramp on this stretch
            siblings.append({"osm_ids": [wy["id"] for wy in c], "tags": c[0].get("tags", {}), "geometry": mapping(cl)})

    return {
        "ident": {key: val},
        "nearest_way": near["way"]["id"],
        "snap_distance_m": round(near["distance_m"], 1),
        "photo_s": round(s0 - a, 1),
        "length_m": round(line.length, 1),
        "trimmed": [a < s0 - half_length_m + 1e-6, b > s0 + half_length_m - 1e-6],
        "line": line,
        "segments": segs,
        "siblings": siblings,
    }


FEATURE_FILTERS = [
    "way[highway]",
    "way[railway]",
    "way[power]",
    "way[barrier]",
    'way[man_made~"^(embankment|cutting|bridge|pipeline|dyke|retaining_wall|pier)$"]',
    "way[natural]",
    "way[landuse]",
    "way[waterway]",
    "way[building]",
    "way[bridge]",
    "way[tunnel]",
    # what a building IS — the editor agent's autogen found 2887 of 3413 footprints tagged only
    # building=yes, while every restaurant, motel and church in OSM carries one of these
    "node[amenity]",
    "node[shop]",
    "node[tourism]",
    "node[office]",
    "way[amenity]",
    "way[shop]",
    "way[tourism]",
    "way[office]",
    "way[leisure]",
    "node[natural=tree]",
    "node[power]",
    'node[highway~"^(street_lamp|traffic_signals|motorway_junction|crossing|stop|give_way)$"]',
    "node[barrier]",
    'node[man_made~"^(tower|mast|flagpole|water_tower|utility_pole|street_cabinet)$"]',
]


def features(corridor: Polygon, frame: Frame, cache: Path) -> dict:
    poly = corridor.simplify(15)
    if poly.geom_type != "Polygon":  # a tight curve can buffer into pieces; the hull is fine for a filter
        poly = poly.convex_hull
    ring = poly.exterior.coords
    lon, lat = frame.to_wgs(np.array([c[0] for c in ring]), np.array([c[1] for c in ring]))
    poly = " ".join(f"{la:.6f} {lo:.6f}" for la, lo in zip(lat, lon))
    body = "".join(f'{f}(poly:"{poly}");' for f in FEATURE_FILTERS)
    q = f"[out:json][timeout:180];({body});out geom tags;"
    els = overpass(q, cache)["elements"]
    feats = []
    for el in els:
        tags = el.get("tags", {})
        if el["type"] == "node":
            geom = {"type": "Point", "coordinates": [el["lon"], el["lat"]]}
        elif el["type"] == "way" and el.get("geometry"):
            coords = [[p["lon"], p["lat"]] for p in el["geometry"]]
            closed = len(coords) > 3 and coords[0] == coords[-1]
            is_area = closed and (tags.get("area") == "yes" or any(k in tags for k in ("building", "landuse", "natural", "leisure", "amenity")) and "highway" not in tags and "barrier" not in tags)
            geom = {"type": "Polygon", "coordinates": [coords]} if is_area else {"type": "LineString", "coordinates": coords}
        else:
            continue
        feats.append({"type": "Feature", "id": f"{el['type']}/{el['id']}", "properties": {"osm_type": el["type"], "osm_id": el["id"], **tags}, "geometry": geom})
    return {"type": "FeatureCollection", "features": feats}


def crossings(spine_line: LineString, feats: dict, ident: dict, frame: Frame, segments: list[dict] | None = None) -> list[dict]:
    """Ways crossing the spine, with the best over/under call OSM alone supports.

    Three sources of truth, in order: the crossing way's own bridge/tunnel/layer tags; the SPINE's
    tags at that along-track metre (if we are on a `bridge=yes` way there, they pass under us —
    OSM maps the motorway's bridge, not the lane's `maxheight`); and, on a motorway or trunk,
    the fact that nothing crosses at grade, so an untagged crossing is over us. The last is
    marked `inferred` and is what the lidar deck check is for."""
    out = []
    (ik, iv), = ident.items()
    segments = segments or []

    def spine_tags_at(s: float) -> dict:
        for sg in segments:
            if sg["s_start"] - 0.5 <= s <= sg["s_end"] + 0.5:
                return sg.get("tags", {})
        return {}
    for f in feats["features"]:
        p = f["properties"]
        if f["geometry"]["type"] != "LineString":
            continue
        if not (p.get("highway") or p.get("railway") or p.get("waterway") or p.get("power")):
            continue
        if p.get(ik) == iv:
            continue
        c = np.array(f["geometry"]["coordinates"])
        x, y = frame.from_wgs(c[:, 0], c[:, 1])
        ln = LineString(np.column_stack([x, y]))
        if not ln.intersects(spine_line):
            continue
        inter = ln.intersection(spine_line)
        pts = [inter] if inter.geom_type == "Point" else [g for g in getattr(inter, "geoms", []) if g.geom_type == "Point"]
        for pt in pts:
            layer = int(p.get("layer", "0") or 0) if str(p.get("layer", "0")).lstrip("-").isdigit() else 0
            # A way that ENDS on the spine joins it — a ramp, a maintenance access — it does not
            # cross it. Braddock had four of these read as inferred overpasses; the lidar found
            # only roadside trees there. Endpoint within 6 m of the intersection = merge.
            ends = [Point(ln.coords[0]), Point(ln.coords[-1])]
            if min(e.distance(pt) for e in ends) <= 6.0:
                out.append({"s": round(spine_line.project(pt), 1), "kind": p.get("highway") or p.get("railway"), "relation": "merge", "inferred": False, "spine_bridge": False, "osm_id": p["osm_id"], "name": p.get("name") or p.get("ref"), "tags": {k: v for k, v in p.items() if k in ("highway", "lanes", "name", "ref", "oneway")}})
                continue
            st = spine_tags_at(spine_line.project(pt))
            inferred = False
            if p.get("bridge") and p.get("bridge") != "no" or layer > 0:
                rel = "over"
            elif p.get("tunnel") and p.get("tunnel") != "no" or layer < 0:
                rel = "under"
            elif st.get("bridge") and st.get("bridge") != "no":
                rel = "under"
            elif st.get("tunnel") and st.get("tunnel") != "no":
                rel = "over"
            elif p.get("power"):
                rel = "over"
            elif p.get("waterway"):
                rel = "under"
            elif st.get("highway") in ("motorway", "trunk") and p.get("highway"):
                rel, inferred = "over", True
            elif p.get("highway") or p.get("railway") == "level_crossing":
                rel = "grade"  # two ordinary roads meeting: an intersection, not a structure
            else:
                rel = "unknown"
            kind = p.get("railway") and "railway" or p.get("power") and "power" or p.get("waterway") and "waterway" or p.get("highway")
            out.append({"s": round(spine_line.project(pt), 1), "kind": kind, "relation": rel, "inferred": inferred, "spine_bridge": bool(st.get("bridge") and st.get("bridge") != "no"), "osm_id": p["osm_id"], "name": p.get("name") or p.get("ref"), "tags": {k: v for k, v in p.items() if k in ("highway", "railway", "bridge", "tunnel", "layer", "lanes", "width", "power", "waterway", "bridge:structure", "maxheight", "name", "ref")}})
    out.sort(key=lambda c: c["s"])
    return out
