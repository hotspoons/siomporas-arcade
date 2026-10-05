"""Branch profiling: group the cloud once, fan the chains out, keep the answers.

The old loop did `pts["road"] == road_index` for every one of 10,137 chains — a full scan of the
669 M-point cloud per chain, ~3.5 h of the Capital Beltway bake — and ran them one at a time.
`build_road_index` sorts once; `profile_many` forks so the cloud is shared copy-on-write. These
tests pin the two rules that make that safe: a chain's slice is exactly the points the mask
selected, in the same order, and the pool returns results in task order (a failure is a None, not
a dead bake).

    tools/corridor/.venv/bin/python -m unittest discover -s tools/corridor/tests
"""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
from shapely.geometry import LineString

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from corridor import network_tiles as nt  # noqa: E402
from corridor.geo import Frame  # noqa: E402

LON, LAT = -76.685, 39.007
FRAME = Frame.at(LON, LAT)
OX, OY = FRAME.origin


def _raster(path: Path, value: float, west: float, north: float, n: int) -> None:
    import rasterio
    from rasterio.transform import from_origin

    with rasterio.open(
        path, "w", driver="GTiff", height=n, width=n, count=1, dtype="float32",
        crs="EPSG:32618", transform=from_origin(west, north, 1.0, 1.0), nodata=-9999.0,
    ) as dst:
        dst.write(np.full((n, n), value, np.float32), 1)


class RoadIndexTest(unittest.TestCase):
    def test_slice_is_exactly_the_mask_in_order(self):
        road = np.array([0, 2, 1, 2, 0, 1, 1], dtype=np.int16)
        pts = {"road": road, "x": np.arange(7)}
        order, bounds = nt.build_road_index(pts)
        for rid in (0, 1, 2):
            a, b = bounds[rid]
            sel = np.sort(order[a:b])
            np.testing.assert_array_equal(sel, np.flatnonzero(road == rid))

    def test_a_road_with_no_points_is_absent(self):
        order, bounds = nt.build_road_index({"road": np.array([1, 1, 3])})
        self.assertNotIn(2, bounds)
        self.assertEqual(bounds[1], (0, 2))
        self.assertEqual(bounds[3], (2, 3))

    def test_no_road_column_is_no_index(self):
        self.assertIsNone(nt.build_road_index(None))
        self.assertIsNone(nt.build_road_index({"x": np.arange(3)}))
        self.assertIsNone(nt.build_road_index({"road": np.zeros(0, np.int16)}))


class ProfileManyTest(unittest.TestCase):
    def setUp(self):
        self.orig = nt.profile_tiled

    def tearDown(self):
        nt.profile_tiled = self.orig

    def _fake(self, boom=None):
        def fake(line, ldir, pts, road_index=None, road_index_cache=None):
            if boom is not None and road_index == boom:
                raise RuntimeError("synthetic failure")
            a, b = road_index_cache[1][road_index]
            return {"road_index": int(road_index), "n": int(b - a), "length": float(line.length)}
        return fake

    def _tasks(self):
        return [
            (1, "a", LineString([(0.0, 0.0), (1.0, 0.0)])),
            (2, "b", LineString([(0.0, 0.0), (2.0, 0.0)])),
            (3, "c", LineString([(0.0, 0.0), (3.0, 0.0)])),
        ]

    def test_parallel_matches_serial_in_order(self):
        nt.profile_tiled = self._fake()
        pts = {"road": np.array([1, 2, 2, 3, 3, 3], np.int16)}
        serial = nt.profile_many(self._tasks(), Path("."), pts, jobs=1)
        parallel = nt.profile_many(self._tasks(), Path("."), pts, jobs=3)
        self.assertEqual(serial, parallel)
        self.assertEqual([p["road_index"] for p in parallel], [1, 2, 3])
        self.assertEqual([p["n"] for p in parallel], [1, 2, 3])

    def test_a_failed_chain_is_none_not_a_dead_pool(self):
        nt.profile_tiled = self._fake(boom=2)
        pts = {"road": np.array([1, 2, 2, 3, 3, 3], np.int16)}
        for jobs in (1, 3):
            got = nt.profile_many(self._tasks(), Path("."), pts, jobs=jobs)
            self.assertIsNone(got[1])
            self.assertIsNotNone(got[0])
            self.assertIsNotNone(got[2])


class ProfileTiledEquivalenceTest(unittest.TestCase):
    """The cached slice must produce the SAME profile as the old full-cloud scan."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.ldir = Path(self.tmp.name)
        _raster(self.ldir / "dtm.tif", 10.0, OX - 50.0, OY + 250.0, 300)
        _raster(self.ldir / "chm.tif", 0.0, OX - 50.0, OY + 250.0, 300)
        self.line = LineString([(OX, OY), (OX + 200.0, OY)])
        rng = np.random.default_rng(1)
        n = 400
        x = OX + rng.uniform(0.0, 200.0, n)
        y = OY + rng.uniform(-5.0, 5.0, n)
        self.pts = {
            "x": x, "y": y, "z": np.full(n, 10.0),
            "cls": np.full(n, 2, np.uint8), "rn": np.ones(n, np.uint8),
            "nr": np.ones(n, np.uint8), "i": rng.integers(100, 200, n).astype(np.uint16),
            "road": np.where(y > OY, 2, 1).astype(np.int16),
        }

    def tearDown(self):
        self.tmp.cleanup()

    def test_cached_slice_matches_the_scan(self):
        scan = nt.profile_tiled(self.line, self.ldir, self.pts, 1, road_index_cache=None)
        cache = nt.build_road_index(self.pts)
        cached = nt.profile_tiled(self.line, self.ldir, self.pts, 1, road_index_cache=cache)
        self.assertEqual(scan, cached)

    def test_forked_pool_matches_serial(self):
        tasks = [(1, "a", self.line), (2, "b", self.line)]
        serial = nt.profile_many(tasks, self.ldir, self.pts, jobs=1)
        parallel = nt.profile_many(tasks, self.ldir, self.pts, jobs=2)
        self.assertEqual(serial, parallel)


if __name__ == "__main__":
    unittest.main()
