"""grade.py: the viewer's ground formula, ported to the bake.

Four synthetic worlds pin the four things the formula has to do — grade the pavement to the road
and blend to the DEM across the verge, leave a deck alone, meet an inferior road to the superior
one at a junction, and give a dead end its bulb — plus the Catmull-Rom port against values three.js
itself computed (scratch: a node one-liner over `new THREE.CatmullRomCurve3(pts, false,
'centripetal')`, embedded below), because every road height goes through that spline and a
polyline would be 25 cm off on a bend.

    tools/corridor/.venv/bin/python -m pytest tools/corridor/tests/test_grade.py
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from corridor import grade  # noqa: E402

# --- three.js reference ------------------------------------------------------------------------

THREE_PTS = [[0, 10.4, 0], [10, 10.6, -1], [20, 10.9, -3.5], [31, 11.0, -7], [40, 11.4, -12], [52, 11.3, -14], [60, 11.0, -15.5], [75, 10.2, -16]]
THREE_LEN = 77.62083789087303
# [s, x, y, z, tx, ty, tz] from getPointAt(s / len) / getTangentAt(s / len), arcLengthDivisions = 100
THREE_SAMPLES = [
    [0, 0, 10.4, 0, 0.9948453452613375, 0.019893493542239224, -0.09943333408135858],
    [5, 4.982444039449298, 10.493548995823648, -0.4067461294648794, 0.9965250695692366, 0.01869816807644519, -0.08116750723419552],
    [10, 9.944146732333332, 10.598610347232004, -0.990325862013438, 0.9851719724162766, 0.02445680594065954, -0.16981769462751506],
    [17.3, 17.043882765735365, 10.823691277408985, -2.6640734330807487, 0.9630245966029105, 0.02963739301834266, -0.2677783622193509],
    [25, 24.45438739568479, 10.940168652867106, -4.751904878924433, 0.9606262476531793, 0.0028344471788579, -0.27782940490337465],
    [33.3, 32.2364181462681, 11.04144132140658, -7.598931299470222, 0.8814662612827331, 0.03582002826217192, -0.4708865636175424],
    [50, 47.60168322028803, 11.38310325417803, -13.42332878110246, 0.9934830275430209, -0.01438159131803898, -0.11306919923265818],
    [64.9, 62.30015973282471, 10.889013971328962, -15.69048746792198, 0.9968875993671734, -0.05034984648873435, -0.06066306278547726],
    [77.61083789087303, 74.99011968758397, 10.200526992957677, -15.999671074568532, 0.9980304830535832, -0.05323723722220352, -0.03318058873465079],
    [77.62083789087303, 75, 10.2, -16.000000000000004, 0.998029315350728, -0.053232842285407, -0.033222736232498135],
]


class CurvePortTest(unittest.TestCase):
    def test_matches_three_catmull_rom_to_the_micron(self):
        c = grade.Curve3(np.array(THREE_PTS, dtype=float), max(100, len(THREE_PTS) * 8))
        self.assertAlmostEqual(c.len, THREE_LEN, places=9)
        ss = np.array([r[0] for r in THREE_SAMPLES])
        pos, tan = c.at(ss)
        ref = np.array(THREE_SAMPLES)
        np.testing.assert_allclose(pos, ref[:, 1:4], atol=1e-9)
        np.testing.assert_allclose(tan, ref[:, 4:7], atol=1e-7)


# --- synthetic worlds ----------------------------------------------------------------------------

ROAD_Z = 10.0
LANES2_TWOWAY_HALF = (2 * 3.66 + 3.0 + 3.0) / 2  # a two-way primary: 6.33 m to the pavement edge
RES_HALF = (2 * 3.66 + 2 * 0.3) / 2             # a kerbed residential street: 3.96 m


def spine_east(x0=0.0, x1=600.0, z=ROAD_Z, highway="primary", lanes="2", osm_id=123):
    """A straight primary along +x (east) at y = 0, every 10 m, the bake's own densification."""
    xs = np.arange(x0, x1 + 1e-9, 10.0)
    return {
        "coords": [[float(x), 0.0, z] for x in xs],
        "photo_s": (x1 - x0) / 2,
        "length_m": float(x1 - x0),
        "segments": [{"osm_id": osm_id, "s_start": 0.0, "s_end": float(x1 - x0), "tags": {"highway": highway, "lanes": lanes}}],
    }


def slope_dem(north_slope=0.1, base=ROAD_Z):
    """The bare earth: `base` under the road, rising to the north at `north_slope` m/m."""
    def at(x, z):
        x = np.asarray(x, dtype=float)
        z = np.asarray(z, dtype=float)
        return base + north_slope * (-z)
    return at


def world(spine, branches=(), intersections=None, bbox=None, structures=(), driveways=()):
    xs = [c[0] for c in spine["coords"]]
    return {
        "spine": spine,
        "siblings": [],
        "branches": list(branches),
        "intersections": {"list": list(intersections or [])},
        "structures": list(structures),
        "driveways": list(driveways),
        "stubs": [],
        # tight to the spine's ends by default, so the ends are "where we clipped the corridor"
        # and not dead ends with bulbs of their own
        "bbox": bbox or [min(xs) - 10, -400.0, max(xs) + 10, 400.0],
    }


class StraightRoadOnASlopeTest(unittest.TestCase):
    """The pavement is the road, the verge blends to the DEM over 0.6–7 m, past VERGE it is NaN."""

    def setUp(self):
        self.dem = slope_dem(0.1)
        self.model = grade.RoadModel(world(spine_east()), self.dem)

    def ground(self, x, north):
        z = -np.asarray(north, dtype=float)
        x = np.full_like(z, x)
        return self.model.graded_height(x, z, self.dem(x, z))

    def test_the_pavement_is_the_road_minus_two_centimetres(self):
        # the spline is the road + 0.4; the ground under the pavement is that - 0.02
        g = self.ground(300.0, [0.0, 3.0, -3.0, LANES2_TWOWAY_HALF - 0.1, -(LANES2_TWOWAY_HALF - 0.1)])
        np.testing.assert_allclose(g, ROAD_Z + grade.ROAD_LIFT - grade.SURFACE_DROP, atol=1e-6)

    def test_the_verge_blends_to_the_dem_and_reaches_it_at_seven_metres(self):
        edge = LANES2_TWOWAY_HALF
        road = ROAD_Z + grade.ROAD_LIFT - grade.SURFACE_DROP
        # just past the edge, inside 0.6 m: still the road
        self.assertAlmostEqual(float(self.ground(300.0, [edge + 0.5])[0]), road, places=6)
        # at d = 7 the blend is complete: the DEM, exactly
        n7 = edge + 7.0
        self.assertAlmostEqual(float(self.ground(300.0, [n7])[0]), float(self.dem(300.0, -n7)), places=6)
        # at d = 3.8 (the middle of the band) it is the smoothstep mix of the two
        n = edge + 3.8
        t = float(grade.smoothstep(3.8, 0.6, 7.0))
        want = road * (1 - t) + float(self.dem(300.0, -n)) * t
        self.assertAlmostEqual(float(self.ground(300.0, [n])[0]), want, places=6)
        # and it is monotone between: the ground climbs the slope, never dips
        ns = edge + np.linspace(0.6, 7.0, 30)
        g = self.ground(300.0, ns)
        self.assertTrue(np.all(np.diff(g) >= -1e-9))

    def test_beyond_the_verge_the_formula_answers_nothing(self):
        g = self.ground(300.0, [LANES2_TWOWAY_HALF + grade.VERGE + 0.5, -(LANES2_TWOWAY_HALF + grade.VERGE + 0.5), 200.0])
        self.assertTrue(np.all(np.isnan(g)))
        # ... and just inside it, it answers the DEM (the blend finished 33 m ago)
        n = LANES2_TWOWAY_HALF + grade.VERGE - 0.5
        self.assertAlmostEqual(float(self.ground(300.0, [n])[0]), float(self.dem(300.0, -n)), places=6)

    def test_a_block_round_trips_the_untouched_pixels_bit_for_bit(self):
        # grade_block: pixels the formula never answered come back exactly as they went in
        rows = cols = 64
        # a flat 'tile' 200 m across, corners as ENU [e, n, up-drop]; drop 0 keeps the test readable
        corners = np.array([[200.0, -100.0, 0.0], [400.0, -100.0, 0.0], [200.0, 100.0, 0.0], [400.0, 100.0, 0.0]])
        u = (np.arange(cols) + 0.5) / cols
        v = (np.arange(rows) + 0.5) / rows
        E = 200.0 + 200.0 * u[None, :]
        N = 100.0 - 200.0 * v[:, None]
        h = (ROAD_Z + 0.1 * N + 0 * E).astype(np.float32)
        out, touched = grade.grade_block(self.model, corners, h)
        self.assertTrue(touched.any())
        self.assertTrue(np.array_equal(out[~touched], h[~touched]))
        # the row through the road is the road height
        row = np.argmin(np.abs(N[:, 0]))
        np.testing.assert_allclose(out[row, :], ROAD_Z + grade.ROAD_LIFT - grade.SURFACE_DROP, atol=1e-5)
        # the north edge (100 m off) is beyond the verge: untouched
        self.assertFalse(touched[0].any())


class DeckTest(unittest.TestCase):
    """A carriageway standing more than OVERPASS_CLEAR_M above the earth is a deck, not ground."""

    def test_the_physics_ground_under_a_deck_is_the_bare_earth(self):
        dem = slope_dem(0.0, base=ROAD_Z - 8.0)  # the valley floor, 8 m below the road
        model = grade.RoadModel(world(spine_east()), dem)
        self.assertTrue(model.st.elev.all())
        x = np.full(5, 300.0)
        z = np.array([0.0, 3.0, 8.0, 20.0, 50.0])
        g = model.graded_height(x, z, dem(x, z), grade=True)
        self.assertTrue(np.all(np.isnan(g)))  # the raster keeps the earth; the deck is a collider
        # the strip's (non-grade) view still follows the deck on the pavement
        g2 = model.graded_height(x[:1], z[:1], dem(x[:1], z[:1]), grade=False)
        self.assertAlmostEqual(float(g2[0]), ROAD_Z + grade.ROAD_LIFT - grade.SURFACE_DROP, places=6)

    def test_the_bake_writes_its_deck_decision_into_the_manifest(self):
        dem = slope_dem(0.0, base=ROAD_Z - 8.0)
        br = {"id": "b1", "highway": "residential", "lanes": 2, "oneway": None, "length_m": 300.0,
              "coords": [[300.0, float(y), ROAD_Z + (0.0 if abs(y) < 60 else -8.0)] for y in np.arange(-150.0, 150.1, 10.0)],
              "junctions": [], "dead_ends": []}
        w = world(spine_east(), branches=[br], bbox=[-10, -160, 610, 160])
        model = grade.RoadModel(w, dem)
        n = model.annotate_decks(w)
        self.assertGreater(n, 0)
        # the whole spine stands 8 m up: one run, the full length
        self.assertEqual(len(w["spine"]["elev_s"]), 1)
        self.assertAlmostEqual(w["spine"]["elev_s"][0][0], 0.0)
        self.assertGreater(w["spine"]["elev_s"][0][1], 590.0)
        # the branch is up only over its middle 120 m: one run, about that long
        runs = w["branches"][0]["elev_s"]
        self.assertEqual(len(runs), 1)
        self.assertGreater(runs[0][1] - runs[0][0], 90.0)
        self.assertLess(runs[0][1] - runs[0][0], 140.0)

    def test_a_branch_verge_does_not_climb_onto_a_crossing_deck(self):
        # a residential branch running north over a valley: on its deck the pavement is kept and
        # the verge beside it drops to the DEM
        dem = slope_dem(0.0, base=ROAD_Z - 8.0)
        br = {"id": "b1", "highway": "residential", "lanes": 2, "oneway": None, "length_m": 300.0,
              "coords": [[300.0, float(y), ROAD_Z] for y in np.arange(-150.0, 150.1, 10.0)], "junctions": [], "dead_ends": []}
        model = grade.RoadModel(world(spine_east(z=ROAD_Z - 8.0), branches=[br], bbox=[-10, -160, 610, 160]), dem)
        x = np.array([300.0, 300.0 + RES_HALF + 2.0])
        z = np.array([-80.0, -80.0])
        g = model.graded_height(x, z, dem(x, z), grade=False)
        self.assertAlmostEqual(float(g[0]), ROAD_Z + grade.ROAD_LIFT - grade.SURFACE_DROP, places=6)
        self.assertTrue(np.isnan(g[1]))


class JunctionMeetTest(unittest.TestCase):
    """An inferior road is re-graded to meet the superior one, fading out over JUNCTION_MEET_M."""

    def setUp(self):
        self.dem = slope_dem(0.0)
        ys = np.arange(-150.0, 150.1, 10.0)
        self.branch = {
            "id": "b1", "highway": "residential", "lanes": 2, "oneway": None, "length_m": 300.0, "name": "Side St",
            "coords": [[300.0, float(y), ROAD_Z + 2.0] for y in ys],  # two metres above the primary
            "junctions": [{"node": 7, "x": 300.0, "y": 0.0, "s": 150.0, "with": ["Main"], "z": ROAD_Z + 2.0}],
            "dead_ends": [],
        }
        self.x = [{"id": "x7", "nodes": [7], "x": 300.0, "y": 0.0, "approaches": [
            {"road": "r123", "superior": True}, {"road": "b1", "superior": False},
        ]}]

    def test_the_branch_meets_the_spine_and_recovers_over_forty_metres(self):
        model = grade.RoadModel(world(spine_east(), branches=[self.branch], intersections=self.x, bbox=[-10, -160, 610, 160]), self.dem)
        jm = model.junction_meet
        self.assertEqual(jm["junctions"], 1)
        self.assertEqual(jm["warped"], 1)
        self.assertAlmostEqual(jm["maxStep"], 2.0, places=2)
        road = ROAD_Z + grade.ROAD_LIFT - grade.SURFACE_DROP
        # on the branch 60 m north of the node: its own grade, untouched
        g = model.graded_height([300.0], [-60.0], self.dem(300.0, -60.0))
        self.assertAlmostEqual(float(g[0]), road + 2.0, places=3)
        # at the node: the spine's height (both roads answer it now)
        g = model.graded_height([300.0], [0.0], self.dem(300.0, 0.0))
        self.assertAlmostEqual(float(g[0]), road, places=3)
        # 20 m along: half the step, as smoothstep(20, 0, 40) = 0.5 says
        g = model.graded_height([300.0], [-20.0], self.dem(300.0, -20.0))
        self.assertAlmostEqual(float(g[0]), road + 1.0, delta=0.03)

    def test_a_superior_branch_keeps_its_grade(self):
        x = [{"id": "x7", "nodes": [7], "x": 300.0, "y": 0.0, "approaches": [{"road": "r123", "superior": False}, {"road": "b1", "superior": True}]}]
        model = grade.RoadModel(world(spine_east(), branches=[self.branch], intersections=x, bbox=[-10, -160, 610, 160]), self.dem)
        self.assertEqual(model.junction_meet["warped"], 0)
        g = model.graded_height([300.0], [-20.0], self.dem(300.0, -20.0))
        self.assertAlmostEqual(float(g[0]), ROAD_Z + 2.0 + grade.ROAD_LIFT - grade.SURFACE_DROP, places=3)


class CulDeSacTest(unittest.TestCase):
    """A dead end gets a bulb: one station, radius 9, just beyond the last metre of pavement."""

    def setUp(self):
        self.dem = slope_dem(0.0)
        ys = np.arange(100.0, 300.1, 10.0)
        self.branch = {
            "id": "b1", "highway": "residential", "lanes": 2, "oneway": None, "length_m": 200.0,
            "coords": [[300.0, float(y), ROAD_Z + 1.0] for y in ys],
            "junctions": [], "dead_ends": [{"s": 200.0, "kind": "cul_de_sac", "radius_m": 9.0}],
        }

    def test_the_bulb_is_pavement_and_its_rim_blends_out(self):
        model = grade.RoadModel(world(spine_east(), branches=[self.branch], bbox=[-10, -400, 610, 400]), self.dem)
        self.assertEqual(model.bulb_count, 1)
        # the bulb centre sits 0.6 r past the end, north of y = 300
        b = model.st.who == model.branch_who0
        bulb = np.isnan(model.st.y) & b
        self.assertEqual(int(bulb.sum()), 1)
        bx, bz, br = float(model.st.x[bulb][0]), float(model.st.z[bulb][0]), float(model.st.half[bulb][0])
        self.assertAlmostEqual(bz, -(300.0 + 0.6 * 9.0), places=2)
        self.assertAlmostEqual(br, 9.0)
        road = ROAD_Z + 1.0 + grade.ROAD_LIFT - grade.SURFACE_DROP
        # 7 m east of the bulb centre is well past the street's 3.96 m half width, and still pavement
        g = model.graded_height([bx + 7.0], [bz], self.dem(bx + 7.0, bz))
        self.assertAlmostEqual(float(g[0]), road, places=3)
        # 9.3 m out is the rim: still the road (d < 0.6); 14 m out is in the blend
        g = model.graded_height([bx + 9.3, bx + 14.0], [bz, bz], self.dem([bx + 9.3, bx + 14.0], [bz, bz]))
        self.assertAlmostEqual(float(g[0]), road, places=3)
        t = float(grade.smoothstep(5.0, 0.6, 7.0))
        self.assertAlmostEqual(float(g[1]), road * (1 - t) + ROAD_Z * t, places=3)

    def test_geometry_decides_when_the_bake_has_not_spoken(self):
        # no authored dead ends: a free end away from the bbox edge and from other roads is a dead end
        br = dict(self.branch, dead_ends=[])
        model = grade.RoadModel(world(spine_east(), branches=[br], bbox=[-10, -400, 610, 400]), self.dem)
        self.assertEqual(model.bulb_count, 2)  # both ends of this isolated street
        # ... and nothing in a world where the knob is off
        off = grade.RoadModel(world(spine_east(), branches=[br], bbox=[-10, -400, 610, 400]), self.dem, knobs=grade.Knobs(CULDESAC_RADIUS=0))
        self.assertEqual(off.bulb_count, 0)


class DeckRunTest(unittest.TestCase):
    def test_a_deck_is_a_run_not_a_coin_toss(self):
        f = np.array([0, 1, 0, 1, 1, 0, 0, 1, 1, 1, 0, 0, 0, 1, 0], dtype=bool)
        out = grade._smooth_runs(f, grade.DECK_GAP_STATIONS, grade.DECK_MIN_STATIONS)
        # the gaps of 1 and 2 close, so stations 1..9 are one deck; the lone flag at 13 is dropped
        self.assertEqual(out.tolist(), [False] + [True] * 9 + [False] * 5)
        # nothing to close or open: untouched
        self.assertEqual(grade._smooth_runs(np.zeros(6, bool), 2, 3).tolist(), [False] * 6)
        self.assertEqual(grade._smooth_runs(np.ones(6, bool), 2, 3).tolist(), [True] * 6)


class DrivewayDirectionTest(unittest.TestCase):
    def test_a_coincident_end_point_does_not_become_a_plateau(self):
        dem = slope_dem(0.0)
        # a stub ending on two coincident points, 6 m above the ground it crosses
        stub = {"highway": "residential", "lanes": 2, "coords": [[300.0, 60.0, ROAD_Z + 6.0], [300.0, 64.0, ROAD_Z + 6.0], [300.0, 68.0, ROAD_Z + 6.0], [300.0, 68.0, ROAD_Z + 6.0]]}
        w = world(spine_east(), bbox=[-10, -400, 610, 400])
        w["stubs"] = [stub]
        model = grade.RoadModel(w, dem)
        # 50 m to the east of the stub, well outside any driveway's band: the DEM, not the stub
        g = model.graded_height([350.0], [-64.0], dem(350.0, -64.0))
        self.assertTrue(np.isnan(g[0]) or abs(float(g[0]) - ROAD_Z) < 0.05)
        # on the stub itself: its own height
        g = model.graded_height([300.0], [-64.0], dem(300.0, -64.0))
        self.assertAlmostEqual(float(g[0]), ROAD_Z + 6.0 + 0.03 - grade.SURFACE_DROP, places=3)


class WidthTest(unittest.TestCase):
    def test_paved_width_matches_props(self):
        self.assertAlmostEqual(grade.paved_width(2, two_way=True), 2 * 3.66 + 6.0)
        self.assertAlmostEqual(grade.paved_width(3, two_way=False), 3 * 3.66 + 4.2)
        self.assertAlmostEqual(grade.paved_width(2, kerbed=True), 2 * 3.66 + 0.6)
        self.assertAlmostEqual(grade.paved_offset(False, False), 0.9)
        self.assertEqual(grade.paved_offset(True, False), 0.0)
        self.assertEqual(grade.branch_lanes("3"), 3.0)
        self.assertEqual(grade.branch_lanes([4, 2]), 2.0)
        self.assertEqual(grade.branch_lanes(None), 2)

    def test_lane_taper_ramps_a_step_over_sixty_metres(self):
        lanes = grade.tapered_lanes(lambda s: 2.0 if s < 200 else 3.0, 400.0, 60.0)
        self.assertEqual(float(lanes(100.0)), 2.0)
        self.assertEqual(float(lanes(300.0)), 3.0)
        self.assertAlmostEqual(float(lanes(199.0)), 2.5, places=2)
        self.assertGreater(float(lanes(185.0)), 2.0)
        self.assertLess(float(lanes(185.0)), 2.5)


if __name__ == "__main__":
    unittest.main()
