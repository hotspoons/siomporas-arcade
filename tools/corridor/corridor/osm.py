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
import os
import json
import time
from pathlib import Path

import re

import numpy as np
import requests
from shapely.geometry import LineString, MultiLineString, Point, Polygon, box, mapping, shape
from shapely.ops import linemerge, substring, unary_union

from . import BakeFault
from .geo import Frame

# Public Overpass instances, tried in turn: the main one 504s under load on queries that take
# milliseconds elsewhere, and every one of these is a shared free server owed the same courtesy.
# Ours first, when there is one: CORRIDOR_OVERPASS_URL (comma-separated) jumps the queue, and the
# public mirrors stay as the fallback for regions our extract does not cover. Every public mirror
# refused connections for an hour on 2026-09-21 and took every new bake down with it; the chart
# for our own is in tools/overpass/chart.
_OURS = [u.strip() for u in os.environ.get("CORRIDOR_OVERPASS_URL", "").split(",") if u.strip()]
OVERPASS = _OURS + [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://lz4.overpass-api.de/api/interpreter",
]
UA = "apex-conduit corridor (github.com/hotspoons; road-corridor extraction for a driving game)"
DRIVABLE = "motorway|trunk|primary|secondary|tertiary|unclassified|residential|motorway_link|trunk_link|primary_link"

session = requests.Session()
session.headers["User-Agent"] = UA


# WHAT EACH OF OURS HOLDS, from the world editor (tools/worldeditor/coverage.mjs): a file on the
# volume naming each instance's Geofabrik regions, polygons and all. Unset on a laptop pointed at
# one instance, and then nothing here changes.
#
# THE SILENT EMPTY, ONE MORE TIME. A regional instance asked about ground outside its extract
# answers HTTP 200 with nothing — not an error. dc-metro-take-2 was sent to the Maryland instance
# because a box said it held Washington and Arlington; its context.json came back with 108,816
# roads in Maryland and none across the river, and the bake reported success (2026-10-10). So
# every query whose area can be read is checked against the polygon of the instance it is about
# to go to, and a query that NONE of ours holds is a BakeFault — never a quiet empty, never a quiet
# half. See tools/overpass/README.md, "Where the OSM comes from".
_COVERAGE_FILE = os.environ.get("CORRIDOR_OVERPASS_COVERAGE", "")
_REFRESH = os.environ.get("CORRIDOR_OSM_REFRESH", "") == "1"
_coverage_cache: dict | None = None


def _coverage() -> dict:
    """url -> (shapely geometry or None for 'claims everywhere', [region ids]). Empty without the file."""
    global _coverage_cache
    if _coverage_cache is not None:
        return _coverage_cache
    if not _COVERAGE_FILE:
        _coverage_cache = {}
        return _coverage_cache
    try:
        doc = json.loads(Path(_COVERAGE_FILE).read_text())
    except (OSError, ValueError) as exc:
        # NOT "no coverage, carry on": the editor said there is a coverage file, and baking without
        # it is baking blind against regional instances, which is the whole failure
        raise BakeFault(f"overpass coverage file {_COVERAGE_FILE} cannot be read ({exc}); refusing to query regional instances blind") from exc
    out = {}
    for up in doc.get("upstreams", []):
        regions = up.get("regions") or []
        url = up.get("url")
        if not url:
            continue
        if not regions:
            out[url] = (None if not up.get("holdsNothingKnown") else Polygon(), [])
            continue
        geom = unary_union([shape(r["geometry"]) for r in regions if r.get("geometry")])
        out[url] = (geom, [r.get("id") for r in regions])
    _coverage_cache = out
    return out


_NUM = r"(-?\d+(?:\.\d+)?)"
_BBOX_RE = re.compile(rf"\(\s*{_NUM}\s*,\s*{_NUM}\s*,\s*{_NUM}\s*,\s*{_NUM}\s*\)")
_POLY_RE = re.compile(r'poly:\s*"([^"]+)"')
_AROUND_RE = re.compile(rf"around:\s*{_NUM}\s*,\s*{_NUM}\s*,\s*{_NUM}")


def query_area(query: str):
    """The ground a query asks about, as a lon/lat shapely geometry — or None when it names no place.

    Read from the query text, because that is the one thing every caller already hands over and the
    thing that is actually sent: every `(s,w,n,e)` bbox, every `poly:"lat lon …"`, every
    `around:r,lat,lon` (as the square about it). Their union. An id lookup (`node(id:…)`) names no
    place and is not checked — its ids came out of a query that was.
    """
    parts = []
    for m in _BBOX_RE.finditer(query):
        s_, w_, n_, e_ = (float(v) for v in m.groups())
        if -90 <= s_ <= n_ <= 90 and -180 <= w_ <= e_ <= 180:
            parts.append(box(w_, s_, e_, n_))
    for m in _POLY_RE.finditer(query):
        v = [float(x) for x in m.group(1).split()]
        pts = [(v[i + 1], v[i]) for i in range(0, len(v) - 1, 2)]
        if len(pts) >= 3:
            parts.append(Polygon(pts).buffer(0))
    for m in _AROUND_RE.finditer(query):
        r, lat, lon = (float(x) for x in m.groups())
        dlat = r / 111132.0
        dlon = r / (111412.84 * max(0.05, np.cos(np.radians(lat))))
        parts.append(box(lon - dlon, lat - dlat, lon + dlon, lat + dlat))
    if not parts:
        return None
    return unary_union(parts)


def _holds(url: str, area) -> tuple[bool, float]:
    """Does this upstream hold ALL of `area`? (True, 0) when it claims everywhere or there is no area."""
    rec = _coverage().get(url)
    if rec is None or area is None:
        return True, 0.0
    geom, _ids = rec
    if geom is None:
        return True, 0.0
    if geom.is_empty:
        return False, 1.0
    if geom.covers(area):
        return True, 0.0
    a = area.area
    return False, (area.difference(geom).area / a) if a > 0 else 1.0


def route(query: str) -> list[str]:
    """Which of OURS may answer this query, in order — those whose coverage holds all of its area.

    BakeFault when ours were configured and none holds it: the world editor routed this world to
    them because they hold the world's own box, and this query reaches past it. Falling through to
    a public mirror here would be quiet and slow (a 40 km network query, minutes per attempt), and
    the regional answer would be the silent empty — so it stops, and says which ground is missing.
    """
    if not _OURS or not _coverage():
        return list(_OURS)
    area = query_area(query)
    ok, worst = [], []
    for u in _OURS:
        held, outside = _holds(u, area)
        (ok if held else worst).append(u if held else (outside, u))
    if ok:
        return ok
    outside, best = min(worst)
    _geom, ids = _coverage().get(best, (None, []))
    b = area.bounds if area is not None else None
    raise BakeFault(
        f"overpass: none of our instances holds this query's area — the closest, {best.split('/')[2]}, "
        f"holds {', '.join(ids) or 'nothing we know of'} and leaves {100 * outside:.1f}% of it outside "
        f"(query box W {b[0]:.4f} S {b[1]:.4f} E {b[2]:.4f} N {b[3]:.4f}). A regional instance answers "
        f"ground it does not hold with HTTP 200 and nothing, so this bake would have been missing roads "
        f"without a word. Add the region to an instance (world editor: Settings → OSM data), or bring "
        f"the world inside one."
    )


def _cache_hit(hit: Path, query: str):
    """A cached answer, unless it is known to have come from an instance that does not hold the area."""
    if _REFRESH or not hit.exists():
        return None
    side = hit.with_name(hit.name + ".upstream")
    if _coverage() and side.exists():
        try:
            prov = json.loads(side.read_text())
        except ValueError:
            prov = {}
        url = prov.get("url")
        if url:
            held, outside = _holds(url, query_area(query))
            if not held:
                print(f"  overpass cache {hit.name} came from {prov.get('host', url)}, which leaves {100 * outside:.1f}% of it outside its extract; asking again")
                return None
    return json.loads(hit.read_text())


def overpass(query: str, cache_dir: Path) -> dict:
    cache_dir.mkdir(parents=True, exist_ok=True)
    key = hashlib.sha1(query.encode()).hexdigest()[:16]
    hit = cache_dir / f"{key}.json"
    cached = _cache_hit(hit, query)
    if cached is not None:
        return cached
    # ours that hold the area, then the public mirrors (which hold everywhere) for an error fallback
    mirrors = route(query) + OVERPASS[len(_OURS):]
    last = None
    for attempt in range(8):
        url = mirrors[attempt % len(mirrors)]
        try:
            resp = session.post(url, data={"data": query}, timeout=240)
        except requests.RequestException as exc:
            print(f"  overpass {url.split('/')[2]}: {exc.__class__.__name__}")
            last = exc
            continue
        if resp.status_code == 200:
            data = resp.json()
            # A RUNTIME ERROR ARRIVES AS A 200. Overpass has already sent its header when a query
            # times out, runs out of memory, or — measured on an instance taking an import, about 1
            # query in 100 — finds "Data file size does not match block size"; the body is valid
            # JSON with `elements` empty or cut short and the reason in `remark`. Cached, that is a
            # permanent hole. So it is a failure: not written, and asked again.
            remark = str(data.get("remark") or "")
            if "runtime error" in remark:
                print(f"  overpass {url.split('/')[2]}: {remark[:160]}; asking again")
                last = RuntimeError(remark)
                time.sleep(5)
                continue
            hit.write_text(json.dumps(data))
            # who answered, beside the answer and never inside it: the file stays byte-compatible
            # with the world editor's cache (same key, same sidecar shape, overpass.mjs)
            try:
                hit.with_name(hit.name + ".upstream").write_text(json.dumps({"url": url, "host": url.split("/")[2], "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "by": "bake"}))
            except OSError:
                pass
            return data
        last = resp
        wait = 5 if attempt < len(mirrors) else 20
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


def nearest_road(lat: float, lon: float, frame: Frame, cache: Path, radius_m: int = 300, want: str | None = None) -> dict:
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

    # `want` (sites.json `road`) is the human saying which road this site IS. A point estimated
    # from two junction coordinates can easily land nearer a lane than the highway it names:
    # md450-staples snapped 369 m onto "Double Gate Road". Naming the road settles it.
    def score(e):
        t = e.get("tags", {})
        hw = str(t.get("highway", ""))
        if want and want.lower() not in f'{t.get("ref", "")} {t.get("name", "")}'.lower():
            return 1e9 + _way_line(e, frame).distance(p)
        d = _way_line(e, frame).distance(p)
        d += CLASS_PENALTY.get(hw, 420)
        d += 150 if hw.endswith("_link") else 0
        d += 200 if not (t.get("ref") or t.get("name")) else 0
        return d

    best = min(els, key=score)
    if want and score(best) >= 1e9:
        raise RuntimeError(f'no way matching road="{want}" within 800 m of {lat},{lon}')
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
    near = nearest_road(site["lat"], site["lon"], frame, cache, want=site.get("road"))
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


#: The minimap's own style table; the viewer keeps the same list. Only these classes are worth
#: shipping to a browser, and dropping the rest is most of the size.
_MINIMAP_CLASSES = {
    "motorway", "trunk", "primary", "secondary", "tertiary", "motorway_link",
    "residential", "unclassified", "service", "track", "railway", "waterway",
}


def _lane_num(v):
    try:
        n = int(str(v), 10)
    except (TypeError, ValueError):
        return None
    return n if 0 < n < 16 else None


def _split_lanes(v):
    return [s.strip() for s in v.split("|")] if isinstance(v, str) and v else None


def context(feats: dict) -> dict:
    """Everything the VIEWER reads out of the raw OSM extract, as tens of kB, not hundreds of MB.

    `features` keeps every raw tag for the bake itself (cuts, water, walkways, power, ...), but the
    browser only ever wanted three small projections of it, and it used to build all three by
    fetching and parsing the whole `osm.geojson` on the main thread:

    - `lanes`    per-way lane facts for the junction model, keyed by the bake's road id (`r<osm id>`,
      which is how `branches[].id` and the junction approaches name a way). Building this live is
      the "junction facts…" step, and on a network-sized world it froze the tab.
    - `crossings` `highway=crossing` nodes (WGS84) for the ladder crosswalks.
    - `roads`    the drawable LineStrings for the minimap base, class already resolved, tags dropped.

    Kept in step with `loadJunctionFacts`/`MiniMap.load` in apps/corridor.
    """
    lanes: dict = {}
    crossings: list = []
    roads: list = []
    for f in feats.get("features", []):
        geom = f.get("geometry") or {}
        props = f.get("properties") or {}
        gtype = geom.get("type")
        if gtype == "Point" and props.get("highway") == "crossing":
            lon, lat = geom["coordinates"]
            crossings.append({"lon": lon, "lat": lat, "marked": props.get("crossing") != "unmarked"})
            continue
        if gtype != "LineString":
            continue
        fid = f.get("id") or ""
        if fid.startswith("way/"):
            lanes["r" + fid[4:]] = {
                "lanes": _lane_num(props.get("lanes")),
                "forward": _lane_num(props.get("lanes:forward")),
                "backward": _lane_num(props.get("lanes:backward")),
                "oneway": props.get("oneway") in ("yes", "-1") or props.get("highway") == "motorway",
                "turn": _split_lanes(props.get("turn:lanes")),
                "turnForward": _split_lanes(props.get("turn:lanes:forward")),
                "turnBackward": _split_lanes(props.get("turn:lanes:backward")),
            }
        cls = props.get("highway") or ("railway" if props.get("railway") else ("waterway" if props.get("waterway") else None))
        if cls in _MINIMAP_CLASSES and len(geom.get("coordinates") or []) > 1:
            roads.append({"cls": cls, "name": props.get("name") or props.get("ref"), "coords": geom["coordinates"]})
    return {"lanes": lanes, "crossings": crossings, "roads": roads}


def write_context(feats: dict, out: Path) -> dict:
    """Write `context.json` beside `osm.geojson` and return a small provenance dict."""
    ctx = context(feats)
    (out / "context.json").write_text(json.dumps(ctx, separators=(",", ":")))
    return {"lanes": len(ctx["lanes"]), "crossings": len(ctx["crossings"]), "roads": len(ctx["roads"])}


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
