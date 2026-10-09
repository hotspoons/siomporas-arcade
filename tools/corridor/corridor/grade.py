"""The viewer's road grading, ported to the bake so the pyramid can carry a GRADED ground.

## Why this exists

`apps/corridor/src/world/scene.ts` grades the ground at run time: `physGroundAt` / `gradedHeight`
fold every carriageway's profile into the bare-earth DEM — the road height under and just beside
the pavement, a smoothstep blend back to the DEM across the verge, decks left to their own
colliders, bridge verges stopping at the parapet, junctions met, cul-de-sac bulbs. That formula
costs ~4 µs a sample, and the physics heightfield (33 × 33 samples a 64 m tile) and the terrain
strips (a vertex a metre) ask it thousands of times a tile — at 75 m/s that is the frame.

The bake already knows every road's grade. This module is that formula, read out of `scene.ts`
and `props.ts` line by line, so `pyramid.bake` can write the graded surface INTO `dem.png` and the
viewer can look it up. It is deliberately a port, not a redesign: every threshold, every order
of operations and every oddity (a sibling's own `s` indexed against the spine's bridge list, a
lone station being a disc) is reproduced, because the measurement that proves this correct is
"the baked raster agrees with the run-time formula", and that measurement is only meaningful if
the two are the same formula. PERF-RIG.md § "For the bake" is the brief.

## The frame

Everything here runs in the VIEWER'S world frame, because that is the frame the formula was
written in: `x = east`, `y = up`, `z = -north` (`toWorld` in scene.ts). The manifest's ENU
coordinates are `[east, north, up]`; `_to_world` flips them once at the door. A caller that holds
ENU (east, north) passes `z = -north`.

Heights are ENU UP. The pyramid stores a raster height `h` and the viewer's `heightAt` returns
`RasterFrame.toEnuUp(u, v, h)` = the ellipsoid drop under that pixel plus `h`; so the raster has
to be converted to up before grading and back after, which `grade_block` does with the viewer's
own bilinear-of-the-corners drop (`enuUp` in packages/engine/src/geo/raster.ts) rather than the
exact ellipsoid, because the viewer's lookup is the thing we must agree with.

## What is NOT ported, and why

- the editor's `ground_offset_m` adjustments: authored outside `web/`, unknown to the bake. The
  viewer keeps run-time grading for a site whose adjustments are active (scene.ts).
- `GRASS_LIFT_M` (the turf lip, default 0): a knob, baked as 0. Nothing stands on the lip today.
- the windowed `taperedLanes` of a > 80 km spine and the 200 m-grid `nearestSpine` of a > 20 km
  one: the simple paths are what every baked site exercises; the long-spine paths change the
  arithmetic only in which station is "nearest" at a junction, and are ported where cheap.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from . import BakeFault

# --- the knobs (apps/corridor/src/tuning.ts defaults) ------------------------------------------
#
# Read out of tuning.ts on 2026-10-09. These are the DEFAULTS; a browser whose F6 panel moved one
# of them is grading a different world than the bake did, and `tools/corridor/README.md` says so.


@dataclass(frozen=True)
class Knobs:
    EDGE_BAND_M: float = 3.5          # half the along-track band of a road station
    LANE_WIDTH: float = 3.66
    SHOULDER_OUT: float = 3.0
    SHOULDER_IN: float = 1.2
    KERB_GUTTER: float = 0.3
    ROAD_TAPER_M: float = 60.0        # a lane-count change ramps over this
    ROAD_ONEWAY_CENTRE: float = 0.0   # 0 = lanes centred on the spine (props.pavedOffset)
    CULDESAC_RADIUS: float = 9.0
    JUNCTION_MEET_M: float = 40.0
    BRANCH_VERGE: float = 14.0
    OVERPASS_CLEAR_M: float = 3.0     # a carriageway this far above the DEM is a deck
    STREAM_LOCAL: float = 1.0         # picks the polyline spine past 6000 points (scene.ts)
    GRASS_LIFT_M: float = 0.0


DEFAULT_KNOBS = Knobs()

#: scene.ts constants that are not knobs
VERGE = 40.0            # the primary road's strip, m each side of the pavement
BRIDGE_TAPER = 10.0     # stripEdgeLimitAt: the parapet limit fades in over this
PARAPET = 1.0           # "the parapets in the structures pass stand 0.6 m outside the pavement"
ST_STEP = 5.0           # a station every 5 m
ST_CELL = 20.0          # the station hash cell, and the 7x7 walk edgeDistance does over it
ROAD_LIFT = 0.4         # every spline is the road surface + 0.4 (toWorld(x, y, z + 0.4))
SURFACE_DROP = 0.02     # ... and the ground under the pavement is e.y - 0.02
BLEND_LO, BLEND_HI = 0.6, 7.0
MEET_NEAR_M = 6.0       # a junction node must be within 6 m of a raw vertex to meet there
HOME_M = 1000.0
#: a deck is at least this many stations (5 m each) long; a gap in one up to this many is not a gap
DECK_MIN_STATIONS = 3
DECK_GAP_STATIONS = 2

#: props.ts: road classes kerbed in an American suburb — a gutter, no shoulder, no edge line
KERBED = frozenset({"residential", "living_street", "unclassified", "service", "tertiary", "tertiary_link"})
#: scene.ts: OSM oneway=yes, or a motorway-class way, is a carriageway; everything else is two-way
ONE_WAY_CLASSES = ("motorway", "motorway_link", "trunk_link", "primary_link")
#: scene.ts RANK for the junction-meet fallback (lower wins)
RANK = {"motorway": 0, "trunk": 1, "primary": 2, "secondary": 3, "tertiary": 4, "unclassified": 5, "residential": 6, "living_street": 7, "service": 8}
#: edgeDistance's `who` for a driveway or stub station (not a carriageway, carries its own height)
WHO_DRIVEWAY = -2

#: How far the carriageways may stand off the DEM, as a median over every station that is NOT a
#: deck, before the bake is wrong rather than the ground being hilly. A road's grade is the lidar
#: DTM under it and the pyramid is the 1 m DEM of the same survey: measured on crofton-triangle
#: they agree to 2 cm (median -0.02 m over 16,282 profile samples). The served 2026-10-02 bake
#: stood a median 1.51 m (p90 3.32 m) above the DEM — its branch z was the raw height, written
#: before f208be9 curved the vertical, and against an earth that IS curved the roads floated by
#: d²/2R: 0.15 m within 2 km of the anchor, 3.3 m at 6–9 km, 6,883 stations over 3 m and so
#: "decks" through a suburb. Half a metre is ten times the agreement and a third of the deck
#: threshold: nothing real sits there, and a bake that does has sampled its grades off something
#: other than the earth it is writing.
GRADE_OFF_MAX_M = 0.5


class GradeFault(BakeFault):
    """The carriageways stand systematically off the DEM the pyramid writes."""


def _smooth_runs(flags: np.ndarray, max_gap: int, min_run: int) -> np.ndarray:
    """Close gaps of at most `max_gap` False between Trues, then drop runs of fewer than
    `min_run` Trues — a morphological closing and opening along one carriageway's stations."""
    f = np.asarray(flags, dtype=bool).copy()
    n = len(f)
    # closing: a False run bounded by Trues on both sides, no longer than max_gap, becomes True
    i = 0
    while i < n:
        if not f[i]:
            j = i
            while j < n and not f[j]:
                j += 1
            if i > 0 and j < n and (j - i) <= max_gap:
                f[i:j] = True
            i = j
        else:
            i += 1
    # opening: a True run shorter than min_run becomes False
    i = 0
    while i < n:
        if f[i]:
            j = i
            while j < n and f[j]:
                j += 1
            if (j - i) < min_run:
                f[i:j] = False
            i = j
        else:
            i += 1
    return f


def smoothstep(x, lo: float, hi: float):
    """THREE.MathUtils.smoothstep, elementwise."""
    x = np.asarray(x, dtype=float)
    t = np.clip((x - lo) / (hi - lo), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def is_kerbed(highway) -> bool:
    return (highway or "") in KERBED


def paved_width(lanes: float, two_way: bool = False, kerbed: bool = False, k: Knobs = DEFAULT_KNOBS) -> float:
    """props.pavedWidth: lanes × 3.66 + both shoulders, or lanes + two gutters when kerbed."""
    if kerbed:
        return lanes * k.LANE_WIDTH + 2 * k.KERB_GUTTER
    return lanes * k.LANE_WIDTH + k.SHOULDER_OUT + (k.SHOULDER_OUT if two_way else k.SHOULDER_IN)


def paved_offset(two_way: bool = False, kerbed: bool = False, k: Knobs = DEFAULT_KNOBS) -> float:
    """props.pavedOffset: how far right of the spine a one-way carriageway's asphalt centre sits."""
    if two_way or kerbed or k.ROAD_ONEWAY_CENTRE >= 0.5:
        return 0.0
    return (k.SHOULDER_OUT - k.SHOULDER_IN) / 2


def branch_lanes(v, fallback: int = 2) -> float:
    """scene.branchLanes: a number > 0, a numeric string, the smallest of a list, else 2."""
    if isinstance(v, bool):
        return fallback
    if isinstance(v, (int, float)):
        return v if v > 0 else fallback
    if isinstance(v, str):
        try:
            n = float(v)
        except ValueError:
            return fallback
        return n if n > 0 else fallback
    if isinstance(v, list):
        ns = []
        for x in v:
            try:
                n = float(x)
            except (TypeError, ValueError):
                continue
            if n > 0:
                ns.append(n)
        return min(ns) if ns else fallback
    return fallback


def two_way_of(oneway, highway) -> bool:
    if oneway in ("yes", "-1"):
        return False
    if oneway == "no":
        return True
    return (highway or "") not in ONE_WAY_CLASSES


# --- the curves (three.js CatmullRomCurve3, 'centripetal', and the long-spine polyline) ---------
#
# The road height at a point is "the spline at the projected along-track metre — the very same
# function the asphalt mesh is built from" (scene.ts). A polyline through the same 10 m points is
# off it by the sagitta, 25 cm on a 50 m radius court, which is most of the 2 cm budget gone on
# every bend. So the spline is ported, arc-length table and all, not approximated.


class Curve3:
    """`new THREE.CatmullRomCurve3(points, false, 'centripetal')` with `arcLengthDivisions` set.

    `at(s)` is `getPointAt(s / len)` + `getTangentAt(s / len)`, vectorised over `s`. The arc-length
    table is built exactly as `Curve.getLengths` builds it (chords between `divisions + 1` samples
    of `getPoint`), so `len` is three's `getLength()` to the last bit that float64 agrees on.
    """

    def __init__(self, points: np.ndarray, divisions: int):
        p = np.asarray(points, dtype=float).reshape(-1, 3)
        if len(p) < 2:
            raise ValueError("a curve needs two points")
        self.p = p
        self.n = len(p)
        self.div = int(divisions)
        # the non-uniform (centripetal) tangents per segment, precomputed once
        l = self.n
        # extrapolated end points, as three does: p0 = points[0] * 2 - points[1]
        ext = np.vstack([2 * p[0] - p[1], p, 2 * p[-1] - p[-2]])  # index k+1 == points[k]
        p0, p1, p2, p3 = ext[:-3], ext[1:-2], ext[2:-1], ext[3:]  # per segment i = 0..l-2
        pw = 0.25
        dt0 = np.sum((p1 - p0) ** 2, axis=1) ** pw
        dt1 = np.sum((p2 - p1) ** 2, axis=1) ** pw
        dt2 = np.sum((p3 - p2) ** 2, axis=1) ** pw
        dt1 = np.where(dt1 < 1e-4, 1.0, dt1)
        dt0 = np.where(dt0 < 1e-4, dt1, dt0)
        dt2 = np.where(dt2 < 1e-4, dt1, dt2)
        dt0, dt1, dt2 = dt0[:, None], dt1[:, None], dt2[:, None]
        t1 = ((p1 - p0) / dt0 - (p2 - p0) / (dt0 + dt1) + (p2 - p1) / dt1) * dt1
        t2 = ((p2 - p1) / dt1 - (p3 - p1) / (dt1 + dt2) + (p3 - p2) / dt2) * dt1
        # CubicPoly.init(x0 = p1, x1 = p2, t0 = t1, t1 = t2)
        self.c0 = p1
        self.c1 = t1
        self.c2 = -3 * p1 + 3 * p2 - 2 * t1 - t2
        self.c3 = 2 * p1 - 2 * p2 + t1 + t2
        assert len(self.c0) == l - 1
        # Curve.getLengths(divisions): chords between divisions + 1 samples of getPoint
        ts = np.arange(self.div + 1) / self.div
        pts = self.point(ts)
        seg = np.linalg.norm(np.diff(pts, axis=0), axis=1)
        self.arc = np.concatenate([[0.0], np.cumsum(seg)])
        self.len = float(self.arc[-1])

    def point(self, t) -> np.ndarray:
        """CatmullRomCurve3.getPoint(t), vectorised. t in 0..1."""
        t = np.asarray(t, dtype=float)
        l = self.n
        pp = (l - 1) * t
        i = np.floor(pp)
        w = pp - i
        end = (w == 0) & (i == l - 1)
        i = np.where(end, l - 2, i).astype(int)
        w = np.where(end, 1.0, w)
        i = np.clip(i, 0, l - 2)
        w2 = w * w
        w3 = w2 * w
        return self.c0[i] + self.c1[i] * w[:, None] + self.c2[i] * w2[:, None] + self.c3[i] * w3[:, None]

    def u_to_t(self, u) -> np.ndarray:
        """Curve.getUtoTmapping(u): the arc-length table, searched and linearly interpolated."""
        u = np.asarray(u, dtype=float)
        target = u * self.arc[-1]
        il = len(self.arc)
        # the largest i with arc[i] <= target (three's bisection lands on the same i)
        i = np.searchsorted(self.arc, target, side="right") - 1
        i = np.clip(i, 0, il - 1)
        exact = self.arc[i] == target
        i2 = np.clip(i, 0, il - 2)
        before = self.arc[i2]
        after = self.arc[i2 + 1]
        seg = after - before
        with np.errstate(divide="ignore", invalid="ignore"):
            frac = np.where(seg > 0, (target - before) / np.where(seg > 0, seg, 1.0), 0.0)
        t = (i2 + frac) / (il - 1)
        return np.where(exact, i / (il - 1), t)

    def point_at(self, u) -> np.ndarray:
        return self.point(self.u_to_t(u))

    def tangent_at(self, u) -> np.ndarray:
        """Curve.getTangentAt → getTangent(t): a central difference of 1e-4 in t, normalised."""
        t = self.u_to_t(u)
        t1 = np.clip(t - 0.0001, 0.0, 1.0)
        t2 = np.clip(t + 0.0001, 0.0, 1.0)
        d = self.point(t2) - self.point(t1)
        n = np.linalg.norm(d, axis=1)
        n = np.where(n > 0, n, 1.0)
        return d / n[:, None]

    def at(self, s) -> tuple[np.ndarray, np.ndarray]:
        """scene's `atB(s)` / `spineAt(s)`: position and tangent at along-track metre s."""
        s = np.atleast_1d(np.asarray(s, dtype=float))
        u = np.clip(s / self.len, 0.0, 1.0) if self.len > 0 else np.zeros_like(s)
        return self.point_at(u), self.tangent_at(u)


class Polyline3:
    """The long-spine path (scene.ts `longSpine`): the bake's own densified points, interpolated."""

    def __init__(self, points: np.ndarray):
        p = np.asarray(points, dtype=float).reshape(-1, 3)
        self.p = p
        self.n = len(p)
        seg = np.linalg.norm(np.diff(p, axis=0), axis=1) if self.n > 1 else np.zeros(0)
        self.cum = np.concatenate([[0.0], np.cumsum(seg)])
        self.len = float(self.cum[-1]) if self.n > 1 else 0.0

    def at(self, s) -> tuple[np.ndarray, np.ndarray]:
        s = np.atleast_1d(np.asarray(s, dtype=float))
        if self.n < 2:
            return np.repeat(self.p[:1], len(s), axis=0), np.tile([1.0, 0.0, 0.0], (len(s), 1))
        t = np.clip(s, 0.0, self.len)
        lo = np.searchsorted(self.cum, t, side="left")
        lo = np.clip(lo, 1, self.n - 1)
        span = self.cum[lo] - self.cum[lo - 1]
        span = np.where(span > 0, span, 1.0)
        f = np.clip((t - self.cum[lo - 1]) / span, 0.0, 1.0)
        pos = self.p[lo - 1] + (self.p[lo] - self.p[lo - 1]) * f[:, None]
        d = self.p[lo] - self.p[lo - 1]
        n = np.linalg.norm(d, axis=1)
        flat = n * n < 1e-8
        d = np.where(flat[:, None], [[1.0, 0.0, 0.0]], d / np.where(flat, 1.0, n)[:, None])
        return pos, d


def tapered_lanes(step_lanes, length: float, taper: float, step: float = 2.0):
    """props.taperedLanes (the dense-table path): a lane count ramped over `taper` at each change."""
    n = max(2, int(np.ceil(length / step)) + 1)
    raw = np.array([float(step_lanes(i * step)) for i in range(n)])
    out = raw.copy()
    if taper > 0:
        changes = [(float((i - 0.5) * step), raw[i - 1], raw[i]) for i in range(1, n) if raw[i] != raw[i - 1]]
        for ci, (cs, c_from, c_to) in enumerate(changes):
            prev_gap = (cs - changes[ci - 1][0]) / 2 if ci > 0 else np.inf
            next_gap = (changes[ci + 1][0] - cs) / 2 if ci < len(changes) - 1 else np.inf
            h = min(taper / 2, prev_gap, next_gap)
            if not h > 0:
                continue
            i0 = max(0, int(np.floor((cs - h) / step)))
            i1 = min(n - 1, int(np.ceil((cs + h) / step)))
            for kk in range(i0, i1 + 1):
                t = min(1.0, max(0.0, (kk * step - (cs - h)) / (2 * h)))
                out[kk] = c_from + (c_to - c_from) * t

    def lanes_at(s):
        x = np.clip(np.asarray(s, dtype=float) / step, 0, n - 1)
        i = np.floor(x).astype(int)
        f = x - i
        j = np.minimum(n - 1, i + 1)
        return out[i] * (1 - f) + out[j] * f

    return lanes_at


# --- the model ---------------------------------------------------------------------------------


@dataclass
class _Road:
    """One carriageway in the station grid: its curve, its paved width and its place in `who`."""
    who: int
    curve: object
    half_at: object          # s -> half paved width
    off_at: object           # s -> asphalt centre offset to the right of the spine
    name: str = ""


@dataclass
class Stations:
    """The station field, as parallel arrays — what edgeDistance walks. Picklable for the workers."""
    x: np.ndarray = field(default_factory=lambda: np.zeros(0))
    z: np.ndarray = field(default_factory=lambda: np.zeros(0))
    dx: np.ndarray = field(default_factory=lambda: np.zeros(0))
    dz: np.ndarray = field(default_factory=lambda: np.zeros(0))
    s: np.ndarray = field(default_factory=lambda: np.zeros(0))
    half: np.ndarray = field(default_factory=lambda: np.zeros(0))
    off: np.ndarray = field(default_factory=lambda: np.zeros(0))
    who: np.ndarray = field(default_factory=lambda: np.zeros(0, dtype=int))
    y: np.ndarray = field(default_factory=lambda: np.zeros(0))       # NaN where the curve answers
    elev: np.ndarray = field(default_factory=lambda: np.zeros(0, dtype=bool))
    order: np.ndarray = field(default_factory=lambda: np.zeros(0, dtype=int))  # insertion order


def _to_world(coords) -> np.ndarray:
    """manifest [east, north, up] -> viewer world [x, y, z] = [east, up, -north] (NO lift here)."""
    a = np.asarray(coords, dtype=float).reshape(-1, 3)
    return np.column_stack([a[:, 0], a[:, 2], -a[:, 1]])


class RoadModel:
    """
    Every carriageway of a site as the viewer builds it, and the ground formula over them.

    `manifest` is the manifest-shaped dict the viewer will read (`spine`, `branches`, `siblings`,
    `intersections`, `structures`, `driveways`, `stubs`, `bbox`) — `export_site` hands it the
    `out` it is about to write, and a test hands it a few hand-built roads. `dem_up_at(x, z)` is
    the bare-earth ENU UP at viewer-world (x, z), the `heightAt` the viewer flags decks against.

    Build order is the viewer's: spine, siblings (only when there are no branches), branches,
    junction meet, stations, dead ends and bulbs, driveways. All of it resident at once — the
    world a `STREAM_LOCAL = 0` load or the editor preview holds, and the state a streamed load
    converges to.
    """

    def __init__(self, manifest: dict, dem_up_at, knobs: Knobs = DEFAULT_KNOBS):
        self.k = knobs
        self.m = manifest
        self.dem_up_at = dem_up_at
        self.junction_meet = {"junctions": 0, "warped": 0, "maxStep": 0.0, "noTarget": 0}
        self.roads: list[_Road] = []
        self._build_spine()
        self._build_siblings()
        self._build_branches()
        self._meet_junctions()
        self._build_stations()
        self._dead_ends()
        self._driveways()
        self._index()

    # --- the spine ---------------------------------------------------------------------------
    def _build_spine(self) -> None:
        k = self.k
        sp = self.m["spine"]
        raw = _to_world(sp["coords"])
        raw[:, 1] += ROAD_LIFT
        long_spine = k.STREAM_LOCAL > 0 and len(raw) > 6000
        self.spine = Polyline3(raw) if long_spine else Curve3(raw, max(200, len(raw) * 8))
        self.spine_len = self.spine.len
        segs = sp.get("segments") or []
        length_m = float(sp.get("length_m") or self.spine_len)

        def seg_at(s):
            for g in segs:
                if g["s_start"] - 0.5 <= s <= g["s_end"] + 0.5:
                    return g
            return None

        def step_lanes(s):
            tags = (seg_at(s) or {}).get("tags") or {}
            try:
                n = float(tags.get("lanes"))
            except (TypeError, ValueError):
                return 2.0
            return n if np.isfinite(n) and n > 0 else 2.0

        lanes_at = tapered_lanes(step_lanes, length_m, k.ROAD_TAPER_M)

        def two_way_at(s):
            tags = (seg_at(s) or {}).get("tags") or {}
            return two_way_of(tags.get("oneway"), tags.get("highway"))

        def kerbed_at(s):
            return is_kerbed(((seg_at(s) or {}).get("tags") or {}).get("highway"))

        # per-station, so vectorise over the loop the viewer runs anyway (one call per 5 m)
        def half_at(s):
            s = np.atleast_1d(np.asarray(s, dtype=float))
            ln = lanes_at(s)
            return np.array([paved_width(float(ln[i]), two_way_at(float(v)), kerbed_at(float(v)), k) / 2 for i, v in enumerate(s)])

        def off_at(s):
            s = np.atleast_1d(np.asarray(s, dtype=float))
            return np.array([paved_offset(two_way_at(float(v)), kerbed_at(float(v)), k) for v in s])

        self.spine_ways = {f"r{g.get('osm_id')}" for g in segs}
        self.roads.append(_Road(0, self.spine, half_at, off_at, "spine"))
        # nearestSpine: stations every 5 m, searched coarse (every 10th) then fine (±10)
        ss = np.arange(0.0, self.spine_len + 1e-9, ST_STEP)
        if len(ss) == 0 or ss[-1] > self.spine_len:
            ss = ss[ss <= self.spine_len]
        pos, _ = self.spine.at(ss)
        self._spine_st = np.column_stack([pos[:, 0], pos[:, 2], pos[:, 1], ss])  # x, z, y, s

    def nearest_spine(self, x: float, z: float) -> tuple[float, float, float, float, float]:
        """scene.nearestSpine: (x, z, y, s, dist) of the nearest 5 m spine station — the viewer's
        coarse-then-fine search, which is a heuristic, so it is reproduced rather than bettered."""
        st = self._spine_st
        d2 = (st[:, 0] - x) ** 2 + (st[:, 1] - z) ** 2
        coarse = np.arange(0, len(st), 10)
        bi = int(coarse[np.argmin(d2[coarse])])
        best = d2[bi]
        lo, hi = max(0, bi - 10), min(len(st) - 1, bi + 10)
        for i in range(lo, hi + 1):
            if d2[i] < best:
                best, bi = d2[i], i
        return float(st[bi, 0]), float(st[bi, 1]), float(st[bi, 2]), float(st[bi, 3]), float(np.sqrt(best))

    # --- siblings (the old dense-coords key; superseded by branches when there are any) --------
    def _build_siblings(self) -> None:
        self.sib_count = 0
        if self.m.get("branches"):
            return
        for sib in self.m.get("siblings") or []:
            if len(sib) < 2:
                continue
            pts = []
            for c in sib:
                x, y = float(c[0]), float(c[1])
                wz = -y
                _, _, ny, _, dist = self.nearest_spine(x, wz)
                z = ny if dist < 60 else self.dem_up_at(np.array([x]), np.array([wz]))[0] + ROAD_LIFT
                pts.append([x, z, wz])
            c2 = Curve3(np.array(pts), max(100, len(pts) * 8))
            if not c2.len > 1:
                continue
            half = paved_width(2, k=self.k) / 2
            self.roads.append(_Road(len(self.roads), c2, lambda s, h=half: np.full(len(np.atleast_1d(s)), h), lambda s: np.zeros(len(np.atleast_1d(s))), "sibling"))
            self.sib_count += 1
        self.branch_who0 = 1 + self.sib_count

    # --- branches -----------------------------------------------------------------------------
    def _build_branches(self) -> None:
        k = self.k
        self.branch_who0 = 1 + self.sib_count
        self.branches: list[dict] = []  # {br, raw (N,3) world, half, dirty}
        taken: set[str] = set()
        for br in self.m.get("branches") or []:
            coords = br.get("coords")
            if not coords or len(coords) < 2:
                continue
            c0 = coords[0]
            key = br.get("id") or f"{c0[0]},{c0[1]},{len(coords)},{br.get('name') or ''}"
            if key in taken:
                continue
            taken.add(key)
            a = np.asarray(coords, dtype=float)
            z = a[:, 2].copy()
            bad = ~np.isfinite(z)
            if bad.any():
                z[bad] = self.dem_up_at(a[bad, 0], -a[bad, 1])
            raw = np.column_stack([a[:, 0], z + ROAD_LIFT, -a[:, 1]])
            curve = Curve3(raw, max(100, len(raw) * 8))
            if not curve.len > 1:
                continue  # "a road shorter than a metre is not a road"
            lanes = branch_lanes(br.get("lanes"))
            two_way = two_way_of(br.get("oneway"), br.get("highway"))
            half = paved_width(lanes, two_way, is_kerbed(br.get("highway")), k) / 2
            self.branches.append({"br": br, "raw": raw, "curve": curve, "half": half, "dirty": False})
        for b in self.branches:
            who = len(self.roads)
            self.roads.append(_Road(who, b["curve"], lambda s, h=b["half"]: np.full(len(np.atleast_1d(s)), h), lambda s: np.zeros(len(np.atleast_1d(s))), b["br"].get("name") or b["br"].get("ref") or "branch"))

    # --- ROADS MEET AT THE SAME HEIGHT (scene.ts meetOne, run once over the whole network) -----
    def _meet_junctions(self) -> None:
        k = self.k
        MEET = k.JUNCTION_MEET_M
        by_id = {b["br"]["id"]: i for i, b in enumerate(self.branches) if b["br"].get("id")}
        x_by_node: dict = {}
        for x in ((self.m.get("intersections") or {}).get("list") or []):
            for n in x.get("nodes") or []:
                x_by_node[n] = x

        def rank(hw):
            hw = (hw or "")
            if hw.endswith("_link"):
                hw = hw[: -len("_link")]
            return RANK.get(hw, 9)

        def height_of(i, x, z):
            raw = self.branches[i]["raw"]
            d = (raw[:, 0] - x) ** 2 + (raw[:, 2] - z) ** 2
            j = int(np.argmin(d))
            return float(raw[j, 1]) if d[j] < MEET_NEAR_M * MEET_NEAR_M else np.nan

        met: set[str] = set()
        jm = self.junction_meet
        for i, b in enumerate(self.branches):
            br = b["br"]
            raw = b["raw"]
            for j in br.get("junctions") or []:
                key = f"{i}:{j.get('node') if j.get('node') is not None else j['x']},{j['y']}"
                if key in met:
                    continue
                wx, wz = float(j["x"]), -float(j["y"])
                x = x_by_node.get(j.get("node")) if j.get("node") is not None else None
                apps = (x or {}).get("approaches") or []
                mine = next((a for a in apps if a.get("road") == br.get("id")), None)
                if mine and mine.get("superior"):
                    met.add(key)
                    continue
                target = np.nan
                sup = next((a for a in apps if a.get("superior") and a.get("road") != br.get("id")), None)
                if sup and sup.get("road") in self.spine_ways:
                    target = self.nearest_spine(wx, wz)[2]
                elif sup and sup.get("road") in by_id:
                    target = height_of(by_id[sup["road"]], wx, wz)
                else:
                    ns = self.nearest_spine(wx, wz)
                    if ns[4] < 4:
                        target = ns[2]
                    else:
                        my_rank, my_len = rank(br.get("highway")), float(br.get("length_m") or 0)
                        for other in j.get("with") or []:
                            kk = by_id.get(other)
                            if kk is None or kk == i:
                                continue
                            o = self.branches[kk]["br"]
                            better = rank(o.get("highway")) < my_rank or (rank(o.get("highway")) == my_rank and float(o.get("length_m") or 0) > my_len)
                            if better:
                                target = height_of(kk, wx, wz)
                                break
                if not np.isfinite(target):
                    jm["noTarget"] += 1
                    continue
                d = (raw[:, 0] - wx) ** 2 + (raw[:, 2] - wz) ** 2
                vi = int(np.argmin(d))
                if d[vi] > MEET_NEAR_M * MEET_NEAR_M:
                    continue
                met.add(key)
                step = target - raw[vi, 1]
                jm["junctions"] += 1
                if abs(step) < 0.05:
                    continue
                jm["warped"] += 1
                jm["maxStep"] = max(jm["maxStep"], float(abs(step)))
                for direction in (-1, 1):
                    dist = 0.0
                    kk = vi
                    while 0 <= kk < len(raw):
                        if kk != vi:
                            dist += float(np.hypot(raw[kk, 0] - raw[kk - direction, 0], raw[kk, 2] - raw[kk - direction, 2]))
                        if dist > MEET:
                            break
                        if not (direction == 1 and kk == vi):
                            raw[kk, 1] += step * (1 - float(smoothstep(dist, 0.0, MEET)))
                        kk += direction
                b["dirty"] = True
        for b in self.branches:
            if b["dirty"]:
                b["curve"] = Curve3(b["raw"], max(100, len(b["raw"]) * 8))
                b["dirty"] = False
        # the recurved splines are what the station loop and edgeDistance read
        for i, b in enumerate(self.branches):
            self.roads[self.branch_who0 + i].curve = b["curve"]
        jm["maxStep"] = round(jm["maxStep"], 2)

    # --- the station field ----------------------------------------------------------------------
    def _build_stations(self) -> None:
        k = self.k
        cols: dict[str, list] = {n: [] for n in ("x", "z", "dx", "dz", "s", "half", "off", "who", "y", "elev", "dem")}
        for r in self.roads:
            ss = np.arange(0.0, r.curve.len + 1e-9, ST_STEP)
            ss = ss[ss <= r.curve.len]
            if len(ss) == 0:
                ss = np.array([0.0])
            pos, dirn = r.curve.at(ss)
            d = dirn.copy()
            d[:, 1] = 0
            n = np.linalg.norm(d, axis=1)
            d = d / np.where(n > 0, n, 1.0)[:, None]
            dem = self.dem_up_at(pos[:, 0], pos[:, 2])
            elev = (pos[:, 1] - dem) > k.OVERPASS_CLEAR_M
            cols["dem"].append(dem)
            cols["x"].append(pos[:, 0]); cols["z"].append(pos[:, 2])
            cols["dx"].append(d[:, 0]); cols["dz"].append(d[:, 2])
            cols["s"].append(ss)
            cols["half"].append(np.asarray(r.half_at(ss), dtype=float))
            cols["off"].append(np.asarray(r.off_at(ss), dtype=float))
            cols["who"].append(np.full(len(ss), r.who, dtype=int))
            cols["y"].append(pos[:, 1])
            cols["elev"].append(elev)
        dem_all = np.concatenate(cols.pop("dem")) if cols["dem"] else np.zeros(0)
        st = Stations()
        for n, arrs in cols.items():
            setattr(st, n, np.concatenate(arrs) if arrs else np.zeros(0))
        st.who = st.who.astype(int)
        st.elev = st.elev.astype(bool)
        # A DECK IS A RUN, NOT A COIN TOSS. Route 3 rides a 3 m embankment for kilometres, and
        # OVERPASS_CLEAR_M is 3 m: against the 1 m DEM the flag flips station by station along it
        # (measured 2026-10-09: the stations behind the old bake's disagreements sat 2.9–4.0 m up),
        # and the viewer's own boot-time guess flipped them differently again. Since the bake now
        # decides for both, it decides in runs — a deck is at least DECK_MIN_STATIONS long, and a
        # gap in one no longer than DECK_GAP_STATIONS is still the deck. The stations' `s` are in
        # order within a road, so this is a 1-D closing then opening along each carriageway.
        for w in np.unique(st.who):
            m = np.flatnonzero(st.who == w)
            if len(m) < 2:
                continue
            st.elev[m] = _smooth_runs(st.elev[m], DECK_GAP_STATIONS, DECK_MIN_STATIONS)
        st.order = np.arange(len(st.x))
        self.st = st
        self.road_station_count = len(st.x)
        # How far the carriageways stand off the earth, over the stations that are not decks: the
        # number `assert_grades_on_the_dem` judges, kept for the summary and the bake log. A deck
        # is excluded by definition — the question is whether the GROUND roads sit on the ground.
        # ROAD_LIFT is the formula's own (every curve is the profile + 0.4), not the grade's, so it
        # comes off first: a road exactly on its DEM reads 0 here, not 0.4.
        off = st.y - ROAD_LIFT - dem_all
        ok = np.isfinite(off) & ~st.elev
        self.grade_offset = {
            "n": int(ok.sum()),
            "median": round(float(np.median(off[ok])), 3) if ok.any() else None,
            "p90": round(float(np.percentile(np.abs(off[ok]), 90)), 3) if ok.any() else None,
            "deck_share": round(float(st.elev.mean()), 4) if len(st.elev) else 0.0,
        }

    def assert_grades_on_the_dem(self) -> dict:
        """
        Fail LOUDLY when the branch grades sit systematically off the DEM the pyramid writes.

        The deck decision above is `road - DEM > OVERPASS_CLEAR_M`, station by station. That is
        only a decision about bridges if the road and the DEM are measured against the same earth:
        a grade sampled from a different product, a different vertical datum, or — the served
        crofton-triangle of 2026-10-02 — a raw height against a curved earth, lifts every station
        by the same systematic amount, and the ones past the threshold become deck colliders the
        car rides through a suburb. The bake used to print its counts and ship that. Now the median
        offset over the non-deck stations has to be within GRADE_OFF_MAX_M, or the export stops
        here with the numbers (BakeFault reaches the job's exit status). Returns the offset block.
        """
        g = self.grade_offset
        if g["median"] is not None and abs(g["median"]) > GRADE_OFF_MAX_M:
            raise GradeFault(
                f"the carriageways stand a median {g['median']:+.2f} m off the DEM over {g['n']:,} non-deck stations "
                f"(|p90| {g['p90']:.2f} m, {100 * g['deck_share']:.1f} % of stations flagged deck; limit {GRADE_OFF_MAX_M} m): "
                f"the branch grades were not sampled from the earth this pyramid writes — a stale or differently-sourced "
                f"profile — and the decks decided against them would be wrong. Re-profile against the site's dem_1m.tif."
            )
        return g

    # --- cul-de-sacs ----------------------------------------------------------------------------
    def _dead_ends(self) -> None:
        k = self.k
        st = self.st
        x0, y0, x1, y1 = self.m.get("bbox") or (-np.inf, -np.inf, np.inf, np.inf)

        def near_bbox_edge(x, wz):
            y = -wz
            return min(x - x0, x1 - x, y - y0, y1 - y) < 60

        def junction_near(x, z, self_who):
            others = st.who != self_who
            return bool((((st.x[others] - x) ** 2 + (st.z[others] - z) ** 2) < 225).any())

        authored: dict[int, list] = {}
        de = self.m["spine"].get("dead_ends")
        if de:
            authored[0] = de
        for i, b in enumerate(self.branches):
            de = b["br"].get("dead_ends")
            if de:
                authored[self.branch_who0 + i] = de
        ends = []  # (x, z, dx, dz, who, s, radius)
        for r in self.roads:
            c = r.curve
            said = authored.get(r.who)
            if said:
                for e in said:
                    if e.get("kind") != "cul_de_sac":
                        continue
                    s = min(c.len, max(0.0, float(e["s"])))
                    pos, dirn = c.at(s)
                    sign = 1.0 if s > c.len / 2 else -1.0
                    d = np.array([dirn[0, 0], 0.0, dirn[0, 2]])
                    n = np.linalg.norm(d)
                    d = d / (n if n > 0 else 1.0) * sign
                    ends.append((pos[0, 0], pos[0, 2], d[0], d[2], r.who, s, e.get("radius_m")))
                continue
            for s, sign in ((0.0, -1.0), (c.len, 1.0)):
                pos, dirn = c.at(min(c.len, max(0.0, s)))
                d = np.array([dirn[0, 0], 0.0, dirn[0, 2]])
                n = np.linalg.norm(d)
                d = d / (n if n > 0 else 1.0) * sign
                if near_bbox_edge(pos[0, 0], pos[0, 2]) or junction_near(pos[0, 0], pos[0, 2], r.who):
                    continue
                ends.append((pos[0, 0], pos[0, 2], d[0], d[2], r.who, s, None))
        self.dead_ends = ends
        self.bulb_count = 0
        if k.CULDESAC_RADIUS <= 0 or not ends:
            return
        rows = []
        for (ex, ez, dx, dz, who, s, radius) in ends:
            r = radius if (radius is not None and radius > 0) else k.CULDESAC_RADIUS
            rows.append((ex + dx * r * 0.6, ez + dz * r * 0.6, dx, dz, s, r, 0.0, who))
        self._append_stations(rows, y=None, elev=False)
        self.bulb_count = len(rows)

    def _append_stations(self, rows, y, elev: bool) -> None:
        if not rows:
            return
        a = np.asarray(rows, dtype=float)
        st = self.st
        n0 = len(st.x)
        st.x = np.concatenate([st.x, a[:, 0]]); st.z = np.concatenate([st.z, a[:, 1]])
        st.dx = np.concatenate([st.dx, a[:, 2]]); st.dz = np.concatenate([st.dz, a[:, 3]])
        st.s = np.concatenate([st.s, a[:, 4]]); st.half = np.concatenate([st.half, a[:, 5]])
        st.off = np.concatenate([st.off, a[:, 6]]); st.who = np.concatenate([st.who, a[:, 7].astype(int)])
        st.y = np.concatenate([st.y, np.full(len(a), np.nan) if y is None else np.asarray(y, dtype=float)])
        st.elev = np.concatenate([st.elev, np.full(len(a), elev, dtype=bool)])
        st.order = np.concatenate([st.order, n0 + np.arange(len(a))])

    # --- driveways and stubs (scene.ts addDriveways, laid at load over the bare DEM) -------------
    def _driveways(self) -> None:
        ribbons = [(d.get("coords") or [], float(d.get("width_m") or 3.6), False) for d in (self.m.get("driveways") or [])]
        ribbons += [(s.get("coords") or [], max(5.5, float(s.get("lanes") or 2) * 3.1 + 0.8), True) for s in (self.m.get("stubs") or [])]
        self.driveway_count = 0
        if not ribbons:
            return
        # the flare test asks edgeDistance of the carriageways and bulbs laid so far — index them now
        self._index()
        rows, ys = [], []
        MOUTH = 11.0
        for coords, width, flare in ribbons:
            pts = _to_world(coords)
            if len(pts) < 2:
                continue
            half = max(1.2, width / 2)
            ends = np.array([[pts[0, 0], pts[0, 2]], [pts[-1, 0], pts[-1, 2]]])
            e = self.edge_distance(ends[:, 0], ends[:, 1], grade=False)
            flare_at = -1 if not flare else (0 if e["d"][0] <= e["d"][1] else len(pts) - 1)
            run = np.concatenate([[0.0], np.cumsum(np.hypot(np.diff(pts[:, 0]), np.diff(pts[:, 2])))])
            total = run[-1]
            # THE BAKE'S OWN z, not a fresh sample. `_service_ways` / `_stub_roads` wrote each point's
            # height from the 1 m DEM, and that number is in the manifest; the viewer on a graded
            # bake lays its driveway stations on it too (scene.ts addDriveways), so the formula
            # and the raster agree to the count. The viewer used to lay them on whatever earth it
            # held at boot — the 8 m overview for most of a site — and a stub on Route 3 landed
            # 3.5 m above the ground it stands on, with a 40 m verge graded up to it (measured,
            # 2026-10-09: 546 of the 743 points over 10 cm were that). A point with no z falls
            # back to the DEM, as the viewer's `?? pt.y` intends.
            z_own = pts[:, 1]
            g = np.where(np.isfinite(z_own), z_own, self.dem_up_at(pts[:, 0], pts[:, 2])) + 0.03
            for i in range(len(pts)):
                a = pts[max(0, i - 1)]
                b = pts[min(len(pts) - 1, i + 1)]
                dx, dz = b[0] - a[0], b[2] - a[2]
                n = float(np.hypot(dx, dz))
                if n < 1e-6:
                    # A STATION WITH NO DIRECTION IS A 160 m PLATEAU. Two coincident shape points
                    # gave the station between them a (0, 0) tangent; then `along` is 0 for every
                    # point in the 7x7 walk, every point is "in the band", `lat` is 0 and d is
                    # -half up to 80 m away — one stub on Lavender Cliff Way graded 3.5 m of
                    # ground over the fields beside Route 3 (measured 2026-10-09). The direction
                    # comes from the nearest distinct point instead; a ribbon with none is a dot.
                    dist = np.hypot(pts[:, 0] - pts[i, 0], pts[:, 2] - pts[i, 2])
                    dist[i] = np.inf
                    j = int(np.argmin(dist))
                    if not np.isfinite(dist[j]) or dist[j] < 1e-6:
                        continue
                    sign = 1.0 if j > i else -1.0
                    dx, dz = (pts[j, 0] - pts[i, 0]) * sign, (pts[j, 2] - pts[i, 2]) * sign
                    n = float(np.hypot(dx, dz))
                if flare_at < 0:
                    hw = half
                else:
                    dd = run[i] if flare_at == 0 else total - run[i]
                    if dd >= MOUTH:
                        hw = half
                    else:
                        f = 1 - dd / MOUTH
                        hw = half + f * f * half * 1.5
                rows.append((pts[i, 0], pts[i, 2], dx / n, dz / n, 0.0, hw + 0.4, 0.0, WHO_DRIVEWAY))
                ys.append(g[i])
        self._append_stations(rows, y=np.asarray(ys), elev=False)
        self.driveway_count = len(rows)

    # --- the index ------------------------------------------------------------------------------
    def _index(self) -> None:
        from scipy.spatial import cKDTree

        st = self.st
        self.tree = cKDTree(np.column_stack([st.x, st.z])) if len(st.x) else None
        self.max_half = float(st.half.max()) if len(st.half) else 0.0
        # what edgeDistance reads per carriageway: the (re)curved spline, by `who`
        self.curves = [r.curve for r in self.roads]
        self.road_count = len(self.roads)
        # bridges on the primary: the strip's verge stops at the parapet across them
        self.bridges = [(float(b["s_start"]), float(b["s_end"])) for b in (self.m.get("structures") or []) if b.get("kind") == "bridge"]

    def strip_edge_limit_at(self, s) -> np.ndarray:
        """scene.stripEdgeLimitAt: VERGE, narrowing to the parapet across a bridge of the primary."""
        s = np.asarray(s, dtype=float)
        lim = np.full(s.shape, VERGE)
        for s0, s1 in self.bridges:
            on = np.minimum(smoothstep(s, s0 - BRIDGE_TAPER, s0), 1 - smoothstep(s, s1, s1 + BRIDGE_TAPER))
            lim = np.where(on > 0, np.minimum(lim, PARAPET + (VERGE - PARAPET) * (1 - on)), lim)
        return lim

    # --- edgeDistance ---------------------------------------------------------------------------
    def edge_distance(self, x, z, grade: bool = False, roads_only: bool = False, pair_budget: int = 2_000_000) -> dict:
        """
        scene.edgeDistance over arrays: signed distance to the nearest pavement edge, which
        carriageway, the road height there and the along-track metre.

        The viewer walks the 7 × 7 station cells about the point; here the candidates come from a
        KD-tree ball query and are then cut to that same 7 × 7 walk, so a station the viewer never
        sees is never a candidate here either. Inside a station's ±EDGE_BAND_M along-track band
        the distance is lateral to its tangent; outside, radial from the station — "what makes a
        lone station a disc and gives cul-de-sac bulbs their shape for free". Ties go the way the
        viewer's loop order would take them: walk cell, then insertion.

        `d` is +inf where nothing answers (the viewer's `best = Infinity`). `who` is -1 there.
        """
        x = np.asarray(x, dtype=float).ravel()
        z = np.asarray(z, dtype=float).ravel()
        n = len(x)
        k = self.k
        out = {"d": np.full(n, np.inf), "who": np.full(n, -1, dtype=int), "y": np.zeros(n), "s": np.zeros(n), "along": np.zeros(n)}
        if self.tree is None or n == 0:
            return out
        st = self.st
        pts = np.column_stack([x, z])
        # a station outside the 7x7 walk is at least 3 cells (60 m) away; nothing beyond
        # 4 cells (80 m) can be in it. Prune further by the best possible d: the nearest station
        # by centre distance gives d <= dist_q; a candidate needs dist_p - band - half_p <= dist_q.
        dist_q, _ = self.tree.query(pts)
        radius = np.minimum(dist_q + k.EDGE_BAND_M + self.max_half + 1e-6, 4 * ST_CELL * np.sqrt(2) + 1e-6)
        cx = np.floor(x / ST_CELL)
        cz = np.floor(z / ST_CELL)
        scx = np.floor(st.x / ST_CELL)
        scz = np.floor(st.z / ST_CELL)
        # chunked, so the pair arrays stay bounded whatever the block holds
        start = 0
        while start < n:
            # grow the chunk until its pairs would exceed the budget (estimated from the radius)
            end = start
            est = 0
            while end < n and (est < pair_budget or end == start):
                est += int(3 + (radius[end] ** 2) * 0.05)
                end += 1
            lists = self.tree.query_ball_point(pts[start:end], radius[start:end])
            counts = np.fromiter((len(l) for l in lists), dtype=int, count=end - start)
            if counts.sum() == 0:
                start = end
                continue
            qi = np.repeat(np.arange(start, end), counts)
            si = np.concatenate([np.asarray(l, dtype=int) for l in lists if len(l)])
            # the viewer's walk: 7x7 cells about the point
            a = (scx[si] - cx[qi]).astype(int)
            b = (scz[si] - cz[qi]).astype(int)
            keep = (np.abs(a) <= 3) & (np.abs(b) <= 3)
            if grade:
                keep &= ~st.elev[si]
            if roads_only:
                keep &= st.who[si] >= 0
            qi, si, a, b = qi[keep], si[keep], a[keep], b[keep]
            if len(qi):
                ux = x[qi] - st.x[si]
                uz = z[qi] - st.z[si]
                along = ux * st.dx[si] + uz * st.dz[si]
                lat = np.abs(uz * st.dx[si] - ux * st.dz[si] - st.off[si])
                in_band = np.abs(along) <= k.EDGE_BAND_M
                d = np.where(in_band, lat, np.hypot(ux, uz)) - st.half[si]
                walk = (a + 3) * 7 + (b + 3)
                order = np.lexsort((st.order[si], walk, d, qi))
                qi_s = qi[order]
                first = np.concatenate([[True], qi_s[1:] != qi_s[:-1]])
                win = order[first]
                q = qi[win]
                out["d"][q] = d[win]
                out["who"][q] = st.who[si[win]]
                out["along"][q] = along[win]
                out["s"][q] = st.s[si[win]]
                out["y"][q] = st.y[si[win]]
                self._road_heights(out, q, si[win], along[win])
            start = end
        return out

    def _road_heights(self, out: dict, q: np.ndarray, si: np.ndarray, along: np.ndarray) -> None:
        """The road height HERE: the carriageway spline at the projected along-track metre."""
        st = self.st
        who = st.who[si]
        for w in np.unique(who):
            if w < 0:
                continue  # a driveway carries its own height
            m = who == w
            c = self.curves[int(w)]
            s_on = np.clip(st.s[si[m]] + along[m], 0.0, c.len)
            pos, _ = c.at(s_on)
            out["y"][q[m]] = pos[:, 1]
            out["s"][q[m]] = s_on

    # --- THE GROUND IS A FORMULA (scene.gradedHeight) ------------------------------------------
    def graded_height(self, x, z, dem_up, grade: bool = True) -> np.ndarray:
        """
        scene.gradedHeight over arrays: the ground under and beside every carriageway, NaN where the
        viewer answers null and the caller falls back to the DEM. `dem_up` is the bare-earth ENU
        up at each point (the viewer's `heightAt(x, -z)`). `grade=True` is the physics ground: an
        elevated carriageway is not a candidate at all, so the point under an overpass grades to
        the road below or the DEM.
        """
        k = self.k
        x = np.asarray(x, dtype=float).ravel()
        z = np.asarray(z, dtype=float).ravel()
        dem = np.asarray(dem_up, dtype=float).ravel()
        e = self.edge_distance(x, z, grade=grade)
        d, who, y, s = e["d"], e["who"], e["y"], e["s"]
        out = np.full(len(x), np.nan)
        hit = np.isfinite(d)
        primary = who < self.branch_who0
        ok = hit & (d <= np.where(primary, VERGE, k.BRANCH_VERGE))
        lim = self.strip_edge_limit_at(s)
        ok &= ~(primary & (d > lim))
        # ... and the spine's ground must not climb to a crossing BRANCH's deck
        ok &= ~(~primary & (d > BLEND_LO) & ((y - dem) > k.OVERPASS_CLEAR_M))
        t = smoothstep(d, BLEND_LO, BLEND_HI)
        ramp = np.where(primary, 0.6, 2.4)
        lift = np.where(d > 0, k.GRASS_LIFT_M * np.minimum(1.0, d / ramp), 0.0)
        road = y - SURFACE_DROP
        val = np.where(d < BLEND_LO, road, road * (1 - t) + dem * t) + lift
        out[ok] = val[ok]
        return out

    # --- what the bake decided is a deck ------------------------------------------------------
    def deck_runs(self) -> dict[int, list[list[float]]]:
        """Per carriageway (`who`), the along-track runs `[s0, s1]` of stations the grading
        treated as ELEVATED — a deck, not ground — measured against the 1 m DEM."""
        st = self.st
        out: dict[int, list[list[float]]] = {}
        n = self.road_station_count
        who = st.who[:n]
        for w in np.unique(who):
            m = who == w
            ss = st.s[:n][m]
            el = st.elev[:n][m]
            order = np.argsort(ss)
            ss, el = ss[order], el[order]
            runs: list[list[float]] = []
            start = None
            prev = None
            for sv, ev in zip(ss, el):
                if ev and start is None:
                    start = sv
                if not ev and start is not None:
                    runs.append([round(float(start), 1), round(float(prev), 1)])
                    start = None
                prev = sv
            if start is not None:
                runs.append([round(float(start), 1), round(float(prev), 1)])
            if runs:
                out[int(w)] = runs
        return out

    def annotate_decks(self, manifest: dict) -> int:
        """
        Write the deck runs INTO the manifest the viewer will read: `spine.elev_s` and each
        branch's `elev_s`, as `[[s0, s1], ...]` in the road's own station metres.

        The viewer used to decide "is this station up in the air?" at boot against whatever earth
        it held — the 8 m overview or a z10 tile for everything but the home kilometre — and the
        physics ground, the deck colliders and the strips all followed that one guess. On a
        graded bake the raster under an elevated station is the EARTH (the bake skipped it), so
        the viewer's guess and the bake's decision have to be the same decision or a bridge
        approach has ground under it in neither: the raster says earth, the deck collider says
        "not a deck". This is the bake saying which, from the 1 m DEM, once. Returns the count.
        """
        runs = self.deck_runs()
        n = 0
        if 0 in runs:
            manifest["spine"]["elev_s"] = runs[0]
            n += len(runs[0])
        for i, b in enumerate(self.branches):
            r = runs.get(self.branch_who0 + i, [])
            b["br"]["elev_s"] = r
            n += len(r)
        return n

    def __getstate__(self) -> dict:
        """Picklable for the pyramid workers (forkserver hands the model over through `initargs`):
        the station field, the index and the curves. The build-time closures, the manifest and
        the DEM sampler stay behind — a worker only ever asks `graded_height`."""
        d = dict(self.__dict__)
        for key in ("roads", "dem_up_at", "m", "_spine_st", "branches", "spine"):
            d.pop(key, None)
        return d

    def summary(self) -> dict:
        return {
            "roads": self.road_count,
            "branches": len(self.branches),
            "stations": int(self.road_station_count),
            "bulbs": int(self.bulb_count),
            "driveway_stations": int(self.driveway_count),
            "junctions": dict(self.junction_meet),
            "grade_offset": dict(self.grade_offset),
        }


# --- a raster block ----------------------------------------------------------------------------


def grade_block(model: RoadModel, corner_enu: np.ndarray, h: np.ndarray, grade: bool = True) -> tuple[np.ndarray, np.ndarray]:
    """
    Grade one quadtree tile's height raster IN PLACE OF the viewer's formula.

    `corner_enu` is (4, 3): the tile's corners' ENU [east, north, up-at-h=0] in the lattice order
    `latticeFor` emits — SW, SE, NW, NE. `h` is the (rows, cols) raster of geodetic heights as
    `_encode_height` will store it, row 0 at the NORTH edge. Returns `(h_graded, touched)`: the
    heights to write, and the boolean mask of pixels the formula answered — every other pixel is
    returned bit-for-bit as it came in, so a point beyond the verge reads exactly what it did.

    The pixel's position and its ellipsoid drop are the VIEWER'S: a bilinear patch on the four
    corners (`RasterFrame.patch` / `toEnuUp`), evaluated at the pixel centre `u = (j + 0.5) / cols`,
    `v = (i + 0.5) / rows` — `toGrid` inverts that patch, and `bilinear` reads the pixel centre, so
    this is the point the viewer believes the pixel to be at.
    """
    h = np.asarray(h, dtype=np.float32)
    rows, cols = h.shape
    c = np.asarray(corner_enu, dtype=float).reshape(4, 3)
    sw, se, nw, ne = c
    u = (np.arange(cols) + 0.5) / cols
    v = (np.arange(rows) + 0.5) / rows
    U, V = np.meshgrid(u, v)  # (rows, cols)
    # patch(u, v): tv = 1 - v weights the NORTH row (lattice rows run south to north)
    tv = 1.0 - V
    south = (1 - U)[..., None] * sw + U[..., None] * se
    north = (1 - U)[..., None] * nw + U[..., None] * ne
    enu = (1 - tv)[..., None] * south + tv[..., None] * north  # (rows, cols, 3)
    east, nrth, drop = enu[..., 0], enu[..., 1], enu[..., 2]
    x = east.ravel()
    z = -nrth.ravel()
    dem_up = (drop.ravel() + h.ravel().astype(float))
    g = model.graded_height(x, z, dem_up, grade=grade)
    touched = np.isfinite(g)
    out = h.copy()
    out.ravel()[touched] = (g[touched] - drop.ravel()[touched]).astype(np.float32)
    return out, touched.reshape(rows, cols)


def corner_enu_for(anchor, w: float, s: float, e: float, n: float) -> np.ndarray:
    """The four lattice corners (SW, SE, NW, NE) of a WGS84 tile as ENU [east, north, up at h=0]."""
    lon = np.array([w, e, w, e], dtype=float)
    lat = np.array([s, s, n, n], dtype=float)
    ee, nn, uu = anchor.to_local(lon, lat, 0.0)
    return np.column_stack([np.asarray(ee), np.asarray(nn), np.asarray(uu)])


# --- the bare earth the bake grades against -----------------------------------------------------


def enu_to_utm(frame, e, n, iterations: int = 3) -> tuple[np.ndarray, np.ndarray]:
    """
    ENU metres about the site anchor -> UTM easting/northing, the inverse of `Frame.to_enu`.

    `Frame` only goes forward (the viewer never needs the inverse; the bake stores UTM). Over one
    site the forward map is an affine to a few decimetres (FRAME.md: 0.34 m at 25 km on axis), so
    the inverse is that affine, fitted from four probes, refined by fixed-point steps on the exact
    forward map. Three steps are millimetres anywhere a site reaches.
    """
    e = np.asarray(e, dtype=float).ravel()
    n = np.asarray(n, dtype=float).ravel()
    ox, oy = frame.origin
    span = 2000.0
    probes = np.array([[span, 0.0], [-span, 0.0], [0.0, span], [0.0, -span]])
    pe, pn = frame.to_enu(ox + probes[:, 0], oy + probes[:, 1])
    enu = np.column_stack([np.asarray(pe), np.asarray(pn)])
    A, *_ = np.linalg.lstsq(probes, enu, rcond=None)  # enu ≈ utm_offset @ A
    Ainv = np.linalg.inv(A)
    target = np.column_stack([e, n])
    utm = target @ Ainv + np.array([ox, oy])
    for _ in range(iterations):
        ce, cn = frame.to_enu(utm[:, 0], utm[:, 1])
        r = target - np.column_stack([np.asarray(ce), np.asarray(cn)])
        utm = utm + r @ Ainv
    return utm[:, 0], utm[:, 1]


def site_dem_up(frame, dem_path, nodata: float = -9000.0):
    """
    A `dem_up_at(x, z)` for `RoadModel`: the bare-earth ENU UP under viewer-world (x, z) from the
    site's 1 m DEM — geodetic height plus the ellipsoid drop at that point, which is what the
    viewer's `heightAt` answers (`RasterFrame.toEnuUp`). Points off the raster get NaN, which no
    deck test fires on.
    """
    import rasterio

    dem_path = str(dem_path)
    anchor = frame.anchor_frame()

    def at(x, z):
        x = np.asarray(x, dtype=float).ravel()
        z = np.asarray(z, dtype=float).ravel()
        if len(x) == 0:
            return np.zeros(0)
        ux, uy = enu_to_utm(frame, x, -z)
        lon, lat = frame.to_wgs(ux, uy)
        _, _, drop = anchor.to_local(np.asarray(lon), np.asarray(lat), 0.0)
        with rasterio.open(dem_path) as src:
            h = np.fromiter((float(v[0]) for v in src.sample(np.column_stack([ux, uy]))), dtype=float, count=len(x))
        h[h <= nodata] = np.nan
        return h + np.asarray(drop)

    return at
