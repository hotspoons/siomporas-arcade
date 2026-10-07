"""The NAIP fetch pool: tiles download concurrently, only the misses are requested, and a failed
tile never publishes a cache file.

The service averages ~40 s for a 4000x4000 tile, so a 44-tile shard block spent half an hour mostly
waiting on one request at a time. These tests pin the concurrency contract without touching USGS.

    tools/corridor/.venv/bin/python -m unittest discover -s tools/corridor/tests
"""
from __future__ import annotations

import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from corridor import naip  # noqa: E402


class _Resp:
    def __init__(self, content: bytes = b"x", ctype: str = "image/jpeg", status: int = 200):
        self.content = content
        self.headers = {"content-type": ctype}
        self.status_code = status
        self.text = ""

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


class FetchTilesParallelTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cache = Path(self.tmp.name)
        self._orig = naip._get_with_retry

    def tearDown(self):
        naip._get_with_retry = self._orig
        self.tmp.cleanup()

    def _tasks(self, n):
        return [(self.cache / "naip" / f"t{i}.jpg", {"bbox": str(i)}) for i in range(n)]

    def test_only_missing_tiles_are_requested(self):
        calls: list = []

        def fake(url, params, timeout, tries=5, session=None):
            calls.append(params["bbox"])
            return _Resp(content=b"a")

        naip._get_with_retry = fake
        hit = self.cache / "naip" / "exists.jpg"
        hit.parent.mkdir(parents=True, exist_ok=True)
        hit.write_bytes(b"old")
        tasks = [(hit, {"bbox": "0"}), (self.cache / "naip" / "new.jpg", {"bbox": "1"})]

        n = naip.fetch_tiles_parallel(tasks, jobs=2)

        self.assertEqual(n, 1)
        self.assertEqual(calls, ["1"])
        self.assertEqual((self.cache / "naip" / "new.jpg").read_bytes(), b"a")

    def test_workers_overlap(self):
        # A barrier only releases when four fetches are in flight at once; a serial loop would time
        # out and raise BrokenBarrierError, so this fails if the pool is not actually parallel.
        barrier = threading.Barrier(4)

        def fake(url, params, timeout, tries=5, session=None):
            barrier.wait(timeout=5)
            return _Resp()

        naip._get_with_retry = fake
        n = naip.fetch_tiles_parallel(self._tasks(4), jobs=4)
        self.assertEqual(n, 4)

    def test_one_job_runs_serially_in_one_thread(self):
        ids: list = []

        def fake(url, params, timeout, tries=5, session=None):
            ids.append(threading.get_ident())
            return _Resp()

        naip._get_with_retry = fake
        n = naip.fetch_tiles_parallel(self._tasks(3), jobs=1)
        self.assertEqual(n, 3)
        self.assertEqual(len(set(ids)), 1)

    def test_a_failed_fetch_leaves_no_cache_file(self):
        def fake(url, params, timeout, tries=5, session=None):
            raise RuntimeError("boom")

        naip._get_with_retry = fake
        with self.assertRaises(RuntimeError):
            naip.fetch_tiles_parallel(self._tasks(1), jobs=1)
        self.assertFalse((self.cache / "naip" / "t0.jpg").exists())


def _jpeg(px: int, color) -> bytes:
    from io import BytesIO

    from PIL import Image

    b = BytesIO()
    Image.new("RGB", (px, px), color).save(b, format="JPEG", quality=90)
    return b.getvalue()


class NaipTiledTest(unittest.TestCase):
    """`naip_tiled` now plans every service tile, downloads the misses in parallel, then writes the
    one output GeoTIFF serially from the cache. This drives the whole path against a fake service."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cache = Path(self.tmp.name)
        self._orig_get = naip._get_with_retry
        self._orig_covered = naip.covered

    def tearDown(self):
        naip._get_with_retry = self._orig_get
        naip.covered = self._orig_covered
        self.tmp.cleanup()

    def test_every_corridor_tile_is_fetched_and_written(self):
        from shapely.geometry import box

        from corridor import network_tiles
        from corridor.geo import Frame

        frame = Frame(32618, (300_000.0, 4_300_000.0))
        # 8000 m at 1 m = 8000 px, which is exactly 2x2 service tiles at TILE_PX=4000.
        bbox = (300_000.0, 4_300_000.0, 308_000.0, 4_308_000.0)
        corridor = box(*bbox)
        naip.covered = lambda frame, bbox: True  # skip the content probe, which is a network call
        calls: list = []

        def fake(url, params, timeout, tries=5, session=None):
            calls.append(params["bbox"])
            return _Resp(content=_jpeg(4000, (10, 20, 30)))

        naip._get_with_retry = fake
        out = self.cache / "naip_1m.tif"

        meta = network_tiles.naip_tiled(frame, bbox, corridor, out, self.cache, res=1.0)

        self.assertEqual(meta["tiles_fetched"], 4)
        self.assertEqual(len(calls), 4)
        self.assertEqual(meta["size"], [8000, 8000])
        import rasterio

        with rasterio.open(out) as ds:
            self.assertEqual((ds.width, ds.height), (8000, 8000))
            # A pixel from the far corner proves the window for the last-service tile landed right.
            self.assertEqual(tuple(ds.read(window=rasterio.windows.Window(7999, 7999, 1, 1))[:, 0, 0]), (10, 20, 30))


class NaipBlankFillTest(unittest.TestCase):
    """`_fill_naip_blank`: every NAIP read fills exact-(0,0,0) no-data with the window's valid mean.
    The per-tile and pyramid paths already did; the whole-region overview did not, which laid
    full-height black bands straight across dc-metro-take-2's ground (2026-10-07)."""

    def test_interior_holes_take_the_valid_mean_per_channel(self):
        import numpy as np

        from corridor import network_tiles

        rgb = np.zeros((3, 4, 4), dtype=np.uint8)  # row 3 is a hole in every channel
        rgb[0, :3] = 10
        rgb[1, :3] = 20
        rgb[2, :3] = 30
        frac = network_tiles._fill_naip_blank(rgb)
        self.assertAlmostEqual(frac, 4 / 16)
        self.assertEqual(tuple(rgb[:, 3, 0]), (10, 20, 30))
        self.assertFalse((rgb == 0).all(axis=0).any())

    def test_real_imagery_is_left_exactly_as_it_was(self):
        import numpy as np

        from corridor import network_tiles

        rng = np.random.default_rng(7)
        rgb = rng.integers(1, 256, size=(3, 8, 8), dtype=np.uint8)  # never exactly zero
        before = rgb.copy()
        self.assertEqual(network_tiles._fill_naip_blank(rgb), 0.0)
        self.assertTrue((rgb == before).all())

    def test_a_wholly_blank_window_is_left_alone(self):
        # No valid mean exists to borrow; NAIP absent for the whole view is a different failure
        # than an edge running past coverage, so this must not divide by zero or invent a tone.
        import numpy as np

        from corridor import network_tiles

        rgb = np.zeros((3, 5, 5), dtype=np.uint8)
        self.assertEqual(network_tiles._fill_naip_blank(rgb), 0.0)
        self.assertTrue((rgb == 0).all())

    def test_the_pyramid_helper_agrees(self):
        from corridor import network_tiles, pyramid

        import numpy as np

        rgb = np.zeros((3, 3, 3), dtype=np.uint8)
        rgb[0, :2] = 4
        rgb[1, :2] = 5
        rgb[2, :2] = 6
        a, b = rgb.copy(), rgb.copy()
        self.assertEqual(network_tiles._fill_naip_blank(a), pyramid.fill_blank(b)[1])
        self.assertTrue((a == b).all())


class OverviewNoDataTest(unittest.TestCase):
    def test_overview_fills_a_black_no_data_band(self):
        # The exact dc-metro-take-2 symptom in miniature: `overview()` wrote a whole-region NAIP
        # mosaic whose no-data came out solid black, full-height bands across the ground. Drive
        # the real function and read the JPEG back (2026-10-07).
        import json
        import tempfile

        import numpy as np
        import rasterio
        from PIL import Image
        from rasterio.transform import from_origin

        from corridor import export, network_tiles
        from corridor.geo import Frame

        with tempfile.TemporaryDirectory() as d:
            site = Path(d)
            web = site / "web"
            web.mkdir()
            x0, y0, x1, y1 = 300000.0, 4300000.0, 300100.0, 4300100.0
            (site / "site.json").write_text(json.dumps({"bbox_utm": [x0, y0, x1, y1], "frame": {"epsg": 32618, "origin": [x0, y0]}}))
            arr = np.full((3, 100, 100), 90, dtype=np.uint8)
            arr[:, :, 40:60] = 0  # a 20-px no-data band in every channel
            with rasterio.open(
                site / "naip_1m.tif", "w", driver="GTiff", height=100, width=100, count=3,
                dtype="uint8", crs="EPSG:32618", transform=from_origin(x0, y1, 1.0, 1.0),
            ) as dst:
                dst.write(arr)

            layers = network_tiles.overview(site, web, Frame(32618, (x0, y0)), [], export.vivid)

            self.assertIn("naip", layers)
            out = np.asarray(Image.open(web / "naip_overview.jpg").convert("RGB"))
            self.assertEqual(int((out == 0).all(axis=2).sum()), 0, "the overview still has black no-data")


if __name__ == "__main__":
    unittest.main()
