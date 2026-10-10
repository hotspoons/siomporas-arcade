"""lidar_sources: which point cloud a bake reads, how deep, and how two surveys share one corridor.

Rich, 2026-09-30: a crofton-triangle bake sat for half an hour downloading 7.6 GB of whole LAZ
tiles from rockyweb at 80 KB/s a connection, while NOAA had the same streets as EPT on S3 at
43 MiB/s. These tests pin the three rules that fix it, without the network: the EPT walk stops at a
density rather than at the leaves; a second survey fills only the cells the first left empty; and
the TNM tiles are the fallback, not the default.

The EPT under test is REAL, just small: ept.json, hierarchy and laszip nodes written with laspy and
served over HTTP from a temporary directory, so the same code path that reads NOAA reads these.

    tools/corridor/.venv/bin/python -m unittest discover -s tools/corridor/tests
"""
from __future__ import annotations

import http.server
import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path

import laspy
import numpy as np
from pyproj import Transformer
from shapely.geometry import box

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from corridor import lidar, lidar_sources as ls  # noqa: E402
from corridor.geo import Frame  # noqa: E402

LON, LAT = -76.685, 39.007  # Crofton
FRAME = Frame.at(LON, LAT)
OX, OY = FRAME.origin
# the site bbox: 2 km x 1 km around the origin, in the site frame
BBOX = (OX - 1000.0, OY - 500.0, OX + 1000.0, OY + 500.0)


class Server:
    """A directory over HTTP, remembering every path asked for."""

    def __init__(self, root: Path):
        self.root = root
        self.asked: list[str] = []
        outer = self

        class H(http.server.SimpleHTTPRequestHandler):
            def __init__(self, *a, **k):
                super().__init__(*a, directory=str(root), **k)

            def log_message(self, *a):
                outer.asked.append(self.path)

        self.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}/"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self):
        self.httpd.shutdown()


def write_ept(root: Path, name: str, epsg: int, region, nodes: dict[str, int], cls: int, seed: int) -> None:
    """An EPT over `region` (site-frame x0, y0, x1, y1) in `epsg`, with `nodes` = {key: points}.

    Every node's points are spread uniformly over the part of the region its box covers, so the
    density per depth is exactly what the counts say.
    """
    d = root / name
    (d / "ept-data").mkdir(parents=True)
    (d / "ept-hierarchy").mkdir()
    to = Transformer.from_crs(FRAME.crs, f"EPSG:{epsg}", always_xy=True)
    back = Transformer.from_crs(f"EPSG:{epsg}", FRAME.crs, always_xy=True)
    xs, ys = to.transform([BBOX[0] - 2000, BBOX[2] + 2000], [BBOX[1] - 2000, BBOX[3] + 2000])
    x0, y0, x1, y1 = min(xs), min(ys), max(xs), max(ys)
    side = max(x1 - x0, y1 - y0)
    cube = [x0, y0, 0.0, x0 + side, y0 + side, side]
    rng = np.random.default_rng(seed)
    for key, n in nodes.items():
        dd, nx, ny, _ = (int(v) for v in key.split("-"))
        s = side / 2**dd
        bx0, by0 = cube[0] + nx * s, cube[1] + ny * s
        # sample in the node box (EPT CRS), keep those whose site-frame position is in the region
        px = rng.uniform(bx0, bx0 + s, n * 40)
        py = rng.uniform(by0, by0 + s, n * 40)
        fx, fy = back.transform(px, py)
        fx, fy = np.asarray(fx), np.asarray(fy)
        m = (fx >= region[0]) & (fx < region[2]) & (fy >= region[1]) & (fy < region[3])
        px, py = px[m][:n], py[m][:n]
        las = laspy.create(point_format=6, file_version="1.4")
        las.header.offsets = [float(bx0), float(by0), 0.0]
        las.header.scales = [0.01, 0.01, 0.01]
        las.x, las.y = px, py
        las.z = np.full(len(px), 30.0)
        las.classification = np.full(len(px), cls, np.uint8)
        las.write(d / "ept-data" / f"{key}.laz", laz_backend=laspy.LazBackend.Lazrs)
        nodes[key] = len(px)
    (d / "ept-hierarchy" / "0-0-0-0.json").write_text(json.dumps(nodes))
    (d / "ept.json").write_text(json.dumps({
        "bounds": cube, "boundsConforming": cube, "points": sum(nodes.values()), "span": 128, "dataType": "laszip",
        "srs": {"authority": "EPSG", "horizontal": str(epsg), "vertical": "5703"}, "schema": [],
    }))


class DensityTest(unittest.TestCase):
    def test_stops_at_the_first_depth_that_reaches_the_target(self):
        counts = [("0-0-0-0", 100, 1.0), ("1-0-0-0", 900, 1.0), ("2-0-0-0", 9000, 1.0)]
        self.assertEqual(ls.choose_depth(counts, 100.0, 1.0)[0], 0)
        self.assertEqual(ls.choose_depth(counts, 100.0, 5.0)[0], 1)   # 100 + 900 = 10 / m²
        self.assertEqual(ls.choose_depth(counts, 100.0, 50.0)[0], 2)

    def test_a_target_nothing_reaches_takes_everything(self):
        d, dens = ls.choose_depth([("0-0-0-0", 10, 1.0), ("1-0-0-0", 10, 0.5)], 100.0, 99.0)
        self.assertEqual(d, 1)
        self.assertAlmostEqual(dens, 0.15)

    def test_only_the_part_of_a_node_over_the_area_counts(self):
        # a node half outside the area contributes half its points
        self.assertAlmostEqual(ls.choose_depth([("0-0-0-0", 200, 0.5)], 100.0, 1.0)[1], 1.0)


class NoaaIndexTest(unittest.TestCase):
    def feature(self, ident, href, start="2020-12-08T00:00:00Z", poly=(-76.8, 38.9, -76.6, 39.1)):
        return {"id": f"DigitalCoast_DAV:id_{ident}", "geometry": box(*poly).__geo_interface__,
                "properties": {"start_datetime": start, "pc:count": 10, "pc:type": "lidar"}, "assets": {"ept": {"href": href}}}

    def test_keeps_navd88_and_drops_other_datums(self):
        base = "https://noaa-nos-coastal-lidar-pds.s3.amazonaws.com/entwine"
        slim = ls.slim_noaa_index({"features": [
            self.feature("10311", f"{base}/geoid18/10311/ept.json"),
            self.feature("777", f"{base}/mllw/777/ept.json"),
            self.feature("778", f"{base}/geoid12b/778/ept.json", start="2012-01-01T00:00:00Z"),
        ]})
        self.assertEqual([(e["id"], e["year"]) for e in slim], [("10311", 2020), ("778", 2012)])
        self.assertTrue(slim[0]["base"].endswith("/geoid18/10311/"))

    def test_ranks_by_coverage_then_year(self):
        area = box(-76.70, 39.00, -76.66, 39.02)
        full_old = ls.EptSource("NOAA:1", "u", 2017, box(-77, 38, -76, 40))
        full_new = ls.EptSource("NOAA:2", "u", 2020, box(-77, 38, -76, 40))
        half = ls.EptSource("NOAA:3", "u", 2024, box(-76.70, 39.00, -76.68, 39.02))
        away = ls.EptSource("NOAA:4", "u", 2024, box(-75, 38, -74, 39))
        ranked = ls.rank_by_footprint([half, full_old, away, full_new], area)
        self.assertEqual([s.name for s, _ in ranked], ["NOAA:2", "NOAA:1", "NOAA:3"])
        self.assertAlmostEqual(ranked[2][1], 0.5, places=2)
        self.assertAlmostEqual(ls.union_share(ranked, area), 1.0, places=2)


class PlanTest(unittest.TestCase):
    """Crofton, as measured 2026-09-30: the order NOAA's surveys are read in."""

    def test_newest_over_half_first_then_whatever_covers_the_gap(self):
        area = box(0, 0, 10, 10)
        aa_2020 = ls.EptSource("NOAA:10311", "u", 2020, box(1.2, 0, 10, 10))   # 88 %, the east
        aa_2017 = ls.EptSource("NOAA:9234", "u", 2017, box(1.0, 0, 10, 10))    # 90 %, the same county again
        old_2011 = ls.EptSource("NOAA:8494", "u", 2011, box(0.4, 0, 10, 10))   # 96 %, ground-only
        pg_2018 = ls.EptSource("NOAA:9235", "u", 2018, box(-5, 0, 1.6, 10))    # 16 %, the west edge
        ranked = ls.rank_by_footprint([old_2011, aa_2017, aa_2020, pg_2018], area)
        plan = [s.name for s, _ in ls.plan_cover(ranked, area)]
        self.assertEqual(plan[0], "NOAA:10311", "the newest survey over half the streets, not the widest")
        self.assertEqual(plan[1], "NOAA:9235", "then the one covering the gap, not a re-fly of the same county")
        self.assertNotIn("NOAA:9234", plan, "adds nothing once the gap is covered")

    def test_nothing_over_half_takes_the_widest(self):
        area = box(0, 0, 10, 10)
        a = ls.EptSource("NOAA:1", "u", 2024, box(0, 0, 2, 10))
        b = ls.EptSource("NOAA:2", "u", 2010, box(0, 0, 4, 10))
        plan = [s.name for s, _ in ls.plan_cover(ls.rank_by_footprint([a, b], area), area)]
        self.assertEqual(plan[0], "NOAA:2")


class UsgsIndexTest(unittest.TestCase):
    """The rest of the country: USGS's 2,279 EPT sets, discovered rather than hand-listed."""

    def test_survey_years_from_project_names(self):
        for name, year in [("MD_Western_2_D21", 2021), ("AL_11County_2_B23", 2023), ("CO_Eastern_ElPaso_2018", 2018),
                           ("USGS_LPC_MD_VA_Sandy_NCR_2014_LAS_2015", 2014), ("ME_MidCoast_1_2021", 2021), ("IA_FullState", None)]:
            self.assertEqual(ls.survey_year(name), year, name)

    def test_the_index_is_slimmed_and_junk_classified_sets_are_left_out(self):
        base = "https://s3-us-west-2.amazonaws.com/usgs-lidar-public"
        feats = [{"properties": {"name": n, "count": 5, "url": f"{base}/{n}/ept.json"}, "geometry": box(-69, 44, -68, 45).__geo_interface__}
                 for n in ("ME_MidCoast_1_2021", "USGS_LPC_MD_VA_Sandy_NCR_2014_LAS_2015")]
        slim = ls.slim_usgs_index({"features": feats})
        self.assertEqual([(e["id"], e["year"]) for e in slim], [("ME_MidCoast_1_2021", 2021)])
        self.assertEqual(slim[0]["base"], f"{base}/ME_MidCoast_1_2021/")

    def test_mount_desert_island_takes_the_2021_usgs_survey_over_noaas_2010(self):
        # measured 2026-09-30: USGS ME_MidCoast_1_2021 covers 96 %, NOAA 2524 (2010) 84 %
        area = box(0, 0, 10, 10)
        usgs = ls.EptSource("USGS:ME_MidCoast_1_2021", "u", 2021, box(0, 0, 10, 9.6))
        noaa = ls.EptSource("NOAA:2524", "u", 2010, box(0, 1.6, 10, 10))
        plan = [s.name for s, _ in ls.plan_cover(ls.rank_by_footprint([noaa, usgs], area), area)]
        self.assertEqual(plan[0], "USGS:ME_MidCoast_1_2021")

    def test_an_unreachable_index_falls_back_to_the_hand_kept_list(self):
        saved = ls._cached_index
        ls._cached_index = lambda *a, **k: None
        try:
            got = ls.usgs_sources(Path("/nonexistent"))
        finally:
            ls._cached_index = saved
        self.assertTrue(got and all(s.footprint is None for s in got), "the fallback sets carry no footprint")
        self.assertEqual({s.name.split(":", 1)[1] for s in got}, set(lidar.DATASETS) - lidar.PREFER_TNM_OVER)


class TnmTilesTest(unittest.TestCase):
    def test_a_tile_no_street_touches_is_not_downloaded(self):
        tiles = [{"boundingBox": {"minX": 0, "minY": 0, "maxX": 1, "maxY": 1}}, {"boundingBox": {"minX": 5, "minY": 5, "maxX": 6, "maxY": 6}}, {}]
        kept = lidar.tiles_touching(tiles, box(0.5, 0.5, 2, 2))
        self.assertEqual(len(kept), 2, "the touching tile, and the one with no box (kept, not guessed away)")


class StreamTest(unittest.TestCase):
    """Two real (tiny) EPTs over HTTP: A covers only the west half, B the whole area."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name) / "www"
        west = (BBOX[0], BBOX[1], OX, BBOX[3])
        # A: in the SITE's own UTM zone; depth 0 sparse, depth 1 dense (its 4 x 1 x 1 children)
        write_ept(root, "A", FRAME.epsg, west, {"0-0-0-0": 40000, "1-0-0-0": 40000, "1-1-0-0": 40000, "1-0-1-0": 40000, "1-1-1-0": 40000}, cls=2, seed=1)
        # B: Web Mercator, as USGS's are, and a different class so its points are recognisable
        write_ept(root, "B", 3857, BBOX, {"0-0-0-0": 40000}, cls=5, seed=2)
        cls.server = Server(root)

    @classmethod
    def tearDownClass(cls):
        cls.server.close()
        cls.tmp.cleanup()

    def sources(self):
        return [ls.EptSource("TEST:A", self.server.url + "A/", 2020), ls.EptSource("TEST:B", self.server.url + "B/", 2018)]

    def run_stream(self, density="0.00001"):
        # A FRESH CACHE each call: a node already on disk is never requested, and the depth tests
        # read the server's request log. The density estimate weights a node by the share of its
        # box over the area (real surveys fill their boxes; these fixtures pack the area), so the
        # targets here are in those terms: depth 0 alone estimates ~1e-4 /m², depth 1 ~1e-2.
        os.environ["CORRIDOR_LIDAR_DENSITY"] = density
        try:
            meta: dict = {}
            cache = Path(tempfile.mkdtemp(dir=self.tmp.name))
            parts = [p for _, p in ls.stream_ept(FRAME, BBOX, None, cache, self.sources(), meta, jobs=4)]
        finally:
            os.environ.pop("CORRIDOR_LIDAR_DENSITY", None)
        return lidar._join(parts), meta

    def test_the_second_survey_fills_only_the_first_ones_gaps(self):
        pts, meta = self.run_stream()
        a = pts["cls"] == 2
        b = pts["cls"] == 5
        self.assertTrue(a.any() and b.any(), "both surveys contributed")
        # every A point is in the west half, in the site frame: the CRS conversion is right
        self.assertTrue((pts["x"][a] < OX + 1).all())
        # no B point lands in a cell A already had
        occ = ls.Occupancy(BBOX, None)
        occ.mark(pts["x"][a], pts["y"][a])
        self.assertFalse((~occ.empty(pts["x"][b], pts["y"][b])).any(), "a B point shares a cell with A")
        self.assertGreater(meta["coverage"], 0.95)
        self.assertEqual([s["dataset"] for s in meta["sources"]], ["TEST:A", "TEST:B"])

    def test_a_low_target_reads_only_the_shallow_nodes(self):
        self.server.asked.clear()
        self.run_stream(density="0.00001")
        got = [p for p in self.server.asked if "/A/ept-data/" in p]
        self.assertEqual(got, ["/A/ept-data/0-0-0-0.laz"], "depth 0 already reached the target")

    def test_a_high_target_goes_deeper(self):
        self.server.asked.clear()
        self.run_stream(density="0.02")
        got = sorted(p.rsplit("/", 1)[1] for p in self.server.asked if "/A/ept-data/" in p)
        self.assertIn("1-0-0-0.laz", got)

    def test_enough_coverage_stops_before_the_next_source(self):
        # A alone over its own west half: a clip of just that half is fully covered by A
        west = box(BBOX[0] + 50, BBOX[1] + 50, OX - 50, BBOX[3] - 50)
        os.environ["CORRIDOR_LIDAR_DENSITY"] = "0.00001"
        try:
            meta: dict = {}
            list(ls.stream_ept(FRAME, BBOX, west, Path(tempfile.mkdtemp(dir=self.tmp.name)), self.sources(), meta, jobs=4))
        finally:
            os.environ.pop("CORRIDOR_LIDAR_DENSITY", None)
        self.assertEqual([s["dataset"] for s in meta["sources"]], ["TEST:A"])


class PoolThreadsTest(unittest.TestCase):
    """No native object crosses the reader pool's threads (lidar_sources.NodeReader).

    dc-metro-take-2 shard 5, 2026-10-10: sixteen readers called `shapely.contains_xy` on ONE shared
    streets polygon; GEOS builds a prepared polygon's point index lazily and without a lock, two
    threads built it at once, and glibc aborted the bake (`malloc(): unaligned tcache chunk
    detected`). These pin the rule that makes that impossible: each pool thread clips with its own
    geometry, transforms with its own Transformer, fetches with its own Session.
    """

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name) / "www"
        write_ept(root, "A", FRAME.epsg, BBOX, {"0-0-0-0": 20000, "1-0-0-0": 20000, "1-1-0-0": 20000, "1-0-1-0": 20000, "1-1-1-0": 20000}, cls=2, seed=3)
        cls.server = Server(root)

    @classmethod
    def tearDownClass(cls):
        cls.server.close()
        cls.tmp.cleanup()

    def test_every_thread_clips_transforms_and_fetches_with_its_own_objects(self):
        import shapely

        clip = box(BBOX[0] + 100, BBOX[1] + 100, BBOX[2] - 100, BBOX[3] - 100)
        seen: list[tuple[int, object]] = []  # (thread, geometry) per contains_xy; holding the
        kits: list[tuple[int, object]] = []  # objects keeps their ids from being reused
        real_contains, real_kit = shapely.contains_xy, ls.NodeReader.kit

        def contains_xy(geom, *a, **k):
            seen.append((threading.get_ident(), geom))
            return real_contains(geom, *a, **k)

        def kit(reader):
            got = real_kit(reader)
            kits.append((threading.get_ident(), got))
            return got

        shapely.contains_xy, ls.NodeReader.kit = contains_xy, kit
        os.environ["CORRIDOR_LIDAR_DENSITY"] = "0.02"  # deep enough for all five nodes
        try:
            parts = list(ls.stream_ept(FRAME, BBOX, clip, Path(tempfile.mkdtemp(dir=self.tmp.name)), [ls.EptSource("TEST:A", self.server.url + "A/", 2020)], {}, jobs=4))
        finally:
            shapely.contains_xy, ls.NodeReader.kit = real_contains, real_kit
            os.environ.pop("CORRIDOR_LIDAR_DENSITY", None)

        self.assertTrue(parts, "the clip kept points")
        main = threading.get_ident()
        workers = [(t, g) for t, g in seen if t != main]
        self.assertTrue(workers, "the clip test ran in the pool, so this test tests the pool")
        self.assertFalse(any(g is clip for _, g in workers), "a pool thread used the caller's clip")
        for what in ("clip", "tr", "session"):
            owner: dict[int, int] = {}
            for t, k in kits:
                obj = getattr(k, what)
                self.assertEqual(owner.setdefault(id(obj), t), t, f"two threads share one {what}")
        self.assertFalse(any(k.session is lidar.session for _, k in kits), "a pool thread used the module's shared Session")
        owner = {}
        for t, g in workers:
            self.assertEqual(owner.setdefault(id(g), t), t, "two threads clipped with one geometry")

    def test_the_clip_a_thread_gets_is_the_same_polygon(self):
        import shapely

        clip = box(OX - 10, OY - 10, OX + 10, OY + 10).union(box(OX + 30, OY, OX + 50, OY + 5))
        r = ls.NodeReader(ls.EptSource("TEST:A", "unused/"), Path("/nonexistent"), FRAME.crs, FRAME.crs, 1.0, BBOX, clip)
        mine = r.kit().clip
        self.assertIsNot(mine, clip)
        self.assertTrue(shapely.equals_exact(mine, clip, tolerance=0.0), "WKB round trip changed the clip")
        self.assertTrue(shapely.is_prepared(mine))
        self.assertIs(r.kit(), r.kit(), "one kit per thread, built once")

    def test_sixteen_threads_at_once_do_not_corrupt_the_heap(self):
        """The crash itself, in a child process so an abort is a failed test and not a dead runner.

        Sixteen threads released together onto a fresh reader's clip, twenty times. With a reader
        that hands every thread the ONE shared polygon, as the bake did, this child aborted with
        `tcache_thread_shutdown(): unaligned tcache chunk detected` on every run (shapely 2.2.0 /
        GEOS 3.14.1, the baker image's, 2026-10-10). It runs in a temporary directory so that a
        failure's core dump lands there and not in the checkout.
        """
        import subprocess

        code = f"""
import sys, threading
sys.path.insert(0, {str(Path(__file__).resolve().parents[1])!r})
import numpy as np, shapely
from pathlib import Path
from corridor import lidar_sources as ls
from corridor.geo import Frame
frame = Frame.at({LON}, {LAT})
ox, oy = frame.origin
t = np.linspace(0, 40 * np.pi, 4000)
road = shapely.LineString(np.column_stack([ox + t * 100, oy + 2000 * np.sin(t)]))
clip = road.buffer(200, cap_style="flat")   # thousands of vertices, as a real streets outline has
x0, y0, x1, y1 = clip.bounds
wkb = shapely.to_wkb(clip)
rng = np.random.default_rng(0)
pts = [(rng.uniform(x0, x1, 4000), rng.uniform(y0, y1, 4000)) for _ in range(16)]  # drawn up front: a
for rnd in range(20):                                                              # shared rng staggers the threads
    fresh = shapely.from_wkb(wkb)  # unprepared, as each source's clip reaches its pool
    reader = ls.NodeReader(ls.EptSource("TEST:A", "unused/"), Path("/nonexistent"), frame.crs, frame.crs, 1.0, clip.bounds, fresh)
    bar = threading.Barrier(16)
    def go(i):
        bar.wait()
        mine = reader.kit().clip
        for k in range(4):
            shapely.contains_xy(mine, pts[i][0][k * 1000:(k + 1) * 1000], pts[i][1][k * 1000:(k + 1) * 1000])
    th = [threading.Thread(target=go, args=(i,)) for i in range(16)]
    [h.start() for h in th]
    [h.join() for h in th]
print("ok")
"""
        r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=300, cwd=self.tmp.name)
        self.assertEqual(r.returncode, 0, f"the child died: {r.stderr[-2000:]}")
        self.assertEqual(r.stdout.strip(), "ok")


class ChoiceTest(unittest.TestCase):
    """point_batches: EPT when it covers enough, the TNM tiles when it does not or when asked."""

    def setUp(self):
        self.saved = (ls.candidates, lidar.tnm_pick)
        self.calls: list[str] = []

        def tnm_pick(*a, **k):
            self.calls.append("tnm")
            raise RuntimeError("tnm reached")

        lidar.tnm_pick = tnm_pick

    def tearDown(self):
        ls.candidates, lidar.tnm_pick = self.saved
        os.environ.pop("CORRIDOR_LIDAR_SOURCE", None)

    def batches(self):
        with self.assertRaisesRegex(RuntimeError, "tnm reached"):
            list(lidar.point_batches(FRAME, BBOX, Path("/nonexistent"), None, {}))

    def test_too_little_ept_coverage_goes_to_tnm(self):
        ls.candidates = lambda *a: ([ls.EptSource("NOAA:1", "u")], 0.3)
        self.batches()
        self.assertEqual(self.calls, ["tnm"])

    def test_asking_for_tnm_skips_ept_entirely(self):
        def boom(*a):
            raise AssertionError("EPT was consulted")

        ls.candidates = boom
        os.environ["CORRIDOR_LIDAR_SOURCE"] = "tnm"
        self.batches()


if __name__ == "__main__":
    unittest.main()
