"""shards: the plan -> shard -> finalize partition and its merge contracts.

The plan assignment and the finalizer's merges are the parts a sharded world's correctness rests
on: tiles must land in exactly one shard, chains must be assigned whole, and the primary must
stitch back to the same along-track array a single bake would have written. These tests pin that
with synthetic rectangles/lines — no rasters, no network.

    tools/corridor/.venv/bin/python -m unittest discover -s tools/corridor/tests
"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from corridor import shards  # noqa: E402


class PartitionTest(unittest.TestCase):
    def test_blocks_cover_the_bbox_without_gaps(self):
        bbox = (0.0, 0.0, 20000.0, 17000.0)
        blocks = shards.partition(bbox, max_side_m=8000.0, max_shards=16)
        self.assertLessEqual(len(blocks), 16)
        area = sum((b["bbox"][2] - b["bbox"][0]) * (b["bbox"][3] - b["bbox"][1]) for b in blocks)
        self.assertAlmostEqual(area, 20000.0 * 17000.0, places=3)
        # every block falls inside the bbox
        for b in blocks:
            x0, y0, x1, y1 = b["bbox"]
            self.assertGreaterEqual(x0, bbox[0] - 1e-6)
            self.assertGreaterEqual(y0, bbox[1] - 1e-6)
            self.assertLessEqual(x1, bbox[2] + 1e-6)
            self.assertLessEqual(y1, bbox[3] + 1e-6)

    def test_no_block_exceeds_max_side_when_the_cap_allows(self):
        blocks = shards.partition((0.0, 0.0, 30000.0, 24000.0), max_side_m=8000.0, max_shards=16)
        self.assertLessEqual(len(blocks), 16)
        for b in blocks:
            self.assertLessEqual(b["bbox"][2] - b["bbox"][0], 8000.0 + 1e-6)
            self.assertLessEqual(b["bbox"][3] - b["bbox"][1], 8000.0 + 1e-6)

    def test_cap_wins_over_side_when_both_cannot_hold(self):
        # a huge world with a small cap: the count cap is honoured, the side grows
        blocks = shards.partition((0.0, 0.0, 100000.0, 100000.0), max_side_m=1000.0, max_shards=4)
        self.assertEqual(len(blocks), 4)

    def test_small_world_is_one_block(self):
        blocks = shards.partition((0.0, 0.0, 3000.0, 2000.0), max_side_m=8000.0, max_shards=16)
        self.assertEqual(len(blocks), 1)


class AssignmentTest(unittest.TestCase):
    def _box_lines(self):
        from shapely.geometry import LineString

        # four chains, one near each corner of a 2x2 block world
        return [
            {"id": "a", "line": LineString([(10, 10), (100, 10)])},
            {"id": "b", "line": LineString([(9010, 10), (9100, 10)])},
            {"id": "c", "line": LineString([(10, 9010), (100, 9010)])},
            {"id": "d", "line": LineString([(9010, 9010), (9100, 9010)])},
        ]

    def test_tiles_assigned_exactly_once(self):
        bbox = (0.0, 0.0, 5000.0, 5000.0)
        blocks = shards.partition(bbox, max_side_m=3000.0, max_shards=16)
        by_block = shards.assign_tiles(bbox, blocks)
        tiles = [tuple(t) for v in by_block.values() for t in v]
        self.assertEqual(len(tiles), len(set(tiles)))  # no tile in two shards
        self.assertEqual(len(tiles), 25)  # 5x5 one-km tiles

    def test_each_chain_lands_in_the_block_it_mostly_occupies(self):
        from shapely.geometry import LineString

        bbox = (0.0, 0.0, 10000.0, 10000.0)
        blocks = shards.partition(bbox, max_side_m=5000.0, max_shards=4)
        chains = self._box_lines()
        primary = {"id": "p", "line": LineString([(0, 5000), (10000, 5000)])}
        assign = shards.assign_chains(chains, primary, blocks)
        self.assertEqual(set(assign), {"a", "b", "c", "d"})
        self.assertNotIn("p", assign)  # the primary is stitched, never assigned
        # a and c are on the west half, b and d east; a/b south, c/d north
        self.assertEqual(assign["a"] % 2, assign["c"] % 2)
        self.assertNotEqual(assign["a"], assign["b"])
        self.assertNotEqual(assign["a"], assign["c"])

    def test_primary_crosses_the_blocks_it_passes_through(self):
        from shapely.geometry import LineString

        blocks = shards.partition((0.0, 0.0, 20000.0, 10000.0), max_side_m=5000.0, max_shards=16)
        primary = {"id": "p", "line": LineString([(0, 5000), (20000, 5000)])}
        touched = shards.primary_blocks(primary, blocks)
        self.assertGreaterEqual(len(touched), 2)
        for bi in touched:
            self.assertIsInstance(bi, int)


class MergeTest(unittest.TestCase):
    def test_merge_tree_first_writer_wins(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            a, b, dest = root / "a", root / "b", root / "dest"
            (a / "web/tiles/0").mkdir(parents=True)
            (b / "web/tiles/0").mkdir(parents=True)
            (a / "web/tiles/0/1_1.pack").write_text("a")
            (b / "web/tiles/0/1_1.pack").write_text("b")  # same tile, must not win
            (b / "web/tiles/0/2_2.pack").write_text("b")
            n = shards.merge_tree([a, b], dest, "web/tiles")
            self.assertEqual(n, 2)
            self.assertEqual((dest / "web/tiles/0/1_1.pack").read_text(), "a")
            self.assertEqual((dest / "web/tiles/0/2_2.pack").read_text(), "b")

    def test_merge_branches_unions_by_id(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            a, b, dest = root / "a", root / "b", root / "dest"
            a.mkdir()
            b.mkdir()
            (a / "branches.json").write_text(json.dumps({"branches": [{"id": "x", "length_m": 1}, {"id": "y", "length_m": 2}]}))
            (b / "branches.json").write_text(json.dumps({"branches": [{"id": "y", "length_m": 99}, {"id": "z", "length_m": 3}]}))
            n = shards.merge_branches([a, b], dest)
            got = json.loads((dest / "branches.json").read_text())["branches"]
            self.assertEqual(n, 3)
            by = {b_["id"]: b_ for b_ in got}
            self.assertEqual(by["y"]["length_m"], 2)  # first writer wins, no duplicate

    def test_stitch_profile_keeps_each_shards_finite_stations(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            a, b, dest = root / "a", root / "b", root / "dest"
            for p in (a, b):
                p.mkdir()
            # same absolute-s lattice, each shard finite over its half
            (a / "profile.json").write_text(json.dumps({"step_m": 2.0, "s": [0, 2, 4, 6], "road_z": [10.0, 11.0, None, None], "structures": [{"kind": "bridge", "s_start": 0.0, "s_end": 2.0}]}))
            (b / "profile.json").write_text(json.dumps({"step_m": 2.0, "s": [0, 2, 4, 6], "road_z": [None, None, 13.0, 14.0], "structures": [{"kind": "bridge", "s_start": 0.0, "s_end": 2.0}]}))
            self.assertTrue(shards.stitch_profile([a, b], dest))
            out = json.loads((dest / "profile.json").read_text())
            self.assertEqual(out["road_z"], [10.0, 11.0, 13.0, 14.0])
            self.assertEqual(len(out["structures"]), 1)  # the seam duplicate is deduped

    def test_stitch_profile_fills_a_true_hole(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            a, dest = root / "a", root / "dest"
            a.mkdir()
            (a / "profile.json").write_text(json.dumps({"step_m": 2.0, "s": [0, 2, 4], "road_z": [10.0, None, 14.0]}))
            shards.stitch_profile([a], dest)
            out = json.loads((dest / "profile.json").read_text())
            self.assertEqual(out["road_z"], [10.0, 12.0, 14.0])  # interpolated, like the single-image path

    def test_merge_geology_unions_by_map_id(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            a, b, dest = root / "a", root / "b", root / "dest"
            a.mkdir()
            b.mkdir()
            (a / "geology.json").write_text(json.dumps({"units": [{"map_id": 1, "strat_name": "A"}], "named_formations": ["A"]}))
            (b / "geology.json").write_text(json.dumps({"units": [{"map_id": 1, "strat_name": "A"}, {"map_id": 2, "strat_name": "B"}], "named_formations": ["A", "B"]}))
            shards.merge_geology([a, b], dest)
            out = json.loads((dest / "geology.json").read_text())
            self.assertEqual(len(out["units"]), 2)
            self.assertEqual(out["named_formations"], ["A", "B"])


class RebuildLidarVrtsTest(unittest.TestCase):
    def test_vrt_covers_tiles_from_every_shard(self):
        # merge_tree copies a shard's dtm.vrt first-writer-wins; the rebuild must cover the union or
        # the merged world silently shrinks to one block.
        import numpy as np
        import rasterio
        from rasterio.transform import from_origin

        with tempfile.TemporaryDirectory() as d:
            ldir = Path(d) / "lidar"
            tdir = ldir / "tiles"
            tdir.mkdir(parents=True)
            for name in ("0_0.dtm.tif", "1_0.dtm.tif", "0_1.dtm.tif"):
                with rasterio.open(tdir / name, "w", driver="GTiff", height=4, width=4, count=1,
                                   dtype="float32", crs="EPSG:32618", transform=from_origin(0, 4, 1, 1)) as ds:
                    ds.write(np.zeros((4, 4), "float32"), 1)
            self.assertEqual(shards.rebuild_lidar_vrts(Path(d)), 1)
            vrt = (ldir / "dtm.vrt").read_text()
            for name in ("0_0.dtm.tif", "1_0.dtm.tif", "0_1.dtm.tif"):
                self.assertIn(name, vrt)

    def test_no_tiles_is_a_noop(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(shards.rebuild_lidar_vrts(Path(d)), 0)


class MosaicShardRasterTest(unittest.TestCase):
    def test_vrt_mosaics_the_shards_and_opens_as_a_raster(self):
        import numpy as np
        import rasterio
        from rasterio.transform import from_origin

        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            parts = []
            for i in range(2):
                p = root / "shards" / str(i)
                p.mkdir(parents=True)
                with rasterio.open(p / "dem_1m.tif", "w", driver="GTiff", height=4, width=4, count=1,
                                   dtype="float32", crs="EPSG:32618", transform=from_origin(i * 4, 4, 1, 1)) as ds:
                    ds.write(np.full((4, 4), float(i), "float32"), 1)
                parts.append(p)
            self.assertEqual(shards.mosaic_shard_raster(root, parts, "dem_1m.tif"), 2)
            # a VRT keeps the `.tif` name every reader already opens — GDAL goes by content
            with rasterio.open(root / "dem_1m.tif") as ds:
                self.assertEqual(ds.count, 1)
                self.assertEqual(ds.width, 8)  # the two 4 px blocks side by side

    def test_no_shard_raster_is_a_noop(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "shards" / "0").mkdir(parents=True)
            self.assertEqual(shards.mosaic_shard_raster(root, [root / "shards" / "0"], "dem_1m.tif"), 0)


class PlanRoundTripTest(unittest.TestCase):
    def test_write_then_read(self):
        from shapely.geometry import LineString

        with tempfile.TemporaryDirectory() as d:
            site_dir = Path(d)
            chains = [{"id": "a", "line": LineString([(0, 0), (100, 0)])}]
            primary = {"id": "p", "line": LineString([(0, 0), (1000, 0)])}
            plan = shards.build_plan("s", (0.0, 0.0, 1000.0, 1000.0), chains, primary)
            shards.write_plan(site_dir, plan)
            self.assertEqual(shards.read_plan(site_dir), plan)
            self.assertEqual(shards.shard_dir(site_dir, 2), site_dir / "shards" / "2")


if __name__ == "__main__":
    unittest.main()
