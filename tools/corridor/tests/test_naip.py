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


if __name__ == "__main__":
    unittest.main()
