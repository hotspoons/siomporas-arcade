"""`export._vector_tiles`: the heavy spatial arrays out of the manifest, into per-1 km files the
viewer streams.

dc-metro's manifest was 346 MB, 142 MB of it `buildings`, and the viewer bucketed all 446k
footprints (and every sidewalk, lot, mast and power line) at load. The tiles are keyed on the SAME
site-metre grid the viewer buckets on, so this pins that: a feature at (x, y) lands in
`floor(x/size), floor(y/size)`, the index matches what was written, and a feature without a
position is dropped rather than crashing the bake. `power` and `signals` are written back nested,
because a tile is a partial manifest the viewer spreads over the full one.
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
            idx = export._vector_tiles(web, {"buildings": buildings})
            self.assertEqual(idx["size_m"], 1000.0)
            self.assertEqual(idx["dir"], "vt/0")
            self.assertEqual(sorted((t["x"], t["y"], t["n"]) for t in idx["buildings"]), [(-1, -1, 1), (0, 0, 1), (1, 1, 1)])
            self.assertEqual(idx["count"], 3)
            self.assertEqual(idx["counts"]["buildings"], 3)
            self.assertEqual(sorted((c["x"], c["y"]) for c in idx["cells"]), [(-1, -1), (0, 0), (1, 1)])
            got = json.loads((web / "vt" / "0" / "0_0.json").read_text())
            self.assertEqual(len(got["buildings"]), 1)
            self.assertEqual(got["buildings"][0]["height_m"], 5)

    def test_nested_power_and_signals_are_written_nested(self):
        arrays = {
            "buildings": [{"ring": [[10.0, 10.0], [20.0, 10.0], [20.0, 20.0]]}],
            "sidewalks": [{"kind": "sidewalk", "coords": [[15.0, 15.0, 0.0], [30.0, 15.0, 0.0]]}],
            "parking": [{"ring": [[40.0, 40.0], [50.0, 40.0], [50.0, 50.0]]}],
            "barriers": [],
            "power": {"lines": [{"coords": [[60.0, 60.0, 0.0], [80.0, 60.0, 0.0]]}], "supports": [{"x": 60.0, "y": 60.0}]},
            "signals": {"masts": [{"x": 12.0, "y": 12.0}], "signs": [], "bars": [{"x": 13.0, "y": 13.0}]},
        }
        with tempfile.TemporaryDirectory() as d:
            web = Path(d)
            idx = export._vector_tiles(web, arrays)
            cell = json.loads((web / "vt" / "0" / "0_0.json").read_text())
            self.assertEqual(len(cell["buildings"]), 1)
            self.assertEqual(len(cell["sidewalks"]), 1)
            self.assertEqual(len(cell["parking"]), 1)
            self.assertNotIn("barriers", cell)  # an empty array contributes no key
            self.assertEqual(len(cell["power"]["lines"]), 1)
            self.assertEqual(len(cell["power"]["supports"]), 1)
            self.assertEqual(len(cell["signals"]["masts"]), 1)
            self.assertEqual(len(cell["signals"]["bars"]), 1)
            self.assertNotIn("signs", cell["signals"])  # empty nested leaf dropped
            self.assertEqual(idx["counts"]["lines"], 1)
            self.assertEqual(idx["counts"]["masts"], 1)
            self.assertEqual(idx["buildings"], [{"x": 0, "y": 0, "n": 1}])

    def test_rerun_replaces_rather_than_merges(self):
        with tempfile.TemporaryDirectory() as d:
            web = Path(d)
            export._vector_tiles(web, {"buildings": [{"ring": [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0]]}]})
            idx = export._vector_tiles(web, {"buildings": [{"ring": [[5000.0, 5000.0], [5001.0, 5000.0], [5001.0, 5001.0]]}]})
            self.assertFalse((web / "vt" / "0" / "0_0.json").exists())
            self.assertTrue((web / "vt" / "0" / "5_5.json").exists())
            self.assertEqual([(t["x"], t["y"]) for t in idx["buildings"]], [(5, 5)])


if __name__ == "__main__":
    unittest.main()
