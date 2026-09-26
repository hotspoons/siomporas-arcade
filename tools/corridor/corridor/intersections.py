"""What happens where two roads meet: who has priority, who stops, and what the signs say.

Rich drove Crofton and found ONE traffic signal, reading from one direction only, and no stop signs
at all. None of that is an OSM problem — it is that the bake only ever transcribed what OSM had
mapped as a point, and an American suburb records almost none of it:

    inside crofton-triangle's corridor, from the OSM extract
      drivable ways                854
      traffic_signals nodes         35      (and they are single nodes, not one per approach)
      stop nodes                     3
      give_way nodes                 0

Three stop nodes for 854 streets. Every one of those residential crossroads has a stop sign on it in
the real world; OSM simply does not carry them, because a mapper records what is unusual, and in the
United States a minor road stopping at a major one is the default rather than a fact worth typing.

So this module DERIVES the control from the road network instead of transcribing it, which is the
same move `cuts.py` and `rock.py` make against terrain: measure the thing, do not look it up.

    junctions      every OSM node shared by two or more roads WE DRAW, clustered so that one
                   physical crossing is one record even when OSM splits it across several nodes
    approaches     one per arm you can arrive on, with the bearing traffic travels INTO the node,
                   which is what a signal head has to face and what a stop bar has to lie across
    control        `signals` where OSM has a signal node, otherwise derived: unequal ranks give a
                   two-way stop on the minor arms, equal ranks give an all-way stop
    phases         a signal cycle. Opposing arms run together, because that is what a real signal
                   does and what makes a crossroads read as governed rather than as four poles
    blades         the street name signs, on the corner Rich asked for, with the text already
                   truncated to fit the blade

Everything here is in the ENU site frame, metres, x east / y north, and every bearing is a true
compass bearing — the same convention `export._bearing` established. Nothing in this module reads a
raster except the DEM for a fallback z; the viewer re-grounds every post it places anyway.
"""
from __future__ import annotations

import json
import math
from pathlib import Path

# --- how superior is this road? ----------------------------------------------------------------
#
# The ranking is OSM's own functional class, which is exactly the question "which of these two
# roads does the other one give way to". It is not traffic volume and it does not need to be: at a
# junction of a residential street and a tertiary, the residential stops, and that is true whatever
# the counts say.
#
# A link (a slip road) ranks one BELOW its parent rather than equal to it. A slip road off a trunk
# is not a trunk for priority purposes — it is the thing that merges, and it is the arm that yields.
RANK = {
    "motorway": 9,
    "trunk": 8,
    "primary": 7,
    "secondary": 6,
    "tertiary": 5,
    "unclassified": 4,
    "residential": 3,
    "living_street": 2,
    "service": 1,
    "track": 0,
}
for _base in ("motorway", "trunk", "primary", "secondary", "tertiary"):
    RANK[_base + "_link"] = RANK[_base] - 1

# Two OSM nodes this close are one crossing. Crofton's residential blocks are 60 m and up, so 20 m
# cannot merge two real intersections, while it does merge the pair of nodes a divided approach or
# a slightly-offset crossroads is recorded as. Measured on crofton-triangle: 1038 junction records
# on 660 distinct nodes collapse to 628 intersections, and the largest cluster is 4 nodes.
CLUSTER_R = 20.0

# A signal node within this of the cluster centre governs it. Signals sit ON the stop line of each
# arm, which at a wide junction is 25-30 m out from the middle.
SIGNAL_SNAP = 40.0
STOP_SNAP = 30.0

# Opposing arms: two approaches whose bearings differ by 180 +/- this run on the same phase.
OPPOSED_TOL = 40.0

# Where the stop line sits, back from the junction centre along the arm. A real stop bar is at the
# edge of the cross street's carriageway plus a metre or two; half a two-lane road is 3.7 m, so the
# floor is about 6 m and the rest comes from the cross street's own width.
STOP_SETBACK_MIN = 6.0
STOP_SETBACK_EXTRA = 1.5

LANE_W = 3.66


def _lanes(tags: dict, highway: str) -> int:
    for k in ("lanes", "lanes:forward"):
        v = tags.get(k)
        try:
            n = int(str(v).split(";")[0])
            if 1 <= n <= 12:
                return n
        except (TypeError, ValueError):
            pass
    return 4 if highway in ("motorway", "trunk", "primary") else 2


def _dir_lanes(tags: dict, oneway: str, sgn: int, total: int) -> int:
    """The lanes an approach has in ITS direction — what a mast's heads should count.

    Rich, at a signal on Davidsonville Road: "why 5 stop lights for 2 lanes?" Because the mast
    carried the way's `lanes=5`, which is both directions. A one-way carriageway keeps the whole
    count; a two-way road takes `lanes:forward` / `lanes:backward` where OSM has them and half the
    total (rounded up, so a three-lane road with a centre turn lane gets two heads) where it does
    not."""
    if oneway in ("yes", "true", "1", "-1", "reverse"):
        return total
    key = "lanes:forward" if sgn > 0 else "lanes:backward"
    try:
        n = int(str(tags.get(key, "")).split(";")[0])
        if 1 <= n <= 8:
            return n
    except (TypeError, ValueError):
        pass
    return max(1, math.ceil(total / 2))


def _bearing(dx: float, dy: float) -> float:
    """ENU delta -> true compass bearing. ENU north IS true north, so there is no convergence term
    here; `export._bearing` carries one because it is handed UTM grid deltas."""
    return math.degrees(math.atan2(dx, dy)) % 360.0


def _ang_diff(a: float, b: float) -> float:
    return abs((a - b + 180.0) % 360.0 - 180.0)


# --- street name blades -------------------------------------------------------------------------
#
# Rich: "Truncate roads with names longer than like 12 characters (truncate the first part, then
# leave the suffix like rd, dr, st, ct, etc.) and short names can spell out the suffix if room
# permits."
#
# 17, not 12: 12 gave "Hawk Holl Dr" for Hawk Hollow Drive, and Rich measured 17 as the most he
# has seen fit on a real blade. The rule below is unchanged — only the budget moved.
#
# So the suffix is never what gets cut — it is the part that tells you what kind of street this is,
# and "Thistle Brooke" without the "Ct" could be anything. The body gives way instead.
SUFFIX = {
    "road": "Rd", "street": "St", "drive": "Dr", "court": "Ct", "lane": "Ln", "avenue": "Ave",
    "boulevard": "Blvd", "circle": "Cir", "place": "Pl", "terrace": "Ter", "parkway": "Pkwy",
    "highway": "Hwy", "trail": "Trl", "square": "Sq", "crescent": "Cres", "turnpike": "Tpke",
    "way": "Way", "turn": "Turn", "cove": "Cove", "path": "Path", "walk": "Walk", "row": "Row",
    "run": "Run", "loop": "Loop", "pike": "Pike", "alley": "Aly", "gate": "Gate",
}
DIRECTION = {"north": "N", "south": "S", "east": "E", "west": "W",
             "northeast": "NE", "northwest": "NW", "southeast": "SE", "southwest": "SW"}


def blade_text(name: str, max_chars: int = 17) -> str:
    """The name as it goes on the blade.

    Order of attack, each step only taken because the previous one did not fit:

        1. the name as it is                         "Lee Street"         -> "Lee Street"
        2. abbreviate a leading/trailing direction   "Bancroft Lane East" -> "Bancroft Lane E"
        3. abbreviate the suffix                     "Aberdeen Drive"     -> "Aberdeen Dr"
        4. cut the BODY and keep the suffix          "Airy Hill Circle"   -> "Airy Hil Cir"

    Step 1 is Rich's "short names can spell out the suffix if room permits" — it comes first, not
    last, so a name that already fits stays exactly as it is written on the sign it is copying.

    Step 4 is his "truncate the first part, then leave the suffix": the body gives way and the
    suffix never does, because "Thistle Brooke" without the "Ct" could be anything, while
    "Thistl Brooke Ct" is still obviously a court. The cut falls on a word boundary when that keeps
    at least half the body — "Hidden Trace Cove" becomes "Hidden Cove" rather than "Hidden Tr Cove" —
    and otherwise it is a hard cut, because an orphaned two-letter fragment reads as a typo.

    The direction goes BEFORE the suffix check, not after: "Bancroft Lane East" has "East" in the
    last position, so a suffix test run first sees no suffix at all, finds nothing to abbreviate,
    and eats the part of the name that identifies the street.
    """
    name = " ".join((name or "").split())
    if not name:
        return ""
    if len(name) <= max_chars:
        return name
    words = name.split(" ")
    # 2. directions first, at either end. CONSECUTIVE leading directions collapse into one token —
    # "North West Crain Highway" is "NW Crain Hwy" on a real blade, and treating the two words
    # separately is what makes the cut land on "Crain", the only part that identifies the road.
    tail = ""
    if len(words) > 1 and words[-1].lower() in DIRECTION:
        tail = DIRECTION[words[-1].lower()]
        words = words[:-1]
    lead = ""
    while len(words) > 1 and words[0].lower() in DIRECTION:
        lead += DIRECTION[words[0].lower()]
        words = words[1:]
    if lead:
        words = [lead] + words
    # 3. then the suffix
    suf = ""
    if len(words) > 1 and words[-1].lower() in SUFFIX:
        suf = SUFFIX[words[-1].lower()]
        words = words[:-1]

    def joined(body: str) -> str:
        return " ".join(p for p in (body, suf, tail) if p)

    body = " ".join(words)
    out = joined(body)
    if len(out) <= max_chars:
        return out
    # 4. the body gives way
    keep = max_chars - sum(len(p) + 1 for p in (suf, tail) if p)
    if keep < 3:
        return out[:max_chars].rstrip()
    # a lowercase connector carries no information and is the first thing a sign painter drops:
    # "Duke of Kent Dr" -> "Duke Kent Dr", which still names the street, where cutting to length
    # would have given "Duke of Dr".
    if len(body) > keep and len(words) > 2:
        trimmed = [w for w in words if w.lower() not in ("of", "the", "de", "la", "at", "on")]
        if trimmed and trimmed != words:
            body = " ".join(trimmed)
            out = joined(body)
            if len(out) <= max_chars:
                return out
    cut = body[:keep].rstrip()
    sp = cut.rfind(" ")
    if sp >= 3 and sp >= len(body) * 0.5:
        cut = cut[:sp]          # a clean word boundary that still keeps half the name
    elif sp >= 3 and len(cut) - sp <= 3:
        cut = cut[:sp]          # "Capitol R" — a one-letter tail reads as a typo, not a name
    return joined(cut)


# --- the junction graph ---------------------------------------------------------------------------


def _roads(site_dir: Path, frame) -> list[dict]:
    """Every road the viewer draws, with its centreline in ENU metres and its junction list.

    The primary is road 0 and is not in `siblings`; it carries its junctions under `primary`.
    """
    sp = json.loads((site_dir / "spine_utm.json").read_text())
    if not sp.get("network"):
        return []
    out = []

    def enu_line(geom) -> list[tuple[float, float]]:
        parts = [geom["coordinates"]] if geom["type"] == "LineString" else geom["coordinates"]
        cs = [c for p in parts for c in p]
        if not cs:
            return []
        e, n = frame.to_enu([c[0] for c in cs], [c[1] for c in cs])
        return [(float(a), float(b)) for a, b in zip(e, n)]

    prim = sp.get("primary") or {}
    e, n = frame.to_enu([c[0] for c in sp["coords"]], [c[1] for c in sp["coords"]])
    out.append({
        "id": prim.get("id") or "primary",
        "ident": sp.get("ident") or prim.get("ident"),
        "name": prim.get("name"), "ref": prim.get("ref"),
        "highway": prim.get("highway") or "secondary",
        "tags": prim.get("tags") or {},
        "oneway": str(prim.get("oneway") or "no"),
        "line": [(float(a), float(b)) for a, b in zip(e, n)],
        "junctions": prim.get("junctions") or sp.get("junctions") or [],
        "primary": True,
    })
    for s in sp.get("siblings", []):
        line = enu_line(s["geometry"])
        if len(line) < 2:
            continue
        out.append({
            "id": s.get("id"), "ident": s.get("ident"), "name": s.get("name"), "ref": s.get("ref"),
            "highway": s.get("highway") or "residential", "tags": s.get("tags") or {},
            "oneway": str(s.get("oneway") or "no"), "line": line,
            "junctions": s.get("junctions") or [], "primary": False,
        })
    # the road's own lidar grade, so a post beside it stands at road height. This is a FALLBACK:
    # the viewer re-grounds every post it places through `groundAt`, and only uses this z where
    # that returns nothing. Taking it from the profile rather than from the DEM also means this
    # module never opens a raster, which is what lets it run on a tiled site unchanged.
    prof = {}
    br_p = site_dir / "branches.json"
    if br_p.exists():
        for b in json.loads(br_p.read_text()).get("branches", []):
            if b.get("id") and b.get("profile") and b["profile"].get("s"):
                prof[b["id"]] = b["profile"]
    for r in out:
        r["profile"] = prof.get(r["id"])
        r["rank"] = RANK.get(r["highway"], 3)
        r["lanes"] = _lanes(r["tags"], r["highway"])
        r["length_m"] = sum(math.dist(r["line"][i], r["line"][i - 1]) for i in range(1, len(r["line"])))
        # cumulative station of every vertex, so a junction's `s` can be turned into a tangent
        cum = [0.0]
        for i in range(1, len(r["line"])):
            cum.append(cum[-1] + math.dist(r["line"][i], r["line"][i - 1]))
        r["cum"] = cum
    return out


def _road_z(road: dict, s: float) -> float:
    """Road height at station s, from that road's own lidar profile. 0.0 where it has none."""
    pr = road.get("profile")
    if not pr or not pr.get("s"):
        return 0.0
    ss, zz = pr["s"], pr["road_z"]
    if s <= ss[0]:
        return float(zz[0]) if _finite(zz[0]) else 0.0
    for i in range(1, len(ss)):
        if ss[i] >= s:
            a, b = zz[i - 1], zz[i]
            if not (_finite(a) and _finite(b)):
                return float(a) if _finite(a) else (float(b) if _finite(b) else 0.0)
            t = (s - ss[i - 1]) / max(1e-6, ss[i] - ss[i - 1])
            return float(a + (b - a) * t)
    return float(zz[-1]) if _finite(zz[-1]) else 0.0


def _finite(v) -> bool:
    return v is not None and isinstance(v, (int, float)) and math.isfinite(v)


def _tangent(road: dict, s: float) -> tuple[float, float]:
    """Unit direction of increasing `s` at station s, from the drawn centreline."""
    cum, line = road["cum"], road["line"]
    s = max(0.0, min(cum[-1], s))
    i = 1
    while i < len(cum) - 1 and cum[i] < s:
        i += 1
    ax, ay = line[i - 1]
    bx, by = line[i]
    d = math.hypot(bx - ax, by - ay) or 1.0
    return (bx - ax) / d, (by - ay) / d


def _point_at(road: dict, s: float) -> tuple[float, float]:
    cum, line = road["cum"], road["line"]
    s = max(0.0, min(cum[-1], s))
    i = 1
    while i < len(cum) - 1 and cum[i] < s:
        i += 1
    t = (s - cum[i - 1]) / max(1e-6, cum[i] - cum[i - 1])
    ax, ay = line[i - 1]
    bx, by = line[i]
    return ax + (bx - ax) * t, ay + (by - ay) * t


def _signal_and_stop_nodes(site_dir: Path, frame) -> tuple[list, list]:
    gj = site_dir / "osm.geojson"
    if not gj.exists():
        return [], []
    sig, stop = [], []
    for f in json.loads(gj.read_text())["features"]:
        g, p = f["geometry"], f["properties"]
        if g["type"] != "Point":
            continue
        h = p.get("highway")
        if h not in ("traffic_signals", "stop", "give_way"):
            continue
        e, n = frame.from_wgs(g["coordinates"][0], g["coordinates"][1])
        e, n = frame.to_enu(e, n)
        (sig if h == "traffic_signals" else stop).append({"x": float(e), "y": float(n), "kind": h, "dir": p.get("direction") or p.get("traffic_signals:direction")})
    return sig, stop


def build(site_dir: Path, frame, max_chars: int = 17) -> dict:
    """Every intersection on this site, with control, phases, stop bars and name blades."""
    roads = _roads(site_dir, frame)
    if not roads:
        return {"list": [], "counts": {}}
    by_id = {r["id"]: r for r in roads}

    # 1. gather every junction record, keyed by OSM node
    at_node: dict[int, list[tuple[dict, dict]]] = {}
    for r in roads:
        for j in r["junctions"]:
            if j.get("node") is None:
                continue
            at_node.setdefault(int(j["node"]), []).append((r, j))

    # 2. cluster nodes that are one physical crossing
    nodes = []
    for nid, recs in at_node.items():
        x = sum(j["x"] for _, j in recs) / len(recs)
        y = sum(j["y"] for _, j in recs) / len(recs)
        nodes.append({"node": nid, "x": x, "y": y, "recs": recs})
    unassigned = list(range(len(nodes)))
    clusters = []
    while unassigned:
        grp = [unassigned.pop()]
        moved = True
        while moved:
            moved = False
            for i in list(unassigned):
                if any(math.dist((nodes[i]["x"], nodes[i]["y"]), (nodes[k]["x"], nodes[k]["y"])) <= CLUSTER_R for k in grp):
                    grp.append(i)
                    unassigned.remove(i)
                    moved = True
        clusters.append(grp)

    sig_nodes, stop_nodes = _signal_and_stop_nodes(site_dir, frame)

    out = []
    counts = {"intersections": 0, "signalised": 0, "all_way_stop": 0, "two_way_stop": 0, "uncontrolled": 0,
              "approaches": 0, "masts": 0, "stop_signs": 0, "blades": 0, "round_robin": 0}
    for grp in clusters:
        members = [nodes[i] for i in grp]
        cx = sum(m["x"] for m in members) / len(members)
        cy = sum(m["y"] for m in members) / len(members)

        # 3. approaches: one per arm you can ARRIVE on.
        #
        # A road through a junction gives two arms; a road that ends there gives one. `oneway`
        # removes the arm you cannot legally arrive on. The bearing is the direction of TRAVEL into
        # the node, taken a short way back down the arm rather than at the node itself, because at
        # the node the two arms of a smooth curve are nearly parallel and the pair would read as
        # opposed when they are the same road bending.
        approaches = []
        seen = set()
        for m in members:
            for r, j in m["recs"]:
                s = float(j.get("s") or 0.0)
                L = r["cum"][-1]
                oneway = r["oneway"] in ("yes", "true", "1")
                rev = r["oneway"] in ("-1", "reverse")
                for sgn in (+1, -1):
                    # sgn = +1: traffic arrives travelling in the direction of increasing s, so the
                    # arm it comes down is the stretch BEFORE the node.
                    back_s = s - sgn * 25.0
                    if sgn > 0 and s < 5.0:
                        continue      # nothing behind it: the road starts here
                    if sgn < 0 and s > L - 5.0:
                        continue
                    if oneway and sgn < 0:
                        continue
                    if rev and sgn > 0:
                        continue
                    key = (r["id"], sgn)
                    if key in seen:
                        continue
                    seen.add(key)
                    bx, by = _point_at(r, max(0.0, min(L, back_s)))
                    dx, dy = cx - bx, cy - by
                    d = math.hypot(dx, dy) or 1.0
                    approaches.append({
                        "road": r["id"], "name": r["ident"] or r["name"] or r["ref"],
                        "highway": r["highway"], "rank": r["rank"], "lanes": r["lanes"],
                        "length_m": round(r["length_m"], 1),
                        "bearing_deg": round(_bearing(dx / d, dy / d), 1),
                        "s": round(s, 1), "sgn": sgn,
                        # does this road CONTINUE past the node, or does it end here? That is the
                        # difference between a through street and the stem of a T, and it decides
                        # who stops when neither road outranks the other.
                        "through": 5.0 < s < L - 5.0,
                    })
        if len(approaches) < 3:
            # two approaches is not an intersection: it is one road continuing through a node where
            # OSM happened to split the way, or a road meeting one we do not draw.
            continue
        counts["intersections"] += 1
        counts["approaches"] += len(approaches)

        # 4. control
        near_sig = min((math.dist((s["x"], s["y"]), (cx, cy)) for s in sig_nodes), default=1e9)
        signalised = near_sig <= SIGNAL_SNAP
        top = max(a["rank"] for a in approaches)

        # WHO STOPS. Class first: a residential street stops at a tertiary, always.
        #
        # When the classes are equal — which in a subdivision is most junctions — class says
        # nothing and CONTINUITY decides, because that is what the junction actually looks like on
        # the ground. A street that runs through has the right of way over one that ends at it:
        # that is a T, and the stem stops. Only where two equal roads BOTH run through is it a real
        # crossroads, and that is the case that gets an all-way stop.
        #
        # Getting this wrong is not subtle. Ranking on class alone made 298 of Crofton's 408
        # junctions all-way stops and put 1062 stop signs on a suburb that has almost no four-way
        # stops in it — every court meeting its street would have stopped the street too.
        main = sorted({a["road"] for a in approaches if a["rank"] == top and a["through"]})
        if signalised:
            control = "signals"
            counts["signalised"] += 1
        elif len(main) == 1:
            control = "two_way_stop"
            counts["two_way_stop"] += 1
        else:
            # two equal through roads (a real crossroads), or none at all (a Y, a fork, a pair of
            # streets that both end here) — nobody has an obvious claim, so everybody stops
            control = "all_way_stop"
            counts["all_way_stop"] += 1

        # superiority: highest class wins; ties broken by lanes, then by how long the road runs
        # through this site (a through-route beats a stub), then by the road id, which is intrinsic
        # (`r<smallest OSM way id>`) and therefore stable across re-bakes.
        def superiority(a):
            return (a["rank"], a["lanes"], a["length_m"], a["road"] or "")
        # the superior arm is drawn from the through roads where there are any, so a long court
        # cannot outrank the street it ends on just by being long
        pool = [a for a in approaches if a["road"] in main] or approaches
        best = max(pool, key=superiority)
        for a in approaches:
            a["superior"] = a["road"] == best["road"]
            a["stop"] = False
        if control == "all_way_stop":
            for a in approaches:
                a["stop"] = True
        elif control == "two_way_stop":
            for a in approaches:
                a["stop"] = a["road"] not in main
        # an OSM stop/give_way node overrules the inference on the arm it sits on
        for sn in stop_nodes:
            if math.dist((sn["x"], sn["y"]), (cx, cy)) > STOP_SNAP:
                continue
            for a in approaches:
                if _ang_diff(_bearing(sn["x"] - cx, sn["y"] - cy), (a["bearing_deg"] + 180.0) % 360.0) < 45.0:
                    a["stop"] = True
                    a["stop_source"] = "osm"
        counts["stop_signs"] += sum(1 for a in approaches if a["stop"])
        if control != "signals" and not any(a["stop"] for a in approaches):
            counts["uncontrolled"] += 1

        # 5. the stop line, and the post beside it
        #
        # Set back from the centre by half the WIDEST cross street plus a margin: that is where the
        # bar goes in the real world, and it is also the only setback that keeps the bar off the
        # cross street's asphalt at a junction of a 4-lane and a residential.
        cross_half = max((a["lanes"] * LANE_W / 2 for a in approaches), default=LANE_W)
        setback = max(STOP_SETBACK_MIN, cross_half + STOP_SETBACK_EXTRA)
        for a in approaches:
            b = math.radians(a["bearing_deg"])
            # travel direction as a unit vector in ENU
            tx, ty = math.sin(b), math.cos(b)
            a["stop_x"] = round(cx - tx * setback, 2)
            a["stop_y"] = round(cy - ty * setback, 2)
            a["width_m"] = round(a["lanes"] * LANE_W, 2)

        # 6. phases
        phases, cycle = _phases(approaches, best)
        if control != "signals":
            phases, cycle = [], 0.0
        else:
            counts["masts"] += len(approaches)
            if len(phases) > 2:
                counts["round_robin"] += 1

        # 7. the name blades and the corner they stand on
        blades, corners = _blades(approaches, best, cx, cy, max_chars)
        counts["blades"] += len(blades)

        out.append({
            "id": f"x{min(m['node'] for m in members)}",
            "nodes": sorted(m["node"] for m in members),
            "x": round(cx, 2), "y": round(cy, 2),
            "control": control,
            "arms": len(approaches),
            "superior": best["road"],
            "approaches": approaches,
            "phases": phases,
            "cycle_s": round(cycle, 1),
            "blades": blades,
            "corners": corners,
        })
    return {"list": out, "counts": counts}


def _phases(approaches: list[dict], best: dict) -> tuple[list[dict], float]:
    """Group the arms into signal phases.

    A real signal runs OPPOSING arms together — northbound and southbound of one road get the same
    green, because they do not conflict. So the phase set is built by pairing each arm with the one
    whose bearing is 180 +/- OPPOSED_TOL away and which belongs to the same road where possible.

    Rich: "set the superior road with a 2 minute interval and the inferior road with a 20 second
    interval. More than 4 way intersections should just round robin." So a junction that pairs into
    two groups gets the long/short split, and anything that does not — five arms, a skew crossing,
    a fork — gets one arm at a time, which is the only safe thing when you cannot prove two arms do
    not conflict.

    The durations are knobs on the viewer side; what the bake stores is the STRUCTURE plus a
    nominal green, so a manifest is readable on its own and the viewer can still override.
    """
    GREEN_MAJOR, GREEN_MINOR, GREEN_RR = 120.0, 20.0, 25.0
    AMBER, ALL_RED = 4.0, 2.0
    used = set()
    groups: list[list[int]] = []
    for i, a in enumerate(approaches):
        if i in used:
            continue
        grp = [i]
        used.add(i)
        opp = (a["bearing_deg"] + 180.0) % 360.0
        cands = [(j, b) for j, b in enumerate(approaches) if j not in used and _ang_diff(b["bearing_deg"], opp) <= OPPOSED_TOL]
        if cands:
            # same road first, then the most exactly opposed
            cands.sort(key=lambda jb: (jb[1]["road"] != a["road"], _ang_diff(jb[1]["bearing_deg"], opp)))
            j = cands[0][0]
            grp.append(j)
            used.add(j)
        groups.append(grp)

    round_robin = len(groups) > 2
    # exactly ONE phase is the superior one: the group holding the superior road. Testing on rank
    # alone made both phases superior at a crossroads of two equal roads and produced a 252 s
    # cycle — four minutes of green split between two streets, and a two-minute wait to turn.
    best_grp = next((gi for gi, g in enumerate(groups) if any(approaches[i]["road"] == best["road"] for i in g)), 0)
    phases = []
    for gi, grp in enumerate(groups):
        sup = gi == best_grp
        if round_robin:
            green = GREEN_RR
        else:
            green = GREEN_MAJOR if sup else GREEN_MINOR
        phases.append({"arms": grp, "green_s": green, "amber_s": AMBER, "all_red_s": ALL_RED, "superior": sup})
        for i in grp:
            approaches[i]["phase"] = gi
    cycle = sum(p["green_s"] + p["amber_s"] + p["all_red_s"] for p in phases)
    return phases, cycle


def _blades(approaches: list[dict], best: dict, cx: float, cy: float, max_chars: int) -> tuple[list[dict], list[dict]]:
    """The street name signs, and which corner they stand on.

    Rich: "prefer the far right corner from superior road in the direction of travel — close right
    for inferior road, figure out a tie breaker."

    Those two rules pick the SAME corner, which is why they are one rule. Take a crossroads with the
    superior road running east-west. Traffic heading east has its far-right corner at the south-east;
    traffic heading north on the minor road has its near-right corner at the south-east too. So the
    corner is fully determined by the superior road's direction of travel — and the superior road
    has two directions, which is exactly where the tie Rich asked about comes from.

    The tie-break, in order:

      1. A T junction decides it by itself: only one of the two diagonal corners has the stem road
         on its side, and a blade on the other one is across an empty verge from the street it names.
      2. Otherwise take the north-easterly corner. It is arbitrary but it is CONSISTENT, and
         consistency is the property that matters across a grid — every blade in Crofton ends up on
         the same corner of every block, the way a real municipality does it.

    Both candidates are emitted, better one first, because only the viewer knows where the pavement
    actually ends and it may have to fall back to the other.
    """
    names: dict[str, dict] = {}
    for a in approaches:
        if not a["name"]:
            continue
        # one blade per road, not per arm, and it keeps the higher-ranked arm's bearing
        prev = names.get(a["name"])
        if prev is None or a["rank"] > prev["rank"]:
            names[a["name"]] = a
    if len(names) < 2:
        return [], []

    b = math.radians(best["bearing_deg"])
    tx, ty = math.sin(b), math.cos(b)          # superior travel direction
    rx, ry = ty, -tx                           # right of travel
    R = max(6.0, best["lanes"] * LANE_W / 2 + 4.0)
    # All FOUR quadrants, in preference order. The two diagonals Rich's rule picks come first; the
    # other two are there because a corner can be unusable — a slip lane, a wide radius, a building
    # on the property line — and a junction with no blade at all is worse than one whose blade is on
    # the near corner. Measured: with two candidates, 62 of 408 junctions (15 %) found neither clear
    # and were skipped entirely.
    cand = [
        {"x": round(cx + (tx + rx) * R, 2), "y": round(cy + (ty + ry) * R, 2), "why": "far right of the superior road"},
        {"x": round(cx - (tx + rx) * R, 2), "y": round(cy - (ty + ry) * R, 2), "why": "far right of the opposite direction"},
        {"x": round(cx + (tx - rx) * R, 2), "y": round(cy + (ty - ry) * R, 2), "why": "far left, where neither right corner is clear"},
        {"x": round(cx - (tx - rx) * R, 2), "y": round(cy - (ty - ry) * R, 2), "why": "near left, last resort"},
    ]
    pref, rest = cand[:2], cand[2:]
    # 1. a T junction: prefer the corner on the side the stem actually comes from
    stems = [a for a in approaches if a["rank"] < best["rank"]] or [a for a in approaches if a["road"] != best["road"]]
    if stems:
        sb = math.radians(stems[0]["bearing_deg"])
        # the stem's traffic arrives travelling (sin, cos), so the stem lies OPPOSITE that
        sx, sy = -math.sin(sb), -math.cos(sb)
        pref.sort(key=lambda c: -((c["x"] - cx) * sx + (c["y"] - cy) * sy))
        rest.sort(key=lambda c: -((c["x"] - cx) * sx + (c["y"] - cy) * sy))
    else:
        # 2. north-easterly wins
        pref.sort(key=lambda c: -((c["x"] - cx) + (c["y"] - cy)))
        rest.sort(key=lambda c: -((c["x"] - cx) + (c["y"] - cy)))
    cand = pref + rest

    blades = []
    for nm, a in sorted(names.items(), key=lambda kv: (-kv[1]["rank"], kv[0])):
        txt = blade_text(nm, max_chars)
        blades.append({
            "text": txt, "full": nm, "truncated": txt != nm,
            # a blade runs PARALLEL to the road it names, so its face is broadside to the traffic
            # on the cross street, which is the traffic that needs to read it
            "yaw_deg": round(a["bearing_deg"] % 180.0, 1),
            "rank": a["rank"],
        })
    return blades, cand


# --- what actually gets built -------------------------------------------------------------------


def furniture(built: dict, roads_by_id: dict) -> dict:
    """Turn the intersection model into the records the viewer already knows how to place.

    Masts and signs come out in the SAME shape `export._signals` emits, so `furniture.ts` places
    them with the code it already has — the kerb walk, the arm that measures its own reach, the
    drop of anything whose road is not drawn. What is new on each record is `junction` (which
    crossing it belongs to) and `phase` (which group of arms it runs with), which is all a
    controller needs.

    The stop BAR is separate from the stop SIGN because they are different objects in the world:
    the sign is a post on the verge and the bar is paint across the lane, and Rich asked for both
    ("please put them with a line in the direction of travel").
    """
    masts, signs, bars = [], [], []
    for X in built["list"]:
        for ai, a in enumerate(X["approaches"]):
            road = roads_by_id.get(a["road"]) or {}
            z = round(_road_z(road, a["s"]), 2) if road else 0.0
            travel = a["bearing_deg"]
            heads = (travel + 180.0) % 360.0
            if X["control"] == "signals":
                dir_lanes = _dir_lanes(road.get("tags") or {}, str(road.get("oneway") or "no"), a.get("sgn", 1), a["lanes"])
                # FAR SIDE. A signal's heads hang across the junction from the traffic they control,
                # at the far-right corner, so a driver at the stop line looks ahead at them and not
                # straight up (Rich, 2026-09-26: "I've seen a lot on the near side ... makes no
                # sense"). The pole goes on this approach's travel line PAST the centre: to the
                # opposite arm's stop line where the road continues, or just past the cross
                # street's far kerb at a T. The viewer then walks it sideways to the kerb and hangs
                # the arm back over the approach's lanes.
                tb = math.radians(a["bearing_deg"])
                tx, ty = math.sin(tb), math.cos(tb)
                opp = None
                for o in X["approaches"]:
                    if o is a:
                        continue
                    dd = abs(((o["bearing_deg"] - a["bearing_deg"] + 180.0) % 360.0) - 180.0)
                    if dd > 145.0:
                        opp = o
                        break
                if opp is not None:
                    far = math.hypot(opp["stop_x"] - X["x"], opp["stop_y"] - X["y"])
                else:
                    far = max((o["lanes"] * LANE_W / 2 for o in X["approaches"] if o is not a), default=LANE_W) + 1.5
                mx, my = X["x"] + tx * far, X["y"] + ty * far
                masts.append({
                    "x": round(mx, 2), "y": round(my, 2), "z": z, "far_side": True,
                    "yaw_deg": round(heads, 1), "travel_deg": round(travel, 1),
                    # the arm reaches over this approach's lanes, and carries one head per lane
                    "arm_m": round(dir_lanes * LANE_W + 1.4, 2), "lanes": dir_lanes,
                    "junction": X["arms"], "tagged": False,
                    "x_id": X["id"], "phase": a.get("phase", 0), "arm": ai,
                })
            if a["stop"]:
                signs.append({
                    "kind": "stop", "x": a["stop_x"], "y": a["stop_y"], "z": z,
                    "yaw_deg": round(heads, 1), "travel_deg": round(travel, 1),
                    "x_id": X["id"], "arm": ai, "source": a.get("stop_source", "derived"),
                })
                bars.append({
                    "x": a["stop_x"], "y": a["stop_y"], "z": z,
                    # the bar lies ACROSS the lane, so its own heading is the travel bearing and
                    # the viewer sweeps it sideways by `width_m`
                    "travel_deg": round(travel, 1), "width_m": a["width_m"],
                    "x_id": X["id"], "arm": ai,
                })
    return {"masts": masts, "signs": signs, "bars": bars}


def build_all(site_dir: Path, frame, max_chars: int = 17) -> dict | None:
    """Everything this module contributes to one manifest, or None for a non-network site."""
    roads = _roads(site_dir, frame)
    if not roads:
        return None
    built = build(site_dir, frame, max_chars)
    f = furniture(built, {r["id"]: r for r in roads})
    return {
        "list": built["list"],
        "counts": {**built["counts"], "bars": len(f["bars"])},
        "masts": f["masts"], "signs": f["signs"], "bars": f["bars"],
    }


def merge_into(out: dict, site_dir: Path, frame, max_chars: int = 17) -> dict | None:
    """Fold this module's output into a manifest that `export._signals` has already filled in.

    The two sources overlap on purpose and the derived one wins AT A JUNCTION WE MODEL:

      * `_signals` emits one mast per OSM `traffic_signals` NODE. OSM records a junction's signals
        as one node per arm where a mapper bothered and as a single node in the middle where they
        did not, which is why Crofton read as one signal facing one way. Every mast inside a
        modelled signalised junction is therefore replaced by one mast PER APPROACH.
      * a signal that belongs to no junction of ours — a mid-block pedestrian crossing, of which
        Crofton has many — is kept exactly as it was. It has no phase and no arms to conflict with.
      * an OSM stop/give_way node inside a modelled junction has already been folded in as
        `stop_source: "osm"` on the arm it governs, so the raw node is dropped to avoid two posts
        in the same place. Ones outside are kept.
    """
    built = build_all(site_dir, frame, max_chars)
    if built is None:
        return None
    centres = [(X["x"], X["y"], X["control"]) for X in built["list"]]
    sig_centres = [(x, y) for x, y, c in centres if c == "signals"]
    all_centres = [(x, y) for x, y, _ in centres]

    def near(p, pts, r):
        return any(math.dist((p["x"], p["y"]), q) <= r for q in pts)

    old = out.get("signals") or {}
    kept_masts = [m for m in (old.get("masts") or []) if not near(m, sig_centres, SIGNAL_SNAP)]
    kept_signs = [s for s in (old.get("signs") or []) if not near(s, all_centres, STOP_SNAP)]
    out["signals"] = {
        "masts": kept_masts + built["masts"],
        "signs": kept_signs + built["signs"],
        "bars": built["bars"],
    }
    out["intersections"] = {"list": built["list"], "counts": built["counts"]}
    built["counts"]["masts_kept_isolated"] = len(kept_masts)
    built["counts"]["signs_kept_isolated"] = len(kept_signs)
    return built["counts"]
