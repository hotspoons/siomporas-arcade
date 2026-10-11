"""Full-world lidar: a world bake reads and rasterises the point cloud over its whole region, and
everything road-local stays exactly what a streets-only read made it.

Rich, 2026-10-10: "So I want to remove the strip logic and have full world trees (and anything
else stripped along roads only)". The lidar CHM read 0 between the streets -- all of Rockville on
dc-metro-take-2 had no trees -- and the global-canopy fill that replaced those zeros left a strip:
lidar canopy along the roads, a different model between them. These tests pin the area rules:

  * what a shard and an unsharded bake read (`shards.world_lidar_area`, `network.world_lidar_area`)
  * the survey's depth is chosen over the STREETS while the nodes are walked over the region
  * the near-road cloud is the points inside the streets, whatever else was read
  * the tile grid the export walks is the site's bbox, not the lidar's list

    tools/corridor/.venv/bin/python -m unittest discover -s tools/corridor/tests
"""
from __future__ import annotations

import json
import sys
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock

import numpy as np
import rasterio
from shapely.geometry import LineString, box

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from corridor import lidar, lidar_sources as ls, network, network_tiles as nt, shards  # noqa: E402
from corridor.geo import Frame  # noqa: E402

LON, LAT = -76.685, 39.007  # Crofton
FRAME = Frame.at(LON, LAT)


class ShardAreaTest(unittest.TestCase):
    """A shard reads the tiles it OWNS, in the world, plus its streets."""

    def setUp(self):
        # a 4 x 2 km world, two 2 x 2 km blocks; tiles assigned by centre
        self.bbox = (500000.0, 4300000.0, 504000.0, 4302000.0)
        blocks = [{"index": 0, "bbox": [500000.0, 4300000.0, 502000.0, 4302000.0]}, {"index": 1, "bbox": [502000.0, 4300000.0, 504000.0, 4302000.0]}]
        self.plan = {"bbox": list(self.bbox), "tile_m": 1000.0, "blocks": blocks, "tiles": shards.assign_tiles(self.bbox, blocks)}
        # block 0's streets: one road along y = 4301000 that runs 300 m into block 1
        self.streets = LineString([(500100.0, 4301000.0), (502300.0, 4301000.0)]).buffer(150.0, cap_style="flat")

    def test_the_owned_tiles_are_read_whole_and_the_streets_ride_along(self):
        a = shards.world_lidar_area(self.plan, 0, box(*self.bbox), self.streets)
        # every square metre of block 0, even far from the road
        self.assertAlmostEqual(a.intersection(box(500000.0, 4300000.0, 502000.0, 4302000.0)).area, 4e6, delta=1.0)
        self.assertTrue(a.contains(box(500050.0, 4300050.0, 500150.0, 4300150.0)), "a field corner 900 m from the road is read")
        # block 1 only where block 0's own street runs into it
        into_1 = a.intersection(box(502000.0, 4300000.0, 504000.0, 4302000.0))
        self.assertAlmostEqual(into_1.area, 300.0 * 300.0, delta=1.0)
        self.assertTrue(a.contains(self.streets), "the streets are always inside what is read")

    def test_the_world_clips_the_owned_tiles(self):
        # a drawn world that is only the southern half: block 0's northern tiles are not read
        world = box(500000.0, 4300000.0, 504000.0, 4301000.0)
        a = shards.world_lidar_area(self.plan, 0, world, self.streets)
        north = a.intersection(box(500000.0, 4301000.0, 502000.0, 4302000.0))
        self.assertAlmostEqual(north.area, self.streets.intersection(box(500000.0, 4301000.0, 502000.0, 4302000.0)).area, delta=1.0)

    def test_neighbours_do_not_overlap_off_the_streets(self):
        a0 = shards.world_lidar_area(self.plan, 0, box(*self.bbox), self.streets)
        a1 = shards.world_lidar_area(self.plan, 1, box(*self.bbox), self.streets.intersection(box(502000.0, 4300000.0, 504000.0, 4302000.0)))
        self.assertAlmostEqual(a0.intersection(a1).area, 300.0 * 300.0, delta=1.0, msg="only the shared street is read twice")


class SiteAreaTest(unittest.TestCase):
    def test_a_network_reads_its_region_and_its_streets(self):
        streets = LineString([(0, 0), (1000, 0)]).buffer(200.0, cap_style="flat")
        region = box(100.0, -500.0, 800.0, 500.0)  # a drawn world the road runs out of
        a = network.world_lidar_area({}, region, streets)
        self.assertTrue(a.contains(region) and a.contains(streets))

    def test_a_site_can_ask_for_the_streets_alone(self):
        streets = LineString([(0, 0), (1000, 0)]).buffer(200.0, cap_style="flat")
        a = network.world_lidar_area({"lidar_area": "streets"}, box(-5000.0, -5000.0, 5000.0, 5000.0), streets)
        self.assertTrue(a.equals(streets))
        self.assertFalse(network.lidar_reads_region({"lidar_area": "Streets "}))
        self.assertTrue(network.lidar_reads_region({}))


class RoadBandDepthTest(unittest.TestCase):
    """nodes_over with a road_band: the nodes of the region, the depth of the streets."""

    def setUp(self):
        self.src = ls.EptSource("TEST:X", "unused/", share=1.0)
        self.src.ept = {"bounds": [0.0, 0.0, 0.0, 1000.0, 1000.0, 1000.0]}
        self.streets = box(0.0, 0.0, 100.0, 100.0)  # south-west corner
        self.region = box(0.0, 0.0, 1000.0, 1000.0)
        self.hier = {"ept-hierarchy/0-0-0-0.json": {"0-0-0-0": 1000, "1-0-0-0": 4000, "1-1-0-0": 1000, "1-0-1-0": 1000, "1-1-1-0": 1000, "2-0-0-0": 1000, "2-3-3-0": 1000}}

    def get(self, rel):
        return self.hier[rel]

    def test_the_depth_is_the_streets_and_the_nodes_are_the_regions(self):
        # streets-only: 10 + 160 points over 10,000 m² by depth 1 (0.017 /m²) -> depth 1
        keys_s, depth_s, dens_s = ls.nodes_over(self.src, (0.0, 0.0, 1000.0, 1000.0), self.get, 0.004, self.streets, self.streets.area)
        keys_w, depth_w, dens_w = ls.nodes_over(self.src, (0.0, 0.0, 1000.0, 1000.0), self.get, 0.004, self.region, self.region.area, self.streets, self.streets.area)
        self.assertEqual(depth_w, depth_s)
        self.assertAlmostEqual(dens_w, dens_s)
        self.assertTrue(set(keys_s) <= set(keys_w), "every node the streets had is still read")
        self.assertIn("1-1-1-0", keys_w, "a depth-1 node over the fields is read too")
        self.assertNotIn("1-1-1-0", keys_s)
        self.assertNotIn("2-3-3-0", keys_w, "nothing deeper than the streets' depth")

    def test_over_the_region_alone_the_depth_could_differ(self):
        # proof the road_band matters: the streets' density (0.017 /m² by depth 1) meets 0.0095 there,
        # the region's (0.008 by depth 1, 0.010 by depth 2) only a level deeper
        _, depth_s, _ = ls.nodes_over(self.src, (0.0, 0.0, 1000.0, 1000.0), self.get, 0.0095, self.region, self.region.area, self.streets, self.streets.area)
        _, depth_r, _ = ls.nodes_over(self.src, (0.0, 0.0, 1000.0, 1000.0), self.get, 0.0095, self.region, self.region.area)
        self.assertEqual((depth_s, depth_r), (1, 2))


class BoundedMapTest(unittest.TestCase):
    def test_order_kept_and_never_more_than_ahead_in_flight(self):
        live, peak = [0], [0]
        lock = threading.Lock()

        def work(i):
            with lock:
                live[0] += 1
                peak[0] = max(peak[0], live[0])
            time.sleep(0.002)
            return i

        out = []
        with ThreadPoolExecutor(8) as ex:
            for r in ls.bounded_map(ex, work, list(range(200)), 6):
                out.append(r)
                with lock:
                    live[0] -= 1  # consumed: no longer held
                time.sleep(0.001)
        self.assertEqual(out, list(range(200)))
        self.assertLessEqual(peak[0], 6 + 1)

    def test_fewer_items_than_ahead(self):
        with ThreadPoolExecutor(2) as ex:
            self.assertEqual(list(ls.bounded_map(ex, lambda i: i * 2, [1, 2, 3], 16)), [2, 4, 6])
            self.assertEqual(list(ls.bounded_map(ex, lambda i: i, [], 4)), [])


class LidarTiledRoadBandTest(unittest.TestCase):
    """lidar_tiled end to end with a synthetic cloud: rasters over the region, near-road cloud
    from the streets only."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.ox, self.oy = 400000.0, 4300000.0
        # a 2 x 1 km region; one road along its southern tile, 500 m long, ending mid-tile
        self.region = box(self.ox, self.oy, self.ox + 2000.0, self.oy + 1000.0)
        self.road = LineString([(self.ox + 100.0, self.oy + 500.0), (self.ox + 600.0, self.oy + 500.0)])
        self.streets = self.road.buffer(200.0, cap_style="flat")
        rng = np.random.default_rng(3)
        n = 400_000
        x = rng.uniform(self.ox, self.ox + 2000.0, n)
        y = rng.uniform(self.oy, self.oy + 1000.0, n)
        ground = rng.random(n) < 0.5
        z = np.where(ground, 50.0, 70.0)  # 20 m trees everywhere
        self.pts = {"x": x, "y": y, "z": z, "cls": np.where(ground, 2, 5).astype(np.uint8),
                    "rn": np.ones(n, np.uint8), "nr": np.ones(n, np.uint8), "i": np.full(n, 100, np.uint16)}

    def tearDown(self):
        self.tmp.cleanup()

    def run_tiled(self, area, road_band, name):
        pts = self.pts

        def batches(frame, bbox, cache, clip, meta, dem=None, jobs=16, road_band=None):
            # what a reader yields: the points inside the clip
            import shapely

            m = shapely.contains_xy(clip, pts["x"], pts["y"])
            yield "synthetic", {k: v[m] for k, v in pts.items()}

        chains = [{"id": "r1", "line": self.road}]
        bbox = tuple(float(v) for v in area.bounds)
        with mock.patch.object(lidar, "point_batches", batches):
            return nt.lidar_tiled(FRAME, bbox, area, chains, Path(self.tmp.name) / name, Path(self.tmp.name), origin=(self.ox, self.oy), road_band=road_band)

    def test_canopy_away_from_the_road_and_the_same_near_road_cloud(self):
        import shapely

        old = self.run_tiled(self.streets, None, "streets")
        new = self.run_tiled(box(*self.region.bounds).union(self.streets), self.streets, "world")
        # the eastern tile has no street within a kilometre: streets-only never wrote it
        self.assertNotIn((1, 0), [tuple(t) for t in old["tiles"]["list"]])
        self.assertIn((1, 0), [tuple(t) for t in new["tiles"]["list"]])
        with rasterio.open(Path(self.tmp.name) / "world" / "tiles" / "1_0.chm.tif") as r:
            chm = r.read(1)
        # ~0.1 tree return per m² in the fixture: ~95,000 of the tile's million cells have one
        self.assertGreater(int((chm > 15).sum()), 50_000, "the lidar CHM has the trees 1.4 km from the road")
        # near-road: the very same points, though the world also has points within BAND_M of the
        # road PAST its flat-capped end, which the streets never read
        band = self.road.buffer(nt.BAND_M)
        past_end = band.difference(self.streets)
        self.assertGreater(int(shapely.contains_xy(past_end, self.pts["x"], self.pts["y"]).sum()), 0, "the fixture must have points the road_band test drops")
        a = np.sort(old["pts"]["x"] * 1e3 + old["pts"]["y"])
        b = np.sort(new["pts"]["x"] * 1e3 + new["pts"]["y"])
        self.assertEqual(len(a), len(b))
        self.assertTrue(np.array_equal(a, b))
        self.assertEqual(new["near_road_points"], old["near_road_points"])
        self.assertGreater(new["points_in_corridor"], 3 * old["points_in_corridor"])
        self.assertAlmostEqual(new["road_band_km2"], round(self.streets.area / 1e6, 2))

    def test_without_the_road_band_the_cloud_would_grow(self):
        # proves the check above can fail: no road_band, and the band past the road's end comes in
        old = self.run_tiled(self.streets, None, "streets2")
        unbanded = self.run_tiled(box(*self.region.bounds).union(self.streets), None, "world2")
        self.assertGreater(unbanded["near_road_points"], old["near_road_points"])

    def test_a_stage_read_over_the_streets_is_not_reused_for_the_world(self):
        self.run_tiled(self.streets, None, "reuse")
        world = box(*self.region.bounds).union(self.streets)
        bbox = tuple(float(v) for v in self.streets.bounds)
        chains = [{"id": "r1", "line": self.road}]
        ldir = Path(self.tmp.name) / "reuse"
        self.assertIsNotNone(nt._resume_lidar(FRAME, bbox, chains, ldir, self.streets))
        self.assertIsNone(nt._resume_lidar(FRAME, bbox, chains, ldir, world))


class StreamRoadBandTest(unittest.TestCase):
    """stream_ept over a world with the streets as road_band, against stream_ept over the streets:
    the streets' points of every batch are the streets-only batch, gap fill included."""

    @classmethod
    def setUpClass(cls):
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import test_lidar_sources as tls

        cls.tls = tls
        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name) / "www"
        bb = tls.BBOX
        west = (bb[0], bb[1], tls.OX, bb[3])
        tls.write_ept(root, "A", tls.FRAME.epsg, west, {"0-0-0-0": 40000, "1-0-0-0": 40000, "1-1-0-0": 40000, "1-0-1-0": 40000, "1-1-1-0": 40000}, cls=2, seed=1)
        tls.write_ept(root, "B", 3857, bb, {"0-0-0-0": 40000}, cls=5, seed=2)
        cls.server = tls.Server(root)
        # the streets: a 300 m band across the middle, half over A's survey, half only B's
        cls.streets = box(tls.OX - 600.0, tls.OY - 150.0, tls.OX + 600.0, tls.OY + 150.0)

    @classmethod
    def tearDownClass(cls):
        cls.server.close()
        cls.tmp.cleanup()

    def stream(self, clip, road_band):
        tls = self.tls
        srcs = [ls.EptSource("TEST:A", self.server.url + "A/", 2020), ls.EptSource("TEST:B", self.server.url + "B/", 2018)]
        meta: dict = {}
        with mock.patch.dict("os.environ", {"CORRIDOR_LIDAR_DENSITY": "0.02"}), mock.patch.object(ls, "BATCH_POINTS", 10000):
            parts = [p for _, p in ls.stream_ept(tls.FRAME, tls.BBOX, clip, Path(tempfile.mkdtemp(dir=self.tmp.name)), srcs, meta, jobs=4, road_band=road_band)]
        return parts, meta

    @staticmethod
    def key(p, m=None):
        x, y = (p["x"], p["y"]) if m is None else (p["x"][m], p["y"][m])
        return np.sort(np.round(x, 3) * 1e7 + np.round(y, 3))

    def test_the_streets_points_of_every_batch_are_the_streets_only_batch(self):
        import shapely

        old, meta_old = self.stream(self.streets, None)
        new, meta_new = self.stream(None, self.streets)
        self.assertGreaterEqual(len(old), 2, "the fixture must cut several batches")
        self.assertGreater(max(len(p["x"]) for p in old), 10000 * 0.6, "a streets-only batch spans more than one node")
        self.assertEqual(len(old), len(new))
        for po, pn in zip(old, new):
            f = pn["road_band"]
            self.assertTrue(np.array_equal(f, shapely.contains_xy(self.streets, pn["x"], pn["y"])), "the flag is the polygon test")
            self.assertTrue(np.array_equal(self.key(po), self.key(pn, f)))
        self.assertGreater(sum(int((~p["road_band"]).sum()) for p in new), 0, "the world brought points from beyond the streets")
        self.assertEqual([s["dataset"] for s in meta_new["sources"]], [s["dataset"] for s in meta_old["sources"]])
        self.assertEqual([s["depth"] for s in meta_new["sources"]], [s["depth"] for s in meta_old["sources"]])
        self.assertEqual(meta_new["coverage"], meta_old["coverage"])
        self.assertIn("coverage_area", meta_new)
        # B filled the eastern half of the streets in both, and the fields east of them in the world
        b_new = np.concatenate([p["cls"] == 5 for p in new])
        self.assertTrue(b_new.any())


class NearLazTest(unittest.TestCase):
    def test_the_chunked_write_holds_what_the_one_shot_write_held(self):
        import laspy

        rng = np.random.default_rng(5)
        n = 25_001
        pts = {"x": rng.uniform(400000, 401000, n), "y": rng.uniform(4300000, 4301000, n), "z": rng.uniform(10, 90, n),
               "cls": rng.integers(1, 18, n).astype(np.uint8), "rn": np.ones(n, np.uint8), "nr": np.full(n, 2, np.uint8),
               "i": rng.integers(0, 60000, n).astype(np.uint16)}
        with tempfile.TemporaryDirectory() as d:
            one = Path(d) / "one.laz"
            las = laspy.create(point_format=6, file_version="1.4")
            las.header.offsets = [float(np.floor(pts["x"].min())), float(np.floor(pts["y"].min())), 0.0]
            las.header.scales = [0.01, 0.01, 0.01]
            las.x, las.y, las.z = pts["x"], pts["y"], pts["z"]
            las.classification = pts["cls"]
            las.return_number, las.number_of_returns, las.intensity = pts["rn"], pts["nr"], pts["i"]
            las.write(one)
            two = Path(d) / "corridor.laz"
            nt._write_near_laz(two, pts, FRAME.crs, chunk=4_000)
            self.assertFalse((Path(d) / "corridor.part.laz").exists())
            a, b = laspy.read(one), laspy.read(two)
            self.assertEqual(len(b.points), n)
            for dim in ("X", "Y", "Z", "classification", "return_number", "number_of_returns", "intensity"):
                self.assertTrue(np.array_equal(np.asarray(a[dim]), np.asarray(b[dim])), dim)
            self.assertIsNotNone(b.header.parse_crs())


class TileGridTest(unittest.TestCase):
    def test_the_export_grid_is_the_bbox_even_where_the_lidar_wrote_nothing(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            # the lidar's origin is a km west and south of the bbox's; it wrote two tiles
            (d / "manifest.json").write_text(json.dumps({"lidar": {"tiles": {"origin": [399000.0, 4299000.0], "list": [[1, 1], [2, 1]]}}}))
            (d / "site.json").write_text(json.dumps({"bbox_utm": [400000.0, 4300000.0, 403000.0, 4302000.0]}))
            x0, y0, tiles = nt._tile_grid(d)
            self.assertEqual((x0, y0), (399000.0, 4299000.0), "the lidar's origin, so its tile names still mean the same place")
            self.assertEqual(sorted(tiles), sorted((tx, ty) for tx in range(1, 4) for ty in range(1, 3)))
            self.assertEqual(tiles[:2], [(1, 1), (2, 1)], "the lidar's own tiles first, as before")

    def test_no_lidar_is_the_bbox_on_its_own_origin(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            (d / "site.json").write_text(json.dumps({"bbox_utm": [400100.0, 4300100.0, 401900.0, 4300900.0]}))
            x0, y0, tiles = nt._tile_grid(d)
            self.assertEqual((x0, y0), (400000.0, 4300000.0))
            self.assertEqual(sorted(tiles), [(0, 0), (1, 0)])


if __name__ == "__main__":
    unittest.main()
