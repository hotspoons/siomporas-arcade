"""The vertical half of the ENU conversion.

`Frame.to_enu` has always returned true east/north (taken at h = 0) but left z in its input frame.
The viewer's terrain mesh, placed from the raster's geodetic lattice, curves; the road, its
profile and its decks did not, so a carriageway 12 km from the anchor floated 11.3 m above the
ground drawn under it (measured on dc-metro-take-2, 2026-10-06). `to_enu3` is the missing half:
the exact ellipsoid UP at each point's own height. These tests pin the three properties that make
it safe to swap in everywhere `_enu_cols` is used.

    tools/corridor/.venv/bin/python -m unittest discover -s tools/corridor/tests
"""
from __future__ import annotations

import math
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from corridor.geo import Frame  # noqa: E402

# dc-metro-take-2's anchor, the world the bug was measured on.
ANCHOR_LON, ANCHOR_LAT = -77.005045, 38.911621
N = 6_386_615.0  # the prime-vertical radius at ~39 N, the number FRAME.md uses


class ToEnu3(unittest.TestCase):
    def setUp(self):
        self.frame = Frame.at(ANCHOR_LON, ANCHOR_LAT)
        # the car / interchange, east and north of the anchor by ~12.1 km
        e0, n0 = self.frame.to_enu(self.frame.origin[0], self.frame.origin[1])
        self.assertEqual((e0, n0), (0.0, 0.0))
        # a UTM point 12 km east & north of the origin is ~12.1 km out
        self.x = self.frame.origin[0] + 12_000.0
        self.y = self.frame.origin[1] + 1_500.0

    def test_horizontal_is_identical_to_to_enu_so_layers_share_one_grid(self):
        e, n = self.frame.to_enu(self.x, self.y)
        e3, n3, _ = self.frame.to_enu3(self.x, self.y, 91.5)
        self.assertAlmostEqual(float(e3), float(e), 6)
        self.assertAlmostEqual(float(n3), float(n), 6)

    def test_the_up_drops_with_distance_at_d_squared_over_2N(self):
        # at h = 0 the up is the ellipsoid's own drop below the tangent plane
        _, _, u = self.frame.to_enu3(self.x, self.y, 0.0)
        d = math.hypot(float(self.frame.to_enu(self.x, self.y)[0]), float(self.frame.to_enu(self.x, self.y)[1]))
        self.assertGreater(d, 11_000.0)
        self.assertAlmostEqual(float(u), -(d * d) / (2 * N), delta=0.05)
        # flat z is +11 m; the converted one is -11 m. That is the reported gap.
        self.assertLess(float(u), -10.0)

    def test_height_moves_it_along_the_normal(self):
        _, _, u0 = self.frame.to_enu3(self.x, self.y, 0.0)
        _, _, u1 = self.frame.to_enu3(self.x, self.y, 100.0)
        self.assertAlmostEqual(float(u1) - float(u0), 100.0, delta=0.01)

    def test_matches_the_lon_lat_transform_exactly(self):
        lon, lat = self.frame.to_wgs(self.x, self.y)
        # horizontal at h = 0 (the shared grid), vertical at the point's own height
        e, n, _ = self.frame.anchor_frame().to_local(lon, lat, 0.0)
        _, _, u = self.frame.anchor_frame().to_local(lon, lat, 91.5)
        e3, n3, u3 = self.frame.to_enu3(self.x, self.y, 91.5)
        self.assertAlmostEqual(float(e3), float(e), 9)
        self.assertAlmostEqual(float(n3), float(n), 9)
        self.assertAlmostEqual(float(u3), float(u), 9)

    def test_vectorised_matches_scalar(self):
        xs = np.array([self.x, self.x + 500.0])
        ys = np.array([self.y, self.y + 250.0])
        hs = np.array([10.0, 200.0])
        e, n, u = self.frame.to_enu3(xs, ys, hs)
        for i in range(2):
            a, b, c = self.frame.to_enu3(float(xs[i]), float(ys[i]), float(hs[i]))
            self.assertAlmostEqual(float(e[i]), float(a), 9)
            self.assertAlmostEqual(float(u[i]), float(c), 9)


if __name__ == "__main__":
    unittest.main()
