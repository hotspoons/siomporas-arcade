"""Sidewalks for a town that has them on the ground and not in OpenStreetMap.

Rich, driving Crofton: "not seeing any sidewalks even though the entire triangle and the north
Crofton is fully covered - are these not in the OSM data?"

Measured, inside crofton-triangle's own corridor:

    drivable ways                        854
      tagged `sidewalk=both|left|right`   50
      tagged `sidewalk=no`                 8
      no sidewalk tag at all             796      (93 %)
    separately mapped `footway=sidewalk` ways   47

So: no, they are not in the data. Forty-seven sidewalk ways for a hundred and forty kilometres of
street. This is not Crofton being unusual — it is what OSM coverage of American suburbia looks
like, because a mapper records what is worth recording and a sidewalk beside a subdivision street
is assumed. The same extract has 626 sidewalk ways once you widen it to the whole Crofton/
Crownsville region, and they cluster on the commercial strips where somebody surveyed.

Rich's answer, which is the right one: "can we add them to customizations and make a polygon around
both zones and line all roads with sidewalks?"

ZONES are polygons inside which every street is assumed to have a sidewalk. They are DERIVED, not
typed: buffer the residential network, union it, and keep the blobs. A subdivision is a dense mesh
of residential streets and a rural road is not, so the buffer closes up over the first and stays a
ribbon along the second; dropping everything under `MIN_ZONE_AREA` leaves exactly the built-up
areas. On crofton-triangle that is the Crofton triangle and the Crofton Mews/north Crofton pocket,
which are the two Rich named, found rather than guessed.

A ZONE NEEDS EVIDENCE. Density alone put sidewalks on every subdivision in the bake, and Rich,
who lives there: "neighborhoods to the south of 450 in the crofton map have sidewalks when they
shouldn't" (2026-09-26). Whether a 1970s subdivision was built with sidewalks is not something a
street mesh knows — but OSM does, thinly: where a neighbourhood has them, a mapper has usually
tagged at least one street `sidewalk=both` or drawn one `footway=sidewalk`. So each density blob is
first SPLIT along the arterials that bound real subdivisions (motorway/trunk/primary/secondary —
Defense Highway is the line here), and a part keeps its sidewalks only if some OSM sidewalk
evidence falls inside it. Measured on crofton-triangle before this rule: thirteen parts, of which
exactly two carry evidence — the triangle (244 streets, 49 tags, 8 sidewalk ways) and north
Crofton (182 streets, 2 sidewalk ways) — which are the two Rich named on day one. Every part south
of 450 has zero. The rule finds his answer instead of needing to be told it.

An authored `sidewalk_zones.json` beside the bake overrides the derivation completely, for the case
where the answer is local knowledge rather than geometry — a subdivision with sidewalks and no
mapper, for instance.

What is emitted goes into the manifest's existing `sidewalks` list with `source: "zone"`, so
`furniture.buildSidewalks` draws it with the kerb, the dropped kerb and the crossing logic it
already has, and a real OSM sidewalk always wins where there is one.
"""
from __future__ import annotations

import json
import math
from pathlib import Path

# roads that get a sidewalk when they fall inside a zone. A trunk road does not: Crofton's western
# edge is Crain Highway, four lanes at 55 mph with a ditch, and lining it with concrete would be
# inventing a feature that is not there.
WALKABLE = {"residential", "unclassified", "living_street", "tertiary", "secondary", "primary"}

ZONE_BUFFER_M = 110.0     # half a Crofton block: closes a subdivision, not a rural road
ZONE_MIN_AREA_M2 = 250_000.0
ZONE_SIMPLIFY_M = 25.0
# the roads that bound a subdivision; a density blob is cut along them before evidence is counted
ZONE_SPLITTERS = {"motorway", "trunk", "primary", "secondary"}
ZONE_PART_MIN_M2 = 50_000.0   # slivers left by the cut are not neighbourhoods

VERGE_M = 2.0             # kerb face to the near edge of the walk
WALK_W = 1.5
NEAR_EXISTING_M = 7.0     # an OSM sidewalk this close already covers this side
LANE_W = 3.66


def _lanes(tags: dict, highway: str) -> int:
    for k in ("lanes", "lanes:forward"):
        try:
            n = int(str(tags.get(k, "")).split(";")[0])
            if 1 <= n <= 12:
                return n
        except (TypeError, ValueError):
            pass
    return 4 if highway in ("motorway", "trunk", "primary") else 2


def zones(roads: list[dict], authored: Path | None = None, frame=None, existing: list[dict] | None = None) -> list:
    """The polygons inside which a street is assumed to have a sidewalk.

    `roads` are the drawn roads with an ENU `line`. Returns shapely polygons in ENU metres.
    """
    from shapely.geometry import LineString, Point, shape
    from shapely.ops import unary_union

    if authored is not None and authored.exists() and frame is not None:
        js = json.loads(authored.read_text())
        out = []
        for z in js.get("zones", []):
            ring = z.get("polygon") or []
            if len(ring) < 3:
                continue
            pts = []
            for lon, lat in ring:
                x, y = frame.from_wgs(lon, lat)
                e, n = frame.to_enu(x, y)
                pts.append((float(e), float(n)))
            out.append(shape({"type": "Polygon", "coordinates": [pts + [pts[0]]]}))
        if out:
            return out

    dense = [LineString(r["line"]) for r in roads if r["highway"] in ("residential", "living_street", "unclassified") and len(r["line"]) > 1]
    if not dense:
        return []
    blob = unary_union([ln.buffer(ZONE_BUFFER_M, resolution=4) for ln in dense])
    polys = list(getattr(blob, "geoms", [blob]))
    blobs = []
    for p in polys:
        if p.area < ZONE_MIN_AREA_M2:
            continue
        # shrink back by most of the buffer so the zone hugs the streets rather than ballooning
        q = p.buffer(-ZONE_BUFFER_M * 0.55).buffer(ZONE_BUFFER_M * 0.25)
        for r in getattr(q, "geoms", [q]):
            if r.is_empty or r.area < ZONE_MIN_AREA_M2 * 0.5:
                continue
            blobs.append(r.simplify(ZONE_SIMPLIFY_M))
    return _with_evidence(blobs, roads, existing)


def _with_evidence(blobs: list, roads: list[dict], existing: list[dict] | None) -> list:
    """Cut each blob along the arterials and keep the parts OSM says have sidewalks.

    Evidence is a walkable street tagged `sidewalk=both|left|right` or a mapped `footway=sidewalk`
    way with its midpoint inside the part. One is enough: the question is whether the subdivision
    was built with sidewalks, and a single tagged street answers it.
    """
    from shapely.geometry import LineString
    from shapely.ops import unary_union

    if not blobs:
        return []
    splitters = [LineString(r["line"]).buffer(2.0) for r in roads if r["highway"] in ZONE_SPLITTERS and len(r["line"]) > 1]
    cut = unary_union(splitters) if splitters else None
    marks = []
    for r in roads:
        tags = r.get("tags") or {}
        if r["highway"] in WALKABLE and str(tags.get("sidewalk") or "").lower() in ("both", "left", "right") and len(r["line"]) > 1:
            marks.append(LineString(r["line"]).interpolate(0.5, normalized=True))
    for e in existing or []:
        cs = e.get("coords") or []
        if e.get("kind") == "sidewalk" and len(cs) > 1:
            marks.append(LineString([(c[0], c[1]) for c in cs]).interpolate(0.5, normalized=True))
    out = []
    for b in blobs:
        pieces = b.difference(cut) if cut is not None else b
        for part in getattr(pieces, "geoms", [pieces]):
            if part.is_empty or part.area < ZONE_PART_MIN_M2:
                continue
            if any(part.contains(m) for m in marks):
                out.append(part)
    return out


def build(site_dir: Path, frame, roads: list[dict], existing: list[dict] | None) -> dict:
    """Sidewalk runs for every walkable street inside a zone, minus what OSM already maps."""
    from shapely.geometry import LineString, MultiLineString, Point
    from shapely.ops import unary_union
    from shapely.strtree import STRtree

    Z = zones(roads, site_dir / "sidewalk_zones.json", frame, existing)
    if not Z:
        return {"runs": [], "zones": [], "counts": {"zones": 0}}
    area = unary_union(Z)

    # what OSM already gives us, so a zone never doubles a real sidewalk
    have = [LineString([(c[0], c[1]) for c in r["coords"]]) for r in (existing or []) if r.get("kind") == "sidewalk" and len(r.get("coords") or []) > 1]
    tree = STRtree(have) if have else None

    runs = []
    counts = {"zones": len(Z), "zone_area_km2": round(area.area / 1e6, 2), "roads_in_zone": 0,
              "roads_skipped_tagged_no": 0, "sides": 0, "sides_already_mapped": 0, "metres": 0.0}
    for r in roads:
        if r["highway"] not in WALKABLE or len(r["line"]) < 2:
            continue
        ln = LineString(r["line"])
        if not area.intersects(ln.interpolate(0.5, normalized=True)):
            continue
        tags = r.get("tags") or {}
        sw = str(tags.get("sidewalk") or "").lower()
        if sw == "no" or str(tags.get("sidewalk:both") or "").lower() == "no":
            counts["roads_skipped_tagged_no"] += 1
            continue
        counts["roads_in_zone"] += 1
        # OSM's own answer wins where it has one; otherwise both sides, which is what a subdivision
        # built after 1960 actually has
        sides = {"left": True, "right": True}
        if sw == "left":
            sides["right"] = False
        elif sw == "right":
            sides["left"] = False
        if str(tags.get("sidewalk:left") or "").lower() == "no":
            sides["left"] = False
        if str(tags.get("sidewalk:right") or "").lower() == "no":
            sides["right"] = False

        off = _lanes(tags, r["highway"]) * LANE_W / 2 + VERGE_M + WALK_W / 2
        for side, want in sides.items():
            if not want:
                continue
            try:
                curve = ln.offset_curve(off if side == "left" else -off)
            except Exception:
                continue
            parts = list(getattr(curve, "geoms", [curve]))
            for part in parts:
                cs = list(part.coords)
                if len(cs) < 2 or part.length < 12.0:
                    continue
                # already mapped? test the middle of the candidate against real sidewalk ways
                if tree is not None:
                    mid = part.interpolate(0.5, normalized=True)
                    idx = tree.query(mid.buffer(NEAR_EXISTING_M))
                    if len(idx) and min(have[i].distance(mid) for i in idx) <= NEAR_EXISTING_M:
                        counts["sides_already_mapped"] += 1
                        continue
                runs.append({
                    "kind": "sidewalk", "width_m": WALK_W, "marked": False, "source": "zone",
                    "road": r["id"], "side": side,
                    "coords": [[round(x, 2), round(y, 2), 0.0] for x, y in cs],
                })
                counts["sides"] += 1
                counts["metres"] += part.length
    counts["metres"] = round(counts["metres"])
    return {"runs": runs, "zones": [list(z.exterior.coords) for z in Z], "counts": counts}


def merge_into(out: dict, site_dir: Path, frame) -> dict | None:
    """Append zone sidewalks to the manifest's `sidewalks`, and record the zones themselves."""
    from . import intersections

    roads = intersections._roads(site_dir, frame)
    if not roads:
        return None
    R = build(site_dir, frame, roads, out.get("sidewalks"))
    if not R["runs"]:
        return R["counts"]
    out["sidewalks"] = (out.get("sidewalks") or []) + R["runs"]
    out["sidewalk_zones"] = [[[round(x, 1), round(y, 1)] for x, y in z] for z in R["zones"]]
    return R["counts"]
