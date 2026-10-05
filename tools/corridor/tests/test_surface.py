"""`surface.measure` without shapely per point, and the same answers.

The old path built a shapely Point for every ground return (~240 bytes each, ~150 GiB on the
Capital Beltway) and called distance/line_locate_point over all 669 M points against an 827-segment
spine — three hours, and an OOM at 128 GiB. `_polyline_measures` indexes the densified line and
projects each point onto its own segment. These tests pin that it agrees with shapely to floating
point, that the per-station medians do not change, and that `measure` still reads a corridor.

    tools/corridor/.venv/bin/python -m unittest discover -s tools/corridor/tests
"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

import laspy
import numpy as np
import shapely
from shapely.geometry import LineString

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from corridor import surface  # noqa: E402
from corridor.geo import Frame  # noqa: E402

LON, LAT = -76.685, 39.007
FRAME = Frame.at(LON, LAT)
OX, OY = FRAME.origin


def _write_laz(path: Path, x, y, cls, intensity) -> None:
    las = laspy.create(point_format=6, file_version="1.4")
    las.header.offsets = [0.0, 0.0, 0.0]
    las.header.scales = [0.01, 0.01, 0.01]
    las.x, las.y, las.z = np.asarray(x, float), np.asarray(y, float), np.zeros(len(x))
    las.classification = np.asarray(cls, np.uint8)
    las.return_number = np.ones(len(x), np.uint8)
    las.number_of_returns = np.ones(len(x), np.uint8)
    las.intensity = np.asarray(intensity, np.uint16)
    las.write(path)


class PolylineMeasuresTest(unittest.TestCase):
    def test_exact_against_shapely(self):
        rng = np.random.default_rng(7)
        t = np.linspace(0.0, 1.0, 60)
        coords = np.column_stack([t * 3000 + 200 * np.sin(t * 7), t * 1500 + 150 * np.cos(t * 9)])
        line = LineString(coords)
        base = rng.integers(0, len(coords) - 1, 20000)
        f = rng.random(20000)
        pts = coords[base] + f[:, None] * (coords[base + 1] - coords[base])
        ang = rng.random(20000) * 2 * np.pi
        pts = pts + np.column_stack([np.cos(ang), np.sin(ang)]) * (rng.random(20000) * 40)[:, None]

        d, s = surface._polyline_measures(coords, pts[:, 0], pts[:, 1])
        sp = shapely.points(pts[:, 0], pts[:, 1])
        self.assertLess(float(np.max(np.abs(d - shapely.distance(sp, line)))), 1e-9)
        self.assertLess(float(np.max(np.abs(s - shapely.line_locate_point(line, sp)))), 1e-9)

    def test_empty_and_degenerate(self):
        d, s = surface._polyline_measures([(0.0, 0.0), (10.0, 0.0)], np.zeros(0), np.zeros(0))
        self.assertEqual(d.shape, (0,))
        d, s = surface._polyline_measures([(1.0, 1.0), (1.0, 1.0)], np.array([0.0]), np.array([0.0]))
        self.assertEqual(d.shape, (1,))

    def test_segments_shorter_than_the_densify_step(self):
        # a staircase of 5 cm segments: a whole run sits between two 0.5 m samples
        rng = np.random.default_rng(11)
        xs = np.arange(0.0, 30.0, 0.05)
        ys = 0.1 * np.round(np.arange(xs.size) / 20.0)
        coords = np.column_stack([xs, ys])
        line = LineString(coords)
        base = rng.integers(0, len(coords) - 1, 8000)
        pts = coords[base] + rng.random(8000)[:, None] * 0.05
        pts = pts + rng.normal(0.0, 3.0, (8000, 2))
        d, s = surface._polyline_measures(coords, pts[:, 0], pts[:, 1])
        sp = shapely.points(pts[:, 0], pts[:, 1])
        self.assertLess(float(np.max(np.abs(d - shapely.distance(sp, line)))), 1e-9)
        self.assertLess(float(np.max(np.abs(s - shapely.line_locate_point(line, sp)))), 1e-9)


class BinMedianTest(unittest.TestCase):
    def test_matches_naive(self):
        rng = np.random.default_rng(3)
        vals = rng.random(5000)
        bins = rng.integers(0, 50, 5000)
        got = surface._bin_median(vals, bins, 50, 30)
        want = np.full(50, np.nan)
        for b in range(50):
            m = bins == b
            if m.sum() >= 30:
                want[b] = np.median(vals[m])
        self.assertTrue(np.allclose(got, want, equal_nan=True))


class MeasureTest(unittest.TestCase):
    """A 1 km straight spine: lane returns on it, verge returns beside it, noise to be ignored."""

    def _site(self, d: Path) -> Path:
        line = LineString([(OX, OY), (OX + 1000.0, OY)])
        (d / "spine_utm.json").write_text(json.dumps({
            "coords": list(line.coords),
            "segments": [{"s_start": 0.0, "s_end": 1000.0, "tags": {"lanes": "2", "highway": "motorway"}}],
        }))
        lane_x, lane_y, lane_i = [], [], []
        verge_x, verge_y, verge_i = [], [], []
        for s0 in range(100, 1000, 100):          # a station every 100 m, 51 stations at 20 m
            lane_x += list(np.linspace(s0 + 2, s0 + 18, 40))
            lane_y += list(np.linspace(0.0, 3.0, 40))     # inside the lane (<= 3.36 m)
            lane_i += [100] * 40
            verge_x += list(np.linspace(s0 + 2, s0 + 18, 40))
            verge_y += list(np.linspace(12.0, 30.0, 40))  # the verge window
            verge_i += [200] * 40
        # classification 1 (unclassified) must be ignored even with a loud intensity
        noise_x, noise_y = [500.0, 700.0], [1.0, 20.0]
        x = [OX + v for v in lane_x + verge_x + noise_x]
        y = [OY + v for v in lane_y + verge_y + noise_y]
        cls = [2] * (len(lane_x) + len(verge_x)) + [1] * len(noise_x)
        inten = lane_i + verge_i + [4000, 4000]
        (d / "lidar").mkdir(parents=True, exist_ok=True)
        _write_laz(d / "lidar" / "corridor.laz", x, y, cls, inten)
        return d

    def test_lane_verge_and_ignored_noise(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = surface.measure(self._site(Path(tmp)))
        self.assertIsNotNone(out)
        rec = out["stations"]
        lane = [v for v in rec["lidar_lane_intensity"] if v is not None]
        self.assertTrue(lane, "some stations should have a lane median")
        self.assertAlmostEqual(min(lane), 100.0, delta=1.0)
        self.assertAlmostEqual(max(lane), 100.0, delta=1.0)
        self.assertEqual(rec["lidar_verge_reference"], 200.0)
        ratios = [v for v in rec["lidar_ratio"] if v is not None]
        self.assertTrue(ratios)
        self.assertAlmostEqual(ratios[0], 0.5, delta=0.01)
        # the noise points sat in the lane and on the verge; had they counted, one median would be
        # 4000 or the reference would move. Neither happened.
        self.assertNotIn(4000.0, lane)

    def test_no_corridor_laz_still_reports_the_stations(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            LineString([(OX, OY), (OX + 1000.0, OY)])
            (d / "spine_utm.json").write_text(json.dumps({
                "coords": [[OX, OY], [OX + 1000.0, OY]],
                "segments": [{"s_start": 0.0, "s_end": 1000.0, "tags": {"highway": "motorway"}}],
            }))
            out = surface.measure(d)
        self.assertIsNotNone(out)
        self.assertTrue(all(v is None for v in out["stations"]["lidar_lane_intensity"]))
        self.assertIsNone(out["stations"].get("lidar_verge_reference"))


if __name__ == "__main__":
    unittest.main()
