"""A span is an overpass only where something goes over: OSM crossing, or a class-17 deck.

The Capital Beltway grew a road-carrying concrete deck with a pier dropped in its median at
s≈42386 that dead-ended on both sides (Rich, 2026-10-06). The lidar had found a full-width,
planar overhead — a sign gantry — and the profile, on a motorway, named it `overpass` off its
length alone, because the motorway path skipped the OSM-crossing test. The viewer then built a
vehicle bridge over a road that does not exist.

These pin the three cases `lidar.profile` must tell apart:

    crossings_over_s == []    nothing crosses here  -> gantry   (the bug)
    crossings_over_s == [s]   OSM maps a crossing   -> overpass
    crossings_over_s is None  not checked (a branch)-> overpass by length, as before

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
from corridor import lidar  # noqa: E402
from corridor.geo import Frame  # noqa: E402

FRAME = Frame.at(-76.685, 39.007)
OX, OY = FRAME.origin

#: the overhead plane sits over this along-track stretch; its midpoint is where a crossing lands
SPAN = (40.0, 60.0)
CROSS_S = (SPAN[0] + SPAN[1]) / 2


def _raster(path: Path, value: float, n: int) -> None:
    import rasterio
    from rasterio.transform import from_origin

    with rasterio.open(
        path, "w", driver="GTiff", height=n, width=n, count=1, dtype="float32",
        crs="EPSG:32618", transform=from_origin(OX - 50.0, OY + 250.0, 1.0, 1.0), nodata=-9999.0,
    ) as dst:
        dst.write(np.full((n, n), value, np.float32), 1)


class OverpassGatingTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        ldir = Path(self.tmp.name)
        _raster(ldir / "dtm.tif", 10.0, 300)   # road deck at z = 10
        _raster(ldir / "chm.tif", 0.0, 300)    # no canopy
        import rasterio

        with rasterio.open(ldir / "dtm.tif") as r:
            self.dtm = r.read(1)
            self.tr = r.transform
        with rasterio.open(ldir / "chm.tif") as r:
            self.chm = r.read(1)
        self.spine = LineString([(OX, OY), (OX + 120.0, OY)])

        # a flat plane 6 m over the road, spanning the full ±7 m width across the SPAN stretch
        xs, ys = [], []
        x = SPAN[0]
        while x <= SPAN[1]:
            for y in (-7.0, -5.0, -3.0, -1.0, 1.0, 3.0, 5.0, 7.0):
                xs.append(OX + x)
                ys.append(OY + y)
            x += 2.0
        n = len(xs)
        self.pts = {
            "x": np.array(xs), "y": np.array(ys), "z": np.full(n, 16.0),
            "cls": np.full(n, 2, np.uint8), "rn": np.ones(n, np.uint8),
            "nr": np.ones(n, np.uint8), "i": np.ones(n, np.uint16),
        }

    def tearDown(self):
        self.tmp.cleanup()

    def _kinds(self, crossings):
        prof = lidar.profile(self.spine, self.dtm, self.chm, self.tr, self.pts,
                             crossings_over_s=crossings)
        return [s["kind"] for s in prof["structures"]]

    def test_no_crossing_is_a_gantry_not_an_overpass(self):
        # nothing in OSM goes over: the motorway must not invent a road-carrying span
        self.assertIn("gantry", self._kinds([]))
        self.assertNotIn("overpass", self._kinds([]))

    def test_a_mapped_crossing_is_an_overpass(self):
        self.assertIn("overpass", self._kinds([CROSS_S]))

    def test_unchecked_is_left_alone(self):
        # a branch profile has no crossing list: keep the old length naming
        self.assertIn("overpass", self._kinds(None))


if __name__ == "__main__":
    unittest.main()
