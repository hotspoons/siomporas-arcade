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
                                 junctions [{x, y, with:[names]}] — OSM nodes shared with other chains
                     junctions = the primary's own, roads = the identities found, network = true
    site.json        corridor  = the UNION of every chain buffered `half_width_m` (150 m) — the
                                 region is ~12 km across, its bbox is mostly fields nobody drives
    osm.geojson      features inside that union's hull (osm.features)
    crossings.json   for the primary (osm.crossings); a branch meeting it is a `merge`/`grade`

Rasters, lidar, profile and export for a network are in `network_bake` below, called from
__main__.fetch_site when `site["kind"] == "network"`; every raster is clipped to the corridor and
the web layers go out as 1 km tiles (export_tiles). The single-road modules are reused where a
function takes a line: profile per chain, cuts/rock/water per chain.
"""
from __future__ import annotations

import json
import re
import time
from pathlib import Path

import numpy as np
import shapely
from shapely.geometry import LineString, MultiLineString, Point, mapping
from shapely.ops import linemerge, unary_union

from . import osm
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
            lanes = sorted({str(w2.get("tags", {}).get("lanes")) for w2 in c if w2.get("tags", {}).get("lanes")})
            chains.append({
                "ident": ident, "ways": c, "line": ln, "length_m": round(float(ln.length), 1),
                "name": tags0.get("name"), "ref": tags0.get("ref"), "highway": tags0.get("highway"),
                "lanes": lanes[0] if len(lanes) == 1 else (lanes or None), "oneway": tags0.get("oneway"),
                "nodes": {nid for w2 in c for nid in w2["nodes"]},
            })
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
    for c in chains:
        for wy in c["ways"]:
            for nid, g in zip(wy["nodes"], wy["geometry"]):
                if nid not in node_xy:
                    x, y = frame.from_wgs(g["lon"], g["lat"])
                    node_xy[nid] = (float(x), float(y))
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
                js.append({"node": nid, "x": round(float(frame.to_enu(x, y)[0]), 1), "y": round(float(frame.to_enu(x, y)[1]), 1), "s": round(float(c["line"].project(Point(x, y))), 1), "with": sorted(by_id[o]["ident"] for o in others)})
        js.sort(key=lambda j: j["s"])
        c["junctions"] = js
    found = sorted({c["ident"] for c in chains})
    missing = sorted(set(wanted) - set(found))
    return {"chains": chains, "primary": primary, "found": found, "missing": missing, "ways": len(ways)}


DEAD_END_RADIUS = {"residential": 9.0, "unclassified": 9.0, "tertiary": 9.0, "living_street": 8.0, "service": 6.0}
DEAD_END_DEFAULT = 9.0
BOUNDARY_M = 60.0  # an end this close to the query box was CLIPPED by us, not built as a dead end


def dead_ends(chains: list[dict], frame: Frame, cache: Path, radius_m: float, site_lat: float, site_lon: float) -> None:
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
            if min(abs(p.x - (ox - radius_m)), abs(p.x - (ox + radius_m)), abs(p.y - (oy - radius_m)), abs(p.y - (oy + radius_m))) < BOUNDARY_M:
                continue  # clipped by our own query box: the road continues, our world does not
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
    bbox = snap_bbox(corridor.bounds)
    ident = {"ref": prim["ref"]} if prim["ref"] else {"name": prim["ident"]}
    site_json = {**site, "frame": {"epsg": frame.epsg, "origin": frame.origin}, "bbox_utm": bbox, "corridor": mapping(corridor), "ident": ident}
    (out / "site.json").write_text(json.dumps(site_json))
    feats = osm.features(corridor.convex_hull, frame, cache)
    (out / "osm.geojson").write_text(json.dumps(feats))
    cross = osm.crossings(line, feats, ident, frame, segs)
    (out / "crossings.json").write_text(json.dumps(cross, indent=1))
    return {"corridor": corridor, "bbox": bbox, "segments": segs, "crossings": cross, "features": len(feats["features"]), "ident": ident, "photo_s": photo_s}


def summary(R: dict) -> str:
    prim = R["primary"]
    return f"{len(R['chains'])} chains from {R['ways']} ways; primary {prim['ident']} {prim['length_m']} m with {len(prim['junctions'])} junctions; roads {R['found']}; missing {R['missing']}"


# --- the bake ----------------------------------------------------------------------------------


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
    manifest |= {"slug": slug, "kind": "network", "frame": {"epsg": frame.epsg, "origin": frame.origin}, "fetched": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "params": {"half_width_m": half_width, "lidar_half_width_m": lidar_half_width, "radius_m": site.get("radius_m"), "horizon_radius_m": 30000.0}}
    R = roads(site, frame, cache / "overpass")
    print(f"  roads   {summary(R)}", flush=True)
    dead_ends(R["chains"], frame, cache / "overpass", float(site.get("radius_m", 9000)), site["lat"], site["lon"])
    V = write_vectors(site, frame, R, out, half_width, cache / "overpass")
    corridor = V["corridor"]
    bbox = V["bbox"]
    lidar_corridor = unary_union([c["line"].buffer(lidar_half_width, cap_style="flat") for c in R["chains"]])
    print(f"  osm     {V['features']} features, {len(V['crossings'])} crossings on the primary; bbox {(bbox[2] - bbox[0]) / 1000:.1f} × {(bbox[3] - bbox[1]) / 1000:.1f} km, corridor {corridor.area / 1e6:.1f} km²", flush=True)
    prim = R["primary"]
    tiled = bool(site.get("tiled")) or max(bbox[2] - bbox[0], bbox[3] - bbox[1]) > 6000.0
    manifest["tiled"] = tiled
    if tiled:
        print(f"  tiled   bbox over 6 km: rasters clipped to the corridor and cut into 1 km tiles", flush=True)
    manifest["spine"] = {"ident": V["ident"], "nearest_way": prim["ways"][0]["id"], "snap_distance_m": round(float(prim["line"].distance(Point(*frame.origin))), 1), "photo_s": round(V["photo_s"], 1), "length_m": prim["length_m"], "trimmed": [False, False], "network": True, "roads": R["found"], "roads_missing": R["missing"], "chains": len(R["chains"])}
    manifest["osm"] = {"features": V["features"], "crossings": len(V["crossings"])}

    if "dem" not in skip:
        manifest["dem"] = dem.fetch_dem(frame, bbox, out / "dem_1m.tif", cache)
    if "naip" not in skip:
        if tiled:
            from . import network_tiles

            manifest["naip"] = network_tiles.naip_tiled(frame, bbox, corridor, out / "naip_1m.tif", cache)
        else:
            manifest["naip"] = naip.fetch_naip(frame, bbox, out / "naip.tif", cache)
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
        return {"id": c["id"], "ident": c["ident"], "name": c["name"], "ref": c["ref"], "highway": c["highway"], "lanes": c["lanes"], "oneway": c["oneway"], "length_m": c["length_m"], "s_on_primary": round(float(prim["line"].project(c["line"].interpolate(0.5, normalized=True))), 1), "junctions": c["junctions"], "dead_ends": c.get("dead_ends", []), "profile": {"step_m": bp["step_m"], "s": bp["s"], "road_z": bp["road_z"]} if bp else None, "structures": bp["structures"] if bp else []}

    if "lidar" not in skip and tiled:
        from . import network_tiles

        ldir = out / "lidar"
        lbbox = snap_bbox(lidar_corridor.bounds)
        meta = network_tiles.lidar_tiled(frame, lbbox, lidar_corridor, R["chains"], ldir, cache)
        pts = meta.pop("pts")
        idx = {c["id"]: i + 1 for i, c in enumerate(R["chains"])}
        prof = network_tiles.profile_tiled(prim["line"], ldir, pts, idx[prim["id"]])
        (out / "profile.json").write_text(json.dumps(prof))
        cls = meta["classes"]
        print(f"  lidar   {meta['points_in_corridor']:,} pts in corridor over {len(meta['tiles']['list'])} km tiles; ground {cls.get('ground', 0):,} veg {cls.get('veg_high', 0) + cls.get('veg_med', 0) + cls.get('veg_low', 0):,} building {cls.get('building', 0):,} bridge_deck {cls.get('bridge_deck', 0):,}; {meta['near_road_points']:,} near-road points kept", flush=True)
        for st in prof["structures"]:
            print(f"  struct  {st['kind']:8s} s={st['s_start']:.0f}..{st['s_end']:.0f} m ({st['length_m']} m)  clearance={st['clearance_m']}  above_ground={st['height_above_ground_m']}")
        manifest["lidar"] = {**meta, "structures": prof["structures"]}
        for c in R["chains"]:
            if c is prim:
                continue
            try:
                bp = network_tiles.profile_tiled(c["line"], ldir, pts, idx[c["id"]])
            except Exception as exc:
                print(f"  branch  {c['ident']} profile failed: {exc}")
                bp = None
            branches.append(branch_rec(c, bp))
        print(f"  branch  {len(branches)} branches profiled, {sum(len(b['structures']) for b in branches)} structures on them", flush=True)
    elif "lidar" not in skip:
        # the single-image path: the whole corridor's points in memory, as for a single road
        ldir = out / "lidar"
        ldir.mkdir(exist_ok=True)
        lbbox = snap_bbox(lidar_corridor.bounds)
        pts, meta = lidar.fetch_points(frame, lbbox, cache, clip=lidar_corridor)
        if (out / "dem_1m.tif").exists():
            f = lidar.check_units(pts, out / "dem_1m.tif")
            if f != 1.0:
                pts["z"] = pts["z"] * f
            meta["z_factor"] = f
        meta["classification"] = lidar.classification_quality(pts)
        r = lidar.rasters(pts, lbbox, frame, lidar_corridor, ldir)
        prof = lidar.profile(prim["line"], r["dtm"], r["chm"], r["transform"], r["pts"])
        (out / "profile.json").write_text(json.dumps(prof))
        cls = r["classes"]
        print(f"  lidar   {r['points_in_corridor']:,} pts in corridor; ground {cls.get('ground', 0):,} veg {cls.get('veg_high', 0) + cls.get('veg_med', 0) + cls.get('veg_low', 0):,} building {cls.get('building', 0):,} bridge_deck {cls.get('bridge_deck', 0):,}")
        for st in prof["structures"]:
            print(f"  struct  {st['kind']:8s} s={st['s_start']:.0f}..{st['s_end']:.0f} m ({st['length_m']} m)  clearance={st['clearance_m']}  above_ground={st['height_above_ground_m']}")
        manifest["lidar"] = {**meta, "points_in_corridor": r["points_in_corridor"], "classes": cls, "rasters": r["rasters"], "structures": prof["structures"]}
        for c in R["chains"]:
            if c is prim:
                continue
            branches.append(branch_rec(c, lidar.profile(c["line"], r["dtm"], r["chm"], r["transform"], r["pts"])))
        print(f"  branch  {len(branches)} branches profiled, {sum(len(b['structures']) for b in branches)} structures on them", flush=True)
    else:
        for c in R["chains"]:
            if c is prim:
                continue
            branches.append(branch_rec(c, None))
    (out / "branches.json").write_text(json.dumps({"branches": branches}))
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


def _enu_cols(frame, pts, zs=None, nd: int = 2) -> list:
    """Nx2 UTM -> [[e, n(, z)], ...] in the site's ENU frame. Mirrors export._enu_cols; kept local
    so network.py does not have to import export.py."""
    e, n = frame.to_enu(pts[:, 0], pts[:, 1])
    cols = [np.asarray(e), np.asarray(n)] + ([np.nan_to_num(np.asarray(zs, dtype=float))] if zs is not None else [])
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

    _br = json.loads(br_p.read_text())["branches"]
    by_id = {b["id"]: b for b in _br if b.get("id")}
    by_pos = _br  # a branches.json written before chains carried ids: its order is the sibling order
    def finite(v, default=0.0):
        return default if v is None or not np.isfinite(v) else float(v)

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
        fine = np.arange(0.0, ln.length, 2.0).tolist() + [ln.length]
        raw = np.array([ln.interpolate(v).coords[0] for v in fine])
        from .export import _smooth_on_line

        sm = _smooth_on_line(raw)
        sm[0], sm[-1] = raw[0], raw[-1]
        ln2 = LineString(sm)
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
        js = []
        for j in b.get("junctions", []):
            z = None
            if prof and prof.get("s"):
                pz = np.asarray(prof["road_z"], dtype=float)
                good = np.isfinite(pz)
                if good.any():
                    z = float(np.interp(j["s"], np.asarray(prof["s"], dtype=float)[good], pz[good]))
            js.append({**j, "z": None if z is None or not np.isfinite(z) else round(z, 2)})
        out.append({
            "id": b["id"], "name": b.get("name"), "ref": b.get("ref"), "ident": b.get("ident"), "highway": b.get("highway"), "lanes": b.get("lanes"), "oneway": b.get("oneway"), "length_m": b.get("length_m"),
            "coords": _enu_cols(frame, pts, zs),
            "junctions": js, "dead_ends": sib.get("dead_ends") or b.get("dead_ends") or [], "s_on_primary": b.get("s_on_primary"),
            "profile": {"s": prof["s"][::5], "road_z": [finite(v) for v in prof["road_z"][::5]]} if prof and prof.get("s") else None,
            "structures": b.get("structures") or [], "surface": None,
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
    frame = Frame.at(site["lon"], site["lat"])
    old_spine = json.loads((out / "spine_utm.json").read_text()) if (out / "spine_utm.json").exists() else {}
    R = roads(site, frame, cache / "overpass")
    print(f"  roads   {summary(R)}", flush=True)
    dead_ends(R["chains"], frame, cache / "overpass", float(site.get("radius_m", 9000)), site["lat"], site["lon"])
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
        br_p.write_text(json.dumps({"branches": branches}))
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
