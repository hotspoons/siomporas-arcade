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

    def test_empty_tiled_keeps_a_compact_junction_paint(self):
        # the full intersection list streams; the paint facts the base road is cut around stay.
        out = {
            "intersections": {
                "list": [{"id": "x", "nodes": [1], "x": 10.0, "y": 20.0,
                          "approaches": [{"stop_x": 5.0, "stop_y": 6.0}, {"stop_x": 15.0, "stop_y": 16.0}]}],
                "counts": {"approaches": 2},
            },
        }
        export._empty_tiled(out)
        self.assertEqual(out["intersections"]["list"], [])
        self.assertEqual(out["intersections"]["counts"], {"approaches": 2})
        self.assertEqual(out["intersections"]["paint"], [{"x": 10.0, "y": 20.0, "a": [[5.0, 6.0], [15.0, 16.0]]}])
        # a re-tile (list already empty) keeps the paint it has
        export._empty_tiled(out)
        self.assertEqual(out["intersections"]["paint"], [{"x": 10.0, "y": 20.0, "a": [[5.0, 6.0], [15.0, 16.0]]}])

    def test_active_set_streams_cuts_rock_and_sidewalk_zones(self):
        # the dressing pass learns to rebuild these per cell, so they leave the manifest for the tiles
        out = {
            "buildings": [{"ring": [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0]]}],
            "cuts": {"faces": [{"stations": [{"toe": [2.0, 2.0, 0.0]}]}], "summary": {"step": 1}},
            "rock": {"polygons": [{"ring": [[3.0, 3.0], [4.0, 3.0], [4.0, 4.0]]}], "thresholds": {}},
            "sidewalk_zones": [[[5.0, 5.0], [6.0, 5.0]]],
        }
        arrays = export._tile_arrays(out)
        self.assertEqual(len(arrays["cuts"]["faces"]), 1)
        self.assertEqual(len(arrays["rock"]["polygons"]), 1)
        self.assertEqual(len(arrays["sidewalk_zones"]), 1)
        export._empty_tiled(out)
        self.assertIsNone(out["cuts"])
        self.assertIsNone(out["rock"])
        self.assertEqual(out["sidewalk_zones"], [])

    def test_rerun_replaces_rather_than_merges(self):
        with tempfile.TemporaryDirectory() as d:
            web = Path(d)
            export._vector_tiles(web, {"buildings": [{"ring": [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0]]}]})
            idx = export._vector_tiles(web, {"buildings": [{"ring": [[5000.0, 5000.0], [5001.0, 5000.0], [5001.0, 5001.0]]}]})
            self.assertFalse((web / "vt" / "0" / "0_0.json").exists())
            self.assertTrue((web / "vt" / "0" / "5_5.json").exists())
            self.assertEqual([(t["x"], t["y"]) for t in idx["buildings"]], [(5, 5)])

    def test_every_streamed_shape_round_trips(self):
        # One feature of every array the schema can carry, each in its own way, tiled and read back
        # through `_load_tiled` — the reader a re-tile builds on. Bare polylines (`siblings`,
        # `sidewalk_zones`) and the two `lines` leaves that carry their points differently are the
        # ones a naive key would drop.
        arrays = {
            "buildings": [{"ring": [[10.0, 10.0], [20.0, 10.0], [20.0, 20.0]]}],
            "sidewalks": [{"coords": [[15.0, 15.0, 0.0], [30.0, 15.0, 0.0]]}],
            "driveways": [{"coords": [[40.0, 40.0, 0.0], [45.0, 40.0, 0.0]]}],
            "stubs": [{"coords": [[41.0, 41.0, 0.0]]}],
            "barriers": [{"coords": [[42.0, 42.0, 0.0]]}],
            "parking": [{"ring": [[50.0, 50.0], [60.0, 50.0], [60.0, 60.0]]}],
            "landuse": [{"class": "forest", "ring": [[70.0, 70.0], [80.0, 70.0], [80.0, 80.0]]}],
            "pois": [{"x": 75.0, "y": 75.0, "kind": "school"}],
            "branches": [{"coords": [[90.0, 90.0, 0.0], [95.0, 90.0, 0.0]]}],
            "siblings": [[[110.0, 110.0], [120.0, 110.0]]],
            "sidewalk_zones": [[[130.0, 130.0], [140.0, 130.0]]],
            "power": {"lines": [{"coords": [[150.0, 150.0, 0.0], [160.0, 150.0, 0.0]]}], "supports": [{"x": 155.0, "y": 155.0}]},
            "signals": {"masts": [{"x": 165.0, "y": 165.0}], "signs": [{"x": 166.0, "y": 166.0}], "bars": [{"x": 167.0, "y": 167.0}]},
            "water": {"lines": [{"pts": [[170.0, 170.0, 0.0], [180.0, 170.0, 0.0]]}], "areas": [{"ring": [[175.0, 175.0], [185.0, 175.0], [185.0, 185.0]]}]},
            "cuts": {"faces": [{"stations": [{"toe": [190.0, 190.0, 0.0], "top": [190.0, 195.0, 5.0]}]}]},
            "rock": {"polygons": [{"ring": [[200.0, 200.0], [210.0, 200.0], [210.0, 210.0]]}]},
            "intersections": {"list": [{"x": 220.0, "y": 220.0, "node": 7}]},
        }
        with tempfile.TemporaryDirectory() as d:
            web = Path(d)
            idx = export._vector_tiles(web, arrays)
            back = export._load_tiled(web, idx)
            self.assertEqual(len(back["buildings"]), 1)
            self.assertEqual(len(back["driveways"]), 1)
            self.assertEqual(len(back["stubs"]), 1)
            self.assertEqual(len(back["siblings"]), 1)
            self.assertEqual(back["siblings"][0][0], [110.0, 110.0])
            self.assertEqual(back["sidewalk_zones"][0][0], [130.0, 130.0])
            self.assertEqual(len(back["landuse"]), 1)
            self.assertEqual(back["pois"][0]["kind"], "school")
            self.assertEqual(len(back["branches"]), 1)
            self.assertEqual(len(back["power"]["lines"]), 1)
            self.assertEqual(len(back["power"]["supports"]), 1)
            self.assertEqual(len(back["water"]["lines"]), 1)
            self.assertEqual(len(back["water"]["areas"]), 1)
            self.assertEqual(len(back["cuts"]["faces"]), 1)
            self.assertEqual(len(back["rock"]["polygons"]), 1)
            self.assertEqual(back["intersections"]["list"][0]["node"], 7)
            # a branch tile index, so a tiled world knows which tiles hold the road network
            self.assertEqual(idx["branch"], [{"x": 0, "y": 0, "n": 1}])
            # everything is within the same 1 km cell, so it is one tile carrying every leaf
            self.assertEqual([(c["x"], c["y"]) for c in idx["cells"]], [(0, 0)])
            cell = json.loads((web / "vt" / "0" / "0_0.json").read_text())
            for leaf in ("buildings", "sidewalks", "driveways", "stubs", "barriers", "parking",
                         "landuse", "pois", "branches", "siblings", "sidewalk_zones",
                         "power", "signals", "water", "cuts", "rock", "intersections"):
                self.assertIn(leaf, cell, leaf)


if __name__ == "__main__":
    unittest.main()
