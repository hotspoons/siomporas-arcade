"""A network site: one interconnected region of roads baked as one world (cadre doc §6).

    sites.json entry:
      { "slug": "crofton-crownsville", "kind": "network", "region": "crofton-crownsville",
        "primary": "Chesterfield Road", "lat": 39.0, "lon": -76.62, "radius_m": 9000,
        "roads": ["Chesterfield Road", "MD 450", ...], "photos": [], "note": "..." }

Where a single-road site trims one carriageway to ±3.2 km of a photo, a network keeps EVERY way
in the region whose `name` or `ref` is in `roads`, chains each identity into carriageways
(osm._chains), and emits:

    spine_utm.json   coords    = the PRIMARY road's longest chain, whole (Chesterfield carries the
                                 jump and the photo point); photo_s = the site point projected on it
                     segments  = per way along the primary, as today
                     siblings  = every other chain, in the EXISTING schema (osm_ids, tags, geometry)
                                 PLUS additive keys: name, ref, highway, lanes, oneway, length_m,
                                 junctions [{node, lon, lat, x, y, s, with:[names]}] — OSM nodes shared
                                 with other chains; lon/lat is the position, x/y its ENU in the
                                 frame the file is tagged with (see `place_junctions`)
                     junctions = the primary's own, roads = the identities found, network = true
    site.json        corridor  = the UNION of every chain buffered `half_width_m` (150 m) — the
                                 region is ~12 km across, its bbox is mostly fields nobody drives
    osm.geojson      features inside that union's hull (osm.features)
    crossings.json   for the primary (osm.crossings); a branch meeting it is a `merge`/`grade`

Rasters, lidar, profile and export for a network are in `network_bake` below, called from
__main__.fetch_site when `site["kind"] == "network"`; the rasters cover the world region (the drawn
boundary, or the bbox -- see `world_lidar_area` for the point cloud) and the web layers go out as
1 km tiles (export_tiles). The single-road modules are reused where a
function takes a line: profile per chain, cuts/rock/water per chain.
"""
from __future__ import annotations

import json
import re
import time
from pathlib import Path

import numpy as np
import shapely
from shapely.geometry import LineString, MultiLineString, Point, Polygon, box as shp_box, mapping
from shapely.ops import linemerge, unary_union

from . import BakeFault, osm
from . import progress
from .geo import Frame, snap_bbox

REF_RE = re.compile(r"^(MD|US|I|VA|PA|CA|OR|ME)[ -]?\d+[A-Z]?( Alt| Bus| Scenic| Toll)?$")
MIN_CHAIN_M = 50.0  # a stub shorter than this (a turning head, a mis-tagged driveway) is dropped; a 75 m cul-de-sac is a road Rich lives on (main, 2026-09-21)


def _ident(tags: dict, refs: set[str], names: set[str]) -> str | None:
    ref = tags.get("ref")
    if ref:
        for r in str(ref).split(";"):
            if r.strip() in refs:
                return r.strip()
    nm = tags.get("name")
    if nm in names:
        return nm
    # alt names: OSM sometimes has the road under alt_name/official_name
    for k in ("alt_name", "official_name", "old_name"):
        v = tags.get(k)
        if v and v in names:
            return v
    return None


def _chain_lanes(chain: list[dict], frame: Frame) -> int | None:
    """
    How many lanes does this chain have? The count most of its LENGTH actually carries, as a NUMBER.

    A chain is many OSM ways joined end to end, and they disagree: a road crosses a junction where
    turn pockets make one 40-metre way four lanes wide while the two kilometres either side are
    two. The old rule kept every distinct value as a sorted set of STRINGS and handed the whole
    list downstream -- so the viewer, which takes the minimum, drew Annapolis Road (a primary
    arterial, tagged 1, 2, 3 and 4 along its length) as ONE LANE. The same shape is most of why
    Rich's Route 3 renders as two.

    Weighted by metres, so a short turn pocket cannot outvote the road it is attached to, and
    returned as an int so nothing downstream has to guess at the type. None when OSM says nothing,
    which is the honest answer for 93 % of residential streets and is what the highway-class
    fallback is for.

    Per-station lane counts, with the taper through the junction, are the real answer and a bigger
    job; see docs/corridor/LANES-AND-SIGNALS.md. This is the number that is right for most of the
    road rather than the number that is right for none of it.
    """
    metres: dict[int, float] = {}
    for wy in chain:
        raw = str(wy.get("tags", {}).get("lanes", "")).split(";")[0].strip()
        try:
            n = int(raw)
        except (TypeError, ValueError):
            continue
        if not 1 <= n <= 12:
            continue
        pts = [(p["lon"], p["lat"]) for p in wy.get("geometry", [])]
        if len(pts) < 2:
            continue
        x, y = frame.from_wgs(np.array([p[0] for p in pts]), np.array([p[1] for p in pts]))
        length = float(np.hypot(np.diff(x), np.diff(y)).sum())
        metres[n] = metres.get(n, 0.0) + length
    if not metres:
        return None
    return max(metres.items(), key=lambda kv: kv[1])[0]


def _chain_line(chain: list[dict], frame: Frame) -> LineString:
    coords: list[tuple[float, float]] = []
    for wy in chain:
        pts = [(p["lon"], p["lat"]) for p in wy["geometry"]]
        if coords and coords[-1] == pts[0]:
            pts = pts[1:]
        coords.extend(pts)
    lon = np.array([c[0] for c in coords])
    lat = np.array([c[1] for c in coords])
    x, y = frame.from_wgs(lon, lat)
    return LineString(np.column_stack([x, y]))


#: every highway kind a car can drive on, for `all_streets` sites
DRIVABLE = (
    "motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential",
    "living_street", "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link",
)

UNNAMED = "«unnamed»"


def selection_polygon(site: dict, frame: Frame):
    """The drawn boundary, in the site frame, or None when the world is still a centre and a radius.

    The bake used to throw this away and take the square around the smallest circle that contained
    it. A long rectangle became a square on its diagonal, and everything outside the drawing was
    fetched anyway. When a boundary is present it is the world: roads, imagery and the region.
    """
    ring = site.get("boundary") or []
    if not isinstance(ring, list) or len(ring) < 3:
        return None
    pts = []
    for p in ring:
        if isinstance(p, (list, tuple)) and len(p) >= 2:
            x, y = frame.from_wgs(float(p[0]), float(p[1]))
            pts.append((float(x), float(y)))
    if len(pts) < 3:
        return None
    poly = Polygon(pts)
    if not poly.is_valid:
        poly = poly.buffer(0)
    if poly.is_empty or poly.geom_type != "Polygon" or poly.area <= 0:
        return None
    return poly


def roads(site: dict, frame: Frame, cache: Path) -> dict:
    """Every chain of every road we want, with junctions, the primary picked out.

    Two ways to say which roads. A `roads` LIST names them, which is what the first network site
    did — Crofton/Crownsville is 18 named roads over a 9 km radius, chosen by hand. That is also a
    ceiling nobody could see: the viewer drew 18 of the 10 593 drivable ways in that extract, so
    most of the street furniture built off the OSM data had no road to belong to and was correctly
    dropped (112 of 205 signal masts, and 20 491 sidewalk stations with no kerb).

    `all_streets: true` takes every drivable way in the radius instead. Identity is then the way's
    own name, or its ref, or `UNNAMED` — and since chains are split by CONNECTIVITY, two unrelated
    "Oak Court"s stay two chains and a run of unnamed links still joins into one.
    """
    wanted = list(site.get("roads") or [])
    all_streets = bool(site.get("all_streets"))
    refs = {r for r in wanted if REF_RE.match(r)}
    names = {r for r in wanted if r not in refs}
    ox, oy = frame.origin
    R = float(site.get("radius_m", 9000))
    sel = selection_polygon(site, frame)
    if sel is not None:
        minx, miny, maxx, maxy = sel.bounds
        pad = 40.0  # a road that crosses the edge still arrives, then the polygon drops it
        w, s, e, n = frame.bbox_wgs(minx - pad, miny - pad, maxx + pad, maxy + pad)
    else:
        w, s, e, n = frame.bbox_wgs(ox - R, oy - R, ox + R, oy + R)
    esc = lambda v: v.replace("(", "\\(").replace(")", "\\)").replace(".", "\\.")  # noqa: E731
    parts = []
    if all_streets:
        parts.append(f'way({s},{w},{n},{e})[highway~"^({"|".join(DRIVABLE)})$"];')
    else:
        if names:
            parts.append(f'way({s},{w},{n},{e})[highway][name~"^({"|".join(esc(x) for x in sorted(names))})$"];')
            parts.append(f'way({s},{w},{n},{e})[highway][alt_name~"^({"|".join(esc(x) for x in sorted(names))})$"];')
        if refs:
            parts.append(f'way({s},{w},{n},{e})[highway][ref~"(^|;)({"|".join(esc(x) for x in sorted(refs))})(;|$)"];')
    if not parts:
        raise RuntimeError(f"site {site.get('slug')} names no roads and is not all_streets")
    q = f"[out:json][timeout:300];({''.join(parts)});out geom;"
    ways = [x for x in osm.overpass(q, cache)["elements"] if x.get("geometry") and x.get("nodes")]
    by: dict[str, list[dict]] = {}
    for wy in ways:
        t = wy.get("tags", {})
        if t.get("highway") in ("footway", "path", "cycleway", "pedestrian", "steps", "bridleway", "service", "track", "proposed", "construction"):
            continue
        if all_streets:
            ident = t.get("name") or (str(t.get("ref")).split(";")[0].strip() if t.get("ref") else None) or UNNAMED
        else:
            ident = _ident(t, refs, names)
        if ident:
            by.setdefault(ident, []).append(wy)
    chains: list[dict] = []
    for ident, ws in by.items():
        for c in osm._chains(ws):
            ln = _chain_line(c, frame)
            if ln.length < MIN_CHAIN_M:
                continue
            tags0 = c[0].get("tags", {})
            chains.append({
                "ident": ident, "ways": c, "line": ln, "length_m": round(float(ln.length), 1),
                "name": tags0.get("name"), "ref": tags0.get("ref"), "highway": tags0.get("highway"),
                "lanes": _chain_lanes(c, frame), "oneway": tags0.get("oneway"),
                "nodes": {nid for w2 in c for nid in w2["nodes"]},
            })
    if sel is not None:
        chains = [c for c in chains if c["line"].intersects(sel)]
    if not chains:
        raise RuntimeError(f"no ways for roads {wanted} within {R:.0f} m of {site['lat']},{site['lon']}")
    # the primary: the longest chain of the primary identity (or the longest chain of all)
    prim_id = site.get("primary")
    prim_cands = [c for c in chains if c["ident"] == prim_id] or chains
    primary = max(prim_cands, key=lambda c: c["length_m"])
    # STABLE IDS, not positional. Chain ids key the branch profiles in branches.json, and numbering
    # them by enumeration meant that lowering MIN_CHAIN_M from 120 m to 50 m — two extra chains,
    # inserted in the middle — renumbered everything after them: 21 of Crofton's 39 branches ended
    # up carrying a DIFFERENT road's grade, silently. An id derived from the chain's own smallest
    # OSM way id survives any change to the chain SET, and changes only when that chain's own ways
    # change — in which case the stale profile fails to match and is recomputed, which is the safe
    # failure rather than the silent one.
    for c in chains:
        c["id"] = f"r{min(w['id'] for w in c['ways'])}"
    # junctions: nodes shared between chains; position from any way's geometry that carries the node
    node_xy: dict[int, tuple[float, float]] = {}
    node_ll: dict[int, tuple[float, float]] = {}
    for c in chains:
        for wy in c["ways"]:
            for nid, g in zip(wy["nodes"], wy["geometry"]):
                if nid not in node_xy:
                    x, y = frame.from_wgs(g["lon"], g["lat"])
                    node_xy[nid] = (float(x), float(y))
                    node_ll[nid] = (float(g["lon"]), float(g["lat"]))
    owners: dict[int, set[str]] = {}
    for c in chains:
        for nid in c["nodes"]:
            owners.setdefault(nid, set()).add(c["id"])
    by_id = {c["id"]: c for c in chains}
    for c in chains:
        js = []
        for nid in c["nodes"]:
            others = owners.get(nid, set()) - {c["id"]}
            if others:
                x, y = node_xy[nid]
                lon, lat = node_ll[nid]
                # `lon`/`lat` are the junction's POSITION; `x`/`y` are a convenience in the frame
                # this file is tagged with (FRAME.md: WGS84 is the authority, ENU is a render
                # frame). A reader places the junction from lon/lat under whatever frame it
                # holds — see `place_junctions` for why the ENU pair alone was not enough.
                js.append({"node": nid, "x": round(float(frame.to_enu(x, y)[0]), 1), "y": round(float(frame.to_enu(x, y)[1]), 1), "lon": round(lon, 7), "lat": round(lat, 7), "s": round(float(c["line"].project(Point(x, y))), 1), "with": sorted(by_id[o]["ident"] for o in others)})
        js.sort(key=lambda j: j["s"])
        c["junctions"] = js
    found = sorted({c["ident"] for c in chains})
    missing = sorted(set(wanted) - set(found))
    return {"chains": chains, "primary": primary, "found": found, "missing": missing, "ways": len(ways)}


DEAD_END_RADIUS = {"residential": 9.0, "unclassified": 9.0, "tertiary": 9.0, "living_street": 8.0, "service": 6.0}
DEAD_END_DEFAULT = 9.0
BOUNDARY_M = 60.0  # an end this close to the query box was CLIPPED by us, not built as a dead end


def dead_ends(chains: list[dict], frame: Frame, cache: Path, radius_m: float, site_lat: float, site_lon: float, clip=None) -> None:
    """Mark each chain end as a cul-de-sac, a true dead end, or neither (Rich, 2026-09-21).

    "If a street dead ends, assume a cul de sac, make it so this can be overridden into a true dead
    end." So the bake says which ends are ends, and uses OSM's own answer where OSM has one.

    MEASURED on arrowhead-farms-network, because the first version found 1 end in a neighbourhood
    that is almost entirely cul-de-sacs, and both reasons were mine:

      * 8 of its 21 end nodes carry `highway=turning_circle` — OSM marks the bulb explicitly, and
        that tag should decide the question on its own.
      * every bulb also has DRIVEWAYS on it (`highway=service`), 2 to 4 of them. Counting any
        highway way as "this end meets another road" suppressed every one. Only a way a car could
        route through counts: service roads, tracks, footways and paths do not make a junction.
        And the comparison has to be against OUR WAYS at that node, not our chain-END records —
        a node where two of our own ways meet is still one road.

    Radius is to the pavement EDGE: 9 m for a residential bulb (the 18 m diameter US standard),
    6 m for a service road. Written onto each chain as `dead_ends`; nothing else moves.
    """
    ROUTABLE = {"motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential", "living_street", "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link"}
    ends: dict[int, list[tuple[dict, float]]] = {}
    for c in chains:
        ways = c["ways"]
        for node, s_at in ((ways[0]["nodes"][0], 0.0), (ways[-1]["nodes"][-1], float(c["line"].length))):
            ends.setdefault(node, []).append((c, s_at))
    node_tags: dict[int, dict] = {}
    node_routable: dict[int, set[int]] = {}
    if ends:
        # `id:` takes COMMAS (semicolons are a syntax error and every mirror 400s), and the ways go
        # out as `body` — ids AND nodes AND tags — because the node list says which end a way
        # touches and the tags say whether it is a road or somebody's driveway.
        ids = ",".join(str(n) for n in sorted(ends))
        q = f"[out:json][timeout:180];node(id:{ids})->.e;.e out tags;way(bn.e)[highway];out body;"
        try:
            for el in osm.overpass(q, cache)["elements"]:
                if el["type"] == "node":
                    node_tags[el["id"]] = el.get("tags", {})
                    continue
                if el.get("tags", {}).get("highway") not in ROUTABLE:
                    continue
                for nid in el.get("nodes", []) or []:
                    if nid in ends:
                        node_routable.setdefault(nid, set()).add(el["id"])
        except Exception as exc:  # a dead end we cannot confirm is better than a failed bake
            print(f"  ends    overpass failed ({exc}); assuming every unshared end is a cul-de-sac")
    ox, oy = frame.origin
    for c in chains:
        c["dead_ends"] = []
    n_osm = n_assumed = 0
    for node, owners in ends.items():
        t = node_tags.get(node, {})
        osm_bulb = t.get("highway") in ("turning_circle", "turning_loop")
        for c, s_at in owners:
            # Any ROUTABLE way at this node other than THIS CHAIN's own ways makes it a junction —
            # including one of our own roads, which is the usual case: a cul-de-sac's inner end
            # sits MID-WAY along the street it comes off, so that street never appears as an "end"
            # here. Excluding every road in the network (the first fix) put a bulb on the joined end
            # of almost every street in the neighbourhood.
            own = {w["id"] for w in c["ways"]}
            if not osm_bulb and (node_routable.get(node, set()) - own):
                continue
            p = c["line"].interpolate(s_at)
            # clipped by the selection, or by the radius square when there is no selection: the
            # road continues and our world does not, so it is not a cul-de-sac
            if clip is not None:
                if p.distance(clip.boundary) < BOUNDARY_M or not clip.covers(p):
                    continue
            elif min(abs(p.x - (ox - radius_m)), abs(p.x - (ox + radius_m)), abs(p.y - (oy - radius_m)), abs(p.y - (oy + radius_m))) < BOUNDARY_M:
                continue
            rad = DEAD_END_RADIUS.get(c["highway"] or "", DEAD_END_DEFAULT)
            c["dead_ends"].append({
                "s": round(s_at, 1), "kind": "cul_de_sac", "radius_m": round(rad, 1),
                "source": "osm" if osm_bulb else "assumed", "node": node,
                "x": round(float(frame.to_enu(p.x, p.y)[0]), 1), "y": round(float(frame.to_enu(p.x, p.y)[1]), 1),
            })
            if osm_bulb:
                n_osm += 1
            else:
                n_assumed += 1
    print(f"  ends    {n_osm + n_assumed} dead ends ({n_osm} marked by OSM, {n_assumed} assumed cul-de-sacs)", flush=True)


def write_vectors(site: dict, frame: Frame, R: dict, out: Path, half_width: float, cache: Path) -> dict:
    """spine_utm.json / spine.geojson / site.json / osm.geojson / crossings.json for a network."""
    ox, oy = frame.origin
    prim = R["primary"]
    line: LineString = prim["line"]
    site_pt = Point(*frame.origin)
    photo_s = float(line.project(site_pt))
    segs = []
    acc = 0.0
    for wy in prim["ways"]:
        ln = osm._way_line(wy, frame)
        segs.append({"osm_id": wy["id"], "s_start": round(acc, 1), "s_end": round(acc + ln.length, 1), "tags": wy.get("tags", {})})
        acc += ln.length
    siblings = []
    for c in R["chains"]:
        if c is prim:
            continue
        siblings.append({
            "osm_ids": [wy["id"] for wy in c["ways"]], "tags": c["ways"][0].get("tags", {}), "geometry": mapping(c["line"]),
            "id": c["id"], "name": c["name"], "ref": c["ref"], "ident": c["ident"], "highway": c["highway"], "lanes": c["lanes"], "oneway": c["oneway"],
            "length_m": c["length_m"], "junctions": c["junctions"], "dead_ends": c.get("dead_ends", []),
        })
    (out / "spine_utm.json").write_text(json.dumps({
        "epsg": frame.epsg, "coords": np.array(line.coords).round(2).tolist(), "photo_s": round(photo_s, 1), "segments": segs, "siblings": siblings,
        "network": True, "primary": {"id": prim["id"], "ident": prim["ident"], "length_m": prim["length_m"], "junctions": prim["junctions"], "dead_ends": prim.get("dead_ends", [])}, "roads": R["found"],
    }))
    xs, ys = np.array(line.coords)[:, 0], np.array(line.coords)[:, 1]
    lon, lat = frame.to_wgs(xs, ys)
    (out / "spine.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {"name": prim["ident"], "photo_s": round(photo_s, 1)}, "geometry": {"type": "LineString", "coordinates": np.column_stack([lon, lat]).round(7).tolist()}}]}))
    corridor = unary_union([c["line"].buffer(half_width, cap_style="flat") for c in R["chains"]])
    #
    # THE CORRIDOR IS NOT THE WORLD.
    #
    # `corridor` means "near a road" and keeps meaning it: the lidar profile along each chain, the
    # near-road point accounting, structures and clearances all want it. But clipping the IMAGERY,
    # the LIDAR and the VEGETATION to it is what makes trees stop 150 m from the tarmac -- Rich,
    # 2026-09-27: "proximity to a road shouldn't really dictate tree mappings and ground textures
    # -- let's build the full world out for a given network."
    #
    # So `region` is the world: the rectangle the network spans plus a margin, so you do not drive
    # to a hard edge the moment you leave the outermost street. A rectangle rather than the
    # network's convex hull because a hull gives a world ragged diagonal edges for nothing, and
    # measured on crofton-triangle the bbox is only 1.29x the hull.
    #
    # `world` is still what adds the margin and widens the OSM query to the region's hull. The
    # REGION itself is the bbox for every network now, not the corridor (Rich, 2026-10-10: "remove
    # the strip logic and have full world trees"): the world editor never sets `world`, so its
    # radius-drawn worlds (dc-metro-take-2) had their imagery and their point cloud cut to a band
    # along the roads. See docs/corridor/PLAN-OPEN-WORLD.md.
    #
    world = bool(site.get("world"))
    margin = float(site.get("world_margin_m", 300.0))
    sel = selection_polygon(site, frame)
    if sel is not None:
        # the drawing is the world. No margin, and no square around the circle that contained it.
        bbox = snap_bbox(sel.bounds)
        region = sel
    else:
        bbox = snap_bbox(corridor.buffer(margin).bounds if world else corridor.bounds)
        region = shp_box(*bbox)
    ident = {"ref": prim["ref"]} if prim["ref"] else {"name": prim["ident"]}
    site_json = {**site, "frame": {"epsg": frame.epsg, "origin": frame.origin}, "bbox_utm": bbox, "corridor": mapping(corridor), "region": mapping(region), "world": world, "ident": ident}
    (out / "site.json").write_text(json.dumps(site_json))
    feats = osm.features(sel if sel is not None else (region.convex_hull if world else corridor.convex_hull), frame, cache)
    (out / "osm.geojson").write_text(json.dumps(feats))
    osm.write_context(feats, out)
    cross = osm.crossings(line, feats, ident, frame, segs)
    (out / "crossings.json").write_text(json.dumps(cross, indent=1))
    return {"corridor": corridor, "region": region, "world": world, "bbox": bbox, "segments": segs, "crossings": cross, "features": len(feats["features"]), "ident": ident, "photo_s": photo_s}


def summary(R: dict) -> str:
    prim = R["primary"]
    return f"{len(R['chains'])} chains from {R['ways']} ways; primary {prim['ident']} {prim['length_m']} m with {len(prim['junctions'])} junctions; roads {R['found']}; missing {R['missing']}"


# --- the bake ----------------------------------------------------------------------------------


def branch_record(c: dict, prim: dict, bp: dict | None) -> dict:
    """One `branches.json` entry (fetch_site's `branch_rec`, hoisted so a shard can reuse it)."""
    return {"id": c["id"], "ident": c["ident"], "name": c["name"], "ref": c["ref"], "highway": c["highway"], "lanes": c["lanes"], "oneway": c["oneway"], "length_m": c["length_m"], "s_on_primary": round(float(prim["line"].project(c["line"].interpolate(0.5, normalized=True))), 1), "junctions": c["junctions"], "dead_ends": c.get("dead_ends", []), "profile": {"step_m": bp["step_m"], "s": bp["s"], "road_z": bp["road_z"]} if bp else None, "structures": bp["structures"] if bp else []}


# --- where a junction IS ------------------------------------------------------------------------
#
# `junctions[].x/y` in spine_utm.json and branches.json are ENU metres about the frame origin the
# file was written with, and the file used to say only `"frame": "enu"` — which frame, it did not
# say. That was enough until the origin moved: crofton-triangle's vectors were written on 2026-09-26
# about sites.json's centre (354269, 4318567) and the world editor's site.json of 2026-10-02 put the
# origin at (355342, 4318965), 1.14 km away. `export_site` builds its frame from site.json, so a
# re-export read x/y written about one origin as if they were about the other: every junction
# 1,082 m from its road, the viewer's junction meet finding nothing (0 met, 604 without a target).
# The on-read "repair" that was here measured which of two readings — ENU as-is, or UTM-relative
# converted — lay nearer the road and chose the nearer; with the origin wrong BOTH readings were a
# kilometre out, and it chose the one 1,068 m off over the one 1,082 m off and said "converted".
#
# So no reader takes a frame-relative number on trust any more. A junction's POSITION is the OSM
# node's lon/lat (`roads` writes it; FRAME.md: WGS84 is the authority), and a file from before that
# key still carries `s`, the station along the chain's own ABSOLUTE-UTM polyline, which is the same
# vertex to 5 cm (the rounding of `s`). Either is placed under whatever frame the reader holds, so
# reading twice is reading once. The tag is kept, with its origin, because it is what a reader that
# still consumed x/y could check against — and so the next person to open the file can see which
# ENU it means. Placement is then ASSERTED: a junction belongs to its own road by construction, so
# one more than JUNCTION_OFF_ROAD_M from its polyline is a wrong input, not a warning.

JUNCTION_OFF_ROAD_M = 1.0


class FrameFault(BakeFault):
    """A junction that could not be placed on its own road — an input in the wrong frame."""


def frame_tag(frame: Frame) -> dict:
    """The `frame` block an intermediate (spine_utm.json, branches.json) is written under."""
    return {"kind": "enu", "epsg": int(frame.epsg), "origin": [float(frame.origin[0]), float(frame.origin[1])]}


def branches_doc(branches: list[dict], frame: Frame | dict | None) -> str:
    """`branches.json`'s text: the frame tag (from a Frame, or a tag copied from another file) and
    the records. The one place the file's shape is spelled out."""
    tag = frame_tag(frame) if isinstance(frame, Frame) else (frame or "enu")
    return json.dumps({"frame": tag, "branches": branches})


def site_frame(site_dir: Path) -> Frame:
    """The frame a site's intermediates are read under: site.json's, which is what export_site
    uses; manifest.json's for a site from before site.json carried one."""
    for name in ("site.json", "manifest.json"):
        p = site_dir / name
        if p.exists():
            fr = (json.loads(p.read_text()).get("frame") or {})
            if fr.get("origin"):
                return Frame(int(fr["epsg"]), (float(fr["origin"][0]), float(fr["origin"][1])))
    raise FrameFault(f"{site_dir.name}: neither site.json nor manifest.json records a frame")


def place_junctions(frame: Frame, junctions: list[dict], line_utm, what: str = "a road") -> list[dict]:
    """
    Every junction of one road with `x`/`y` in `frame`, placed from what the record MEANS.

    `lon`/`lat` when the record has them (every file written since this function), else the chain's
    own polyline at station `s` (every file before it — the vertex the node was, to the rounding of
    `s`), else the stored x/y as a last resort. `line_utm` is the road's absolute-UTM polyline — the
    sibling's `geometry`, the spine's `coords` — the one thing in these files that never depended on
    an origin. Then the placement is measured, because a junction that is not on its own road is
    not a junction: a record further than JUNCTION_OFF_ROAD_M from the polyline raises FrameFault
    with the numbers, so a re-export of a file in the wrong frame fails here and not in the viewer.
    """
    out: list[dict] = []
    if not junctions:
        return out
    ln = line_utm if isinstance(line_utm, LineString) else (LineString(line_utm) if line_utm is not None and len(line_utm) >= 2 else None)
    pe = pn = None
    if ln is not None:
        a = np.asarray(ln.coords, dtype=float)
        pe, pn = frame.to_enu(a[:, 0], a[:, 1])
        pe, pn = np.asarray(pe, dtype=float), np.asarray(pn, dtype=float)
    worst = 0.0
    for j in junctions:
        if j.get("lon") is not None and j.get("lat") is not None:
            ux, uy = frame.from_wgs(float(j["lon"]), float(j["lat"]))
            how = "lon/lat"
        elif ln is not None and j.get("s") is not None:
            p = ln.interpolate(min(max(float(j["s"]), 0.0), ln.length))
            ux, uy = p.x, p.y
            how = "s"
        else:
            ux = uy = None
            how = "x/y"
        if ux is None:
            e, n = float(j["x"]), float(j["y"])
        else:
            ee, nn = frame.to_enu([float(ux)], [float(uy)])  # vectorised, like every caller of to_enu
            e, n = float(np.asarray(ee).ravel()[0]), float(np.asarray(nn).ravel()[0])
        if pe is not None:
            d = float(np.hypot(pe - e, pn - n).min())
            worst = max(worst, d)
            if d > JUNCTION_OFF_ROAD_M:
                raise FrameFault(
                    f"junction node {j.get('node')} of {what} placed from {how} lands {d:.1f} m from its own road "
                    f"(limit {JUNCTION_OFF_ROAD_M} m): the record's frame does not match the one being exported under "
                    f"(origin {frame.origin[0]:.0f}, {frame.origin[1]:.0f}); the vectors need a revector")
        out.append({**j, "x": round(e, 1), "y": round(n, 1)})
    return out


def lidar_reads_region(site: dict) -> bool:
    """Whether a network bake reads the point cloud over its whole region (the default) or only
    over its streets (`"lidar_area": "streets"` in the site file, for a single long highway through
    open country, where the region's bbox is a hundred times the road)."""
    return str(site.get("lidar_area", "region")).strip().lower() != "streets"


def world_lidar_area(site: dict, region, streets):
    """The area a tiled network bake reads and rasterises the point cloud over: the world region
    and the streets together (a chain's tail can leave a drawn boundary, and its profile still
    needs ground), or the streets alone when the site asks for that (`lidar_reads_region`).

    The streets stay the ROAD BAND whichever it is (`road_band` in network_tiles.lidar_tiled): the
    survey, its depth and the near-road cloud are chosen over them, so the profiles and structures
    are the same.
    """
    if not lidar_reads_region(site) or region is None or region.is_empty:
        return streets
    return unary_union([region, streets])


def fetch_site(site: dict, half_width: float, lidar_half_width: float, skip: set[str], data: Path, cache: Path) -> None:
    """A network site through the single-image pipeline: the union corridor's bbox is the raster
    extent (fine for a neighbourhood; the 18 km Crofton region goes through the tiled path). Every
    branch gets its own lidar profile (road grade, structures) into branches.json; export.py turns
    those into the manifest's `branches`."""
    from shapely.geometry import LineString

    from . import dem, geology, horizon, lidar, naip

    slug = site["slug"]
    lidar_half_width = min(lidar_half_width, half_width)  # §6: ±150 m per road for every layer
    out = data / "sites" / slug
    out.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    asked = "every drivable street" if site.get("all_streets") else f"roads {len(site.get('roads') or [])}"
    print(f"=== {slug}  network ({site['lat']:.5f}, {site['lon']:.5f}) {asked}")
    frame = Frame.at(site["lon"], site["lat"])
    manifest: dict = json.loads((out / "manifest.json").read_text()) if (out / "manifest.json").exists() else {}
    manifest |= {"slug": slug, "world": bool(site.get("world")), "kind": "network", "frame": {"epsg": frame.epsg, "origin": frame.origin}, "fetched": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "params": {"half_width_m": half_width, "lidar_half_width_m": lidar_half_width, "radius_m": site.get("radius_m"), "horizon_radius_m": 30000.0}}
    R = roads(site, frame, cache / "overpass")
    print(f"  roads   {summary(R)}", flush=True)
    dead_ends(R["chains"], frame, cache / "overpass", float(site.get("radius_m", 9000)), site["lat"], site["lon"], clip=selection_polygon(site, frame))
    V = write_vectors(site, frame, R, out, half_width, cache / "overpass")
    corridor = V["corridor"]
    region = V["region"]
    world = V["world"]
    bbox = V["bbox"]
    #
    # THE STREETS ARE `lidar_corridor`; THE POINT CLOUD IS READ OVER THE WORLD (world_lidar_area).
    #
    # Everything road-local -- the DTM under the carriageway, bridge-deck clearances, structures,
    # the along-track profile -- is still decided by the streets: the survey and its depth are
    # chosen over them and the near-road cloud is the points inside them. The rasters (DTM, DSM,
    # CHM, deck and building counts) cover the whole region, so the canopy no longer stops at a
    # band along the roads with the global model painted between.
    #
    # The streets-only read of 2026-09 died twice on a four-gigabyte machine at 2.45x the ground;
    # what made that fatal (every point held, the accumulators allocated up front, an unbounded
    # reader queue) is streamed now: points go into 1 km tile accumulators batch by batch, and only
    # the near-road ones are kept. dc-metro-take-2 shard 5, full block: see the commit message.
    lidar_corridor = unary_union([c["line"].buffer(lidar_half_width, cap_style="flat") for c in R["chains"]])
    print(f"  osm     {V['features']} features, {len(V['crossings'])} crossings on the primary; bbox {(bbox[2] - bbox[0]) / 1000:.1f} × {(bbox[3] - bbox[1]) / 1000:.1f} km, corridor {corridor.area / 1e6:.1f} km²" + (f", WORLD {region.area / 1e6:.1f} km² ({region.area / max(corridor.area, 1):.2f}x)" if world else ""), flush=True)
    prim = R["primary"]
    # `tiled` on the site is the editor's default: every world it bakes is cut into tiles,
    # however small. The 6 km test remains for a site file that never said, so an old
    # definition of a large world still tiles.
    asked = bool(site.get("tiled"))
    tiled = asked or max(bbox[2] - bbox[0], bbox[3] - bbox[1]) > 6000.0
    manifest["tiled"] = tiled
    if tiled:
        why = "editor bake" if asked else "bbox over 6 km"
        print(f"  tiled   {why}: rasters over the region, cut into 1 km tiles", flush=True)
    manifest["spine"] = {"ident": V["ident"], "nearest_way": prim["ways"][0]["id"], "snap_distance_m": round(float(prim["line"].distance(Point(*frame.origin))), 1), "photo_s": round(V["photo_s"], 1), "length_m": prim["length_m"], "trimmed": [False, False], "network": True, "roads": R["found"], "roads_missing": R["missing"], "chains": len(R["chains"])}
    manifest["osm"] = {"features": V["features"], "crossings": len(V["crossings"])}

    if "dem" not in skip:
        manifest["dem"] = dem.fetch_dem(frame, bbox, out / "dem_1m.tif", cache)
    if "naip" not in skip:
        if tiled:
            from . import network_tiles

            # the file keeps its name (several readers key off it); the resolution is NAIP_RES_M
            fresh = network_tiles.naip_tiled(frame, bbox, region, out / "naip_1m.tif", cache, res=network_tiles.NAIP_RES_M)
        else:
            fresh = naip.fetch_naip(frame, bbox, out / "naip.tif", cache)
        # a cached raster returns {"cached": true}; keep the first run's sources and items under it
        prev = manifest.get("naip")
        manifest["naip"] = {**prev, **fresh} if fresh.get("cached") and isinstance(prev, dict) else fresh
    #
    # THE CANOPY OF A WORLD COMES FROM THE GLOBAL MODEL, NOT FROM THE POINT CLOUD.
    #
    # `network_tiles` has read `canopy_global.tif` for a while and nothing has ever written it, so
    # the fill path it describes has never once run. That is what makes a world's trees stop at the
    # corridor: the lidar CHM is rasterised only in a band along the roads, and outside that band
    # "no lidar" was written as "0 m canopy", which the tree planter reads as "no trees".
    #
    # The Meta/WRI global model is the same product at the same resolution for the whole planet,
    # and `canopy.fetch_chm` streams it out of S3 through gdalwarp -- so it costs an HTTP fetch of
    # a precomputed raster and a few hundred megabytes of output, against the tens of gigabytes of
    # LAZ that the point cloud needs. It is also the only canopy available outside the United
    # States at all.
    #
    # At 2 m rather than 1: the viewer plants from a CHM it reads on a 4 m lattice, and 112 km2 at
    # 1 m is 450 MB of Float32 to produce a picture nothing samples that finely.
    #
    if "horizon" not in skip:
        manifest["horizon"] = horizon.fetch_horizon(frame, out / "horizon_30m.tif", cache, radius_m=30000.0)
    if "geology" not in skip:
        # units under every chain, merged: the primary first so `samples` keep their meaning
        g = geology.along_spine(prim["line"], frame, site, cache, out)
        units = {u["map_id"]: u for u in g["units"]}
        for c in R["chains"]:
            if c is prim:
                continue
            g2 = geology.along_spine(c["line"], frame, site, cache, out, step_m=500.0)
            for u in g2["units"]:
                units.setdefault(u["map_id"], u)
        g["units"] = list(units.values())
        g["named_formations"] = sorted({u["strat_name"] for u in units.values() if u.get("strat_name")})
        (out / "geology.json").write_text(json.dumps(g, indent=1))
        print(f"  geology {len(g['units'])} units; named: {', '.join(g['named_formations'][:6])}")
        manifest["geology"] = {"units": len(g["units"]), "named_formations": g["named_formations"]}
    branches: list[dict] = []

    def branch_rec(c: dict, bp: dict | None) -> dict:
        return branch_record(c, prim, bp)

    #
    # NO LIDAR IS NOT A FAILED BAKE.
    #
    # TNM is the USGS's index, so it stops at the United States border. Rich drew a world over
    # Monte Bondone on 2026-09-27; the bake ran roads, OSM, GLO-30 elevation, Sentinel-2 imagery,
    # horizon and geology, and then died in this stage with `no TNM lidar for this region` and a
    # Job backoff limit. Every earlier stage was already on disk and correct.
    #
    # So the point cloud is now OPTIONAL and the profiles fall back to the elevation model. What
    # is lost is real and worth naming: bridge decks and overpasses (read from classified returns,
    # not inferrable from a surface), and the accuracy of the road itself, because GLO-30 is a 30 m
    # SURFACE model that includes the trees and the roofs. What is kept is a world with its roads
    # at the right height instead of at sea level.
    #
    no_lidar: str | None = None
    if "lidar" not in skip and tiled:
        from . import network_tiles

        ldir = out / "lidar"
        larea = world_lidar_area(site, region, lidar_corridor)
        lbbox = snap_bbox(larea.bounds)
        try:
            meta = network_tiles.lidar_tiled(frame, lbbox, larea, R["chains"], ldir, cache, road_band=lidar_corridor)
        except network_tiles.NoLidarHere as exc:
            no_lidar = str(exc)
            meta = None
    else:
        meta = None
    if no_lidar is None and "lidar" not in skip and tiled:
        pts = meta.pop("pts")
        idx = {c["id"]: i + 1 for i, c in enumerate(R["chains"])}
        over_s = network_tiles.crossings_over(out)
        with progress.heartbeat("profile", f"primary {prim['ident']} {prim['line'].length / 1000:.0f} km"):
            prof = network_tiles.profile_tiled(prim["line"], ldir, pts, idx[prim["id"]], crossings_over_s=over_s)
        (out / "profile.json").write_text(json.dumps(prof))
        cls = meta["classes"]
        print(f"  lidar   {meta['points_in_corridor']:,} pts in corridor over {len(meta['tiles']['list'])} km tiles; ground {cls.get('ground', 0):,} veg {cls.get('veg_high', 0) + cls.get('veg_med', 0) + cls.get('veg_low', 0):,} building {cls.get('building', 0):,} bridge_deck {cls.get('bridge_deck', 0):,}; {meta['near_road_points']:,} near-road points kept", flush=True)
        for st in prof["structures"]:
            print(f"  struct  {st['kind']:8s} s={st['s_start']:.0f}..{st['s_end']:.0f} m ({st['length_m']} m)  clearance={st['clearance_m']}  above_ground={st['height_above_ground_m']}")
        manifest["lidar"] = {**meta, "structures": prof["structures"]}
        # Every branch is an independent profile, and there are 10,137 of them here — so they are
        # fanned out across processes. `profile_many` groups the cloud once (the old loop rescanned
        # all 669 M points per chain) and forks, so the cloud is shared copy-on-write, not pickled.
        others = [c for c in R["chains"] if c is not prim]
        tasks = [(idx[c["id"]], c["ident"], c["line"], None) for c in others]
        for c, bp in zip(others, network_tiles.profile_many(tasks, ldir, pts)):
            branches.append(branch_rec(c, bp))
        print(f"  branch  {len(branches)} branches profiled, {sum(len(b['structures']) for b in branches)} structures on them", flush=True)
    elif no_lidar:
        # Elevation-derived profiles: the road is where the DEM says, and there are no structures.
        from . import network_tiles

        print(f"  lidar   none here ({no_lidar}); road profiles from the elevation model instead", flush=True)
        dem_p = out / "dem_1m.tif"
        if not dem_p.exists():
            print("  lidar   and no elevation model either — every branch would sit at sea level, so this bake stops", flush=True)
            raise RuntimeError("no lidar and no DEM: nothing can say how high the roads are")
        prof = network_tiles.profile_from_dem(prim["line"], dem_p)
        (out / "profile.json").write_text(json.dumps(prof))
        manifest["lidar"] = {"source": "none", "why": no_lidar, "profiles_from": "dem", "structures": []}
        failed = 0
        for c in R["chains"]:
            if c is prim:
                continue
            try:
                bp = network_tiles.profile_from_dem(c["line"], dem_p)
            except Exception as exc:
                if failed == 0:
                    print(f"  branch  {c['ident']} profile failed: {exc}")
                failed += 1
                bp = None
            branches.append(branch_rec(c, bp))
        print(f"  branch  {len(branches)} branches profiled from the DEM, {failed} failed; no structures (a surface model has no bridge decks)", flush=True)
    elif "lidar" not in skip:
        # the single-image path: the whole corridor's points in memory, as for a single road.
        # STILL THE STREETS ONLY, on purpose: this path holds every point at once (lidar.rasters),
        # so the region's points would be the region's memory. Only a hand-written site under 6 km
        # with no `tiled` gets here -- the editor marks every bake tiled -- and its canopy past the
        # band comes from the global model (fetched below for `world` sites).
        ldir = out / "lidar"
        ldir.mkdir(exist_ok=True)
        lbbox = snap_bbox(lidar_corridor.bounds)
        try:
            pts, meta = lidar.fetch_points(frame, lbbox, cache, clip=lidar_corridor)
        except Exception as exc:
            # the same border, on the path a small site takes. lidar.py raises its own message
            # rather than NoLidarHere, so the test is on what it says.
            if "no lidar" not in str(exc).lower() and "no tnm" not in str(exc).lower():
                raise
            from . import network_tiles

            print(f"  lidar   none here ({exc}); road profiles from the elevation model instead", flush=True)
            dem_p = out / "dem_1m.tif"
            if not dem_p.exists():
                raise RuntimeError("no lidar and no DEM: nothing can say how high the roads are") from exc
            prof = network_tiles.profile_from_dem(prim["line"], dem_p)
            (out / "profile.json").write_text(json.dumps(prof))
            manifest["lidar"] = {"source": "none", "why": str(exc), "profiles_from": "dem", "structures": []}
            pbr = progress.Progress("branch", max(0, len(R["chains"]) - 1))
            for c in R["chains"]:
                if c is prim:
                    continue
                try:
                    branches.append(branch_rec(c, network_tiles.profile_from_dem(c["line"], dem_p)))
                except Exception:
                    branches.append(branch_rec(c, None))
                pbr.tick()
            pbr.close()
            print(f"  branch  {len(branches)} branches profiled from the DEM; no structures", flush=True)
            pts = None
        if pts is not None:  # the lidar half; the DEM fallback above already wrote its profiles
            if (out / "dem_1m.tif").exists():
                f = lidar.check_units(pts, out / "dem_1m.tif")
                if f != 1.0:
                    pts["z"] = pts["z"] * f
                meta["z_factor"] = f
            meta["classification"] = lidar.classification_quality(pts)
            r = lidar.rasters(pts, lbbox, frame, lidar_corridor, ldir)
            over_s = [c["s"] for c in V["crossings"] if c.get("relation") == "over"]
            with progress.heartbeat("profile", f"primary {prim['ident']} {prim['line'].length / 1000:.0f} km"):
                prof = lidar.profile(prim["line"], r["dtm"], r["chm"], r["transform"], r["pts"], crossings_over_s=over_s)
            (out / "profile.json").write_text(json.dumps(prof))
            cls = r["classes"]
            print(f"  lidar   {r['points_in_corridor']:,} pts in corridor; ground {cls.get('ground', 0):,} veg {cls.get('veg_high', 0) + cls.get('veg_med', 0) + cls.get('veg_low', 0):,} building {cls.get('building', 0):,} bridge_deck {cls.get('bridge_deck', 0):,}")
            for st in prof["structures"]:
                print(f"  struct  {st['kind']:8s} s={st['s_start']:.0f}..{st['s_end']:.0f} m ({st['length_m']} m)  clearance={st['clearance_m']}  above_ground={st['height_above_ground_m']}")
            manifest["lidar"] = {**meta, "points_in_corridor": r["points_in_corridor"], "classes": cls, "rasters": r["rasters"], "structures": prof["structures"]}
            pbr = progress.Progress("branch", max(0, len(R["chains"]) - 1))
            for c in R["chains"]:
                if c is prim:
                    continue
                branches.append(branch_rec(c, lidar.profile(c["line"], r["dtm"], r["chm"], r["transform"], r["pts"])))
                pbr.tick()
            pbr.close()
            print(f"  branch  {len(branches)} branches profiled, {sum(len(b['structures']) for b in branches)} structures on them", flush=True)
    else:
        # A partial re-run with lidar skipped ("a partial re-run updates the manifest it finds
        # rather than forgetting the rest") used to write every branch with profile: null and the
        # export then put all 427 of crofton-triangle's side streets at z = 0 — sea level, 40 m
        # under the terrain, with the verges grading down to them as walls (2026-09-26, after an
        # imagery-only re-fetch). The profiles the previous run computed are kept, keyed by id.
        had: dict[str, dict] = {}
        old_p = out / "branches.json"
        if old_p.exists():
            try:
                for b in (json.loads(old_p.read_text()).get("branches") or []):
                    if b.get("profile") and b.get("id"):
                        had[b["id"]] = b
            except Exception as exc:
                print(f"  branch  could not read the previous branches.json: {exc}")
        kept = 0
        for c in R["chains"]:
            if c is prim:
                continue
            prev = had.get(c["id"])
            bp = {"step_m": prev["profile"].get("step_m", 2.0), "s": prev["profile"]["s"], "road_z": prev["profile"]["road_z"], "structures": prev.get("structures") or []} if prev else None
            if bp:
                kept += 1
            branches.append(branch_rec(c, bp))
        if had:
            print(f"  branch  lidar skipped: kept {kept} of {len(branches)} branch profiles from the previous run", flush=True)
    #
    # THE GLOBAL CANOPY, AND WHEN IT IS NEEDED.
    #
    # This used to run only for a site marked `world`, and before the lidar stage -- so it could
    # not know whether there was a lidar canopy to fall back FROM. The world editor does not set
    # that flag (Rich's Monte Bondone came through as a plain `kind: network`), and outside the
    # United States there is no lidar canopy at all, so a bake there got no canopy from either
    # source. The viewer gates its whole distance field on having one: no canopy is a site that
    # comes up with nothing on it (export.py).
    #
    # So the test is now what it always meant: fetch the global model when this site is a world,
    # or when the point cloud did not give us a canopy of our own.
    #
    have_lidar_chm = (out / "lidar" / "chm.tif").exists() or (out / "lidar" / "chm.vrt").exists()
    # ...and for every TILED bake: its lidar now covers the region, but a survey's edge, a river or
    # the far side of a state line can still leave ground with no lidar at all, and that is what
    # the global model fills (export_tiles, pyramid, overview). The editor never sets `world`, so
    # gating on it alone meant its bakes with lidar never fetched the fallback.
    if (world or tiled or no_lidar or not have_lidar_chm) and "canopy" not in skip:
        from . import canopy

        try:
            manifest["canopy"] = canopy.fetch_chm(frame, tuple(bbox), out / "canopy_global.tif", cache, res=2.0)
        except Exception as exc:
            # not fatal: a world without trees is worse than a world, but it is still a world
            print(f"  canopy  global CHM unavailable: {exc}", flush=True)
    (out / "branches.json").write_text(branches_doc(branches, frame))
    manifest["branches"] = {"count": len(branches), "structures": sum(len(b["structures"]) for b in branches)}
    try:
        from . import preview

        preview.render(out)
    except Exception as exc:
        print(f"  preview failed: {exc}")
    if "surface" not in skip:
        try:
            from . import surface

            sf = surface.measure(out)
            if sf:
                print(f"  surface {sf['summary']}")
                manifest["surface"] = sf["summary"]
        except Exception as exc:
            print(f"  surface failed: {exc}")
    manifest["seconds"] = round(time.time() - t0, 1)
    (out / "manifest.json").write_text(json.dumps(manifest, indent=1, default=str))
    try:
        from . import export

        ex = export.export_site(out)
        export.write_index(data / "sites")
        print(f"  web     {', '.join(ex['layers'])} ({ex['bytes'] / 2**20:.1f} MiB)")
    except Exception as exc:
        import traceback

        traceback.print_exc()
        print(f"  web export failed: {exc}")
    print(f"  done    {manifest['seconds']} s -> {out}")


def fetch_shard(site: dict, index: int, half_width: float, lidar_half_width: float, skip: set[str], data: Path, cache: Path) -> None:
    """A sharded bake's step 2: the area stages for ONE block, into `sites/<slug>/shards/<index>/`.

    The global Network (`roads`, `dead_ends`, `site.json`, `spine_utm.json`, `osm.geojson`,
    `crossings.json`) is already on disk from `corridor plan`; this re-derives `R` through the same
    cached Overpass call so chain identity matches, keeps the primary plus the chains the plan
    assigned to this block, and runs the same tiled pipeline over a block-sized bbox. The primary is
    profiled WHOLE against this block's rasters with `fill=False`, so its out-of-block stations stay
    NaN for the finalizer's stitch — see `shards.stitch_profile`.

    The manifest/export are the finalizer's, not a shard's: a shard writes the raw rasters and the
    per-block vectors, and nothing global.
    """
    from . import dem, geology, horizon
    from . import shards as shardlib

    slug = site["slug"]
    lidar_half_width = min(lidar_half_width, half_width)
    out = data / "sites" / slug
    plan = shardlib.read_plan(out)
    if plan is None:
        raise RuntimeError(f"no plan for {slug!r}: run `corridor plan {slug}` first")
    sdir = shardlib.shard_dir(out, index)
    sdir.mkdir(parents=True, exist_ok=True)
    gj = json.loads((out / "site.json").read_text())
    frame = Frame(gj["frame"]["epsg"], tuple(gj["frame"]["origin"]))
    t0 = time.time()
    print(f"=== {slug}  shard {index}/{plan['n']}")

    R = roads(site, frame, cache / "overpass")
    prim = R["primary"]
    assigned = {cid for cid, b in plan["chains"].items() if int(b) == index}
    shard_chains = [prim] + [c for c in R["chains"] if c is not prim and str(c["id"]) in assigned]
    # road index is the chain's POSITION in the list lidar_tiled sees, so the shard's own ordered
    # list is its own index map — the primary is always 1.
    idx = {c["id"]: i + 1 for i, c in enumerate(shard_chains)}
    prim_idx = idx[prim["id"]]
    print(f"  shard   {len(shard_chains) - 1} chains assigned, primary {prim['ident']} {prim['line'].length / 1000:.0f} km")

    block = plan["blocks"][index]["bbox"]
    margin = max(lidar_half_width, half_width) + shardlib.DEFAULT_MARGIN_M
    bbox = snap_bbox((block[0] - margin, block[1] - margin, block[2] + margin, block[3] + margin))
    region = shp_box(*bbox)
    corridor = unary_union([c["line"].buffer(half_width, cap_style="flat") for c in shard_chains])
    # the PRIMARY only over this block and its margin; the assigned chains whole (shards.lidar_area)
    lidar_corridor = shardlib.lidar_area(prim["line"], [c["line"] for c in shard_chains if c is not prim], block, margin, lidar_half_width)
    # and the point cloud over the tiles this block owns, in the world (shards.world_lidar_area)
    sel = selection_polygon(site, frame)
    larea = shardlib.world_lidar_area(plan, index, sel if sel is not None else shp_box(*plan["bbox"]), lidar_corridor) if lidar_reads_region(site) else lidar_corridor

    if "dem" not in skip:
        dem.fetch_dem(frame, bbox, sdir / "dem_1m.tif", cache)
    naip_meta = None
    if "naip" not in skip:
        from . import network_tiles

        # kept in the shard's manifest: which source and which NAIP items/years fed this block
        # the YEAR is chosen over the whole world's bbox, not this block's, so every shard agrees
        naip_meta = network_tiles.naip_tiled(frame, bbox, region, sdir / "naip_1m.tif", cache, res=network_tiles.NAIP_RES_M, area=tuple(gj["bbox_utm"]) if gj.get("bbox_utm") else None)
    if "horizon" not in skip:
        horizon.fetch_horizon(frame, sdir / "horizon_30m.tif", cache, radius_m=30000.0)
    if "geology" not in skip:
        g = geology.along_spine(prim["line"], frame, site, cache, sdir, step_m=250.0)
        units = {u["map_id"]: u for u in g["units"]}
        for c in shard_chains:
            if c is prim:
                continue
            g2 = geology.along_spine(c["line"], frame, site, cache, sdir, step_m=500.0)
            for u in g2["units"]:
                units.setdefault(u["map_id"], u)
        (sdir / "geology.json").write_text(json.dumps({"units": list(units.values()), "named_formations": sorted({u["strat_name"] for u in units.values() if u.get("strat_name")})}, indent=1))
        print(f"  geology {len(units)} units", flush=True)

    branches: list[dict] = []
    no_lidar: str | None = None
    if "lidar" not in skip:
        from . import network_tiles

        ldir = sdir / "lidar"
        lbbox = snap_bbox(larea.bounds)
        try:
            # tiles named on the WORLD's grid, so the finalizer's merge by file name is by place
            gx, gy, _ = shardlib.tile_grid(tuple(plan["bbox"]))
            meta = network_tiles.lidar_tiled(frame, lbbox, larea, shard_chains, ldir, cache, origin=(gx, gy), road_band=lidar_corridor)
        except network_tiles.NoLidarHere as exc:
            no_lidar = str(exc)
            meta = None
    else:
        meta = None
    if no_lidar is None and meta is not None:
        pts = meta.pop("pts")
        from . import network_tiles

        with progress.heartbeat("profile", f"primary {prim['ident']} {prim['line'].length / 1000:.0f} km"):
            prof = network_tiles.profile_tiled(prim["line"], ldir, pts, prim_idx, fill=False, crossings_over_s=network_tiles.crossings_over(out))
        # which stations are THIS block's: the stitch takes each station from its owner
        prof["owned"] = shardlib.owner_runs(shardlib.profile_owner(prim["line"], prof["s"], plan["blocks"]), index)
        (sdir / "profile.json").write_text(json.dumps(prof))
        manifest_lidar = meta
        others = [c for c in shard_chains if c is not prim]
        tasks = [(idx[c["id"]], c["ident"], c["line"], None) for c in others]
        for c, bp in zip(others, network_tiles.profile_many(tasks, ldir, pts)):
            branches.append(branch_record(c, prim, bp))
        print(f"  branch  {len(branches)} branches profiled, {sum(len(b['structures']) for b in branches)} structures", flush=True)
    elif no_lidar:
        from . import network_tiles

        dem_p = sdir / "dem_1m.tif"
        if not dem_p.exists():
            raise RuntimeError("no lidar and no DEM: nothing can say how high the roads are")
        prof = network_tiles.profile_from_dem(prim["line"], dem_p)
        if prof.get("s"):
            prof["owned"] = shardlib.owner_runs(shardlib.profile_owner(prim["line"], prof["s"], plan["blocks"]), index)
        (sdir / "profile.json").write_text(json.dumps(prof))
        manifest_lidar = {"source": "none", "why": no_lidar, "profiles_from": "dem", "structures": []}
        for c in shard_chains:
            if c is prim:
                continue
            try:
                branches.append(branch_record(c, prim, network_tiles.profile_from_dem(c["line"], dem_p)))
            except Exception:
                branches.append(branch_record(c, prim, None))
        print(f"  branch  {len(branches)} branches from the DEM", flush=True)
    else:
        prof = None
        manifest_lidar = {}

    (sdir / "branches.json").write_text(branches_doc(branches, frame))
    manifest = {"slug": slug, "kind": "network", "tiled": True, "shard": index, "world": bool(site.get("world")),
                "frame": {"epsg": frame.epsg, "origin": frame.origin},
                "bbox_utm": list(bbox), "lidar": manifest_lidar, "naip": naip_meta,
                "branches": {"count": len(branches), "structures": sum(len(b["structures"]) for b in branches)},
                "seconds": round(time.time() - t0, 1)}
    (sdir / "manifest.json").write_text(json.dumps(manifest, indent=1, default=str))
    print(f"  done    shard {index} {manifest['seconds']} s -> {sdir}")



def _enu_cols(frame, pts, zs=None, nd: int = 2) -> list:
    """Nx2 UTM -> [[e, n(, z)], ...] in the site's ENU frame. Mirrors export._enu_cols; kept local
    so network.py does not have to import export.py. With `zs` the third column is the ENU UP
    (see export._enu_cols / Frame.to_enu3), so a branch road curves with the terrain it crosses."""
    if zs is None:
        e, n = frame.to_enu(pts[:, 0], pts[:, 1])
        cols = [np.asarray(e), np.asarray(n)]
    else:
        e, n, u = frame.to_enu3(pts[:, 0], pts[:, 1], np.nan_to_num(np.asarray(zs, dtype=float)))
        cols = [np.asarray(e), np.asarray(n), np.asarray(u)]
    return np.column_stack(cols).round(nd).tolist()


def export_branches(site_dir: Path, frame) -> list[dict] | None:
    """The manifest's `branches` (cadre §6 / main's 011): every non-primary chain with coords
    [x, y, z] every 10 m (Gaussian-smoothed like the spine, z from its own lidar profile), its
    junctions with z, and its profile/structures. None for a single-road site."""
    sp_p, br_p = site_dir / "spine_utm.json", site_dir / "branches.json"
    if not (sp_p.exists() and br_p.exists()):
        return None
    spine = json.loads(sp_p.read_text())
    if not spine.get("network"):
        return None
    from scipy.ndimage import gaussian_filter1d
    from shapely.geometry import LineString

    _bj = json.loads(br_p.read_text())
    _br = _bj["branches"]
    # `junctions[].x/y` go into the manifest beside `coords`, which is converted from the sibling's
    # absolute-UTM geometry under THIS frame. The junctions are not read from the file's frame at
    # all — they are placed from the node's lon/lat (or the chain's own polyline at `s`) under the
    # same frame, and asserted onto the road (`place_junctions`, and the history above it: three
    # on-read "repairs" preceded this, each measuring the wrong thing). Reading the file twice is
    # reading it once.
    by_id = {b["id"]: b for b in _br if b.get("id")}
    by_pos = _br  # a branches.json written before chains carried ids: its order is the sibling order

    out = []
    for si, sib in enumerate(spine.get("siblings", [])):
        b = by_id.get(sib.get("id")) or (by_pos[si] if not by_id and si < len(by_pos) else None) or {}
        if not b:  # a road with no profile is still a road: emit it and say so, never drop it
            print(f"  branches no profile for {sib.get('ident')} ({sib.get('id')}) — emitted with profile: null; run `python -m corridor.network_tiles <slug>` to compute it")
        g = sib["geometry"]
        parts = [g["coordinates"]] if g["type"] == "LineString" else g["coordinates"]
        coords = [c for part in parts for c in part]
        if len(coords) < 2:
            continue
        ln = LineString(coords)
        placed = place_junctions(frame, b.get("junctions") or [], ln, what=f"{sib.get('ident')} ({sib.get('id')})")
        fine = np.arange(0.0, ln.length, 2.0).tolist() + [ln.length]
        raw = np.array([ln.interpolate(v).coords[0] for v in fine])
        from .export import _smooth_on_line

        sm = _smooth_on_line(raw)
        sm[0], sm[-1] = raw[0], raw[-1]
        ln2 = LineString(sm)
        # A CLOSED way — a cul-de-sac ring, start and end on the same node — collapses under the
        # smoothing: Nancarles Drive (59 m, r351763585) came out as two identical points on
        # 2026-09-26 and its zero-length curve took the whole viewer down. If smoothing lost more
        # than half the length, it was not smoothing, and the raw densified line is kept.
        if ln2.length < max(1.0, 0.5 * ln.length):
            ln2 = LineString(raw)
        s_d = np.arange(0.0, ln2.length, 10.0).tolist() + [ln2.length]
        pts = np.array([ln2.interpolate(v).coords[0] for v in s_d])
        prof = b.get("profile")
        if prof and prof.get("s"):
            pz = np.asarray(prof["road_z"], dtype=float)
            good = np.isfinite(pz)
            zs = np.interp(np.array(s_d), np.asarray(prof["s"], dtype=float)[good], pz[good]) if good.any() else np.zeros(len(s_d))
        else:
            zs = np.zeros(len(s_d))
        zs = np.nan_to_num(zs, nan=0.0, posinf=0.0, neginf=0.0)
        s_d_a = np.asarray(s_d, dtype=float)
        coords_curved = _enu_cols(frame, pts, zs)
        # The branch grade, the junctions and the deck heights are all measured on the SAME road,
        # so they have to land on the SAME curve as the coords — interpolate the converted coords
        # back rather than converting the profile a second way (it must not disagree by the
        # curvature the branch is now expressed in).
        spine_zb = np.asarray([c[2] for c in coords_curved], dtype=float)

        def _curve_on_branch(values, ss):
            out = []
            for v, sv in zip(values, ss):
                x = float(np.interp(sv, s_d_a, pts[:, 0]))
                y = float(np.interp(sv, s_d_a, pts[:, 1]))
                out.append(round(float(frame.to_enu3(x, y, float(v))[2]), 2))
            return out

        js = []
        for j in placed:
            z = None
            if prof and prof.get("s"):
                z = float(np.interp(j["s"], s_d_a, spine_zb))
            js.append({**j, "z": None if z is None or not np.isfinite(z) else round(z, 2)})
        structs = []
        for st0 in (b.get("structures") or []):
            st = dict(st0)
            smid = 0.5 * (float(st.get("s_start", 0.0)) + float(st.get("s_end", st.get("s_start", 0.0))))
            for k in ("deck_z_min", "deck_z_max"):
                if st.get(k) is not None:
                    st[k] = _curve_on_branch([st[k]], [smid])[0]
            structs.append(st)
        prof_road_z = None
        if prof and prof.get("s"):
            prof_road_z = np.round(np.interp(np.asarray(prof["s"], dtype=float), s_d_a, spine_zb), 2)
        out.append({
            "id": b["id"], "name": b.get("name"), "ref": b.get("ref"), "ident": b.get("ident"), "highway": b.get("highway"), "lanes": b.get("lanes"), "oneway": b.get("oneway"), "length_m": b.get("length_m"),
            "coords": coords_curved,
            "junctions": js, "dead_ends": sib.get("dead_ends") or b.get("dead_ends") or [], "s_on_primary": b.get("s_on_primary"),
            "profile": {"s": prof["s"][::5], "road_z": prof_road_z[::5].tolist()} if prof_road_z is not None else None,
            "structures": structs, "surface": None,
        })
    return out


def revector(site: dict, data: Path, cache: Path) -> dict:
    """Re-run only the OSM stage of a network site and patch the vectors in place.

    A rule that lives before the rasters — dead ends, a junction change, a road added to the list —
    must not cost a re-bake: Crofton's was 8.7 hours, and every Overpass answer it used is cached,
    so this is seconds. Rewrites `spine_utm.json` (and the manifest's spine block) and leaves every
    raster, profile and branch profile exactly where it is; `branches.json` keeps its profiles and
    gains the new per-chain keys. Follow it with `python -m corridor export <slug>`.
    """
    slug = site["slug"]
    out = data / "sites" / slug
    # the site's STORED frame, the one export_site reads under — not one re-derived from the
    # sites.json centre, which is where crofton-triangle's two origins came from (place_junctions)
    try:
        frame = site_frame(out)
    except FrameFault:
        frame = Frame.at(site["lon"], site["lat"])
    old_spine = json.loads((out / "spine_utm.json").read_text()) if (out / "spine_utm.json").exists() else {}
    R = roads(site, frame, cache / "overpass")
    print(f"  roads   {summary(R)}", flush=True)
    dead_ends(R["chains"], frame, cache / "overpass", float(site.get("radius_m", 9000)), site["lat"], site["lon"], clip=selection_polygon(site, frame))
    if old_spine.get("coords") and len(R["primary"]["line"].coords) != len(old_spine["coords"]):
        print(f"  WARNING the primary changed shape ({len(old_spine['coords'])} -> {len(R['primary']['line'].coords)} points): profiles are keyed to the OLD line, re-bake instead", flush=True)
    half_width = float((json.loads((out / "manifest.json").read_text()).get("params") or {}).get("half_width_m", 150.0))
    write_vectors(site, frame, R, out, half_width, cache / "overpass")
    # branches keep their profiles; the per-chain keys are refreshed from the new chains
    br_p = out / "branches.json"
    if br_p.exists():
        # branches.json written before chains carried ids has neither `id` nor a name to match on.
        # Its order is the NON-PRIMARY chain order — `fetch_site` appends `for c in chains: if c is
        # prim: continue` — so position must be matched against that list, not against every chain;
        # matching against all of them shifts every entry after the primary onto the wrong road,
        # which is the same mis-attribution intrinsic ids were introduced to stop. And it is only
        # ever safe when the counts agree: if they do not, the chain SET changed too, and the only
        # honest answer is to recompute rather than guess.
        by_id = {c["id"]: c for c in R["chains"]}
        branches = json.loads(br_p.read_text())["branches"]
        if branches and "id" not in branches[0]:
            others = [c for c in R["chains"] if c is not R["primary"]]
            if len(others) == len(branches):
                print(f"  note    branches.json predates chain ids; matching {len(branches)} branches by position", flush=True)
                for i, b in enumerate(branches):
                    b["id"] = others[i]["id"]
            else:
                print(f"  WARNING branches.json predates chain ids and holds {len(branches)} records for {len(others)} roads — cannot match them safely. Run `python -m corridor.network_tiles {slug}` to recompute the profiles.", flush=True)
        for b in branches:
            c = by_id.get(b["id"])
            if c:
                b["junctions"] = c["junctions"]
                b["dead_ends"] = c.get("dead_ends", [])
        br_p.write_text(branches_doc(branches, frame))
    m_p = out / "manifest.json"
    if m_p.exists():
        m = json.loads(m_p.read_text())
        m["spine"] = {**m.get("spine", {}), "roads": R["found"], "roads_missing": R["missing"], "chains": len(R["chains"]), "dead_ends": sum(len(c.get("dead_ends", [])) for c in R["chains"])}
        m["revectored"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        m_p.write_text(json.dumps(m, indent=1, default=str))
    return {"chains": len(R["chains"]), "dead_ends": sum(len(c.get("dead_ends", [])) for c in R["chains"])}


def main() -> None:
    import sys

    from .__main__ import DATA, SITES, CACHE

    sites = {s["slug"]: s for s in json.loads(SITES.read_text())}
    for slug in sys.argv[1:]:
        print(f"=== {slug} revector")
        print(" ", revector(sites[slug], DATA, CACHE))


if __name__ == "__main__":
    main()
