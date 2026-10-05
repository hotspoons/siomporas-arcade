"""`export._vector_tiles`: buildings out of the manifest, into per-1 km files the viewer streams.

dc-metro's manifest was 346 MB, 142 MB of it `buildings`, and the viewer bucketed all 446k
footprints at load. The tiles are keyed on the SAME site-metre grid the viewer buckets on, so this
pins that: a footprint at (x, y) lands in `floor(x/size), floor(y/size)`, the index matches what
was written, and a footprint without a ring is dropped rather than crashing the bake.
"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from corridor import export  # noqa: E402


class VectorTilesTest(unittest.TestCase):
    def test_buckets_on_site_metres_and_writes_an_index(self):
        buildings = [
            {"ring": [[100.0, 100.0], [110.0, 100.0], [110.0, 110.0]], "height_m": 5},
            {"ring": [[1990.0, 1990.0], [2000.0, 2000.0], [2000.0, 1990.0]], "height_m": 6},
            {"ring": [[-5.0, -5.0], [5.0, -5.0], [5.0, 5.0]], "height_m": 4},
            {"height_m": 3},  # no ring: dropped
        ]
        with tempfile.TemporaryDirectory() as d:
            web = Path(d)
            idx = export._vector_tiles(web, buildings)
            self.assertEqual(idx["size_m"], 1000.0)
            self.assertEqual(idx["dir"], "vt/0")
            self.assertEqual(sorted((t["x"], t["y"], t["n"]) for t in idx["buildings"]), [(-1, -1, 1), (0, 0, 1), (1, 1, 1)])
            self.assertEqual(sum(t["n"] for t in idx["buildings"]), 3)
            got = json.loads((web / "vt" / "0" / "0_0.json").read_text())
            self.assertEqual(len(got["buildings"]), 1)
            self.assertEqual(got["buildings"][0]["height_m"], 5)

    def test_rerun_replaces_rather_than_merges(self):
        with tempfile.TemporaryDirectory() as d:
            web = Path(d)
            export._vector_tiles(web, [{"ring": [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0]]}])
            idx = export._vector_tiles(web, [{"ring": [[5000.0, 5000.0], [5001.0, 5000.0], [5001.0, 5001.0]]}])
            self.assertFalse((web / "vt" / "0" / "0_0.json").exists())
            self.assertTrue((web / "vt" / "0" / "5_5.json").exists())
            self.assertEqual([(t["x"], t["y"]) for t in idx["buildings"]], [(5, 5)])


if __name__ == "__main__":
    unittest.main()
