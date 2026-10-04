"""The lidar completion marker: a finished point pass is reused, a changed or damaged one is not.

Bake 495 wrote every 1 km tile and its VRTs and then died on the near-road cloud. The rerun could
not tell that directory from an empty one, re-read 3.08 B cached points and rebuilt the tiles. The
marker in network_tiles is that difference, and these tests pin the two rules that make it safe:
reuse only for the same corridor, and only when every recorded output is still on disk.

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
from shapely.geometry import LineString

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from corridor import network_tiles as nt  # noqa: E402
from corridor.geo import Frame  # noqa: E402

LON, LAT = -76.685, 39.007  # Crofton
FRAME = Frame.at(LON, LAT)
OX, OY = FRAME.origin
BBOX = (OX - 100.0, OY - 100.0, OX + 100.0, OY + 100.0)
CHAINS = [
    {"id": "r00", "line": LineString([(OX - 60.0, OY), (OX + 60.0, OY)])},
    {"id": "r01", "line": LineString([(OX - 60.0, OY + 80.0), (OX + 60.0, OY + 80.0)])},
]
WRITTEN = [(0, 0), (0, 1)]


def near_points() -> dict:
    """Three points on each chain, in the frame's metres, as corridor.laz records them."""
    x = np.array([OX - 30, OX - 10, OX + 10, OX - 20, OX + 0, OX + 20], dtype=np.float64)
    y = np.array([OY, OY, OY, OY + 80, OY + 80, OY + 80], dtype=np.float64)
    return {
        "x": x, "y": y, "z": np.full(6, 10.0),
        "cls": np.full(6, 2, np.uint8), "rn": np.ones(6, np.uint8),
        "nr": np.ones(6, np.uint8), "i": np.full(6, 100, np.uint16),
    }


def write_laz(path: Path, pts: dict) -> None:
    las = laspy.create(point_format=6, file_version="1.4")
    las.header.offsets = [0.0, 0.0, 0.0]
    las.header.scales = [0.01, 0.01, 0.01]
    las.x, las.y, las.z = pts["x"], pts["y"], pts["z"]
    las.classification = pts["cls"]
    las.return_number, las.number_of_returns, las.intensity = pts["rn"], pts["nr"], pts["i"]
    las.write(path)


def finish(ldir: Path, pts: dict | None) -> None:
    """Lay down the stage the way lidar_tiled does: tiles, corridor.laz, then the marker."""
    (ldir / "tiles").mkdir(parents=True, exist_ok=True)
    for tx, ty in WRITTEN:
        for kind in nt._TILE_KINDS:
            (ldir / "tiles" / f"{tx}_{ty}.{kind}.tif").write_bytes(b"tif")
    if pts is not None:
        write_laz(ldir / "corridor.laz", pts)
    result = {
        "source": "ept",
        "dataset": "NOAA:9235",
        "points_in_corridor": 123456,
        "near_road_points": int(len(pts["x"])) if pts is not None else 0,
        "classes": {"ground": 3},
        "classification": {"tiles_demoted_17_18": 0, "class17_trusted": True},
        "z_factor": 1.0,
        "tiles": {"size_m": nt.TILE_M, "origin": [123456.0, 654321.0], "list": WRITTEN},
    }
    nt._mark_lidar_done(FRAME, BBOX, CHAINS, ldir, result, WRITTEN, pts)


class ResumeTest(unittest.TestCase):
    def test_a_finished_stage_is_reused(self):
        with tempfile.TemporaryDirectory() as d:
            finish(Path(d), near_points())
            got = nt._resume_lidar(FRAME, BBOX, CHAINS, Path(d))
            self.assertIsNotNone(got)
            meta = {k: v for k, v in got.items() if k != "pts"}
            self.assertEqual(meta["source"], "ept")
            self.assertEqual(meta["near_road_points"], 6)
            self.assertEqual(len(got["pts"]["x"]), 6)

    def test_the_road_index_is_recomputed_from_the_chains(self):
        # corridor.laz does not store which chain a point belongs to; profile_tiled needs it, and
        # the only correct source is the same 2 m band the bake rasterised.
        with tempfile.TemporaryDirectory() as d:
            finish(Path(d), near_points())
            got = nt._resume_lidar(FRAME, BBOX, CHAINS, Path(d))
            road = got["pts"]["road"]
            self.assertEqual(int((road == 1).sum()), 3, "three points sit on r00")
            self.assertEqual(int((road == 2).sum()), 3, "three points sit on r01")

    def test_no_marker_is_not_reused(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertIsNone(nt._resume_lidar(FRAME, BBOX, CHAINS, Path(d)))

    def test_a_changed_corridor_is_not_reused(self):
        with tempfile.TemporaryDirectory() as d:
            finish(Path(d), near_points())
            wider = (BBOX[0] - 500.0, BBOX[1] - 500.0, BBOX[2] + 500.0, BBOX[3] + 500.0)
            self.assertIsNone(nt._resume_lidar(FRAME, wider, CHAINS, Path(d)))
            # a chain that moved leaves the old 2 m band assigning the wrong road to points
            shifted = [CHAINS[0], {"id": "r01", "line": LineString([(OX - 60.0, OY + 40.0), (OX + 60.0, OY + 40.0)])}]
            self.assertIsNone(nt._resume_lidar(FRAME, BBOX, shifted, Path(d)))

    def test_a_lost_tile_is_not_reused(self):
        with tempfile.TemporaryDirectory() as d:
            finish(Path(d), near_points())
            (Path(d) / "tiles" / "0_1.chm.tif").unlink()
            self.assertIsNone(nt._resume_lidar(FRAME, BBOX, CHAINS, Path(d)))

    def test_a_lost_near_road_cloud_is_not_reused(self):
        with tempfile.TemporaryDirectory() as d:
            finish(Path(d), near_points())
            (Path(d) / "corridor.laz").unlink()
            self.assertIsNone(nt._resume_lidar(FRAME, BBOX, CHAINS, Path(d)))

    def test_a_truncated_cloud_is_not_reused(self):
        # the marker promises six points and the file holds fewer: rebuild rather than profile a
        # cloud that lost points
        with tempfile.TemporaryDirectory() as d:
            finish(Path(d), near_points())
            marker = Path(d) / nt._LIDAR_MARKER
            saved = json.loads(marker.read_text())
            saved["near_road_points"] = 99
            marker.write_text(json.dumps(saved))
            self.assertIsNone(nt._resume_lidar(FRAME, BBOX, CHAINS, Path(d)))

    def test_an_empty_stage_writes_no_marker(self):
        with tempfile.TemporaryDirectory() as d:
            result = {"near_road_points": 0, "tiles": {"size_m": nt.TILE_M, "origin": [0.0, 0.0], "list": []}}
            nt._mark_lidar_done(FRAME, BBOX, CHAINS, Path(d), result, [], None)
            self.assertFalse((Path(d) / nt._LIDAR_MARKER).exists())


if __name__ == "__main__":
    unittest.main()
