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


class AddOverviewsTest(unittest.TestCase):
    """The merged VRTs get external overviews, so a decimated read stops decoding full-res pixels."""

    def _tile(self, path: Path, n: int = 2048):
        import numpy as np
        import rasterio
        from rasterio.transform import from_origin

        with rasterio.open(path, "w", driver="GTiff", height=n, width=n, count=1,
                           dtype="uint8", crs="EPSG:32618", transform=from_origin(0, n, 1, 1)) as ds:
            ds.write(np.zeros((1, n, n), "uint8"))

    def test_vrt_gets_external_overviews_and_is_idempotent(self):
        import rasterio

        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "a").mkdir()
            self._tile(root / "a" / "dem_1m.tif")
            self.assertEqual(shards.mosaic_shard_raster(root, [root / "a"], "dem_1m.tif"), 1)
            # 2048 / 2 = 1024, /4 = 512, /8 = 256; /16 = 128 < 256 so it stops
            self.assertEqual(shards.add_overviews(root / "dem_1m.tif"), 3)
            self.assertTrue((root / "dem_1m.tif.ovr").exists())
            with rasterio.open(root / "dem_1m.tif") as ds:
                self.assertTrue(ds.overviews(1))
            self.assertEqual(shards.add_overviews(root / "dem_1m.tif"), 0)  # already there

    def test_tiny_raster_is_a_noop(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "a").mkdir()
            self._tile(root / "a" / "dem_1m.tif", n=64)
            shards.mosaic_shard_raster(root, [root / "a"], "dem_1m.tif")
            self.assertEqual(shards.add_overviews(root / "dem_1m.tif"), 0)


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


class ShardLidarAreaTest(unittest.TestCase):
    """A shard reads lidar for its OWN block (shards.lidar_area): dc-metro-take-2 shard 5 used to
    buffer the whole 93 km Beltway and read a 36.7 x 27.6 km bbox for a 9.6 x 9.3 km block."""

    def setUp(self):
        from shapely.geometry import LineString

        # a primary 60 km long, west to east; the block is 10 km of it
        self.primary = LineString([(0.0, 5000.0), (60000.0, 5000.0)])
        self.block = [20000.0, 0.0, 30000.0, 10000.0]
        # an assigned chain mostly in the block whose tail runs 3 km past the margin
        self.chain = LineString([(25000.0, 2000.0), (25000.0, 8000.0), (33600.0, 8000.0)])

    def test_the_far_primary_is_not_read_and_the_assigned_chain_is_whole(self):
        from shapely.geometry import Point

        area = shards.lidar_area(self.primary, [self.chain], self.block, 600.0, 200.0)
        x0, y0, x1, y1 = area.bounds
        self.assertGreaterEqual(x0, 20000.0 - 600.0 - 1e-6, "primary read west of the margin")
        self.assertFalse(area.contains(Point(10000.0, 5000.0)), "the primary 10 km west is read")
        self.assertFalse(area.contains(Point(45000.0, 5000.0)), "the primary 15 km east is read")
        self.assertTrue(area.contains(Point(19500.0, 5000.0)), "the primary in the margin is context")
        self.assertTrue(area.contains(Point(33500.0, 8000.0)), "the assigned chain's tail was cut")
        self.assertAlmostEqual(x1, 33600.0, delta=1.0)

    def test_stations_are_owned_by_the_block_they_lie_in(self):
        blocks = shards.partition((0.0, 0.0, 60000.0, 10000.0), max_side_m=10000.0, max_shards=36)
        s = [0.0, 15000.0, 25000.0, 35000.0]
        owner = shards.profile_owner(self.primary, s, blocks)
        self.assertEqual(owner, [shards.block_at(blocks, v, 5000.0) for v in s])
        self.assertEqual(shards.owner_runs([1, 2, 2, 3, 2], 2), [[1, 2], [4, 4]])


class OwnedStitchTest(unittest.TestCase):
    """The stitch takes each station from its OWNER, and joins a structure two shards each saw part
    of — with the primary clipped per block, both happen at every seam."""

    def write(self, root: Path, i: int, road_z, owned, structures=()):
        d = root / str(i)
        d.mkdir(parents=True)
        (d / "profile.json").write_text(json.dumps({"step_m": 2.0, "s": [0.0, 2.0, 4.0, 6.0, 8.0, 10.0], "road_z": road_z, "owned": owned, "structures": list(structures)}))
        return d

    def test_the_owner_wins_where_both_have_values(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            # shard 0 owns stations 0-2 but also saw 3-4 at the edge of its lidar, wrongly
            a = self.write(root, 0, [1.0, 1.0, 1.0, 9.0, 9.0, None], [[0, 2]])
            b = self.write(root, 1, [None, None, 2.0, 2.0, 2.0, 2.0], [[3, 5]])
            shards.stitch_profile([a, b], root / "out")
            out = json.loads((root / "out" / "profile.json").read_text())
        self.assertEqual(out["road_z"], [1.0, 1.0, 1.0, 2.0, 2.0, 2.0])

    def test_a_structure_across_the_seam_is_joined_and_a_margin_only_one_dropped(self):
        bridge_a = {"kind": "bridge", "s_start": 2.0, "s_end": 6.0, "length_m": 6.0, "deck_z_min": 10.0, "deck_z_max": 11.0}
        bridge_b = {"kind": "bridge", "s_start": 6.0, "s_end": 10.0, "length_m": 6.0, "deck_z_min": 9.5, "deck_z_max": 12.0}
        ghost = {"kind": "gantry", "s_start": 8.0, "s_end": 10.0, "length_m": 4.0, "deck_z_min": 5.0, "deck_z_max": None}
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            a = self.write(root, 0, [1.0] * 6, [[0, 2]], [bridge_a, ghost])
            b = self.write(root, 1, [1.0] * 6, [[3, 5]], [bridge_b])
            shards.stitch_profile([a, b], root / "out")
            out = json.loads((root / "out" / "profile.json").read_text())
        self.assertEqual(len(out["structures"]), 1, out["structures"])
        st = out["structures"][0]
        self.assertEqual((st["kind"], st["s_start"], st["s_end"]), ("bridge", 2.0, 10.0))
        self.assertEqual((st["deck_z_min"], st["deck_z_max"]), (9.5, 12.0))


class MergeLidarTest(unittest.TestCase):
    """Seam tiles by place, owner first; the primary's near-road cloud from every block."""

    def tile(self, d: Path, name: str, dsm, value: float):
        import numpy as np
        import rasterio
        from rasterio.transform import from_origin

        d.mkdir(parents=True, exist_ok=True)
        prof = {"driver": "GTiff", "height": 4, "width": 4, "count": 1, "dtype": "float32", "crs": "EPSG:32618", "transform": from_origin(1000.0, 2000.0, 250.0, 250.0), "nodata": -9999}
        for kind in shards._LIDAR_KINDS:
            arr = np.where(np.asarray(dsm), value, -9999).astype(np.float32)
            with rasterio.open(d / f"{name}.{kind}.tif", "w", **prof) as w:
                w.write(arr, 1)

    def test_the_owners_pixels_first_and_its_holes_from_the_neighbour(self):
        import numpy as np
        import rasterio

        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            own = np.zeros((4, 4), bool)
            own[:, :2] = True           # the owner read the west half of this tile's streets
            other = np.ones((4, 4), bool)
            self.tile(root / "s0" / "lidar" / "tiles", "1_1", other, 7.0)
            self.tile(root / "s1" / "lidar" / "tiles", "1_1", own, 3.0)
            plan = {"tiles": {"0": [], "1": [[1, 1]]}, "blocks": []}
            st = shards.merge_lidar([(0, root / "s0"), (1, root / "s1")], root / "out", plan)
            with rasterio.open(root / "out" / "lidar" / "tiles" / "1_1.dsm.tif") as r:
                got = r.read(1)
        self.assertEqual(st["seam_tiles"], 1)
        self.assertTrue((got[:, :2] == 3.0).all(), "the owner's pixels were replaced")
        self.assertTrue((got[:, 2:] == 7.0).all(), "the owner's holes were not filled")

    def test_the_primary_cloud_is_each_blocks_own_points_on_the_primary(self):
        import laspy
        import numpy as np
        from shapely.geometry import LineString

        blocks = shards.partition((0.0, 0.0, 2000.0, 1000.0), max_side_m=1000.0, max_shards=4)
        plan = {"bbox": [0.0, 0.0, 2000.0, 1000.0], "blocks": blocks, "tiles": {}}
        primary = LineString([(0.0, 500.0), (2000.0, 500.0)])
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            for i in range(2):
                # each shard's cloud reaches 300 m into the other block (its margin), and has a
                # branch's points 200 m off the primary
                xs = np.concatenate([np.arange(0.0, 1300.0, 10.0) if i == 0 else np.arange(700.0, 2000.0, 10.0), [500.0 + 1000 * i]])
                ys = np.concatenate([np.full(len(xs) - 1, 500.0), [700.0]])
                d = root / f"s{i}" / "lidar"
                d.mkdir(parents=True)
                las = laspy.create(point_format=6, file_version="1.4")
                las.header.offsets, las.header.scales = [0.0, 0.0, 0.0], [0.01, 0.01, 0.01]
                las.x, las.y, las.z = xs, ys, np.full(len(xs), float(i))
                las.write(d / "corridor.laz")
            st = shards.merge_lidar([(0, root / "s0"), (1, root / "s1")], root / "out", plan, primary)
            got = laspy.read(root / "out" / "lidar" / "corridor.laz")
        x = np.asarray(got.x)
        self.assertEqual(st["near_points"], 200, "each primary point once, no branch points")
        self.assertEqual(len(np.unique(np.round(x, 2))), 200, "a margin point came from both shards")
        self.assertTrue((np.asarray(got.z)[x < 1000] == 0).all() and (np.asarray(got.z)[x >= 1000] == 1).all(), "a point came from the block that does not own it")


class WorldTileNamesTest(unittest.TestCase):
    def test_a_shards_lidar_tiles_are_named_on_the_world_grid(self):
        """2026-10-10: dc-metro shards anchored their 1 km grids at their own bbox corners, so
        `3_4` was a different square kilometre in each and the merge kept one of them."""
        from shapely.geometry import box

        from corridor import network_tiles

        world = (302080.0, 4284770.0, 350010.0, 4331400.0)
        gx, gy, _ = shards.tile_grid(world)
        a = network_tiles.tile_index((310000.0, 4296000.0, 312000.0, 4297000.0), box(310100, 4296100, 311900, 4296900), (gx, gy))
        b = network_tiles.tile_index((304000.0, 4286000.0, 312000.0, 4297000.0), box(311100, 4296100, 311900, 4296900), (gx, gy))
        self.assertEqual(a[0], (gx, gy))
        self.assertIn((9, 12), a[1])        # x 311000-312000, y 4296000-4297000: column 9, row 12
        self.assertEqual(b[1], [(9, 12)])  # the same place has the same name from another bbox
        own = network_tiles.tile_index((304000.0, 4286000.0, 312000.0, 4297000.0), box(311100, 4296100, 311900, 4296900))
        self.assertEqual(own[1], [(7, 10)], "without an origin the bbox's own corner anchors the grid, as before")
