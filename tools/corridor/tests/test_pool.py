"""pool + the parallel tile stages: a forked worker pool, and a strip reader that used to be one call.

Two fixes from the 2026-10-05 investigation: the serial per-tile export/pyramid loops now fan out
across `pool`, and `overview()` reads its 1 m VRTs in parallel strips instead of one `rasterio.read`
that ran for hours with no log line. These tests pin the pool's ordering/split contract and the
strip reader's geometry without needing a real world.

    tools/corridor/.venv/bin/python -m unittest discover -s tools/corridor/tests
"""
from __future__ import annotations

import os
import pickle
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from corridor import pool  # noqa: E402


def _square(x):
    """Module-level so the fork pool can pickle it by reference."""
    return x * x


class ChunkTest(unittest.TestCase):
    def test_split_is_contiguous_and_covers_everything(self):
        items = list(range(10))
        parts = pool.chunk(items, 3)
        self.assertEqual([x for p in parts for x in p], items)  # order preserved, nothing lost
        self.assertTrue(all(len(p) >= 1 for p in parts))
        self.assertLessEqual(len(parts), 3)

    def test_one_job_is_one_chunk(self):
        self.assertEqual(pool.chunk([1, 2, 3], 1), [[1, 2, 3]])

    def test_empty(self):
        self.assertEqual(pool.chunk([], 4), [])


class MapChunksTest(unittest.TestCase):
    def test_ordered_results_across_forked_workers(self):
        out = pool.map_chunks(_square, [5, 4, 3, 2, 1], "test", jobs=3)
        self.assertEqual(out, [25, 16, 9, 4, 1])  # one future per chunk, results by index

    def test_single_worker_runs_in_process(self):
        out = pool.map_chunks(_square, [2, 3], "test", jobs=1)
        self.assertEqual(out, [4, 9])

    def test_empty(self):
        self.assertEqual(pool.map_chunks(_square, [], "test"), [])

    def test_default_jobs_honours_env(self):
        old = os.environ.get("CORRIDOR_TILE_JOBS")
        try:
            os.environ["CORRIDOR_TILE_JOBS"] = "3"
            self.assertEqual(pool.default_jobs(100), 3)
            self.assertEqual(pool.default_jobs(2), 2)  # never more workers than tasks
        finally:
            if old is None:
                os.environ.pop("CORRIDOR_TILE_JOBS", None)
            else:
                os.environ["CORRIDOR_TILE_JOBS"] = old


class ForkLockTest(unittest.TestCase):
    def test_a_forked_child_gets_an_unlocked_stdout_lock(self):
        # export.py wraps cuts/rock/water in an outer `heartbeat`, so a fork pool is created WHILE
        # that heartbeat thread may hold progress._LOCK. A child that inherits the lock held has no
        # thread to release it and deadlocks on its first print — which is how the rock pool sat at
        # 9/14 for half an hour on the shard-smoke finalizer. `os.register_at_fork` must hand the
        # child a fresh lock. The check is non-blocking so a regression fails rather than hangs.
        import select

        from corridor import progress

        progress.install_timestamps()
        progress._LOCK.acquire()  # pretend the outer heartbeat is mid-print at fork time
        r, w = os.pipe()
        try:
            pid = os.fork()
            if pid == 0:  # child
                os.close(r)
                got = progress._LOCK.acquire(blocking=False)
                if got:
                    progress._LOCK.release()
                    sys.stdout.write("forked child line\n")
                    sys.stdout.flush()
                    os.write(w, b"ok")
                else:
                    os.write(w, b"locked")
                os._exit(0)
            os.close(w)
            ready, _, _ = select.select([r], [], [], 10.0)
            if not ready:
                os.kill(pid, 9)
                os.waitpid(pid, 0)
                self.fail("the forked child deadlocked on the inherited stdout lock")
            got = os.read(r, 16)
            os.waitpid(pid, 0)
            self.assertEqual(got, b"ok")
        finally:
            progress._LOCK.release()
            os.close(r)


class ReadStripsTest(unittest.TestCase):
    def _raster(self, path):
        import numpy as np
        import rasterio
        from rasterio.transform import from_origin

        data = np.full((40, 40), 7.0, dtype=np.float32)
        with rasterio.open(
            path, "w", driver="GTiff", height=40, width=40, count=1, dtype="float32",
            crs="EPSG:32618", transform=from_origin(0.0, 40.0, 1.0, 1.0), nodata=-9999.0,
        ) as dst:
            dst.write(data, 1)

    def test_strips_reconstruct_the_whole_read(self):
        import numpy as np

        from corridor import network_tiles

        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "t.tif"
            self._raster(p)
            bbox = (0.0, 0.0, 40.0, 40.0)
            whole, (w, h) = network_tiles._read_strips(p, bbox, 1.0, 1, strips=1)
            self.assertEqual((w, h), (40, 40))
            self.assertEqual(whole.shape, (40, 40))
            for n in (2, 3, 7):
                part, (w2, h2) = network_tiles._read_strips(p, bbox, 1.0, 1, strips=n)
                self.assertEqual((w2, h2), (40, 40))
                self.assertTrue(np.allclose(part, whole), f"strips={n} differs from a whole read")


class VividPickleTest(unittest.TestCase):
    def test_vivid_is_module_level_and_picklable(self):
        # `vivid` used to be a closure inside export_site, which no forked worker can unpickle.
        from corridor import export

        self.assertIs(pickle.loads(pickle.dumps(export.vivid)), export.vivid)


class PyramidBakeTest(unittest.TestCase):
    def test_bake_reads_site_json_without_a_namespace_error(self):
        # `pyramid.bake` grew a `json.loads` in the Phase 0 fan-out while `import json` stayed
        # local to `_bake_serial`; every large tiled bake since then SKIPPED the pyramid with a
        # NameError and shipped without an LOD tree (dc-metro-take-2, 2026-10-05). A site with no
        # bbox is the cheapest call that still parses site.json.
        import json
        import tempfile

        from corridor import pyramid

        with tempfile.TemporaryDirectory() as d:
            Path(d, "site.json").write_text(json.dumps({"slug": "x"}))
            self.assertEqual(pyramid.bake(Path(d), Path(d), None), {})


if __name__ == "__main__":
    unittest.main()
