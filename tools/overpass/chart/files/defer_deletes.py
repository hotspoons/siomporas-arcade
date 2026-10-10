#!/usr/bin/env python3
"""Drop the deletes in one region's diff that another region on this instance still owns.

WHY. A Geofabrik diff is the difference between two consecutive extracts of ONE region. An object
that leaves the region — a node moved across the line, a way re-routed so it no longer touches it,
a node that was only in the extract because a way of the region used it — appears in that diff as
a DELETE, though nothing was deleted in OpenStreetMap. On an instance that holds that region alone
the delete is right. On an instance that also holds the neighbour, the object is still the
neighbour's, and applying the delete takes it out of the database until the neighbour next edits
it — which for a node on an unchanged road is never.

THE RULE. A true deletion appears in the diff of EVERY region that held the object, because it
left all their extracts at once. So a delete for an object whose last known position lies inside
ANOTHER imported region's polygon is left to that region's own stream: if it was a real deletion,
that region's diff carries it too; if the object only left this region, nobody deletes it. Creates
and modifies are never touched — both regions carry the same version of a shared object, and
Overpass stores the version it is given.

Positions come from the delete itself when it has them, else from the database through the running
dispatcher (osm3s_query): a node's coordinates, a way's node coordinates, a relation's bounding box.
An object the database does not have is deleted as asked (it cannot be anybody's).

Standard library only: it runs in the overpass image's own python.

    defer_deletes.py /db/diffs/changes.osc --self _primary --regions /db/regions
"""
from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path


def read_poly(path: Path) -> list[list[tuple[float, float]]]:
    """A Geofabrik .poly file as rings of (lon, lat). Holes (`!name`) are kept as rings; even-odd handles them."""
    rings, cur = [], None
    lines = [ln.strip() for ln in path.read_text().splitlines()]
    for ln in lines[1:]:
        if ln == "END":
            if cur is None:
                break
            rings.append(cur)
            cur = None
        elif cur is None:
            cur = []
        else:
            x, y = ln.split()[:2]
            cur.append((float(x), float(y)))
    return rings


class Region:
    def __init__(self, name: str, rings):
        self.name = name
        self.rings = rings
        xs = [p[0] for r in rings for p in r]
        ys = [p[1] for r in rings for p in r]
        self.bbox = (min(xs), min(ys), max(xs), max(ys))

    def contains(self, lon: float, lat: float) -> bool:
        w, s, e, n = self.bbox
        if not (w <= lon <= e and s <= lat <= n):
            return False
        inside = False
        for ring in self.rings:
            j = len(ring) - 1
            for i in range(len(ring)):
                xi, yi = ring[i]
                xj, yj = ring[j]
                if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (yj - yi) + xi:
                    inside = not inside
                j = i
        return inside

    def touches_box(self, w, s, e, n) -> bool:
        """Conservative, for a relation's bbox: any corner or the centre inside, or the bboxes overlap a ring vertex."""
        if any(self.contains(x, y) for x, y in ((w, s), (w, n), (e, s), (e, n), ((w + e) / 2, (s + n) / 2))):
            return True
        return any(w <= x <= e and s <= y <= n for r in self.rings for x, y in r)


def others(regions_dir: Path, self_name: str) -> list[Region]:
    out = []
    for d in sorted(regions_dir.glob("*/")):
        if d.name == self_name:
            continue
        poly = d / "region.poly"
        st = d / "state.json"
        if not poly.exists():
            continue
        try:
            state = json.loads(st.read_text()).get("state") if st.exists() else None
        except ValueError:
            state = None
        # only regions the database actually holds; a staged or failed import owns nothing yet
        if state != "applied":
            continue
        out.append(Region(d.name, read_poly(poly)))
    return out


def query(cmd: list[str], q: str) -> dict:
    r = subprocess.run(cmd, input=q, capture_output=True, text=True, timeout=600)
    if r.returncode != 0 or not r.stdout.strip():
        raise RuntimeError(f"osm3s_query failed ({r.returncode}): {r.stderr[-300:]}")
    return json.loads(r.stdout)


def positions(cmd, nodes: list[str], ways: list[str], rels: list[str]):
    """Where the database last had each deleted object."""
    node_pos, way_pts, rel_box = {}, {}, {}
    for i in range(0, len(nodes), 2000):
        for el in query(cmd, f"[out:json];node(id:{','.join(nodes[i:i + 2000])});out skel;").get("elements", []):
            node_pos[str(el["id"])] = (el["lon"], el["lat"])
    for i in range(0, len(ways), 500):
        for el in query(cmd, f"[out:json];way(id:{','.join(ways[i:i + 500])});out geom;").get("elements", []):
            way_pts[str(el["id"])] = [(p["lon"], p["lat"]) for p in el.get("geometry") or [] if p]
    for i in range(0, len(rels), 500):
        for el in query(cmd, f"[out:json];rel(id:{','.join(rels[i:i + 500])});out bb;").get("elements", []):
            b = el.get("bounds")
            if b:
                rel_box[str(el["id"])] = (b["minlon"], b["minlat"], b["maxlon"], b["maxlat"])
    return node_pos, way_pts, rel_box


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("osc")
    ap.add_argument("--self", dest="self_name", required=True, help="this stream's region directory name (_primary for the instance's own)")
    ap.add_argument("--regions", default=os.environ.get("REGIONS_DIR", "/db/regions"))
    ap.add_argument("--query", default=os.environ.get("OSM3S_QUERY", "/app/bin/osm3s_query"), help="the query command, talking to the dispatcher")
    a = ap.parse_args(argv)

    path = Path(a.osc)
    regions = others(Path(a.regions), a.self_name)
    if not regions or not path.exists() or path.stat().st_size == 0:
        return 0  # one region on this instance, or nothing to do: every delete is right
    tree = ET.parse(path)
    root = tree.getroot()
    deletes = [(blk, el) for blk in root.findall("delete") for el in list(blk)]
    if not deletes:
        return 0
    need = {"node": [], "way": [], "relation": []}
    for _blk, el in deletes:
        if el.tag == "node" and el.get("lat") is not None:
            continue
        need.setdefault(el.tag, []).append(el.get("id"))
    node_pos, way_pts, rel_box = positions(shlex.split(a.query), need["node"], need["way"], need["relation"])

    deferred = {}
    for blk, el in deletes:
        oid = el.get("id")
        if el.tag == "node":
            p = (float(el.get("lon")), float(el.get("lat"))) if el.get("lat") is not None else node_pos.get(oid)
            hit = next((r for r in regions if p and r.contains(*p)), None)
        elif el.tag == "way":
            pts = way_pts.get(oid) or []
            hit = next((r for r in regions if any(r.contains(*p) for p in pts)), None)
        else:
            b = rel_box.get(oid)
            hit = next((r for r in regions if b and r.touches_box(*b)), None)
        if hit is not None:
            blk.remove(el)
            deferred.setdefault(hit.name, {}).setdefault(el.tag, 0)
            deferred[hit.name][el.tag] += 1
    for blk in root.findall("delete"):
        if len(blk) == 0:
            root.remove(blk)
    n = sum(v for d in deferred.values() for v in d.values())
    if n:
        tmp = path.with_suffix(".osc.tmp")
        tree.write(tmp, encoding="UTF-8", xml_declaration=True)
        os.replace(tmp, path)
    detail = "; ".join(f"{k}: " + ", ".join(f"{c} {t}s" for t, c in v.items()) for k, v in deferred.items())
    print(f"[defer_deletes] {path.name} ({a.self_name}): {len(deletes)} deletes, {n} left to the region that still holds them{(' — ' + detail) if detail else ''}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
