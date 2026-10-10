"""osm: a query goes only to an instance whose extract holds ALL of it, or the bake stops.

The failure behind these tests, measured 2026-10-10. The world editor sent dc-metro-take-2 to the
`overpass` instance because a box on its URL (#37.9/-79.5/39.8/-75.0) took in Washington and
Arlington. The instance holds a Geofabrik MARYLAND extract. Asked for highways over Arlington it
answered HTTP 200 with 0 ways (overpass-na: 4,346), over downtown Washington 0 (6,418), and the
bake shipped a world with 108,816 roads in Maryland and none across the river, reporting success.

So the bake now reads what each instance holds (CORRIDOR_OVERPASS_COVERAGE, written by the world
editor) and checks every query's area against it before sending it anywhere. These use the REAL
polygons — Geofabrik's maryland and north-america, vendored in tools/worldeditor/geofabrik-seed.json
— and the REAL query the bake builds for dc-metro-take-2, through the real `Frame`.

    tools/corridor/.venv/bin/python -m unittest tools/corridor/tests/test_osm_coverage.py
"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from corridor import BakeFault, osm  # noqa: E402
from corridor.geo import Frame  # noqa: E402

# A copy of tools/worldeditor/geofabrik-seed.json, beside the tests: the corridor image's CI mounts
# only tools/corridor/tests into the image, so a path into tools/worldeditor is not there (CI,
# 2026-10-10: seven ERRORs, all "No such file"). `SeedCopyTest` holds the copy to the original
# wherever both exist, so the two cannot drift.
SEED = Path(__file__).resolve().parent / "fixtures" / "geofabrik-seed.json"
ORIGINAL_SEED = Path(__file__).resolve().parents[2] / "worldeditor" / "geofabrik-seed.json"
MD = "http://overpass/api/interpreter"
NA = "http://overpass-na/api/interpreter"
EU = "http://overpass-eu/api/interpreter"


def region(rid: str) -> dict:
    for f in json.loads(SEED.read_text())["features"]:
        if f["properties"]["id"] == rid:
            return {"id": rid, "geometry": f["geometry"], "source": "deploy"}
    raise KeyError(rid)


def roads_query(lat: float, lon: float, R: float) -> str:
    """network.roads' all_streets query for a radius world, built the way it builds it."""
    frame = Frame.at(lon, lat)
    ox, oy = frame.origin
    w, s, e, n = frame.bbox_wgs(ox - R, oy - R, ox + R, oy + R)
    return f'[out:json][timeout:300];(way({s},{w},{n},{e})[highway~"^(motorway|trunk|primary)$"];);out geom;'


DC_METRO = roads_query(38.911621, -77.005045, 19933)   # dc-metro-take-2, from the deployed editor
CROFTON = roads_query(39.007758, -76.670706, 5260)     # crofton-triangle: wholly in Maryland


class Coverage(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.file = Path(self.tmp.name) / "coverage.json"
        self.file.write_text(json.dumps({"version": 1, "upstreams": [
            {"name": "overpass-eu", "url": EU, "regions": [region("europe")]},
            {"name": "overpass", "url": MD, "regions": [region("us/maryland")]},
            {"name": "overpass-na", "url": NA, "regions": [region("north-america")]},
        ]}))
        self.saved = (osm._OURS, osm._COVERAGE_FILE, osm._coverage_cache, osm._REFRESH)
        osm._COVERAGE_FILE = str(self.file)
        osm._coverage_cache = None
        osm._REFRESH = False

    def tearDown(self):
        osm._OURS, osm._COVERAGE_FILE, osm._coverage_cache, osm._REFRESH = self.saved
        self.tmp.cleanup()

    def test_query_area_reads_every_spatial_filter(self):
        a = osm.query_area("way(38.7,-77.2,39.1,-76.7)[highway];out;")
        self.assertEqual(tuple(round(v, 6) for v in a.bounds), (-77.2, 38.7, -76.7, 39.1))
        a = osm.query_area('(way(poly:"39.0 -76.7 39.0 -76.6 39.1 -76.6");node(poly:"39.0 -76.7 39.0 -76.6 39.1 -76.6"););out;')
        self.assertAlmostEqual(a.bounds[0], -76.7)
        self.assertAlmostEqual(a.bounds[3], 39.1)
        a = osm.query_area("way(around:800,39.0,-76.7)[highway];out;")
        self.assertAlmostEqual((a.bounds[3] - a.bounds[1]) * 111132 / 2, 800, delta=1)
        # an id lookup names no place: its ids came out of a query that was checked
        self.assertIsNone(osm.query_area("node(id:1,2,3,4)->.e;.e out tags;way(bn.e)[highway];out body;"))

    def test_dc_metro_goes_to_north_america_not_maryland(self):
        # the editor handed it both, in the old order; the bake takes only the one that holds it
        osm._OURS = [MD, NA]
        self.assertEqual(osm.route(DC_METRO), [NA])

    def test_dc_metro_sent_only_to_maryland_is_a_bake_fault_not_a_silent_half(self):
        # what the fences did: Maryland alone. It answered 200 for every query and the world had no
        # Washington. Now it stops, and says how much is missing and from where.
        osm._OURS = [MD]
        with self.assertRaises(BakeFault) as cm:
            osm.route(DC_METRO)
        msg = str(cm.exception)
        self.assertIn("us/maryland", msg)
        pct = float(msg.split("leaves ")[1].split("%")[0])
        self.assertGreater(pct, 30)  # 35.3% of the world's square is Washington and Virginia
        self.assertLess(pct, 40)

    def test_crofton_still_goes_to_maryland_first(self):
        osm._OURS = [MD, NA]
        self.assertEqual(osm.route(CROFTON), [MD, NA])

    def test_without_a_coverage_file_nothing_changes(self):
        osm._COVERAGE_FILE = ""
        osm._coverage_cache = None
        osm._OURS = [MD]
        self.assertEqual(osm.route(DC_METRO), [MD])

    def test_an_unreadable_coverage_file_is_a_fault_not_a_blind_bake(self):
        osm._COVERAGE_FILE = str(Path(self.tmp.name) / "missing.json")
        osm._coverage_cache = None
        osm._OURS = [MD]
        with self.assertRaises(BakeFault):
            osm.route(CROFTON)

    def test_a_cached_answer_from_the_wrong_instance_is_asked_again(self):
        # the cache is keyed by the query alone, so dc-metro's Maryland-only roads would be a hit
        # for ever; the sidecar says who answered, and Maryland does not hold that query
        osm._OURS = [MD, NA]
        hit = Path(self.tmp.name) / "abc.json"
        hit.write_text(json.dumps({"elements": [{"type": "way", "id": 1}]}))
        hit.with_name("abc.json.upstream").write_text(json.dumps({"url": MD, "host": "overpass"}))
        self.assertIsNone(osm._cache_hit(hit, DC_METRO))
        # ...and the same answer from the instance that holds it is a hit
        hit.with_name("abc.json.upstream").write_text(json.dumps({"url": NA, "host": "overpass-na"}))
        self.assertEqual(osm._cache_hit(hit, DC_METRO)["elements"][0]["id"], 1)
        # CORRIDOR_OSM_REFRESH asks again whoever answered
        osm._REFRESH = True
        self.assertIsNone(osm._cache_hit(hit, DC_METRO))


class RuntimeErrorIsNotAnAnswer(unittest.TestCase):
    """Overpass reports a timeout, out-of-memory, or a data file caught mid-import as HTTP 200 with
    the reason in `remark`. Measured on a local copy of the instance taking an import: 4 of 406
    queries answered "runtime error: open64: … Data file size does not match block size"."""

    def test_a_runtime_error_remark_is_retried_and_never_cached(self):
        answers = [
            {"elements": [], "remark": "runtime error: open64: /db/db/ways.bin.idx File_Blocks_Index: Data file size does not match block size"},
            {"elements": [{"type": "way", "id": 7}]},
        ]
        posted = []

        class R:
            status_code = 200

            def __init__(self, doc):
                self.doc = doc

            def json(self):
                return self.doc

        saved = (osm.session.post, osm.time.sleep, osm._OURS, osm.OVERPASS, osm._COVERAGE_FILE, osm._coverage_cache)
        osm.session.post = lambda url, data, timeout: (posted.append(url), R(answers.pop(0)))[1]
        osm.time.sleep = lambda s: None
        osm._OURS, osm.OVERPASS, osm._COVERAGE_FILE, osm._coverage_cache = [MD], [MD], "", None
        try:
            with tempfile.TemporaryDirectory() as d:
                out = osm.overpass("way(39.0,-76.7,39.01,-76.69)[highway];out;", Path(d))
                self.assertEqual(out["elements"][0]["id"], 7)
                self.assertEqual(len(posted), 2)
                cached = json.loads(next(Path(d).glob("*.json")).read_text())
                self.assertEqual(cached["elements"][0]["id"], 7)
        finally:
            osm.session.post, osm.time.sleep, osm._OURS, osm.OVERPASS, osm._COVERAGE_FILE, osm._coverage_cache = saved


if __name__ == "__main__":
    unittest.main()


class SeedCopyTest(unittest.TestCase):
    def test_the_fixture_is_the_world_editors_seed(self):
        if not ORIGINAL_SEED.exists():
            self.skipTest("tools/worldeditor is not here (the image's CI): nothing to compare against")
        self.assertEqual(json.loads(SEED.read_text()), json.loads(ORIGINAL_SEED.read_text()),
                         "tests/fixtures/geofabrik-seed.json has drifted from tools/worldeditor/geofabrik-seed.json — copy it again")
